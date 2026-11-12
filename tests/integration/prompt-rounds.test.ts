import { expect, it } from 'vitest';
import { Core } from '../../src/core/core.ts';
import { runForkLoop } from '../../src/core/fork.ts';
import { readPromptList, readPromptDetail } from '../../src/core/prompt-log.ts';
import { message } from '../../src/protocol/open-responses/context.ts';
import { SessionTracker } from '../../src/core/sessions.ts';
import { nullLogger } from '../../src/core/util.ts';
import { SHUTDOWN_INTERRUPTED } from '../../src/core/markers.ts';
import { join } from 'node:path';
import { FakeLLM, makeCfg, makeFakePersona, makeLoaded, makeTmpDir, makeTool, sleep, textReply, toolReply } from '../core/helpers.ts';
it('records every real Core tool round and every fork round with independent context', async () => {
  const tmp = makeTmpDir(); const cfg = makeCfg();
  const llm = new FakeLLM(); let head = 0;
  const persona = makeFakePersona([makeTool('touch', 'tool-receipt')], { cfg, sessionHead: () => [message('user', `dynamic-head-${++head}`).item] });
  const core = new Core(makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir: tmp.dir, dataDir: join(tmp.dir, 'data') }), { worlds: [], persona, llm });
  try {
    llm.script(toolReply([{ name: 'touch', args: {} }]), toolReply([{ name: 'touch', args: {} }]), textReply('finished'));
    await core.start();
    const deadline = Date.now() + 5000;
    while ((llm.calls.length < 3 || core.loop.getStatus().phase.state !== 'idle') && Date.now() < deadline) await sleep(10);
    expect(llm.calls).toHaveLength(3);
    const list = readPromptList(core.loaded.dataDir, core.run.id, { session: 'main' });
    expect(list.items.map(x => x.round)).toEqual([3, 2, 1]);
    expect(list.turns).toHaveLength(1); expect(list.turns![0].calls).toBe(3); expect(list.turns![0].endedAt).toBeTruthy();
    expect(new Set(list.items.map(x => x.turnId)).size).toBe(1);
    expect(list.items.map(x => x.turnRound)).toEqual([3, 2, 1]);
    const details = [...list.items].reverse().map(x => readPromptDetail(core.loaded.dataDir, core.run.id, x.id)!);
    expect(JSON.stringify(details[1].request)).toContain('tool-receipt');
    expect(JSON.stringify(details[0].toolResults)).toContain('tool-receipt');
    expect(JSON.stringify(details[2].result?.response?.output)).toContain('finished');
    expect(details[0].request).not.toEqual(details[1].request);
    const firstHead = JSON.stringify(details[0].context?.filter(r => r.context.head));
    expect(firstHead).toContain('dynamic-head-');
    expect(firstHead).not.toBe(JSON.stringify(details[1].context?.filter(r => r.context.head)));
    llm.script(toolReply([{ name: 'touch', args: {} }]), toolReply([{ name: 'touch', args: {} }]), textReply('second finished'));
    core.wakeInternal('second response process', 'fixture');
    const secondDeadline = Date.now() + 5000;
    while ((llm.calls.length < 6 || core.loop.getStatus().phase.state !== 'idle') && Date.now() < secondDeadline) await sleep(10);
    const both = readPromptList(core.loaded.dataDir, core.run.id, { session: 'main' });
    expect(both.turns).toHaveLength(2); expect(both.turns!.map(t => t.calls)).toEqual([3, 3]);
    expect(both.items.map(x => x.turnRound)).toEqual([3, 2, 1, 3, 2, 1]);
    expect(new Set(both.items.map(x => x.turnId)).size).toBe(2);
    llm.script(toolReply([{ name: 'touch', args: {} }]), textReply('fork done'));
    const track = new SessionTracker(cfg.timezone).open('fixture', 'fixture');
    await runForkLoop({ id: 'fixture', llm: core.llm, spec: { model: 'fixture', thinking: false }, messages: [message('user', 'fork input')], tools: [makeTool('touch', 'fork-receipt')], maxRounds: 3, log: nullLogger(), track, prompts: core.prompts });
    const fork = readPromptList(core.loaded.dataDir, core.run.id, { session: track.id });
    expect(fork.items.map(x => x.round)).toEqual([2, 1]);
    expect(fork.turns![0].calls).toBe(2); expect(fork.turns![0].id).not.toBe(list.turns![0].id);
    expect(JSON.stringify(readPromptDetail(core.loaded.dataDir, core.run.id, fork.items[1].id)?.toolResults)).toContain('fork-receipt');
    expect(JSON.stringify(readPromptDetail(core.loaded.dataDir, core.run.id, fork.items[0].id)!.request)).toContain('fork-receipt');
  } finally { await core.stop(); tmp.cleanup(); }
}, 15000);

it('attributes externally initiated shutdown receipts to the pending model round', async () => {
  const tmp = makeTmpDir(); const cfg = makeCfg(); const llm = new FakeLLM();
  let entered = false; let release: () => void = () => {};
  const touch = { ...makeTool('touch', ''), handler: async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); return 'late-handler-result'; } };
  const persona = makeFakePersona([touch], { cfg });
  const core = new Core(makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir: tmp.dir, dataDir: join(tmp.dir, 'data') }), { worlds: [], persona, llm });
  try {
    llm.script(toolReply([{ name: 'touch', args: {} }])); await core.start();
    const deadline = Date.now() + 5000; while (!entered && Date.now() < deadline) await sleep(10);
    expect(entered).toBe(true);
    const stopping = core.stop(); release(); await stopping;
    const call = readPromptList(core.loaded.dataDir, core.run.id).items[0];
    const detail = readPromptDetail(core.loaded.dataDir, core.run.id, call.id)!;
    expect(JSON.stringify(core.session.records)).toContain(SHUTDOWN_INTERRUPTED);
    expect(JSON.stringify(detail.toolResults)).toContain(SHUTDOWN_INTERRUPTED);
    expect(JSON.stringify(detail.toolResults)).not.toContain('late-handler-result');
  } finally { release(); await core.stop(); tmp.cleanup(); }
}, 15000);
