import fs from 'node:fs/promises';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import Koa from 'koa';
import request from 'supertest';
import type { Configuration } from 'webpack';
import type { BuildContext } from '../../create-build-context';
import { watch, type WebpackWatcher } from '../watch';
import { resolveDevelopmentConfig, mergeConfigWithUserConfig } from '../config';

jest.setTimeout(30000);

jest.mock('../config', () => ({
  resolveDevelopmentConfig: jest.fn(),
  mergeConfigWithUserConfig: jest.fn((config) => config),
}));

describe('webpack development middleware', () => {
  let directory: string;
  let app: Koa;
  let watcher: WebpackWatcher;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'strapi-webpack-'));
    await fs.writeFile(path.join(directory, 'entry.js'), 'console.log("admin fixture");');
    app = new Koa();
  });

  afterEach(async () => {
    await watcher?.close();
    await fs.rm(directory, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  const start = async (publicPath = '/admin/', serveFallback = false) => {
    const config: Configuration = {
      mode: 'development',
      entry: path.join(directory, 'entry.js'),
      output: { path: path.join(directory, 'dist'), filename: 'main.js', publicPath },
      infrastructureLogging: { level: 'none' },
      stats: 'none',
      plugins: [
        {
          apply(compiler) {
            compiler.hooks.afterEmit.tapAsync('OutsideOutputFixture', (_compilation, done) => {
              compiler.outputFileSystem!.writeFile(
                path.join(directory, 'secret.txt'),
                'outside-output-secret',
                (error) => {
                  if (error) return done(error);
                  return compiler.outputFileSystem!.writeFile(
                    path.join(directory, 'dist', 'index.html'),
                    '<html>admin shell</html>',
                    done
                  );
                }
              );
            });
          },
        },
      ],
    };
    jest.mocked(resolveDevelopmentConfig).mockResolvedValue(config);
    watcher = await watch({
      logger: { debug: jest.fn() },
      adminPath: '/admin',
      strapi: {
        server: {
          app,
          routes: jest.fn((routes: Array<{ handler: Koa.Middleware }>) => {
            if (serveFallback) app.use(routes[0].handler);
          }),
        },
      },
    } as unknown as BuildContext);
    expect(mergeConfigWithUserConfig).toHaveBeenCalled();
    if (!serveFallback)
      app.use((ctx) => {
        ctx.status = 404;
        ctx.body = 'downstream';
      });
    return request(app.callback());
  };

  it('serves assets and HEAD requests, preserves ranges and passes missing assets downstream', async () => {
    const client = await start();
    const asset = await client.get('/admin/main.js').timeout(10000).expect(200);
    expect(asset.text).toContain('admin fixture');
    const head = await client.head('/admin/main.js').timeout(10000).expect(200);
    expect(head.text).toBeUndefined();
    expect(head.headers['content-length']).toBe(asset.headers['content-length']);
    const partial = await client
      .get('/admin/main.js')
      .set('Range', 'bytes=0-9')
      .timeout(10000)
      .expect(206);
    expect(partial.text).toBe(asset.text.slice(0, 10));
    await client.get('/admin/main.js').set('Range', 'bytes=999999-').timeout(10000).expect(416);
    await client.get('/admin/missing.js').timeout(10000).expect(404, 'downstream');
    await client.post('/admin/main.js').timeout(10000).expect(404, 'downstream');
  });

  it('serves the admin shell for client-side routes', async () => {
    const client = await start('/admin/', true);
    await client.get('/admin/settings').timeout(10000).expect(200, '<html>admin shell</html>');
    await client.post('/admin/settings').timeout(10000).expect(404);
  });

  it('keeps the hot middleware endpoint and rebuilds after an entry change', async () => {
    const client = await start();
    const server = http.createServer(app.callback());
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${address.port}/__webpack_hmr`, (response) => {
          try {
            expect(response.statusCode).toBe(200);
            expect(response.headers['content-type']).toContain('text/event-stream');
            response.destroy();
            resolve();
          } catch (error) {
            response.destroy();
            reject(error);
          }
        });
        req.setTimeout(10000, () => req.destroy(new Error('HMR response timed out')));
        req.on('error', reject);
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await fs.writeFile(path.join(directory, 'entry.js'), 'console.log("updated fixture");');
    let content = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await client.get('/admin/main.js').timeout(10000).expect(200);
      content = response.text;
      if (content.includes('updated fixture')) break;
      await delay(100);
    }
    expect(content).toContain('updated fixture');
  });

  it('does not expose sibling output files when a custom publicPath lacks a trailing slash', async () => {
    const client = await start('/admin');
    await client.get('/admin/main.js').timeout(10000).expect(200);
    const response = await client.get('/admin../secret.txt').timeout(10000);
    expect([403, 404]).toContain(response.status);
    expect(response.text).not.toContain('outside-output-secret');
  });
});
