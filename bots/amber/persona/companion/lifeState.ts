/**
 * 生活状态：她今天怎么过。
 *
 * 这一层回答的是 AstrBot 陪伴面板「今日 / 当前」那两张卡的问题——
 * 天气、地点、今天几段日程、现在在做什么、睡没睡、身体处在周期哪一天、
 * 饿不饿、昨晚记住梦没有、换没换衣服。
 *
 * 边界：它不决定她怎么说话（那是 RoleState 的活），只给「生活延续感」提供事实。
 * 日程由梦写；没写时用一份按作息切出来的临时排程，面板会标明来源。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dayKey, inHourWindow, localHour } from './state.ts';
import { nowIso, parseTimeIn } from 'cortico/core/util.ts';

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

export interface AgendaSlot {
  /** HH:MM */
  time: string;
  /** HH:MM；跨午夜时小于 time */
  end: string;
  activity: string;
  mood: string | null;
  messageSeed: string | null;
  /** 这一段她在哪；不给就按活动词推断。 */
  location: string | null;
  /** 实际做了什么；和计划不一样时才有值。旧存档里没有这个字段。 */
  actual?: string | null;
  sleeping?: boolean;
  actualSleeping?: boolean;
}

export interface LifeWeather {
  /** 「多云 18–24℃」这类可直接显示的一句。 */
  text: string;
  tempC: number | null;
  fetchedAt: number;
  source: string;
}

export interface CyclePhase {
  id: 'menstrual' | 'follicular' | 'pre_ovulation' | 'ovulation' | 'luteal' | 'pms';
  name: string;
  days: number;
  label: string;
  mood: string;
  energyDelta: number;
}

/** 六阶段，默认 5+7+2+2+9+3 = 28 天。文案与体力偏移取 AstrBot 的原值。 */
export const CYCLE_PHASES: readonly CyclePhase[] = [
  { id: 'menstrual', name: '经期', days: 5, label: '处于月经期，身体更容易疲倦，情绪感受稍敏锐', mood: '疲惫', energyDelta: -12 },
  { id: 'follicular', name: '卵泡期', days: 7, label: '处于卵泡期，精力平稳回升，心情逐渐轻快', mood: '轻快', energyDelta: 0 },
  { id: 'pre_ovulation', name: '排卵前期', days: 2, label: '处于排卵前期，身体逐渐轻盈，精力有所上升', mood: '期待', energyDelta: 8 },
  { id: 'ovulation', name: '排卵期', days: 2, label: '处于排卵期，精力较充足，社交意愿稍有增强', mood: '明朗', energyDelta: 9 },
  { id: 'luteal', name: '黄体期', days: 9, label: '处于黄体期，精力尚可，情绪整体平稳', mood: '平稳', energyDelta: 5 },
  { id: 'pms', name: 'PMS 期', days: 3, label: '处于 PMS 期，精力有所下降，情绪波动稍明显', mood: '敏感', energyDelta: -8 },
];

export const CYCLE_DAYS = CYCLE_PHASES.reduce((sum, phase) => sum + phase.days, 0);

export interface CycleState {
  phase: CyclePhase;
  dayInPhase: number;
}

export interface LifeStateData {
  version: 1;
  /** 这份数据属于哪一天（本地日期）。换天时日程与穿搭作废，周期锚点不动。 */
  day: string;
  refreshedAt: number;
  plan: { slots: AgendaSlot[]; generatedAt: number; source: 'dream' | 'fallback' } | null;
  previousPlan?: { day: string; plan: NonNullable<LifeStateData['plan']> };
  actualActivity?: {
    activity: string;
    location: string | null;
    sleeping: boolean;
    startedAt: number;
    endsAt: number;
  };
  weather: LifeWeather | null;
  /** 对话/日程之外的地点覆盖，4 小时内有效。 */
  locationOverride: { name: string; at: number } | null;
  hunger: string;
  dream: string;
  /** 今日穿搭的文字；没有图后端时为 null，面板显示「暂无穿搭图」。 */
  outfit: string | null;
  /** 周期锚点：最近一次月经开始的那天，YYYY-MM-DD。 */
  cycleAnchor: string | null;
}

export interface LifeSettings {
  timezone: string;
  sleepStartHour: number;
  sleepEndHour: number;
  planItemCount: number;
  homeName: string;
  cycleEnabled: boolean;
  cycleAnchor: string | null;
}

export interface SlotView extends AgendaSlot {
  plannedActivity?: string;
  state: 'planned' | 'active' | 'completed';
  /** 这一段在本地时间里的分钟数，面板画时间轴用。 */
  startMin: number;
  endMin: number;
}

export interface LifeSnapshot {
  date: string;
  refreshedAt: number;
  weather: string;
  location: string;
  locationSource: 'slot' | 'override' | 'default';
  mood: string;
  agendaCount: number;
  planSource: 'dream' | 'fallback' | 'none';
  slots: SlotView[];
  current: SlotView | null;
  next: SlotView | null;
  sleep: { sleeping: boolean; text: string; wakeAt: string | null };
  cycle: CycleState | null;
  body: string;
  health: string;
  hunger: string;
  dream: string;
  outfit: string;
  energy: number;
}

// ---------------------------------------------------------------------------
// 时间工具
// ---------------------------------------------------------------------------

/** `HH:MM` → 分钟；坏值返回 null。 */
export function minuteOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 24 || min < 0 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function formatMinute(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 现在是一天里的第几分钟（按部署时区）。 */
export function minuteOfDay(now: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(now));
  const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return pick('hour') * 60 + pick('minute');
}

/** 一段持续多少分钟；`end` 等于 `time` 视为 24 小时。 */
function durationOf(startMin: number, endMinRaw: number): number {
  const d = ((endMinRaw - startMin) % 1440 + 1440) % 1440;
  return d === 0 ? 1440 : d;
}

/** 现在这一段的进度：已过 / 进行中 / 还没到。 */
export function slotState(slot: AgendaSlot, nowMin: number): SlotView['state'] {
  const startMin = minuteOf(slot.time);
  const endRaw = minuteOf(slot.end);
  if (startMin === null || endRaw === null) return 'planned';
  const endMin = startMin + durationOf(startMin, endRaw);
  if (nowMin >= startMin && nowMin < endMin) return 'active';
  return nowMin >= endMin ? 'completed' : 'planned';
}

/**
 * 一整天的时间轴。
 *
 * 按顺序排下来，遇到"开始时间比上一段还小"就是跨过了午夜，整段加一天。
 * 单看一段没法知道它是不是明天的 —— 这个信息只在顺序里。
 */
export function viewOfSlots(slots: readonly AgendaSlot[], nowMin: number): SlotView[] {
  const out: SlotView[] = [];
  let offset = 0;
  let prevStart = Number.NEGATIVE_INFINITY;
  for (const slot of slots) {
    const rawStart = minuteOf(slot.time) ?? 0;
    if (rawStart + offset < prevStart) offset += 1440;
    const startMin = rawStart + offset;
    const endRaw = minuteOf(slot.end) ?? rawStart;
    const endMin = startMin + durationOf(rawStart, endRaw);
    prevStart = startMin;
    const state: SlotView['state'] = nowMin >= startMin && nowMin < endMin
      ? 'active'
      : nowMin >= endMin ? 'completed' : 'planned';
    out.push({
      ...slot,
      activity: slot.actual?.trim() || slot.activity,
      ...(slot.actual?.trim() ? {
        plannedActivity: slot.activity, messageSeed: null, sleeping: slot.actualSleeping ?? false,
      } : {}),
      state, startMin, endMin,
    });
  }
  return out;
}

export function currentOf(view: readonly SlotView[]): SlotView | null {
  return view.find((slot) => slot.state === 'active') ?? null;
}

export function nextOf(view: readonly SlotView[], current: SlotView | null): SlotView | null {
  if (!current) return view.find((slot) => slot.state === 'planned') ?? null;
  const idx = view.indexOf(current);
  return view.slice(idx + 1).find((slot) => slot.state === 'planned') ?? null;
}

// ---------------------------------------------------------------------------
// 临时排程：梦还没写今天的时候，先按作息切出可用的一段
// ---------------------------------------------------------------------------

const TEMPLATE: Array<{ activity: string; mood: string; seed: string }> = [
  { activity: '起床、洗漱', mood: '清爽', seed: '刚醒，声音还有点哑' },
  { activity: '早餐', mood: '平稳', seed: '早饭吃到一半' },
  { activity: '上午的安排', mood: '专注', seed: '手头的东西还没理完' },
  { activity: '午饭', mood: '放松', seed: '刚放下筷子' },
  { activity: '午休', mood: '困', seed: '有点睡意' },
  { activity: '下午的安排', mood: '平稳', seed: '下午的事情推着走' },
  { activity: '傍晚透气', mood: '轻快', seed: '出去走了一圈' },
  { activity: '晚饭', mood: '放松', seed: '正在吃晚饭' },
  { activity: '晚上的时间', mood: '安静', seed: '晚上比较安静' },
  { activity: '睡前收拾', mood: '困', seed: '准备收尾了' },
];

/**
 * 按她的作息切一段临时日程。
 *
 * 不是"编好的生活"，只是让「日程 N 个时间段」和当前活动在梦还没写之前也有个着落；
 * 面板会标出来源是临时排程。
 */
export function defaultPlan(settings: LifeSettings, date: string): AgendaSlot[] {
  const wake = settings.sleepEndHour;
  const bed = settings.sleepStartHour <= wake ? settings.sleepStartHour + 24 : settings.sleepStartHour;
  const total = (bed - wake) * 60;
  const count = Math.max(1, Math.min(16, settings.planItemCount));
  const step = Math.floor(total / count);
  const slots: AgendaSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = wake * 60 + step * i;
    const end = i === count - 1 ? bed * 60 : start + step;
    const tpl = TEMPLATE[i % TEMPLATE.length]!;
    slots.push({
      time: formatMinute(start),
      end: formatMinute(end),
      activity: tpl.activity,
      mood: tpl.mood,
      messageSeed: tpl.seed,
      location: null,
      actual: null,
    });
  }
  void date;
  return slots;
}

// ---------------------------------------------------------------------------
// 周期
// ---------------------------------------------------------------------------

/** 本地日期 → UTC 日序号；坏日期返回 null。 */
function dateOrdinal(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

/** 给定锚点与今天，算处在周期的哪一段。锚点是最近一次月经开始日。 */
export function cycleAt(anchor: string | null, today: string, enabled: boolean): CycleState | null {
  if (!enabled || !anchor) return null;
  const from = dateOrdinal(anchor);
  const to = dateOrdinal(today);
  if (from === null || to === null) return null;
  const days = ((to - from) % CYCLE_DAYS + CYCLE_DAYS) % CYCLE_DAYS;
  let cursor = 0;
  for (const phase of CYCLE_PHASES) {
    if (days < cursor + phase.days) {
      return { phase, dayInPhase: days - cursor + 1 };
    }
    cursor += phase.days;
  }
  return null;
}

export function cycleText(cycle: CycleState | null): string {
  if (!cycle) return '不处于生理期';
  return `${cycle.phase.name} 第${cycle.dayInPhase}/${cycle.phase.days}天`;
}

// ---------------------------------------------------------------------------
// 睡眠 / 地点
// ---------------------------------------------------------------------------

const HOME_WORDS = /家|房间|床|沙发|屋里/;
const WORK_WORDS = /公司|上班|工位|办公室|学校|教室/;
const OUT_WORDS = /超市|街|路上|外面|出去|出门|散步|便利店|公园|买|逛/;

/** 现在睡没睡，以及计划几点醒。 */
export function sleepOf(input: {
  current: SlotView | null;
  now: number;
  settings: LifeSettings;
  sleepText: string | null;
}): { sleeping: boolean; text: string; wakeAt: string | null } {
  const { current, now, settings, sleepText } = input;
  const sleeping = current?.actual?.trim() ? current.actualSleeping ?? false : current?.sleeping;
  if (typeof sleeping === 'boolean' && current) {
    return sleeping
      ? { sleeping: true, text: `睡眠中 · 计划 ${current.end} 醒来`, wakeAt: current.end }
      : { sleeping: false, text: sleepText?.trim() || '睡眠平稳', wakeAt: null };
  }
  const hour = localHour(now, settings.timezone);
  if (inHourWindow(hour, settings.sleepStartHour, settings.sleepEndHour)) {
    return {
      sleeping: true,
      text: `睡眠中 · 计划 ${String(settings.sleepEndHour).padStart(2, '0')}:00 醒来`,
      wakeAt: `${String(settings.sleepEndHour).padStart(2, '0')}:00`,
    };
  }
  return { sleeping: false, text: sleepText?.trim() || '睡眠平稳', wakeAt: null };
}

/** 她在哪：对话覆盖 > 这一段写明的地点 > 活动词推断 > 家里。 */
export function locationOf(input: {
  current: SlotView | null;
  override: { name: string; at: number } | null;
  now: number;
  homeName: string;
}): { name: string; source: 'slot' | 'override' | 'default' } {
  const { current, override, now, homeName } = input;
  if (override && now - override.at < 4 * 3_600_000) {
    return { name: override.name, source: 'override' };
  }
  const text = current?.actual?.trim() || current?.activity || '';
  if (current?.location) return { name: current.location, source: 'slot' };
  if (WORK_WORDS.test(text)) return { name: '公司', source: 'slot' };
  if (OUT_WORDS.test(text)) return { name: '外面', source: 'slot' };
  if (HOME_WORDS.test(text)) return { name: homeName, source: 'slot' };
  return { name: homeName, source: 'default' };
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

const FILE = 'life-state.json';

function defaults(day: string, now: number): LifeStateData {
  return {
    version: 1,
    day,
    refreshedAt: now,
    plan: null,
    weather: null,
    locationOverride: null,
    hunger: '无饥饿感',
    dream: '没有记住梦',
    outfit: null,
    cycleAnchor: null,
  };
}

function dayDistance(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

function normalize(raw: unknown, day: string, now: number): LifeStateData {
  const base = defaults(day, now);
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<LifeStateData>;
  const out: LifeStateData = {
    ...base,
    hunger: typeof value.hunger === 'string' && value.hunger.trim() ? value.hunger.trim().slice(0, 256) : base.hunger,
    dream: typeof value.dream === 'string' && value.dream.trim() ? value.dream.trim().slice(0, 256) : base.dream,
    outfit: typeof value.outfit === 'string' && value.outfit.trim() ? value.outfit.trim().slice(0, 256) : null,
    cycleAnchor: typeof value.cycleAnchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.cycleAnchor) ? value.cycleAnchor : null,
    refreshedAt: typeof value.refreshedAt === 'number' ? value.refreshedAt : now,
    weather: isWeather(value.weather) ? value.weather : null,
    locationOverride: isOverride(value.locationOverride) ? value.locationOverride : null,
    plan: isPlan(value.plan) ? value.plan : null,
    ...(isActualActivity(value.actualActivity) ? { actualActivity: value.actualActivity } : {}),
    ...(value.previousPlan && typeof value.previousPlan.day === 'string' && isPlan(value.previousPlan.plan)
      && dayDistance(value.previousPlan.day, day) === 1 ? { previousPlan: value.previousPlan } : {}),
  };
  if (value.day !== day) {
    if (typeof value.day === 'string' && dayDistance(value.day, day) === 1 && out.plan) {
      out.previousPlan = { day: value.day, plan: out.plan };
    }
    out.day = day;
    out.plan = null;
    out.outfit = null;
  }
  return out;
}

function isActualActivity(value: unknown): value is NonNullable<LifeStateData['actualActivity']> {
  if (!value || typeof value !== 'object') return false;
  const activity = value as Partial<NonNullable<LifeStateData['actualActivity']>>;
  return typeof activity.activity === 'string' && activity.activity.trim().length > 0
    && (activity.location === null || typeof activity.location === 'string')
    && typeof activity.sleeping === 'boolean'
    && typeof activity.startedAt === 'number' && Number.isFinite(activity.startedAt)
    && typeof activity.endsAt === 'number' && Number.isFinite(activity.endsAt)
    && activity.endsAt > activity.startedAt;
}

function isWeather(value: unknown): value is LifeWeather {
  const w = value as LifeWeather | null;
  return !!w && typeof w.text === 'string' && typeof w.fetchedAt === 'number';
}

function isOverride(value: unknown): value is LifeStateData['locationOverride'] {
  const o = value as LifeStateData['locationOverride'];
  return !!o && typeof o.name === 'string' && typeof o.at === 'number';
}

function isPlan(value: unknown): value is LifeStateData['plan'] {
  const p = value as LifeStateData['plan'];
  return !!p && Array.isArray(p.slots) && typeof p.generatedAt === 'number' && (p.source === 'dream' || p.source === 'fallback');
}

export class LifeStateStore {
  readonly file: string | null;
  private data: LifeStateData;

  constructor(
    dataDir: string | null,
    private readonly settings: () => LifeSettings,
    private readonly now: () => number = Date.now,
  ) {
    this.file = dataDir ? join(dataDir, FILE) : null;
    this.data = this.load();
  }

  get current(): LifeStateData {
    return this.data;
  }

  /** 换天滚动；返回是否发生了换天。 */
  tick(): boolean {
    const now = this.now();
    const day = dayKey(now, this.settings().timezone);
    if (this.data.day === day) return false;
    this.data.previousPlan = dayDistance(this.data.day, day) === 1 && this.data.plan
      ? { day: this.data.day, plan: this.data.plan } : undefined;
    this.data.day = day;
    this.data.plan = null;
    this.data.outfit = null;
    this.save();
    return true;
  }

  /** 保证今天有日程：梦写过就用梦的，没写过就铺一份临时排程。 */
  ensurePlan(): void {
    this.tick();
    // 梦定过就算数，哪怕她写的是"今天不排"——空计划是她自己的选择，不是缺数据。
    if (this.data.plan) return;
    const slots = defaultPlan(this.settings(), this.data.day);
    this.data.plan = { slots, generatedAt: this.now(), source: 'fallback' };
    this.save();
  }

  setPlan(slots: AgendaSlot[], source: 'dream' | 'fallback' = 'dream'): { ok: boolean; result: string } {
    const clean = slots
      .map((slot) => ({
        time: slot.time,
        end: slot.end,
        activity: String(slot.activity ?? '').trim().slice(0, 120),
        mood: slot.mood ? String(slot.mood).trim().slice(0, 40) : null,
        messageSeed: slot.messageSeed ? String(slot.messageSeed).trim().slice(0, 200) : null,
        location: slot.location ? String(slot.location).trim().slice(0, 40) : null,
        actual: null,
        ...(typeof slot.sleeping === 'boolean' ? { sleeping: slot.sleeping } : {}),
      }))
      .filter((slot) => minuteOf(String(slot.time ?? '')) !== null && minuteOf(String(slot.end ?? '')) !== null && slot.activity);
    // 空数组是"今天不想安排"，不是坏输入：她要能有一天走一步算一步。
    if (!clean.length && !slots.length) {
      this.tick();
      this.data.plan = { slots: [], generatedAt: this.now(), source };
      this.save();
      return { ok: true, result: '今天不排了' };
    }
    if (!clean.length) return { ok: false, result: '没有可用的时间段：每段都要有 time、end、activity' };
    this.tick();
    this.data.plan = { slots: clean, generatedAt: this.now(), source };
    this.save();
    return { ok: true, result: `已写入 ${clean.length} 个时间段` };
  }

  private agendaAt(now: number): {
    plan: LifeStateData['plan']; view: SlotView[]; nowMin: number; offset: number;
  } {
    const settings = this.settings();
    const day = dayKey(now, settings.timezone);
    const nowMin = localHourMinutes(now, settings.timezone);
    const plan = this.data.day === day ? this.data.plan
      : this.data.previousPlan?.day === day ? this.data.previousPlan.plan : null;
    const view = viewOfSlots(plan?.slots ?? [], nowMin);
    if (plan?.source === 'dream' && currentOf(view)) return { plan, view, nowMin, offset: 0 };
    const candidates = [
      ...(this.data.plan ? [{ day: this.data.day, plan: this.data.plan }] : []),
      ...(this.data.previousPlan ? [this.data.previousPlan] : []),
    ];
    for (const previous of candidates) {
      if (dayDistance(previous.day, day) !== 1) continue;
      const carried = viewOfSlots(previous.plan.slots, nowMin + 1440);
      if (currentOf(carried)) return { plan: previous.plan, view: carried, nowMin: nowMin + 1440, offset: 1440 };
    }
    return { plan, view, nowMin, offset: 0 };
  }

  private actualAt(now: number): SlotView | null {
    const actual = this.data.actualActivity;
    if (!actual || now < actual.startedAt || now >= actual.endsAt) return null;
    const timezone = this.settings().timezone;
    const day = dayKey(now, timezone);
    const startMin = dayDistance(day, dayKey(actual.startedAt, timezone)) * 1440 + localHourMinutes(actual.startedAt, timezone);
    const endMin = dayDistance(day, dayKey(actual.endsAt, timezone)) * 1440 + localHourMinutes(actual.endsAt, timezone);
    return {
      time: formatMinute(startMin), end: formatMinute(endMin),
      activity: actual.activity, actual: actual.activity,
      sleeping: actual.sleeping, actualSleeping: actual.sleeping,
      location: actual.location, mood: null, messageSeed: null,
      state: 'active', startMin, endMin,
    };
  }

  private untilAt(until: string, now: number): number {
    const timezone = this.settings().timezone;
    const minutes = minuteOf(until);
    if (minutes === null) return NaN;
    let wall = Date.parse(`${dayKey(now, timezone)}T00:00:00Z`) + minutes * 60_000;
    let end = parseTimeIn(timezone, new Date(wall).toISOString().slice(0, 19));
    if (end <= now) {
      wall += 86_400_000;
      end = parseTimeIn(timezone, new Date(wall).toISOString().slice(0, 19));
    }
    return end;
  }

  sleepingAt(now: number): boolean {
    const agenda = this.agendaAt(now);
    return sleepOf({ current: this.actualAt(now) ?? currentOf(agenda.view), now, settings: this.settings(), sleepText: null }).sleeping;
  }

  /** 相对时长独立到期；绝对 until 可延长当前日程段；不重新给期限的更新保留原起止时间。 */
  advance(doing: string, until?: string, location?: string, sleeping = false, durationMinutes?: number): { ok: boolean; result: string } {
    const previous = structuredClone(this.data);
    try {
      return this.applyAdvance(doing, until, location, sleeping, durationMinutes);
    } catch (error) {
      this.data = previous;
      throw error;
    }
  }

  private applyAdvance(doing: string, until?: string, location?: string, sleeping = false, durationMinutes?: number): { ok: boolean; result: string } {
    const now = this.now();
    if (until !== undefined && minuteOf(until) === null) return { ok: false, result: 'until 必须是有效的 HH:MM' };
    if (durationMinutes !== undefined && until !== undefined) return { ok: false, result: 'duration_minutes 与 until 不能同时填写' };
    if (durationMinutes !== undefined && (!Number.isFinite(durationMinutes) || durationMinutes <= 0)) {
      return { ok: false, result: 'duration_minutes 必须是有限正数' };
    }
    const relativeEnd = durationMinutes === undefined ? undefined : now + durationMinutes * 60_000;
    if (relativeEnd !== undefined && (!Number.isFinite(new Date(relativeEnd).getTime()) || relativeEnd <= now)) {
      return { ok: false, result: 'duration_minutes 超出有效时间范围' };
    }
    this.tick();
    const { plan, view, nowMin } = this.agendaAt(now);
    const idx = view.findIndex((slot) => slot.state === 'active');
    if (durationMinutes !== undefined || this.actualAt(now) || !plan || idx < 0) {
      const existing = this.actualAt(now) ? this.data.actualActivity : undefined;
      if (until === undefined && relativeEnd === undefined && !existing) return { ok: false, result: '现在是日程空档，请提供 duration_minutes 或 until 明确实际活动的结束时间；无需重排日程' };
      const endsAt = relativeEnd ?? (until !== undefined ? this.untilAt(until, now) : existing!.endsAt);
      if (!Number.isFinite(endsAt) || endsAt <= now) return { ok: false, result: '活动结束时间必须晚于当前时刻' };
      this.data.actualActivity = {
        activity: doing.trim().slice(0, 120),
        location: location?.trim().slice(0, 40) || existing?.location || null,
        sleeping,
        startedAt: until === undefined && durationMinutes === undefined && existing ? existing.startedAt : now,
        endsAt,
      };
      this.data.locationOverride = null;
      this.save();
      const span = durationMinutes === undefined ? '' : `${durationMinutes} 分钟，`;
      return { ok: true, result: `${this.data.actualActivity.activity}（实际活动 ${span}至 ${nowIso(this.settings().timezone, new Date(endsAt))}，原日程不变）` };
    }
    this.data.actualActivity = undefined;

    const slot = plan.slots[idx]!;
    slot.actual = doing.trim().slice(0, 120);
    slot.actualSleeping = sleeping;
    slot.location = location?.trim().slice(0, 40) || null;
    slot.messageSeed = null;
    this.data.locationOverride = null;

    let moved = 0;
    const rawEnd = until ? minuteOf(until) : null;
    const currentEnd = view[idx].endMin;
    let endMin = rawEnd === null ? null : rawEnd + Math.floor(nowMin / 1440) * 1440;
    if (endMin !== null && endMin <= nowMin) endMin += 1440;
    if (endMin !== null && endMin > currentEnd) {
      const delta = endMin - currentEnd;
      slot.end = formatMinute(endMin);
      const kept: AgendaSlot[] = [];
      plan.slots.forEach((item, i) => {
        if (i <= idx) { kept.push(item); return; }
        const start = view[i].startMin;
        const end = view[i].endMin;
        if (start + delta >= (Math.floor(start / 1440) + 1) * 1440) return;
        kept.push({ ...item, time: formatMinute(start + delta), end: formatMinute(end + delta) });
      });
      plan.slots = kept;
      moved = delta;
    }

    this.save();
    return {
      ok: true,
      result: moved > 0
        ? `${slot.actual}（到 ${slot.end}，后面顺延 ${moved} 分钟）`
        : slot.actual,
    };
  }

  setWeather(weather: LifeWeather | null): void {
    this.data.weather = weather;
    this.data.refreshedAt = this.now();
    this.save();
  }

  setLocation(name: string, at = this.now()): void {
    const value = name.trim();
    this.data.locationOverride = value ? { name: value.slice(0, 40), at } : null;
    this.save();
  }

  patch(patch: { hunger?: string | null; dream?: string | null; outfit?: string | null; cycleAnchor?: string | null }): {
    ok: boolean;
    applied: string[];
    rejected: string[];
  } {
    const applied: string[] = [];
    const rejected: string[] = [];
    if (patch.hunger !== undefined) {
      if (patch.hunger === null) {
        this.data.hunger = defaults(this.data.day, this.now()).hunger;
        applied.push('hunger');
      } else {
        const value = String(patch.hunger).trim();
        if (value) {
          this.data.hunger = value.slice(0, 256);
          applied.push('hunger');
        } else rejected.push('hunger');
      }
    }
    if (patch.dream !== undefined) {
      if (patch.dream === null) {
        this.data.dream = defaults(this.data.day, this.now()).dream;
        applied.push('dream');
      } else {
        const value = String(patch.dream).trim();
        if (value) {
          this.data.dream = value.slice(0, 256);
          applied.push('dream');
        } else rejected.push('dream');
      }
    }
    if (patch.outfit !== undefined) {
      if (patch.outfit === null) {
        this.data.outfit = null;
        applied.push('outfit');
      } else {
        const value = String(patch.outfit).trim();
        this.data.outfit = value ? value.slice(0, 256) : null;
        applied.push('outfit');
      }
    }
    if (patch.cycleAnchor !== undefined) {
      if (patch.cycleAnchor === null) {
        this.data.cycleAnchor = null;
        applied.push('cycleAnchor');
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(patch.cycleAnchor))) {
        this.data.cycleAnchor = String(patch.cycleAnchor);
        applied.push('cycleAnchor');
      } else rejected.push('cycleAnchor');
    }
    if (applied.length) this.save();
    return { ok: applied.length > 0, applied, rejected };
  }

  /** 面板与注入共用的一份投影。 */
  snapshot(extra: { energy: number; mood: string; health: string | null; sleepText: string | null }): LifeSnapshot {
    const settings = this.settings();
    const now = this.now();
    this.tick();
    const day = this.data.day;
    const agenda = this.agendaAt(now);
    const view = agenda.view.filter((slot) => slot.endMin > agenda.offset)
      .map((slot) => ({ ...slot, startMin: slot.startMin - agenda.offset, endMin: slot.endMin - agenda.offset }));
    const actual = this.actualAt(now);
    const current = actual ?? currentOf(view);
    const next = actual
      ? view.find((slot) => slot.state === 'planned' && slot.startMin >= actual.endMin) ?? null
      : nextOf(view, current);
    const location = locationOf({ current, override: this.data.locationOverride, now, homeName: settings.homeName });
    const sleep = sleepOf({ current, now, settings, sleepText: extra.sleepText });
    const cycle = cycleAt(this.data.cycleAnchor ?? settings.cycleAnchor, day, settings.cycleEnabled);
    const cycleEnergy = cycle ? cycle.phase.energyDelta : 0;
    return {
      date: day,
      refreshedAt: this.data.refreshedAt,
      weather: this.data.weather?.text ?? '暂无天气信息',
      location: location.name,
      locationSource: location.source,
      mood: extra.mood,
      agendaCount: view.length,
      planSource: agenda.plan?.source ?? 'none',
      slots: view,
      current,
      next,
      sleep,
      cycle,
      body: cycleText(cycle),
      health: extra.health?.trim() || '状态正常',
      hunger: this.data.hunger,
      dream: this.data.dream,
      outfit: this.data.outfit ?? '',
      energy: Math.max(5, Math.min(100, Math.round(extra.energy + cycleEnergy))),
    };
  }

  private load(): LifeStateData {
    const now = this.now();
    const day = dayKey(now, this.settings().timezone);
    if (!this.file || !existsSync(this.file)) return defaults(day, now);
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return normalize(raw, day, now);
    } catch {
      return defaults(day, now);
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}

/** 本地时区下的"今天第几分钟"。用 Intl 取，半小时时区也不会偏。 */
export function localHourMinutes(now: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(now));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

// ---------------------------------------------------------------------------
// 注进上下文的那一段
// ---------------------------------------------------------------------------

/**
 * 「你今天的日子」。
 *
 * 和 RoleState 的状态块分开：那个说"你现在什么语气"，这个说"你今天在过什么日子"。
 * 明写别主动播报，否则她会把日程当台词念。
 */
/** 一句话里的一段：压平空白，太长就截。 */
function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 当前活动 → 能当公开状态用的短标签：取第一个分句，最多 8 字。 */
export function shortActivity(text: string, max = 8): string {
  const first = text.split(/[：:，,。；;]/)[0]?.trim() ?? '';
  const flat = (first || text).replace(/\s+/g, '');
  return flat.length > max ? flat.slice(0, max) : flat;
}

const PERIODS: Array<{ until: number; label: string }> = [
  { until: 5 * 60, label: '凌晨' },
  { until: 9 * 60, label: '早上' },
  { until: 12 * 60, label: '上午' },
  { until: 14 * 60, label: '中午' },
  { until: 18 * 60, label: '下午' },
  { until: 23 * 60, label: '晚上' },
  { until: 24 * 60, label: '深夜' },
];

export function periodOf(startMin: number): string {
  const minute = ((startMin % 1440) + 1440) % 1440;
  return PERIODS.find((p) => minute < p.until)?.label ?? '深夜';
}

/**
 * 「你今天的日子」。
 *
 * 和 RoleState 的状态块分开：那个说"你现在什么语气"，这个说"你今天在过什么日子"。
 *
 * **整条时间线都给她**，不只当前这一段：被问"下午在干嘛"时，只给"现在"等于没给，
 * 她只能回去翻旧账、把上一轮说过的话再说一遍。规则也写明：被问就按时间线答，
 * 不要拿状态块里的「手头」代替——那是最容易过时的一处。
 */
export function lifeBlock(snapshot: LifeSnapshot): string {
  const bits: string[] = [];
  if (snapshot.weather !== '暂无天气信息') bits.push(snapshot.weather);
  bits.push(snapshot.location);
  bits.push(`日程 ${snapshot.agendaCount} 段`);
  if (snapshot.cycle) bits.push(`${snapshot.cycle.phase.name}第${snapshot.cycle.dayInPhase}天`);
  bits.push(snapshot.sleep.text);
  if (snapshot.hunger && snapshot.hunger !== '无饥饿感') bits.push(snapshot.hunger);

  const lines: string[] = [];
  const seedOf = (slot: SlotView, max: number): string =>
    slot.messageSeed ? `（${clipText(slot.messageSeed, max)}）` : '';
  // 被打断过的那段：说实际在做什么，计划缩成一句括注。
  const whatOf = (slot: SlotView, max: number): string => (slot.actual && slot.plannedActivity
    ? `${clipText(slot.actual, max)}〔原：${clipText(slot.plannedActivity, 12)}〕`
    : clipText(slot.activity, max));
  if (snapshot.slots.length) {
    const groups = new Map<string, string[]>();
    for (const slot of snapshot.slots) {
      const period = periodOf(slot.startMin);
      const item = `${slot.time}–${slot.end} ${whatOf(slot, 22)}${seedOf(slot, 14)}`;
      const list = groups.get(period) ?? [];
      list.push(item);
      groups.set(period, list);
    }
    for (const [period, items] of groups) lines.push(`${period}：${items.join('；')}`);
    // 松散的一天：只排了几个点，其余是空白，别让她以为那段时间也在做排好的事。
    if (snapshot.slots.length <= 5) lines.push('（其余时间没安排，走到哪算哪。）');
  } else {
    lines.push('今天没排，走到哪儿算哪儿。');
  }
  const current = snapshot.current;
  if (current) lines.push(`现在：${current.time}–${current.end} ${whatOf(current, 40)}${seedOf(current, 24)}`);
  else if (snapshot.next) lines.push(`接下来：${snapshot.next.time} ${clipText(snapshot.next.activity, 40)}`);

  return [
    '[你今天的日子]（有人问你今天、下午或刚才在做什么，就按这条时间线回答；不要拿「手头」的旧状态代替，也别把上一轮说过的话再说一遍。没人问就别主动播报。'
    + '这是今天的默认走向，不是规矩：被人叫住、有事情插进来，就照实际改（`advance_life`）。'
    + '睡到一半被喊醒也一样——先按真实反应接住，再决定是起来还是接着睡，别拿日程把人挡回去。）',
    `${snapshot.date}；${bits.join('；')}。`,
    ...lines,
  ].join('\n');
}
