/**
 * 她自己此刻的状态。
 *
 * 来自 AstrBot「我会永远陪着你」的 role.state：精力、心情五轴、睡眠、忙碌、健康、
 * 公开状态、在线态、临时状况。关键不在字段多，而在三条纪律：
 *
 * 1. **只影响语气浓度**，不决定回不回、不播报数值；
 * 2. **模拟不是事实**：时间经过不证明她吃过饭、睡着过、出过门；
 * 3. **不把别人的状态搬到她身上**，也不把她的状态当成对用户的诊断。
 *
 * 值的作者是梦（一个后台模型任务），这里是存储、规则漂移与渲染。
 * 两次梦之间按规则回落：心情向基线衰减，精力按昼夜增减。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { interoLine } from './intero.ts';

export type MoodIntensity = 'mild' | 'moderate' | 'strong' | null;
export type OnlineMode = 'online' | 'away' | 'busy' | 'invisible' | null;

export interface Mood {
  /** 1–10；静息水平。 */
  baseline: number;
  joy: number;
  anger: number;
  sorrow: number;
  fear: number;
  intensity: MoodIntensity;
  /** 带生活肌理的第一人称心境，例如「心里踏实，有点挂念」。 */
  description: string;
}

export interface Condition {
  kind: 'hunger' | 'health' | 'sleep' | 'busy' | 'mood' | 'other';
  text: string;
  /** 写下这条的时刻；说不清年纪的状况不能信。 */
  since: number;
  /** 复核时点，不是康复时刻；null 表示没有明确到期。 */
  expiresAt: string | null;
}

export interface RoleState {
  version: 1;
  updatedAt: number;
  /** 0–100 主观精力。 */
  energy: number;
  mood: Mood;
  sleep: string | null;
  busy: string | null;
  health: string | null;
  /** 公开 QQ 短状态，≤8 字。 */
  presence: string | null;
  onlineMode: OnlineMode;
  conditions: Condition[];
  /** 上一轮为什么变成这样（给梦与排障看）。 */
  basis: string;
}

const MOOD_AXES = ['joy', 'anger', 'sorrow', 'fear'] as const;
const MOOD_MIN = 1;
const MOOD_MAX = 10;
/** 心情向基线回落：半衰期 180 分钟。一次夸奖不该让她整天亢奋。 */
const MOOD_HALF_LIFE_MIN = 180;
const TEXT_MAX = 256;
const PRESENCE_MAX = 8;

const HOUR = 3_600_000;
/**
 * 临时状况最多活多久。
 *
 * `expiresAt: null` 的意思是"我说不清什么时候结束"，不是"永远成立"。昨晚写的
 * 「眼睛发涩，灯已经调暗」如果一直有效，第二天上午十点她还在被提醒自己困着——
 * 于是整场对话她都在劝人睡觉。类别不同，自然的寿命也不同。
 */
const CONDITION_TTL: Record<Condition['kind'], number> = {
  sleep: 8 * HOUR,
  hunger: 4 * HOUR,
  mood: 6 * HOUR,
  busy: 8 * HOUR,
  health: 24 * HOUR,
  other: 24 * HOUR,
};
/** 状态块里最多出现的状况条数；再多就只是噪音。 */
const CONDITION_LINES = 3;

export function defaultState(now: number): RoleState {
  return {
    version: 1,
    updatedAt: now,
    energy: 62,
    mood: { baseline: 5, joy: 5, anger: 3, sorrow: 3, fear: 2, intensity: null, description: '' },
    sleep: null,
    busy: null,
    health: null,
    presence: null,
    onlineMode: 'online',
    conditions: [],
    basis: '',
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const int = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(Math.round(n), lo, hi) : fallback;
};
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const flat = v.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, max) : null;
};

export class RoleStateStore {
  private readonly file: string | null;
  private readonly log: { warn(msg: string, data?: unknown): void } | null;
  private state: RoleState;
  private readonly now: () => number;

  constructor(dataDir: string | null, now: () => number, log?: { warn(msg: string, data?: unknown): void }) {
    this.file = dataDir ? join(dataDir, 'role-state.json') : null;
    this.now = now;
    this.log = log ?? null;
    this.state = this.load();
    // 第一次运行时把默认状态落盘：否则要等下一次梦才看得到这个文件。
    if (this.file && !existsSync(this.file)) this.save();
  }

  get current(): RoleState {
    return this.state;
  }

  /** 只读一份副本，避免调用方改到内部状态。 */
  snapshot(): RoleState {
    return JSON.parse(JSON.stringify(this.state)) as RoleState;
  }

  /**
   * 两次维护之间的规则漂移。
   *
   * 心情向基线衰减（半衰期 180 分钟）；精力按昼夜增减，睡着回、醒着掉。
   * 这不是"她真的休息了"，只是让数值不至于冻结在上一次梦的瞬间。
   */
  drift(hoursAsleep: (date: Date) => boolean, now = this.now()): void {
    const minutes = Math.max(0, (now - this.state.updatedAt) / 60_000);
    if (minutes < 5) return;
    const asleep = hoursAsleep(new Date(now));
    const factor = Math.pow(0.5, minutes / MOOD_HALF_LIFE_MIN);
    for (const axis of MOOD_AXES) {
      const value = this.state.mood[axis];
      // 五轴是 1–10 的整数（模型协议如此），漂移也落成整数，免得读了又舍一次。
      this.state.mood[axis] = clamp(
        Math.round(this.state.mood.baseline + (value - this.state.mood.baseline) * factor),
        MOOD_MIN,
        MOOD_MAX,
      );
    }
    const perHour = asleep ? 5 : -1.5;
    this.state.energy = clamp(Math.round(this.state.energy + (perHour * minutes) / 60), 5, 100);
    this.state.updatedAt = now;
    // 过期的临时状况在复核时才清；这里只把已经到点的标出来。
    this.save();
  }

  /**
   * 梦维护状态：合并一个补丁。
   *
   * 类型不对的字段直接丢掉并记在回执里——模型偶尔会写「很累」而不是 30，
   * 那不该让整次维护失败，也不该被硬塞进数字字段。
   */
  patch(input: Record<string, unknown>): { ok: boolean; applied: string[]; rejected: string[] } {
    const applied: string[] = [];
    const rejected: string[] = [];
    const now = this.now();

    if (input.energy !== undefined) {
      const n = Number(input.energy);
      if (Number.isFinite(n)) {
        this.state.energy = clamp(Math.round(n), 0, 100);
        applied.push('energy');
      } else rejected.push('energy 不是数字');
    }

    const mood = input.mood;
    if (mood && typeof mood === 'object') {
      const m = mood as Record<string, unknown>;
      const next = { ...this.state.mood };
      for (const axis of ['baseline', ...MOOD_AXES] as const) {
        if (m[axis] === undefined) continue;
        const n = Number(m[axis]);
        if (!Number.isFinite(n)) { rejected.push(`mood.${axis}`); continue; }
        next[axis] = clamp(Math.round(n), MOOD_MIN, MOOD_MAX);
        applied.push(`mood.${axis}`);
      }
      if (m.intensity !== undefined) {
        const v = m.intensity;
        if (v === null || v === 'mild' || v === 'moderate' || v === 'strong') {
          next.intensity = v;
          applied.push('mood.intensity');
        } else rejected.push('mood.intensity');
      }
      if (m.description !== undefined) {
        const d = text(m.description, TEXT_MAX);
        next.description = d ?? '';
        applied.push('mood.description');
      }
      this.state.mood = next;
    }

    for (const key of ['sleep', 'busy', 'health', 'presence'] as const) {
      if (input[key] === undefined) continue;
      const max = key === 'presence' ? PRESENCE_MAX : TEXT_MAX;
      this.state[key] = text(input[key], max);
      applied.push(key);
    }

    if (input.onlineMode !== undefined) {
      const v = input.onlineMode;
      if (v === null || v === 'online' || v === 'away' || v === 'busy' || v === 'invisible') {
        this.state.onlineMode = v;
        applied.push('onlineMode');
      } else rejected.push('onlineMode');
    }

    if (Array.isArray(input.conditions)) {
      const out: Condition[] = [];
      for (const raw of input.conditions.slice(0, 16)) {
        if (!raw || typeof raw !== 'object') continue;
        const c = raw as Record<string, unknown>;
        const kind = c.kind;
        if (kind !== 'hunger' && kind !== 'health' && kind !== 'sleep' && kind !== 'busy'
          && kind !== 'mood' && kind !== 'other') continue;
        const body = text(c.text, 512);
        if (!body) continue;
        const expires = typeof c.expiresAt === 'string' && !Number.isNaN(Date.parse(c.expiresAt))
          ? new Date(c.expiresAt).toISOString()
          : null;
        out.push({ kind, text: body, since: now, expiresAt: expires });
      }
      this.state.conditions = out;
      applied.push('conditions');
    }

    const basis = text(input.basis, TEXT_MAX);
    if (basis) {
      this.state.basis = basis;
      // basis 也是一次真实改动：只写它时不该回执"没有可用的字段"。
      applied.push('basis');
    }
    this.state.updatedAt = now;
    this.save();
    return { ok: applied.length > 0, applied, rejected };
  }

  /** 给主意识看的一段话：只写她现在是什么状态，不写数值之外的解释。 */
  block(intero?: { socialBattery: number; load: number }, opts?: { busy?: string | null; presence?: string | null }): string {
    const s = this.state;
    const bits: string[] = [`精力 ${Math.round(s.energy)}/100`];
    const mood = moodPhrase(s.mood);
    if (mood) bits.push(mood);
    if (s.sleep) bits.push(s.sleep);
    if (s.health) bits.push(s.health);
    const now = this.now();
    const active = s.conditions.filter((c) => (
      now - c.since < CONDITION_TTL[c.kind] && (!c.expiresAt || Date.parse(c.expiresAt) > now)
    ));
    // 同一类只留最新一条。昨晚的状态块里并排塞着「有些困意，准备睡了」
    // 「眼睛微涩，灯已调暗」「眼睛发涩，灯已经调暗」——她被同一个事实提醒了三次。
    const newest = new Map<Condition['kind'], Condition>();
    for (const c of active) {
      const prev = newest.get(c.kind);
      if (!prev || c.since >= prev.since) newest.set(c.kind, c);
    }
    const picked = [...newest.values()].sort((a, b) => b.since - a.since).slice(0, CONDITION_LINES);
    for (const c of picked) bits.push(c.text);
    // 「你在干嘛」是常被问到的一句：没有具体在忙的事就如实说，不要从对话里编一个。
    // 有日程时以日程的当前段为准——梦写的 busy 可能停在几小时前。
    const busy = opts?.busy !== undefined ? opts.busy : s.busy;
    const doing = busy ? `手头：${busy}` : '此刻没在做什么具体的事。';
    const tail: string[] = [doing];
    // 公开状态也以日程为准：梦写的那句可能几小时没变，每轮重复注入会把她带回去。
    const presence = opts?.presence !== undefined ? opts.presence : s.presence;
    if (presence) tail.push(`公开状态：${presence}`);
    if (s.onlineMode && s.onlineMode !== 'online') tail.push(`在线态：${s.onlineMode}`);
    // 内感受不是梦写的，是事件流算出来的；只在低电量或高负荷时出现。
    if (intero) {
      const line = interoLine(intero);
      if (line) tail.push(line);
    }
    return [
      '[你自己此刻的状态]（只影响语气和浓度；有人问你「在做什么」就按「手头」那一行说，问你怎么了才说精力心情；平时不要主动播报数值）',
      bits.join('；') + '。',
      tail.join('；'),
      '状态是你自己的模拟感受，不是对别人的观察，也不是诊断；时间经过不等于你做过什么。',
    ].join('\n');
  }

  save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      this.log?.warn('角色状态写入失败', { error: String(err) });
    }
  }

  private load(): RoleState {
    const fallback = defaultState(this.now());
    if (!this.file || !existsSync(this.file)) return fallback;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RoleState>;
      if (raw.version !== 1) return fallback;
      const moodRaw = (raw.mood ?? {}) as Partial<Mood>;
      return {
        version: 1,
        updatedAt: Number(raw.updatedAt ?? this.now()),
        energy: int(raw.energy, 0, 100, fallback.energy),
        mood: {
          baseline: int(moodRaw.baseline, MOOD_MIN, MOOD_MAX, 5),
          joy: int(moodRaw.joy, MOOD_MIN, MOOD_MAX, 5),
          anger: int(moodRaw.anger, MOOD_MIN, MOOD_MAX, 3),
          sorrow: int(moodRaw.sorrow, MOOD_MIN, MOOD_MAX, 3),
          fear: int(moodRaw.fear, MOOD_MIN, MOOD_MAX, 2),
          intensity: moodRaw.intensity ?? null,
          description: typeof moodRaw.description === 'string' ? moodRaw.description : '',
        },
        sleep: typeof raw.sleep === 'string' ? raw.sleep : null,
        busy: typeof raw.busy === 'string' ? raw.busy : null,
        health: typeof raw.health === 'string' ? raw.health : null,
        presence: typeof raw.presence === 'string' ? raw.presence : null,
        onlineMode: raw.onlineMode ?? 'online',
        conditions: Array.isArray(raw.conditions)
          ? (raw.conditions as unknown[]).flatMap((item): Condition[] => {
            const c = item as Partial<Condition> | null;
            if (!c || typeof c.text !== 'string' || !c.kind) return [];
            if (!(c.kind in CONDITION_TTL)) return [];
            // 没有写入时刻的旧条目说不清年纪，留着就会一直成立——宁可这一轮先不显示。
            if (typeof c.since !== 'number' || !Number.isFinite(c.since)) return [];
            return [{ kind: c.kind, text: c.text, since: c.since, expiresAt: c.expiresAt ?? null }];
          })
          : [],
        basis: typeof raw.basis === 'string' ? raw.basis : '',
      };
    } catch (err) {
      this.log?.warn('角色状态读取失败，按默认值继续', { error: String(err) });
      return fallback;
    }
  }
}

/** 把五轴压成一句人话：只在明显偏离基线时说出来。 */
function moodPhrase(mood: Mood): string {
  if (mood.description.trim()) return mood.description.trim();
  const parts: string[] = [];
  const band = (v: number) => (v >= 7 ? 'high' : v <= 3 ? 'low' : 'mid');
  if (band(mood.joy) === 'high') parts.push('心情不错');
  if (band(mood.joy) === 'low') parts.push('没什么兴致');
  if (band(mood.sorrow) === 'high') parts.push('有点低落');
  if (band(mood.anger) === 'high') parts.push('有点烦躁');
  if (band(mood.fear) === 'high') parts.push('心里不踏实');
  if (parts.length === 0) return '';
  if (mood.intensity === 'strong') return parts.join('，') + '，情绪比较重';
  if (mood.intensity === 'mild') return parts.join('，') + '，但不算强烈';
  return parts.join('，');
}
