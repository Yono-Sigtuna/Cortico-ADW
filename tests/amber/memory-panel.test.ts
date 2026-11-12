/** 记忆面板的导入导出：round-trip、判重模式、无效条目。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryIndex } from '../../bots/amber/persona/memoryIndex.ts';
import { memindexInvoke, type MemoryPanelDeps } from '../../bots/amber/persona/memoryPanel.ts';
import { PersonRegistry } from '../../bots/amber/persona/people.ts';
import { makeTmpDir } from '../core/helpers.ts';

function depsFor(index: MemoryIndex, dir: string, onImported?: () => void): MemoryPanelDeps {
  const people = new PersonRegistry(dir);
  return {
    memoryIndex: () => index,
    dataDir: () => dir,
    memoryDir: () => dir,
    people: () => people,
    embedQuery: async () => null,
    embeddingModel: () => '',
    ...(onImported ? { onImported } : {}),
  };
}

describe('记忆导入导出', () => {
  let index: MemoryIndex;
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    index = new MemoryIndex(':memory:');
    tmp = makeTmpDir();
  });

  afterEach(() => {
    index.close();
    tmp.cleanup();
  });

  it('导出再导入，条目原样回来', async () => {
    index.put({ text: '群主说他面试又失败了。', kind: 'episodic', importance: 0.7, eventTime: '2026-10-23', source: 'people/a.md' });
    index.put({ text: '阿摆会直接指出我说话的味道不对。', kind: 'relational', importance: 0.8 });

    const out = await memindexInvoke(depsFor(index, tmp.dir), 'export', [{}]) as { content: string; count: number };
    expect(out.count).toBe(2);

    const fresh = new MemoryIndex(':memory:');
    const result = await memindexInvoke(depsFor(fresh, tmp.dir), 'import', [out.content, 'skip']) as {
      added: number; updated: number; skipped: number;
    };
    expect(result).toEqual(expect.objectContaining({ added: 2, updated: 0, skipped: 0 }));
    expect(fresh.count()).toBe(2);
    const texts = fresh.list().map((r) => r.text).sort();
    expect(texts).toEqual(['群主说他面试又失败了。', '阿摆会直接指出我说话的味道不对。'].sort());
    fresh.close();
  });

  it('跳过与覆盖两种判重模式', async () => {
    index.put({ id: 'fixed', text: '旧的一条记忆内容。', kind: 'factual', importance: 0.4 });
    const payload = JSON.stringify({ memories: [{ id: 'fixed', text: '新的一条记忆内容。', kind: 'factual', importance: 0.9 }] });

    const skipped = await memindexInvoke(depsFor(index, tmp.dir), 'import', [payload, 'skip']) as { skipped: number };
    expect(skipped.skipped).toBe(1);
    expect(index.get('fixed')?.text).toContain('旧的');

    const overwritten = await memindexInvoke(depsFor(index, tmp.dir), 'import', [payload, 'overwrite']) as { updated: number };
    expect(overwritten.updated).toBe(1);
    expect(index.get('fixed')?.text).toContain('新的');
    expect(index.get('fixed')?.importance).toBeCloseTo(0.9, 5);
  });

  it('坏条目只计数，不中断整次导入，也不写库', async () => {
    const payload = JSON.stringify([
      { text: '', kind: 'factual', importance: 0.5 },
      { text: '这是一条正常长度的记忆。', kind: 'factual', importance: 0.5 },
    ]);
    const out = await memindexInvoke(depsFor(index, tmp.dir), 'import', [payload, 'skip']) as { added: number; invalid: string[] };
    expect(out.added).toBe(1);
    expect(out.invalid.length).toBe(1);
    expect(index.count()).toBe(1);
  });

  it('导入成功后触发补向量回调', async () => {
    let called = 0;
    const payload = JSON.stringify([{ text: '需要补向量的一条记忆。', kind: 'factual', importance: 0.5 }]);
    await memindexInvoke(depsFor(index, tmp.dir, () => { called++; }), 'import', [payload, 'skip']);
    expect(called).toBe(1);
  });

  it('不是 JSON / 没有 memories 数组都明确报错', async () => {
    await expect(memindexInvoke(depsFor(index, tmp.dir), 'import', ['not json', 'skip'])).rejects.toThrow('JSON');
    await expect(memindexInvoke(depsFor(index, tmp.dir), 'import', ['{"items":[]}', 'skip'])).rejects.toThrow('memories');
  });
});

describe('知识图谱', () => {
  let index: MemoryIndex;
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    index = new MemoryIndex(':memory:');
    tmp = makeTmpDir();
    index.put({ text: '群主说他面试又失败了。', kind: 'episodic', importance: 0.7, people: ['3124076548'], topics: ['话太密'], source: 'note/cases/a.md' });
    index.put({ text: '群主调试不顺时叫我闭嘴。', kind: 'episodic', importance: 0.6, people: ['3124076548'], topics: ['话太密'], source: 'note/cases/a.md' });
    index.put({ text: '阿摆说我像在说风凉话。', kind: 'episodic', importance: 0.5, people: ['704372607'], topics: ['只有一次的主题'], source: 'note/library/b.md' });
  });

  afterEach(() => {
    index.close();
    tmp.cleanup();
  });

  it('人物与来源成节点，同一条记忆内的共现成边', async () => {
    const graph = await memindexInvoke(depsFor(index, tmp.dir), 'graph', []) as {
      nodes: Array<{ id: string; count: number }>;
      edges: Array<{ a: string; b: string; weight: number }>;
      stats: { persons: number; topics: number; sources: number; edges: number };
    };
    const owner = graph.nodes.find((n) => n.id === 'p:3124076548');
    expect(owner?.count).toBe(2);
    expect(graph.stats.persons).toBe(2);
    // 只出现一次的主题被过滤掉，只有重复出现的留下。
    expect(graph.nodes.some((n) => n.id === 't:只有一次的主题')).toBe(false);
    const edge = graph.edges.find((e) =>
      (e.a === 'p:3124076548' && e.b === 's:note/cases/a.md') || (e.b === 'p:3124076548' && e.a === 's:note/cases/a.md'));
    expect(edge?.weight).toBe(2);
  });

  it('点节点能看到相邻实体和关联记忆', async () => {
    const out = await memindexInvoke(depsFor(index, tmp.dir), 'neighbors', ['p:3124076548']) as {
      node: { label: string };
      neighbors: Array<{ node: { id: string }; weight: number }>;
      memories: Array<{ text: string }>;
    };
    expect(out.memories.length).toBe(2);
    expect(out.neighbors.some((n) => n.node.id === 's:note/cases/a.md')).toBe(true);
    // 没有档案时人物显示 QQ 号，不编名字。
    expect(out.node.label).toBe('3124076548');
  });

  it('人物名从 people/qq-<号>.md 首行解析', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(tmp.dir, 'people'), { recursive: true });
    writeFileSync(join(tmp.dir, 'people', 'qq-3124076548.md'), '疯狂性寝祀(3124076548) — 群主。\n', 'utf8');
    const out = await memindexInvoke(depsFor(index, tmp.dir), 'neighbors', ['p:3124076548']) as { node: { label: string } };
    expect(out.node.label).toBe('疯狂性寝祀');
  });
});
