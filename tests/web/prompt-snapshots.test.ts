import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp } from '../../src/web/server.ts';
import { PromptLog, readPromptList, readPromptDetail } from '../../src/core/prompt-log.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';
let app: WebApp; let base: string; let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'web-prompts-')); const run = 'r-test';
  mkdirSync(join(dir, 'runs', run), { recursive: true });
  const log = new PromptLog(join(dir, 'runs', run), run, () => {});
  for (let i = 1; i <= 3; i++) log.start({ model: 'fixture', input: `round-${i}` }, { sessionId: 'main', round: i }).finish('completed');
  app = new WebApp({ store: new FakeStore(), dataDir: dir, memoryDir: dir, getStatus: () => ({}), log: nullLogger(),
    promptSnapshots: { list: (run, opts) => readPromptList(dir, run, opts), detail: (run, id) => readPromptDetail(dir, run, id), onChange: cb => log.onChange(cb) },
    debug: { runId: () => run, sessionMessages: () => [], onSessionAppend: () => {}, onSessionReset: () => {}, onEvent: () => {}, onRunlog: () => {}, toolSchemas: () => [] },
  });
  base = `http://127.0.0.1:${await app.start(0)}`;
});
afterAll(async () => { await app.stop(); rmSync(dir, { recursive: true, force: true }); });
it('returns summaries in pages and full input only through detail', async () => {
  const page = await (await fetch(`${base}/api/prompt-snapshots?limit=2`)).json() as any;
  expect(page.items.map((x: any) => x.round)).toEqual([3, 2]); expect(JSON.stringify(page)).not.toContain('round-3');
  const old = await (await fetch(`${base}/api/prompt-snapshots?before=${page.nextBefore}&limit=2`)).json() as any;
  expect(old.items.map((x: any) => x.round)).toEqual([1]);
  const detail = await (await fetch(`${base}/api/prompt-snapshots/detail?run=r-test&id=${old.items[0].id}`)).json() as any;
  expect(detail.request.input).toBe('round-1');
});
it('exposes missing history and filters sessions', async () => {
  expect(await (await fetch(`${base}/api/prompt-snapshots?run=r-old`)).json()).toMatchObject({ recorded: false, items: [] });
  expect(await (await fetch(`${base}/api/prompt-snapshots?session=fork`)).json()).toMatchObject({ recorded: true, items: [] });
});
it('rejects traversal, invalid cursors and missing detail', async () => {
  for (const query of ['run=../secret', 'before=nope', 'limit=-1']) expect((await fetch(`${base}/api/prompt-snapshots?${query}`)).status).toBe(400);
  expect((await fetch(`${base}/api/prompt-snapshots/detail?run=r-test&id=../secret`)).status).toBe(400);
  expect((await fetch(`${base}/api/prompt-snapshots/detail?run=r-test&id=00000000-0000-0000-0000-000000000000`)).status).toBe(404);
});
