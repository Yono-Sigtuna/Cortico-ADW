import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { ToolDef, ToolOutcome } from '../../src/core/types.ts';
import { CortiSoulmate } from '../../bots/amber/persona/index.ts';
import { composeDefaults } from '../../bots/amber/assemble.ts';
import type { LifeStateStore } from '../../bots/amber/persona/companion/lifeState.ts';
import type { MemoryIndex } from '../../bots/amber/persona/memoryIndex.ts';
import { makeFakeHarnessApi, makeFakeIO, makeTmpDir } from '../core/helpers.ts';

const T = Date.parse('2026-11-06T06:00:00Z');
const update = { doing: '在窗边站一会儿', sleeping: false, location: '家里·窗边', until: '14:10' };
const outputText = (out: string | ToolOutcome) => typeof out === 'string' ? out : out.text;

describe('发言前的明确活动决策', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let persona: CortiSoulmate;
  let internal: { life: LifeStateStore; index: MemoryIndex | null };
  let original: ToolDef;
  let calls: Array<{ args: Record<string, unknown>; activity: string | null; saved: unknown }>;
  let result: string | ToolOutcome;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    tmp = makeTmpDir();
    calls = [];
    result = '[sent]';
    original = {
      name: 'fixture_say', description: '对外发言。', tags: ['speak'], barrierAfter: true,
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: async (args) => {
        calls.push({
          args,
          activity: internal.life.snapshot({ energy: 60, mood: '平稳', health: null, sleepText: null }).current?.activity ?? null,
          saved: JSON.parse(readFileSync(internal.life.file!, 'utf8')),
        });
        return result;
      },
    };
    persona = new CortiSoulmate({ memoryDir: tmp.dir, wakeLogDir: tmp.dir, cfg: composeDefaults(), worlds: [makeFakeIO('fixture', [original])] });
    persona.attach(makeFakeHarnessApi());
    internal = persona as unknown as typeof internal;
    internal.life.setPlan([]);
  });

  afterEach(() => {
    persona.stopRhythm();
    internal.index?.close();
    tmp.cleanup();
    vi.useRealTimers();
  });

  const speak = () => persona.declareSessions().find((session) => session.id === 'main')!.tools().find((tool) => tool.name === 'fixture_say')!;
  const run = (args: Record<string, unknown>) => speak().handler(args, { role: 'main', log: makeFakeHarnessApi().log });

  it('漏填活动决策时拒发，不能悄悄按未改变处理', async () => {
    expect(outputText(await run({ text: '窗边。' }))).toContain('life_update');
    expect(calls).toHaveLength(0);
    expect(internal.life.current.actualActivity).toBeUndefined();
  });

  it('非发言工具与沉默出口不强制活动决策', async () => {
    original.tags = ['read'];
    expect(speak().parameters.required).toEqual(['text']);
    expect(outputText(await run({ text: '只读调用' }))).toBe('[sent]');
    const end = persona.declareSessions().find((session) => session.id === 'main')!.tools().find((tool) => tool.name === 'end_turn')!;
    expect(end.parameters.required ?? []).not.toContain('life_update');
    expect(outputText(await end.handler({}, { role: 'main', log: makeFakeHarnessApi().log }))).toContain('turn ended');
    expect(internal.life.current.actualActivity).toBeUndefined();
  });

  it('明确 null 不改状态，元数据不传入 World', async () => {
    expect(outputText(await run({ text: '在听。', life_update: null }))).toBe('[sent]');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ text: '在听。' });
    expect(internal.life.current.actualActivity).toBeUndefined();
  });

  it('同次发言提交活动：World handler 执行前，内存与磁盘都已更新', async () => {
    const out = await run({ text: '窗边。', life_update: update });
    expect(outputText(out)).toContain('[life advanced]');
    expect(outputText(out)).toContain('[sent]');
    expect(calls[0].activity).toBe(update.doing);
    expect((calls[0].saved as { actualActivity: { location: string } }).actualActivity.location).toBe(update.location);
    expect(calls[0].args).toEqual({ text: '窗边。' });
    expect(internal.life.current.plan?.slots).toEqual([]);
  });

  it.each([42, [], { doing: '在窗边', sleeping: 'false' }, { sleeping: false }])('坏活动声明不外发：%j', async (life_update) => {
    expect(outputText(await run({ text: '窗边。', life_update }))).toContain('[life failed]');
    expect(calls).toHaveLength(0);
  });

  it('发言携带相对五分钟时由运行时精确计算，并在保存后才外发', async () => {
    vi.setSystemTime(T + 17_432);
    const out = await run({ text: '坐五分钟。', life_update: { doing: '在沙发看画册', sleeping: false, location: '沙发', duration_minutes: 5 } });
    expect(outputText(out)).toContain('[life advanced]');
    expect(outputText(out)).toContain('5 分钟');
    const saved = calls[0].saved as { actualActivity: { startedAt: number; endsAt: number } };
    expect(saved.actualActivity.endsAt - saved.actualActivity.startedAt).toBe(5 * 60_000);
    expect(saved.actualActivity.startedAt).toBe(T + 17_432);
    expect(calls[0].args).toEqual({ text: '坐五分钟。' });
  });

  it.each([
    { duration_minutes: '5' },
    { duration_minutes: 0 },
    { duration_minutes: -1 },
    { duration_minutes: Infinity },
    { duration_minutes: 5, until: '14:10' },
  ])('相对时长错误或冲突时不保存、不发言：%j', async (duration) => {
    const before = JSON.stringify(internal.life.current);
    const out = await run({ text: '坐五分钟。', life_update: { doing: '翻画册', sleeping: false, ...duration } });
    expect(outputText(out)).toContain('[life failed]');
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(internal.life.current)).toBe(before);
  });

  it('更新说明或显式 null 都不把剩余时间重新变为五分钟', async () => {
    await run({ text: '坐五分钟。', life_update: { doing: '翻画册', sleeping: false, duration_minutes: 5 } });
    vi.setSystemTime(T + 2 * 60_000);
    await run({ text: '翻到下一页。', life_update: { doing: '翻到下一页', sleeping: false } });
    expect(internal.life.current.actualActivity?.startedAt).toBe(T);
    expect(internal.life.current.actualActivity?.endsAt).toBe(T + 5 * 60_000);
    await run({ text: '还在看。', life_update: null });
    expect(internal.life.current.actualActivity?.endsAt).toBe(T + 5 * 60_000);
  });

  it('空档缺明确结束时间时拒发，并保留空计划', async () => {
    const out = await run({ text: '窗边。', life_update: { doing: '在窗边', sleeping: false } });
    expect(outputText(out)).toContain('until');
    expect(calls).toHaveLength(0);
    expect(internal.life.current.actualActivity).toBeUndefined();
    expect(internal.life.current.plan?.slots).toEqual([]);
  });

  it('写盘失败不外发，内存恢复为调用前的状态', async () => {
    const before = JSON.stringify(internal.life.current);
    rmSync(internal.life.file!);
    mkdirSync(internal.life.file!);
    const out = await run({ text: '窗边。', life_update: update });
    expect(outputText(out)).toContain('[life failed]');
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(internal.life.current)).toBe(before);
  });

  it('克隆 schema 并保留原 required、屏障与 ToolOutcome', async () => {
    const schema = JSON.stringify(original.parameters);
    result = { text: '[sent]', endTurn: true, blobs: [{ bytes: new Uint8Array([1]), mime: 'image/png', fallbackText: '测试附件' }] };
    const wrapped = speak();
    expect(wrapped.parameters.required).toEqual(['text', 'life_update']);
    expect(wrapped.barrierAfter).toBe(true);
    const out = await run({ text: '窗边。', life_update: update }) as ToolOutcome;
    expect(out.endTurn).toBe(true);
    expect(out.blobs).toEqual(result.blobs);
    expect(JSON.stringify(original.parameters)).toBe(schema);
  });

  it.each(['[draft held]', '[send failed]', '[draft discarded]'])('发言未完成不回滚已明确发生的活动，也不在确认时重放：%s', async (receipt) => {
    result = receipt;
    await run({ text: '窗边。', life_update: update });
    expect(internal.life.current.actualActivity?.activity).toBe(update.doing);
    const saved = JSON.stringify(internal.life.current.actualActivity);
    vi.setSystemTime(T + 60_000);
    await run({ text: '继续原消息。', life_update: null });
    expect(JSON.stringify(internal.life.current.actualActivity)).toBe(saved);
  });
});
