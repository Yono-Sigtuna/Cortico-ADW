/** 记忆再固化：召回时交出用上的 id，收口时按结局给很小的增量。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryIndex } from '../../bots/amber/persona/memoryIndex.ts';
import { recallDelta } from '../../bots/amber/persona/memoryFeedback.ts';

describe('记忆再固化 · 结局映射', () => {
  it('发出去了加分，做了事小加分，冷场小减分，没发出去不加不减', () => {
    expect(recallDelta('sent', true)).toBe(0.02);
    expect(recallDelta('acted', true)).toBe(0.01);
    expect(recallDelta('silent', true)).toBe(-0.01);
    expect(recallDelta('unsent-text', true)).toBe(0);
  });

  it('没有外部输入的一轮不评价记忆', () => {
    expect(recallDelta('sent', false)).toBe(0);
    expect(recallDelta('silent', false)).toBe(0);
  });
});

describe('记忆再固化 · 索引', () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex(':memory:');
  });
  afterEach(() => index.close());

  it('recallBlock 交出真正用上的 id，injectBlock 仍然只给文本', () => {
    const id = index.put({
      text: '群主说 2026-10-23 面试又失败了，后来没再提。',
      kind: 'episodic',
      importance: 0.6,
      eventTime: '2026-10-23',
      people: ['3124076548'],
    });
    index.put({ text: '今天群里在聊新出的显卡。', kind: 'episodic', importance: 0.2 });

    const out = index.recallBlock('面试', 3, 700);
    expect(out.ids).toEqual([id]);
    expect(out.text).toContain('面试');
    expect(index.injectBlock('面试', 3, 700)).toBe(out.text);
    expect(index.recallBlock('完全不相干的量子色动力学', 3).ids).toEqual([]);
  });

  it('一条都放不进预算时，什么都不算用上', () => {
    index.put({ text: '很长的一条记忆'.repeat(50), kind: 'episodic', importance: 0.9 });
    const out = index.recallBlock('很长', 3, 10);
    expect(out).toEqual({ text: null, ids: [] });
  });

  it('正增量抬高重要性，且有上限', () => {
    const id = index.put({ text: '他会在我答错时直接指出来。', kind: 'relational', importance: 0.5 });
    expect(index.bumpImportance([id], 0.02)).toBe(1);
    expect(index.get(id)?.importance).toBeCloseTo(0.52, 5);
    for (let i = 0; i < 100; i += 1) index.bumpImportance([id], 0.02);
    expect(index.get(id)?.importance).toBe(1);
  });

  it('负增量压低重要性，有下限', () => {
    const id = index.put({ text: '一次没人接的冷场。', kind: 'episodic', importance: 0.2 });
    index.bumpImportance([id], -0.01);
    expect(index.get(id)?.importance).toBeCloseTo(0.19, 5);
    for (let i = 0; i < 100; i += 1) index.bumpImportance([id], -0.02);
    expect(index.get(id)?.importance).toBe(0.05);
  });

  it('空的、重复的、不存在的 id 都不会出错', () => {
    const id = index.put({ text: '一条普通的记录。', kind: 'factual', importance: 0.5 });
    expect(index.bumpImportance([], 0.02)).toBe(0);
    expect(index.bumpImportance([id, id], 0)).toBe(0);
    expect(index.bumpImportance(['nope'], 0.02)).toBe(0);
    expect(index.bumpImportance([id, 'nope'], 0.02)).toBe(1);
  });
});
