/** 她自己的状态：存得住、会回落、只影响语气。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoleStateStore, defaultState } from '../../bots/amber/persona/companion/roleState.ts';
import { maintainStateTool } from '../../bots/amber/persona/companion/tool.ts';
import { makeTmpDir } from '../core/helpers.ts';

const T = Date.parse('2026-10-25T06:00:00Z');
const MIN = 60_000;

describe('角色状态', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let now: number;

  beforeEach(() => {
    tmp = makeTmpDir();
    now = T;
  });
  afterEach(() => tmp.cleanup());

  const store = () => new RoleStateStore(tmp.dir, () => now);

  it('默认是一个普通下午：有精力、心情平稳', () => {
    const s = store();
    expect(s.current.energy).toBe(62);
    expect(s.current.mood.baseline).toBe(5);
    expect(s.block()).toContain('精力 62/100');
    expect(s.block()).toContain('只影响语气和浓度');
  });

  it('梦写入状态：数字越界被夹住，写错的字段被忽略而不是整次失败', () => {
    const s = store();
    const r = s.patch({ energy: 140, mood: { joy: 9, anger: '烦' }, busy: '在读一本讲地形的书', basis: '下午断续聊了两小时' });
    expect(r.ok).toBe(true);
    expect(s.current.energy).toBe(100);
    expect(s.current.mood.joy).toBe(9);
    expect(r.rejected).toContain('mood.anger');
    expect(s.current.busy).toContain('地形');
  });

  it('心情会向基线回落：一次夸奖不该让她整天亢奋', () => {
    const s = store();
    s.patch({ mood: { joy: 10, baseline: 5 } });
    now = T + 180 * MIN; // 一个半衰期
    s.drift(() => false);
    expect(s.current.mood.joy).toBeLessThan(9);
    expect(s.current.mood.joy).toBeGreaterThan(6);
  });

  it('精力按昼夜增减：醒着掉、睡着回', () => {
    const s = store();
    s.patch({ energy: 50 });
    now = T + 6 * 60 * MIN;
    s.drift(() => false);
    expect(s.current.energy).toBeLessThan(50);

    const t2 = new RoleStateStore(null, () => now);
    t2.patch({ energy: 20 });
    now += 6 * 60 * MIN;
    t2.drift(() => true);
    expect(t2.current.energy).toBeGreaterThan(20);
  });

  it('状态块优先用她自己的心境描述，不用干瘪标签', () => {
    const s = store();
    s.patch({ mood: { joy: 8, description: '心里踏实，有点挂念' }, presence: '阅读中', onlineMode: 'away' });
    const block = s.block();
    expect(block).toContain('心里踏实，有点挂念');
    expect(block).toContain('公开状态：阅读中');
    expect(block).toContain('在线态：away');
  });

  it('「你在干嘛」有得可答：有手头事就说，没有就如实说没在做什么', () => {
    const s = store();
    expect(s.block()).toContain('此刻没在做什么具体的事');
    s.patch({ busy: '在读一本讲地形的书' });
    expect(s.block()).toContain('手头：在读一本讲地形的书');
  });

  it('有日程时，「手头」以日程当前段为准，梦写的旧 busy 让位', () => {
    const s = store();
    s.patch({ busy: '整理昨晚的记录' });
    const block = s.block(undefined, { busy: '按日程：群里的时间' });
    expect(block).toContain('手头：按日程：群里的时间');
    expect(block).not.toContain('整理昨晚的记录');
  });

  it('有日程时，公开状态也跟着当前段走', () => {
    const s = store();
    s.patch({ presence: '收拾记录' });
    const block = s.block(undefined, { busy: '按日程：群里的时间', presence: '群里的时间' });
    expect(block).toContain('公开状态：群里的时间');
    expect(block).not.toContain('收拾记录');
  });

  it('过期的临时状况不进状态块', () => {
    const s = store();
    s.patch({
      conditions: [
        { kind: 'sleep', text: '刚被叫醒，还在缓', expiresAt: new Date(T + 30 * MIN).toISOString() },
        { kind: 'health', text: '嗓子有点干', expiresAt: null },
      ],
    });
    expect(s.block()).toContain('刚被叫醒');
    now = T + 60 * MIN;
    const later = store();
    expect(later.block()).not.toContain('刚被叫醒');
    expect(later.block()).toContain('嗓子有点干');
  });

  it('隔夜的睡意不再出现：昨晚写的「灯已调暗」不能撑到第二天上午', () => {
    const s = store();
    s.patch({ conditions: [{ kind: 'sleep', text: '眼睛发涩，灯已经调暗', expiresAt: null }] });
    expect(s.block()).toContain('灯已经调暗');
    now = T + 9 * 60 * MIN;
    expect(store().block()).not.toContain('灯已经调暗');
  });

  it('同一类状况只留最新一条：同一个事实不该在一轮里说三遍', () => {
    const s = store();
    now = T + 10 * MIN;
    s.patch({ conditions: [{ kind: 'sleep', text: '眼睛微涩，灯已调暗', expiresAt: null }] });
    now = T + 20 * MIN;
    s.patch({ conditions: [{ kind: 'sleep', text: '眼睛发涩，灯已经调暗', expiresAt: null }] });
    const block = s.block();
    expect(block).toContain('眼睛发涩');
    expect(block).not.toContain('眼睛微涩');
  });

  it('旧文件里没有写入时刻的状况读进来就丢掉，不留成永久', () => {
    writeFileSync(join(tmp.dir, 'role-state.json'), JSON.stringify({
      version: 1,
      updatedAt: T,
      energy: 86,
      conditions: [{ kind: 'sleep', text: '眼睛发涩，灯已经调暗', expiresAt: null }],
    }), 'utf8');
    const s = store();
    expect(s.current.conditions).toHaveLength(0);
    expect(s.block()).not.toContain('灯已经调暗');
  });

  it('落盘后另一份实例读得到', () => {    store().patch({ energy: 33, mood: { sorrow: 7 }, presence: '休息中' });
    const again = store();
    expect(again.current.energy).toBe(33);
    expect(again.current.mood.sorrow).toBe(7);
    expect(again.current.presence).toBe('休息中');
  });

  it('工具回执说清改了什么、忽略了什么', async () => {
    const s = store();
    const tool = maintainStateTool({ store: s });
    const out = await tool.handler({ energy: 40, mood: { joy: 6 }, basis: '刚睡醒' }, {} as never);
    expect(out).toContain('[state updated]');
    expect(out).toContain('energy');
    const bad = await tool.handler({ energy: '没力气' }, {} as never);
    expect(bad).toContain('[state unchanged]');
  });

  it('默认值可以被覆盖而不会破坏结构', () => {
    const base = defaultState(T);
    expect(Object.keys(base)).toEqual(expect.arrayContaining(['energy', 'mood', 'conditions', 'basis']));
  });

  it('只写 basis 也算一次真实改动，不回执"没有可用的字段"', () => {
    const s = store();
    const r = s.patch({ basis: '面板手动调整' });
    expect(r.ok).toBe(true);
    expect(r.applied).toContain('basis');
    expect(s.current.basis).toBe('面板手动调整');
  });

  it('状态文件坏了就按默认值继续，不阻塞启动', () => {
    writeFileSync(join(tmp.dir, 'role-state.json'), '{ 这不是 JSON', 'utf8');
    const s = store();
    expect(s.current.energy).toBe(62);
    expect(s.current.version).toBe(1);
  });

  it('临时状况的到期时间写错就当作没有到期，不会丢掉整条', () => {
    const s = store();
    s.patch({ conditions: [{ kind: 'health', text: '有点头晕', expiresAt: '明早' }] });
    expect(s.current.conditions).toHaveLength(1);
    expect(s.current.conditions[0].expiresAt).toBeNull();
  });

  it('mood 传了非对象不会把心情清空', () => {
    const s = store();
    s.patch({ mood: { joy: 8 } });
    const before = s.current.mood.joy;
    s.patch({ mood: '开心' as unknown as Record<string, unknown> });
    expect(s.current.mood.joy).toBe(before);
  });
});
