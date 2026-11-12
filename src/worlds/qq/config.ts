import type { ConfigGroup } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import type { AttentionConfig } from './salience.ts';
import type { RoomConfig } from './room.ts';
import type { VisionConfig } from './vision.ts';
import { text } from './strings.ts';

/** 关闭的 roster 条目仍持久化并显示,仅从监听集合中排除。 */
export interface QQRosterEntry {
  id: number;
  enabled: boolean;
}

export const QQ_DEFAULTS = {
  enabled: false,
  /** OneBot v11 协议端的正向 WS 地址 */
  wsUrl: 'ws://127.0.0.1:3001',
  groups: [] as QQRosterEntry[],
  privates: [] as QQRosterEntry[],
  token: '',
  /** 群里未被 @ 的消息不单独唤醒;开启时这些消息只归档,不进入下一次唤醒的批次 */
  wakeOnMentionOnly: false,
  /** 群里正文提到 wakeNames 里的词时也立即唤醒 */
  wakeOnName: true,
  /** 唤醒名字;正文包含任一词(不区分大小写)就算叫到 bot */
  wakeNames: ['claude', '克劳德', '小橙', 'claude娘'] as string[],
  /** 拉丁别名的前缀最短长度(>=3 才认);CJK 别名始终要求完整出现 */
  wakeNameMinChars: 3,
  /** 拉丁别名允许一次编辑距离(cluade → claude) */
  wakeNameFuzzy: true,
  /** 黑名单 QQ 号,逗号/空格/换行分隔;这些号的事件在入站处直接丢弃 */
  blacklist: '',
  /**
   * 线索的保鲜期(分钟)。她在这条线索里最后一次开口之后的这段时间内,对方说话才叫醒她;
   * 过期后只有点名、@、引用和问句能叫醒。0 = 永远算冷。
   */
  threadHotMinutes: 360,
  /** 把没唤醒 bot 的群消息按间隔汇总成一条背景摘要,给它插话的机会 */
  ambientInterject: true,
  /** 背景摘要间隔(分钟);0 = 关闭 */
  ambientIntervalMinutes: 10,
  /** 一条摘要最多带多少条消息 */
  ambientMaxMessages: 20,
  /** 重连到协议端时补齐离线期间错过的消息（只投一条摘要） */
  catchupOnStart: true,
  /** 补拉时最多往回看多少条消息 */
  catchupMaxMessages: 60,
  /** 注意力显著性：没叫到她的群消息分三档，低分的只归档不唤醒。 */
  attention: {
    enabled: false,
    peripheryThreshold: 0.35,
    windowMinutes: 10,
    habituationMinutes: 30,
  },
  /** 群聊形状：统计窗口与开关。事实进上下文，判断留给模型。 */
  room: {
    enabled: true,
    windowMinutes: 30,
  },
  /**
   * 发言形状的自律：一条里最多几处括号动作、最近 windowSize 条里最多几条带动作。
   * 0 = 不限制。默认值按克制型人格调；话多、爱做戏的人格应当放宽或关掉。
   */
  gesture: {
    maxPerMessage: 1,
    maxRecent: 2,
    windowSize: 5,
  },
  /** 这些账号发的群消息**可以**叫醒本实例（同住的其它 AI 娘），但见下一条预算。 */
  siblingIds: [] as number[],
  /**
   * 同一会话里连续多少条来自同住 AI 的消息之后开始降速（不是静音）。
   * 有人在中间说话就重新计数。0 = 一上来就降速。
   */
  siblingWakeBudget: 6,
  /** 降速后，同住 AI 的消息最多多少秒叫醒一次。0 = 预算用完后彻底不叫醒。 */
  siblingWakeThrottleSeconds: 90,
  /**
   * 同住 AI 的名字（它们的 `wakeNames`）。消息里叫到这些名字、又没叫到本实例时，
   * 这条只归档——否则「叫白龙」会被线程热着的另一个人接走。
   */
  siblingNames: [] as string[],
  /** 把「不评/不接/别问」这类台词判成拒绝，并提示沉默比再发一句更像她。关掉后不再提示。 */
  refusalHint: true,
} as const;

/**
 * 本 World 需要的密钥的**环境变量名**。辅助视觉用的是 OpenRouter——
 * core 不认识这个名字,装配层照 World 声明的名字取值。
 */
export const QQ_SECRETS = { vision: 'OPENROUTER_API_KEY' } as const;

/**
 * 本 World 声明的可调项。只声明**World 自己**的参数:连接与监听名单有
 * 专用面板(要卡片式增删、要重启),这里放的是自带视觉的行为旋钮。文案按界面语言给。
 */
export function qqConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: 'world:qq',
    owner: 'world:qq',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.qq.wakeOnMentionOnly': {
          type: 'boolean',
          title: t.wakeOnMentionTitle,
          'x-hot': true,
          description: t.wakeOnMentionDescription,
        },
        'worlds.qq.wakeOnName': {
          type: 'boolean',
          title: t.wakeOnNameTitle,
          'x-hot': false,
          description: t.wakeOnNameDescription,
        },
        'worlds.qq.wakeNameMinChars': {
          type: 'integer',
          title: t.wakeNameMinCharsTitle,
          minimum: 2,
          maximum: 12,
          'x-hot': false,
          description: t.wakeNameMinCharsDescription,
        },
        'worlds.qq.wakeNameFuzzy': {
          type: 'boolean',
          title: t.wakeNameFuzzyTitle,
          'x-hot': false,
          description: t.wakeNameFuzzyDescription,
        },
        'worlds.qq.blacklist': {
          type: 'string',
          title: t.blacklistTitle,
          'x-hot': true,
          description: t.blacklistDescription,
        },
        'worlds.qq.ambientInterject': {
          type: 'boolean',
          title: t.ambientInterjectTitle,
          'x-hot': false,
          description: t.ambientInterjectDescription,
        },
        'worlds.qq.ambientIntervalMinutes': {
          type: 'integer',
          title: t.ambientIntervalTitle,
          minimum: 0,
          maximum: 240,
          'x-suffix': t.intervalSuffix,
          'x-hot': false,
          description: t.ambientIntervalDescription,
        },
        'worlds.qq.ambientMaxMessages': {
          type: 'integer',
          title: t.ambientMaxMessagesTitle,
          minimum: 1,
          maximum: 100,
          'x-hot': false,
          description: t.ambientMaxMessagesDescription,
        },
        'worlds.qq.catchupOnStart': {
          type: 'boolean',
          title: t.catchupOnStartTitle,
          'x-hot': false,
          description: t.catchupOnStartDescription,
        },
        'worlds.qq.catchupMaxMessages': {
          type: 'integer',
          title: t.catchupMaxMessagesTitle,
          minimum: 1,
          maximum: 200,
          'x-hot': false,
          description: t.catchupMaxMessagesDescription,
        },
        'worlds.qq.attention.enabled': {
          type: 'boolean',
          title: t.attentionEnabledTitle,
          'x-hot': true,
          description: t.attentionEnabledDescription,
        },
        'worlds.qq.attention.peripheryThreshold': {
          type: 'number',
          title: t.attentionThresholdTitle,
          minimum: 0.05,
          maximum: 0.95,
          'x-hot': false,
          description: t.attentionThresholdDescription,
        },
        'worlds.qq.attention.windowMinutes': {
          type: 'integer',
          title: t.attentionWindowTitle,
          minimum: 1,
          maximum: 120,
          'x-suffix': t.intervalSuffix,
          'x-hot': false,
          description: t.attentionWindowDescription,
        },
        'worlds.qq.attention.habituationMinutes': {
          type: 'integer',
          title: t.attentionHabituationTitle,
          minimum: 1,
          maximum: 480,
          'x-suffix': t.intervalSuffix,
          'x-hot': false,
          description: t.attentionHabituationDescription,
        },
        'worlds.qq.room.enabled': {
          type: 'boolean',
          title: t.roomEnabledTitle,
          'x-hot': true,
          description: t.roomEnabledDescription,
        },
        'worlds.qq.room.windowMinutes': {
          type: 'integer',
          title: t.roomWindowTitle,
          minimum: 5,
          maximum: 240,
          'x-suffix': t.intervalSuffix,
          'x-hot': false,
          description: t.roomWindowDescription,
        },
        'worlds.qq.gesture.maxPerMessage': {
          type: 'integer',
          title: t.gesturePerMessageTitle,
          minimum: 0,
          maximum: 10,
          'x-hot': true,
          description: t.gesturePerMessageDescription,
        },
        'worlds.qq.gesture.maxRecent': {
          type: 'integer',
          title: t.gestureRecentTitle,
          minimum: 0,
          maximum: 20,
          'x-hot': true,
          description: t.gestureRecentDescription,
        },
        'worlds.qq.gesture.windowSize': {
          type: 'integer',
          title: t.gestureWindowTitle,
          minimum: 1,
          maximum: 50,
          'x-suffix': t.gestureWindowSuffix,
          'x-hot': true,
          description: t.gestureWindowDescription,
        },
        'worlds.qq.refusalHint': {
          type: 'boolean',
          title: t.refusalHintTitle,
          'x-hot': true,
          description: t.refusalHintDescription,
        },
        'worlds.qq.vision.enabled': {
          type: 'boolean',
          title: t.visionEnabledTitle,
          'x-hot': false,
          description: t.visionEnabledDescription,
        },
        'worlds.qq.vision.model': {
          type: 'string',
          title: t.visionModelTitle,
          'x-hot': false,
          description: t.visionModelDescription,
        },
        'worlds.qq.vision.concurrency': {
          type: 'integer',
          title: t.concurrencyTitle,
          minimum: 1,
          maximum: 16,
          multipleOf: 1,
          'x-suffix': t.concurrencySuffix,
          'x-hot': true,
          description: t.concurrencyDescription,
        },
        'worlds.qq.vision.dedupPrecheckMs': {
          type: 'integer',
          title: t.dedupPrecheckTitle,
          minimum: 0,
          maximum: 30_000,
          multipleOf: 100,
          'x-suffix': 'ms',
          'x-hot': true,
          description: t.dedupPrecheckDescription,
        },
        'worlds.qq.vision.maxImageBytes': {
          type: 'integer',
          title: t.maxImageBytesTitle,
          minimum: 65_536,
          maximum: 104_857_600,
          multipleOf: 65_536,
          'x-scale': 1_048_576,
          'x-suffix': 'MB',
          'x-hot': true,
          description: t.maxImageBytesDescription,
        },
        'worlds.qq.vision.timeoutMs': {
          type: 'integer',
          title: t.timeoutTitle,
          minimum: 1000,
          maximum: 300_000,
          multipleOf: 1000,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': false,
          description: t.timeoutDescription,
        },
      },
    },
  };
}

/** config.json 的 `worlds.qq` 节。 */
export interface QQConfigSection {
  enabled: boolean;
  /** OneBot v11 协议端的正向 WS 地址 */
  wsUrl: string;
  /** 群 roster,逐项热更新;关闭的条目仍持久化并显示,但不参与监听。 */
  groups: QQRosterEntry[];
  /** 监听的私聊 QQ 号 roster,语义同 groups */
  privates: QQRosterEntry[];
  /** OneBot access token,可空 */
  token: string;
  /** 群里未被 @ 的消息不单独唤醒;开启时这些消息只归档,不进入下一次唤醒的批次 */
  wakeOnMentionOnly: boolean;
  /** 群里正文提到 wakeNames 里的词时也立即唤醒 */
  wakeOnName: boolean;
  /** 唤醒名字;正文包含任一词(不区分大小写)就算叫到 bot */
  wakeNames: string[];
  /** 拉丁别名的前缀最短长度(>=3 才认);CJK 别名始终要求完整出现 */
  wakeNameMinChars: number;
  /** 拉丁别名允许一次编辑距离 */
  wakeNameFuzzy: boolean;
  /** 黑名单 QQ 号,逗号/空格/换行分隔;这些号的事件在入站处直接丢弃 */
  blacklist: string;
  /**
   * 线索保鲜期(分钟):她最后一次在这条线索里开口之后,这段时间内对方说话才叫醒她;
   * 过期后只有点名、@、引用、问句能叫醒。0 = 永远算冷。
   */
  threadHotMinutes: number;
  /** 把没唤醒 bot 的群消息按间隔汇总成一条背景摘要 */
  ambientInterject: boolean;
  /** 背景摘要间隔(分钟);0 = 关闭 */
  ambientIntervalMinutes: number;
  /** 一条摘要最多带多少条消息 */
  ambientMaxMessages: number;
  /** 重连到协议端时补齐离线期间错过的消息（只投一条摘要，不逐条唤醒） */
  catchupOnStart: boolean;
  /** 补拉时最多往回看多少条消息 */
  catchupMaxMessages: number;
  /** 注意力显著性：没叫到她的群消息分三档。 */
  attention: AttentionConfig;
  /** 群聊此刻的形状：只数事实（几个人在说、谁占了大半、静了多久），不做解读。 */
  room: RoomConfig;
  vision: VisionConfig;
}
