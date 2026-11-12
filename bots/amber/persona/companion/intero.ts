/**
 * 内感受：从事件里长出来的两个慢变量。
 *
 * `RoleState` 的精力是梦写的、心情是梦写的——那是"她怎么描述自己"。
 * 这一层不靠梦，只靠事件流的物理属性：说了多少、被同一个人刷了多少遍、
 * 隔了多久。于是"累"不再是一句可以随手改写的话，而是一条能算出轨迹的数。
 *
 * 两个量：
 * - 社交电量 socialBattery（0–1）：有人来找就掉一点，复读掉得更多，说话也花电；
 *   说出去的话十五分钟内有人接，回一点；安静下来按 90 分钟半衰期回。
 * - 负荷 load（0–1）：短时间堆进来的消息把它抬高，按 30 分钟半衰期回落。
 *
 * 规则是确定性的、可复盘：同一批事件永远得到同一条轨迹。不做"AI 判断我现在累不累"。
 * "有没有劲"也走同一条纪律：只看**有没有人接话**，不看话题好不好——话题要模型来判，
 * 那样电量就又变成可以哄出来的东西，这一层就白建了。
 *
 * 一次回复的耗电（0.006）刻意压得比一条来找她的话还低：这一天说了七十多句时，
 * 0.02 一句会把整条电量说穿，她会在夜里被压成只会点头的人——而说话本来是她要做的事。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventEnvelope } from 'cortico/core/types.ts';

export interface InteroState {
  version: 1;
  updatedAt: number;
  socialBattery: number;
  load: number;
  /** 她上一次真正说出去的时刻；过了窗口还没人接，这一句算白说的。 */
  lastSentAt: number | null;
}

export interface InteroSnapshot {
  socialBattery: number;
  load: number;
  updatedAt: number;
}

export interface InteroGates {
  /** 低于这个电量，她不主动开口。 */
  lowBattery: number;
  /** 高于这个负荷，她也不主动开口。 */
  highLoad: number;
}

export const INTERO_DEFAULTS: InteroGates = { lowBattery: 0.3, highLoad: 0.85 };

const START_SOCIAL = 0.75;
const START_LOAD = 0.2;
/** 社交电量回满的半衰期。 */
const SOCIAL_HALF_LIFE_MIN = 90;
/** 一句回复花多少电。说一天七十句也只掉四成，不至于把人说到开不了口。 */
const REPLY_DRAIN = 0.006;
/** 她说完之后这么久内有人接着聊，算这段话还在往前走。 */
const ENGAGED_WINDOW_MIN = 15;
/**
 * 被接住一次回多少电。
 *
 * 必须小于一条消息的耗电，否则聊得越热闹电量越满，"累"就重新变成可以刷出来的东西。
 * 它抵的是"这段对话还在往前"这件事——说出去的话有人接，比一个人对着空气说省力得多。
 */
const ENGAGED_GAIN = 0.01;
/**
 * 说出去的话过了窗口还没人接，再扣多少。
 *
 * 和一句回复等量：一条没人接的话，代价是一句普通回复的两倍。被无视比说话本身更耗人。
 */
const IGNORED_PENALTY = 0.006;
/** 负荷回落的半衰期。 */
const LOAD_HALF_LIFE_MIN = 30;
/** 同一个人同一句话在这么久内重复，算"刷屏"。 */
const REPEAT_WINDOW_MIN = 10;
const REPEAT_KEEP = 80;

interface RepeatEntry {
  at: number;
  sender: string;
  hash: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 消息正文：去掉 `#id [群…] 名字(号):` 前缀，只留说的那句。 */
function bodyOf(text: string): string {
  const idx = text.lastIndexOf(': ');
  return idx >= 0 ? text.slice(idx + 2) : text;
}

/** 复读判定用的归一化。 */
export function normalizeRepeat(text: string): string {
  return bodyOf(text)
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

/**
 * 把内感受翻译成一句她看得懂的话——只在值得说的时候返回。
 * 不报数字给"用户"，这是给她自己的状态说明。
 */
export function interoLine(snapshot: Pick<InteroSnapshot, 'socialBattery' | 'load'>): string | null {
  const social = Math.round(snapshot.socialBattery * 100);
  const load = Math.round(snapshot.load * 100);
  if (social < 25) return `社交电量很低（${social}%）：这会儿不想主动找话说，别人来找你也可以答得短一点。`;
  if (social < 45) return `社交电量偏低（${social}%）：说话会更省，别硬撑着热闹。`;
  if (load > 85) return `手头负荷 ${load}%：有点满，容易走神，先别接新话题。`;
  return null;
}

export interface ReplyBudgetSettings {
  /** 低于这条线就短回、不追问、慢半拍。 */
  replyBattery: number;
  /** 电量跌到 0 时最多慢多少秒。 */
  hesitationSeconds: number;
}

export interface ReplyBudget {
  short: boolean;
  delayMs: number;
}

/**
 * 电量低时的回复预算。
 *
 * 延迟是按比例缩放的：刚好压线不延迟，跌到 0 才到最大秒数。
 * 这不是"惩罚"，是"累的时候反应慢一点、话说得省一点"。
 */
export function replyBudget(
  snapshot: Pick<InteroSnapshot, 'socialBattery'>,
  settings: ReplyBudgetSettings,
): ReplyBudget {
  const gate = settings.replyBattery;
  if (!(gate > 0) || snapshot.socialBattery >= gate) return { short: false, delayMs: 0 };
  const ratio = Math.max(0, Math.min(1, 1 - snapshot.socialBattery / gate));
  const seconds = Math.max(0, settings.hesitationSeconds);
  return { short: true, delayMs: Math.round(seconds * 1000 * ratio) };
}

/** 给这一轮的一句预算说明；电量正常时不出现。 */
export function replyBudgetLine(
  snapshot: Pick<InteroSnapshot, 'socialBattery'>,
  settings: ReplyBudgetSettings,
): string | null {
  if (!replyBudget(snapshot, settings).short) return null;
  const pct = Math.round(snapshot.socialBattery * 100);
  // 给的是「怎么说」，不是「不许做什么」——低电量在热闹的群里会常常发生，
  // 一串「不要反问、不要追问、不要开新话题」会把她变成只会点头的人。
  return `[本轮预算] 电量偏低（${pct}%）：句子比平时短一点，一句能说完就一句；想接就接一句，不想接可以不说。`;
}

/**
 * 这条事件算不算"在接她刚才说的话"。
 *
 * 只认行为：她说完不久、对方是接着那句来的（thread / name / mention）。
 * 关系账本和电量账本共用这一条判断，免得两处各写一个窗口。
 */
export function isEngaged(
  event: EventEnvelope,
  lastSentAt: number | null,
  now: number,
): boolean {
  if (lastSentAt === null || now - lastSentAt > ENGAGED_WINDOW_MIN * 60_000) return false;
  const wake = String((event.meta as { wake?: unknown } | undefined)?.wake ?? '');
  return wake === 'thread' || wake === 'name' || wake === 'mention';
}

export class InteroStore {
  readonly file: string | null;
  private state: InteroState;
  private recent: RepeatEntry[] = [];

  constructor(dataDir: string | null, private readonly now: () => number = Date.now) {
    this.file = dataDir ? join(dataDir, 'intero.json') : null;
    this.state = this.load();
  }

  get current(): InteroState {
    return this.state;
  }

  /** 时间经过：电量回、负荷落；说出去的话到点没人接，扣一笔。读的时候顺手算，不需要定时器。 */
  tick(): InteroSnapshot {
    const now = this.now();
    const minutes = Math.max(0, (now - this.state.updatedAt) / 60_000);
    if (minutes >= 1) {
      const social = this.state.socialBattery
        + (1 - this.state.socialBattery) * (1 - Math.pow(0.5, minutes / SOCIAL_HALF_LIFE_MIN));
      const load = this.state.load * Math.pow(0.5, minutes / LOAD_HALF_LIFE_MIN);
      this.state.socialBattery = clamp(social, 0.02, 1);
      this.state.load = clamp(load, 0, 1);
      this.state.updatedAt = now;
      this.save();
    }
    // 那句说出去的话，窗口过了还没人接：算白说。扣一次就清标记，不会反复扣。
    if (this.state.lastSentAt !== null && now - this.state.lastSentAt > ENGAGED_WINDOW_MIN * 60_000) {
      this.state.socialBattery = clamp(this.state.socialBattery - IGNORED_PENALTY, 0.02, 1);
      this.state.lastSentAt = null;
      this.state.updatedAt = now;
      this.save();
    }
    return this.snapshot();
  }

  snapshot(): InteroSnapshot {
    return {
      socialBattery: this.state.socialBattery,
      load: this.state.load,
      updatedAt: this.state.updatedAt,
    };
  }

  /**
   * 一批投递里她实际看到的事件。
   *
   * 只数外部的人说的话：`qq.message`。群里的环境摘要、图片附件、她自己发的
   * 都不算——那些不是"又一个人来找她"。
   */
  observe(events: readonly EventEnvelope[]): InteroSnapshot {
    this.tick();
    const now = this.now();
    let changed = false;
    for (const event of events) {
      if (event.origin !== 'external' || event.type !== 'qq.message') continue;
      const sender = event.senderKey ?? '';
      const text = event.text ?? '';
      const hash = normalizeRepeat(text);
      const repeats = this.recent.filter((entry) => (
        entry.at >= now - REPEAT_WINDOW_MIN * 60_000 && entry.sender === sender && entry.hash === hash
      )).length;
      // 耗多少看「这条是不是冲她来的」，而不是「群里一共有多少条」：
      // 远处再热闹也只是耗神，不该和当面被找同价。按条数算的话，群越吵她越哑，
      // 这在她自己的群里是常态，不是疲劳。
      const wake = String((event.meta as { wake?: unknown } | undefined)?.wake ?? '');
      // 她刚说完、这会儿有人接着聊：这段话在往前走，回一点电。
      // 只看"有没有人接"，不看"话题好不好"——话题要模型来判，那样电量就又能被说动。
      if (isEngaged(event, this.state.lastSentAt, now)) {
        this.state.socialBattery += ENGAGED_GAIN;
        this.state.lastSentAt = null;
        changed = true;
      }
      const drain = wake === 'mention' || wake === 'name' ? 0.02 : wake === 'thread' ? 0.008 : 0.002;
      this.state.socialBattery -= drain + Math.min(repeats, 2) * 0.05;
      this.state.load += 0.006 + Math.min(repeats, 2) * 0.03 + (bodyOf(text).length > 160 ? 0.004 : 0);
      this.remember({ at: now, sender, hash });
      changed = true;
    }
    if (!changed) return this.snapshot();
    this.state.socialBattery = clamp(this.state.socialBattery, 0.02, 1);
    this.state.load = clamp(this.state.load, 0, 1);
    this.state.updatedAt = now;
    this.save();
    return this.snapshot();
  }

  /** 一轮结束：她真的开口了，说话本身也花电。 */
  noteTurn(input: { sent: boolean }): InteroSnapshot {
    this.tick();
    if (input.sent) {
      const now = this.now();
      this.state.socialBattery = clamp(this.state.socialBattery - REPLY_DRAIN, 0.02, 1);
      this.state.load = clamp(this.state.load + 0.004, 0, 1);
      this.state.updatedAt = now;
      this.state.lastSentAt = now;
      this.save();
    }
    return this.snapshot();
  }

  /** 测试与面板用：直接看两个数，不推进时间。 */
  values(): { socialBattery: number; load: number } {
    return { socialBattery: this.state.socialBattery, load: this.state.load };
  }

  private remember(entry: RepeatEntry): void {
    this.recent.push(entry);
    if (this.recent.length > REPEAT_KEEP) this.recent.splice(0, this.recent.length - REPEAT_KEEP);
  }

  private load(): InteroState {
    const now = this.now();
    if (!this.file || !existsSync(this.file)) return this.fresh(now);
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<InteroState>;
      return {
        version: 1,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
        socialBattery: clamp(Number(raw.socialBattery ?? START_SOCIAL), 0.02, 1),
        load: clamp(Number(raw.load ?? START_LOAD), 0, 1),
        // 旧文件没有这一项：按"没说出去过"读，不补一笔滞后的惩罚。
        lastSentAt: typeof raw.lastSentAt === 'number' ? raw.lastSentAt : null,
      };
    } catch {
      return this.fresh(now);
    }
  }

  private fresh(now: number): InteroState {
    return { version: 1, updatedAt: now, socialBattery: START_SOCIAL, load: START_LOAD, lastSentAt: null };
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch { /* 存不下去不拖累投递 */ }
  }
}
