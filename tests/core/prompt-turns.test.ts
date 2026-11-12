import { afterEach, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PromptLog, observeResponseClient, readPromptDetail, readPromptList } from '../../src/core/prompt-log.ts';
import { createResponse } from '../../src/protocol/open-responses/index.ts';
import { message, functionCall, functionResult } from '../../src/protocol/open-responses/context.ts';
import { GenerationError } from '../../src/core/generation.ts';
import { makeTmpDir } from './helpers.ts';
const cleanups: Array<() => void> = [];
const origin = { instance: 'fixture', module: 'fixture', model: 'fixture', compatibilityDomain: 'fixture' };
function rig() {
  const tmp = makeTmpDir(); cleanups.push(tmp.cleanup); const run = 'r-test'; const dir = join(tmp.dir, 'runs', run);
  mkdirSync(dir, { recursive: true }); const log = new PromptLog(dir, run, e => { throw new Error(e); });
  return { data: tmp.dir, dir, run, log };
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
it('persists two distinct response processes with three input/output pairs each', async () => {
  const s = rig(); let n = 0;
  const llm = observeResponseClient({ respond: async request => {
    const response = createResponse(`r-${++n}`, request); response.status = 'completed';
    response.output = [message('assistant', `result-${n}`).item as any];
    return { response, origin, attempts: [] };
  } }, s.log);
  const ids: string[] = [];
  for (let t = 0; t < 2; t++) {
    const turn = s.log.beginTurn('main'); ids.push(turn.id);
    for (let round = 1; round <= 3; round++) await llm.respond({ input: `input-${t * 3 + round}` }, { sessionId: 'main', turnId: turn.id, turnRound: round, round: t * 3 + round });
    turn.end();
  }
  new PromptLog(s.dir, s.run, () => {});
  const list = readPromptList(s.data, s.run);
  expect(list.turns?.map(t => t.calls)).toEqual([3, 3]);
  expect(list.turns?.every(t => !!t.endedAt)).toBe(true);
  expect(new Set(list.items.map(i => i.turnId)).size).toBe(2);
  expect(list.items.map(i => i.turnRound)).toEqual([3, 2, 1, 3, 2, 1]);
  for (const item of list.items) {
    const detail = readPromptDetail(s.data, s.run, item.id)!;
    expect(detail.request.input).toBe(`input-${item.sequence}`);
    expect(JSON.stringify(detail.result?.response?.output)).toContain(`result-${item.sequence}`);
    expect(detail.summary.turnId).toBe(ids[item.sequence > 3 ? 1 : 0]);
  }
  expect(readPromptList(s.data, s.run, { limit: 2 }).turns?.[0].calls).toBe(3);
});
it('associates last-round tool receipts by session and call id, without waiting for a next prompt', async () => {
  const s = rig();
  const llm = observeResponseClient({ respond: async request => {
    const response = createResponse('response', request); response.status = 'completed';
    response.output = [functionCall('same-call', 'touch', '{}').item as any];
    return { response, origin, attempts: [] };
  } }, s.log);
  const a = s.log.beginTurn('main'); const b = s.log.beginTurn('fork-1');
  await llm.respond({ input: 'main' }, { sessionId: 'main', turnId: a.id, turnRound: 1 });
  await llm.respond({ input: 'fork' }, { sessionId: 'fork-1', turnId: b.id, turnRound: 1 });
  s.log.recordToolResult(functionResult('same-call', 'fork-receipt'), 'fork-1');
  s.log.recordToolResult(functionResult('same-call', 'main-receipt'), 'main');
  a.end(); b.end();
  for (const item of readPromptList(s.data, s.run).items) {
    const detail = readPromptDetail(s.data, s.run, item.id)!;
    expect(JSON.stringify(detail.toolResults)).toContain(item.sessionId === 'main' ? 'main-receipt' : 'fork-receipt');
    expect(detail.toolResults).toHaveLength(1);
  }
});
it('saves partial output on failure without exposing the provider error body', async () => {
  const s = rig(); const partial = createResponse('partial', { input: 'start' });
  partial.output = [message('assistant', 'partial-answer').item as any];
  const error = new GenerationError('upstream interrupted', [], partial, origin, 500, 'PRIVATE_PROVIDER_BODY');
  const llm = observeResponseClient({ respond: async () => { throw error; } }, s.log);
  await expect(llm.respond({ input: 'start' })).rejects.toBe(error);
  const item = readPromptList(s.data, s.run).items[0];
  const detail = readPromptDetail(s.data, s.run, item.id)!;
  expect(detail.result?.partial).toBe(true); expect(JSON.stringify(detail.result)).toContain('partial-answer');
  expect(JSON.stringify(detail)).not.toContain('PRIVATE_PROVIDER_BODY'); expect(item.outcome).toBe('failed');
});
it('does not invent process boundaries or outputs for legacy inputs', () => {
  const s = rig(); s.log.start({ input: 'legacy' }).finish('completed');
  const item = readPromptList(s.data, s.run).items[0];
  expect(item.turnId).toBeUndefined();
  expect(readPromptDetail(s.data, s.run, item.id)?.result).toBeUndefined();
});
