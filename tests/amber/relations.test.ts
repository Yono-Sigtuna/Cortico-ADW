/** 关系约束：信任、熟悉度、边界、欠着的话——事件更新、衰减、注入行与主动门。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AFFINITY_CAP, AFFINITY_GAIN_ENGAGED, RelationStore, affinityMass, decayRelation, humanGap,
  observeRelation, relationBlock, relationLines, type Relation,
} from '../../bots/amber/persona/relations.ts';
import { maintainRelationTool } from '../../bots/amber/persona/relationTool.ts';
import { makeTmpDir } from '../core/helpers.ts';

const T = Date.parse('2026-10-26T06:00:00Z');
const MIN = 60_000;
const QQ = '3124076548';

const fresh = (patch: Partial<Relation> = {}): Relation => ({
  trust: 0.5,
  familiarity: 0.05,
  affinity: 0,
  boundary: 0,
  updatedAt: T,
  basis: '',
  ...patch,
});

describe('关系 · 事件与衰减', () => {
  it('普通消息只涨一点熟悉度，而且是逼近不是撞顶', () => {
    const { relation } = observeRelation(fresh(), '今天也在改代码', T);
    // 0.05 + 0.01×(1−0.05)：越熟涨得越慢，不会在九十几句话里撞到 1。
    expect(relation.familiarity).toBeCloseTo(0.0595, 6);
    expect(relation.affinity).toBe(0);
    expect(relation.trust).toBe(0.5);
    expect(relation.boundary).toBe(0);
  });

  it('被人接住才动好感度：没接住的消息不涨', () => {
    const idle = observeRelation(fresh({ affinity: 0.3 }), '在吗', T);
    expect(idle.relation.affinity).toBeCloseTo(0.3, 6);
    const held = observeRelation(fresh({ affinity: 0.3 }), '刚那句我接住了', T, { engaged: true, mass: 0 });
    expect(held.relation.affinity).toBeGreaterThan(0.3);
  });

  it('好感度总量有限：份额满了以后谁也不涨', () => {
    // 总量已经顶到上限，这时候再来一件好事也只涨 0。
    const full = observeRelation(fresh({ affinity: 0.5 }), '接住了', T, { engaged: true, mass: AFFINITY_CAP });
    expect(full.relation.affinity).toBeCloseTo(0.5, 6);
    // 份额空着才涨得动。
    const roomy = observeRelation(fresh({ affinity: 0.5 }), '接住了', T, { engaged: true, mass: 0 });
    expect(roomy.relation.affinity).toBeCloseTo(0.5 + AFFINITY_GAIN_ENGAGED, 6);
  });

  it('好感度按 150 天散掉：三个月才淡一半', () => {
    const rel = decayRelation(fresh({ affinity: 0.8 }), T + 150 * 24 * 60 * MIN);
    expect(rel.affinity).toBeCloseTo(0.4, 3);
  });

  it('总量就是所有人的好感度之和', () => {
    expect(affinityMass([fresh({ affinity: 0.4 }), fresh({ affinity: 0.6 })])).toBeCloseTo(1, 6);
    expect(AFFINITY_CAP).toBeGreaterThan(1);
  });

  it('越界言论：信任下降、边界抬升，并留下依据', () => {
    const { relation } = observeRelation(fresh(), '闭嘴，你个废物', T);
    expect(relation.trust).toBeCloseTo(0.44, 5);
    expect(relation.boundary).toBeCloseTo(0.4, 5);
    expect(relation.basis).toContain('越界言论');
  });

  it('边界按一天半衰，信任慢慢回中，熟悉度回落很慢', () => {
    const angry = fresh({ boundary: 0.8, trust: 0.2, familiarity: 0.9 });
    const after = decayRelation(angry, T + 24 * 60 * MIN);
    expect(after.boundary).toBeCloseTo(0.4, 2);
    expect(after.trust).toBeGreaterThan(0.2);
    expect(after.trust).toBeLessThan(0.5);
    expect(after.familiarity).toBeLessThan(0.9);
    expect(after.familiarity).toBeGreaterThan(0.5);
  });
});

describe('关系 · 注入行与主动门', () => {
  it('边界高与信任低各给一条约束', () => {
    const lines = relationLines(fresh({ boundary: 0.5, trust: 0.2 }), T + MIN);
    expect(lines.join('')).toContain('刚越过界');
    expect(lines.join('')).toContain('谈不上信任');
  });

  it('亲疏只看好感度：聊得再勤、没有好感，也不带来放宽', () => {
    // 熟悉度顶满、信任也高，但好感度为零——这就是"熟归熟，不亲"。
    expect(relationLines(fresh({ trust: 0.8, familiarity: 0.95 }))).toEqual([]);
    expect(relationLines(fresh({ affinity: 0.5 })).join('')).toContain('更有耐心');
    expect(relationLines(fresh({ affinity: 0.8 })).join('')).toContain('有分量');
  });

  it('正常关系没有约束行', () => {
    expect(relationLines(fresh())).toEqual([]);
  });

  it('刚越界或几乎不信任的人，不先主动找他', () => {
    expect(relationBlock(fresh({ boundary: 0.7 }))).toContain('刚越过界');
    expect(relationBlock(fresh({ trust: 0.1 }))).toContain('信得过');
    expect(relationBlock(fresh())).toBeNull();
  });
});

describe('关系 · 存储', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let now = T;
  let store: RelationStore;

  beforeEach(() => {
    tmp = makeTmpDir();
    now = T;
    store = new RelationStore(tmp.dir, () => now);
  });
  afterEach(() => tmp.cleanup());

  it('没有记录时给默认值，观察后落盘', () => {
    expect(store.get(QQ)).toMatchObject({ trust: 0.5, familiarity: 0.05, boundary: 0 });
    store.observe(QQ, '闭嘴');
    const file = join(tmp.dir, 'relations.json');
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.people[QQ].boundary).toBeCloseTo(0.4, 5);
  });

  it('非 QQ 号的消息不建档案', () => {
    expect(store.observe('甲', '你好')).toBeNull();
    expect(store.all()).toEqual([]);
  });

  it('梦写的补丁：信任、熟悉、边界', () => {
    const a = store.patch(QQ, { trust: 0.7, familiarity: 0.4, basis: '他说了谢谢' });
    expect(a.ok).toBe(true);
    expect(a.applied).toEqual(['trust', 'familiarity', 'basis']);

    const bad = store.patch(QQ, { trust: Number.NaN, boundary: Number.NaN });
    expect(bad.ok).toBe(false);
    expect(bad.rejected).toEqual(['trust', 'boundary']);
  });

  it('他等的事兑现了会涨好感度，同一事件只涨一次', () => {
    const before = store.get(QQ).affinity;
    expect(store.rewardFulfilled(QQ, 'ev-1')).toBe(true);
    const after = store.get(QQ).affinity;
    expect(after).toBeGreaterThan(before);
    expect(store.rewardFulfilled(QQ, 'ev-1')).toBe(false);
    expect(store.get(QQ).affinity).toBe(after);
  });

  it('旧文件没有好感度：按「认识程度 × 信任」折算一小段接过来，不让群主变陌生人', () => {
    writeFileSync(join(tmp.dir, 'relations.json'), JSON.stringify({
      version: 1,
      people: { [QQ]: { trust: 0.878, familiarity: 0.979, boundary: 0, debts: [], updatedAt: T, basis: '' } },
    }), 'utf8');
    const again = new RelationStore(tmp.dir, () => now);
    // 八天在"三个月才到最喜欢"的尺子上只走一小段：0.878 × 0.979 × 0.15 ≈ 0.129。
    expect(again.get(QQ).affinity).toBeCloseTo(0.878 * 0.979 * 0.15, 4);
    expect(again.get(QQ).affinity).toBeLessThan(0.2);
  });

  it('v1 已经按老公式播过种的：按同一比例缩回去，不重播', () => {
    writeFileSync(join(tmp.dir, 'relations.json'), JSON.stringify({
      version: 1,
      people: { [QQ]: { trust: 0.878, familiarity: 0.979, affinity: 0.878, boundary: 0, debts: [], updatedAt: T, basis: '' } },
    }), 'utf8');
    const again = new RelationStore(tmp.dir, () => now);
    expect(again.get(QQ).affinity).toBeCloseTo(0.878 * 0.15, 4);
  });

  it('v2 读回来不再缩', () => {
    writeFileSync(join(tmp.dir, 'relations.json'), JSON.stringify({
      version: 2,
      people: { [QQ]: { trust: 0.878, familiarity: 0.979, affinity: 0.13, boundary: 0, debts: [], updatedAt: T, basis: '' } },
    }), 'utf8');
    const again = new RelationStore(tmp.dir, () => now);
    expect(again.get(QQ).affinity).toBeCloseTo(0.13, 4);
  });

  it('重开能读到，坏文件回默认', () => {
    store.patch(QQ, { familiarity: 0.4 });
    const again = new RelationStore(tmp.dir, () => now);
    expect(again.get(QQ).familiarity).toBeCloseTo(0.4, 5);

    writeFileSync(join(tmp.dir, 'relations.json'), '{bad', 'utf8');
    const broken = new RelationStore(tmp.dir, () => now);
    expect(broken.get(QQ).trust).toBe(0.5);
  });

  it('距上次说话：没记录是 null，说过话之后按分钟算', () => {
    expect(store.gapMinutes(QQ)).toBeNull();
    store.observe(QQ, '在吗');
    now += 6 * 60 * MIN;
    expect(store.gapMinutes(QQ)).toBeCloseTo(360, 0);
  });
});

describe('时间感 · 人话', () => {
  it('分钟、小时、天', () => {
    expect(humanGap(12)).toBe('12 分钟前');
    expect(humanGap(59.4)).toBe('59 分钟前');
    expect(humanGap(60)).toBe('1 小时前');
    expect(humanGap(360)).toBe('6 小时前');
    expect(humanGap(60 * 30)).toBe('1 天前');
    expect(humanGap(60 * 24 * 4)).toBe('4 天前');
  });
});


describe('梦的手 · 待兑现走会话，不走档案', () => {
  const run = async (tool: ReturnType<typeof maintainRelationTool>, args: Record<string, unknown>): Promise<string> => {
    const out = await tool.handler(args, {} as never);
    return typeof out === 'string' ? out : String((out as { text?: unknown }).text ?? '');
  };

  it('pending 写进会话状态，关系档案里一个字都不留', async () => {
    const tmp = makeTmpDir();
    try {
      const store = new RelationStore(tmp.dir, () => T);
      const noted: string[] = [];
      const tool = maintainRelationTool({
        store,
        pending: { note: (_qq, text) => { noted.push(text); return true; }, close: () => true },
      });
      const out = await run(tool, { qq: QQ, pending: '答应明天给他检查结果' });
      expect(out).toContain('pending');
      expect(noted).toEqual(['答应明天给他检查结果']);
      expect(JSON.stringify(store.get(QQ))).not.toContain('检查结果');
    } finally {
      tmp.cleanup();
    }
  });

  it('兑现了只销账：没有可核对的原话，不加好感', async () => {
    const tmp = makeTmpDir();
    try {
      const store = new RelationStore(tmp.dir, () => T);
      let closed = '';
      const tool = maintainRelationTool({
        store,
        pending: {
          note: () => true,
          close: () => true,
          closeDetail: (_qq, fragment) => { closed = fragment; return { closed: true, conv: 'group:1', at: T }; },
        },
      });
      const out = await run(tool, { qq: QQ, resolved: '检查结果' });
      expect(out).toContain('resolved');
      expect(out).toContain('不加好感');
      expect(closed).toBe('检查结果');
      expect(store.get(QQ).affinity).toBe(0);
    } finally {
      tmp.cleanup();
    }
  });

  it('有本人之后发来的原话才加好感，同一事件只加一次', async () => {
    const tmp = makeTmpDir();
    try {
      const store = new RelationStore(tmp.dir, () => T);
      const tool = maintainRelationTool({
        store,
        pending: {
          note: () => true,
          close: () => true,
          closeDetail: () => ({ closed: true, conv: 'group:1', at: T }),
        },
        evidence: (qq, conv, after, fragment) => (
          qq === QQ && conv === 'group:1' && after === T && fragment === '收到了' ? 'ev-1' : null
        ),
      });
      const out = await run(tool, { qq: QQ, resolved: '检查结果', resolved_event: '收到了' });
      expect(out).not.toContain('只销账');
      const first = store.get(QQ).affinity;
      expect(first).toBeGreaterThan(0);
      // 另一条账引用同一条真实消息，也不能再发一次奖励。
      expect(store.rewardFulfilled(QQ, 'ev-1')).toBe(false);
      expect(store.get(QQ).affinity).toBe(first);
    } finally {
      tmp.cleanup();
    }
  });

  it('证据对不上时不加好感', async () => {
    const tmp = makeTmpDir();
    try {
      const store = new RelationStore(tmp.dir, () => T);
      const tool = maintainRelationTool({
        store,
        pending: {
          note: () => true,
          close: () => true,
          closeDetail: () => ({ closed: true, conv: 'group:1', at: T }),
        },
        evidence: () => null,
      });
      const out = await run(tool, { qq: QQ, resolved: '检查结果', resolved_event: '没这回事' });
      expect(out).toContain('不加好感');
      expect(store.get(QQ).affinity).toBe(0);
    } finally {
      tmp.cleanup();
    }
  });
});
