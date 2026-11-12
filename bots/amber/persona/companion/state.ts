/**
 * 陪伴层的状态：她此刻有没有精神、和谁的话还没说完、今天已经主动过几次。
 *
 * 全是**状态**，不是计时器：每一个判断都问"现在是什么情况"，
 * 而不是"过了几分钟"。落盘到 `data/companion.json`，重启接着算。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CompanionSettings {
  /** 关掉就什么都不做，连状态都不推进。 */
  enabled: boolean;
  /** 允许在私聊里主动。 */
  allowPrivate: boolean;
  /** 允许在监听中的群里主动（只会对着某一个人说，不做广播）。 */
  allowGroups: boolean;
  /** 允许接群里的正在聊的话题（需要先判断热度、她懂不懂、她有没有别的话）。 */
  participateGroups: boolean;
  /** 话题窗口：最近多少分钟内的发言才算"正在聊"。 */
  topicWindowMinutes: number;
  /** 每天最多接几次群话题：和"接自己的话头"分开计。 */
  topicDailyCap: number;
  /** 低水位兜底：距上次梦超过这么多小时就入一次；0 = 只在上下文满时入梦。 */
  dreamEveryHours: number;
  /** 全局每天最多主动几次。 */
  dailyCap: number;
  /** 她问过/说过一句、对方没回，多久之后可以自然接一句。 */
  followupMinutes: number;
  /** 两次尝试之间至少隔多久（同一会话）。 */
  followupCooldownMinutes: number;
  /** 不打扰时段（对方侧的安静时间）。 */
  quietStartHour: number;
  quietEndHour: number;
  /** 她自己睡觉的时段：睡着时不主动。 */
  sleepStartHour: number;
  sleepEndHour: number;
  /** 内感受的门：电量低于 lowBattery、负荷高于 highLoad 时不主动。省略 = 默认值。 */
  intero?: {
    enabled: boolean;
    lowBattery: number;
    highLoad: number;
    /** 电量低于它：短回、不追问、慢半拍。 */
    replyBattery?: number;
    /** 电量跌到 0 时最多慢多少秒。 */
    hesitationSeconds?: number;
  };
}

export interface OpenLoop {
  /** 这句话说出去的时刻。 */
  at: number;
  /** 她说的话，用来给模型看"你上次问的是…"。 */
  text: string;
  /** `question`：她问了问题；`proactive`：她主动说过一句。 */
  kind: 'question' | 'proactive';
  /** 对着谁说。 */
  subject: string;
  /** 已经为它主动过一次就不再纠缠。 */
  followed: boolean;
}

/** 群里最近说过话的人与内容，只留一小段给"要不要接一句"用。 */
export interface RecentMessage {
  at: number;
  /** QQ 号。 */
  from: string;
  text: string;
}

/**
 * 他还在等的一件事。
 *
 * 不是这个人的属性，是这一段对话里的悬空：他提起时带出来一次，她自己说到了就销，
 * 挂过期限就散。跟 openLoop 同一条命——同理，它不会在档案里积成山。
 */
export interface PendingNote {
  id: string;
  at: number;
  text: string;
  /**
   * 这是欠谁的（QQ 号）。
   *
   * 存在哪个会话只是记账位置：兑现和提醒都按人找，所以他在群里听到的承诺，
   * 到私聊里再开口也还在。省略 = 这一版之前的旧账，只在自己那个会话里认。
   */
  subject?: string;
  /** 已经在他眼前带出来过一次。 */
  referredAt?: number;
}

export interface ConvState {
  lastUserAt: number | null;
  lastUserKey: string | null;
  lastUserText: string;
  lastBotAt: number | null;
  lastBotText: string;
  /** 她上一句是不是在回别人（而不是主动开口）。 */
  lastBotWasReply: boolean;
  /** 上一次真正开口主动的时刻。 */
  lastProactiveAt: number | null;
  /** 上一次"给过她机会"的时刻，含她选择不说的那些。冷却看它，不看发没发。 */
  lastAttemptAt: number | null;
  /** 上一次有人明确叫到她的时刻：刚被叫到时不该再"自己插话"。 */
  lastAddressedAt: number | null;
  /** 最近一小段群聊（最多 20 条），给话题判断用。 */
  recent: RecentMessage[];
  openLoop: OpenLoop | null;
  /**
   * 连着几轮她只接话、没把话头递回去（没问回去、也没自己起头）。
   *
   * 不是要她每句都反问——是让"这场只剩他一个人推"这件事有个读数，
   * 攒够了才提一次。问了/自己起头了/隔了半天再聊，都从头算。
   */
  oneSided: number;
  /** 上一次为这条线提醒时的计数：同一个数字只提一次，涨到下一个台阶再说。 */
  oneSidedNudgedAt: number;
  /** 还等他兑现的事；最多留三条，多了就不是"一件没做完的事"，是待办清单。 */
  pending: PendingNote[];
}

export interface CompanionState {
  version: 1;
  /** 本地日期，用于每日上限滚动。 */
  day: string;
  proactiveToday: number;
  /** 今天已经"接群话题"过几次：这类机会和"接自己的话头"分开计。 */
  topicToday: number;
  lastProactiveAt: number | null;
  convs: Record<string, ConvState>;
}

export function emptyConv(): ConvState {
  return {
    lastUserAt: null,
    lastUserKey: null,
    lastUserText: '',
    lastBotAt: null,
    lastBotText: '',
    lastBotWasReply: true,
    lastProactiveAt: null,
    lastAttemptAt: null,
    lastAddressedAt: null,
    recent: [],
    openLoop: null,
    oneSided: 0,
    oneSidedNudgedAt: 0,
    pending: [],
  };
}

export function emptyState(now: number, day: string): CompanionState {
  return { version: 1, day, proactiveToday: 0, topicToday: 0, lastProactiveAt: null, convs: {} };
}

/** 本地日期键 `YYYY-MM-DD`。 */
export function dayKey(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 本地小时（0–23）。 */
export function localHour(now: number, timezone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false })
    .format(new Date(now))
    .replace(/\D/g, ''));
}

/** `[start, end)`，支持跨午夜（23 → 8）。 */
export function inHourWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** 待兑现的事能挂多久：两天还没兑现也没人再提，它就不是"他还在等"了。 */
export const PENDING_TTL_MS = 48 * 60 * 60_000;
/** 最多同时挂几件：再多就不是"一件没做完的事"，是待办清单。 */
const PENDING_MAX = 3;

/** 连着几轮只答不问就提一次。三轮回合够一个人把话都问完了，再不说就是单边。 */
export const ONE_SIDED_MIN = 3;
/** 中间隔了这么久，就不是同一场对话了，单边计数从头算。 */
export const ONE_SIDED_RESET_MS = 6 * 60 * 60_000;

const normPending = (s: string): string => s.replace(/[sp{P}p{S}]+/gu, '');

/** 两句话说的是不是同一件事：去标点后相同、互相包含，或字符重合够高。 */
export function overlaps(a: string, b: string): boolean {
  const x = normPending(a);
  const y = normPending(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const setB = new Set(y);
  let common = 0;
  for (const ch of new Set(x)) if (setB.has(ch)) common++;
  return common / Math.min(new Set(x).size, setB.size) >= 0.8;
}

/** 还等着的（没过期），最老的在前。 */
export function livePending(conv: ConvState, now: number): PendingNote[] {
  return conv.pending
    .filter((p) => now - p.at <= PENDING_TTL_MS)
    .sort((a, b) => a.at - b.at);
}

/**
 * 这一轮该带出来一次的那件：最老的、还没在他眼前带出来过的。
 *
 * 跟 openLoop 同一条命——提一次就够。每一轮都提醒，她就只剩下还债这一个动作。
 */
export function duePending(conv: ConvState, now: number): PendingNote | null {
  return livePending(conv, now).find((p) => p.referredAt === undefined) ?? null;
}

/**
 * 这个人该被带出来的那一件：先看当前会话，再看他还在别的哪几个会话里说过话。
 *
 * 债是欠人的，不是欠会话的。只按会话找，会让同群别人一开口就把不相干的账翻出来，
 * 也会让他换个地方说话时那件事永远沉底。
 */
export function duePendingFor(
  convs: Record<string, ConvState>,
  subject: string,
  now: number,
  currentConv = '',
): { conv: string; note: PendingNote } | null {
  if (!subject) return null;
  const order = [currentConv, ...Object.keys(convs).filter((key) => key !== currentConv)];
  for (const key of order) {
    const conv = convs[key];
    if (!conv) continue;
    const note = livePending(conv, now).find((p) => p.referredAt === undefined
      && (p.subject ? p.subject === subject : key === currentConv));
    if (note) return { conv: key, note };
  }
  return null;
}

export class CompanionStore {
  private readonly file: string | null;
  private readonly log: { warn(msg: string, data?: unknown): void } | null;
  private state: CompanionState;
  private readonly timezone: string;
  private now: () => number;

  constructor(dataDir: string | null, timezone: string, now: () => number, log?: { warn(msg: string, data?: unknown): void }) {
    this.file = dataDir ? join(dataDir, 'companion.json') : null;
    this.log = log ?? null;
    this.timezone = timezone;
    this.now = now;
    this.state = this.load();
  }

  get current(): CompanionState {
    return this.state;
  }

  conv(key: string): ConvState {
    const found = this.state.convs[key];
    if (found) return found;
    const created = emptyConv();
    this.state.convs[key] = created;
    return created;
  }

  /** 每天第一次用到时滚动：上限归零，精力从睡眠里恢复。 */
  tick(): CompanionState {
    const now = this.now();
    const day = dayKey(now, this.timezone);
    if (day !== this.state.day) {
      this.state.day = day;
      this.state.proactiveToday = 0;
      this.state.topicToday = 0;
    }
    return this.state;
  }

  /**
   * 给过她一次机会——无论最后说没说，冷却都从这里算起。
   * 冷却看"尝试"而不是"发出"：否则她每次选择沉默，下一分钟又会被问一遍。
   */
  noteAttempt(convKey: string, at: number): void {
    this.conv(convKey).lastAttemptAt = at;
    this.state.lastProactiveAt = this.state.lastProactiveAt ?? at;
    this.save();
  }

  /** 记下"他还在等的一件事"：同一件事只刷新那一条。 */
  notePending(convKey: string, text: string, at = this.now(), subject = ''): PendingNote | null {
    const body = text.trim().slice(0, 200);
    if (!body) return null;
    const conv = this.conv(convKey);
    // 同一件事的判定必须带主人：同群两个人欠了同一句话，各是各的账。
    const dup = conv.pending.find((p) => (p.subject ?? '') === subject && overlaps(p.text, body));
    if (dup) {
      dup.text = body;
      dup.at = at;
      delete dup.referredAt;
    } else {
      conv.pending.push({
        id: `${at}-${Math.random().toString(36).slice(2, 6)}`,
        at,
        text: body,
        ...(subject ? { subject } : {}),
      });
      conv.pending = conv.pending.slice(-PENDING_MAX);
    }
    this.save();
    return dup ?? conv.pending[conv.pending.length - 1] ?? null;
  }

  /** 这个人这一轮该被带出来一次的那件；跨会话找，当前会话优先。 */
  dueFor(subject: string, currentConv = ''): { conv: string; note: PendingNote } | null {
    return duePendingFor(this.state.convs, subject, this.now(), currentConv);
  }

  /** 兑现了：按人和片段销掉，不要求还在同一个会话里。 */
  closeFor(subject: string, fragment: string): boolean {
    return this.closeForDetail(subject, fragment).closed;
  }

  /**
   * 同 closeFor，但告诉调用方销的是哪个会话、最早那条承诺的时间。
   * 履约奖励要靠这两个信息去外部事件里找证据，不能只凭"销账成功"就加好感。
   */
  closeForDetail(subject: string, fragment: string): { closed: boolean; conv?: string; at?: number } {
    const needle = fragment.trim();
    if (!needle) return { closed: false };
    let hit: { conv: string; at: number } | null = null;
    for (const [conv, state] of Object.entries(this.state.convs)) {
      const removed = state.pending.filter((p) => {
        const sameOwner = (p.subject ?? '') === subject;
        // ID 只销自己名下的；旧账没有主人时，片段销账照旧。
        if (sameOwner && p.id === needle) return true;
        return (sameOwner || p.subject === undefined) && overlaps(p.text, needle);
      });
      if (!removed.length) continue;
      state.pending = state.pending.filter((p) => !removed.includes(p));
      if (!hit) hit = { conv, at: Math.min(...removed.map((p) => p.at)) };
    }
    if (!hit) return { closed: false };
    this.save();
    return { closed: true, conv: hit.conv, at: hit.at };
  }

  /** 兑现了：按片段销掉。 */
  closePending(convKey: string, fragment: string): boolean {
    const conv = this.conv(convKey);
    const needle = fragment.trim();
    if (!needle) return false;
    const before = conv.pending.length;
    // 没有主人参数的入口不能按 ID 去销有名有姓的账；旧账（无主）照旧。
    conv.pending = conv.pending.filter((p) => !(
      (p.subject === undefined && p.id === needle) || overlaps(p.text, needle)
    ));
    if (conv.pending.length === before) return false;
    this.save();
    return true;
  }

  /** 已经在他眼前带出来过一次：同一条不再重复占位。 */
  notePendingReferred(convKey: string, id: string, at = this.now()): void {
    const hit = this.conv(convKey).pending.find((p) => p.id === id);
    if (!hit || hit.referredAt !== undefined) return;
    hit.referredAt = at;
    this.save();
  }

  /** 她真的主动开口了：计入当天上限。 */
  noteProactive(convKey: string, at: number): void {
    this.state.proactiveToday += 1;
    this.state.lastProactiveAt = at;
    this.conv(convKey).lastProactiveAt = at;
    this.save();
  }

  /** 今天给过一次"接群话题"的机会（无论说没说）。 */
  noteTopic(): void {
    this.state.topicToday += 1;
    this.save();
  }

  save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      this.log?.warn('陪伴状态写入失败', { error: String(err) });
    }
  }

  private load(): CompanionState {
    const now = this.now();
    const fallback = emptyState(now, dayKey(now, this.timezone));
    if (!this.file || !existsSync(this.file)) return fallback;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CompanionState>;
      if (raw.version !== 1 || typeof raw.convs !== 'object' || !raw.convs) return fallback;
      return {
        version: 1,
        day: typeof raw.day === 'string' ? raw.day : fallback.day,
        proactiveToday: Number(raw.proactiveToday ?? 0) || 0,
        topicToday: Number(raw.topicToday ?? 0) || 0,
        lastProactiveAt: typeof raw.lastProactiveAt === 'number' ? raw.lastProactiveAt : null,
        convs: Object.fromEntries(
          Object.entries(raw.convs as Record<string, Partial<ConvState>>).map(([key, value]) => [key, {
            ...emptyConv(),
            ...value,
            lastAddressedAt: typeof value?.lastAddressedAt === 'number' ? value.lastAddressedAt : null,
            oneSided: Number.isFinite(Number(value?.oneSided)) ? Number(value.oneSided) : 0,
            oneSidedNudgedAt: Number.isFinite(Number(value?.oneSidedNudgedAt)) ? Number(value.oneSidedNudgedAt) : 0,
            recent: Array.isArray(value?.recent)
              ? value.recent
                  .filter((m) => m && typeof m.text === 'string' && typeof m.at === 'number')
                  .slice(-20)
                  .map((m) => ({ at: m.at, from: String(m.from ?? ''), text: String(m.text).slice(0, 200) }))
              : [],
            pending: Array.isArray(value?.pending)
              ? value.pending
                  .filter((p) => p && typeof p.text === 'string' && typeof p.at === 'number')
                  .slice(-3)
                  .map((p) => ({
                    id: String(p.id ?? p.at),
                    at: p.at,
                    text: String(p.text).slice(0, 200),
                    ...(typeof p.subject === 'string' && p.subject ? { subject: p.subject } : {}),
                    ...(typeof p.referredAt === 'number' ? { referredAt: p.referredAt } : {}),
                  }))
              : [],
            openLoop: value?.openLoop && typeof value.openLoop === 'object'              ? {
                  at: Number(value.openLoop.at ?? 0),
                  text: String(value.openLoop.text ?? ''),
                  kind: value.openLoop.kind === 'question' ? 'question' : 'proactive',
                  subject: String(value.openLoop.subject ?? ''),
                  followed: value.openLoop.followed === true,
                }
              : null,
          }]),
        ),
      };
    } catch (err) {
      this.log?.warn('陪伴状态读取失败，按空状态继续', { error: String(err) });
      return fallback;
    }
  }
}
