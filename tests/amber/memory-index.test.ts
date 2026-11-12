/** 记忆索引：中文可检索、重复不膨胀、召回格式带免疫声明。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryIndex, memorySourceRevision, memoryId, tokenize, logRecall, effectiveImportance } from '../../bots/amber/persona/memoryIndex.ts';
import { rememberTool, recallTool, RECALL_DECL, REMEMBER_DECL } from '../../bots/amber/persona/memoryTools.ts';
import { makeTmpDir } from '../core/helpers.ts';

describe('记忆索引', () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex(':memory:');
  });

  afterEach(() => index.close());

  it('按 ID 纠正事实：身份不变，旧文留在修订历史且不再召回', () => {
    const entry = { text: '她明天要做的是红豆饭。', kind: 'factual' as const, people: ['11111'], importance: 0.8 };
    const id = index.put(entry);
    const row = index.revise(id, { text: '她明天要做的是南瓜汤。', reason: '本人明确更正菜名' });
    expect(row.id).toBe(id);
    expect(row.people).toEqual(['11111']);
    expect(index.recall('红豆饭').some((hit) => hit.text.includes('红豆饭'))).toBe(false);
    expect(index.recall('南瓜汤').map((hit) => hit.id)).toContain(id);
    expect(index.revisionHistory(id)[0].previous.text).toBe(entry.text);
    expect(() => index.put(entry)).toThrow('不能重新写入旧事实');
  });

  it('撤回后词法、人物、自动注入、向量召回都不返回，回填不能复活', () => {
    const entry = { text: '她计划去海边搭一间木屋。', kind: 'plan' as const, people: ['11111'], importance: 0.8, source: 'note/test.md' };
    const id = index.put(entry);
    index.storeVector(id, new Float32Array([1, 0]), 'fixture');
    index.revise(id, { reason: '本人撤回计划' });
    expect(index.get(id)?.status).toBe('withdrawn');
    expect(index.recall('木屋', { queryVector: new Float32Array([1, 0]) })).toEqual([]);
    expect(index.recallForPeople(['11111'], { includeDormant: true })).toEqual([]);
    expect(index.recallBlock('木屋', 5).ids).toEqual([]);
    expect(index.replaceSource('note/test.md', [entry])).toBe(0);
    expect(() => index.update(id, { status: 'active' })).toThrow('不能');
    expect(index.recall('木屋')).toEqual([]);
  });

  it('纠正与撤回不会影响同文的另一个人', () => {
    const entry = { text: '明天要做的是红豆饭。', kind: 'factual' as const, importance: 0.8 };
    const first = index.put({ ...entry, people: ['11111'] });
    const second = index.put({ ...entry, people: ['22222'] });
    index.revise(first, { reason: '甲撤回' });
    expect(index.get(second)?.status).toBe('active');
    expect(index.recall('红豆饭').map((hit) => hit.id)).toEqual([second]);
  });

  it('文件改写、移动和删除使派生事实失效，回填当前来源不复活旧来源', () => {
    const tmp = makeTmpDir();
    const file = join(tmp.dir, 'source.md');
    const sourceIndex = new MemoryIndex(':memory:', undefined, {
      sourceRevision: (source) => memorySourceRevision(tmp.dir, source),
    });
    try {
      const old = { text: '她的午餐是红豆饭。', kind: 'factual' as const, importance: 0.8, source: 'source.md' };
      writeFileSync(file, old.text);
      const id = sourceIndex.put(old);
      expect(sourceIndex.recall('红豆饭').map((hit) => hit.id)).toContain(id);
      writeFileSync(file, '她的午餐是南瓜汤。');
      expect(sourceIndex.recall('红豆饭')).toEqual([]);
      expect(sourceIndex.get(id)?.status).toBe('stale');
      sourceIndex.replaceSource('source.md', [{ ...old, text: '她的午餐是南瓜汤。' }]);
      expect(sourceIndex.recall('南瓜汤')).toHaveLength(1);
      renameSync(file, join(tmp.dir, 'renamed.md'));
      expect(sourceIndex.recall('南瓜汤')).toEqual([]);
      sourceIndex.replaceSource('renamed.md', [{ ...old, text: '她的午餐是南瓜汤。', source: 'renamed.md' }]);
      expect(sourceIndex.recall('南瓜汤')).toHaveLength(1);
      unlinkSync(join(tmp.dir, 'renamed.md'));
      expect(sourceIndex.recall('南瓜汤')).toEqual([]);
    } finally {
      sourceIndex.close();
      tmp.cleanup();
    }
  });

  it('remember 可纠正与撤回，recall 提供稳定 ID', async () => {
    const deps = { index };
    const write = rememberTool(deps);
    const recall = recallTool(deps);
    const id = index.put({ text: '明天她会带来红豆饭。', kind: 'factual', importance: 0.8 });
    const result = await recall.handler({ query: '红豆饭' }, {} as never);
    expect(String(result)).toContain(`[id:${id}]`);
    expect(String(await write.handler({ entries: [{ action: 'correct', id, text: '明天她会带来南瓜汤。', reason: '本人纠正' }] }, {} as never)))
      .toContain('[remembered]');
    expect(index.get(id)?.text).toContain('南瓜汤');
    await write.handler({ entries: [{ action: 'withdraw', id, reason: '不再带午饭' }] }, {} as never);
    expect(index.get(id)?.status).toBe('withdrawn');
    expect(index.revisionHistory(id)).toHaveLength(2);
  });

  it('重启和文件回填保留撤回标记及修订历史', () => {
    const tmp = makeTmpDir();
    const file = join(tmp.dir, 'index.db');
    const entry = { text: '她的午餐约定是红豆饭。', kind: 'factual' as const, importance: 0.8, source: 'note/lunch.md' };
    let persisted = new MemoryIndex(file);
    try {
      const id = persisted.put(entry);
      persisted.revise(id, { reason: '本人取消约定' });
      persisted.close();
      persisted = new MemoryIndex(file);
      expect(persisted.replaceSource(entry.source, [entry])).toBe(0);
      expect(persisted.get(id)?.status).toBe('withdrawn');
      expect(persisted.revisionHistory(id)[0].reason).toBe('本人取消约定');
      expect(persisted.recall('红豆饭')).toEqual([]);
    } finally {
      persisted.close();
      tmp.cleanup();
    }
  });

  it('旧文件来源没有版本时不冒充当前事实；显式回填后才能重新召回', () => {
    const tmp = makeTmpDir();
    const file = join(tmp.dir, 'index.db');
    const entry = { text: '她的午餐约定是红豆饭。', kind: 'factual' as const, importance: 0.8, source: 'lunch.md' };
    writeFileSync(join(tmp.dir, entry.source), entry.text);
    const legacy = new MemoryIndex(file);
    const id = legacy.put(entry);
    legacy.close();
    const upgraded = new MemoryIndex(file, undefined, { sourceRevision: (source) => memorySourceRevision(tmp.dir, source) });
    try {
      expect(upgraded.recall('红豆饭')).toEqual([]);
      expect(upgraded.get(id)?.status).toBe('stale');
      expect(upgraded.replaceSource(entry.source, [entry])).toBe(1);
      expect(upgraded.recall('红豆饭').map((hit) => hit.id)).toContain(id);
    } finally {
      upgraded.close();
      tmp.cleanup();
    }
  });

  it('中文按 bigram 切词，能被关键词命中', () => {
    index.put({ text: '群主说他 2026-10-23 面试又失败了，后来没再提。', kind: 'episodic', importance: 0.6, eventTime: '2026-10-23' });
    index.put({ text: '今天群里在聊新出的显卡。', kind: 'episodic', importance: 0.2 });
    const hits = index.recall('面试', { k: 3 });
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain('面试');
    expect(hits[0].breakdown.bm25).toBe(1);
  });

  it('不同人或相反事实的相似记忆不会自动合并', () => {
    const entries = [
      { text: '甲说他昨天面试失败了，后来回家休息。', people: ['11111'] },
      { text: '乙说他昨天面试失败了，后来回家休息。', people: ['22222'] },
      { text: '甲明确答应明天会把面试资料发过来。', people: ['11111'] },
      { text: '甲并没有明确答应明天会把面试资料发过来。', people: ['11111'] },
    ];
    const ids = entries.map((entry) => index.put({ ...entry, kind: 'episodic', importance: 0.5, eventTime: '2026-10-24' }));
    index.dedupe();
    for (const id of ids) expect(index.get(id)?.status).toBe('active');
  });

  it('自动注入不丢弃不同人相似的事实', () => {
    const first = index.put({ text: '甲昨天面试失败之后回家休息。', people: ['11111'], kind: 'episodic', importance: 0.5, eventTime: '2026-10-24' });
    const second = index.put({ text: '乙昨天面试失败之后回家休息。', people: ['22222'], kind: 'episodic', importance: 0.5, eventTime: '2026-10-24' });
    const block = index.recallBlock('面试失败之后回家休息', 5, 700);
    expect(block.ids).toContain(first);
    expect(block.ids).toContain(second);
  });

  it('相同正文属于不同人时分别保存', () => {
    const text = '昨天面试失败后回家休息。';
    const first = index.put({ text, people: ['11111'], kind: 'episodic', importance: 0.5 });
    const second = index.put({ text, people: ['22222'], kind: 'episodic', importance: 0.5 });
    expect(first).not.toBe(second);
    expect(index.get(first)?.people).toEqual(['11111']);
    expect(index.get(second)?.people).toEqual(['22222']);
  });

  it('同一句话写两次只存一条', () => {
    const entry = { text: '阿摆会直接指出我说话的味道不对。', kind: 'relational' as const, importance: 0.7 };
    const a = index.put(entry);
    const b = index.put(entry);
    expect(a).toBe(b);
    expect(index.count()).toBe(1);
  });

  it('近重复的两条只占一个名额，后面的相关条能进来', () => {
    index.put({
      text: '群主把 people/ 里的档案截图发到群里，我先认了：那是我自己写的字，不算客气但都是实话。',
      kind: 'episodic', importance: 0.6, eventTime: '2026-10-24',
    });
    index.put({
      text: '群主把 people/ 里的档案截图发到群里，我认了那是我自己写的字，不算客气但都是实话。',
      kind: 'episodic', importance: 0.6, eventTime: '2026-10-24',
    });
    index.put({
      text: '档案贴到群里以后，我补了一句：怕什么，你翻的是我写的字，又不是我。',
      kind: 'episodic', importance: 0.4, eventTime: '2026-10-24',
    });
    const block = index.recallBlock('档案 截图 贴到群里 我写的字', 2, 700);
    const lines = (block.text ?? '').split('\n').filter((l) => l.startsWith('- '));
    expect(lines.length).toBe(2);
    // 前两条是同一件事的两种写法；去重后应当腾出位置给第三条。
    expect(block.text).toContain('怕什么，你翻的是我写的字');
    // 收尾要告诉她：这块是自动检索的结果，先用它，不够再查。
    expect(block.text).toContain('先用这一块');
  });

  it('同一事件同主体的完全相同记录可合并，其他事件不合并', () => {
    const shared = {
      text: '他递台阶说这不是你的错，我没有接受。', kind: 'episodic' as const,
      people: ['11111'], eventTime: '2026-10-24', scope: 'group:1',
    };
    const first = index.put({ ...shared, id: 'first', source: 'event:10-10', importance: 0.8 });
    const duplicate = index.put({ ...shared, id: 'duplicate', source: 'event:10-10', importance: 0.5 });
    const otherEvent = index.put({ ...shared, id: 'other', source: 'event:11-11', importance: 0.5 });
    const result = index.dedupe();
    expect(result.merged).toBe(1);
    expect(result.pairs[0].keep).toBe(first);
    expect(result.pairs[0].drop).toBe(duplicate);
    expect(index.get(duplicate)?.status).toBe('merged');
    expect(index.get(otherEvent)?.status).toBe('active');
  });

  it('重要性与新鲜度参与排序', () => {
    index.put({ text: '随便一句关于猫的话。', kind: 'episodic', importance: 0.1, eventTime: '2020-01-01' });
    index.put({ text: '猫今天又打翻了杯子。', kind: 'episodic', importance: 0.9, eventTime: '2026-10-24' });
    const hits = index.recall('猫', { k: 2 });
    expect(hits[0].importance).toBeGreaterThan(hits[1].importance);
    expect(hits[0].breakdown.recency).toBeGreaterThan(hits[1].breakdown.recency);
  });

  it('没有命中时退化成最近的条目，而不是报错或空手而归', () => {
    index.put({ text: '一句与查询完全无关的话。', kind: 'factual', importance: 0.5 });
    const hits = index.recall('量子力学', { k: 3 });
    expect(hits.length).toBe(1);
    expect(hits[0].breakdown.bm25).toBe(0);
  });

  it('访问会累加，供衰减使用', () => {
    const id = index.put({ text: '他答应下周把截图发我。', kind: 'plan', importance: 0.6 });
    index.touch([id]);
    index.touch([id]);
    expect(index.list()[0].accessCount).toBe(2);
  });

  it('按来源重建：清掉旧条目不留残影', () => {
    index.put({ text: '甲文件里的第一条观察。', kind: 'episodic', importance: 0.4, source: 'note/a.md' });
    index.put({ text: '乙文件里的观察。', kind: 'episodic', importance: 0.4, source: 'note/b.md' });
    expect(index.dropBySource('note/a.md')).toBe(1);
    expect(index.count()).toBe(1);
    const hits = index.recall('甲文件');
    expect(hits.every((h) => h.source !== 'note/a.md')).toBe(true);
  });
});

describe('记忆衰减与休眠', () => {
  let index: MemoryIndex;
  const day = 86_400_000;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day);

  beforeEach(() => {
    index = new MemoryIndex(':memory:');
  });

  afterEach(() => index.close());

  it('没被想起的记忆随时间变淡，并且不会归零', () => {
    const id = index.put({ text: '很久以前的一句闲聊。', kind: 'episodic', importance: 0.8 }, at(120));
    const row = index.list()[0];
    const fresh = effectiveImportance({ ...row, lastAccessAt: null }, at(0));
    expect(fresh).toBeLessThan(0.8);
    expect(fresh).toBeGreaterThan(0.05);
    const ancient = effectiveImportance({ ...row, createdAt: at(3000).toISOString(), lastAccessAt: null }, new Date());
    expect(ancient).toBe(0.05);
    expect(id).toBeTruthy();
  });

  it('访问会放慢衰减，但没有永久免疫', () => {
    const base = { importance: 0.8, createdAt: at(120).toISOString(), accessCount: 10 };
    const recent = effectiveImportance({ ...base, lastAccessAt: at(1).toISOString() }, at(0));
    const stale = effectiveImportance({ ...base, lastAccessAt: at(60).toISOString() }, at(0));
    expect(recent).toBeGreaterThan(stale);
    // 访问窗口外的强化失效：仍然按基础速率衰减。
    const never = effectiveImportance({ ...base, accessCount: 0, lastAccessAt: null }, at(0));
    expect(Math.abs(stale - never)).toBeLessThan(0.25);
  });

  it('久未想起转入休眠，被召回后复活', () => {
    const id = index.put({ text: '两百天前有人提过的一句旧事。', kind: 'episodic', importance: 0.5 }, at(200));
    expect(index.sweep({}, at(0))).toEqual({ dormantized: 1, revived: 0 });
    expect(index.list()[0].status).toBe('dormant');

    index.touch([id], at(0));
    expect(index.sweep({}, at(0))).toEqual({ dormantized: 0, revived: 1 });
    expect(index.list()[0].status).toBe('active');
  });

  it('休眠条目仍可主动召回，但不会进入自动注入', () => {
    index.put({ text: '关于面试失败那天的记录。', kind: 'episodic', importance: 0.5 }, at(200));
    index.sweep({}, at(0));
    expect(index.recall('面试').length).toBe(1);
    expect(index.recall('面试', { activeOnly: true }).length).toBe(0);
    expect(index.injectBlock('面试', 3)).toBeNull();
  });

  it('自动注入只给关键词命中的条目，并带免疫声明', () => {
    index.put({ text: '他 2026-10-24 问过我是不是机器人，我直说是。', kind: 'episodic', importance: 0.5 });
    const block = index.injectBlock('你还记得机器人那事吗', 3);
    expect(block).toContain('过去的记录');
    expect(block).toContain('机器人');
    // 完全无关的查询不注入。
    expect(index.injectBlock('量子色动力学', 3)).toBeNull();
  });
});

describe('面板接口', () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex(':memory:');
    index.put({ text: '群主说他面试又失败了，后来没再提。', kind: 'episodic', importance: 0.6, eventTime: '2026-10-23', source: 'people/a.md' });
    index.put({ text: '阿摆会直接指出我说话的味道不对。', kind: 'relational', importance: 0.8, source: 'people/b.md' });
    index.put({ text: '他答应下周把截图发我。', kind: 'plan', importance: 0.4 });
  });

  afterEach(() => index.close());

  it('按类型 / 状态 / 关键词筛选', () => {
    expect(index.list({ kind: 'relational' }).length).toBe(1);
    expect(index.list({ status: 'dormant' }).length).toBe(0);
    expect(index.list({ query: '面试' }).map((r) => r.kind)).toEqual(['episodic']);
    expect(index.list({ query: 'zzzz' }).length).toBe(0);
    expect(index.list({ limit: 2 }).length).toBe(2);
    expect(index.list({ limit: 2, offset: 2 }).length).toBe(1);
  });

  it('改重要性、切状态，都能读回', () => {
    const id = index.list({ kind: 'plan' })[0].id;
    expect(index.update(id, { importance: 0.9 })?.importance).toBeCloseTo(0.9, 5);
    expect(index.update(id, { status: 'dormant' })?.status).toBe('dormant');
    expect(index.update('不存在', { importance: 0.1 })).toBeNull();
  });

  it('删除会连同检索行一起清掉', () => {
    const id = index.list({ kind: 'episodic' })[0].id;
    expect(index.remove(id)).toBe(true);
    expect(index.remove(id)).toBe(false);
    expect(index.list({ query: '面试' }).length).toBe(0);
    expect(index.count()).toBe(2);
  });

  it('统计给出类型、状态、来源与向量数', () => {
    const stats = index.stats();
    expect(stats.total).toBe(3);
    expect(stats.byKind.episodic).toBe(1);
    expect(stats.byStatus.active).toBe(3);
    expect(stats.sources).toBe(2);
    expect(stats.vectorized).toBeNull();
  });
});

describe('记忆工具', () => {
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

  it('remember 拒收空正文与超长条目，并回执写了几条', async () => {
    const tool = rememberTool({ index, dataDir: tmp.dir });
    const out = await tool.handler({ entries: [
      { text: '', kind: 'factual', importance: 0.5 },
      { text: '我', kind: 'factual', importance: 0.5 },
      { text: '小克这个称呼是群主专用的，2026-10-23 起。', kind: 'relational', importance: 0.7, topics: ['称呼'] },
    ] }, { role: 'dream' } as never) as string;
    expect(out).toContain('[remembered] 1 条');
    expect(out).toContain('[skipped]');
    expect(index.count()).toBe(1);
  });

  it('recall 输出带"过去的记录"声明，并写召回日志', async () => {
    index.put({ text: '他 2026-10-24 问过我是不是机器人，我直说是。', kind: 'episodic', importance: 0.5, eventTime: '2026-10-24' });
    const tool = recallTool({ index, dataDir: tmp.dir });
    const out = await tool.handler({ query: '机器人' }, { role: 'main' } as never) as string;
    expect(out).toContain('过去的记录');
    expect(out).toContain('机器人');
    const log = readFileSync(join(tmp.dir, 'recalls.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(log[0]).query).toBe('机器人');
  });

  it('工具声明的标签分别是读与写', () => {
    expect(RECALL_DECL.tags).toEqual(['read']);
    expect(REMEMBER_DECL.tags).toEqual(['write']);
  });

  it('召回日志写不进去时不影响召回', () => {
    expect(() => logRecall('Z:/不存在的盘/x', { ts: '', query: 'q', k: 1, hits: [], caller: 'main' })).not.toThrow();
  });

  it('id 按正文去空白后稳定', () => {
    expect(memoryId(' 你好  世界 ')).toBe(memoryId('你好 世界'));
    expect(tokenize('面试 failure')).toContain('面试');
    expect(tokenize('面试 failure')).toContain('failure');
  });
});
