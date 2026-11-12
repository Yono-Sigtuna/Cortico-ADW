/** 时间问题的定向注入：识别问的是哪一段，只给那几段，并带上"上一句说过什么"。 */
import { describe, it, expect } from 'vitest';
import { detectTimeScope, groundingBlock } from '../../bots/amber/persona/companion/grounding.ts';
import { defaultPlan, viewOfSlots, type LifeSettings, type LifeSnapshot } from '../../bots/amber/persona/companion/lifeState.ts';

const T = Date.parse('2026-10-26T06:00:00Z'); // 上海 14:00
const settings: LifeSettings = {
  timezone: 'Asia/Shanghai', sleepStartHour: 2, sleepEndHour: 9, planItemCount: 10,
  homeName: '家里', cycleEnabled: false, cycleAnchor: null,
};

function snapshot(nowMin: number): LifeSnapshot {
  const slots = viewOfSlots(defaultPlan(settings, '2026-10-26'), nowMin);
  const current = slots.find((slot) => slot.state === 'active') ?? null;
  return {
    date: '2026-10-26', refreshedAt: T, weather: '暂无天气信息', location: '家里', locationSource: 'default',
    mood: '平稳', agendaCount: slots.length, planSource: 'dream', slots, current,
    next: slots.find((slot) => slot.state === 'planned') ?? null,
    sleep: { sleeping: false, text: '睡眠平稳', wakeAt: null },
    cycle: null, body: '不处于生理期', health: '状态正常', hunger: '无饥饿感',
    dream: '没有记住梦', outfit: '', energy: 60,
  };
}

describe('时间问题 · 识别', () => {
  it('按时间词识别，具体时段优先于"今天"', () => {
    expect(detectTimeScope('下午在干嘛')).toBe('afternoon');
    expect(detectTimeScope('今天下午在干嘛')).toBe('afternoon');
    expect(detectTimeScope('上午忙什么了')).toBe('morning');
    expect(detectTimeScope('晚上做什么')).toBe('evening');
    expect(detectTimeScope('刚才在干嘛')).toBe('justnow');
    expect(detectTimeScope('你在干嘛')).toBe('now');
    expect(detectTimeScope('今天过得怎么样')).toBe('today');
    expect(detectTimeScope('这个 bug 怎么修')).toBeNull();
  });
});

describe('时间问题 · 注入块', () => {
  it('问下午：只给下午那几段', () => {
    const block = groundingBlock(snapshot(14 * 60), 'afternoon')!;
    expect(block).toContain('[他问的是你的下午]');
    expect(block).toContain('下午：');
    // 14:00 之后的两段属于下午；晚上与上午的不该出现。
    expect(block).toContain('午饭');
    expect(block).not.toContain('起床、洗漱');
    expect(block).not.toContain('睡前收拾');
  });

  it('问现在：给当前这一段', () => {
    const block = groundingBlock(snapshot(14 * 60), 'now')!;
    expect(block).toContain('[他问的是你的此刻]');
    expect(block).toContain('上午的安排');
  });

  it('日程只标为计划，不能直接声称它已发生', () => {
    const block = groundingBlock(snapshot(14 * 60), 'now')!;
    expect(block).toContain('计划：上午的安排');
    expect(block).toContain('计划不等于已经做过');
    expect(block).not.toContain('下面是真实发生过/正在发生的安排');
  });

  it('已登记的实际活动明确标出，不把原计划当成回答', () => {
    const snap = snapshot(14 * 60);
    const actual = { ...snap.current!, activity: '在楼下挑热饮', actual: '在楼下挑热饮' };
    const block = groundingBlock({ ...snap, current: actual }, 'now')!;
    expect(block).toContain('实际：在楼下挑热饮');
    expect(block).not.toContain('计划：上午的安排');
  });

  it('问刚才：给已过的最近两段加现在', () => {
    const block = groundingBlock(snapshot(14 * 60), 'justnow')!;
    expect(block).toContain('[他问的是你的刚才到现在]');
    expect(block).toContain('（现在）');
  });

  it('带上她上一句说过的话，提醒别复述', () => {
    const block = groundingBlock(snapshot(14 * 60), 'afternoon', '在收拾记录，核昨天答错的地方')!;
    expect(block).toContain('你上一句已经说过');
    expect(block).toContain('在收拾记录');
    expect(block).toContain('别把同一件事再说一遍');
  });

  it('没有日程也没有上一句时，不注入', () => {
    const empty: LifeSnapshot = { ...snapshot(14 * 60), slots: [], current: null, next: null, agendaCount: 0 };
    expect(groundingBlock(empty, 'afternoon', null)).toBeNull();
    expect(groundingBlock(empty, 'today', '上一句')).toContain('这一段没有安排');
  });
});
