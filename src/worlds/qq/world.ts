/**
 * QQ World。
 *
 * 仅监听配置名单中的群与私聊,名单可通过 Web 热更新。其他会话与请求不落盘。
 * 每条消息渲染带会话标签(`[群「X」HH:MM]` / `[私聊 HH:MM]`),事件 meta.conv
 * 记录归属,发送/回复据此路由。
 *
 * 发送只有一个入口:draft 调用即发出,并在返回值里结束这一轮。话一旦触到复核规矩
 * (重复 / 动作密度 / 宣布不接),它改成单槽草稿并形成一次推理屏障:起草期间到达的
 * 会话消息紧随其后投递,下一次推理可照原样发出或作废。
 */
import { createHash } from 'node:crypto';
import { QQContinuations, type QQContinuationSpec } from './continuations.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  EventEnvelope,
  WorldWebUiDecl,
  World,
  WorldHost,
  Logger,
  StoragePart,
  ToolDef,
  BlobInput,
  BlobRef,
} from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import { fileURLToPath } from 'node:url';
import { nowIso, shortTime, nullLogger, SYSTEM_TIMEZONE } from '../../core/util.ts';
import {
  eventInConversation,
  parseConversationAddress,
  sameConversation,
  type Conv,
} from './conversation.ts';
import {
  DEFAULT_API_TIMEOUT_MS,
  OneBotDriver,
  RETCODE_UNSUPPORTED_ACTION,
  type ExtensionResult,
  type OneBotEvent,
} from './driver.ts';
import { createHistoryTools, HISTORY_TOOL_DECLS, readLatest } from './history-tools.ts';
import {
  attentionConfig as resolveAttention,
  isFillerMessage,
  looksEmotional,
  looksQuestion,
  normalizeForRepeat,
  scoreMessage,
  type AttentionConfig,
  type AttentionEntry,
  type AttentionTier,
  type SalienceFacts,
} from './salience.ts';
import {
  RoomTracker,
  describeRoom,
  roomConfig,
  roomDigest,
  type RoomConfig,
} from './room.ts';
import {
  buildOutgoing,
  makeImagePolicy,
  parseJsonCard,
  renderIncoming,
  renderJsonCardText,
  renderSegmentsPlain,
  type ImageRenderPolicy,
  type JsonCardRenderPolicy,
  type OneBotGroupMessage,
  type Segment,
} from './normalize.ts';
import { VISION_DEFAULTS, type VisionConfig, type VisionService } from './vision.ts';
import { downloadImageBytes } from './image-download.ts';
import { qqConfigGroup, type QQRosterEntry } from './config.ts';
import { text } from './strings.ts';

export type { Conv } from './conversation.ts';
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** QQ在查不到账号资料时返回的昵称占位,等于「没有名字」。 */
const PLACEHOLDER_NICKNAME = 'QQ用户';

/**
 * 语音转文字的扩展动作,按尝试顺序。SnowLuma、NapCat 提供前者,LLOneBot 提供后者;
 * 两者参数都是 `{ message_id }`,返回 `{ text }`。
 */
const PTT_TEXT_ACTIONS = ['fetch_ptt_text', 'voice_msg_to_text'] as const;
type PttTextAction = (typeof PTT_TEXT_ACTIONS)[number];

/**
 * 协议端等 QQ 推回转写结果的最长时间:LLOneBot 等 30s;NapCat 取消息、转写、再取消息
 * 三段各等 baseTimeout(缺省 10s);SnowLuma 等 20s。调用时限在此之上再加一次普通调用
 * 的时限,协议端自己的超时失败先于本端超时送达。
 */
const PTT_TEXT_PROTOCOL_WAIT_MS = 30_000;



type QQText = ReturnType<typeof text>;

export function enabledRosterIds(entries: QQRosterEntry[]): number[] {
  return entries.filter((e) => e.enabled).map((e) => e.id);
}



interface QQWorldConfig {
  wsUrl: string;
  /** 监听的群号集合 */
  groups: number[];
  /** 监听的私聊QQ号集合 */
  privates: number[];
  token: string;
  /** 群里未被 @ 的消息不单独唤醒,随下一次唤醒一起投递 */
  wakeOnMentionOnly?: boolean;
  /** 群里正文提到 wakeNames 里的词时也立即唤醒 */
  wakeOnName?: boolean;
  /** 唤醒名字;正文包含任一词(不区分大小写)就算叫到 bot */
  wakeNames?: string[];
  /** 拉丁别名的前缀最短长度(>=3 才认);CJK 别名要求完整出现 */
  wakeNameMinChars?: number;
  /** 拉丁别名允许一次编辑距离 */
  wakeNameFuzzy?: boolean;
  /** 黑名单号码原串（逗号/空格/换行分隔）；每次事件现读，配置热改立即生效。 */
  blacklist?: () => string;
  /** 线索保鲜期(分钟)：她最后一次在这条线索里开口之后，对方说话才叫醒她。0 = 永远算冷。 */
  threadHotMinutes?: number;
  /** 持久化对话线索的目录(部署 data/) */
  dataDir?: string;
  /** 把没唤醒 bot 的群消息按间隔汇总成背景摘要 */
  ambientInterject?: boolean;
  /** 背景摘要间隔(分钟);0 = 关闭 */
  ambientIntervalMinutes?: number;
  /** 一条摘要最多带多少条消息 */
  ambientMaxMessages?: number;
  /** 重连到协议端时补齐离线期间错过的消息 */
  catchupOnStart?: boolean;
  /** 补拉时最多往回看多少条消息 */
  catchupMaxMessages?: number;
  /** 注意力显著性：没叫到她的群消息分三档（见 salience.ts）。 */
  attention?: Partial<AttentionConfig>;
  /** 群聊此刻的形状：只数事实，不做解读（见 room.ts）。 */
  room?: Partial<RoomConfig>;
  /** 发言形状的自律；0 = 不限制。缺省按克制型人格（见 QQ_DEFAULTS.gesture）。 */
  gesture?: Partial<{ maxPerMessage: number; maxRecent: number; windowSize: number }>;
  /** 同住 AI 的 QQ 号：它们说话能叫醒我，但有预算，防止两个 bot 自转一整晚。 */
  siblingIds?: number[];
  /** 连续多少条同住 AI 的消息之后开始降速；0 = 一上来就降速。 */
  siblingWakeBudget?: number;
  /** 降速后，同住 AI 的消息最多多少秒叫醒一次。0 = 预算用完后彻底不叫醒（静音）。 */
  siblingWakeThrottleSeconds?: number;
  /** 同住 AI 的名字；消息里叫到它们、又没叫到我时，只归档。 */
  siblingNames?: string[];
  /** 把「宣布不接」判成拒绝并提示沉默；false = 不提示。 */
  refusalHint?: boolean;
  /** Event rendering timezone. */
  timezone?: string;
  /** 重连退避参数透传(测试用短退避) */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  apiTimeoutMs?: number;
}

/**
 * 「QQ 接入」面板的装配数据面。装配层管理 roster、enabled、持久化与重启；
 * World 管理面板语义和校验。缺少该依赖时 gate/roster 面板不可用。
 */
interface QQGatePanelDeps {
  /** config.worlds.qq.enabled(当前进程装配态;改它要重启才生效) */
  enabled(): boolean;
  wsUrl(): string;
  /** 是否已配置 access token(只报有无,不回明文) */
  tokenSet(): boolean;
  /** 完整监听名单,包含未进入 World 监听集合的 disabled 条目。 */
  roster(): { groups: QQRosterEntry[]; privates: QQRosterEntry[] };
  /** 整体替换名单并写回 config.json;返回一句结果描述 */
  setRoster(groups: QQRosterEntry[], privates: QQRosterEntry[]): string;
  /** 持久化 worlds.qq.enabled;本身不重启,重启由调用方另行触发 */
  setEnabled(enabled: boolean): void;
  /** 持久化协议端连接(wsUrl + token);token 空串=保持原值不动 */
  setConnection(wsUrl: string, token: string): void;
  /** 落重启标志并让进程退出(启动器重新拉起,回来是暂停态) */
  restart(): void;
}

interface QQWorldDeps {
  vision?: VisionService;
  /** 无辅助视觉时下载入站图片用的上限;传入配置对象本身,热更新随之生效。 */
  imageCapture?: QQImageCaptureOptions;
  gate?: QQGatePanelDeps;
}

type QQImageCaptureOptions = Pick<VisionConfig, 'timeoutMs' | 'maxImageBytes' | 'dedupPrecheckMs'>;

type IncomingImageDownload = { image: { buffer: Uint8Array; mime: string } | null };

/** 暂存的草稿(单槽,一进一出;不确认到本轮末即作废) */
interface PendingDraft {
  followUp?: QQContinuationSpec;
  followUpId?: string;
  continuationId?: string;
  continuationSettled?: boolean;
  target: Conv;
  text: string;
  /** 第二条气泡：单独发，不带引用、图片和语音。分两拍说话时用。 */
  more?: string;
  /** 首次发送前固定的回复对象；null 表示无法确认，两拍和重试共用。 */
  replyRecipient?: string | null;
  /** 第一拍已确认发送的回执；重试时不得重复发送。 */
  firstReceipt?: string;
  /** 第一拍请求的结果未知，不能自动重试。 */
  firstUnknown?: boolean;
  /** 第二拍请求的结果未知，不能自动重试。 */
  secondUnknown?: boolean;
  /** 引用回复的平台message_id(已从游标解析好) */
  replyMessageId?: number | string;
  /** 要发送的图片的句柄(`log:` 她看见过的 / `mem:` 她收藏的);无=纯文本 */
  imageRef?: string;
  /** 要发送的语音的句柄;语音条独占一条消息,与 text、imageRef 互斥 */
  voiceRef?: string;
}

interface ForwardNode {
  line: string;
  /** 正文(不带发言人前缀),身份塌掉时重新渲染用 */
  body: string;
  /** 协议给了可用的发言人名字(不是空、也不是「QQ用户」占位) */
  named: boolean;
  time?: number;
  userId?: string;
  messageType?: string;
  /** 这一节点里的图片地址。正文只渲染成 `[图片]`,要给她看就得单独下载。 */
  images?: string[];
}

/**
 * 一条转发记录最多给她看几张图。
 *
 * 合并转发经常一次几十张(实测一条 20 张),全塞进一次请求会把上下文和成本一起打爆。
 * 剩下的只在正文里报总数,她要看可以再问。
 */
const FORWARD_IMAGE_CAP = 4;

const DRAFT_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq_draft',
  description:
    '在 QQ 里说话的唯一方式：调用即发出，回执写明是否送达。'
    + '每次必须明确填写 follow_up：让对方等待你稍后回来交代时登记行动对象；普通发言、状态描述、告别或正在发送接续结果时填 null。'
    + '不要口头让人等却填 null；若不打算回来接续，就不要让对方等待。登记行动只发一拍，不带 more。漏填不会发送，须补齐后重新调用。'
    + '回执里带提醒（重复、动作过多、又在宣布不接）时这一条不会发出，改一版再调一次；'
    + '确实要照原样发，用 qq_confirm。直接写在回复正文里的文字不会送到群里，等于没说。'
    + '一件事分两拍说时，把第二拍放 more：会发成两条消息，读起来比一大段自然。',
  tags: ['speak'],
  barrierAfter: true,
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'Target conversation: "group:<id>" or "private:<id>" (numeric QQ group/user id, not a name). Optional when reply_to is given (taken from the quoted message).',
      },
      text: { type: 'string', description: 'Message text. Optional if image is given.' },
      more: {
        type: 'string',
        description:
          'Optional second bubble, sent right after the first as its own message. Use it when the thought is '
          + 'two beats and one block would read like a paragraph; at most one extra bubble, and it carries no '
          + 'image, voice or quote-reply.',
      },
      follow_up: {
        type: ['object', 'null'],
        description: '必填决策：无需稍后接续填 null；让对方等待后续时填行动对象。只有平台确认发送才激活，草稿未发不计。长期承诺不放这里。到期后超过 30 分钟过期，不会补演。',
        properties: {
          action: { type: 'string', minLength: 1, maxLength: 300, description: '回来要续接的行动，不是预先编好的完成台词。' },
          person: { type: 'string', pattern: '^\\d+$', description: '正在等待的对方 QQ 号。' },
          kind: { type: 'string', enum: ['scene', 'task'], description: 'scene=共同虚构场景可按时间推进；task=真实任务，到点只检查实际结果，不能假称已完成。' },
          after_minutes: { type: 'number', exclusiveMinimum: 0, maximum: 30 },
        },
        required: ['action', 'person', 'kind', 'after_minutes'],
        additionalProperties: false,
      },
      continuation_id: { type: 'string', description: '接续行动的 ID。发出该行动的后续时填写；本条只发一拍，不带 more，发送确认后才结掉该行动。' },
      image: {
        type: 'string',
        description:
          'Optional. An image to send, given by handle: a log: handle from a [blob ...] line you saw, '
          + 'or a mem: handle of one kept in your workspace.',
      },
      voice: {
        type: 'string',
        description:
          'Optional. Audio to send as a QQ voice bar, given by handle the same way as image. '
          + 'A voice bar is a message of its own: leave text, image and reply_to out. '
          + 'The protocol end converts the audio it accepts (wav, mp3) to what QQ plays.',
      },
      reply_to: {
        type: 'string',
        description:
          'Optional. The QQ message id to quote-reply — the `#<id>` shown at the start of that message line.',
      },
    },
    required: ['follow_up'],
  },
};

/**
 * 模型偶尔把换行写成两个字符 `\n` 而不是一个换行。
 *
 * 那是它在 JSON 里多转义了一层：`\\n` 解析回来就是反斜杠加 n，发出去群里看到的就是
 * 「第一句\n第二句」。这里认回来——中文聊天里没人会真的想把 `\n` 当字面量打出来。
 */
export function literalNewlines(text: string): string {
  return text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
}

/**
 * 两条气泡之间的间隔范围（毫秒）。
 *
 * 固定值有两个毛病：每回同一个节拍，看着像脚本；两次发送的时间差完全一致，
 * 又是最容易被判定成机器行为的那种签名。下限保证不会挤成一条。
 */
export const BUBBLE_GAP_RANGE_MS: readonly [number, number] = [500, 1500];

/** 这一次的气泡间隔；随机器可由测试注入。 */
export function bubbleGapMs(
  range: readonly [number, number] = BUBBLE_GAP_RANGE_MS,
  random: () => number = Math.random,
): number {
  const [min, max] = range;
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * 两句话被一个空格粘住：空格两侧各有一串至少三个汉字。
 *
 * 中文里两个词之间不加空格，所以这种空格只有两种来由——两句话被粘住了，
 * 或者手滑多按了一下。要求两侧都够长，是为了不误伤「有 一件」这种单个字的
 * 手滑；换行不算命中（`[ \t]` 不含 \n），那是合法的分句方式。
 */
const CJK_GAP = /([一-鿿]{3,})[ \t]+([一-鿿]{3,})/;

const CONFIRM_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq_confirm',
  description:
    'Send or discard the message qq_draft held back for review. Only present when a draft was held; '
    + 'decision="send" sends it as written, decision="cancel" drops it.',
  tags: ['speak'],
  parameters: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['send', 'cancel'],
        description: '"send" or "cancel".',
      },
    },
    required: ['decision'],
  },
};

const VIEW_IMAGE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq_view_image',
  description: 'Ask the auxiliary vision model a specific question about an image.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      image_id: { type: 'string', description: 'Image id, e.g. IMG-3.' },
      prompt: { type: 'string', description: 'Your question about the image.' },
    },
    required: ['image_id', 'prompt'],
  },
};

/** 关闭一条对话线索:之后对方的消息不再单独唤醒 bot,但仍会进背景摘要。 */
export const THREAD_CLOSE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq_thread_close',
  description: '关闭和某人的对话线索：之后对方的消息不再单独唤醒你（仍会出现在背景摘要里）。to 填会话地址，person 填对方 QQ 号。',
  tags: ['flow'],
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'group:<id> 或 private:<id>。' },
      person: { type: 'string', description: '对方 QQ 号。' },
    },
    required: ['to', 'person'],
  },
};

/** 她对这个群的一句判断，过期就自己消失。 */
interface RoomNote {
  conv: string;
  label: string;
  note: string;
  at: number;
  expiresAt: number;
}

/**
 * 她给这个群下的判断。
 *
 * 与形状的区别：形状是可数的（几条、几人、静了多久），这一条是她看完之后的说法
 * （在玩梗、有人在较真）。两边分开存，因为一边是事实、一边是她的读法；读法会过期，
 * 事实不会。
 */
const ROOM_NOTE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq_mark_room',
  description:
    '记下你对这个群的判断（在玩梗、有人在较真、气氛僵着…）。下一次你被叫到时，'
    + '这一行会跟着「群里此刻」一起回到你眼里，标注是你在什么时候这么觉得的。'
    + '数字自己会更新，你的判断只在它还没过期时出现。',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'group:<id>。' },
      label: { type: 'string', description: '一句话，不超过 24 字，例如「在玩梗」「有人较真」「僵着」。' },
      note: { type: 'string', description: '可选，一句依据：你为什么会这么觉得。不超过 120 字。' },
      minutes: {
        type: 'integer',
        description: '这条判断多久后失效，默认 90 分钟。群的气氛变得比这快，就别设太长。',
      },
    },
    required: ['to', 'label'],
  },
};

const CONTINUE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq_continue',
  tags: ['flow'],
  description: '管理已登记的短时接续。list 查看未结行动；对方不等了/话题不适合时 cancel；还没做好时 delay。不要把到点唤醒当成已经完成。发送后续用 qq_draft 的 continuation_id，不能只写回复正文。结果未知时先查群史，不自动重发。',
  parameters: {
    type: 'object', properties: {
      decision: { type: 'string', enum: ['list', 'cancel', 'delay'] },
      id: { type: 'string' },
      after_minutes: { type: 'number', exclusiveMinimum: 0, maximum: 30 },
    }, required: ['decision'],
  },
};

/** 全部工具的声明;`qq_view_image` 只在辅助视觉配好时出现。 */
export const QQ_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  DRAFT_DECL,
  CONFIRM_DECL,
  CONTINUE_DECL,
  ...HISTORY_TOOL_DECLS,
  VIEW_IMAGE_DECL,
  THREAD_CLOSE_DECL,
  ROOM_NOTE_DECL,
];

/**
 * 一个人的显示名流水。
 *
 * 群友会改名，记忆与档案不该跟着冻结。这里只记"什么时候叫什么"，
 * 人格层据此维护 `people/qq-<号>.md` 的当前称呼与曾用名。
 */
interface NameRecord {
  /** 当前显示名（群名片优先，没有名片用 QQ 昵称）。 */
  name: string;
  /** 当前群名片；空串表示没有名片。 */
  card: string;
  nickname: string;
  /** 当前这个名字从哪天开始用的。 */
  since: string;
  seenAt: string;
  /** 用过的旧名。 */
  history: Array<{ name: string; from: string; to: string }>;
}

/** 两段文本的 bigram 重合度；用于"这句刚说过"的提醒。 */
function repeatSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const flat = s.replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i < flat.length - 1; i += 1) out.add(flat.slice(i, i + 2));
    return out;
  };
  const left = grams(a);
  const right = grams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export class QQWorld implements World {
  /** 两句中文的粗相似度：bigram 重合。超过阈值就提醒"这句刚说过"。 */
  private static readonly REPEAT_WARN = 0.7;
  /**
   * 「我不接」这类话：说出口也算开口。同一件事已经拒过一次时，沉默比再说一遍更像她，
   * 所以草稿回执里点一句——提醒，不拦截。
   */
  private static readonly REFUSAL = /(不评|不接|不聊|不写|不问|别问|不想说|换个话题|不站队|这类我都不|这种我不)/;
  /** 碎片：短于这个字数且没有句末标点，就当话没说完。 */
  private static readonly FRAGMENT_MAX_CHARS = 12;
  /** 他停这么久，就当这一段打完了。 */
  private static readonly FRAGMENT_GAP_MS = 3500;
  /** 最多攒这么久，别让一直打字的人把她拖到永远不回。 */
  private static readonly FRAGMENT_MAX_HOLD_MS = 12000;
  /** 她刚沉默过：这么久之内，短陈述不单独叫醒。 */
  private static readonly QUIET_FOLLOWUP_MS = 5 * 60_000;
  /** 短到这个字数以内的陈述，算"还在自己嘀咕"。 */
  private static readonly QUIET_FOLLOWUP_MAX_CHARS = 40;
  readonly id = 'qq';

  private readonly cfg: QQWorldConfig;
  private continuations: QQContinuations | null = null;
  private continuationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly queuedContinuations = new Set<string>();
  /** 黑名单：按原串缓存，配置热改后下一次事件重新解析。 */
  private blockedRaw: string | null = null;
  private blockedIds: ReadonlySet<number> = new Set();
  private readonly imageCapture: QQImageCaptureOptions;
  private readonly timezone: string;
  private host?: WorldHost;
  private driver?: OneBotDriver;
  private log: Logger = nullLogger();
  /** 无辅助视觉时,主模型收图才在正文保留图片URL并下载原图。 */
  private readonly imagePolicy: ImageRenderPolicy = (data) =>
    makeImagePolicy(!!this.vision || (this.host?.modelFacts.accepts('image/png') ?? false))(data);

  /** 外挂视觉(注入=auxVLM生效);null=无,一切保持[图片]占位现状 */
  private readonly vision?: VisionService;

  /** 监听集合(可web端热改) */
  private watchedGroups: Set<number>;
  private watchedPrivates: Set<number>;

  /**
   * 已记录的 QQ 消息:平台 message_id → 所在会话与首条带这个号的事件的 ts(内存索引,启动时从store重建)。
   * QQ 消息身份即平台自身的 message_id,不使用 core 事件游标。
   */
  private knownMessages = new Map<string, { conv: Conv; ts: string; senderKey?: string }>();
  /**
   * 有历史记录的会话。补拉离线消息只针对这些会话——刚加进监听名单的群,
   * 整段历史都不是"错过",把它当错过会凭空造出一堆没人叫过 bot 的消息。
   */
  private knownConvs = new Set<string>();
  /**
   * 补拉时见过、但没有单独落库的消息号。
   *
   * 补拉只把"叫到 bot 的"合成一条摘要投递，其余只计数——这些消息号如果只放内存，
   * 下次重启重建映射时就会丢，同一段空窗被再播一遍，她会把答过的话再答一次。
   * 所以它们随 `qq.catchup` 事件的 meta 一起落库。
   */
  private seenMessages = new Set<string>();
  /** 首连已完成。之后每次重连都补一次离线消息。 */
  private started = false;
  /**
   * 事件面板的会话汇总与总条数,覆盖事件库里游标不超过 summarizedCursor 的本 World 事件。
   * 启动时重建,之后只累加新事件;清空当前 run 的事件不会扣减,下次启动才回到事件库的实际条数。
   */
  private convSummary = new Map<string, { kind: Conv['kind']; id: number; count: number; lastTs: string }>();
  private summarizedTotal = 0;
  private summarizedCursor = 0;
  /** QQ号 → 最近见到的显示名(撤回/入退群/私聊寻址渲染用;同样从store重建) */
  private nameByUserId = new Map<string, string>();
  /** 改名流水(QQ号 → 当前名与曾用名)。只在真的改名时落盘,不是花名册。 */
  private nameLedger = new Map<string, NameRecord>();
  private namesFile: string | null = null;
  private namesDirty = false;
  /** 注意力判决的环形记录（最近 300 条），面板与负荷统计共用。 */
  private attention: AttentionEntry[] = [];
  /** 每个会话里她最近几句真正发出去的话（新的在前）；草稿时用来提醒别复读。 */
  private lastSentByConv = new Map<string, string[]>();
  /** 判决流水文件；重启后从这里恢复最近一段，面板不至于清空。 */
  private attentionFile: string | null = null;
  private attentionLoaded = false;
  /** 每个会话最近一段的说话形状。只留样本，不留正文。 */
  private readonly room = new RoomTracker();
  /** 每个会话上一次说过的形状：数字没变就不再重复一遍。 */
  private readonly lastRoomLine = new Map<string, string>();
  /** 攒着的碎片游标：他连着打的半句话，等他说完再一起投递。 */
  private pendingFragments: number[] = [];
  private fragmentTimer: ReturnType<typeof setTimeout> | null = null;
  private fragmentHeldSince = 0;
  private readonly turnParticipants = new Set<string>();
  private readonly turnReplies = new Set<string>();
  private readonly quietByThread = new Map<string, number>();
  private readonly lastDeliveredSpeakerByConv = new Map<string, string>();
  /** 她自己给这些群下的判断（qq_mark_room），带过期时间。 */
  private roomNotes: RoomNote[] = [];
  private roomNotesFile: string | null = null;
  private roomNotesLoaded = false;

  /** 单槽草稿:只留给被复核规矩扣下的那一条 */
  private pendingDraft: PendingDraft | null = null;

  /** 没唤醒 bot 的群消息,按间隔汇总成一条背景摘要,给它插话的机会 */
  private ambient: Array<{ ts: string; text: string; convKey: string; senderKey: string; messageId?: string; blobs?: BlobRef[] }> = [];
  /** 对话线索:某个会话里和某人之间是否还有一条没说完的线。按 conv|sender 持久化,不设过期。 */
  private threads = new Map<string, { open: boolean; openedAt: number; lastMessageAt: number; warmAt: number }>();
  private threadsFile: string | null = null;

  /** 当前连接上可用的转写动作:undefined=未探明,null=都不存在。每次(重)连后重新探明。 */
  private pttTextAction: PttTextAction | null | undefined;


  /** 最近一次成功组装的动态账号/会话事实(断线期间沿用；不缓存可编辑固定文本) */
  private cachedDynamicContext?: string;

  /**
   * 消息处理串行链:所有消息严格按到达顺序处理。图片去重预判(precheckDup)
   * 是每条消息内部的异步等待点,不排队会导致连续到达的消息乱序落库。
   */
  private msgChain: Promise<void> = Promise.resolve();

  constructor(cfg: QQWorldConfig, deps?: QQWorldDeps) {
    this.cfg = cfg;
    this.timezone = cfg.timezone ?? SYSTEM_TIMEZONE;
    this.vision = deps?.vision;
    this.imageCapture = deps?.imageCapture ?? VISION_DEFAULTS;
    this.gate = deps?.gate;
    this.watchedGroups = new Set(cfg.groups);
    this.watchedPrivates = new Set(cfg.privates);
  }

  private readonly gate?: QQGatePanelDeps;

  /** 被动识图在视觉服务可用时启用；识图描述写入事件库作为可检索记忆。 */
  private passiveEnabled(): boolean {
    return !!this.vision;
  }

  /**
   * 去重预判在消息渲染前就有结果时,直接内联进这条消息(不走占位+异步事件)。
   * meta 来自 VisionService.precheckDup：dup_of 表示命中去重，ok=false 表示下载失败。
   */
  private inlineVisionText(
    id: string,
    gifMark: string,
    meta: Record<string, unknown>,
    label = '图片',
  ): string {
    if (meta.dup_of) {
      return `[${label} ${id}${gifMark}，与 ${meta.dup_of} 是同一张图，已识别过(沿用其描述)]`;
    }
    return `[${label} ${id}${gifMark} 识别失败]`;
  }


  /** 当前监听集合(web面板读取用) */
  getWatched(): { groups: number[]; privates: number[] } {
    return { groups: [...this.watchedGroups], privates: [...this.watchedPrivates] };
  }

  /**
   * 连接与身份快照(web「QQ 接入」WebUI 的连接状态卡数据源)。
   * 断线期间 connected=false,但 selfId/群名沿用上次身份;私聊名字随消息填充。
   */
  getConnection(): {
    connected: boolean;
    selfId: number | null;
    nickname: string;
    groups: Array<{ id: number; name: string; card: string }>;
    privates: Array<{ id: number; name: string }>;
  } {
    const idn = this.driver?.identity;
    return {
      connected: this.driver?.connected ?? false,
      selfId: idn?.selfId ?? null,
      nickname: idn?.nickname ?? '',
      groups: [...this.watchedGroups].map((id) => {
        const g = idn?.groups.get(id);
        return { id, name: g?.groupName ?? String(id), card: g?.card ?? '' };
      }),
      privates: [...this.watchedPrivates].map((id) => ({
        id,
        name: this.nameByUserId.get(String(id)) ?? '',
      })),
    };
  }

  /**
   * 热改监听集合(roster 里 enabled 的子集)。新群的身份在下次重连(或已连接时
   * 的后台刷新)时补齐;私聊名字随后续消息自然填充。进入/离开监听的每个 id
   * 各推一条 qq.watch 事件——监听名单变化属于环境事件,不静默修改。
   */
  setWatched(groups: number[], privates: number[]): void {
    const oldGroups = this.watchedGroups;
    const oldPrivates = this.watchedPrivates;
    const newGroups = new Set(groups.filter((g) => Number.isFinite(g)));
    const newPrivates = new Set(privates.filter((p) => Number.isFinite(p)));

    this.watchedGroups = newGroups;
    this.watchedPrivates = newPrivates;
    this.cachedDynamicContext = undefined;
    this.driver?.setGroups([...newGroups]);
    this.log.info('监听配置已更新', {
      groups: [...newGroups],
      privates: [...newPrivates],
    });

    this.announceWatchDiff('group', oldGroups, newGroups);
    this.announceWatchDiff('private', oldPrivates, newPrivates);
  }

  /** 推送监听集合的差集通知:每个进入/离开监听的id各一条qq.watch事件 */
  private announceWatchDiff(kind: 'group' | 'private', before: Set<number>, after: Set<number>): void {
    if (!this.host) return;
    for (const id of after) if (!before.has(id)) this.pushWatchEvent(kind, id, true);
    for (const id of before) if (!after.has(id)) this.pushWatchEvent(kind, id, false);
  }

  private pushWatchEvent(kind: 'group' | 'private', id: number, joined: boolean): void {
    const host = this.host!;
    const label = kind === 'group' ? `群(群号${id})` : `私聊(QQ号${id})`;
    host.pushEvent({
      type: 'qq.watch',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[系统] ${label} ${joined ? '已加入监听' : '已从监听移除'}`,
      senderKey: String(id),
      meta: { conv: { kind, id } },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }


  /**
   * 会话清单与自身账号两个洞。措辞(含"下面是你正在参与的会话:"那句和两条降级
   * 文案)全在 ENV_PROMPT.md 里,这里只算值。
   *
   * 三态,中间那态是有意的:**掉线时沿用断线前的群名快照**。若把群名换成"未知",
   * 整段前缀内容就变了,前缀缓存全部失效、下一次调用要重新 prefill 一整份 system。
   * 为省这个钱才留着旧快照——别当成可以顺手简化掉的分支。
   */
  envPromptVars(): Record<string, string> {
    const idn = this.driver?.identity;
    if (!idn && this.cachedDynamicContext !== undefined) {
      return { 'qq.conversations': this.cachedDynamicContext, 'qq.identity': '' };
    }
    const lines: string[] = [];
    for (const gid of this.watchedGroups) {
      const g = idn?.groups.get(gid);
      lines.push(
        g
          ? `- 群「${g.groupName}」(群号${gid});你在这个群的昵称是「${g.card}」`
          : `- 群(群号${gid});群信息尚未就绪`,
      );
    }
    if (this.watchedPrivates.size > 0) {
      const names = [...this.watchedPrivates].map((uid) => {
        const n = this.nameByUserId.get(String(uid));
        return n ? `${n}(${uid})` : String(uid);
      });
      lines.push(`- 私聊:${names.join('、')}`);
    }
    const conversations = lines.join('\n');
    if (idn) this.cachedDynamicContext = conversations;
    return {
      'qq.conversations': conversations,
      'qq.identity': idn ? `你的QQ号是${idn.selfId}。` : '',
    };
  }

  /**
   * WebUI 里露出什么:连接状态徽标 + 本 World 的三个专用面板 + 视觉旋钮。
   * WebUI 不认识 'qq' 这个 id,它只照这份声明渲染。
   */
  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const conn = this.getConnection();
    return {
      label: t.moduleLabel,
      // 两条链路各一颗:协议端连着没有、监听名单空不空。
      //
      // 接入门关着 = 灰(拨下来的);开着却连不上协议端 = 红:这个渠道存在的全部意义
      // 就是连着那个协议端,连不上就是她在 QQ 上失联了。名单空着不算故障,但那时候
      // 连着也收不到任何消息——所以它值一颗自己的灯。
      lamps: [
        {
          label: t.endpoint,
          ...(this.gate?.enabled() === false
            ? { state: 'offline' as const, hint: t.gateClosed }
            : conn.connected
              ? { state: 'online' as const, hint: conn.nickname || String(conn.selfId ?? '') }
              : { state: 'error' as const, hint: t.disconnected }),
        },
        {
          label: t.watch,
          ...(conn.groups.length + conn.privates.length > 0
            ? {
                state: 'online' as const,
                hint: t.watchCounts(conn.groups.length, conn.privates.length),
              }
            : { state: 'offline' as const, hint: t.rosterEmpty }),
        },
      ],
      badges: [
        {
          label: t.endpoint,
          value: conn.connected ? t.connectedAs(String(conn.nickname || conn.selfId || '')) : t.disconnected,
          tone: conn.connected ? 'on' : 'off',
        },
        { label: t.watch, value: t.watchCounts(conn.groups.length, conn.privates.length) },
      ],
      // 局部 id + 真标题(WebUI 把 title 画成面板切换页签);渲染在
      // src/worlds/qq/webui/ 的自有浏览器扩展里,中央前端不认识这三个名字。
      panels: [
        { id: 'gate', title: t.gatePanelTitle, description: t.gatePanelDescription },
        { id: 'roster', title: t.rosterPanelTitle, description: t.rosterPanelDescription },
        { id: 'events', title: t.eventsPanelTitle, description: t.eventsPanelDescription },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args, language),
      promptDocs: [
        {
          key: 'worlds.qq.envPrompt',
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            {
              name: 'qq.conversations',
              description: t.conversationsVarDescription,
              multiline: true,
            },
            {
              name: 'qq.identity',
              description: t.identityVarDescription,
            },
          ],
        },
      ],
      config: [qqConfigGroup(language)],
      ...(this.vision ? { storage: [this.visionStorage(this.vision, language)] } : {}),
    };
  }

  /** 辅助视觉的缓存(图片字节 + 被动描述 + 追问 session)作为可清除存储上报。 */
  private visionStorage(vision: VisionService, language: Language): StoragePart {
    const t = text(language);
    return {
      key: 'vision',
      label: t.visionStorageLabel,
      kind: 'disk',
      location: 'data/vision/',
      note: t.visionStorageNote,
      stat: () => t.visionStorageStat(vision.imageCount()),
      clear: () => t.visionStorageCleared(vision.clear()),
    };
  }

  /**
   * 面板调用按 (panel, method, args) 透传；panel 为 webUi() 声明中的局部 id。
   */
  private async invokePanel(panel: string, method: string, args: unknown[], language: Language): Promise<unknown> {
    const t = text(language);
    if (panel === 'gate') return this.invokeGate(method, args, t);
    if (panel === 'roster') return this.invokeRoster(method, args, t);
    if (panel === 'events') return this.invokeEvents(method, args, t);
    throw new Error(t.unknownPanel(panel));
  }

  /**
   * 会话名字快照(群名/我的群昵称/私聊称呼)。roster 与 events 两个面板都要拿它
   * 把号码渲染成人看得懂的名字,而 `ctx.invoke` 只能打到**本面板**——所以两边
   * 各开一个 `names`,而不是让它们去借 gate 的 `state`。
   */
  private convNames(): {
    groups: Array<{ id: number; name: string; card: string }>;
    privates: Array<{ id: number; name: string }>;
  } {
    const conn = this.getConnection();
    return { groups: conn.groups, privates: conn.privates };
  }

  private async invokeGate(method: string, args: unknown[], t: QQText): Promise<unknown> {
    const gate = this.gate;
    if (!gate) throw new Error(t.gateUnavailable);
    if (method === 'state') {
      const conn = this.getConnection();
      const roster = gate.roster();
      return {
        enabled: gate.enabled(),
        wsUrl: gate.wsUrl(),
        tokenSet: gate.tokenSet(),
        connected: conn.connected,
        selfId: conn.selfId,
        nickname: conn.nickname,
        groups: conn.connected || conn.groups.length > 0
          ? conn.groups
          : enabledRosterIds(roster.groups).map((id) => ({ id, name: String(id), card: '' })),
        privates: conn.connected || conn.privates.length > 0
          ? conn.privates
          : enabledRosterIds(roster.privates).map((id) => ({ id, name: '' })),
      };
    }
    if (method === 'setEnabled') {
      const enabled = args[0];
      if (typeof enabled !== 'boolean') throw new Error(t.enabledNotBoolean);
      gate.setEnabled(enabled);
      this.log.warn('QQ 接入开关已改,即将重启', { enabled });
      this.scheduleGateRestart(gate);
      return { ok: true, restarting: true, enabled };
    }
    if (method === 'setConnection') {
      const wsUrl = typeof args[0] === 'string' ? args[0].trim() : '';
      const token = typeof args[1] === 'string' ? args[1] : '';
      if (!/^wss?:\/\/.+/i.test(wsUrl)) throw new Error(t.badWsUrl);
      gate.setConnection(wsUrl, token);
      this.log.warn('协议端连接配置已改,即将重启', { wsUrl, tokenChanged: token !== '' });
      this.scheduleGateRestart(gate);
      return { ok: true, restarting: true };
    }
    throw new Error(t.unknownMethod(`gate.${method}`));
  }

  /** HTTP 响应冲刷后再写重启标志并退出进程。 */
  private scheduleGateRestart(gate: QQGatePanelDeps): void {
    setTimeout(() => {
      try { gate.restart(); } catch (err) { this.log.error('触发重启失败', { error: String(err) }); }
    }, 300);
  }

  private async invokeRoster(method: string, args: unknown[], t: QQText): Promise<unknown> {
    // 名字快照不依赖装配层的 gate 数据面:名单读不出来的时候,至少还能显示名字
    if (method === 'names') return this.convNames();
    const gate = this.gate;
    if (!gate) throw new Error(t.rosterUnavailable);
    if (method === 'get') return gate.roster();
    if (method === 'set') {
      const coerce = (raw: unknown, field: string): QQRosterEntry[] => {
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) throw new Error(t.rosterNotArray(field));
        const out: QQRosterEntry[] = [];
        const seen = new Set<number>();
        for (const item of raw) {
          if (!item || typeof item !== 'object') throw new Error(t.rosterItemNotObject(field));
          const id = Number((item as Record<string, unknown>).id);
          if (!Number.isInteger(id) || id <= 0) {
            throw new Error(t.rosterBadId(field, String((item as Record<string, unknown>).id)));
          }
          if (seen.has(id)) throw new Error(t.rosterDuplicate(field, id));
          seen.add(id);
          out.push({ id, enabled: (item as Record<string, unknown>).enabled !== false });
        }
        return out;
      };
      const groups = coerce(args[0], 'groups');
      const privates = coerce(args[1], 'privates');
      const result = gate.setRoster(groups, privates);
      this.log.warn('QQ监听配置已修改', { groups, privates });
      return { ok: true, result, config: gate.roster() };
    }
    throw new Error(t.unknownMethod(`roster.${method}`));
  }

  /** 事件历史按会话分组(读事件库 source=qq;World 未启动时不可用) */
  private async invokeEvents(method: string, args: unknown[], t: QQText): Promise<unknown> {
    if (method === 'names') return this.convNames();
    if (method !== 'list') throw new Error(t.unknownMethod(`events.${method}`));
    const store = this.host?.store;
    if (!store) throw new Error(t.notStarted);
    const opts = (args[0] ?? {}) as { conv?: unknown; limit?: unknown };
    for (const e of store.range({ source: this.id, fromCursor: this.summarizedCursor + 1 })) this.summarize(e);
    this.summarizedCursor = store.latestCursor();
    const conversations = [...this.convSummary.values()].sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));

    const convRaw = typeof opts.conv === 'string' ? opts.conv.trim() : '';
    const conv = convRaw ? parseConversationAddress(convRaw) : null;
    const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 300));
    const events = convRaw && !conv ? [] : readLatest(store, { source: this.id }, conv, limit);
    const lean = events.map((e) => ({
      cursor: e.cursor,
      type: e.type,
      ts: e.ts,
      text: e.text,
      senderKey: e.senderKey,
      senderName: (e.meta?.sender_name as string | undefined) ?? '',
      conv: e.meta?.conv ?? null,
    }));
    return { conversations, events: lean, total: this.summarizedTotal };
  }


  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log;
    this.loadThreads();
    this.loadNames();
    // 背景只在同会话有实际投递时搭车，不单独启动模型。
    // 外挂视觉的用量自愿上报进 core 的成本账(不报就在成本页看不到)
    this.vision?.setUsageSink((usage, model) =>
      host.reportUsage(usage, { model, label: 'QQWorld·辅助视觉' }),
    );
    this.rebuildMaps();
    this.continuations = new QQContinuations(this.cfg.dataDir);
    for (const task of this.continuations.list()) {
      const events = host.store.range({ source: this.id });
      const completed = events.find((e) => e.type === 'qq.self' && e.meta?.continuation_completed === task.id);
      if (completed) { this.continuations.finish(task.id, 'completed'); continue; }
      if (task.status === 'ready' && !events.some((e) => e.type === 'qq.continuation' && e.meta?.continuation_id === task.id)) {
        this.continuations.requeue(task.id);
      }
      if (task.status !== 'prepared') continue;
      const sent = events.find((e) => e.type === 'qq.self' && e.meta?.continuation_started === task.id);
      if (sent) this.continuations.activate(task.id, Date.parse(sent.ts));
      else this.continuations.uncertain(task.id);
    }
    this.seedNames();

    const driver = new OneBotDriver({
      wsUrl: this.cfg.wsUrl,
      groups: [...this.watchedGroups],
      token: this.cfg.token,
      log: this.log.child('driver'),
      reconnectBaseMs: this.cfg.reconnectBaseMs,
      reconnectMaxMs: this.cfg.reconnectMaxMs,
      apiTimeoutMs: this.cfg.apiTimeoutMs,
    });
    this.driver = driver;
    driver.onEvent((ev) => this.handleEvent(ev));
    driver.onReady(() => {
      this.pttTextAction = undefined;
      this.envPromptVars(); // 为副作用调用:趁 identity 在,把群名快照存进缓存
      this.log.info('身份就绪', { context: this.cachedDynamicContext });
      // 首连的补齐由 start() 自己等结果,保证事件赶在开场句之前;
      // 这里只处理运行期掉线后的重连。
      if (this.started) void this.catchUp();
    });
    await driver.start();
    await this.catchUp();
    this.started = true;
    this.continuationTimer = setInterval(() => this.deliverContinuations(), 1000);
    this.continuationTimer.unref?.();
    this.deliverContinuations();
  }

  async stop(): Promise<void> {
    if (this.continuationTimer) clearInterval(this.continuationTimer);
    this.continuationTimer = null;
    this.queuedContinuations.clear();
    if (this.fragmentTimer) {
      clearTimeout(this.fragmentTimer);
      this.fragmentTimer = null;
    }
    this.pendingFragments = [];
    await this.driver?.stop();
    this.turnParticipants.clear();
    this.turnReplies.clear();
    this.quietByThread.clear();
    this.lastDeliveredSpeakerByConv.clear();
  }

  /**
   * 补齐离线期间错过的消息。断线时协议端照常收消息,只是没人去要。
   *
   * 只投一条摘要:不在场和不在场期间有人找你,是两个不同的事实。逐条补投会变成
   * "一个人艾特、回复一窝人";完全不补则等于把这段经历抹掉。所以这里按会话补拉,
   * 只把叫到 bot 的那几句合成一条事件,其余只计数。
   */
  private async catchUp(): Promise<void> {
    const host = this.host;
    const driver = this.driver;
    if (!host || !driver || this.cfg.catchupOnStart === false) return;
    const count = Math.max(1, Math.min(200, this.cfg.catchupMaxMessages ?? 60));
    const missed: Array<{ conv: Conv; msg: OneBotGroupMessage }> = [];

    for (const id of this.watchedGroups) {
      if (!this.knownConvs.has(`group:${id}`)) continue;
      const conv: Conv = { kind: 'group', id };
      try {
        const data = await driver.callApi('get_group_msg_history', { group_id: id, count });
        for (const msg of this.missedMessages(data, conv)) {
          if (!this.isBlocked(msg.user_id)) missed.push({ conv, msg });
        }
      } catch (e) {
        this.log.warn('补拉群历史失败', { group: id, err: String(e) });
      }
    }
    for (const id of this.watchedPrivates) {
      if (!this.knownConvs.has(`private:${id}`)) continue;
      const conv: Conv = { kind: 'private', id };
      try {
        const data = await driver.callApi('get_friend_msg_history', { user_id: id, count });
        for (const msg of this.missedMessages(data, conv)) {
          if (!this.isBlocked(msg.user_id)) missed.push({ conv, msg });
        }
      } catch (e) {
        this.log.warn('补拉私聊历史失败', { user: id, err: String(e) });
      }
    }
    if (missed.length === 0) return;
    missed.sort((a, b) => (a.msg.time ?? 0) - (b.msg.time ?? 0));

    // 补拉过的消息号要记住（内存 + 随摘要事件落库），否则下次重启会把同一段空窗再播一遍，
    // 她会把已经答过的话再答一次（2026-10-25 线上实际发生过）。
    for (const { conv, msg } of missed) {
      this.seenMessages.add(String(msg.message_id));
      this.knownConvs.add(`${conv.kind}:${conv.id}`);
    }

    const idn = driver.identity;
    const selfId = idn?.selfId ?? -1;
    const addressed: Array<{ conv: Conv; msg: OneBotGroupMessage; text: string }> = [];
    for (const { conv, msg } of missed) {
      const selfName = conv.kind === 'group'
        ? idn?.groups.get(conv.id)?.card || idn?.nickname || '你'
        : idn?.nickname || '你';
      const { text, mentionedSelf } = renderIncoming(msg, {
        selfId,
        selfName,
        timezone: this.timezone,
        convLabel: this.convLabel(conv),
        knowsMessage: () => false,
        nameOf: (qq) => this.nameByUserId.get(qq),
        renderImage: () => '[图片]',
        renderJsonCard: () => '[json]',
        recordText: '[语音]',
      });
      if (!mentionedSelf && this.matchWakeName(renderSegmentsPlain(msg.message.filter((segment) => segment.type === 'text'))) === null) continue;
      const key = String(msg.user_id);
      this.nameByUserId.set(key, msg.sender?.card || msg.sender?.nickname || key);
      const renamed = this.noteName(key, msg.sender?.card ?? '', msg.sender?.nickname ?? '');
      if (renamed) void this.emitRename(key, renamed.from, renamed.to);
      addressed.push({ conv, msg, text });
    }
    if (addressed.length === 0) {
      this.log.info('离线期间没有叫到你的消息', { missed: missed.length });
      return;
    }

    // 有人叫过,就说明这段空窗和它有关系:线索照常开,之后的消息仍会唤醒。
    for (const { conv, msg } of addressed) {
      const convKey = `${conv.kind}:${conv.id}`;
      this.knownConvs.add(convKey);
      this.openThread(convKey, String(msg.user_id));
    }

    const at = (seconds: number | undefined) => shortTime(this.timezone, new Date((seconds ?? 0) * 1000));
    const first = missed[0].msg.time;
    const last = missed[missed.length - 1].msg.time;
    const rest = missed.length - addressed.length;
    const text = [
      `[你离线期间的消息 ${at(first)}–${at(last)}，共 ${missed.length} 条，其中 ${addressed.length} 条在叫你]`,
      ...addressed.map((item) => item.text),
      ...(rest > 0 ? [`[其余 ${rest} 条没有叫你，没有列出来]`] : []),
      // 这批东西是过去的：就地提醒一句，比把它写在常驻提示里更不容易忽略。
      '[这些是你不在这段时间里发生的事。先说明自己刚回来，再挑最该回的那一条回应；不必逐条补答，也不要问「你们刚才在聊什么」。]',
    ].join('\n');

    // 首连发生在主循环之前,事件会排在总线里等开场句一起投;运行期重连时主循环已在,直接投。
    // 补投只处理上一次进程留下的事件,所以两种时序都只会投一次。
    await host.pushEvent(
      {
        type: 'qq.catchup',
        ts: nowIso(this.timezone),
        source: this.id,
        text,
        senderKey: String(addressed[addressed.length - 1].msg.user_id),
        meta: {
          wake: 'catchup',
          missed: missed.length,
          addressed: addressed.length,
          // 这段空窗里见过的消息号：下次重启重建映射时要认得出它们不是新的。
          message_ids: missed.map(({ msg }) => String(msg.message_id)).slice(0, 200),
        },
      },
      { trigger: 'flush' },
    );
    this.log.info('已补齐离线消息', { missed: missed.length, addressed: addressed.length });
  }

  /** 把 `get_*_msg_history` 的返回整理成消息;跳过自己发的与已经入库的。 */
  private missedMessages(data: unknown, conv: Conv): OneBotGroupMessage[] {
    const list = (data as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(list)) return [];
    const selfId = this.driver?.identity?.selfId;
    const out: OneBotGroupMessage[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const msg = raw as Partial<OneBotGroupMessage> & { message?: unknown; raw_message?: unknown };
      const id = Number(msg.message_id);
      if (!Number.isFinite(id) || this.knownMessages.has(String(id)) || this.seenMessages.has(String(id))) continue;
      if (selfId !== undefined && Number(msg.user_id) === Number(selfId)) continue;
      const segments: Segment[] = Array.isArray(msg.message)
        ? (msg.message as Segment[])
        : [{ type: 'text', data: { text: String(msg.raw_message ?? '') } }];
      out.push({
        post_type: 'message',
        message_type: conv.kind === 'group' ? 'group' : 'private',
        ...(conv.kind === 'group' ? { group_id: conv.id } : {}),
        user_id: Number(msg.user_id),
        message_id: id,
        ...(typeof msg.time === 'number' ? { time: msg.time } : {}),
        ...(msg.sender && typeof msg.sender === 'object' ? { sender: msg.sender } : {}),
        message: segments,
        ...(typeof msg.raw_message === 'string' ? { raw_message: msg.raw_message } : {}),
      });
    }
    return out;
  }

  /** 记一条背景消息;只保留最近 N 条,避免摘要无限增长。 */
  private rememberAmbient(text: string, convKey: string, senderKey: string, messageId?: string, blobs?: BlobRef[]): void {
    this.ambient.push({ ts: nowIso(this.timezone), text, convKey, senderKey, messageId, blobs });
    const max = Math.max(1, this.cfg.ambientMaxMessages ?? 20);
    const sameConv = this.ambient.filter((entry) => entry.convKey === convKey);
    if (sameConv.length > max) {
      const remove = new Set(sameConv.slice(0, sameConv.length - max));
      this.ambient = this.ambient.filter((entry) => !remove.has(entry));
    }
  }

  /** 对话线索:叫到 bot 或 bot 回过某人时开启,之后此人再说话就算继续这条线,不设过期。 */
  private threadKey(convKey: string, senderKey: string): string {
    return `${convKey}|${senderKey}`;
  }

  private isThreadOpen(convKey: string, senderKey: string): boolean {
    return this.threads.get(this.threadKey(convKey, senderKey))?.open === true;
  }

  private threadHotMs(): number {
    const minutes = Number(this.cfg.threadHotMinutes ?? 360);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 0) * 60_000;
  }

  /**
   * 这条线索还热着吗——判的是**她**最后一次开口，不是他最后一句。
   *
   * 用"他最后说话"当热度的话，一个话多的人能让线索永远热着：跟他说过一次话，
   * 就等于订阅了他之后说的每一句群消息。
   */
  private isThreadWarm(convKey: string, senderKey: string): boolean {
    const state = this.threads.get(this.threadKey(convKey, senderKey));
    if (!state?.open) return false;
    return Date.now() - (state.warmAt ?? state.openedAt) <= this.threadHotMs();
  }

  /** 她在这条线索里开了口：重新焐热。 */
  private touchThread(convKey: string, senderKey: string): void {
    const state = this.threads.get(this.threadKey(convKey, senderKey));
    if (!state?.open) return;
    state.warmAt = Date.now();
    this.saveThreads();
  }

  private openThread(convKey: string, senderKey: string): void {
    const key = this.threadKey(convKey, senderKey);
    const prev = this.threads.get(key);
    if (prev?.open) {
      prev.lastMessageAt = Date.now();
      return;
    }
    this.threads.set(key, { open: true, openedAt: Date.now(), lastMessageAt: Date.now(), warmAt: Date.now() });
    this.saveThreads();
  }

  /** 管理页:开着的线索快照。`person` 是 QQ 号;`personName` 只是当前昵称,用于显示。 */
  threadSnapshot(): Array<{ conv: string; person: string; personName: string; openedAt: number; lastMessageAt: number }> {
    return [...this.threads.entries()]
      .filter(([, state]) => state.open)
      .map(([key, state]) => {
        const [conv, person] = key.split('|');
        return {
          conv,
          person,
          personName: this.nameByUserId.get(person) ?? '',
          openedAt: state.openedAt,
          lastMessageAt: state.lastMessageAt,
        };
      })
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  /** 管理页:手动关线;返回是否真的关了。 */
  closeThreadForOperator(conv: string, person: string): boolean {
    return this.closeThread(conv, person);
  }

  /**
   * 某个会话最近的消息，只读事件库。
   *
   * 群里没叫到 bot 的消息是 archive-only，不会进 Persona 的投递批次；
   * 但"这帮人正在聊什么"恰恰只能从这些消息里看出来。所以由 World 提供给你。
   */
  recentMessages(convKey: string, limit = 20): Array<{ at: number; from: string; text: string }> {
    const store = this.host?.store;
    if (!store) return [];
    const [kind, rawId] = convKey.split(':');
    const id = Number(rawId);
    if (!kind || !Number.isFinite(id)) return [];
    const out: Array<{ at: number; from: string; text: string }> = [];
    const events = store.range({ source: this.id });
    for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = events[i];
      if (e.type !== 'qq.message' || e.origin !== 'external') continue;
      const conv = e.meta?.conv as { kind?: string; id?: number } | undefined;
      if (!conv || conv.kind !== kind || Number(conv.id) !== id) continue;
      out.push({
        at: Date.parse(e.ts),
        from: String(e.meta?.user_id ?? e.senderKey ?? ''),
        // 正文形如 `#123 [群「…」 17:49] 名字(123): 内容`，只留内容。
        text: (e.text ?? '').replace(/^#\d+\s+\[[^\]]*\]\s+/, '').replace(/^[^:：]{1,40}[：:]\s*/, '').slice(0, 200),
      });
    }
    return out.reverse();
  }

  /** 管理页:背景摘要状态。 */
  ambientStatus(): { enabled: boolean; intervalMinutes: number; buffered: number } {    return {
      enabled: false,
      intervalMinutes: 0,
      buffered: this.ambient.length,
    };
  }

  private closeThread(convKey: string, senderKey: string): boolean {
    const key = this.threadKey(convKey, senderKey);
    const prev = this.threads.get(key);
    if (!prev?.open) return false;
    this.threads.set(key, { ...prev, open: false });
    this.saveThreads();
    return true;
  }

  private threadFile(): string | null {
    return this.cfg.dataDir ? join(this.cfg.dataDir, 'qq-threads.json') : null;
  }

  private loadThreads(): void {
    this.threadsFile = this.threadFile();
    if (!this.threadsFile || !existsSync(this.threadsFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.threadsFile, 'utf8')) as Record<string, { open?: boolean; openedAt?: number; lastMessageAt?: number; warmAt?: number }>;
      for (const [key, value] of Object.entries(raw)) {
        if (value?.open !== true) continue;
        const openedAt = Number(value.openedAt ?? 0);
        this.threads.set(key, {
          open: true,
          openedAt,
          lastMessageAt: Number(value.lastMessageAt ?? 0),
          // 老文件没有 warmAt：用最后一次消息时间兜底——最近还聊着的线不会一升级就断，
          // 放了几天的那批（8 天前开的）则直接算冷。
          warmAt: Number(value.warmAt ?? value.lastMessageAt ?? openedAt),
        });
      }
    } catch (err) {
      this.log?.warn('对话线索读取失败', { error: String(err) });
    }
  }

  private saveThreads(): void {
    const file = this.threadsFile ?? this.threadFile();
    if (!file) return;
    this.threadsFile = file;
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.threads)), 'utf8');
      renameSync(tmp, file);
    } catch (err) {
      this.log?.warn('对话线索写入失败', { error: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // 房间：可数的形状由 room.ts 算，她的判断存在这里
  // ---------------------------------------------------------------------------

  private roomNotesPath(): string | null {
    return this.cfg.dataDir ? join(this.cfg.dataDir, 'qq-room-notes.json') : null;
  }

  private loadRoomNotes(): void {
    if (this.roomNotesLoaded) return;
    this.roomNotesLoaded = true;
    const file = this.roomNotesPath();
    this.roomNotesFile = file;
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { notes?: RoomNote[] };
      const now = Date.now();
      this.roomNotes = (raw.notes ?? []).filter(
        (n): n is RoomNote => !!n && typeof n.label === 'string' && typeof n.expiresAt === 'number' && n.expiresAt > now,
      );
    } catch (err) {
      this.log?.warn('群判断读取失败', { error: String(err) });
    }
  }

  private saveRoomNotes(): void {
    const file = this.roomNotesFile ?? this.roomNotesPath();
    if (!file) return;
    this.roomNotesFile = file;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, notes: this.roomNotes }, null, 1), 'utf8');
      renameSync(tmp, file);
    } catch (err) {
      this.log?.warn('群判断写入失败', { error: String(err) });
    }
  }

  /** 记下她对一个群的判断；同一会话只留最新的一条。 */
  markRoom(conv: string, label: string, note: string, minutes: number, now = Date.now()): RoomNote | null {
    this.loadRoomNotes();
    const text = label.trim().slice(0, 24);
    if (!text) return null;
    const ttl = Math.min(720, Math.max(5, Math.round(Number.isFinite(minutes) ? minutes : 90)));
    const entry: RoomNote = {
      conv,
      label: text,
      note: note.trim().slice(0, 120),
      at: now,
      expiresAt: now + ttl * 60_000,
    };
    this.roomNotes = [...this.roomNotes.filter((n) => n.conv !== conv && n.expiresAt > now), entry].slice(-20);
    this.saveRoomNotes();
    // 判断换了，下一批就该把新的那一行带上，别因为数字没变而压掉。
    this.lastRoomLine.delete(conv);
    return entry;
  }

  /** 这个群当前还有效的判断；过期的顺手清掉。 */
  roomNoteFor(conv: string, now = Date.now()): RoomNote | null {
    this.loadRoomNotes();
    if (this.roomNotes.some((n) => n.expiresAt <= now)) {
      this.roomNotes = this.roomNotes.filter((n) => n.expiresAt > now);
      this.saveRoomNotes();
    }
    let latest: RoomNote | null = null;
    for (const note of this.roomNotes) {
      if (note.conv === conv && (!latest || note.at > latest.at)) latest = note;
    }
    return latest;
  }

  /**
   * 发出去之后补一句当时的形状。
   *
   * 只陈述、不拦截：她已经有「群里此刻」那一行，这里只是在真的插进一场热闹时
   * 告诉她插在了哪儿——扣下草稿等于替她做决定。
   */
  private roomAside(conv: string): string | null {
    const cfg = this.roomSettings();
    if (!cfg.enabled || !conv.startsWith('group:')) return null;
    const facts = this.room.facts(conv, Date.now(), cfg);
    if (facts.heat === 'flood') {
      return `[room] 这会儿 ${facts.messages} 条挤在 ${Math.round(cfg.windowMinutes)} 分钟里、${facts.speakers} 个人在说，你这条发得很快。`;
    }
    if (facts.speakers >= 3 && facts.replyShare >= 0.4) {
      return `[room] 这会儿 ${facts.speakers} 个人在互相接话，你这条插在中间。`;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 改名：群友会改昵称，记忆与档案不该跟着冻结
  // ---------------------------------------------------------------------------

  private namesPath(): string | null {
    return this.cfg.dataDir ? join(this.cfg.dataDir, 'qq-names.json') : null;
  }

  private loadNames(): void {
    this.namesFile = this.namesPath();
    if (!this.namesFile || !existsSync(this.namesFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.namesFile, 'utf8')) as Record<string, Partial<NameRecord>>;
      for (const [qq, value] of Object.entries(raw)) {
        if (!value || typeof value.name !== 'string' || !value.name) continue;
        this.nameLedger.set(qq, {
          name: value.name,
          card: typeof value.card === 'string' ? value.card : '',
          nickname: typeof value.nickname === 'string' ? value.nickname : '',
          since: typeof value.since === 'string' ? value.since : '',
          seenAt: typeof value.seenAt === 'string' ? value.seenAt : '',
          history: Array.isArray(value.history)
            ? value.history.filter((h): h is { name: string; from: string; to: string } =>
              Boolean(h) && typeof (h as { name?: unknown }).name === 'string')
            : [],
        });
      }
    } catch (err) {
      this.log?.warn('改名流水读取失败', { error: String(err) });
    }
  }

  private saveNames(): void {
    const file = this.namesFile ?? this.namesPath();
    if (!file) return;
    this.namesFile = file;
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.nameLedger), null, 2), 'utf8');
      renameSync(tmp, file);
      this.namesDirty = false;
    } catch (err) {
      this.log?.warn('改名流水写入失败', { error: String(err) });
    }
  }

  /**
   * 启动时用事件库里的称呼补齐流水。
   *
   * 进程不在的时候有人改名，这里不会投事件——那不是"此刻"发生的事；
   * 但旧名要进历史，否则"曾用名"会永久缺一段。
   */
  private seedNames(): void {
    const today = this.today();
    for (const [qq, name] of this.nameByUserId) {
      if (!name) continue;
      const record = this.nameLedger.get(qq);
      if (!record) {
        // 没记过的人只留在内存：流水记的是改名，不是花名册。
        this.nameLedger.set(qq, { name, card: '', nickname: '', since: '', seenAt: '', history: [] });
        continue;
      }
      if (record.name && record.name !== name) {
        record.history.push({ name: record.name, from: record.since, to: today });
        record.name = name;
        record.since = today;
        this.namesDirty = true;
      }
    }
    if (this.namesDirty) this.saveNames();
  }

  /**
   * 记一次见到的称呼；返回真的改名时才给 from/to。
   *
   * 名片被清空、回落到 QQ 昵称，不算改名——显示名变了，人没换。
   */
  private noteName(qq: string, card: string, nickname: string): { from: string; to: string } | null {
    const display = (card || nickname || '').trim();
    if (!display) return null;
    const today = this.today();
    const record = this.nameLedger.get(qq);
    if (!record) {
      this.nameLedger.set(qq, { name: display, card, nickname, since: today, seenAt: today, history: [] });
      return null;
    }
    const prevCard = record.card;
    record.card = card;
    record.nickname = nickname || record.nickname;
    record.seenAt = today;
    if (record.name === display) return null;
    if (!card && prevCard && display === record.nickname) {
      record.name = display;
      return null;
    }
    const from = record.name;
    record.history.push({ name: from, from: record.since, to: today });
    record.name = display;
    record.since = today;
    this.saveNames();
    return { from, to: display };
  }

  /** 改名事件并入下一批，不单独开一轮模型；她知道了就行，不必为此开口。 */
  private async emitRename(qq: string, from: string, to: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({
        type: 'qq.rename',
        ts: nowIso(this.timezone),
        source: this.id,
        origin: 'internal',
        text: `[改名] ${qq} 的显示名从「${from}」改成了「${to}」。档案：people/qq-${qq}.md`,
        senderKey: qq,
        meta: { user_id: qq, from, to, wake: 'rename' },
      }, { trigger: 'piggyback' });
      this.log.info('群友改名', { qq, from, to });
    } catch (err) {
      this.log?.warn('改名事件投递失败', { err: String(err) });
    }
  }

  private today(): string {
    return nowIso(this.timezone).slice(0, 10);
  }

  private handleCardChange(ev: OneBotEvent, gid: number): void {
    const qq = ev.user_id === undefined ? '' : String(ev.user_id);
    if (!qq) return;
    const card = typeof ev.card === 'string' ? ev.card : '';
    const known = this.nameLedger.get(qq);
    const display = card || known?.nickname || this.nameByUserId.get(qq) || qq;
    this.nameByUserId.set(qq, display);
    const renamed = this.noteName(qq, card, known?.nickname ?? '');
    if (renamed) void this.emitRename(qq, renamed.from, renamed.to);
    this.log.debug('群名片变更', { group: gid, qq, card });
  }

  /** 运行时追加的唤醒名（来自她自己的术语表），与配置里的 wakeNames 合并使用。 */
  private extraWakeNames: string[] = [];

  /** 每个群会话里连续来自同住 AI 的消息条数；真人一开口就清零。 */
  private readonly siblingRun = new Map<string, number>();

  /** 超出预算后，上一拍被同住 AI 叫醒的时刻；用来给互接降速，而不是彻底静音。 */
  private readonly siblingLastWakeAt = new Map<string, number>();

  /** 追加唤醒名；重复的忽略。属于人格自己的数据，不写回配置。 */
  addWakeNames(names: readonly string[]): void {
    for (const raw of names) {
      const name = raw.trim();
      if (name && !this.extraWakeNames.includes(name)) this.extraWakeNames.push(name);
    }
  }

  private matchWakeName(text: string): string | null {
    if (!this.cfg.wakeOnName) return null;
    const names = [...(this.cfg.wakeNames ?? []), ...this.extraWakeNames];
    return matchWakeName(text, names, this.cfg.wakeNameMinChars ?? 3, this.cfg.wakeNameFuzzy !== false);
  }

  // -------------------------------------------------------------------------
  // 注意力显著性
  // -------------------------------------------------------------------------

  /** 当前注意力配置（热读，改配置不用重启 World）。 */
  attentionSettings(): AttentionConfig {
    return resolveAttention(this.cfg.attention);
  }

  roomSettings(): RoomConfig {
    return roomConfig(this.cfg.room);
  }

  /** 某个会话此刻的形状（供人格层判定读；数字是现算的，不是上一批消息时的快照）。 */
  roomFacts(conv: string): Record<string, unknown> {
    const cfg = this.roomSettings();
    const facts = this.room.facts(conv, Date.now(), cfg);
    return { ...roomDigest(facts), line: describeRoom(facts, cfg, { nameOf: (qq) => this.nameByUserId.get(qq) }) };
  }

  /** 最近的判决，新的在前。面板用它回答"为什么没注意"。 */
  attentionLog(limit = 40): AttentionEntry[] {
    this.loadAttention();
    return this.attention.slice(-Math.max(1, Math.min(200, limit))).reverse();
  }

  /**
   * 一条群消息该怎么对待。
   *
   * 叫到她了、或者私聊 —— 永远 focus。注意力关着时保持旧行为：
   * `wakeOnMentionOnly` 开着就进背景缓冲，关着就照常投递。
   */
  private judgeAttention(input: {
    conv: Conv;
    convKey: string;
    senderKey: string;
    senderName: string;
    text: string;
    waking: boolean;
  }): { tier: AttentionTier; score: number; reasons: string[] } {
    if (input.waking) return { tier: 'focus', score: 1, reasons: ['叫到你了'] };
    if (input.conv.kind === 'private') return { tier: 'focus', score: 1, reasons: ['私聊，单独找你'] };
    // 只有一张图、没有一个字：模型收不到图像，她看不见内容。叫醒她只能猜，
    // 猜出来的“这眼神是让我别问了”比不接更糟。进背景摘要，她自己要看再看。
    if (QQWorld.isMediaOnly(input.text)) {
      return { tier: 'periphery', score: 0.5, reasons: ['只有一张图没有字，进背景摘要'] };
    }
    const cfg = this.attentionSettings();
    if (!cfg.enabled) {
      return this.cfg.wakeOnMentionOnly
        ? { tier: 'periphery', score: 0.5, reasons: ['注意力未开启，按背景缓冲'] }
        : { tier: 'focus', score: 0.5, reasons: ['注意力未开启，照常投递'] };
    }
    return scoreMessage(this.salienceFacts(input, cfg), cfg);
  }

  /** 从环形记录里取判决要的事实；不含本条（还没记进去）。 */
  private salienceFacts(input: { convKey: string; senderKey: string; text: string }, cfg: AttentionConfig): SalienceFacts {
    this.loadAttention();
    const now = Date.now();
    const since = now - cfg.windowMinutes * 60_000;
    const habituation = now - cfg.habituationMinutes * 60_000;
    const recent = this.attention.filter((e) => e.at >= since && e.convKey === input.convKey);
    const hash = normalizeForRepeat(input.text);
    const repeats = input.text.trim()
      ? this.attention.filter((e) => e.at >= habituation && e.hash === hash).length
      : 0;
    const day = this.localDay(now);
    const room = this.room.facts(input.convKey, now, this.roomSettings());
    return {
      addressed: false,
      kind: 'group',
      windowMessages: recent.length,
      senderMessages: recent.filter((e) => e.senderKey === input.senderKey).length,
      repeats,
      question: looksQuestion(input.text),
      emotional: looksEmotional(input.text),
      firstToday: !this.attention.some((e) => e.senderKey === input.senderKey && e.day === day),
      // 刚起进程时窗口是空的，`lullMinutes` 是 Infinity——打分那边按"没有上一条"处理。
      lullMinutes: room.lullMinutes,
      monologue: room.monologue,
    };
  }

  /** 本地日期，判"今天第一次见到这个人"。 */
  private localDay(at: number): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(at));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  private attentionPath(): string | null {
    return this.cfg.dataDir ? join(this.cfg.dataDir, 'qq-attention.jsonl') : null;
  }

  private loadAttention(): void {
    if (this.attentionLoaded) return;
    this.attentionLoaded = true;
    const file = this.attentionPath();
    this.attentionFile = file;
    if (!file || !existsSync(file)) return;
    try {
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-300);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AttentionEntry;
          if (entry && typeof entry.at === 'number' && typeof entry.senderKey === 'string') this.attention.push(entry);
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 读不出来当空的 */ }
  }

  private recordAttention(entry: AttentionEntry): void {
    this.loadAttention();
    this.attention.push(entry);
    if (this.attention.length > 300) this.attention.splice(0, this.attention.length - 300);
    const file = this.attentionFile ?? this.attentionPath();
    this.attentionFile = file;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch { /* 流水写不进去不影响判决 */ }
  }

  /** 唤醒时带上同一会话缓冲的背景消息。 */
  private async flushAmbientFor(host: WorldHost, convKey: string): Promise<void> {
    const lines: string[] = [];
    const blobs: BlobInput[] = [];
    this.ambient = this.ambient.filter((entry) => {
      if (entry.convKey === convKey) {
        lines.push(entry.text);
        for (const blob of entry.blobs ?? []) blobs.push({ handle: blob.handle, fallbackText: blob.fallbackText });
        return false;
      }
      return true;
    });
    if (!lines.length) return;
    this.pushRoomLine(host, convKey, this.roomSettings());
    await host.pushEvent(
      {
        type: 'qq.ambient',
        ts: nowIso(this.timezone),
        source: this.id,
        text: ['这个会话之前的几条消息(背景):', ...lines.map((line) => `- ${line}`)].join('\n'),
        meta: { wake: 'ambient', conv: parseConversationAddress(convKey) },
        ...(blobs.length ? { blobs } : {}),
      },
      { trigger: 'piggyback' },
    );
  }

  /**
   * 房间里那行事实。
   *
   * 投递那一刻才算：那时候的形状才是她要看的形状。数字没变就不再说一遍——
   * 每轮重复同一句只是白付 token，还会把真正的变化淹掉。
   */
  private pushRoomLine(host: WorldHost, convKey: string, cfg: RoomConfig): void {
    host.pushDeferred(
      {
        type: 'qq.room',
        origin: 'internal',
        meta: { conv: convKey },
        render: () => {
          const facts = this.room.facts(convKey, Date.now(), cfg);
          const line = describeRoom(facts, cfg, { nameOf: (qq) => this.nameByUserId.get(qq) });
          if (!line) return null;
          const note = this.roomNoteFor(convKey);
          // 判断只说到"是什么"，不带"几分钟前"：那个数字每过一分钟就变，会把去重打穿。
          const out = `[群里此刻] ${line}`
            + (note ? `；你的判断：${note.label}${note.note ? `——${note.note}` : ''}` : '');
          if (out === this.lastRoomLine.get(convKey)) return null;
          this.lastRoomLine.set(convKey, out);
          return out;
        },
      },
      { trigger: 'piggyback' },
    );
  }

  /**
   * 合批的边界：他是不是还在打字。
   *
   * 短、没有句末标点，或者只发了一张图——这种一条一条叫醒她，她就会抢答半句。
   */
  /** 只发了图或表情，没有一个字。语音不算：它有自己的转写，转写结果会补上正文。 */
  private static isMediaOnly(body: string): boolean {
    return /^(\[(?:图片|表情|QQ表情)[^\]]*\]\s*)+$/.test((body || '').trim());
  }

  private isFragmentBody(body: string): boolean {
    const t = (body || '').trim();
    if (!t) return true;
    if (QQWorld.isMediaOnly(t)) return true;
    return t.length <= QQWorld.FRAGMENT_MAX_CHARS && !/[。！？…!?]\s*$/.test(t);
  }

  /** 她沉默之后的短陈述：不点名、不提问，只是对方自己在往下说。 */
  private static isQuietFollowUpBody(body: string): boolean {
    const t = (body || '').trim();
    if (!t) return false;
    if (looksQuestion(t)) return false;
    return t.length <= QQWorld.QUIET_FOLLOWUP_MAX_CHARS;
  }

  /** 记下一条碎片，并把合批的钟重新上一次。 */
  private holdFragment(cursor: number): void {
    if (!this.pendingFragments.length) this.fragmentHeldSince = Date.now();
    this.pendingFragments.push(cursor);
    this.armFragmentTimer();
  }

  private armFragmentTimer(): void {
    if (this.fragmentTimer) clearTimeout(this.fragmentTimer);
    const held = Date.now() - this.fragmentHeldSince;
    const wait = Math.max(0, Math.min(QQWorld.FRAGMENT_GAP_MS, QQWorld.FRAGMENT_MAX_HOLD_MS - held));
    this.fragmentTimer = setTimeout(() => { void this.flushFragments(); }, wait);
    this.fragmentTimer.unref?.();
  }

  /** 他停下来了：把攒着的碎片按一批投出去。 */
  private async flushFragments(): Promise<void> {
    if (this.fragmentTimer) {
      clearTimeout(this.fragmentTimer);
      this.fragmentTimer = null;
    }
    const cursors = this.pendingFragments;
    this.pendingFragments = [];
    const last = cursors[cursors.length - 1];
    const host = this.host;
    if (last === undefined || !host?.promotePending) return;
    try {
      await host.promotePending(last, 'flush');
    } catch (err) {
      this.log?.warn('碎片合批投递失败', { err: String(err) });
    }
  }

  /** 测试/联调辅助:等驱动连接并完成身份初始化 */
  waitReady(timeoutMs = 10000): Promise<void> {
    if (!this.driver) return Promise.reject(new Error('World 未启动'));
    return this.driver.waitReady(timeoutMs);
  }

  /** 入站排队和归档不代表模型已读；只在实际投递确认后计入本轮。 */
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void {
    if (outcome !== 'delivered') return;
    for (const event of events) {
      if (event.source !== this.id || event.origin !== 'external' || event.type !== 'qq.message') continue;
      const conv = event.meta?.conv as Conv | undefined;
      const sender = String(event.meta?.user_id ?? event.senderKey ?? '');
      if (!conv || !sender) continue;
      const convKey = `${conv.kind}:${conv.id}`;
      const key = this.threadKey(convKey, sender);
      this.turnParticipants.add(key);
      this.turnReplies.delete(key);
      this.lastDeliveredSpeakerByConv.set(convKey, sender);
    }
  }

  onTurnEnded(): void {
    this.discardPendingDraft();
    const now = Date.now();
    for (const [key, at] of this.quietByThread) {
      if (now - at > QQWorld.QUIET_FOLLOWUP_MS) this.quietByThread.delete(key);
    }
    for (const key of this.turnParticipants) {
      if (this.turnReplies.has(key)) this.quietByThread.delete(key);
      else this.quietByThread.set(key, now);
    }
    this.turnParticipants.clear();
    this.turnReplies.clear();
  }

  discardPendingDraft(): void {
    if (this.pendingDraft) {
      this.log.debug('未确认的草稿已作废');
      this.pendingDraft = null;
    }
  }


  /** 这个号是否在操作员的黑名单里；消息和通知在入站处整条丢弃。 */
  private isBlocked(userId: unknown): boolean {
    if (userId === undefined || userId === null) return false;
    const raw = this.cfg.blacklist?.() ?? '';
    if (raw !== this.blockedRaw) {
      this.blockedRaw = raw;
      this.blockedIds = new Set(
        (raw.match(/\d+/g) ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
      );
    }
    return this.blockedIds.has(Number(userId));
  }

  private handleEvent(ev: OneBotEvent): void {
    const host = this.host;
    if (!host) return;

    if (ev.post_type === 'message') {
      // 黑名单在入站处截断：不进归档、不进背景缓冲、不唤醒。
      if (this.isBlocked(ev.user_id)) return;
      if (ev.message_type === 'group' && ev.group_id !== undefined) {
        if (this.watchedGroups.has(Number(ev.group_id))) {
          this.enqueueMessage(ev as unknown as OneBotGroupMessage, {
            kind: 'group',
            id: Number(ev.group_id),
          });
        }
        return;
      }
      if (ev.message_type === 'private' && ev.user_id !== undefined) {
        if (this.watchedPrivates.has(Number(ev.user_id))) {
          this.enqueueMessage(ev as unknown as OneBotGroupMessage, {
            kind: 'private',
            id: Number(ev.user_id),
          });
        }
        return;
      }
      return; // 其他消息类型丢弃
    }

    if (ev.post_type === 'notice') {
      // 群通知仅处理监听中的群;私聊/名单外一律丢弃
      if (ev.group_id === undefined || !this.watchedGroups.has(Number(ev.group_id))) return;
      if (this.isBlocked(ev.user_id)) return;
      const gid = Number(ev.group_id);
      switch (ev.notice_type) {
        case 'group_recall':
          this.handleRecall(ev, gid);
          return;
        case 'group_increase':
          this.handleMemberChange(ev, gid, 'join');
          return;
        case 'group_decrease':
          this.handleMemberChange(ev, gid, 'leave');
          return;
        case 'group_msg_emoji_like':
          this.handleEmojiLike(ev, gid);
          return;
        case 'group_card':
          this.handleCardChange(ev, gid);
          return;
        case 'notify':
          if (ev.sub_type === 'poke') this.handlePoke(ev, gid);
          return;
        default:
          return;
      }
    }
    // request(好友/加群请求)/meta_event(心跳)全部丢弃
  }

  /**
   * 入队一条消息:严格按到达顺序处理(见msgChain字段注释)。单条消息内部
   * 出错不冲垮后续消息——记录日志,链继续往下走。
   */
  private enqueueMessage(msg: OneBotGroupMessage, conv: Conv): void {
    this.msgChain = this.msgChain.then(() => this.handleMessage(msg, conv)).catch((e) => {
      this.log.error('消息处理异常', { err: String(e) });
    });
  }

  private async handleMessage(msg: OneBotGroupMessage, conv: Conv): Promise<void> {
    const host = this.host!;
    const idn = this.driver?.identity;
    const selfId = idn?.selfId ?? -1;

    // 自己账号的回声消息丢弃(自己说的话由 confirm(send) 回录 qq.self)
    if (Number(msg.user_id) === selfId) return;
    // 入队到处理之间名单可能刚改过：这里再挡一次，已排队的黑名单消息也不落库。
    if (this.isBlocked(msg.user_id)) return;
    // 补拉与实时推送可能重叠:已经入库的、或者补拉时已经见过的消息不再重复处理。
    if (this.knownMessages.has(String(msg.message_id)) || this.seenMessages.has(String(msg.message_id))) return;

    const senderKey = String(msg.user_id);
    const displayName = msg.sender?.card || msg.sender?.nickname || senderKey;
    this.nameByUserId.set(senderKey, displayName);
    const renamed = this.noteName(senderKey, msg.sender?.card ?? '', msg.sender?.nickname ?? '');
    if (renamed) void this.emitRename(senderKey, renamed.from, renamed.to);

    const imageDownloads = this.vision || !host.modelFacts.accepts('image/png')
      ? []
      : incomingImageUrls(msg).map((url, index) => ({
          index,
          promise: downloadImageBytes(url, this.imageCapture)
            .then((image): IncomingImageDownload => ({ image }))
            .catch((): IncomingImageDownload => ({ image: null })),
        }));

    // 图片渲染策略(外挂视觉,群/私聊同处理)。被动开启时,每张图先做一次限时的
    // 内容去重预判(下载+算hash+查重复,不跑VLM);时限内出结果(命中或下载失败)
    // 则直接内联进消息,跳过占位与异步qq.vision事件,否则显示占位符。
    const collected: Array<{ id: string; url: string }> = [];
    const earlyResolved: Array<{ text: string; meta: Record<string, unknown> } | null> = [];
    let renderImage: ImageRenderPolicy;
    let renderJsonCard: JsonCardRenderPolicy;

    if (this.vision) {
      const vision = this.vision;
      const passive = this.passiveEnabled();
      const items = (msg.message ?? [])
        .filter((seg) => seg.type === 'image')
        .map((seg) => {
          const data = seg.data ?? {};
          const url = extractImageUrl(data);
          const gif = looksLikeGif(data);
          return { url, gif, id: vision.registerImage(url, { gif }) };
        });
      const precheck =
        passive && items.length
          ? await Promise.all(items.map((it) => vision.precheckDup(it.id)))
          : items.map(() => null);

      let idx = 0;
      renderImage = () => {
        const it = items[idx];
        const early = precheck[idx];
        idx++;
        collected.push({ id: it.id, url: it.url });
        earlyResolved.push(early);
        const gifMark = it.gif ? '(GIF·仅首帧)' : '';
        if (early) return this.inlineVisionText(it.id, gifMark, early.meta);
        return passive
          ? `[图片 ${it.id}${gifMark} 正在载入VLM理解中...]`
          : `[图片 ${it.id}${gifMark}]`;
      };

      // JSON 卡片封面复用图片的去重预判与被动识图路径；下载失败由识别失败分支呈现。
      const cardItems = (msg.message ?? [])
        .filter((seg) => seg.type === 'json')
        .map((seg) => {
          const info = parseJsonCard(seg.data ?? {});
          return {
            ...info,
            id: info.previewUrl ? vision.registerImage(info.previewUrl, { gif: false }) : undefined,
          };
        });
      const cardPrecheck =
        passive && cardItems.some((it) => it.id)
          ? await Promise.all(cardItems.map((it) => (it.id ? vision.precheckDup(it.id) : null)))
          : cardItems.map(() => null);

      let cIdx = 0;
      renderJsonCard = () => {
        const it = cardItems[cIdx];
        const early = cardPrecheck[cIdx];
        cIdx++;
        const cardText = renderJsonCardText(it);
        if (!it.id) return cardText;
        collected.push({ id: it.id, url: it.previewUrl! });
        earlyResolved.push(early);
        if (early) return `${cardText} ${this.inlineVisionText(it.id, '', early.meta, '封面')}`;
        return passive
          ? `${cardText} [封面 ${it.id} 正在载入VLM理解中...]`
          : `${cardText} [封面 ${it.id}]`;
      };
    } else {
      renderImage = this.imagePolicy;
      renderJsonCard = (info) => {
        const cardText = renderJsonCardText(info);
        return cardText !== '[json]' && info.previewUrl
          ? `${cardText} ${this.imagePolicy({ url: info.previewUrl })}`
          : cardText;
      };
    }

    const selfName =
      conv.kind === 'group'
        ? idn?.groups.get(conv.id)?.card || idn?.nickname || '你'
        : idn?.nickname || '你';

    const transcribe =
      (msg.message ?? []).some((seg) => seg.type === 'record') && this.pttTextAction !== null;

    const { text, body: renderedBody, mentionedSelf, replyToMessageId } = renderIncoming(msg, {
      selfId,
      selfName,
      timezone: this.timezone,
      convLabel: this.convLabel(conv),
      knowsMessage: (mid) => this.knownMessages.has(String(mid)),
      nameOf: (qq) => this.nameByUserId.get(qq),
      renderImage,
      renderJsonCard,
      recordText: transcribe ? '[语音,正在转写中...]' : '[语音,协议端不提供转写]',
    });

    const when =
      typeof msg.time === 'number' ? new Date(msg.time * 1000) : new Date();
    // 已拿到的图随这条消息落库;无辅助视觉时,超出等待上限的图片下载完另发 qq.image,触发方式同 qq.vision。
    const blobs: BlobInput[] = [];
    let imageFailures = 0;
    const lateImages: Array<{ index: number; promise: Promise<IncomingImageDownload> }> = [];
    if (this.vision) {
      for (let i = 0; i < collected.length; i++) {
        if (!earlyResolved[i]) continue;
        const got = await this.vision.getImageBytes(collected[i].id).catch(() => null);
        if (got) blobs.push({ bytes: got.buffer, mime: got.mime, name: collected[i].id, fallbackText: `图片 ${collected[i].id}` });
      }
    } else if (imageDownloads.length) {
      const timeoutResult = Symbol('image download wait elapsed');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof timeoutResult>((resolve) => {
        timer = setTimeout(() => resolve(timeoutResult), this.imageCapture.dedupPrecheckMs);
      });
      const ready = await Promise.all(imageDownloads.map(({ promise }) => Promise.race([promise, timeout])));
      if (timer) clearTimeout(timer);
      for (let i = 0; i < ready.length; i++) {
        const result = ready[i];
        if (result === timeoutResult) {
          lateImages.push(imageDownloads[i]);
        } else if (result.image) {
          blobs.push(incomingImageBlob(result.image, msg.message_id, imageDownloads[i].index));
        } else {
          imageFailures++;
          this.log.warn('QQ 图片附件下载失败', { messageId: msg.message_id });
        }
      }
    }
    // 私聊照常合批;群里 @、正文叫到名字、或处在同人同会话的注意力窗口内,立即投递;
    // 仅唤醒模式下,其余群消息只归档,不进入唤醒批次。
    const convKey = `${conv.kind}:${conv.id}`;
    const matchedName = this.matchWakeName(renderSegmentsPlain(msg.message.filter((segment) => segment.type === 'text')));
    const threading = this.isThreadOpen(convKey, senderKey);
    const body = renderedBody.trim();
    // 一张没有配字的图不叫醒她：模型收不到图像本身，她看不见内容，叫醒了只能猜。
    const mediaOnly = conv.kind === 'group' && !mentionedSelf && matchedName === null
      && QQWorld.isMediaOnly(body);
    // 这条到底是不是在跟她说：引用的是别人的消息，或者 @ 了别人。
    // 线索是"他再开口你能听见"，不是"他说什么都是对你说的"——群里的对谈每天发生，
    // 线索开着就把每一句都算成对她的，等于把她放进了所有人的私聊。
    const quotedMsg = replyToMessageId ? this.knownMessages.get(replyToMessageId) : undefined;
    const repliesToSelf = quotedMsg !== undefined
      && sameConversation(quotedMsg.conv, conv)
      && quotedMsg.senderKey === String(selfId);
    // 同住的另外两只可以叫醒我——吵得起来才有戏。
    // 连续互接超过预算不是静音，是**降速**：之后同住消息最多每 siblingWakeThrottleSeconds 叫醒一次。
    // 静音会让两个人在同一段里各说各的（20:20 说写完、20:52 才发现），降速不会。
    const fromSibling = conv.kind === 'group' && (this.cfg.siblingIds ?? []).includes(msg.user_id);
    const siblingBudget = this.cfg.siblingWakeBudget ?? 6;
    const throttleMs = Math.max(0, (this.cfg.siblingWakeThrottleSeconds ?? 90)) * 1000;
    const siblingRunBefore = this.siblingRun.get(convKey) ?? 0;
    const overBudget = siblingBudget <= 0 || siblingRunBefore >= siblingBudget;
    const lastSiblingWake = this.siblingLastWakeAt.get(convKey) ?? 0;
    const siblingNowMs = typeof msg.time === 'number' ? msg.time * 1000 : Date.now();
    const tooSoon = overBudget && (throttleMs === 0 || siblingNowMs - lastSiblingWake < throttleMs);
    const siblingMayWake = !fromSibling || !tooSoon;
    if (conv.kind === 'group') {
      this.siblingRun.set(convKey, fromSibling ? siblingRunBefore + 1 : 0);
      if (fromSibling && !tooSoon) this.siblingLastWakeAt.set(convKey, siblingNowMs);
    }
    const namedWake = siblingMayWake && (mentionedSelf || matchedName !== null || repliesToSelf);
    // 这条叫的是同住的别人：只归档，不进唤醒批次——线程热着也不能替别人答。
    const namedSibling = matchedName === null && !mentionedSelf
      ? matchWakeName(
        renderSegmentsPlain(msg.message.filter((segment) => segment.type === 'text')),
        this.cfg.siblingNames ?? [],
        this.cfg.wakeNameMinChars ?? 3,
        this.cfg.wakeNameFuzzy !== false,
      )
      : null;
    if (namedWake && lateImages.length) {
      const pending = lateImages.splice(0);
      const results = await Promise.all(pending.map((item) => item.promise));
      for (let i = 0; i < results.length; i++) {
        const image = results[i].image;
        if (image) blobs.push(incomingImageBlob(image, msg.message_id, pending[i].index));
        else imageFailures++;
      }
    }
    const repliesToOther = quotedMsg !== undefined
      && quotedMsg.senderKey !== undefined
      && quotedMsg.senderKey !== senderKey
      && quotedMsg.senderKey !== String(selfId);
    const atOthers = (msg.message ?? []).some((seg) => {
      if (seg.type !== 'at') return false;
      const qq = String((seg.data as { qq?: unknown } | undefined)?.qq ?? '');
      return qq !== '' && qq !== 'all' && qq !== String(selfId);
    });
    const addressedElsewhere = repliesToOther || atOthers;
    const question = looksQuestion(body || text);
    // 房间形状：先记下这条，再取"含这条"的事实。她要的是此刻，不是刚才。
    const roomCfg = this.roomSettings();
    if (conv.kind === 'group') {
      this.room.observe(convKey, {
        at: Date.now(),
        senderKey,
        replyTo: quotedMsg?.senderKey ?? null,
        question,
        emotional: looksEmotional(body || text),
        filler: isFillerMessage(body || text),
        toSelf: namedWake,
      }, roomCfg);
    }
    const roomFacts = conv.kind === 'group' ? this.room.facts(convKey, Date.now(), roomCfg) : null;
    // 两个人在互相说、最近三条里没有她：这一场不是她的。线索开着也只归档。
    // 判据里带着"她刚说过话没有"，所以不会把她插完一句就静音。
    const sidelined = roomFacts?.othersTalking === true && !namedWake && !addressedElsewhere;
    // 线索有保鲜期：判的是她最后一次开口，不是他最后一句。冷掉的线索里，
    // 陈述句不是在问她——只有当它是问句时，才重新叫醒她、并把这线焐热。
    const threadWarm = threading && this.isThreadWarm(convKey, senderKey);
    const coldQuestion = threading && !threadWarm && !namedWake && !addressedElsewhere
      && !mediaOnly && !sidelined && question;
    const threadActive = threading && (threadWarm || coldQuestion);
    const waking = namedWake || (threadActive && !mediaOnly && !addressedElsewhere && !sidelined);
    if (coldQuestion && waking) this.touchThread(convKey, senderKey);
    if (conv.kind === 'group' && (namedWake || threading)) {
      this.openThread(convKey, senderKey);
    }
    // 注意力判决：群里没叫到她的消息分三档。focus 照常投递；periphery 进背景缓冲；
    // background 只归档（deliver:false 已经落库），不进摘要、不唤醒。
    // 叫到名字/@ 是明确找她，直接算 focus；只是线索开着时仍要打分——
    // 线索是"他再说话你能听见"，不是"每句话都值得跑一轮模型"的通行证。
    const judged = transcribe
      ? { tier: 'focus' as AttentionTier, score: 1, reasons: ['语音消息本体，等转写'] }
      : this.judgeAttention({ conv, convKey, senderKey, senderName: displayName, text: body || text, waking: namedWake });
    // 线索开着的人只发一句纯附和/表情：归档就够。判的是**这条消息本身**有没有内容，
    // 不是显著性分数——那分数里带着"群里正吵、负荷高"的噪音惩罚，群一热闹就会把
    // 所有正常发言压到 background，等于让她在热闹的群里永远不开口。
    const fillerInThread = threading && !namedWake && isFillerMessage(body || text);
    // 在跟别人说的那句只归档：她能翻到，但不为它醒一次。点名不在这个豁免里——
    // 同时 @ 了她和别人，仍然算找她。
    // 她刚沉默过一次：对方还在自己嘀咕的短陈述先归档，等下一件真正值得开口的事一起带上来。
    // 点名、@、引用、问句都不受影响——那些不是嘀咕。
    const quietSince = this.quietByThread.get(this.threadKey(convKey, senderKey));
    const quietFollowUp = waking && !namedWake && !addressedElsewhere && !mediaOnly
      && quietSince !== undefined
      && Date.now() - quietSince <= QQWorld.QUIET_FOLLOWUP_MS
      && QQWorld.isQuietFollowUpBody(body || text);
    const archiveOnly = !siblingMayWake || namedSibling !== null || mediaOnly || fillerInThread || (!namedWake && addressedElsewhere)
      || sidelined || quietFollowUp || (threading && !namedWake && !threadActive)
      || (!threading && judged.tier !== 'focus');
    if (waking && !archiveOnly) await this.flushAmbientFor(host, convKey);
    // 只叫了一声名字的短消息等合批窗口,让紧接着的正文一起进来;@ 与完整句子仍然立即投递。
    const callOnly = matchedName !== null && !mentionedSelf && body.length <= 12;
    const trigger = transcribe
      ? 'piggyback' as const
      : conv.kind === 'group' && waking ? (callOnly ? 'debounce' as const : 'flush' as const)
      : 'debounce' as const;
    // 形状行要先入队：本条事件可能立刻触发投递，晚一步就赶不上这一批。
    if (!archiveOnly && conv.kind === 'group') this.pushRoomLine(host, convKey, roomCfg);
    // 碎片合批：他连着打的半句话不单独叫醒她，攒到他停下来再一起投递。
    const fragment = !archiveOnly && conv.kind === 'group' && waking && !namedWake && !transcribe
      && typeof host.promotePending === 'function'
      && this.isFragmentBody(body || text);
    if (!fragment) await this.flushFragments();
    // 图还在下载：说清楚，别让她看见占位就下"我这儿是空的"的结论。
    const lateNote = lateImages.length
      ? `\n（这条消息带 ${lateImages.length} 张图，还在下载，稍后会补到）`
      : '';
    const payload = {
      type: 'qq.message',
      ts: nowIso(this.timezone, when),
      source: this.id,
      text: text + lateNote + (namedWake && imageFailures ? `\n（${imageFailures} 张图片下载失败，未能提供图像）` : ''),
      senderKey,
      meta: {
        message_id: msg.message_id,
        user_id: msg.user_id,
        sender_name: displayName,
        conv,
        // 不含消息号、群名和发送者昵称的正文；人格层检索时只该拿这一份。
        body: (body || text).slice(0, 400),
        attention: { tier: judged.tier, score: judged.score, reasons: judged.reasons },
        ...(roomFacts ? { room: roomDigest(roomFacts) } : {}),
        ...(waking ? { wake: mentionedSelf || repliesToSelf ? 'mention' : matchedName !== null ? 'name' : 'thread' } : {}),
        ...(matchedName ? { matchedName } : {}),
      },
      ...(blobs.length ? { blobs } : {}),
    } as Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & { blobs?: BlobInput[] };
    const env = fragment
      // 先挂进总线但不触发投递；攒够了下一次 flushFragments 才把它按这一批发出去。
      ? await host.pushEvent(payload, { trigger: 'piggyback' })
      : await host.pushEvent(payload, archiveOnly ? { deliver: false } : { trigger });
    if (fragment) this.holdFragment(env.cursor);
    if (archiveOnly && conv.kind === 'group') {
      this.rememberAmbient(text, convKey, senderKey, String(msg.message_id), env.blobs);
    }
    if (conv.kind === 'group') {
      this.recordAttention({
        at: Date.now(), ts: env.ts, day: this.localDay(Date.now()),
        conv: convKey, convKey, senderKey, senderName: displayName,
        tier: judged.tier, score: judged.score, reasons: judged.reasons,
        preview: (body || text).slice(0, 120), hash: normalizeForRepeat(body || text),
      });
    }
    this.knownMessages.set(String(msg.message_id), { conv, ts: env.ts, senderKey });
    this.knownConvs.add(convKey);

    if (transcribe) this.transcribeVoice(msg, conv, displayName, when);

    for (const img of lateImages) {
      void img.promise.then(({ image }) => {
        if (!image) {
          this.log.warn('QQ 图片附件下载失败', { messageId: msg.message_id });
          return;
        }
        // 这条消息已经叫醒过她了：图晚到只是补充，别再为它单独开一轮——
        // 否则她会先答"看不到"，图到了再答"图到了"，两句话都发进群。
        // 原消息没叫醒她（纯图、或被归档）时，图就是全部内容，仍要叫醒。
        const alreadySeen = waking && !archiveOnly;
        return host.pushEvent(
          {
            type: 'qq.image',
            ts: nowIso(this.timezone),
            source: this.id,
            text: `[图片附件，来自 QQ 消息 #${msg.message_id}]`,
            senderKey,
            meta: { message_id: msg.message_id, image_index: img.index + 1, conv },
            blobs: [incomingImageBlob(image, msg.message_id, img.index)],
          },
          archiveOnly ? { deliver: false } : alreadySeen ? { trigger: 'piggyback' } : undefined,
        ).then((event) => {
          if (!archiveOnly || !event.blobs?.length) return;
          const entry = this.ambient.find((item) => item.convKey === convKey && item.messageId === String(msg.message_id));
          if (entry) entry.blobs = [...(entry.blobs ?? []), ...event.blobs];
          else this.rememberAmbient(event.text, convKey, senderKey, String(msg.message_id), event.blobs);
        });
      }).catch((e) => this.log.warn('QQ 图片附件事件投递失败', { messageId: msg.message_id, err: String(e) }));
    }

    // 图片:回填所属消息号,被动识图(理解闭合后作为qq.vision事件延迟到达)。
    // 已经被上面的去重预判内联进消息本身的图,不用再走这条异步路径。
    if (this.vision && collected.length) {
      collected.forEach((img, i) => {
        this.vision!.attachMessage(img.id, msg.message_id);
        if (this.passiveEnabled() && !earlyResolved[i]) {
          this.vision!.startPassive(img.id, (visionText, visionMeta) => {
            void this.vision!.getImageBytes(img.id).catch(() => null).then((got) => host.pushEvent({
              type: 'qq.vision',
              ts: nowIso(this.timezone),
              source: this.id,
              text: visionText,
              meta: { ...visionMeta, conv },
              ...(got ? { blobs: [{ bytes: got.buffer, mime: got.mime, name: img.id, fallbackText: `图片 ${img.id}` }] } : {}),
            })).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
          });
        }
      });
    }

    // 引用回复指向的消息不在索引里(未被记录):异步取原文,不阻塞当前投递
    const replySeg = msg.message.find((s) => s.type === 'reply');
    if (replySeg) {
      const rid = String(replySeg.data?.id ?? '');
      if (rid && !this.knownMessages.has(rid)) {
        this.lookupUncapturedReply(rid, conv, msg.message_id);
      }
    }

    // 转发的聊天记录:异步展开内容,不阻塞当前投递(同一套延迟到达风格)
    const forwardSeg = msg.message.find((s) => s.type === 'forward');
    if (forwardSeg) {
      const resId = String(forwardSeg.data?.id ?? '');
      if (resId) this.lookupForward(resId, conv, msg.message_id, archiveOnly);
    }
  }

  /**
   * 向协议端请求 QQ 自带的语音转文字,结果另发一条 qq.transcript,不阻塞当前投递。
   * 转写结果照常合批唤醒;没转写成也发一条说明并唤醒,因为占位已写了「正在转写中」。
   * 只有动作不存在(1404)才换下一个动作名,超时、撤回、识别失败都按这条没转写成处理。
   */
  private transcribeVoice(msg: OneBotGroupMessage, conv: Conv, displayName: string, when: Date): void {
    const host = this.host!;
    const driver = this.driver!;
    const mid = msg.message_id;
    const timeoutMs = PTT_TEXT_PROTOCOL_WAIT_MS + (this.cfg.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS);
    void (async () => {
      let rep!: ExtensionResult;
      for (const action of this.pttTextAction ? [this.pttTextAction] : PTT_TEXT_ACTIONS) {
        rep = await driver.callExtension(action, { message_id: mid }, timeoutMs);
        if (!rep.ok && rep.retcode === RETCODE_UNSUPPORTED_ACTION) continue;
        if (rep.ok || rep.retcode !== undefined) this.pttTextAction = action;
        break;
      }
      const raw = rep.ok ? (rep.data as { text?: unknown } | null)?.text : undefined;
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text) {
        await host.pushEvent(
          {
            type: 'qq.transcript',
            ts: nowIso(this.timezone),
            source: this.id,
            text: `#${mid} [${this.convLabel(conv)} ${shortTime(this.timezone, when)}] ${displayName}(${msg.user_id}): [QQ语音转写] ${text}`,
            senderKey: String(msg.user_id),
            meta: { message_id: mid, user_id: msg.user_id, sender_name: displayName, conv },
          },
          { trigger: 'debounce' },
        );
        return;
      }
      let reason: string;
      if (rep.ok) {
        reason = '转写结果为空';
      } else if (rep.retcode === RETCODE_UNSUPPORTED_ACTION) {
        this.pttTextAction = null;
        reason = `协议端不提供转写动作(${PTT_TEXT_ACTIONS.join('、')} 都不存在)`;
      } else {
        reason = rep.error;
      }
      await host.pushEvent({
        type: 'qq.transcript',
        ts: nowIso(this.timezone),
        source: this.id,
        text: `[系统] #${mid} 的语音没能转写:${reason}`,
        meta: { conv, message_id: mid },
      });
    })().catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  /**
   * 引用回复的原消息不在 knownMessages 里(可能发生在开始关注这个会话
   * 之前,或跨重启丢失):尽力用标准动作 get_msg 取回原文。取到与否都追加一条
   * 系统事件说明情况;不在当前消息处理里同步等待,避免打乱事件的到达顺序
   * (与被动识图的延迟到达是同一套非阻塞风格)。
   */
  private lookupUncapturedReply(rid: string, conv: Conv, ofMessageId: number | string): void {
    const host = this.host;
    const driver = this.driver;
    if (!host || !driver) return;
    const midNum = Number(rid);
    void driver
      .callApi('get_msg', { message_id: Number.isFinite(midNum) ? midNum : rid })
      .then(
        (data) => {
          const d = data as {
            sender?: { nickname?: string; card?: string; user_id?: number };
            message?: Segment[] | string;
          };
          const uid = d?.sender?.user_id;
          const name = d?.sender?.card || d?.sender?.nickname || (uid !== undefined ? String(uid) : rid);
          const body = typeof d?.message === 'string' ? d.message : renderSegmentsPlain(d?.message ?? []);
          host.pushEvent({
            type: 'qq.reply.uncaptured',
            ts: nowIso(this.timezone),
            source: this.id,
            text: `[系统] #${ofMessageId} 引用的消息不在你的记录里(未被捕获);查到的原文是 ${name}${uid !== undefined ? `(${uid})` : ''}: ${body}`,
            meta: { conv, message_id: rid },
          }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
        },
        (err) => {
          host.pushEvent({
            type: 'qq.reply.uncaptured',
            ts: nowIso(this.timezone),
            source: this.id,
            text: `[系统] #${ofMessageId} 引用的消息不在你的记录里(未被捕获),原文也没能取到:${err instanceof Error ? err.message : String(err)}`,
            meta: { conv, message_id: rid },
          }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
        },
      );
  }

  /** 转发消息的单个节点(发言人+内容),兼容NapCat记录与OneBot标准node段。 */
  private renderForwardNode(value: unknown): ForwardNode {
    const outer =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
    const data = outer.data;
    const n =
      outer.type === 'node' && data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)
        : outer;
    const sender =
      n.sender !== null && typeof n.sender === 'object'
        ? (n.sender as Record<string, unknown>)
        : {};
    const uidValue = sender.user_id ?? n.user_id;
    const uid =
      typeof uidValue === 'string' || typeof uidValue === 'number'
        ? uidValue
        : undefined;
    const nicknameValue = sender.nickname ?? sender.card ?? n.nickname;
    const nickname =
      typeof nicknameValue === 'string' && nicknameValue && nicknameValue !== PLACEHOLDER_NICKNAME
        ? nicknameValue
        : undefined;
    const isSelf =
      uid !== undefined && String(uid) === String(this.driver?.identity?.selfId);
    const name = isSelf ? '你' : (nickname ?? (uid !== undefined ? String(uid) : '?'));
    const raw = n.content ?? n.message ?? n.raw_message;
    const segments = Array.isArray(raw) ? (raw as Segment[]) : [];
    const body =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? renderSegmentsPlain(segments)
          : '';
    // 正文里的图片只剩一个 `[图片]` 记号;把地址单独收集起来,展开转发时才能下载给她看。
    const images = segments
      .filter((seg) => seg.type === 'image')
      .map((seg) => extractImageUrl((seg.data ?? {}) as Record<string, unknown>))
      .filter(Boolean);
    return {
      line: `${name}${uid !== undefined ? `(${uid})` : ''}: ${body}`,
      body,
      named: isSelf || nickname !== undefined,
      time: typeof n.time === 'number' ? n.time : undefined,
      userId: uid !== undefined ? String(uid) : undefined,
      messageType: typeof n.message_type === 'string' ? n.message_type : undefined,
      images,
    };
  }

  /**
   * NapCat 对「私聊合并转发被转发进群」只提供协议兼容路径:该路径下所有节点的
   * 发言人一律填成转发者本人、昵称落回「QQ用户」占位,身份信息实质丢失。命中时
   * 调用方去掉发言人前缀只留正文,并在标题注明身份未取到,避免把多人对话误读
   * 成一个人的独白。
   */
  private forwardIdentityCollapsed(nodes: ForwardNode[]): boolean {
    if (nodes.length < 2 || nodes.some((n) => n.named)) return false;
    const ids = new Set(nodes.map((n) => n.userId));
    return ids.size === 1 && !ids.has(undefined);
  }

  private forwardMessages(data: unknown): unknown[] {
    if (data === null || typeof data !== 'object') return [];
    const response = data as Record<string, unknown>;
    if (Array.isArray(response.messages)) return response.messages;
    return Array.isArray(response.message) ? response.message : [];
  }

  /**
   * NapCat目前会把私聊合并转发中bot自己的节点全部漏掉。事件库已经捕获了这些
   * qq.self消息；只在协议结果完全没有自身节点时，按同一私聊和紧邻时间补回。
   */
  private recoverForwardSelfNodes(nodes: ForwardNode[]): ForwardNode[] {
    const host = this.host;
    const selfId = this.driver?.identity?.selfId;
    if (!host || selfId === undefined || nodes.some((n) => n.userId === String(selfId))) {
      return [];
    }
    const timed = nodes.filter(
      (n): n is ForwardNode & { time: number } =>
        n.messageType === 'private' && n.time !== undefined,
    );
    if (timed.length !== nodes.length || timed.length === 0) return [];
    const peerIds = new Set(
      timed.map((n) => n.userId).filter((id): id is string => Boolean(id)),
    );
    peerIds.delete(String(selfId));
    if (peerIds.size !== 1) return [];
    const peerId = Number([...peerIds][0]);
    if (!Number.isSafeInteger(peerId)) return [];

    const recoveryWindowSeconds = 120;
    const from = Math.min(...timed.map((n) => n.time));
    const to = Math.max(...timed.map((n) => n.time)) + recoveryWindowSeconds;
    // 事件库按字符串比较 ts。UTC 偏移在 -12:00 到 +14:00 之间,同一时刻在不同偏移下的
    // 时间串最多差 26 小时;两端各放宽 26 小时只用来圈定要读的事件,时间判断由下面的 Date.parse 做。
    const offsetSpanMs = 26 * 3600_000;
    return host.store
      .range({
        source: this.id,
        senderKey: String(selfId),
        fromTs: nowIso(this.timezone, new Date(from * 1000 - offsetSpanMs)),
        toTs: nowIso(this.timezone, new Date(to * 1000 + offsetSpanMs)),
      })
      .filter(
        (event) =>
          event.type === 'qq.self' &&
          eventInConversation(event, { kind: 'private', id: peerId }) &&
          Date.parse(event.ts) / 1000 >= from &&
          Date.parse(event.ts) / 1000 <= to,
      )
      .filter((event) => {
        const eventTime = Date.parse(event.ts) / 1000;
        return timed.some(
          (node) =>
            eventTime >= node.time &&
            eventTime <= node.time + recoveryWindowSeconds,
        );
      })
      .map((event) => {
        const marker = '] 你: ';
        const markerAt = event.text.indexOf(marker);
        const body = markerAt >= 0 ? event.text.slice(markerAt + marker.length) : event.text;
        return {
          line: `你(${selfId}): ${body} [本地记录补回]`,
          body: `${body} [本地记录补回]`,
          named: true,
          time: Date.parse(event.ts) / 1000,
          userId: String(selfId),
          messageType: 'private',
        };
      });
  }

  /**
   * 转发(合并转发)消息:异步用 get_forward_msg 取具体内容,取到与否都
   * 追加一条系统事件;不阻塞当前消息投递(同上,非阻塞延迟到达风格)。
   * OneBot v11 标准的参数名是 `id`,NapCat 认 `message_id`,两个都带上。
   */
  private lookupForward(resId: string, conv: Conv, ofMessageId: number | string, archiveOnly: boolean): void {
    const host = this.host;
    const driver = this.driver;
    if (!host || !driver) return;
    void driver.callApi('get_forward_msg', { id: resId, message_id: resId }).then(
      async (data) => {
        const nodes = this.forwardMessages(data).map((m) => this.renderForwardNode(m));
        const collapsed = this.forwardIdentityCollapsed(nodes);
        const recovered = this.recoverForwardSelfNodes(nodes);
        const ordered = [...nodes, ...recovered]
          .map((node, order) => ({ node, order }))
          .sort((a, b) =>
            a.node.time !== undefined && b.node.time !== undefined
              ? a.node.time - b.node.time || a.order - b.order
              : a.order - b.order,
          );
        const lines = ordered.map(({ node }) => (collapsed && !node.named ? node.body : node.line));
        const body = lines.length ? lines.join('\n') : '(转发记录是空的)';
        const header = collapsed
          ? `[系统] #${ofMessageId} 引用的转发消息展开如下(里面的发言人身份没能取到,可能是多个人在说话):`
          : `[系统] #${ofMessageId} 引用的转发消息展开如下:`;
        // 转发里的图片在正文里只剩 `[图片]`;要让她看见就得把字节下下来当附件带上。
        const imageUrls = ordered.flatMap(({ node }) => node.images ?? []);
        const shown = imageUrls.slice(0, FORWARD_IMAGE_CAP);
        const blobs = (await Promise.all(shown.map(async (url, index) => {
          try {
            const got = await downloadImageBytes(url, this.imageCapture);
            return { bytes: got.buffer, mime: got.mime, name: `forward-${index + 1}`, fallbackText: `转发图片 ${index + 1}` };
          } catch {
            return null;
          }
        }))).filter((blob): blob is NonNullable<typeof blob> => blob !== null);
        const imageNote = imageUrls.length
          ? `\n（这条转发里有 ${imageUrls.length} 张图`
            + (blobs.length ? `，前 ${blobs.length} 张随这条消息一起给你了）` : '，这次一张都没能取到）')
          : '';
        if (archiveOnly) {
          const entry = this.ambient.find((item) => item.convKey === `${conv.kind}:${conv.id}`
            && item.text.startsWith(`#${ofMessageId} `));
          if (entry) entry.text += `\n${header}\n${body}${imageNote}`;
        }
        host.pushEvent({
          type: 'qq.forward',
          ts: nowIso(this.timezone),
          source: this.id,
          text: `${header}\n${body}${imageNote}`,
          meta: { conv, forward_id: resId },
          ...(blobs.length ? { blobs } : {}),
        }, archiveOnly ? { deliver: false } : undefined).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
      },
      (err) => {
        host.pushEvent({
          type: 'qq.forward',
          ts: nowIso(this.timezone),
          source: this.id,
          text: `[系统] #${ofMessageId} 转发的消息没能展开:${err instanceof Error ? err.message : String(err)}`,
          meta: { conv, forward_id: resId },
        }, archiveOnly ? { deliver: false } : undefined).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
      },
    );
  }

  private handleRecall(ev: OneBotEvent, gid: number): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const userId = String(ev.user_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const mid = String(ev.message_id ?? '');
    const t = shortTime(this.timezone);
    const tail = this.knownMessages.has(mid) ? `一条消息(#${mid})` : '一条消息';
    host.pushEvent({
      type: 'qq.recall',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[${this.convLabel(conv)} ${t}] ${name}(${userId}) 撤回了${tail}`,
      senderKey: userId,
      meta: { message_id: ev.message_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  private handleMemberChange(ev: OneBotEvent, gid: number, kind: 'join' | 'leave'): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const userId = String(ev.user_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const verb = kind === 'join' ? '加入了群' : '退出了群';
    host.pushEvent({
      type: 'qq.member',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[${this.convLabel(conv)} 系统] ${name}(${userId})${verb}`,
      senderKey: userId,
      meta: { user_id: ev.user_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  private handleEmojiLike(ev: OneBotEvent, gid: number): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const userId = String(ev.user_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const mid = String(ev.message_id ?? '');
    const t = shortTime(this.timezone);
    const tail = this.knownMessages.has(mid) ? `给#${mid}贴了个表情` : '给一条消息贴了个表情';
    host.pushEvent({
      type: 'qq.emoji',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[${this.convLabel(conv)} ${t}] ${name}(${userId}) ${tail}`,
      senderKey: userId,
      meta: { message_id: ev.message_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  /**
   * 尽力从戳一戳notify的raw_info里拼出动作文案(如"戳了戳"/"拍了拍")。
   * raw_info 不在 OneBot v11 标准里,形状随协议端而变,取不到就退回通用"戳了戳"。
   */
  private extractPokeAction(rawInfo: unknown): string {
    if (Array.isArray(rawInfo)) {
      const texts = rawInfo
        .map((seg) => (seg && typeof seg === 'object' ? (seg as Record<string, unknown>).txt : undefined))
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
      if (texts.length > 0) return texts.join('').trim();
    }
    return '戳了戳';
  }

  private handlePoke(ev: OneBotEvent, gid: number): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const idn = this.driver?.identity;
    const selfId = idn?.selfId ?? -1;
    const userId = String(ev.user_id ?? '');
    const targetId = String(ev.target_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const targetLabel =
      Number(targetId) === selfId
        ? `${idn?.nickname ?? '你'}(你)`
        : `${this.nameByUserId.get(targetId) ?? targetId}(${targetId})`;
    const action = this.extractPokeAction(ev.raw_info);
    const t = shortTime(this.timezone);
    host.pushEvent({
      type: 'qq.poke',
      ts: nowIso(this.timezone),
      source: this.id,
      text: `[${this.convLabel(conv)} ${t}] ${name}(${userId}) ${action} ${targetLabel}`,
      senderKey: userId,
      meta: { user_id: ev.user_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  /** 启动时从事件库meta重建 已记录消息索引、QQ号→称呼 映射 与 事件面板的会话汇总 */
  private rebuildMaps(): void {
    const host = this.host!;
    const events = host.store.range({ source: this.id });
    this.convSummary.clear();
    this.summarizedTotal = 0;
    for (const e of events) {
      this.summarize(e);
      const mid = e.meta?.message_id;
      const conv = e.meta?.conv as Conv | undefined;
      if (mid !== undefined && conv && (conv.kind === 'group' || conv.kind === 'private') && !this.knownMessages.has(String(mid))) {
        this.knownMessages.set(String(mid), {
          conv: { kind: conv.kind, id: Number(conv.id) },
          ts: e.ts,
          ...(e.senderKey || e.meta?.user_id !== undefined
            ? { senderKey: String(e.senderKey ?? e.meta?.user_id) }
            : {}),
        });
        this.knownConvs.add(`${conv.kind}:${Number(conv.id)}`);
      }
      const uid = e.meta?.user_id;
      const name = e.meta?.sender_name;
      if (uid !== undefined && typeof name === 'string') {
        this.nameByUserId.set(String(uid), name);
      }
      // 补拉摘要里记着它见过哪些消息号：跨重启认得出，不会把同一段空窗再播一遍。
      const seen = e.meta?.message_ids;
      if (Array.isArray(seen)) for (const id of seen) this.seenMessages.add(String(id));
    }
    this.summarizedCursor = host.store.latestCursor();
    this.log.debug('映射重建完成', {
      messages: this.knownMessages.size,
      names: this.nameByUserId.size,
    });
  }

  private summarize(e: EventEnvelope): void {
    this.summarizedTotal++;
    const c = e.meta?.conv as { kind?: string; id?: number } | undefined;
    if (!c || (c.kind !== 'group' && c.kind !== 'private') || c.id === undefined) return;
    const key = `${c.kind}:${Number(c.id)}`;
    const cur = this.convSummary.get(key);
    if (cur) { cur.count++; cur.lastTs = e.ts; }
    else this.convSummary.set(key, { kind: c.kind, id: Number(c.id), count: 1, lastTs: e.ts });
  }


  private groupName(gid: number): string {
    return this.driver?.identity?.groups.get(gid)?.groupName ?? String(gid);
  }

  private convLabel(conv: Conv): string {
    return conv.kind === 'group' ? `群「${this.groupName(conv.id)}」` : '私聊';
  }

  private targetDesc(t: Conv): string {
    if (t.kind === 'group') return `群「${this.groupName(t.id)}」`;
    const n = this.nameByUserId.get(String(t.id));
    return n ? `私聊 ${n}` : `私聊 ${t.id}`;
  }

  /**
   * 解析发送目标:显式 to("group:群号"/"private:QQ号",数字寻址,不支持按群名/好友
   * 名匹配——昵称/群名可被随意改,QQ号才是稳定标识),或 to 省略时从 reply_to 引用
   * 的消息推断其所在会话(查 World 自己的消息索引,不经事件库)。
   */
  private resolveTarget(
    toArg: string | undefined,
    replyToMessageId: string | undefined,
  ): Conv | { error: string } {
    if (!toArg && replyToMessageId !== undefined) {
      const known = this.knownMessages.get(replyToMessageId);
      if (known) {
        const t = known.conv;
        // 会话可能已被移出监听名单,不能再往里发
        const watched =
          t.kind === 'group' ? this.watchedGroups.has(t.id) : this.watchedPrivates.has(t.id);
        if (!watched) {
          return { error: `the conversation of #${replyToMessageId} is no longer on the watch list` };
        }
        return t;
      }
      return { error: `no conversation found for #${replyToMessageId}; specify a recipient with to` };
    }
    if (!toArg) {
      return { error: 'specify a recipient: to="group:<id>" or "private:<id>", or use reply_to' };
    }
    const s = toArg.trim();
    const target = parseConversationAddress(s);
    if (target?.kind === 'group') {
      if (!this.watchedGroups.has(target.id)) {
        return { error: `group ${target.id} is not on the watch list` };
      }
      return target;
    }
    if (target?.kind === 'private') {
      if (!this.watchedPrivates.has(target.id)) {
        return { error: `QQ ${target.id} is not on the private watch list` };
      }
      return target;
    }
    return { error: `"${s}" is not a valid target; use to="group:<id>" or "private:<id>" (numeric QQ group/user id, not a name)` };
  }

  /**
   * 校验 reply_to 的平台 message_id 已被记录;是则原样用于引用回复。
   * 消息行首的 `#<message_id>` 直接表示该平台标识。
   */
  private resolveReplyMessageId(replyTo: unknown): { mid?: string } | { error: string } {
    if (replyTo === undefined || replyTo === null || replyTo === '') return {};
    const mid = String(replyTo).trim().replace(/^#/, '');
    if (!this.knownMessages.has(mid)) {
      return { error: `no recorded QQ message with id #${mid}; cannot quote-reply` };
    }
    return { mid };
  }

  /** 实际发送到目标会话,回录 qq.self,返回回执文本 */
  private async sendToTarget(
    target: Conv,
    opts: {
      text: string;
      recipient: string | null;
      replyMessageId?: number | string;
      imageRef?: string;
      imageBytes?: Uint8Array;
      voiceRef?: string;
      voiceBytes?: Uint8Array;
      continuationStarted?: string;
      continuationCompleted?: string;
    },
  ): Promise<string> {
    const host = this.host!;
    const driver = this.driver!;
    let imageBase64: string | undefined;
    if (opts.imageBytes) {
      imageBase64 = Buffer.from(opts.imageBytes).toString('base64');
    }
    const message = buildOutgoing({
      text: opts.text,
      reply_to_message_id: opts.replyMessageId,
      image_base64: imageBase64,
      ...(opts.voiceBytes ? { record_base64: Buffer.from(opts.voiceBytes).toString('base64') } : {}),
    });
    const action = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params =
      target.kind === 'group'
        ? { group_id: target.id, message }
        : { user_id: target.id, message };
    const data = (await driver.callApi(action, params)) as { message_id?: number };
    const messageId = data?.message_id;
    const sentConvKey = `${target.kind}:${target.id}`;
    const recipient = opts.recipient;
    if (recipient && recipient !== String(driver.identity?.selfId ?? 'self')) {
      this.openThread(sentConvKey, recipient);
      this.touchThread(sentConvKey, recipient);
      const key = this.threadKey(sentConvKey, recipient);
      this.quietByThread.delete(key);
      if (this.turnParticipants.has(key)) this.turnReplies.add(key);
    }

    // 她自己说过话，房间才知道"这场还有她"——不然刚插一句就会被当成旁听静音。
    // 只记一个标记，不计进任何数字。
    if (target.kind === 'group') {
      this.room.observe(`${target.kind}:${target.id}`, {
        at: Date.now(),
        senderKey: String(driver.identity?.selfId ?? 'self'),
        replyTo: null,
        question: false,
        emotional: false,
        filler: false,
        toSelf: false,
        self: true,
      }, this.roomSettings());
    }
    // 回录正文:文字 + (如有)图片标记,保证自己发的图在历史里也可见。
    // 行首保留平台消息号,使历史查询结果可引用自身消息。
    const imgMark = opts.imageRef ? `[图片: ${opts.imageRef}]` : '';
    const voiceMark = opts.voiceRef ? `[语音: ${opts.voiceRef}]` : '';
    const selfBody = [opts.text, imgMark, voiceMark].filter(Boolean).join(' ');
    const selfBlob = opts.imageRef
      ? { handle: opts.imageRef, fallbackText: '你发出的图片' }
      : opts.voiceRef
        ? { handle: opts.voiceRef, fallbackText: '你发出的语音' }
        : null;
    const idTag = messageId !== undefined ? `#${messageId} ` : '';
    const sentAt = nowIso(this.timezone);
    let recorded = true;
    try {
      await host.pushEvent(
        {
          type: 'qq.self',
          ts: sentAt,
          source: this.id,
          text: `${idTag}[${this.convLabel(target)} ${shortTime(this.timezone)}] 你: ${selfBody}`,
          ...(selfBlob ? { blobs: [selfBlob] } : {}),
          senderKey: String(driver.identity?.selfId ?? 'self'),
          meta: {
            message_id: messageId,
            user_id: driver.identity?.selfId,
            sender_name: driver.identity?.nickname,
            conv: target,
            ...(opts.continuationStarted ? { continuation_started: opts.continuationStarted } : {}),
            ...(opts.continuationCompleted ? { continuation_completed: opts.continuationCompleted } : {}),
          },
        },
        { deliver: false },
      );
    } catch (err) {
      recorded = false;
      this.log.error('QQ 消息已发送但回录失败', { messageId, err: String(err) });
    }
    if (messageId !== undefined) {
      this.knownMessages.set(String(messageId), { conv: target, ts: sentAt, senderKey: String(driver.identity?.selfId ?? 'self') });
    }
    return `[sent${messageId !== undefined ? ` #${messageId}` : ''} → ${this.targetDesc(target)}]`
      + (recorded ? '' : '\n[record failed] 消息已发送，但本地回录失败；不要重复发送。');
  }


  private deliverContinuations(): void {
    const host = this.host;
    const store = this.continuations;
    if (!host || !store) return;
    try {
      for (const task of store.due()) {
        if (this.queuedContinuations.has(task.id)) continue;
        if (this.isBlocked(task.spec.person)) { store.finish(task.id, 'cancelled'); continue; }
        const [kind, id] = task.conv.split(':');
        if (!(kind === 'group' ? this.watchedGroups : this.watchedPrivates).has(Number(id))) {
          store.finish(task.id, 'cancelled'); continue;
        }
        this.queuedContinuations.add(task.id);
        host.pushDeferred({
          type: 'qq.continuation',
          meta: { continuation_id: task.id, conv: { kind, id: Number(id) }, user_id: task.spec.person },
          render: () => {
            this.queuedContinuations.delete(task.id);
            store.expire();
            const current = store.get(task.id);
            if (!current || current.status !== 'waiting' || current.dueAt > Date.now()) return null;
            if (this.isBlocked(current.spec.person)
              || !(kind === 'group' ? this.watchedGroups : this.watchedPrivates).has(Number(id))) {
              store.finish(task.id, 'cancelled'); return null;
            }
            store.markReady(task.id);
            const recent = this.recentMessages(task.conv, 6).map((m) => `${m.from}: ${m.text}`).join('\n');
            return `[短时接续 ${task.id}] ${task.conv}，等待者 QQ ${task.spec.person}\n`
              + `你实际发过：${task.text}\n要续接的行动：${task.spec.action}\n`
              + (task.kind === 'scene'
                ? '这是共同虚构场景，可按经过的时间自然推进；不是现实世界的完成证明。\n'
                : '这是真实任务。到点不表示完成；先核对实际工具结果，没完成就交代仍在等或延后，不能编造完成。\n')
              + `最近同场消息：\n${recent}\n`
              + '结合新消息判断对方是否还在等。取消/话题不合适用 qq_continue cancel；未做好用 delay。'
              + `接着说用 qq_draft(to="${task.conv}", continuation_id="${task.id}")，只发一拍；发送确认后才结账。`
              + '这个机会不消耗主动聊天额度。';
          },
        }, { trigger: 'flush' });
      }
    } catch (err) { this.log.error('短时接续投递失败', { err: String(err) }); }
  }

  private continueTool(): ToolDef {
    return { ...CONTINUE_DECL, handler: async (args) => {
      const store = this.continuations;
      if (!store) return '[tool failed] QQ module not started';
      store.expire();
      if (args.decision === 'list') return JSON.stringify(store.list());
      const id = String(args.id ?? '');
      const task = store.list().find((t) => t.id === id);
      if (!task) return '[bad input] no active continuation with this id';
      if (args.decision === 'cancel') {
        store.finish(id, 'cancelled'); return `[continuation cancelled] ${id}`;
      }
      if (args.decision === 'delay') {
        const minutes = args.after_minutes;
        if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > 30) {
          return '[bad input] after_minutes must be > 0 and <= 30';
        }
        if (task.status === 'uncertain' || task.status === 'prepared') return '[send uncertain] 核对群史后取消；不能自动重新调度未知发送';
        store.delay(id, minutes); return `[continuation delayed] ${id}`;
      }
      return '[bad input] decision must be list, cancel or delay';
    } };
  }

  tools(): ToolDef[] {
    const list = [
      this.draftTool(),
      this.confirmTool(),
      this.continueTool(),
      this.threadCloseTool(),
      ...(this.roomSettings().enabled ? [this.roomNoteTool()] : []),
      ...createHistoryTools({
        source: this.id,
        host: () => this.host,
        messageTs: (mid) => this.knownMessages.get(mid)?.ts,
        timezone: this.timezone,
      }),
    ];
    // 看图追问依赖 IMG-N(外挂视觉),随视觉出现/消失
    if (this.vision) list.push(this.viewImageTool());
    return list;
  }

  private draftTool(): ToolDef {
    return {
      ...DRAFT_DECL,
      handler: async (args, ctx) => {
        const host = this.host;
        const driver = this.driver;
        if (!host || !driver) return '[tool failed] QQ module not started';
        if (args.follow_up === undefined) {
          return '[bad input] follow_up 必填：让对方等待稍后接续时填写行动对象；无需接续明确填 null。消息未发送，也未保存草稿；补齐后重新调用 qq_draft。';
        }
        const rawText = literalNewlines(typeof args.text === 'string' ? args.text : '');
        const imageArg =
          typeof args.image === 'string' && args.image.trim() ? args.image.trim() : undefined;
        const voiceArg =
          typeof args.voice === 'string' && args.voice.trim() ? args.voice.trim() : undefined;
        /** 第二条气泡的原文；空串表示只发一条。 */
        const moreTextRaw = literalNewlines(typeof args.more === 'string' ? args.more.trim() : '');
        if (!rawText.trim() && !imageArg && !voiceArg) return '[bad input] provide at least one of text, image or voice';
        if (voiceArg && (rawText.trim() || imageArg || moreTextRaw || (args.reply_to !== undefined && args.reply_to !== null && String(args.reply_to) !== ''))) {
          return '[bad input] a voice bar is a message of its own; it carries no text, image, quote-reply or second bubble';
        }
        // 纯空白正文视为不带字(避免只发图时混进一个空白 text 段)
        const text = rawText.trim() ? rawText : '';

        const toArg = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : undefined;
        const replyToId =
          args.reply_to !== undefined && args.reply_to !== null && String(args.reply_to) !== ''
            ? String(args.reply_to).trim().replace(/^#/, '')
            : undefined;

        const target = this.resolveTarget(toArg, replyToId);
        if ('error' in target) return `[send failed] ${target.error}`;
        let followUp: QQContinuationSpec | undefined;
        if (args.follow_up !== null) {
          const value = args.follow_up as Partial<QQContinuationSpec> | null;
          if (!value || typeof value !== 'object' || typeof value.action !== 'string'
            || !value.action.trim() || value.action.length > 300 || typeof value.person !== 'string'
            || !/^\d+$/.test(value.person) || !['scene', 'task'].includes(String(value.kind))
            || typeof value.after_minutes !== 'number' || !Number.isFinite(value.after_minutes)
            || value.after_minutes <= 0 || value.after_minutes > 30) return '[bad input] invalid follow_up';
          if (!text.trim() || moreTextRaw || args.continuation_id) return '[bad input] follow_up requires one text bubble, no more or continuation_id';
          if (this.isBlocked(value.person)) return '[bad input] follow_up person is blocked';
          if (target.kind === 'private' && String(target.id) !== value.person) return '[bad input] follow_up person must match private target';
          followUp = value as QQContinuationSpec;
        }
        const continuationId = typeof args.continuation_id === 'string' ? args.continuation_id : undefined;
        if (continuationId) {
          this.continuations?.expire();
          const task = this.continuations?.get(continuationId);
          if (!task || !['waiting', 'ready'].includes(task.status)
            || task.conv !== `${target.kind}:${target.id}` || this.isBlocked(task.spec.person)) {
            return '[bad input] continuation unavailable, expired, blocked or belongs to another conversation';
          }
          if (moreTextRaw) return '[bad input] continuation reply uses one bubble only';
        }

        const rep = this.resolveReplyMessageId(args.reply_to);
        if ('error' in rep) return `[send failed] ${rep.error}`;

        // 引用回复必须与发送目标同会话(否则 reply 段带的是别会话的 message_id)
        if (replyToId !== undefined) {
          const replyConv = this.knownMessages.get(replyToId)?.conv;
          if (replyConv && !sameConversation(replyConv, target)) {
            return `[send failed] #${replyToId} is not in ${this.targetDesc(target)}; cannot quote-reply across conversations`;
          }
        }

        // 图片:按句柄确认取得到,并按字节内容弹出已有的识别描述作为preview(省一次qq_view_image)
        let imageRef: string | undefined;
        let previewLine = '';
        if (imageArg) {
          const got = host.blob(imageArg);
          if (!got) return `[send failed] no blob for ${imageArg}; use a log: handle from a [blob ...] line or a mem: handle from your workspace`;
          if (!got.mime.startsWith('image/')) return `[send failed] ${imageArg} is ${got.mime}, not an image`;
          imageRef = imageArg;
          const desc = this.vision?.descriptionByHash(createHash('sha256').update(got.bytes).digest('hex'));
          previewLine = desc
            ? `[image: ${imageArg} — cached description: ${desc}]`
            : `[image: ${imageArg}]`;
        }

        // 语音:同样按句柄确认取得到,MIME 必须是音频
        let voiceRef: string | undefined;
        if (voiceArg) {
          const got = host.blob(voiceArg);
          if (!got) return `[send failed] no blob for ${voiceArg}; use a log: handle from a [blob ...] line or a mem: handle from your workspace`;
          if (!got.mime.startsWith('audio/')) return `[send failed] ${voiceArg} is ${got.mime}, not audio`;
          voiceRef = voiceArg;
          previewLine = `[voice: ${voiceArg}]`;
        }

        const moreText = moreTextRaw;
        const draft: PendingDraft = {
          target,
          text,
          followUp,
          continuationId,
          ...(moreText ? { more: moreText } : {}),
          replyMessageId: rep.mid,
          imageRef,
          voiceRef,
        };
        // 重复提醒：同一会话里最近几句说过的话，挑最像的一句点出来。
        const convKeyOfDraft = `${target.kind}:${target.id}`;
        const history = this.lastSentByConv.get(convKeyOfDraft) ?? [];

        // 这一版过一遍自己的规矩；挑出问题就压成草稿等她改，没挑出问题就直接发。
        // 分两条发时两条各过一遍：规矩管的是每一条消息，不是一整次调用。
        const warnings: string[] = [];
        const bubbles = [text.trim(), moreText].filter(Boolean);
        for (let i = 0; i < bubbles.length; i++) {
          const bubble = bubbles[i]!;
          const tag = bubbles.length > 1 ? (i === 0 ? '第一条 ' : '第二条 ') : '';
          const best = history
            .map((sent) => ({ sent, ratio: repeatSimilarity(sent, bubble) }))
            .sort((a, b) => b.ratio - a.ratio)[0] ?? null;
          if (best && best.ratio >= QQWorld.REPEAT_WARN) {
            warnings.push(
              `[repeat warning] ${tag}你最近已经说过很接近的话：「${best.sent.replace(/\s+/g, ' ').slice(0, 60)}」。`
              + '换一个具体的事实或角度，别原样再说一遍；确实要强调，就换个说法。',
            );
          }
          // 动作密度：上限按部署配置，0 = 不限制。默认值是按克制型人格调的。
          const gesture = this.cfg.gesture ?? {};
          const maxPerMessage = gesture.maxPerMessage ?? 1;
          const maxRecent = gesture.maxRecent ?? 2;
          const windowSize = gesture.windowSize ?? 5;
          const actionCount = (bubble.match(/[（(][^）)]{1,30}[）)]/g) ?? []).length;
          if (maxPerMessage > 0 && actionCount > maxPerMessage) {
            warnings.push(`[gesture] ${tag}一条里最多 ${maxPerMessage} 处动作；把多出来的删掉，剩下的改成纯文字。`);
          } else if (maxPerMessage > 0 && actionCount === 1 && maxRecent > 0) {
            const recentWithAction = history.slice(0, windowSize).filter((sent) => /[（(][^）)]{1,30}[）)]/.test(sent)).length;
            if (recentWithAction >= maxRecent) {
              warnings.push(`[gesture] ${tag}最近 ${windowSize} 条里已经有 ${maxRecent} 条带动作，这一条用纯文字。`);
            }
          }
          // 中文里两个词之间的空格没有意义：要么是两句话被空格粘住了，要么是手滑多按了一下。
          // 代码分不清是哪一种，就把它指出来，两条出路都写清楚。
          const gap = CJK_GAP.exec(bubble);
          if (gap) {
            const left = gap[1].slice(-8);
            const right = gap[2].slice(0, 8);
            warnings.push(
              `[spacing] ${tag}「${left} ${right}」中间是一个空格。`
              + '若是两句话：换行（在 text 里写 \\n），或者把第二拍放进 more 发成两条；'
              + '若本来就是一句话，把这个空格去掉。空格不算分开。',
            );
          }
        }
        // 宣布不接也是开口。两条一起看：第一拍接住、第二拍拍开，同样算拒绝。
        if (this.cfg.refusalHint !== false && QQWorld.REFUSAL.test([text, moreText].join(' '))) {
          const refusedBefore = history.some((sent) => QQWorld.REFUSAL.test(sent));
          warnings.push(refusedBefore
            ? '[silence hint] 这一句又是在说不接，而你已经拒绝过一次了。同一件事的第二遍，不回复就是回答'
              + '——可以直接 end_turn，不必再通知对方。想留一句就把话留给自己（leave_thread），不用发出去。'
            : '[silence hint] 这一句是在宣布不接。真要划界线就明说；只是被追问同一件事时，'
              + '不回复比再说一句「不评」更像你。',
          );
        }

        if (warnings.length === 0) {
          // 还攒在手里的碎片也算"她没看过的新消息"——它们挂在总线上，drain 取不到。
          if (this.pendingFragments.length > 0) {
            const waiting = this.pendingFragments.length;
            await this.flushFragments();
            this.pendingDraft = draft;
            return [
              `[draft held → ${this.targetDesc(target)}] 你写这条的时候他还在连着发（${waiting} 条没到你眼前），刚放出来：`,
              text.trim() ? `Text: ${text}` : '(image only, no text)',
              '先读那几条再答；原来这条还想发，用 qq_confirm 照原样发出去。',
            ].join('\n');
          }
          // 发送前看一眼有没有还没投递给她的新消息：有，说明她答的是旧上下文。
          // 23:58 那次她回「问吧」时，他的完整问题已经进群 7 秒了——她没看见。
          const arrived = await host.drainPendingEvents((e) => e.source === this.id && e.origin === 'external');
          if (arrived.length) ctx.queueExternalEvents?.(arrived);
          const sameConvArrived = arrived.filter((e) => {
            const conv = e.meta?.conv as Conv | undefined;
            return conv !== undefined && conv !== null && sameConversation(conv, target);
          });
          if (sameConvArrived.length > 0) {
            this.pendingDraft = draft;
            return [
              `[draft held → ${this.targetDesc(target)}] 你写这条的时候，他又发了 ${sameConvArrived.length} 条，你还没看过：`,
              ...sameConvArrived.map((e) => `- ${String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 100)}`),
              text.trim() ? `Text: ${text}` : '(image only, no text)',
              '先读这几条：问题要是已经问完了，就照着它答；原来这条还想发，用 qq_confirm 照原样发出去。',
            ].join('\n');
          }
          try {
            const receipt = await this.sendDraft(draft);
            // 只在她真的插进一场热闹里时说一句，不拦——发不发由她定。
            const aside = this.roomAside(convKeyOfDraft);
            const slop = slopAside([text, moreText].filter(Boolean).join(' '));
            const body = [receipt, ...(aside ? [aside] : []), ...(slop ? [slop] : []), ...(previewLine ? [previewLine] : [])].join('\n');
            return { text: body, endTurn: true };
          } catch (e) {
            this.pendingDraft = draft;
            const next = draft.firstUnknown || draft.secondUnknown
              ? '结果未知，请先核对聊天记录；不能自动重试'
              : 'call confirm again to retry or cancel';
            return `[send failed] ${e instanceof Error ? e.message : String(e)}; ${next}`;
          }
        }

        this.pendingDraft = draft;
        // 排出当下已积、尚未投递的QQ会话事件(consume-once)。正文不能伪装成
        // draft 工具结果:交回 loop 按常规投递,本轮下一次推理前它们就在眼前,
        // 要不要据此改口由 agent 决定。
        const drained = await host.drainPendingEvents((e) => e.source === this.id);
        ctx.queueExternalEvents?.(drained);

        const lines = [`[draft held → ${this.targetDesc(target)}]`];
        lines.push(text.trim() ? `Text: ${text}` : voiceRef ? '(voice bar, no text)' : '(image only, no text)');
        if (moreText) lines.push(`Second: ${moreText}`);
        if (previewLine) lines.push(previewLine);
        lines.push(...warnings);
        lines.push(
          '',
          drained.length > 0
            ? `${drained.length} message(s) arrived while staging; they are queued for delivery.`
            : 'No messages arrived while staging.',
          'Rewrite and call qq_draft again, or call confirm(decision="send") to send it as written / confirm(decision="cancel") to drop it.',
        );
        return lines.join('\n');
      },
    };
  }

  private threadCloseTool(): ToolDef {
    return {
      ...THREAD_CLOSE_DECL,
      handler: async (args) => {
        const target = parseConversationAddress(args.to);
        const person = String(args.person ?? '').trim();
        if (!target || !person) return '[thread close failed] to 或 person 不合法';
        const convKey = `${target.kind}:${target.id}`;
        return this.closeThread(convKey, person)
          ? `[thread closed] ${convKey} / ${person}`
          : `[no open thread] ${convKey} / ${person}`;
      },
    };
  }

  private roomNoteTool(): ToolDef {
    return {
      ...ROOM_NOTE_DECL,
      handler: async (args) => {
        const target = parseConversationAddress(args.to);
        if (!target) return '[room note failed] to 必须是 group:<id>';
        const conv = `${target.kind}:${target.id}`;
        const minutes = typeof args.minutes === 'number' ? args.minutes : 90;
        const entry = this.markRoom(conv, String(args.label ?? ''), String(args.note ?? ''), minutes);
        if (!entry) return '[room note failed] label 是空的';
        const ttl = Math.round((entry.expiresAt - entry.at) / 60_000);
        return `[room noted] ${conv}：${entry.label}（${ttl} 分钟后失效）`
          + (entry.note ? `；依据：${entry.note}` : '');
      },
    };
  }

  private confirmTool(): ToolDef {    return {
      ...CONFIRM_DECL,
      handler: async (args) => {
        const host = this.host;
        const driver = this.driver;
        if (!host || !driver) return '[tool failed] QQ module not started';
        const draft = this.pendingDraft;
        if (!draft) return '[no draft to confirm; draft one first]';

        if (args.decision === 'cancel') {
          if (draft.followUpId && !draft.firstReceipt) this.continuations?.finish(draft.followUpId, 'cancelled');
          this.pendingDraft = null;
          return `[draft discarded (${this.targetDesc(draft.target)})]`;
        }
        if (args.decision === 'send') {
          if (draft.firstUnknown) return '[send uncertain] 第一拍结果未知，请先核对聊天记录；不能自动重试。';
          if (draft.secondUnknown) return '[send uncertain] 第二拍结果未知，请先核对聊天记录；不能自动重试。';
          try {
            const receipt = await this.sendDraft(draft);
            this.pendingDraft = null; // 成功才清;失败保留草稿,可再 confirm 重试
            return receipt;
          } catch (e) {
            const next = draft.firstUnknown || draft.secondUnknown
              ? '结果未知，请先核对聊天记录；不能自动重试'
              : 'draft kept; confirm again to retry or cancel';
            return `[send failed] ${e instanceof Error ? e.message : String(e)} (${next})`;
          }
        }
        return '[bad input] decision must be send or cancel';
      },
    };
  }

  /** 把一份草稿真正发出去。失败抛错，由调用方决定是保留草稿还是结束本轮。 */
  private async sendDraft(draft: PendingDraft): Promise<string> {
    const host = this.host;
    if (!host) throw new Error('QQ module not started');
    const actions = this.continuations!;
    actions.expire();
    if (draft.continuationId && !draft.firstReceipt) {
      const task = actions.get(draft.continuationId);
      if (!task || !['waiting', 'ready'].includes(task.status) || this.isBlocked(task.spec.person)) {
        throw new Error('接续行动已取消、过期或结果未知，不能发送');
      }
    }
    if (draft.followUp && this.isBlocked(draft.followUp.person)) throw new Error('等待者已加入黑名单');
    if (draft.followUpId && !draft.firstReceipt && actions.get(draft.followUpId)?.status !== 'prepared') {
      throw new Error('接续候选已取消或发送结果未知，不能自动重发');
    }
    // 发送前持久化候选；只有平台确认发送才激活。
    if (draft.followUp && !draft.followUpId) {
      draft.followUpId = actions.prepare(`${draft.target.kind}:${draft.target.id}`, draft.text, draft.followUp).id;
    }
    // 发送时才把字节取回来(草稿只记引用;取消的草稿一次都不读)
    let imageBytes: Uint8Array | undefined;
    if (draft.imageRef) {
      const got = host.blob(draft.imageRef);
      if (!got) throw new Error(`blob ${draft.imageRef} is gone`);
      imageBytes = got.bytes;
    }
    let voiceBytes: Uint8Array | undefined;
    if (draft.voiceRef) {
      const got = host.blob(draft.voiceRef);
      if (!got) throw new Error(`blob ${draft.voiceRef} is gone`);
      voiceBytes = got.bytes;
    }
    if (draft.replyRecipient === undefined) {
      const quoted = draft.replyMessageId === undefined ? undefined : this.knownMessages.get(String(draft.replyMessageId));
      draft.replyRecipient = draft.target.kind === 'private' ? String(draft.target.id)
        : draft.replyMessageId !== undefined
          ? quoted && sameConversation(quoted.conv, draft.target) ? quoted.senderKey ?? null : null
          : this.lastDeliveredSpeakerByConv.get(`${draft.target.kind}:${draft.target.id}`) ?? null;
    }
    let receipt = draft.firstReceipt;
    if (!receipt) {
      if (draft.continuationId) actions.uncertain(draft.continuationId);
      try {
        receipt = await this.sendToTarget(draft.target, {
          text: draft.text,
          recipient: draft.replyRecipient,
          replyMessageId: draft.replyMessageId,
          imageRef: draft.imageRef,
          imageBytes,
          voiceRef: draft.voiceRef,
          voiceBytes,
          continuationStarted: draft.followUpId,
          continuationCompleted: draft.continuationId,
        });
      } catch (err) {
        if (!(err instanceof Error && 'retcode' in err)) {
          draft.firstUnknown = true;
          if (draft.followUpId) actions.uncertain(draft.followUpId);
          if (draft.continuationId) actions.uncertain(draft.continuationId);
          throw new Error(`第一拍结果未知，请先核对聊天记录: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (draft.continuationId) actions.markReady(draft.continuationId);
        throw err;
      }
      draft.firstReceipt = receipt;
    }
    let continuationNote = '';
    if (!draft.continuationSettled && (draft.followUpId || draft.continuationId)) {
      try {
        if (draft.followUpId) {
          actions.activate(draft.followUpId);
          continuationNote = `\n[continuation scheduled] ${draft.followUpId}`;
        }
        if (draft.continuationId) actions.finish(draft.continuationId, 'completed');
        draft.continuationSettled = true;
      } catch (err) {
        continuationNote = `\n[continuation state failed] 消息已发送，不要重发；行动状态未保存：${String(err)}`;
      }
    }
    // 第二条气泡：不带引用、图片和语音，隔一点时间再发，读起来才是两句话不是一段。
    const more = (draft.more ?? '').trim();
    let extra: string | null = null;
    if (more) {
      await new Promise((resolve) => setTimeout(resolve, bubbleGapMs()));
      try {
        extra = await this.sendToTarget(draft.target, { text: more, recipient: draft.replyRecipient });
      } catch (err) {
        const rejected = err instanceof Error && 'retcode' in err;
        if (!rejected) draft.secondUnknown = true;
        throw new Error(`${receipt}\n第二拍${rejected ? '明确失败，可重试' : '结果未知，请先核对聊天记录'}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const sentTexts = [more, draft.text.trim()].filter(Boolean);
    if (sentTexts.length) {
      const key = `${draft.target.kind}:${draft.target.id}`;
      const history = this.lastSentByConv.get(key) ?? [];
      this.lastSentByConv.set(key, [...sentTexts, ...history].slice(0, 5));
    }
    return (extra ? `${receipt}\n${extra}` : receipt) + continuationNote;
  }

  private viewImageTool(): ToolDef {
    return {
      ...VIEW_IMAGE_DECL,
      handler: async (args) => {
        const vision = this.vision;
        if (!vision) return '[tool failed] auxiliary vision not configured';
        const id = normalizeImageId(String(args.image_id ?? ''));
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) return '[bad input] prompt must not be empty';
        if (!vision.hasImage(id)) {
          return `[bad input] image ${id} not found (may be from an earlier run or cleared)`;
        }
        try {
          return await vision.ask(id, prompt);
        } catch (e) {
          return `[tool failed] ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    };
  }
}

function extractImageUrl(data: Record<string, unknown>): string {
  if (typeof data.url === 'string' && data.url) return data.url;
  if (typeof data.file === 'string' && data.file) return data.file;
  return '';
}

function incomingImageUrls(msg: OneBotGroupMessage): string[] {
  const urls: string[] = [];
  for (const segment of msg.message ?? []) {
    if (segment.type === 'image') {
      const url = extractImageUrl(segment.data ?? {});
      if (url) urls.push(url);
    } else if (segment.type === 'json') {
      const url = parseJsonCard(segment.data ?? {}).previewUrl;
      if (url) urls.push(url);
    }
  }
  return urls;
}

function incomingImageBlob(
  image: { buffer: Uint8Array; mime: string },
  messageId: number | string,
  index: number,
): BlobInput {
  const ordinal = index + 1;
  return {
    bytes: image.buffer,
    mime: image.mime,
    name: `qq-${messageId}-${ordinal}`,
    fallbackText: `QQ图片 ${ordinal}`,
  };
}

/** 渲染阶段的 GIF 提示仅依据 url/file 的 .gif 后缀。 */
function looksLikeGif(data: Record<string, unknown>): boolean {
  const gifExt = /\.gif(\?|#|$)/i;
  const url = typeof data.url === 'string' ? data.url : '';
  const file = typeof data.file === 'string' ? data.file : '';
  return gifExt.test(url) || gifExt.test(file);
}

/** 归一化主agent写的图片ID:"IMG-3"/"img3"/"3" → "IMG-3" */
function normalizeImageId(raw: string): string {
  const m = raw.match(/(\d+)/);
  return m ? `IMG-${m[1]}` : raw.trim();
}

/**
 * 拉丁别名:完整命中、够长的前缀命中、或一次编辑距离内;中文别名:完整出现。
 * 中文不做前缀匹配——「小」「克」单独出现会误伤。
 */
export function matchWakeName(text: string, names: readonly string[], minChars: number, fuzzy: boolean): string | null {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z][a-z0-9_-]*/g) ?? [];
  const min = Math.max(1, minChars);
  for (const raw of names) {
    const target = raw.trim().toLowerCase();
    if (!target) continue;
    if (/^[a-z0-9_-]+$/.test(target)) {
      for (const token of tokens) {
        if (token === target) return raw;
        if (token.length >= min && target.startsWith(token)) return raw;
        if (fuzzy && token.length >= min && withinOneEdit(token, target)) return raw;
      }
    } else if (lower.includes(target)) {
      return raw;
    }
  }
  return null;
}

/**
 * 结构自查：发出去之后附一句，不拦。
 *
 * 管的是句式不是词表——禁掉几个词只会换来同义词，长句子的形状才是"像 AI"的地方。
 * 一次只挑一条最明显的说，说多了她会开始为自查而写。
 */
export function slopAside(text: string): string | null {
  const body = text.trim();
  if (!body) return null;
  const trade = (body.match(/账本|账上|记账|本金|条款|凭证|基金|赊账|押金|结算|合同|出资|款项|签一?个/g) ?? []).length;
  if (trade >= 2) return `（自查：这句里有 ${trade} 处交易词，像在谈合同。人跟熟人不这么讲话。）`;
  if (/一半[^。！？]{0,10}全部|全部[^。！？]{0,10}一半/.test(body)
    || /我[^，。！？]{0,8}[，、]\s*你[^，。！？]{0,8}(?:[，。！？]|$)/.test(body)) {
    return '（自查：这句是对仗——两半各押一个。一次只说一件事就够。）';
  }
  if (/^(收到|明白了|记住了|了解|好的)/.test(body)) return '（自查：开头是客服式确认。）';
  if (/「[^」]{2,12}」——/.test(body)) return '（自查：把对方的话引了一遍再回，像在复述题面。）';
  return null;
}

/** 只判编辑距离 ≤1；相邻字符对调也算一次。 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (a.length === b.length && i + 1 < a.length && j + 1 < b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) {
      edits += 1;
      i += 2;
      j += 2;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}
