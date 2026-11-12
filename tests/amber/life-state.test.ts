/** 生活层：临时排程、时段判定、周期推算、睡眠/地点推断、存储与换天。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LifeStateStore, cycleAt, cycleText, defaultPlan, formatMinute, lifeBlock, locationOf, shortActivity,
  minuteOf, sleepOf, slotState, viewOfSlots, currentOf, CYCLE_DAYS, type LifeSettings,
} from '../../bots/amber/persona/companion/lifeState.ts';
import { makeFakeHarnessApi, makeTmpDir } from '../core/helpers.ts';
import { composeDefaults } from '../../bots/amber/assemble.ts';
import { CortiSoulmate } from '../../bots/amber/persona/index.ts';
import type { MemoryIndex } from '../../bots/amber/persona/memoryIndex.ts';
import { advanceLifeTool, maintainLifeTool, writePlanTool } from '../../bots/amber/persona/companion/lifeTool.ts';

const TZ = 'Asia/Shanghai';
/** 2026-10-25T06:00Z = 上海 14:00。 */
const T = Date.parse('2026-10-25T06:00:00Z');

const settings = (patch: Partial<LifeSettings> = {}): LifeSettings => ({
  timezone: TZ,
  sleepStartHour: 2,
  sleepEndHour: 9,
  planItemCount: 10,
  homeName: '家里',
  cycleEnabled: true,
  cycleAnchor: '2026-10-01',
  ...patch,
});

describe('生活层 · 时间与排程', () => {
  it('HH:MM 解析与格式化', () => {
    expect(minuteOf('09:30')).toBe(570);
    expect(minuteOf('24:00')).toBe(1440);
    expect(minuteOf('9:3')).toBeNull();
    expect(minuteOf('foo')).toBeNull();
    expect(formatMinute(1500)).toBe('01:00');
  });

  it('临时排程覆盖起床到睡前，段与段不重叠', () => {
    const slots = defaultPlan(settings(), '2026-10-25');
    expect(slots).toHaveLength(10);
    expect(slots[0]?.time).toBe('09:00');
    expect(slots[9]?.end).toBe('02:00');
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.time).toBe(slots[i - 1]!.end);
    }
  });

  it('时段状态：进行中 / 已过去 / 还没到，跨午夜也对', () => {
    expect(slotState({ time: '13:00', end: '15:00', activity: 'x', mood: null, messageSeed: null, location: null }, 14 * 60)).toBe('active');
    expect(slotState({ time: '09:00', end: '10:00', activity: 'x', mood: null, messageSeed: null, location: null }, 14 * 60)).toBe('completed');
    expect(slotState({ time: '18:00', end: '19:00', activity: 'x', mood: null, messageSeed: null, location: null }, 14 * 60)).toBe('planned');
    expect(slotState({ time: '23:30', end: '00:30', activity: 'x', mood: null, messageSeed: null, location: null }, 23 * 60 + 45)).toBe('active');
    expect(slotState({ time: '23:30', end: '00:30', activity: 'x', mood: null, messageSeed: null, location: null }, 10 * 60)).toBe('planned');
  });

  it('当前段取第一个进行中的', () => {
    const view = viewOfSlots(defaultPlan(settings(), '2026-10-25'), 14 * 60);
    const current = currentOf(view);
    expect(current?.activity).toBe('上午的安排');
  });

  it('跨过午夜的末段按顺序归到明天，不会被当成已过去', () => {
    const view = viewOfSlots(defaultPlan(settings(), '2026-10-25'), 22 * 60 + 26);
    const last = view[view.length - 1]!;
    expect(last.time).toBe('00:18');
    expect(last.state).toBe('planned');
    expect(view.find((slot) => slot.state === 'active')?.time).toBe('20:54');
  });
});

describe('生活层 · 周期', () => {
  it('按 28 天推六阶段', () => {
    expect(cycleAt('2026-10-01', '2026-10-01', true)?.phase.id).toBe('menstrual');
    expect(cycleAt('2026-10-01', '2026-10-05', true)).toMatchObject({ phase: { id: 'menstrual' }, dayInPhase: 5 });
    expect(cycleAt('2026-10-01', '2026-10-06', true)).toMatchObject({ phase: { id: 'follicular' }, dayInPhase: 1 });
    expect(cycleAt('2026-10-01', '2026-10-28', true)).toMatchObject({ phase: { id: 'pms' }, dayInPhase: 3 });
    expect(cycleAt('2026-10-01', '2026-10-29', true)).toMatchObject({ phase: { id: 'menstrual' }, dayInPhase: 1 });
    expect(CYCLE_DAYS).toBe(28);
  });

  it('没开启或没锚点就没有周期；文案回落到「不处于生理期」', () => {
    expect(cycleAt(null, '2026-10-25', true)).toBeNull();
    expect(cycleAt('2026-10-01', '2026-10-25', false)).toBeNull();
    expect(cycleAt('坏日期', '2026-10-25', true)).toBeNull();
    expect(cycleText(null)).toBe('不处于生理期');
    expect(cycleText(cycleAt('2026-10-01', '2026-10-25', true))).toBe('黄体期 第9/9天');
  });
});

describe('生活层 · 睡眠与地点', () => {
  const slot = { time: '13:00', end: '14:30', activity: '午休', sleeping: true, mood: null, messageSeed: null, location: null, state: 'active' as const, startMin: 780, endMin: 870 };

  it('睡眠时段与午休段都算睡着', () => {
    expect(sleepOf({ current: null, now: Date.parse('2026-10-25T19:00:00Z'), settings: settings(), sleepText: null }))
      .toMatchObject({ sleeping: true, wakeAt: '09:00' });
    expect(sleepOf({ current: slot, now: T, settings: settings(), sleepText: null }))
      .toMatchObject({ sleeping: true, wakeAt: '14:30' });
    expect(sleepOf({ current: null, now: T, settings: settings(), sleepText: null }).text).toBe('睡眠平稳');
    expect(sleepOf({ current: null, now: T, settings: settings(), sleepText: '昨晚睡得很浅' }).text).toBe('昨晚睡得很浅');
  });

  it('地点：覆盖 > 段内地点 > 活动词 > 家里', () => {
    const now = T;
    expect(locationOf({ current: null, override: { name: '咖啡馆', at: now - 60_000 }, now, homeName: '家里' }).name).toBe('咖啡馆');
    expect(locationOf({ current: null, override: { name: '咖啡馆', at: now - 5 * 3_600_000 }, now, homeName: '家里' }).name).toBe('家里');
    const atWork = { ...slot, activity: '在公司改代码' };
    expect(locationOf({ current: atWork, override: null, now, homeName: '家里' })).toMatchObject({ name: '公司', source: 'slot' });
    expect(locationOf({ current: { ...slot, activity: '出去买点东西' }, override: null, now, homeName: '家里' }).name).toBe('外面');
    expect(locationOf({ current: { ...slot, activity: '在床上发呆' }, override: null, now, homeName: '家里' }).name).toBe('家里');
  });
});

describe('生活层 · 存储', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let now = T;
  let store: LifeStateStore;

  beforeEach(() => {
    tmp = makeTmpDir();
    now = T;
    store = new LifeStateStore(tmp.dir, () => settings(), () => now);
  });
  afterEach(() => tmp.cleanup());

  it('没写过计划时铺临时排程，并落盘', () => {
    store.ensurePlan();
    expect(store.current.plan?.source).toBe('fallback');
    expect(store.current.plan?.slots).toHaveLength(10);
    const file = join(tmp.dir, 'life-state.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).plan.slots).toHaveLength(10);
  });

  it('梦写的计划整份覆盖临时排程', () => {
    store.ensurePlan();
    const out = store.setPlan([
      { time: '09:00', end: '11:00', activity: '把报错看完', mood: '专注', messageSeed: '刚打开编辑器', location: '书房' },
      { time: '11:00', end: '12:00', activity: '做饭', mood: null, messageSeed: null, location: null },
    ]);
    expect(out).toMatchObject({ ok: true });
    expect(store.current.plan?.source).toBe('dream');
    expect(store.current.plan?.slots).toHaveLength(2);
    expect(store.setPlan([{ time: '坏', end: '01:00', activity: 'x', mood: null, messageSeed: null, location: null }]).ok).toBe(false);
  });

  it('换天作废日程与穿搭，天气与锚点留着', () => {
    store.ensurePlan();
    store.patch({ outfit: '白衬衫' });
    store.setWeather({ text: '多云 18–24℃', tempC: 21, fetchedAt: now, source: 'test' });
    now = Date.parse('2026-10-26T06:00:00Z');
    expect(store.tick()).toBe(true);
    expect(store.current.plan).toBeNull();
    expect(store.current.outfit).toBeNull();
    expect(store.current.weather?.text).toBe('多云 18–24℃');
  });

  it('生活事实的补丁有白名单，坏锚点被拒', () => {
    const out = store.patch({ hunger: '有点饿', dream: '梦到在下雨', outfit: '牛仔裤', cycleAnchor: '2026-10-20' });
    expect(out.ok).toBe(true);
    expect(out.applied).toEqual(['hunger', 'dream', 'outfit', 'cycleAnchor']);
    expect(store.patch({ cycleAnchor: '昨天' }).rejected).toContain('cycleAnchor');
  });

  it('快照把八格需要的值都算出来，体力吃周期偏移', () => {
    store.ensurePlan();
    const snap = store.snapshot({ energy: 60, mood: '有点累', health: null, sleepText: null });
    expect(snap).toMatchObject({
      date: '2026-10-25',
      weather: '暂无天气信息',
      location: '家里',
      mood: '有点累',
      agendaCount: 10,
      planSource: 'fallback',
      health: '状态正常',
      hunger: '无饥饿感',
      dream: '没有记住梦',
      body: '黄体期 第9/9天',
    });
    // 黄体期 +5：60 → 65。
    expect(snap.energy).toBe(65);
    expect(snap.current?.activity).toBe('上午的安排');
    expect(lifeBlock(snap)).toContain('现在：12:24–14:06 上午的安排');
    // 被问「下午在干嘛」时，过去的时间线也在：不能只给当前这一段。
    expect(lifeBlock(snap)).toContain('上午：09:00–10:42 起床、洗漱');
    expect(lifeBlock(snap)).toContain('中午：');
    expect(lifeBlock(snap)).not.toContain('暂无天气信息');
    expect(lifeBlock(snap)).toContain('不要拿「手头」的旧状态代替');
  });

  it('坏文件回默认值，不抛错', () => {
    const broken = join(tmp.dir, 'life-state.json');
    store.ensurePlan();
    writeFileSync(broken, '{not json', 'utf8');
    const again = new LifeStateStore(tmp.dir, () => settings(), () => now);
    expect(again.current.plan).toBeNull();
    expect(again.current.hunger).toBe('无饥饿感');
  });
});

describe('生活层 · 梦的工具', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let store: LifeStateStore;

  beforeEach(() => {
    tmp = makeTmpDir();
    store = new LifeStateStore(tmp.dir, () => settings(), () => T);
  });
  afterEach(() => tmp.cleanup());

  it('write_daily_plan 写入计划并回报段数', async () => {
    const tool = writePlanTool({ store });
    const out = await tool.handler({
      slots: [
        { time: '09:00', end: '11:00', activity: '看报错', mood: '专注' },
        { time: '11:00', end: '12:00', activity: '做饭' },
      ],
    } as never, {} as never);
    expect(out).toContain('2 个时间段');
    expect(store.current.plan?.source).toBe('dream');
  });

  it('空数组是"今天不排"，不是坏输入，也不会被临时排程盖掉', async () => {
    const tool = writePlanTool({ store });
    const out = await tool.handler({ slots: [] } as never, {} as never);
    expect(out).toContain('今天不排了');
    expect(store.current.plan?.slots).toHaveLength(0);
    expect(store.current.plan?.source).toBe('dream');
    // 她定过就算数：临时排程不许接管。
    store.ensurePlan();
    expect(store.current.plan?.slots).toHaveLength(0);
  });

  it('有段但每段都缺字段 → plan unchanged', async () => {
    const tool = writePlanTool({ store });
    const bad = await tool.handler({ slots: [{ time: '09:00' }] } as never, {} as never);
    expect(bad).toContain('plan unchanged');
  });

  it('被打断：当前段记下实际，后面的段整体顺延', () => {
    store.setPlan([
      { time: '13:00', end: '15:00', activity: '写稿' },
      { time: '15:00', end: '16:00', activity: '出门买菜' },
      { time: '16:00', end: '17:00', activity: '读书' },
    ] as never, 'dream');
    // T 是上海 14:00，落在第一段里。
    const out = store.advance('被他们拖在楼下吃饭', '16:30');
    expect(out.ok).toBe(true);
    const slots = store.current.plan!.slots;
    expect(slots[0]!.actual).toBe('被他们拖在楼下吃饭');
    expect(slots[0]!.end).toBe('16:30');
    expect(slots[1]!.time).toBe('16:30');
    expect(slots[2]!.end).toBe('18:30');
  });

  it('顺延到第二天的段直接丢掉，今天不做了', () => {
    store.setPlan([
      { time: '13:00', end: '15:00', activity: '写稿' },
      { time: '23:30', end: '23:50', activity: '收尾' },
    ] as never, 'dream');
    store.advance('被拖住了', '22:00');
    const slots = store.current.plan!.slots;
    expect(slots).toHaveLength(1);
    expect(slots[0]!.end).toBe('22:00');
  });

  it('没有正在进行的一段 → life unchanged', () => {
    store.setPlan([{ time: '09:00', end: '10:00', activity: '早饭' }] as never, 'dream');
    // T 是 14:00，哪一段都不在里面。
    expect(store.advance('临时出门').ok).toBe(false);
  });

  it('maintain_life 改生活事实与地点', async () => {
    const tool = maintainLifeTool({ store });
    const out = await tool.handler({ hunger: '有点饿', dream: '梦到下雨', outfit: '白衬衫', location: '阳台' } as never, {} as never);
    expect(out).toContain('life updated');
    expect(store.current.hunger).toBe('有点饿');
    expect(store.current.dream).toBe('梦到下雨');
    expect(store.current.outfit).toBe('白衬衫');
    expect(store.current.locationOverride?.name).toBe('阳台');
    const empty = await tool.handler({} as never, {} as never);
    expect(empty).toContain('life unchanged');
  });
});

describe('实际活动与跨午夜接续', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let now = T;
  let store: LifeStateStore;
  const extra = { energy: 60, mood: '平稳', health: null, sleepText: null };

  beforeEach(() => {
    tmp = makeTmpDir();
    now = T;
    store = new LifeStateStore(tmp.dir, () => settings(), () => now);
  });
  afterEach(() => tmp.cleanup());

  it('旧日程的未来睡觉描述不会冒充当前睡眠，明确状态不依赖活动用词', () => {
    store.setPlan([{ time: '13:00', end: '15:00', activity: '洗茶壶，看几页书就睡' }] as never);
    expect(store.snapshot(extra).sleep.sleeping).toBe(false);
    store.setPlan([{ time: '13:00', end: '15:00', activity: '午间恢复', sleeping: true }] as never);
    expect(store.snapshot(extra).sleep.sleeping).toBe(true);
    store.setPlan([{ time: '13:00', end: '15:00', activity: '不睡觉，准备明天的事情', sleeping: false }] as never);
    expect(store.snapshot(extra).sleep.sleeping).toBe(false);
  });

  it('夜间明确清醒优先于作息；未标记的旧数据仍按作息兜底', () => {
    now = Date.parse('2026-10-25T19:30:00Z');
    store.setPlan([{ time: '02:00', end: '08:00', activity: '坐着看书', sleeping: false }] as never);
    expect(store.sleepingAt(now)).toBe(false);
    store.setPlan([{ time: '02:00', end: '08:00', activity: '坐着看书', sleeping: true }] as never);
    expect(store.sleepingAt(now)).toBe(true);
    store.setPlan([{ time: '02:00', end: '08:00', activity: '没有睡眠标记的旧日程' }] as never);
    expect(store.sleepingAt(now)).toBe(true);
  });

  it('advance_life 明确登记睡眠或清醒，跨重启保留且不靠正文猜测', async () => {
    store.setPlan([{ time: '13:00', end: '15:00', activity: '读书', sleeping: false }] as never);
    const tool = advanceLifeTool({ store });
    expect(String(await tool.handler({ doing: '抱着抱枕休息', sleeping: true, location: '卧室' }, {} as never)))
      .toContain('[life advanced]');
    expect(store.sleepingAt(now)).toBe(true);
    const again = new LifeStateStore(tmp.dir, () => settings(), () => now);
    expect(again.sleepingAt(now)).toBe(true);
    const wake = advanceLifeTool({ store: again });
    await wake.handler({ doing: '去楼下挑热饮', location: '便利店', sleeping: false }, {} as never);
    expect(again.sleepingAt(now)).toBe(false);
    expect(again.snapshot(extra).current?.activity).toBe('去楼下挑热饮');
  });

  it('午休改成外出后，快照活动、地点和睡眠一致，并保留原计划', () => {
    store.setPlan([{ time: '13:00', end: '15:00', activity: '午休', location: '卧室', messageSeed: '困得睁不开眼' }] as never);
    expect(store.advance('在楼下吃饭', undefined, '楼下餐馆').ok).toBe(true);
    const snap = store.snapshot(extra);
    expect(snap.current?.activity).toBe('在楼下吃饭');
    expect(snap.sleep.sleeping).toBe(false);
    expect(store.sleepingAt(now)).toBe(false);
    expect(snap.location).toBe('楼下餐馆');
    expect(store.current.plan?.slots[0].activity).toBe('午休');
    expect(lifeBlock(snap)).toContain('原：午休');
    expect(lifeBlock(snap)).not.toContain('困得睁不开眼');
  });

  it('睡眠窗口里明确改成清醒活动后，不再被默认作息判为睡着', () => {
    now = Date.parse('2026-10-25T19:30:00Z');
    store.setPlan([{ time: '02:00', end: '08:00', activity: '睡觉' }] as never);
    store.advance('在厨房喝水', undefined, '厨房');
    expect(store.snapshot(extra).sleep.sleeping).toBe(false);
  });

  it('跨午夜当前段能修改，延长到午夜之后时后续时段按同一时间轴顺延', () => {
    now = Date.parse('2026-10-25T15:30:00Z');
    store.setPlan([
      { time: '23:00', end: '01:00', activity: '读书' },
      { time: '01:00', end: '02:00', activity: '收拾书桌' },
    ] as never);
    expect(store.advance('还在读书', '01:30').ok).toBe(true);
    expect(store.current.plan?.slots[0].end).toBe('01:30');
    expect(store.current.plan?.slots[1].time).toBe('01:30');
    expect(store.current.plan?.slots[1].end).toBe('02:30');
  });

  it('午夜换天和重启后，未结束的实际活动继续有效，到点后退出', () => {
    now = Date.parse('2026-10-25T15:30:00Z');
    store.setPlan([{ time: '23:00', end: '01:00', activity: '读书' }] as never);
    store.advance('在阳台喝茶', undefined, '阳台');
    now = Date.parse('2026-10-25T16:30:00Z');
    store.ensurePlan();
    expect(store.snapshot(extra).current?.activity).toBe('在阳台喝茶');
    const again = new LifeStateStore(tmp.dir, () => settings(), () => now);
    expect(again.snapshot(extra).current?.activity).toBe('在阳台喝茶');
    expect(again.advance('回书桌读书', undefined, '书房').ok).toBe(true);
    expect(again.snapshot(extra).current?.activity).toBe('回书桌读书');
    now = Date.parse('2026-10-25T17:00:00Z');
    expect(again.snapshot(extra).current?.activity).not.toBe('回书桌读书');
  });

  it('今天明确的新活动优先于昨日跨午夜计划，不会两段同时进行', () => {
    now = Date.parse('2026-10-25T15:30:00Z');
    store.setPlan([{ time: '23:00', end: '01:00', activity: '读书' }] as never);
    now = Date.parse('2026-10-25T16:30:00Z');
    store.setPlan([{ time: '00:00', end: '01:00', activity: '睡觉', sleeping: true }] as never);
    const snap = store.snapshot(extra);
    expect(snap.current?.activity).toBe('睡觉');
    expect(snap.slots.filter((slot) => slot.state === 'active')).toHaveLength(1);
    expect(store.sleepingAt(now)).toBe(true);
  });

  it('相对五分钟按提交时刻精确计算，保留秒和毫秒，不填充空日程', () => {
    now = T + 17_432;
    store.setPlan([]);
    expect(store.advance('在沙发翻画册', undefined, '家里·沙发', false, 5).ok).toBe(true);
    expect(store.current.actualActivity?.startedAt).toBe(now);
    expect(store.current.actualActivity?.endsAt).toBe(now + 5 * 60_000);
    expect(store.current.plan?.slots).toEqual([]);
    now += 5 * 60_000;
    expect(store.snapshot(extra).current).toBeNull();
  });

  it('当前有日程段时相对时长仍精确到期，不延长成整段计划', () => {
    store.setPlan([{ time: '13:00', end: '15:00', activity: '午休', sleeping: true }] as never);
    expect(store.advance('到沙发翻画册', undefined, '家里·沙发', false, 5).ok).toBe(true);
    expect(store.snapshot(extra).current?.activity).toBe('到沙发翻画册');
    expect(store.sleepingAt(now)).toBe(false);
    expect(store.current.plan?.slots[0].actual).toBeNull();
    expect(store.current.plan?.slots[0].end).toBe('15:00');
    now += 5 * 60_000;
    expect(store.snapshot(extra).current?.activity).toBe('午休');
    expect(store.sleepingAt(now)).toBe(true);
  });

  it('相对时长与绝对钟点冲突时拒绝，不偷偷选一个', () => {
    store.setPlan([]);
    const before = JSON.stringify(store.current);
    expect(store.advance('翻画册', '14:10', '沙发', false, 5).ok).toBe(false);
    expect(JSON.stringify(store.current)).toBe(before);
  });

  it.each([0, -1, NaN, Infinity, Number.MAX_VALUE])('坏相对时长拒绝且不改变已有日程：%s', (duration) => {
    store.setPlan([{ time: '13:00', end: '15:00', activity: '读书', sleeping: false }] as never);
    const before = JSON.stringify(store.current);
    expect(store.advance('翻画册', undefined, '沙发', false, duration).ok).toBe(false);
    expect(JSON.stringify(store.current)).toBe(before);
  });

  it('更新已登记活动但没重新给期限时，不重置五分钟的起点或截止时间', () => {
    store.setPlan([]);
    expect(store.advance('翻画册', undefined, '沙发', false, 5).ok).toBe(true);
    now += 2 * 60_000;
    expect(store.advance('翻到下一页', undefined, '沙发', false).ok).toBe(true);
    expect(store.current.actualActivity?.startedAt).toBe(T);
    expect(store.current.actualActivity?.endsAt).toBe(T + 5 * 60_000);
  });

  it('相对时长跨午夜和重启仍保持同一毫秒期限', () => {
    now = Date.parse('2026-10-25T15:58:30.125Z');
    store.setPlan([]);
    const started = now;
    expect(store.advance('翻两页画册', undefined, '沙发', false, 5).ok).toBe(true);
    now = started + 4 * 60_000;
    const again = new LifeStateStore(tmp.dir, () => settings(), () => now);
    expect(again.snapshot(extra).current?.activity).toBe('翻两页画册');
    expect(again.current.actualActivity?.endsAt).toBe(started + 5 * 60_000);
    now = started + 5 * 60_000;
    expect(again.snapshot(extra).current).toBeNull();
  });

  it('独立活动工具支持小数分钟，并拒绝坏类型或双时间字段', async () => {
    store.setPlan([]);
    const tool = advanceLifeTool({ store });
    expect(String(await tool.handler({ doing: '翻一页画册', sleeping: false, duration_minutes: 0.5 }, {} as never)))
      .toContain('[life advanced]');
    expect(store.current.actualActivity?.endsAt).toBe(T + 30_000);
    const before = JSON.stringify(store.current);
    expect(String(await tool.handler({ doing: '翻画册', duration_minutes: '5' }, {} as never))).toContain('[life unchanged]');
    expect(String(await tool.handler({ doing: '翻画册', duration_minutes: 5, until: '14:10' }, {} as never))).toContain('[life unchanged]');
    expect(String(await tool.handler({ doing: '翻画册', duration_minutes: 5, until: 1410 }, {} as never))).toContain('[life unchanged]');
    expect(JSON.stringify(store.current)).toBe(before);
  });

  it('空日程中独立登记实际活动，计划仍为空，状态与地点立即更新', async () => {
    store.setPlan([]);
    const tool = advanceLifeTool({ store });
    const out = await tool.handler({ doing: '床边坐着喝牛奶', until: '14:15', location: '卧室', sleeping: false }, {} as never);
    expect(String(out)).toContain('[life advanced]');
    store.ensurePlan();
    expect(store.current.plan?.slots).toEqual([]);
    const snap = store.snapshot(extra);
    expect(snap.agendaCount).toBe(0);
    expect(snap.current?.activity).toBe('床边坐着喝牛奶');
    expect(snap.location).toBe('卧室');
    expect(snap.sleep.sleeping).toBe(false);
    expect(lifeBlock(snap)).toContain('床边坐着喝牛奶');
    expect(lifeBlock(snap)).not.toContain('原：床边坐着喝牛奶');
    const again = new LifeStateStore(tmp.dir, () => settings(), () => now);
    expect(again.snapshot(extra).current?.activity).toBe('床边坐着喝牛奶');
    expect(again.current.plan?.slots).toEqual([]);
  });

  it('未安排时段的活动到点退出，不改动下一段计划', () => {
    store.setPlan([{ time: '14:05', end: '15:00', activity: '看书', sleeping: false }] as never);
    expect(store.advance('坐着喝牛奶', '14:10', '卧室').ok).toBe(true);
    now += 6 * 60_000;
    expect(store.snapshot(extra).current?.activity).toBe('坐着喝牛奶');
    expect(store.advance('把杯子放回桌上').ok).toBe(true);
    expect(store.snapshot(extra).location).toBe('卧室');
    now = T + 10 * 60_000;
    expect(store.snapshot(extra).current?.activity).toBe('看书');
    expect(store.current.plan?.slots[0].time).toBe('14:05');
    expect(store.current.plan?.slots[0].end).toBe('15:00');
    expect(store.current.plan?.slots[0].actual).toBeNull();
    expect(store.snapshot(extra).location).not.toBe('卧室');
  });

  it('日程空档缺结束时间或给坏时间时明确拒绝，不声称更新成功', async () => {
    store.setPlan([]);
    const tool = advanceLifeTool({ store });
    expect(String(await tool.handler({ doing: '床边喝牛奶' }, {} as never))).toContain('until');
    expect(store.advance('床边喝牛奶', '24:30').ok).toBe(false);
    expect(store.advance('床边喝牛奶', '坏时间').ok).toBe(false);
    expect(store.snapshot(extra).current).toBeNull();
    expect(store.current.plan?.slots).toEqual([]);
  });

  it('空档实际活动跨午夜、重启仍有效，到期后不残留', () => {
    now = Date.parse('2026-10-25T15:55:00Z');
    store.setPlan([]);
    expect(store.advance('床边坐一会儿', '00:10', '卧室', false).ok).toBe(true);
    now = Date.parse('2026-10-25T16:05:00Z');
    const again = new LifeStateStore(tmp.dir, () => settings(), () => now);
    expect(again.snapshot(extra).current?.activity).toBe('床边坐一会儿');
    expect(again.sleepingAt(now)).toBe(false);
    now = Date.parse('2026-10-25T16:10:00Z');
    expect(again.snapshot(extra).current).toBeNull();
  });

  it('没有计划也能明确睡眠或清醒，到期后恢复作息兜底', () => {
    now = Date.parse('2026-10-25T19:00:00Z');
    store.setPlan([]);
    expect(store.advance('床边喝牛奶', '03:10', '卧室', false).ok).toBe(true);
    expect(store.sleepingAt(now)).toBe(false);
    now += 10 * 60_000;
    expect(store.sleepingAt(now)).toBe(true);
    expect(store.advance('抱着枕头休息', '04:00', '卧室', true).ok).toBe(true);
    expect(store.snapshot(extra).sleep.sleeping).toBe(true);
  });

  it('空日程仍可留白，改活动失败不会创建临时安排', () => {
    store.setPlan([]);
    expect(store.advance('去喝茶').ok).toBe(false);
    store.ensurePlan();
    expect(store.current.plan?.slots).toEqual([]);
    expect(store.snapshot(extra).current).toBeNull();
  });

  it('跨午夜后直接重开仍能修改昨天尚未结束的时段', () => {
    now = Date.parse('2026-10-25T15:30:00Z');
    store.setPlan([{ time: '23:00', end: '01:00', activity: '读书' }] as never);
    now = Date.parse('2026-10-25T16:30:00Z');
    const again = new LifeStateStore(tmp.dir, () => settings(), () => now);
    expect(again.advance('在厨房煮面', '01:30', '厨房').ok).toBe(true);
    expect(again.snapshot(extra).current?.activity).toBe('在厨房煮面');
  });
});

describe('实际活动的上下文与创作门禁', () => {
  it('午休改为吃饭后，状态注入、公开状态与创作门禁一起更新', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const tmp = makeTmpDir();
    const persona = new CortiSoulmate({ memoryDir: tmp.dir, cfg: composeDefaults(), wakeLogDir: tmp.dir });
    const internal = persona as unknown as {
      life: LifeStateStore;
      index: MemoryIndex | null;
      injectRoleState(): void;
      stateAsleep(date: Date): boolean;
      creativeBlockedAt(now: number): string | null;
    };
    try {
      const injected: string[] = [];
      persona.attach(makeFakeHarnessApi({ injectInternal: (text) => { injected.push(text); } }));
      internal.life.setPlan([{ time: '13:00', end: '15:00', activity: '午休', sleeping: true }] as never);
      expect(internal.creativeBlockedAt(T)).not.toBeNull();
      internal.life.advance('在楼下吃饭', undefined, '楼下餐馆');
      internal.injectRoleState();
      const state = injected.find((text) => text.includes('[你自己此刻的状态]'))!;
      expect(state).toContain('实际：在楼下吃饭');
      expect(state).toContain('公开状态：在楼下吃饭');
      expect(state).not.toContain('按日程：午休');
      expect(internal.stateAsleep(new Date(T))).toBe(false);
      expect(internal.creativeBlockedAt(T)).toBeNull();
      internal.life.setPlan([]);
      expect(internal.life.advance('在床边喝牛奶', '14:10', '卧室', false).ok).toBe(true);
      internal.injectRoleState();
      const gapState = injected.filter((text) => text.includes('[你自己此刻的状态]')).at(-1)!;
      expect(gapState).toContain('实际：在床边喝牛奶');
      expect(gapState).toContain('公开状态：在床边喝牛奶');
      expect(gapState).not.toContain('在楼下吃饭');
      expect(internal.life.current.plan?.slots).toEqual([]);
    } finally {
      persona.stopRhythm();
      internal.index?.close();
      tmp.cleanup();
      vi.useRealTimers();
    }
  });
});

describe('生活层 · 公开状态短标签', () => {
  it('取第一个分句，最多八个字', () => {
    expect(shortActivity('群里的时间：看着他们刷图和调试')).toBe('群里的时间');
    expect(shortActivity('整理笔记：把示例当台词那条补上')).toBe('整理笔记');
    expect(shortActivity('一个很长很长的活动名称没有分句')).toBe('一个很长很长的活');
  });
});
