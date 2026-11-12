/**
 * 群聊此刻的形状。
 *
 * 只数事实，不做解读：几个人在说、谁占了大半、有没有人在接谁的话、问到她头上几个、
 * 静了多久。那层「在玩梗 / 在吵架」的判断留给她——基础设施只陈述能核对的东西，
 * 猜错比不猜更糟。
 *
 * 统计是确定性的：同一串样本永远得到同一组数字，方便复盘和写测试。
 */

export type RoomHeat = 'silent' | 'quiet' | 'normal' | 'busy' | 'flood';

export interface RoomConfig {
  enabled: boolean;
  /** 统计窗口（分钟）。 */
  windowMinutes: number;
}

export const ROOM_DEFAULTS: RoomConfig = { enabled: true, windowMinutes: 30 };

export function roomConfig(raw?: Partial<RoomConfig> | null): RoomConfig {
  const clamp = (value: unknown, fallback: number, min: number, max: number): number => (
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  );
  return {
    enabled: raw?.enabled ?? ROOM_DEFAULTS.enabled,
    windowMinutes: clamp(raw?.windowMinutes, ROOM_DEFAULTS.windowMinutes, 5, 240),
  };
}

/** 一条消息在统计里留下的东西。只记事实，不记正文。 */
export interface RoomSample {
  at: number;
  senderKey: string;
  /** 引用回复的那个人；引用的消息不在窗口内时为 null。 */
  replyTo: string | null;
  question: boolean;
  emotional: boolean;
  /** 纯附和、单个表情。 */
  filler: boolean;
  /** 叫到她（@ / 名字）。 */
  toSelf: boolean;
  /** 这条是她自己说的。只用来判断"这场还有没有她"，不计进任何数字。 */
  self?: boolean;
}

export interface RoomFacts {
  messages: number;
  speakers: number;
  /** 说得最多的那个。 */
  topSender: string;
  topMessages: number;
  /** 他占了多少，0–1。 */
  topShare: number;
  /** 窗口内平均每分钟几条。 */
  perMinute: number;
  replyMessages: number;
  replyShare: number;
  toSelfMessages: number;
  questionMessages: number;
  fillerMessages: number;
  /** 距最后一条多少分钟。 */
  lullMinutes: number;
  heat: RoomHeat;
  /** 一个人在说、别人偶尔插嘴。 */
  monologue: boolean;
  /** 她上一次在这个房间说话的时刻(窗口内);没说过就是 null。 */
  lastSelfAt: number | null;
  /**
   * 最近三条里没有她,而且是两个以上的人在互相说——这一场不是她的。
   *
   * 只看"有没有别人"不够:她刚插完一句,房间里照样有两个人,那条规则会把她静音。
   * 所以判据里必须带上"最近这三条里有没有她自己"。
   */
  othersTalking: boolean;
}

/** 样本条数上限：刷屏的群也不让内存跟着涨。 */
const MAX_SAMPLES = 300;

function heatOf(perMinute: number): RoomHeat {
  if (perMinute < 0.05) return 'silent';
  if (perMinute < 0.4) return 'quiet';
  if (perMinute < 1.5) return 'normal';
  if (perMinute < 4) return 'busy';
  return 'flood';
}

export function roomFacts(samples: readonly RoomSample[], now: number, cfg: RoomConfig): RoomFacts {
  const windowMs = cfg.windowMinutes * 60_000;
  const recent = samples.filter((s) => now - s.at <= windowMs);
  // 她自己的发言只用来判"这场还有没有她"，不进任何数字：
  // 「3 人在说」说的是别人，不是她。
  const live = recent.filter((s) => s.self !== true);
  const tail = recent.slice(-3);
  // 判"这一场是不是她的"：这条是在接上一条别人说的话吗？
  // 只看"有三个以上的人在说"会把"他连着说两句"也算成旁听——那是最常见的对话形状。
  const current = recent[recent.length - 1];
  const prevOther = [...recent.slice(0, -1)].reverse().find((s) => s.self !== true);
  const othersTalking = current !== undefined
    && current.self !== true
    && prevOther !== undefined
    && prevOther.senderKey !== current.senderKey
    && !tail.some((s) => s.self === true);
  const lastSelfAt = [...recent].reverse().find((s) => s.self === true)?.at ?? null;
  const windowMinutes = Math.max(1, cfg.windowMinutes);
  if (live.length === 0) {
    const lastAny = [...samples].reverse().find((s) => s.self !== true);
    return {
      messages: 0, speakers: 0, topSender: '', topMessages: 0, topShare: 0,
      perMinute: 0, replyMessages: 0, replyShare: 0, toSelfMessages: 0,
      questionMessages: 0, fillerMessages: 0,
      lullMinutes: lastAny ? Math.max(0, (now - lastAny.at) / 60_000) : Infinity,
      heat: 'silent', monologue: false,
      lastSelfAt, othersTalking,
    };
  }

  const bySender = new Map<string, number>();
  let replyMessages = 0;
  let toSelfMessages = 0;
  let questionMessages = 0;
  let fillerMessages = 0;
  for (const s of live) {
    bySender.set(s.senderKey, (bySender.get(s.senderKey) ?? 0) + 1);
    if (s.replyTo) replyMessages++;
    if (s.toSelf) toSelfMessages++;
    if (s.question) questionMessages++;
    if (s.filler) fillerMessages++;
  }
  let topSender = '';
  let topMessages = 0;
  for (const [sender, count] of bySender) {
    if (count > topMessages) { topSender = sender; topMessages = count; }
  }
  const messages = live.length;
  const perMinute = messages / windowMinutes;
  const topShare = topMessages / messages;
  const last = live[live.length - 1]!;
  return {
    messages,
    speakers: bySender.size,
    topSender,
    topMessages,
    topShare,
    perMinute,
    replyMessages,
    replyShare: replyMessages / messages,
    toSelfMessages,
    questionMessages,
    fillerMessages,
    lullMinutes: Math.max(0, (now - last.at) / 60_000),
    heat: heatOf(perMinute),
    // 一个人说了六成以上、且不是只有他一个人在说——两条判据都要，「群里只有你在说」
    // 和「他在说、别人在听」是同一件事，但对她的含义不同。
    monologue: messages >= 4 && (bySender.size === 1 || (bySender.size >= 2 && topShare >= 0.6)),
    lastSelfAt,
    othersTalking,
  };
}

export interface DescribeOptions {
  /** QQ 号 → 当前称呼；缺省就用号码。 */
  nameOf?: (senderKey: string) => string | undefined;
}

/** 把事实写成给她看的一行。不写评价，只写数字和名字。 */
export function describeRoom(facts: RoomFacts, cfg: RoomConfig, opts: DescribeOptions = {}): string | null {
  const name = (key: string): string => (opts.nameOf?.(key) ?? key).trim() || key;
  const head = `近 ${Math.round(cfg.windowMinutes)} 分钟`;
  const quietTail = Number.isFinite(facts.lullMinutes)
    ? `；最后一条在 ${Math.round(facts.lullMinutes)} 分钟前。`
    : '。';
  if (facts.messages === 0) {
    return Number.isFinite(facts.lullMinutes) ? `${head}没人说话${quietTail}` : null;
  }
  // 一条两条、隔了很久：那不是"1 条消息、1 人在说"，是这屋基本没人。说法要跟着变。
  if (facts.heat === 'silent') {
    return `${head}只有 ${facts.messages} 条${quietTail}`;
  }

  const parts: string[] = [`${facts.messages} 条，${facts.speakers} 人在说`];
  if (facts.monologue) {
    parts.push(`${name(facts.topSender)} 一个人占了 ${facts.topMessages} 条`);
  } else if (facts.speakers >= 2) {
    parts.push(`最多的是 ${name(facts.topSender)}（${facts.topMessages} 条）`);
  }
  if (facts.replyMessages > 0) parts.push(`${facts.replyMessages} 条在接别人的话`);
  if (facts.toSelfMessages > 0) parts.push(`${facts.toSelfMessages} 条在问你`);
  if (facts.questionMessages >= 2) parts.push(`${facts.questionMessages} 条是问句`);
  if (facts.fillerMessages >= Math.max(3, facts.messages / 3)) parts.push(`${facts.fillerMessages} 条是附和或表情`);

  const tail = facts.lullMinutes >= 2
    ? `；上一条在 ${Math.round(facts.lullMinutes)} 分钟前。`
    : '。';
  return `${head}${parts.join('，')}${tail}`;
}

/**
 * 挂在事件 meta 上的那一份：判定要用的少量字段，不带名字也不带正文。
 * 数字都取整，别让浮点尾巴泄漏到日志和面板里。
 */
export function roomDigest(facts: RoomFacts): Record<string, unknown> {
  return {
    messages: facts.messages,
    speakers: facts.speakers,
    heat: facts.heat,
    monologue: facts.monologue,
    replyShare: Math.round(facts.replyShare * 100) / 100,
    toSelf: facts.toSelfMessages,
    lullMinutes: Number.isFinite(facts.lullMinutes) ? Math.round(facts.lullMinutes) : null,
  };
}

/** 每个会话一个滚动窗口。只存样本，不存正文。 */export class RoomTracker {
  private readonly byConv = new Map<string, RoomSample[]>();

  observe(convKey: string, sample: RoomSample, cfg: RoomConfig): void {
    if (!cfg.enabled) return;
    const list = this.byConv.get(convKey) ?? [];
    list.push(sample);
    const cutoff = sample.at - cfg.windowMinutes * 60_000;
    let drop = 0;
    while (drop < list.length && list[drop]!.at < cutoff) drop++;
    if (drop) list.splice(0, drop);
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
    this.byConv.set(convKey, list);
  }

  facts(convKey: string, now: number, cfg: RoomConfig): RoomFacts {
    return roomFacts(this.byConv.get(convKey) ?? [], now, cfg);
  }

  /** 窗口内最近 N 条，供引用回复解析。 */
  recent(convKey: string, limit = 40): readonly RoomSample[] {
    const list = this.byConv.get(convKey);
    return list ? list.slice(-limit) : [];
  }
}
