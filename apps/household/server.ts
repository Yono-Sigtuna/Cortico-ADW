import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HouseholdService } from './service.ts';
import { MEMBERS, POLICY, type HouseholdId } from './policy.ts';
import { ConfigError } from '../../src/config/types.ts';
import { configScope } from '../../src/config/shared.ts';
import { readPolicy } from '../../src/config/shared.ts';

const SELECT_COOKIE = 'household_instance';
const SWITCHER_PATH = '/__household/switcher.js';
const SELECT_PATH = '/__household/select';

export interface ManagerOptions {
  rootDir: string;
  mode: 'live' | 'fixture';
  /** Instance origins, keyed by member id. Defaults to the loopback ports. */
  targets?: Partial<Record<HouseholdId, string>>;
}

const member = (id: string) => MEMBERS.find((m) => m.id === id);

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

function selected(req: IncomingMessage): HouseholdId {
  const id = cookieValue(req.headers.cookie, SELECT_COOKIE) ?? '';
  return member(id)?.id ?? MEMBERS[0].id;
}

function targetOf(id: HouseholdId, options: ManagerOptions): URL {
  const explicit = options.targets?.[id];
  if (explicit) {
    const url = new URL(explicit);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new ConfigError('Instance target must be a loopback HTTP origin');
    }
    return url;
  }
  return new URL(`http://127.0.0.1:${member(id)!.port}`);
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'content-length']);

function upstreamHeaders(req: IncomingMessage, origin: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP.has(name) || value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  out.host = origin.host;
  // The instance rejects a cross-site Origin; the manager is the only client it sees.
  if (out.origin) out.origin = origin.origin;
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * The panel edits one group at a time, and that group can hold both shared and
 * individual keys. Shared keys go to the shared file, the rest stay with the
 * instance, so a mixed save still succeeds as one action from the operator's side.
 */
async function splitSharedGroup(
  service: HouseholdService,
  body: Record<string, unknown>,
  expectedRevision?: string,
): Promise<{ shared: string | null; rest: Record<string, unknown> | null }> {
  const values = body.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { shared: null, rest: null };
  const policy = readPolicy(service.ref, service.rootDir);
  const shared: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    (configScope(path, policy) === 'shared' ? shared : rest)[path] = value;
  }
  const sharedResult = Object.keys(shared).length
    ? `公共配置已保存（版本 ${service.saveShared(String(body.group ?? ''), shared, expectedRevision ?? service.snapshot().revision).revision.slice(0, 10)}）；各实例下次启动读取。`
    : null;
  return { shared: sharedResult, rest: Object.keys(rest).length ? { ...body, values: rest } : null };
}

function switcherScript(mode: string): string {
  const members = MEMBERS.map((m) => ({ id: m.id, label: m.label, color: m.color }));
  return `(() => {
  const MEMBERS = ${JSON.stringify(members)};
  const MODE = ${JSON.stringify(mode)};
  const COOKIE = ${JSON.stringify(SELECT_COOKIE)};
  const current = document.cookie.split('; ').find((c) => c.startsWith(COOKIE + '='));
  const active = current ? decodeURIComponent(current.split('=')[1]) : MEMBERS[0].id;
  const bar = document.createElement('div');
  bar.id = 'household-switcher';
  bar.innerHTML = \`<style>
    #household-switcher{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147483000;
      display:flex;gap:2px;padding:5px;border-radius:999px;background:#1f2933e6;backdrop-filter:blur(10px);
      box-shadow:0 6px 24px #0f172a55;font:12px/1 system-ui,sans-serif}
    #household-switcher button{border:0;background:transparent;color:#c7d3de;padding:8px 14px;border-radius:999px;
      cursor:pointer;display:flex;align-items:center;gap:7px;font:inherit}
    #household-switcher button:hover{background:#ffffff1a;color:#fff}
    #household-switcher button[aria-current]{background:#fff;color:#1f2933;font-weight:600}
    #household-switcher i{width:7px;height:7px;border-radius:50%;display:block}
    #household-switcher .mode{color:#8fa3b5;padding:8px 10px;font-size:11px;align-self:center}
  </style>\`;
  for (const m of MEMBERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = '<i style="background:' + m.color + '"></i>' + m.label;
    if (m.id === active) button.setAttribute('aria-current', 'true');
    button.onclick = () => {
      document.cookie = COOKIE + '=' + encodeURIComponent(m.id) + ';path=/;max-age=31536000;samesite=strict';
      location.reload();
    };
    bar.append(button);
  }
  if (MODE === 'fixture') {
    const tag = document.createElement('span');
    tag.className = 'mode';
    tag.textContent = '假数据预览';
    bar.append(tag);
  }
  addEventListener('DOMContentLoaded', () => document.body.append(bar));
})();`;
}

export function createHouseholdServer(options: ManagerOptions): Server {
  const service = new HouseholdService(options.rootDir);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const hostHeader = req.headers.host ?? '';
      const originHeader = req.headers.origin;
      if (originHeader && originHeader !== `http://${hostHeader}`) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '跨站请求被拒绝' }));
        return;
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '跨站请求被拒绝' }));
        return;
      }
      if (url.pathname === SWITCHER_PATH) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(switcherScript(options.mode));
        return;
      }
      if (url.pathname === SELECT_PATH && req.method === 'POST') {
        const id = member(String(url.searchParams.get('id') ?? ''));
        if (!id) throw new ConfigError('Unknown instance');
        res.writeHead(204, { 'set-cookie': `${SELECT_COOKIE}=${encodeURIComponent(id.id)};Path=/;Max-Age=31536000;SameSite=Strict;HttpOnly` });
        res.end();
        return;
      }

      const id = selected(req);
      const origin = targetOf(id, options);
      let body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      let sharedMessage: string | null = null;

      if (url.pathname === '/api/config' && req.method === 'POST' && options.mode === 'live') {
        const parsed = JSON.parse(body?.toString('utf8') || '{}') as Record<string, unknown>;
        const expected = typeof parsed.expectedRevision === 'string' ? parsed.expectedRevision : undefined;
        const split = await splitSharedGroup(service, parsed, expected);
        sharedMessage = split.shared;
        if (!split.rest) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, result: sharedMessage }));
          return;
        }
        body = Buffer.from(JSON.stringify(split.rest));
      }

      const upstream = httpRequest(
        {
          protocol: origin.protocol,
          hostname: origin.hostname,
          port: origin.port,
          method: req.method,
          path: req.url,
          headers: {
            ...upstreamHeaders(req, origin),
            ...(body ? { 'content-length': String(body.length) } : {}),
            cookie: cookieValue(req.headers.cookie, 'cortico_session') ? `cortico_session=${cookieValue(req.headers.cookie, 'cortico_session')}` : '',
          },
        },
        (reply) => {
          const headers: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(reply.headers)) {
            if (name === 'connection' || name === 'transfer-encoding' || value === undefined) continue;
            headers[name] = value;
          }
          const type = String(reply.headers['content-type'] ?? '');
          const isDocument = type.includes('text/html');
          const mergeJson = sharedMessage !== null && type.includes('application/json');
          if (!isDocument && !mergeJson) {
            res.writeHead(reply.statusCode ?? 502, headers);
            reply.pipe(res);
            return;
          }
          const chunks: Buffer[] = [];
          reply.on('data', (c: Buffer) => chunks.push(c));
          reply.on('end', () => {
            if (mergeJson) {
              let merged: Record<string, unknown> = { ok: false };
              try { merged = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* keep failure shape */ }
              const existing = typeof merged.result === 'string' && merged.result ? `${merged.result}；` : '';
              merged.result = existing + sharedMessage;
              const payload = Buffer.from(JSON.stringify(merged));
              delete headers['content-length'];
              res.writeHead(reply.statusCode ?? 200, { ...headers, 'content-length': String(payload.length) });
              res.end(payload);
              return;
            }
            const html = Buffer.concat(chunks).toString('utf8')
              .replace('</body>', `<script src="${SWITCHER_PATH}"></script></body>`);
            delete headers['content-length'];
            res.writeHead(reply.statusCode ?? 200, { ...headers, 'content-length': String(Buffer.byteLength(html)) });
            res.end(html);
          });
        },
      );
      upstream.on('error', (error) => {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: `无法连接${member(id)!.label}；它可能没在运行。${error.message}` }));
      });
      if (body) upstream.end(body); else upstream.end();
    } catch (error) {
      const status = error instanceof ConfigError ? error.status : 500;
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: error instanceof ConfigError ? error.message : '管理服务请求失败' }));
      } else res.destroy();
    }
  });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const id = selected(req);
    const origin = targetOf(id, options);
    const upstream = connect({ host: origin.hostname, port: Number(origin.port) }, () => {
      // A WebSocket handshake needs Connection and Upgrade intact; everywhere else they are hop-by-hop.
      const headers: Record<string, string> = { connection: 'Upgrade', upgrade: String(req.headers.upgrade ?? 'websocket') };
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || name === 'connection' || name === 'upgrade' || name === 'host') continue;
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      headers.host = origin.host;
      if (headers.origin) headers.origin = origin.origin;
      const session = cookieValue(req.headers.cookie, 'cortico_session');
      if (session) headers.cookie = `cortico_session=${session}`;
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return server;
}

/** Kept for callers that already hold an Express app shape. */
export function createHouseholdApp(options: ManagerOptions) {
  return createHouseholdServer(options);
}

/** The built native WebUI is only used to detect an unbuilt checkout early. */
export function nativeBundlePresent(rootDir: string): boolean {
  return existsSync(join(resolve(rootDir, 'dist/web'), 'asset-manifest.json'));
}

export { POLICY };
