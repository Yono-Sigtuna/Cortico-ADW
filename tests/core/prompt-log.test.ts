import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptLog, observeResponseClient, readPromptList, readPromptDetail } from '../../src/core/prompt-log.ts';
import { message } from '../../src/protocol/open-responses/context.ts';
import type { ResponseClient } from '../../src/core/generation.ts';

const dirs: string[] = [];
function setup() {
  const data = mkdtempSync(join(tmpdir(), 'prompt-log-')); dirs.push(data);
  const run = 'r-test'; const dir = join(data, 'runs', run); mkdirSync(dir, { recursive: true });
  const errors: string[] = [];
  return { data, run, dir, errors, log: new PromptLog(dir, run, e => errors.push(e)) };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const response = () => ({ response: { id: 'response-test', output: [], status: 'completed' }, attempts: [], origin: { instance: 'test', module: 'test', model: 'test', compatibilityDomain: 'test' } }) as any;

describe('immutable per-call prompt snapshots', () => {
  it('retains three independent tool rounds, their dynamic heads, and full text after reopening', async () => {
    const s = setup();
    const llm = observeResponseClient({ respond: async () => response() }, s.log);
    const context = [message('system', 'identity'), message('user', 'head-1')];
    for (let round = 1; round <= 3; round++) {
      context[1] = message('user', `head-${round}`);
      if (round > 1) context.push(message('user', `tool-result-${round - 1}`));
      await llm.respond({ model: 'test', input: context.map(r => r.item), tools: [] } as any, { sessionId: 'main', round, context });
    }
    context[0] = message('system', 'changed');
    new PromptLog(s.dir, s.run, e => s.errors.push(e));
    const list = readPromptList(s.data, s.run, { limit: 2 });
    expect(list.recorded).toBe(true); expect(list.items.map(i => i.round)).toEqual([3, 2]);
    const older = readPromptList(s.data, s.run, { before: list.nextBefore!, limit: 2 });
    expect(older.items.map(i => i.round)).toEqual([1]);
    const first = readPromptDetail(s.data, s.run, older.items[0].id)!;
    expect(JSON.stringify(first.context)).toContain('head-1');
    expect(JSON.stringify(first.context)).not.toContain('changed');
    const second = readPromptDetail(s.data, s.run, list.items[1].id)!;
    expect(JSON.stringify(second.request)).toContain('tool-result-1');
    expect(first.summary.outcome).toBe('completed'); expect(s.errors).toEqual([]);
  });

  it('records failed and aborted calls even without output', async () => {
    const s = setup(); let calls = 0;
    const llm = observeResponseClient({ respond: async () => { calls++; throw Object.assign(new Error('not available'), { name: calls === 2 ? 'AbortError' : 'Error' }); } }, s.log);
    for (let i = 0; i < 2; i++) await expect(llm.respond({ input: [] } as any, { sessionId: 'fork-1', round: i + 1 })).rejects.toThrow('not available');
    expect(readPromptList(s.data, s.run, { session: 'fork-1' }).items.map(i => i.outcome)).toEqual(['aborted', 'failed']);
    expect(readPromptList(s.data, s.run, { session: 'main' }).items).toEqual([]);
  });

  it('preserves bound clients and associates two wire attempts with one call', async () => {
    const s = setup(); let endpoint = 'one'; let seen = '';
    const source: ResponseClient = {
      respond: async () => { throw new Error('must bind'); },
      bind: () => { const selected = endpoint; return { respond: async (_r, opts) => {
        seen = selected;
        for (let i = 0; i < 2; i++) opts?.onRequest?.({ generationId: 'g', attemptId: `attempt-${i}`, ordinal: i, startedAt: '2026-11-07T00:00:00Z', body: JSON.stringify({ messages: [{ role: 'user', content: 'actual-native-body' }] }), diagnostic: false });
        return response();
      } }; },
    };
    const bound = observeResponseClient(source, s.log).bind!(); endpoint = 'two';
    await bound.respond({ input: [] } as any, { sessionId: 'fork-1', round: 1 });
    expect(seen).toBe('one');
    const list = readPromptList(s.data, s.run); expect(list.items).toHaveLength(1);
    const detail = readPromptDetail(s.data, s.run, list.items[0].id)!;
    expect(detail.attempts.map(a => a.ordinal)).toEqual([0, 1]);
    expect(detail.attempts[0].body).toContain('actual-native-body');
  });

  it('reports persistence failure without changing model outcome', async () => {
    const s = setup();
    const bad = join(s.dir, 'file'); writeFileSync(bad, 'not a directory');
    const log = new PromptLog(bad, s.run, e => s.errors.push(e));
    await expect(observeResponseClient({ respond: async () => response() }, log).respond({ input: [] } as any)).resolves.toHaveProperty('response.id', 'response-test');
    expect(s.errors.length).toBeGreaterThan(0);
  });

  it('recovers a partial index tail before subsequent successful calls', () => {
    const s = setup(); s.log.start({ input: 'first' }).finish('completed');
    appendFileSync(join(s.dir, 'prompts', 'index.jsonl'), '{"broken":');
    s.log.start({ input: 'second' }).finish('completed');
    const list = readPromptList(s.data, s.run); expect(list.items).toHaveLength(2);
    expect(list.items.map(x => readPromptDetail(s.data, s.run, x.id)?.request.input)).toEqual(['second', 'first']);
  });

  it('retains readable snapshots after an interrupted final index write', () => {
    const s = setup(); s.log.start({ input: 'saved' }).finish('completed');
    appendFileSync(join(s.dir, 'prompts', 'index.jsonl'), '{"unfinished":');
    const list = readPromptList(s.data, s.run); expect(list.items).toHaveLength(1);
    expect(readPromptDetail(s.data, s.run, list.items[0].id)?.request.input).toBe('saved');
  });

  it('stores only body observation fields, never extra authentication properties', () => {
    const s = setup(); const capture = s.log.start({ input: 'saved' });
    capture.transport({ generationId: 'g', attemptId: 'a', ordinal: 0, startedAt: '', body: '{}', diagnostic: false,
      headers: { Authorization: 'SECRET_AUTH' } } as any);
    const list = readPromptList(s.data, s.run);
    expect(JSON.stringify(readPromptDetail(s.data, s.run, list.items[0].id))).not.toContain('SECRET_AUTH');
  });

  it('rejects unsafe identifiers and distinguishes unrecorded old runs', () => {
    const s = setup();
    expect(readPromptList(s.data, 'r-old').recorded).toBe(false);
    expect(() => readPromptList(s.data, '../outside')).toThrow();
    expect(() => readPromptDetail(s.data, s.run, '../secret')).toThrow();
    expect(readPromptDetail(s.data, s.run, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
