/**
 * 关系约束：不是"我对这个人的看法"，而是"我现在能怎么对他"。
 *
 * `people/` 里的「我的看法」是散文，给语气用；这一层是机器可读的少量状态，
 * 只回答两个问题：
 *   1. 注入时要不要收紧（信任低、刚越界、还欠他一句话）；
 *   2. 主动开口时要不要跳过（刚越界的人，不该先去找他）。
 *
 * 更新只有两条路：事件流的确定性信号（越界言论会掉信任、抬边界），以及梦在
 * 整理时通过 `maintain_relation` 写的判断。两者写同一份状态，谁也不是装饰。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Relation {
  trust: number;
  /** 认识程度：聊过多少、认不认得。不设人均上限，但增长递减，逼近而不撞顶。 */
  familiarity: number;
  /**
   * 好感度：稀缺、慢、只在有分量的事上动。
   *
   * 和熟悉度不是一回事——聊得多叫熟，不叫喜欢。全场所有人的好感度加起来有上限，
   * 所以"同时跟好几个人都很亲"在这套账上不成立；想对一个人更近，别人就得淡下去。
   */
  affinity: number;
  /** 0 = 没有未修复的越界；越高越新。 */
  boundary: number;
  updatedAt: number;
  basis: string;
}

export interface RelationState {
  version: 3;
  people: Record<string, Relation>;
  /** 已经发过履约奖励的事件键：同一件事只加一次好感，梦不能自己刷。 */
  rewards?: Record<string, number>;
}

const FILE = 'relations.json';
const TRUST_BASE = 0.5;
const FAMILIARITY_BASE = 0.05;

/**
 * 她在一个群里能同时"在意"的总量。
 *
 * 2.5 大约是两三个人的份额：一个人到 0.9，剩下的人加起来就只能有一半多点。
 * 这是"只能维持几段高好感"的算式——不靠名单，靠守恒。
 */
export const AFFINITY_CAP = 2.5;
/**
 * 她说完、有人接住：一点点。
 *
 * 实测这个群每 15 分钟窗口里平均每天被接住 93 次。按 0.0003 算，满份额时一天涨
 * 0.028——**从零填满整个预算要约九十天**。之前写 0.006，四天就顶满，那不叫慢。
 */
export const AFFINITY_GAIN_ENGAGED = 0.0003;
/** 欠的话兑现了：一次约等于两天半的日常接话。有分量的事该有分量的价钱。 */
const AFFINITY_GAIN_DEBT = 0.05;
/** 好感度回落：150 天半衰期。三个月才近，也三个月才淡。 */
const AFFINITY_HALF_LIFE_DAYS = 150;
/**
 * 旧账本迁移时，`熟悉度 × 信任` 只折算这么多。
 *
 * 八天在"三个月才到最喜欢"的尺子上只走了一小段。之前按 1.0 折算，群主第一天就
 * 站在 0.877，总量直接占到上限的 89%——**成长在开局就结束了**。
 */
const AFFINITY_SEED_FACTOR = 0.15;
/** 越界言论：只在明确冲着人来的词上触发，不做泛情绪判断。 */
const INSULT = /(傻逼|脑残|废物|垃圾东西|去死|滚蛋|你他妈|狗东西|闭嘴)/;
const THREAT = /(弄死你|人肉你|曝光你|封了你|威胁你)/;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fresh(now: number): Relation {
  return {
    trust: TRUST_BASE,
    familiarity: FAMILIARITY_BASE,
    affinity: 0,
    boundary: 0,
    updatedAt: now,
    basis: '',
  };
}

/**
 * 旧文件没有好感度：用「认识程度 × 信任」当起点，把已经长出来的亲疏接过来。
 *
 * 不这么做的话，升级那一刻所有人都从零开始——群主和她认识了八天，账本上却和陌生人一样。
 * 之后它就自己长了，不再看这两个数。
 */
function normalizeRelation(raw: Partial<Relation>, legacy = false): Relation {
  const rel = {
    ...fresh(typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()),
    ...raw,
  } as Relation;
  // v2 的 debts 搬去了会话状态（`ConvState.pending`）；旧档案里那一项读到就丢掉。
  delete (rel as unknown as Record<string, unknown>).debts;
  if (typeof raw.affinity !== 'number' || !Number.isFinite(raw.affinity)) {
    rel.affinity = clamp((rel.familiarity ?? 0) * (rel.trust ?? TRUST_BASE) * AFFINITY_SEED_FACTOR, 0, 1);
  } else if (legacy) {
    // v1 已经用老公式播过种：按同一比例缩回去，而不是重播——重播会把这几小时长出来的也抹掉。
    rel.affinity = clamp(rel.affinity * AFFINITY_SEED_FACTOR, 0, 1);
  }
  return rel;
}

/** 全场好感度总和。所有增长都要先看这个数——它就是"她还能在意几个人"。 */
export function affinityMass(people: Iterable<Relation>): number {
  let sum = 0;
  for (const rel of people) sum += rel.affinity;
  return sum;
}

/**
 * 一次有分量的好事能涨多少。
 *
 * 乘剩余份额：总和越接近上限，每个人越难再涨。总量没满时一切正常；
 * 满的时候谁也不动，只有等谁淡下去才腾出位置。这不是惩罚，是有限。
 */
export function gainAffinity(current: number, amount: number, mass: number): number {
  const room = Math.max(0, 1 - mass / AFFINITY_CAP);
  return clamp(current + amount * room, 0, 1);
}

/** 时间经过：边界按 24 小时半衰期回落，熟悉度按 90 天回落到基线，好感度按 150 天散掉，信任慢慢回中。 */
export function decayRelation(rel: Relation, now: number): Relation {
  const minutes = Math.max(0, (now - rel.updatedAt) / 60_000);
  if (minutes < 1) return rel;
  const boundary = rel.boundary * Math.pow(0.5, minutes / (24 * 60));
  const familiarity = FAMILIARITY_BASE
    + (rel.familiarity - FAMILIARITY_BASE) * Math.pow(0.5, minutes / (90 * 24 * 60));
  const affinity = rel.affinity * Math.pow(0.5, minutes / (AFFINITY_HALF_LIFE_DAYS * 24 * 60));
  const trust = TRUST_BASE + (rel.trust - TRUST_BASE) * Math.pow(0.5, minutes / (30 * 24 * 60));
  return {
    ...rel,
    boundary: clamp(boundary, 0, 1),
    familiarity: clamp(familiarity, 0, 1),
    affinity: clamp(affinity, 0, 1),
    trust: clamp(trust, 0, 1),
    updatedAt: now,
  };
}

/**
 * 一条外部消息对关系的影响；没有明显信号时只涨一点熟悉度。
 *
 * `engaged` 表示这条是在接她刚才说的话（她说完不久、对方是接着那句来的）。
 * 只有这种时刻才动好感度——被人接住是"有分量的事"，而发消息本身不是。
 */
export function observeRelation(
  rel: Relation,
  text: string,
  now: number,
  opts: { engaged?: boolean; mass?: number } = {},
): { relation: Relation; changed: boolean } {
  const base = decayRelation(rel, now);
  // 认识程度逼近 1 而不是撞上 1：聊得多叫熟，但没有"熟透"这一说。
  const familiarity = clamp(base.familiarity + 0.01 * (1 - base.familiarity), 0, 1);
  const affinity = opts.engaged
    ? gainAffinity(base.affinity, AFFINITY_GAIN_ENGAGED, opts.mass ?? 0)
    : base.affinity;
  const hit = INSULT.exec(text) ?? THREAT.exec(text);
  if (!hit) {
    return { relation: { ...base, familiarity, affinity, updatedAt: now }, changed: true };
  }
  return {
    relation: {
      ...base,
      familiarity,
      affinity,
      trust: clamp(base.trust - 0.06, 0, 1),
      boundary: clamp(base.boundary + 0.4, 0, 1),
      updatedAt: now,
      basis: `越界言论：${hit[0]}`,
    },
    changed: true,
  };
}

/** 「6 小时前」这种相对说法：分钟数 → 人话。 */
export function humanGap(minutes: number): string {
  const mins = Math.max(0, Math.round(minutes));
  if (mins < 60) return `${mins} 分钟前`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)} 小时前`;
  const days = hours / 24;
  return `${Math.round(days)} 天前`;
}

/**
 * 注入给她的约束行；没有需要收紧的地方就返回空数组。
 *
 * 亲疏只看好感度：信任低就收紧，好感高才放宽，中间的人什么都不说——
 * "其他人都在平均分附近"的意思就是他们不带额外的行。
 */
export function relationLines(rel: Relation, now = Date.now()): string[] {
  const out: string[] = [];
  if (rel.boundary >= 0.25) {
    out.push('他刚越过界、还没修复：回答短一点，礼貌但不热络；不主动示好，不追问他自己的事。');
  }
  if (rel.trust < 0.3) {
    out.push('你对他还谈不上信任：不开玩笑、不说自己的私事、不答应没把握的事。');
  }
  if (rel.affinity >= 0.7) {
    out.push('他在你心里有分量：他的事你会先问一句，也愿意多说一点自己。可以省客套，但不抢白、不给脸色——熟不是许可。');
  } else if (rel.affinity >= 0.42) {
    out.push('你对他比对群里多数人更有耐心：他开口你会多接一句。');
  }
  return out;
}

/** 主动开口的门：他在这个名单里，就不先去找他。 */
export function relationBlock(rel: Relation): string | null {
  if (rel.boundary >= 0.6) return '刚越过界，先不主动找他';
  if (rel.trust < 0.2) return '还不太信得过他，先不主动';
  return null;
}

export class RelationStore {
  readonly file: string | null;
  private state: RelationState;

  constructor(dataDir: string | null, private readonly now: () => number = Date.now) {
    this.file = dataDir ? join(dataDir, FILE) : null;
    this.state = this.load();
  }

  /** 读出并顺手衰减；没有记录就按默认值建一条。 */
  get(qq: string): Relation {
    const key = String(qq);
    const existing = this.state.people[key];
    const relation = existing ? decayRelation(existing, this.now()) : fresh(this.now());
    if (relation !== existing) this.save();
    return relation;
  }

  /** 一条外部消息；只认 5–12 位 QQ 号。`engaged` 表示这句是在接她刚说的话。 */
  observe(qq: string, text: string, opts: { engaged?: boolean } = {}): Relation | null {
    const key = String(qq);
    if (!/^\d{5,12}$/.test(key)) return null;
    const before = this.state.people[key] ?? fresh(this.now());
    const { relation, changed } = observeRelation(before, text, this.now(), {
      ...(opts.engaged ? { engaged: true } : {}),
      mass: this.mass(),
    });
    if (!changed) return relation;
    this.state.people[key] = relation;
    this.save();
    return relation;
  }

  /** 全场好感度总和：增长的可用空间由它决定。 */
  mass(): number {
    return affinityMass(Object.values(this.state.people));
  }

  /** 上次听到他说话到现在多少分钟；没记录过就是 null。 */
  gapMinutes(qq: string): number | null {
    const existing = this.state.people[String(qq)];
    if (!existing) return null;
    return Math.max(0, (this.now() - existing.updatedAt) / 60_000);
  }

  /** 梦写的那只手：信任、熟悉度、边界、欠着的话。 */
  patch(
    qq: string,
    patch: { trust?: number; familiarity?: number; boundary?: number; basis?: string },
  ): { ok: boolean; applied: string[]; rejected: string[] } {
    const key = String(qq);
    if (!/^\d{5,12}$/.test(key)) return { ok: false, applied: [], rejected: ['qq'] };
    const now = this.now();
    const rel = this.state.people[key] ?? fresh(now);
    const applied: string[] = [];
    const rejected: string[] = [];
    const num = (value: unknown): number | null => (
      typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : null
    );
    if (patch.trust !== undefined) {
      const v = num(patch.trust);
      if (v === null) rejected.push('trust'); else { rel.trust = v; applied.push('trust'); }
    }
    if (patch.familiarity !== undefined) {
      const v = num(patch.familiarity);
      if (v === null) rejected.push('familiarity'); else { rel.familiarity = v; applied.push('familiarity'); }
    }
    if (patch.boundary !== undefined) {
      const v = num(patch.boundary);
      if (v === null) rejected.push('boundary'); else { rel.boundary = v; applied.push('boundary'); }
    }
    if (patch.basis !== undefined && String(patch.basis).trim()) {
      rel.basis = String(patch.basis).trim().slice(0, 256);
      applied.push('basis');
    }
    if (!applied.length) return { ok: false, applied, rejected };
    rel.updatedAt = now;
    this.state.people[key] = rel;
    this.save();
    return { ok: true, applied, rejected };
  }

  /** 他等的那件事兑现了：好感度涨一点——这是少数几件真正算数的事。 */
  /**
   * 一次可核对的履约奖励；同一个事件键只算一次。
   * 没有证据键时不奖励——销账归销账，好感度只认真实发生过的事。
   */
  rewardFulfilled(qq: string, key: string): boolean {
    const id = key.trim();
    if (!id) return false;
    const rewards = (this.state.rewards ??= {});
    if (rewards[id] !== undefined) return false;
    const q = String(qq);
    const rel = this.state.people[q] ?? fresh(this.now());
    rel.affinity = gainAffinity(rel.affinity, AFFINITY_GAIN_DEBT, this.mass());
    rel.updatedAt = this.now();
    this.state.people[q] = rel;
    rewards[id] = this.now();
    this.save();
    return true;
  }

  /** 面板用：有记录的人与当前值。 */
  all(): Array<{ qq: string; relation: Relation }> {
    return Object.entries(this.state.people).map(([qq, rel]) => ({
      qq,
      relation: decayRelation(rel, this.now()),
    }));
  }

  private load(): RelationState {
    if (!this.file || !existsSync(this.file)) return { version: 3, people: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
        version?: number;
        people?: Record<string, Partial<Relation>>;
        rewards?: Record<string, unknown>;
      };
      // v1 的好感度是按 1.0 折算播的种，把预算一次吃光；载入时统一缩回 0.15。
      const legacy = !(typeof raw.version === 'number' && raw.version >= 2);
      const people: Record<string, Relation> = {};
      for (const [qq, value] of Object.entries(raw.people ?? {})) {
        if (!value || typeof value !== 'object') continue;
        people[qq] = normalizeRelation(value, legacy);
      }
      const rewards: Record<string, number> = {};
      for (const [key, at] of Object.entries(raw.rewards ?? {})) {
        if (typeof at === 'number' && Number.isFinite(at)) rewards[key] = at;
      }
      return Object.keys(rewards).length ? { version: 3, people, rewards } : { version: 3, people };
    } catch {
      return { version: 3, people: {} };
    }
  }

  private save(): void {
    if (!this.file) return;
    this.prune();
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch { /* 存不下去不影响回复 */ }
  }

  /** 群里谁说话都会建一条记录；只留最近活跃的 500 个人，别让文件无限长。 */
  private prune(): void {
    const entries = Object.entries(this.state.people);
    if (entries.length > 500) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      this.state.people = Object.fromEntries(entries.slice(0, 500));
    }
    // 奖励键只用来防重复发钱；留最近的 500 条足够，旧事件早已不可能再被兑现一次。
    const rewards = Object.entries(this.state.rewards ?? {});
    if (rewards.length > 500) {
      rewards.sort((a, b) => b[1] - a[1]);
      this.state.rewards = Object.fromEntries(rewards.slice(0, 500));
    }
  }
}
