import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function rootWithShared() {
  const root = mkdtempSync(join(tmpdir(), 'household-'));
  dirs.push(root);
  mkdirSync(join(root, 'deployments/shared'), { recursive: true });
  writeFileSync(join(root, 'deployments/shared/config.json'), JSON.stringify({ batching: { maxBatchSize: 7 } }));
  writeFileSync(join(root, 'deployments/shared/policy.json'), JSON.stringify({ version: 1, individualPrefixes: ['web', 'paths'], individualPaths: ['displayName'] }));
  return root;
}

async function manager(root: string, origin: string) {
  const { createHouseholdServer } = await import('../../apps/household/server.ts');
  const server = createHouseholdServer({ rootDir: root, mode: 'live', targets: { amber: origin, bailong: origin, jingyu: origin } });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it('serves the native panel unchanged and adds only the instance switcher', async () => {
  const root = rootWithShared();
  const upstream = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><div id="app"></div></body></html>');
  });
  const url = await manager(root, upstream);
  const html = await (await fetch(url + '/')).text();
  expect(html).toContain('<div id="app"></div>');
  expect(html).toContain('/__household/switcher.js');
  const script = await (await fetch(url + '/__household/switcher.js')).text();
  for (const label of ['琥珀', '白龙', '鲸鱼']) expect(script).toContain(label);
});

it('writes shared keys to the one shared file and leaves individual keys upstream', async () => {
  const root = rootWithShared();
  const seen: Array<Record<string, unknown>> = [];
  const upstream = await serve((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      seen.push(JSON.parse(text || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: '个体已保存' }));
    });
  });
  const url = await manager(root, upstream);
  const response = await fetch(url + '/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group: 'core', values: { 'batching.maxBatchSize': 8, displayName: '名字' } }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { result: string };
  expect(body.result).toContain('公共配置已保存');
  expect(body.result).toContain('个体已保存');
  expect(JSON.parse(readFileSync(join(root, 'deployments/shared/config.json'), 'utf8')).batching.maxBatchSize).toBe(8);
  expect(seen[0]).toEqual({ group: 'core', values: { displayName: '名字' } });
});

it('reports an unreachable instance instead of a blank page', async () => {
  const root = rootWithShared();
  const dead = await serve((_req, res) => res.end());
  const closed = new URL(dead);
  const port = Number(closed.port);
  await new Promise<void>((r) => servers.splice(servers.length - 1, 1)[0].close(() => r()));
  const url = await manager(root, `http://127.0.0.1:${port}`);
  const response = await fetch(url + '/api/status');
  expect(response.status).toBe(502);
  expect((await response.json() as { error: string }).error).toContain('琥珀');
});
