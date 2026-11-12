import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAIHttpClient } from '../../src/providers/transport/chat.ts';
import type { NativeChatMessage } from '../../src/providers/transport/native-types.ts';
import type { ModelSpec } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';
import { PromptLog, observeResponseClient, readPromptDetail, readPromptList } from '../../src/core/prompt-log.ts';
import { makeTmpDir } from '../core/helpers.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
let server: Server; let port: number; const bodies: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      bodies.push(body); res.setHeader('content-type', 'application/json');
      if (bodies.length === 1) { res.statusCode = 429; res.setHeader('retry-after', '0'); res.end('{"error":"retry"}'); }
      else res.end(JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as any).port;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
class LocalClient extends OpenAIHttpClient {
  constructor() { super(`http://127.0.0.1:${port}`, nullLogger()); }
  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[]) { return { model: spec.model, messages }; }
  protected headers() { return { 'content-type': 'application/json', Authorization: 'Bearer PRIVATE_FIXTURE_AUTH' }; }
}
it('captures exactly the native bodies received by HTTP across retries, without authentication metadata', async () => {
  const tmp = makeTmpDir();
  try {
    const dir = join(tmp.dir, 'runs', 'r-test'); mkdirSync(dir, { recursive: true });
    const log = new PromptLog(dir, 'r-test', e => { throw new Error(e); });
    await observeResponseClient(new LocalClient(), log).respond({ model: 'fixture', input: [{ type: 'message', role: 'user', content: 'hello \ud83c' }] }, { sessionId: 'main', round: 1 });
    const list = readPromptList(tmp.dir, 'r-test'); expect(list.items).toHaveLength(1);
    const detail = readPromptDetail(tmp.dir, 'r-test', list.items[0].id)!;
    expect(detail.attempts.map(a => a.body)).toEqual(bodies);
    expect(detail.attempts).toHaveLength(2); expect(new Set(detail.attempts.map(a => a.attemptId)).size).toBe(2);
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_FIXTURE_AUTH');
    expect(JSON.parse(detail.attempts[0].body).messages[0].content).toBe('hello �');
  } finally { tmp.cleanup(); }
});
