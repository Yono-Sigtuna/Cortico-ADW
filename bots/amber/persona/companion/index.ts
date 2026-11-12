/**
 * 陪伴层：她自己的时间、没说完的话，和"要不要主动开口"。
 *
 * 这一层不生成文字，也不发送。它只做一件事：在合适的时刻，把一条内部事件放进总线，
 * 让她在自己完整的人格与记忆里决定说不说。发送仍然只走 qq_draft，
 * 没有第二条投递路径。
 */
import { buildOpportunityText } from './prompt.ts';
import { explain, inspect, planOnce, type ScheduleInput } from './scheduler.ts';
import {
  CompanionStore, ONE_SIDED_MIN, ONE_SIDED_RESET_MS, duePending, localHour, type CompanionSettings,
} from './state.ts';
import type { RoomView } from '../roomView.ts';
import type { ShareOffer } from '../creative/models.ts';

export interface CompanionOptions {
  dataDir: string | null;
  timezone: string;
  /** 热配置：每次都现读。 */
  settings: () => CompanionSettings;
  /** 把主动时刻推进总线；由 Persona 接到 core.wakeInternal。 */
  emit: (text: string, meta: Record<string, unknown>) => Promise<void>;
  /** 当前精力 0–1，由角色状态提供：累的时候不主动找话说。 */
  energy: () => number;
  /** 记忆检索：话题机会用它判断"她懂不懂"。不给就没有话题机会。 */
  recall?: (query: string, k: number) => Array<{ text: string; eventTime: string; kind: string }>;
  /** 她对这个人的看法（`people/` 的「我的看法」）。 */
  viewsOf?: (qq: string) => string[];
  /** 某个会话最近的消息：群里没叫到她的消息不会进投递批次，得由 World 给。 */
  recentOf?: (conv: string) => Array<{ at: number; from: string; text: string }>;
  /** 某个会话此刻的形状；`lullMinutes` 现算，不能拿旧快照判断"现在能不能插话"。 */
  roomOf?: (conv: string) => RoomView | null;
  /** QQ 号 → `名字(号)`，没有档案时只给号。 */
  nameOf: (qq: string) => string;
  /** 内感受：社交电量与负荷（0–1），由事件流算出来。 */
  intero?: () => { socialBattery: number; load: number };
  /** 关系约束：这个人此刻不该被主动找时，返回原因。 */
  relationBlock?: (qq: string) => string | null;
  /** 她手上待分享的作品片段；没有就 null。 */
  creativeOffer?: () => ShareOffer | null;
  /** 分享机会给出去了：那一节点不再给第二次。 */
  onCreativeShared?: (offer: ShareOffer) => void;
  /** 她走的时候留的那句话；半小时到一天半之内、还没提过的才算数。 */
  threadNote?: () => { id: string; text: string; at: number } | null;
  /** 话头当作由头给出去了：标记一下，不重复提。 */
  onThreadOffered?: (id: string) => void;
  log?: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void };
  now?: () => number;
  /** 多久评估一次机会。默认 5 分钟；这是"看一眼状态"，不是定时发消息。 */
  intervalMs?: number;
}

interface Pending {
  opportunityId: string;
  conv: string;
  at: number;
}

export class Companion {
  private readonly store: CompanionStore;
  private readonly opts: CompanionOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Pending | null = null;

  constructor(opts: CompanionOptions) {
    this.opts = opts;
    this.store = new CompanionStore(
      opts.dataDir,
      opts.timezone,
      opts.now ?? (() => Date.now()),
      ...(opts.log ? [opts.log] : []),
    );
  }

  start(): void {
    if (this.timer) return;
    const every = Math.max(60_000, this.opts.intervalMs ?? 5 * 60_000);
    this.timer = setInterval(() => {
      void this.evaluate().catch((err) => this.opts.log?.warn('主动评估失败', { err: String(err) }));
    }, every);
    // 不因为一个后台评估就让进程退不出去。
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store.save();
  }

  /** 有人说话：记录，并关掉这个会话里未接的话头。 */
  noteUserMessage(
    conv: string,
    subject: string,
    text: string,
    opts: { at?: number; addressed?: boolean } = {},
  ): void {
    const at = opts.at ?? this.now();
    const state = this.store.conv(conv);
    state.lastUserAt = at;
    state.lastUserKey = subject || state.lastUserKey;
    state.lastUserText = text.slice(0, 200);
    if (opts.addressed) state.lastAddressedAt = at;
    // 最近一小段对话：判断"群里是不是真在聊一件事"要用，只留 20 条。
    state.recent = [...state.recent, { at, from: subject, text: text.replace(/\s+/g, ' ').slice(0, 200) }].slice(-20);
    // 对方开口了，就不再"接上次那句"——那是催。
    if (state.openLoop && at > state.openLoop.at) state.openLoop = null;
    // 她还没决定说不说，对方先来了：这次机会作废。
    if (this.pending && this.pending.conv === conv) this.pending = null;
    this.store.save();
  }

  /**
   * 她自己说了一句。
   *
   * 说了问题就留一个"未完话头"；说了陈述就没有话头；主动开口则留一个"没回音"。
   */
  noteBotMessage(
    conv: string,
    text: string,
    reply: boolean,
    opts: { at?: number; answered?: boolean } = {},
  ): void {
    const at = opts.at ?? this.now();
    const state = this.store.conv(conv);
    // 隔了半天的对话不算同一条线：单边计数从头算，不然昨天攒的账会算到今天头上。
    const gap = state.lastBotAt === null ? 0 : at - state.lastBotAt;
    state.lastBotAt = at;
    state.lastBotText = text.slice(0, 200);
    state.lastBotWasReply = reply;
    const asked = isQuestion(text);
    if (!reply) {
      state.openLoop = { at, text, kind: 'proactive', subject: state.lastUserKey ?? '', followed: false };
    } else if (asked) {
      state.openLoop = { at, text, kind: 'question', subject: state.lastUserKey ?? '', followed: false };
    } else {
      state.openLoop = null;
    }
    // 单边只看"别人开口、她接了一句、句尾没问回去"；她自己起头的不算。
    if (!opts.answered || asked) {
      state.oneSided = 0;
      state.oneSidedNudgedAt = 0;
    } else {
      state.oneSided = gap > ONE_SIDED_RESET_MS ? 1 : state.oneSided + 1;
    }
    this.store.save();
  }

  /**
   * 这一线连着几轮只答不问；够数就返回这个数字，否则 0。
   *
   * 同一个数字只提一次：提醒过还在涨，就等下一个台阶（3 → 6 → 9），
   * 不然每一轮都会来一句「你没把话头递回去」，那比不提醒更烦。
   */
  oneSidedDue(conv: string): number {
    const state = this.store.conv(conv);
    const n = state.oneSided;
    if (n < ONE_SIDED_MIN || n % ONE_SIDED_MIN !== 0) return 0;
    // 中间断了半天以上，这条线已经不是"正在聊"的那一场了，旧账不提。
    if (state.lastBotAt !== null && this.now() - state.lastBotAt > ONE_SIDED_RESET_MS) return 0;
    if (state.oneSidedNudgedAt === n) return 0;
    state.oneSidedNudgedAt = n;
    this.store.save();
    return n;
  }

  /** 这一轮结束：她到底说没说。没说也不追问——机会用过就退役。 */
  settle(sent: boolean): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    if (sent) this.store.noteProactive(pending.conv, this.now());
    this.store.save();
    this.opts.log?.info('主动时刻收口', { conv: pending.conv, sent });
  }

  /** 看一眼现在有没有机会；有就推一条内部事件。 */
  async evaluate(at = this.now()): Promise<boolean> {
    const settings = this.opts.settings();
    if (!settings.enabled) return false;
    if (this.pending) return false;

    this.store.tick();
    const energy = Math.max(0, Math.min(1, this.opts.energy()));
    const planned = planOnce(this.scheduleInput(at, energy));
    if (!planned) return false;
    // 话头是一次性的：给出去就标记，免得同一句被反复当由头。
    if (planned.threadId) this.opts.onThreadOffered?.(planned.threadId);

    const conv = planned.conv;
    const state = this.store.conv(conv);
    // 未完话头只尝试一次：说过了就不再纠缠，这也是"不催"的一部分。
    if (state.openLoop) state.openLoop.followed = true;
    state.lastAttemptAt = at;
    this.store.save();

    const subject = planned.selection.opportunity.subject ?? state.lastUserKey ?? conv.split(':')[1] ?? '';
    const lastTalk = Math.max(state.lastUserAt ?? 0, state.lastBotAt ?? 0);
    const text = buildOpportunityText({
      now: at,
      timezone: this.opts.timezone,
      selection: planned.selection,
      conv,
      subjectName: this.opts.nameOf(subject),
      gapMinutes: lastTalk > 0 ? Math.round((at - lastTalk) / 60_000) : null,
      energy,
      proactiveToday: this.store.current.proactiveToday,
    });

    this.pending = { opportunityId: planned.selection.opportunity.id, conv, at };
    try {
      await this.opts.emit(text, {
        companion: true,
        opportunity: planned.selection.opportunity.id,
        kind: planned.selection.opportunity.kind,
        conv,
        subject,
        hour: localHour(at, this.opts.timezone),
      });
    } catch (err) {
      this.pending = null;
      this.opts.log?.warn('主动事件投递失败', { err: String(err) });
      return false;
    }
    // 话题机会按"给过几次"计，不按"说没说"——否则她每次沉默，下一分钟又能再接一次。
    if (planned.selection.opportunity.kind.startsWith('topic')) this.store.noteTopic();
    // 同一个作品节点也只给一次：反复把同一段递上去，等的是夸奖。
    if (planned.creative) this.opts.onCreativeShared?.(planned.creative);
    this.opts.log?.info('主动时刻', {
      conv,
      kind: planned.selection.opportunity.kind,
      energy: Number(energy.toFixed(2)),
      today: this.store.current.proactiveToday,
    });
    return true;
  }

  /** 面板与排障用。 */
  /** 他还等他兑现的那件事：记在会话里，不写进关系档案。`subject` = 欠的是谁。 */
  notePending(conv: string, text: string, subject = ''): boolean {
    return this.store.notePending(conv, text, this.now(), subject) !== null;
  }

  closePending(conv: string, fragment: string): boolean {
    return this.store.closePending(conv, fragment);
  }

  /** 兑现按人销：在群里欠的，到私聊里兑现也算。 */
  closePendingFor(subject: string, fragment: string): boolean {
    return this.store.closeFor(subject, fragment);
  }

  /** 销账时带上会话和承诺时间；梦的履约奖励要用它去找可核对的事件。 */
  closePendingForDetail(subject: string, fragment: string): { closed: boolean; conv?: string; at?: number } {
    return this.store.closeForDetail(subject, fragment);
  }

  /** 这一轮该带出来一次的那件；没有就 null。 */
  duePending(conv: string) {
    return duePending(this.store.conv(conv), this.now());
  }

  /** 他这一轮该被带出来一次的那件：跨会话找，当前会话优先。 */
  duePendingFor(subject: string, currentConv = '') {
    return this.store.dueFor(subject, currentConv);
  }

  notePendingReferred(conv: string, id: string): void {
    this.store.notePendingReferred(conv, id);
  }

  snapshot(): {
    enabled: boolean;
    energy: number;
    proactiveToday: number;
    topicToday: number;
    convs: Array<{ conv: string; lastUserKey: string | null; lastUserAt: number | null; lastBotAt: number | null; lastBotText: string | null; openLoop: string | null; followed: boolean; lastAttemptAt: number | null }>;
  } {
    const state = this.store.current;
    return {
      enabled: this.opts.settings().enabled,
      energy: Number(this.opts.energy().toFixed(2)),
      proactiveToday: state.proactiveToday,
      topicToday: state.topicToday,
      convs: Object.entries(state.convs).map(([conv, c]) => ({
        conv,
        lastUserKey: c.lastUserKey,
        lastUserAt: c.lastUserAt,
        lastBotAt: c.lastBotAt,
        lastBotText: c.lastBotText ?? null,
        openLoop: c.openLoop?.text ?? null,
        followed: c.openLoop?.followed ?? false,
        lastAttemptAt: c.lastAttemptAt,
      })),
    };
  }

  /** 面板用：现在为什么不说，或者说的是什么。只读，不消耗机会。 */
  diagnose(at = this.now()): { ok: boolean; reason: string } {
    this.store.tick();
    return explain(this.scheduleInput(at));
  }

  /** 面板用：此刻有哪些候选、各自从哪来。只读，不消耗机会。 */
  inspect(at = this.now()): ReturnType<typeof inspect> {
    this.store.tick();
    return inspect(this.scheduleInput(at));
  }

  /** 排期的只读输入；diagnose 与 inspect 共用一份，免得两处判断悄悄分叉。 */
  private scheduleInput(at: number, energy?: number): ScheduleInput {
    const intero = this.opts.intero?.();
    return {
      now: at,
      timezone: this.opts.timezone,
      settings: this.opts.settings(),
      state: this.store.current,
      energy: energy ?? Math.max(0, Math.min(1, this.opts.energy())),
      ...(this.opts.recall ? { recall: this.opts.recall } : {}),
      ...(this.opts.viewsOf ? { viewsOf: this.opts.viewsOf } : {}),
      ...(this.opts.recentOf ? { recentOf: this.opts.recentOf } : {}),
      ...(this.opts.roomOf ? { roomOf: this.opts.roomOf } : {}),
      ...(this.opts.creativeOffer ? { creativeOffer: this.opts.creativeOffer } : {}),
      ...(this.opts.threadNote ? { threadNote: this.opts.threadNote } : {}),
      ...(intero ? { socialBattery: intero.socialBattery, load: intero.load } : {}),
      ...(this.opts.relationBlock ? { relationBlock: this.opts.relationBlock } : {}),
      nameOf: this.opts.nameOf,
    };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}

/** 一句话里有问题，才值得等一个回答。 */
/**
 * 这一批值不值得催她"把话头递回去"。
 *
 * 房间里不止一个人在说、又没点到她，那场本来就不是她的——这时提醒她递话头，
 * 只会把她推进别人的对谈。一对一（窗口内只有一个人说）才算数。
 */
export function oneSidedWorthNudging(speakers: number | null): boolean {
  return speakers === null || speakers <= 1;
}

export function isQuestion(text: string): boolean {
  const flat = text.trim();
  return /[?？]\s*$/.test(flat) || /(吗|呢|么)[。！!？?]?\s*$/.test(flat);
}
