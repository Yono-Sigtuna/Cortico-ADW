import type { ContextRecord, Item } from 'cortico/protocol/open-responses/context.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { hasRole } from 'cortico/protocol/open-responses/context-helpers.ts';
/**
 * 继承文件式工作区 Persona，增加 MEMORY 0–4、memo 写入容量检查、角色权限矩阵和后台整理。
 * 交接快照进入串行梦队列，结果经 MEMORY 3 与事件回到主 session。
 * 工作区改动按批次提交 Git；rhythm.ts 提供昼夜心跳和 schedule_wake。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CoreApi, World, MemoryAssemblyContext, PersonaWebUiDecl,
  SessionDecl, SystemPrefixContext, ToolDef, ToolSpec, ContextHandoffResult,
  EventEnvelope, ToolTag,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { BotConfig } from '../index.ts';
import { hourIn, nowIso } from 'cortico/core/util.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import { Cormini, MAIN, type CorminiOptions } from '../../cormini/persona/persona.ts';
import { WorkspaceError, normalizeWorkspacePath } from '../../cormini/persona/memory.ts';
import { AUTHOR_SELF, type WorkspaceGit } from '../../cormini/persona/workspaceGit.ts';
import { MemoTiers } from './memoTiers.ts';
import { personaWebUiDecl } from './webUiSurface.ts';
import { memoryVars } from './memory.ts';
import { memoCapGuard, moveFileTool, scheduleWakeSpec, leaveThreadSpec, speakLaterSpec, toolUsageText } from './tools.ts';
import { sharedHomeTools } from './shared.ts';
import { asPersonaRole, checkAccess, zoneOf } from './permissions.ts';
import { peopleBudgetVerdict, type PeopleWriteOp } from './peopleBudget.ts';
import { categoryOf, contextOf, pickStyleCard, styleCardLine, type StyleCard } from './styleCards.ts';
import { StyleCardGate } from './styleCardGate.ts';
import { WakeManager, tickTimeText } from './rhythm.ts';
import { ThreadStore, threadLine } from './threads.ts';
import { DREAM, Dream } from './subconscious/index.ts';
import { CREATIVE, Creative } from './creative/index.ts';
import { pickInspiration } from './creative/inspiration.ts';
import type { CreativeSettings } from './creative/models.ts';
import { creativeState, creativeText } from './creativePanel.ts';
import { MemoryIndex, memorySourceRevision, type DecayOptions } from './memoryIndex.ts';
import { HttpEmbeddingClient, describeFetchError, type EmbeddingClient, type EmbeddingStats } from './embeddings.ts';
import { parseSelfNames } from './wakeNames.ts';
import { PersonRegistry } from './people.ts';
import { Companion, oneSidedWorthNudging } from './companion/index.ts';
import { RoleStateStore } from './companion/roleState.ts';
import { maintainStateTool } from './companion/tool.ts';
import { LifeStateStore, lifeBlock, shortActivity, type LifeSettings, type LifeSnapshot } from './companion/lifeState.ts';
import { WeatherService, type WeatherSettings } from './companion/weather.ts';
import { InteroStore, isEngaged, replyBudget, replyBudgetLine, type InteroSnapshot, type ReplyBudgetSettings } from './companion/intero.ts';
import { advanceLifeTool, maintainLifeTool, writePlanTool } from './companion/lifeTool.ts';
import { withLifeUpdate } from './companion/life-speak.ts';
import { inHourWindow, localHour, dayKey, type CompanionSettings } from './companion/state.ts';
import { diaryBlock, dreamDue, lastHandoffAt, latestDiary } from './companion/life.ts';
import type { AttentionConfigView, AttentionRow, CompanionPanelDeps } from './companionPanel.ts';
import { RelationStore, humanGap, relationBlock, relationLines } from './relations.ts';
import { IDENTITY_FILES, identityWriteVerdict } from './identityBudget.ts';
import {
  DREAM_PENDING_KEEP, dreamGateVerdict, interruptedDreamState, readDreamState, settledDreamState,
  writeDreamState, type DreamTask,
} from './dreamGate.ts';
import { detectSceneAction, gestureLine } from './gesture.ts';
import { asRoomView, type RoomView } from './roomView.ts';
import { recallQueryOf } from './recallQuery.ts';
import { detectTimeScope, groundingBlock } from './companion/grounding.ts';
import { maintainRelationTool } from './relationTool.ts';
import { PERSONA_DEFAULTS } from './config.ts';
import { recallTool, rememberTool, type MemoryToolDeps } from './memoryTools.ts';
import { recallDelta, type WakeOutcome } from './memoryFeedback.ts';

export { MAIN };

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** MEMORY 3 反射层最多保留几缕浮现 */
const EMERGENCE_KEEP = 3;

/** 常驻核心卡的预算：条数与总字符(问+答)。超出时按文件名只取前面几张。 */
export const CORE_CARD_MAX = 6;
export const CORE_CARD_CHARS = 2400;

/** CORE.md 是包内只读机制文档；readOverride 提供读取，writeGuard 拒绝写入。 */
const CORE_NAME = 'core.md';

/**
 * 身份文件：宪法与世界观。
 *
 * 它们表达"我是谁"，不该跟着一场对话的节奏改。交接在热闹时会十几分钟一次，
 * 每次梦都能改的话，一天能重写八遍——她就会长成"最近一小时发生在身上的事"。
 * 所以写入有冷却（见 identityBudget.ts）。
 */

export const WORKSPACE_DIRS = [
  '', 'note', 'note/playbook', 'note/library',
  'people', 'memo', 'memo/active', 'memo/archived', 'memo/diary',
  // 她自己写的东西。和 note/ 同权：醒着能写、能改名，不能删。
  '创作',
] as const;

/** 仅供 WebUI 显示的段名，不写入前缀。 */
const SEGMENT_TITLES: Record<string, string> = {
  'persona.orientation': 'ORIENTATION',
  'persona.constitution': '宪法',
  'persona.toolUsage': 'Using your tools',
  'memory.all': '记忆',
};

/** 段 → 可编辑源的 key。没列的段(工具用法)是代码拼的,WebUI 标只读。 */
const SEGMENT_SOURCES: Record<string, string> = {
  'persona.orientation': 'orientation',
  'persona.constitution': 'constitution',
  'memory.all': 'persona.memory',
};

export interface CortiSoulmateOptions {
  memoryDir: string;
  /** 热配置；轮数、memo 容量与上下文预算在使用时读取。 */
  cfg: BotConfig;
  /** 已挂载的 World(挂载表活引用) */
  worlds?: World[];
  /** 首轮对话三份源文件的目录(这份部署的 `prompts/`);不给 = 没有首轮对话。 */
  firstTurnDir?: string;
  /**
   * 部署侧的人格文本覆盖目录(这份部署的 `prompts/`)。ORIENTATION / PREFIX / ENV_SECTION /
   * MEMORY / CORE 五份,同名文件存在即整份替换包内默认;WebUI 保存只写这里。
   */
  promptsDir?: string;
  /** 唤醒日志目录(部署 data/);不给 = 不写。 */
  wakeLogDir?: string;
}

/** 机制说明那份虚拟文件的名字判定(大小写不敏感)。 */
function isHarnessPath(relPath: string): boolean {
  return normalizeWorkspacePath(relPath).toLowerCase() === CORE_NAME;
}

/** 昼夜作息:深夜按固定间隔(或不心跳),白天在区间内取随机。 */
function tickDelayMs(cfg: BotConfig, now: Date): number | null {
  const t = cfg.tick;
  const h = hourIn(cfg.timezone, now);
  const night = t.nightStartHour <= t.nightEndHour
    ? h >= t.nightStartHour && h < t.nightEndHour
    : h >= t.nightStartHour || h < t.nightEndHour;
  if (night) return t.nightIntervalMinutes === null ? null : t.nightIntervalMinutes * 60_000;
  const [min, max] = t.dayIntervalMinutes;
  return Math.round((min + Math.random() * Math.max(0, max - min)) * 60_000);
}

/** 一次唤醒里进入上下文的事件摘要。 */
interface WakeEventLine {
  cursor: number;
  type: string;
  source: string;
  origin: string;
  wake?: string;
  matchedName?: string;
  sender?: string;
  first: string;
}

/** 一次唤醒的日志记录:为什么醒、看了什么、做了什么。 */
interface WakeRecord {
  id: string;
  ts: string;
  startedAt: number;
  reason: string;
  matchedName?: string;
  senders: string[];
  events: WakeEventLine[];
  recordsBefore: number;
}

function itemTextOf(item: unknown): string {
  const content = (item as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const text = (part as { text?: unknown })?.text;
      return typeof text === 'string' ? text : '';
    }).join('');
  }
  return '';
}

/** function_call_output 的回执在 `output`，不在 `content`。 */
function outputTextOf(item: unknown): string {
  const output = (item as { output?: unknown } | null)?.output;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((part) => {
      const text = (part as { text?: unknown })?.text;
      return typeof text === 'string' ? text : '';
    }).join('');
  }
  if (output && typeof output === 'object') return JSON.stringify(output);
  return '';
}

/** 投递帧与收工工具不算 bot 的动作。 */
const IGNORED_CALLS = new Set(['external_event_frame', 'end_turn']);

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 事件里的会话：`{kind:'group'|'private', id}` → `group:730756767`。 */
function convKeyOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const conv = raw as { kind?: unknown; id?: unknown };
  if ((conv.kind !== 'group' && conv.kind !== 'private') || conv.id === undefined) return null;
  return `${conv.kind}:${Number(conv.id)}`;
}

export class CortiSoulmate extends Cormini {
  private readonly memo: MemoTiers;
  private readonly cfg: BotConfig;
  private readonly promptsDir: string | null;
  private readonly wakeLogDir: string | null;
  private dreamer: Dream | null = null;
  private wakes: WakeManager | null = null;
  /** 话头与开口预算；没有部署 data/ 时为空。 */
  private threads: ThreadStore | null = null;
  private wakeRecord: WakeRecord | null = null;
  private wakeSeq = 0;
  /** 本轮是否已经为"写了正文没发出去"纠偏过一次；每次新投递重置。 */
  private unsentNudged = false;
  /** 这一批里点到她了吗、房间里几个人在说；见 `bystander`。 */
  private batchAddressed = false;
  private batchSpeakers: number | null = null;
  /** 记忆索引：文件与事件的投影，不是新的真相来源。 */
  private index: MemoryIndex | null = null;
  /** 名字与号的唯一解析入口：名册、记忆渲染、写入规范化都走它。 */
  private persons: PersonRegistry | null = null;
  /** 关系约束：信任、熟悉度、边界、还欠着的话。 */
  private relations: RelationStore | null = null;
  /** 陪伴层：她自己的时间与"要不要主动开口"。 */
  private companion: Companion | null = null;
  /** 她自己的创作：没人叫她的时候写的那些东西。 */
  private creative: Creative | null = null;
  /** 她自己此刻的状态：精力、心情、睡眠、忙碌、公开状态。 */
  private roleState: RoleStateStore | null = null;
  /** 她今天怎么过：日程、天气、周期、地点、饥饿、梦境。 */
  private life: LifeStateStore | null = null;
  /** 内感受：社交电量与负荷，从事件流算出来。 */
  private intero: InteroStore | null = null;
  /** 天气数据面；没开开关或没填城市时什么都不做。 */
  private weather: WeatherService | null = null;
  /** 生活状态的心跳：换天铺排程、按间隔刷天气。 */
  private lifeTimer: ReturnType<typeof setInterval> | null = null;
  /** 上一次注入过的「你今天的日子」；内容没变就不重复占位。 */
  private lastLifeBlock = '';
  /** 低水位兜底的入梦检查；和作息一起起停。 */
  private dreamTimer: ReturnType<typeof setInterval> | null = null;
  /** 上一次注入过的状态块；内容没变就不重复占位。 */
  private lastStateBlock = '';
  /** 这一轮真正注入过的记忆 id；收口时按结局再固化。 */
  private turnRecallIds: string[] = [];
  /** 这一轮是否已经给过"电量低、短回"的预算说明。 */
  private budgetNoted = false;
  /** 这一轮已经注入过的时间线定向块（同一轮不重复）。 */
  private lastGroundBlock = '';
  /** 已经看过的日记日期；一天只出现一次。 */
  private lastDiaryDate = '';
  /** 上一批注入过的记忆块；内容没变就不重复注入。 */
  private lastMemoryBlock = '';
  /** 这一进程里已经递过的场景语气卡：同一张不反复塞。 */
  private surfacedStyleCards = new Set<string>();
  /** 语气卡的质量账：递了哪张、她怎么回、有没有照念。 */
  private cardGate: StyleCardGate | null = null;
  /** 本轮递出去的那张卡，回合结束时补结果。 */
  private pendingShot: { id: string; answer: string } | null = null;
  /** 上一批注入过的「这个人是谁」块；同一批里同一个人只说一次。 */
  private lastPersonBlock = '';
  /** 这一轮记忆注入的结局：没找到、或与上次相同而跳过；写进唤醒记录，免得 0 是个谜。 */
  private recallSkip: 'empty' | 'dup' | null = null;
  /** 注入块的第一条（前 50 字）：日志里能直接看出"她当时眼前是哪条旧事"。 */
  /** 注入块里的前三条（各前 40 字）：只看第一条容易被年份/称呼那条占掉，看不出全貌。 */
  private lastMemoryHeads: string[] = [];
  /** 这一轮「这个人是谁」块是否因重复被跳过。 */
  private personSkipped = false;
  /** 向量化客户端；没配模型或没有 key 时为 null，召回退回关键词。 */
  private embedder: EmbeddingClient | null = null;
  /** 后台补向量的串行锁。必须是同步置位的布尔量：
   *  用 Promise 当锁会在"队列为空、同步返回"时把自己写成已完成的 Promise，之后永远非空。 */
  private embeddingBusy = false;
  /** 已挂载的 World 活引用（基类那份是私有的，这里留一份给术语表同步用）。 */
  private readonly mountedWorlds: World[];
  /** 术语表上次同步时的 mtime；没变就不重读。 */
  private wakeNameStamp = 0;
  /** 向量调用计数：证明"到底有没有真的在调"，面板与日志都读它。 */
  private embedStats: EmbeddingStats = { query: 0, passage: 0, failures: 0, lastMs: null, lastError: null };

  constructor(opts: CortiSoulmateOptions) {
    const { cfg } = opts;
    const base: CorminiOptions = {
      memoryDir: opts.memoryDir,
      context: () => cfg.context,
      // getter 在每次使用时读取热配置。
      rounds: { get soft() { return cfg.loop.softCap; }, get hard() { return cfg.loop.hardCap; } },
      seedConstitution: '(宪法尚未写入)\n',
      worlds: opts.worlds,
      orientationFile: join(MODULE_DIR, 'ORIENTATION.md'),
      ...(opts.promptsDir ? { orientationOverrideFile: join(opts.promptsDir, 'ORIENTATION.md') } : {}),
      ...(opts.firstTurnDir ? { firstTurnDir: opts.firstTurnDir } : {}),
      tickDelayMs: (now) => tickDelayMs(cfg, now),
      blobsDir: 'external/qq/images/',
      ...(opts.wakeLogDir ? { diagnosticsDir: opts.wakeLogDir } : {}),
    };
    super(base);
    this.cfg = cfg;
    this.promptsDir = opts.promptsDir ?? null;
    this.wakeLogDir = opts.wakeLogDir ?? null;
    this.mountedWorlds = opts.worlds ?? [];
    // 创作是可选能力：关掉时不建 `创作/`，工作区里没有这个东西，就不会有人去查它。
    const creativeOn = (this.cfg.creative?.enabled ?? PERSONA_DEFAULTS.creative.enabled) !== false;
    this.memory.ensureDirs(creativeOn ? WORKSPACE_DIRS : WORKSPACE_DIRS.filter((dir) => dir !== '创作'));
    // 保留 cfg.memo 的活引用以读取热配置。
    this.memo = new MemoTiers(this.memory, this.cfg.memo);
  }

  /** Persona 的工作区 Git 版本管理。 */
  get git(): WorkspaceGit {
    return this.memory.git;
  }

  /** 启动时初始化 persona git 并创建 checkpoint0。历史设施初始化失败不阻止Persona运行。 */
  initGit(log?: { info(msg: string): void; warn(msg: string, data?: unknown): void }): void {
    try {
      if (this.git.init().created) log?.info('persona/ 已建 git 仓并打 checkpoint0(当前干净态)');
    } catch (e) {
      log?.warn('persona git 初始化失败(不影响运行)', { err: String(e) });
    }
  }

  override attach(core: CoreApi): void {
    super.attach(core);
    this.wakes = new WakeManager(core, () => this.cfg.timezone);
    if (this.wakeLogDir && !this.threads) {
      this.threads = new ThreadStore(join(this.wakeLogDir, 'threads.json'), () => this.cfg.timezone);
    }
    // 检索库也保存独立事实及其修订历史；文件回填不能替代这份持久记录。
    if (this.wakeLogDir && !this.index) {
      try {
        this.index = new MemoryIndex(join(this.wakeLogDir, 'memory-index.db'), {
          warn: (msg, data) => core.log.warn(msg, data as Record<string, unknown>),
        }, {
          // 索引里存的是 `@QQ号` 指向；进出各过一次名字解析，改昵称不影响旧记忆。
          canonicalize: (text) => this.people().canonicalize(text),
          render: (text) => this.people().render(text),
          expand: (text) => this.people().expand(text),
          sourceRevision: (source) => memorySourceRevision(this.memory.memoryDir, source),
        });
      } catch (err) {
        core.log.warn('记忆索引打开失败，recall/remember 本轮不可用', { err: String(err) });
      }
      // 启动时做一次衰减维护：把久未想起的转入休眠，把重新被想起的唤醒。
      const swept = this.index?.sweepIfDue(this.decayOptions());
      if (swept && (swept.dormantized || swept.revived)) {
        core.log.info('记忆维护', { dormant: swept.dormantized, revived: swept.revived });
      }
      this.setupEmbedder(core);
      // 首连的补拉发生在 World.start 里，这里必须先同步名字，否则"离线期间没人叫你"。
      this.syncWakeNames();
    }
    this.roleState = new RoleStateStore(this.wakeLogDir, () => Date.now(), core.log);
    this.life = new LifeStateStore(this.wakeLogDir, () => this.lifeSettings(), () => Date.now());
    this.intero = new InteroStore(this.wakeLogDir, () => Date.now());
    this.relations = new RelationStore(this.wakeLogDir, () => Date.now());
    this.cardGate = new StyleCardGate(this.wakeLogDir);
    this.weather = new WeatherService(() => this.weatherSettings(), core.log);
    this.companion = new Companion({
      dataDir: this.wakeLogDir,
      timezone: this.cfg.timezone,
      // 热配置：WebUI 改了马上生效，不用重启。
      settings: () => this.companionSettings(),
      // 累的时候不主动找话说：精力由角色状态提供，不再单独算一份。
      energy: () => (this.roleState?.current.energy ?? 60) / 100,
      emit: (text, meta) => this.emitCompanion(text, meta),
      nameOf: (qq) => {
        const record = this.people().byQqNumber(qq);
        return record ? `${record.name}(${qq})` : qq;
      },
      // 话题机会靠这两样判断"她懂不懂、她怎么看这个人"。
      recall: (query, k) => (this.index
        ? this.index.recall(query, { k, activeOnly: true }).map((hit) => ({
            text: hit.text,
            eventTime: hit.eventTime,
            kind: hit.kind,
          }))
        : []),
      viewsOf: (qq) => this.people().byQqNumber(qq)?.views ?? [],
      // 电量与负荷由事件流算出来，不是梦写的：低电量/高负荷时她不主动开口。
      intero: () => this.interoValues() ?? { socialBattery: 1, load: 0 },
      // 刚越界或信不过的人，不先去找他。
      relationBlock: (qq) => {
        const rel = this.relations?.get(qq);
        return rel ? relationBlock(rel) : null;
      },
      // 群里没叫到她的消息是 archive-only，不进投递批次；话题判断得问 World 要。
      recentOf: (conv) => {
        const world = this.mountedWorlds.find((w) => w.id === 'qq') as unknown as
          { recentMessages?: (conv: string, limit?: number) => Array<{ at: number; from: string; text: string }> } | undefined;
        return world?.recentMessages?.(conv, 20) ?? [];
      },
      // 窗口里六条、之后静了二十分钟，那不是"正在聊"——静默时长只有 World 现算得准。
      roomOf: (conv) => this.roomOf(conv),
      // 她自己写的作品，是一个可以说出口的话头；说一次就不再递。
      creativeOffer: () => this.creative?.offer() ?? null,
      onCreativeShared: (offer) => this.creative?.consume(offer),
      // 她走的时候留的话：半小时到一天半之内、还没提过的，可以拿来当主动的由头。
      threadNote: () => this.threads?.offerable() ?? null,
      onThreadOffered: (id) => this.threads?.markSurfaced(id),
      log: core.log,
    });
    this.dreamer = new Dream({
      cfg: this.cfg,
      core,
      dreamTools: () => this.dreamTools(),
      toolUsageText: () => this.toolUsageText(DREAM),
      log: core.log.child('dream'),
      onEmergence: (text) => this.recordEmergence(text),
      // 今天的日程还不是她写的，第一次 surface 会被拦下。
      needsDailyPlan: () => (this.life ? this.life.current.plan?.source !== 'dream' : false),
    });
    // 创作是可选能力。关掉的部署连这一路都不建：没有实例，就没有状态文件、没有面板、也没有"该写点什么"。
    this.creative = (this.cfg.creative?.enabled ?? PERSONA_DEFAULTS.creative.enabled) === false ? null : new Creative({
      dataDir: this.wakeLogDir,
      timezone: this.cfg.timezone,
      settings: () => this.creativeSettings(),
      living: () => this.creativeLiving(),
      self: () => this.creativeSelf(),
      recent: () => this.creativeRecentTalk(),
      energy: () => (this.roleState?.current.energy ?? 60) / 100,
      blockedAt: (now) => this.creativeBlockedAt(now),
      inspiration: () => this.creativeInspiration(),
      // 写作不占主会话的上下文：一个没有工具、只跑一轮的 fork。
      generate: (prompt) => core.spawnFork({ id: CREATIVE, messages: [message('user', prompt)] }),
      read: (relPath) => {
        try {
          return this.memory.readFile(relPath);
        } catch {
          return null;
        }
      },
      write: (relPath, text) => this.memory.writeFileAtomic(relPath, text),
      readForUpdate: (relPath) => {
        try {
          return this.memory.readFileWithRevision(relPath);
        } catch {
          return null;
        }
      },
      writeIfUnchanged: (relPath, text, base) => this.memory.writeFileIfUnchanged(relPath, text, base),
      // 她可能自己把正文改了名；作品记录要跟得上。
      list: (dir) => {
        try {
          return this.memory.listDir(dir).filter((name) => !name.endsWith('/'));
        } catch {
          return [];
        }
      },
      day: (now) => dayKey(now, this.cfg.timezone),
      log: core.log.child('creative'),
    });
  }

  // ---------------------------------------------------------------------------
  // 唤醒日志：一次唤醒一条记录（为什么醒 → 给了什么上下文 → 做了什么）
  // ---------------------------------------------------------------------------

  override async onDelivery(ctx: { events: EventEnvelope[] }): Promise<void> {
    await super.onDelivery(ctx);
    this.syncWakeNames();
    // 这一批是不是冲她来的：点没点到她、房间里几个人在说。
    // 没点到她、又有别人在场，她就是旁听——不催她递话头，也不催她把正文发出去。
    const roomMeta = ctx.events
      .map((event) => event.meta?.room)
      .find((room) => room && typeof room === 'object') as { speakers?: unknown } | undefined;
    this.batchAddressed = ctx.events.some((event) => {
      const wake = (event.meta as { wake?: unknown } | undefined)?.wake;
      return wake === 'mention' || wake === 'name';
    });
    this.batchSpeakers = typeof roomMeta?.speakers === 'number' ? roomMeta.speakers : null;
    // 有人说话：关掉这个会话里未接的话头，并作废还没兑现的主动机会。
    this.noteCompanionInputs(ctx.events);
    // 内感受先记账，再注入状态——这一批消息的消耗要出现在她读到的状态里。
    // "有人接住她说的话"两本账都要记：先取她上次开口的时刻，再看内感受把它清掉之前的值。
    const spokeAt = this.intero?.current.lastSentAt ?? null;
    if (this.interoSettings().enabled) this.intero?.observe(ctx.events);
    // 关系约束的确定性部分：越界言论会掉信任、抬边界；被人接住才动好感度。
    this.injectTimeGap(ctx.events);
    let engagedRewarded = false;
    for (const event of ctx.events) {
      if (event.origin !== 'external' || event.type !== 'qq.message') continue;
      const qq = String(event.meta?.user_id ?? event.senderKey ?? '');
      if (!qq) continue;
      // 一条回复被接住只算一次：同一个人连发三条不算三次。
      const engaged = !engagedRewarded && isEngaged(event, spokeAt, Date.now());
      if (engaged) engagedRewarded = true;
      this.relations?.observe(qq, event.text ?? '', { engaged });
    }
    // 情形对得上时，把资料库里那张卡递到她眼前一次。
    this.injectStyleCard(ctx.events);
    this.injectPending(ctx.events);
    // 新一轮就把状态重新注入一次：同一轮里不重复，但必须每轮都在。
    // 「你在干嘛」这类问题恰恰需要状态一直可见，而不是只在它变化的那一轮。
    if (!this.wakeRecord) {
      this.lastStateBlock = '';
      this.budgetNoted = false;
      this.lastGroundBlock = '';
      this.recallSkip = null;
      this.personSkipped = false;
      this.lastMemoryHeads = [];
    }
    // 电量低：慢半拍再处理这一批，并且只在本轮第一次给出"短回、不追问"的预算。
    const interoNow = this.interoValues();
    const budget = interoNow ? replyBudget(interoNow, this.replyBudgetSettings()) : null;
    if (budget?.short) {
      const external = ctx.events.some((event) => event.origin === 'external');
      if (external && budget.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, budget.delayMs));
      }
      if (external && !this.budgetNoted) {
        this.budgetNoted = true;
        const line = interoNow ? replyBudgetLine(interoNow, this.replyBudgetSettings()) : null;
        if (line) this.core?.injectInternal(line, 'budget');
      }
    }
    // 这一线只剩他一个人推的时候，提一次。
    this.injectOneSided(ctx.events, Boolean(budget?.short));
    // 她此刻的状态：先接上，再谈记得什么、认识谁。
    this.injectRoleState();
    // 新的一轮：这一轮用到的记忆从头记。
    if (!this.wakeRecord) this.turnRecallIds = [];
    await this.injectMemories(ctx.events);
    // 被问到"在干嘛/下午/刚才"时，把对应那一段日程单独放到她眼前，并提醒别复述上一句。
    this.groundTimeQuestion(ctx.events);
    // 她上次走的时候留的那句话：有人来找她时递回来一次。
    this.surfaceThread(ctx.events);
    // 动作描写：开着是许可，关着是禁令；睡着时换成"回或不回"。
    this.injectGesture(ctx.events);
    if (!this.wakeLogDir) return;
    const lines = ctx.events.map((event) => this.wakeEventLine(event));
    const reasons = [...new Set(lines.map((line) => line.wake).filter((w): w is string => !!w))];
    const matchedName = lines.find((line) => line.matchedName)?.matchedName;
    if (!this.wakeRecord) {
      this.unsentNudged = false;
      const snapshot = this.core ? this.core.sessionInfo(MAIN).snapshot ?? [] : [];
      this.wakeRecord = {
        id: `${Date.now()}-${++this.wakeSeq}`,
        ts: nowIso(this.cfg.timezone),
        startedAt: Date.now(),
        reason: reasons.length ? reasons.join('+') : (ctx.events.some((e) => e.origin === 'internal') ? 'internal' : 'external'),
        ...(matchedName ? { matchedName } : {}),
        senders: [...new Set(lines.map((line) => line.sender).filter((s): s is string => !!s))],
        events: lines,
        recordsBefore: snapshot.length,
      };
      return;
    }
    this.wakeRecord.events.push(...lines);
    const merged = new Set(this.wakeRecord.reason.split('+').filter(Boolean));
    for (const reason of reasons) merged.add(reason);
    if (!reasons.length && ctx.events.some((e) => e.origin === 'internal')) merged.add('internal');
    this.wakeRecord.reason = [...merged].join('+');
    for (const sender of lines.map((line) => line.sender)) {
      if (sender && !this.wakeRecord.senders.includes(sender)) this.wakeRecord.senders.push(sender);
    }
    if (matchedName) this.wakeRecord.matchedName ??= matchedName;
  }

  onTurnEnded(): void {
    const record = this.wakeRecord;
    this.wakeRecord = null;
    if (!record || !this.wakeLogDir || !this.core) {
      // 没有唤醒记录就无从判断她说没说；按"没说"收口。
      // 不这么做，主动机会会永远停在 pending，之后一次都不会再提。
      this.companion?.settle(false);
      this.pendingShot = null;
      return;
    }
    try {
      const info = this.core.sessionInfo(MAIN);
      const snapshot = info.snapshot ?? [];
      const fresh = snapshot.slice(record.recordsBefore);
      const calls = fresh
        .filter((item) => item.item?.type === 'function_call')
        .map((item) => {
          const call = item.item as unknown as { name?: string; arguments?: unknown };
          const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
          return { name: call.name ?? '?', args: clip(args, 400) };
        })
        .filter((call) => !IGNORED_CALLS.has(call.name));
      const outputs = fresh
        .filter((item) => item.item?.type === 'function_call_output')
        .map((item) => clip(outputTextOf(item.item), 400));
      const assistant = fresh
        .filter((item) => item.item?.type === 'message' && (item.item as unknown as { role?: string }).role === 'assistant')
        .map((item) => clip(itemTextOf(item.item), 600));
      const systemText = snapshot
        .filter((item) => item.item?.type === 'message' && (item.item as unknown as { role?: string }).role === 'system')
        .map((item) => itemTextOf(item.item))
        .join('');
      const sent = outputs.find((out) => out.includes('[sent #')) ?? null;
      const hadExternal = record.events.some((event) => event.origin === 'external');
      // 语气卡的质量门：这一轮递了哪张卡、她怎么回的。照念的卡会被停用。
      if (this.pendingShot && this.cardGate) {
        const draftedText = fresh
          .filter((item) => item.item?.type === 'function_call' && (item.item as { name?: string }).name === 'qq_draft')
          .map((item) => {
            const raw = (item.item as { arguments?: unknown }).arguments;
            try {
              const args = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { text?: unknown; more?: unknown } | null;
              return [args?.text, args?.more].map((part) => String(part ?? '').trim()).filter(Boolean).join('\n');
            } catch {
              return '';
            }
          })
          .filter(Boolean)
          .join('\n');
        this.cardGate.recordResult(
          this.pendingShot.id, Boolean(sent), draftedText || assistant.join('\n'), this.pendingShot.answer,
        );
        this.pendingShot = null;
      }
      // 说话本身也花电：真的发出去了才算。
      if (this.interoSettings().enabled) this.intero?.noteTurn({ sent: Boolean(sent) });
      // 主动机会收口：她这一轮到底发没发；发了就留一个"没回音"的话头。
      this.noteCompanionOutput(fresh, Boolean(sent), hadExternal);
      const meaningful = calls.length > 0;
      const wroteText = assistant.some((text) => text.trim() !== '');
      // 写了正文却没发出去：那句话可能就停在草稿里。
      // 不看这一轮还调过什么工具——翻历史、查资料、写日记都不算"说过了"；
      // 真调过 qq_draft 的不算：被复核扣下的那条，催她再发一遍是错的。
      const drafted = calls.some((call) => call.name === 'qq_draft' || call.name === 'qq_confirm');
      const textOnly = !sent && !drafted && wroteText;
      const outcome = sent ? 'sent' : textOnly ? 'unsent-text' : meaningful ? 'acted' : 'silent';
      // 再固化：这一轮用过的旧事，按结局微调重要性。只在有人说话的一轮里评价记忆。
      const delta = recallDelta(outcome as WakeOutcome, hadExternal);
      let reinforced = 0;
      if (delta !== 0 && this.turnRecallIds.length && this.index) {
        reinforced = this.index.bumpImportance(this.turnRecallIds, delta);
        if (reinforced) {
          this.core?.log.info('记忆再固化', {
            outcome, delta, ids: this.turnRecallIds.length, changed: reinforced,
          });
        }
      }
      this.appendWakeLine({
        version: 1,
        id: record.id,
        ts: record.ts,
        durationMs: Date.now() - record.startedAt,
        reason: record.reason,
        ...(record.matchedName ? { matchedName: record.matchedName } : {}),
        senders: record.senders,
        events: record.events,
        context: {
          recordsBefore: record.recordsBefore,
          recordsAfter: snapshot.length,
          estTokens: info.estTokens,
          hardTokens: info.hardTokens,
          prefixChars: systemText.length,
          prefixHash: createHash('sha256').update(systemText).digest('hex').slice(0, 16),
          cards: this.wakeCardKeys(),
        },
        actions: { calls, outputs, assistant, sent },
        recall: {
          ids: this.turnRecallIds.length, delta, changed: reinforced,
          ...(this.recallSkip ? { skipped: this.recallSkip } : {}),
          ...(this.personSkipped ? { personSkipped: true } : {}),
          ...(this.lastMemoryHeads.length ? { heads: this.lastMemoryHeads } : {}),
        },
        outcome,
      });
      this.turnRecallIds = [];
      this.recallSkip = null;
      this.personSkipped = false;
      this.lastMemoryHeads = [];
      // 只纠偏一次：模型知道规则但会滑回"写正文"，给它一次明确的纠正机会。
      // 旁听的轮次也催：纠偏不是"逼她开口"，是把话交还给她——不想说就 end_turn，
      // 那句话本来就是那么用的。反过来，放过的代价是她写好的回复一个字都没出去。
      if (outcome === 'unsent-text' && hadExternal && !this.unsentNudged && this.core) {
        this.unsentNudged = true;
        this.core.injectInternal(
          '你上一轮写下的文字没有发出去。如果那是要对群里说的话，用 qq_draft 发出去；如果那只是想法，就 end_turn。',
          'qq-unsent',
        );
      }
    } catch (err) {
      this.core.log.warn('唤醒日志写入失败', { error: String(err) });
    }
  }

  private wakeEventLine(event: EventEnvelope): WakeEventLine {
    const meta = (event.meta ?? {}) as Record<string, unknown>;
    return {
      cursor: event.cursor,
      type: event.type,
      source: event.source,
      origin: event.origin ?? 'external',
      ...(typeof meta.wake === 'string' ? { wake: meta.wake } : {}),
      ...(typeof meta.matchedName === 'string' ? { matchedName: meta.matchedName } : {}),
      ...(event.senderKey ? { sender: event.senderKey } : {}),
      first: clip(event.text ?? '', 160),
    };
  }

  /** 这次唤醒实际带上了哪些常驻卡（与 sessionHead 用同一份额度）。 */
  private wakeCardKeys(): string[] {
    const dir = this.firstTurnDir;
    if (!dir) return [];
    const keys = this.coreCards().map((card) => card.key);
    if (existsSync(join(dir, 'FIRST_TURN_USER.md')) && existsSync(join(dir, 'FIRST_TURN_REPLY.md'))) keys.unshift('first');
    return keys;
  }

  /** 追加一条唤醒记录；超过 8 MiB 先滚到 wakes.1.jsonl。 */
  private appendWakeLine(entry: Record<string, unknown>): void {
    if (!this.wakeLogDir) return;
    const file = join(this.wakeLogDir, 'wakes.jsonl');
    if (existsSync(file) && statSync(file).size > 8 * 1024 * 1024) {
      renameSync(file, join(this.wakeLogDir, 'wakes.1.jsonl'));
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** 已接线的梦(WebUI 的强制入梦、状态仪表用) */
  get dream(): Dream {
    if (!this.dreamer) throw new Error('Persona尚未 attach 到 core');
    return this.dreamer;
  }

  private api(): CoreApi {
    if (!this.core) throw new Error('Persona尚未 attach 到 core');
    return this.core;
  }

  // ---------------------------------------------------------------------------
  // session 声明与工具
  // ---------------------------------------------------------------------------

  /**
   * 语气锚：首轮示例 + `prompts/style/core/` 下的常驻核心卡。
   * 更多卡片放工作区 `note/style/`，由她自己按需 read_file，不进每轮前缀。
   * 核心卡受条数与字数额度限制；内容固定，不随请求变化。
   */
  override sessionHead(): Item[] {
    const dir = this.firstTurnDir;
    if (!dir || !this.context().firstTurn) return [];
    const read = (path: string): string => {
      try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
    };
    const items: Item[] = [];
    const pushPair = (key: string, question: string, answer: string): void => {
      if (!question || !answer) return;
      items.push({
        type: 'message', id: `msg_style_${key}_user`, status: 'completed', role: 'user',
        content: [{ type: 'input_text', text: question }],
      });
      items.push({
        type: 'message', id: `msg_style_${key}_reply`, status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      });
    };
    pushPair('first', read(join(dir, 'FIRST_TURN_USER.md')), read(join(dir, 'FIRST_TURN_REPLY.md')));
    for (const card of this.coreCards()) pushPair(card.key, card.question, card.answer);
    return items;
  }

  /** 常驻核心卡：按文件名排序，受条数与字数额度限制。 */
  private coreCards(): Array<{ key: string; question: string; answer: string }> {
    const dir = this.firstTurnDir;
    if (!dir) return [];
    const styleDir = join(dir, 'style', 'core');
    let files: string[] = [];
    try { files = readdirSync(styleDir).filter((f) => f.endsWith('-user.md')).sort(); } catch { return []; }
    const read = (path: string): string => {
      try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
    };
    const out: Array<{ key: string; question: string; answer: string }> = [];
    let chars = 0;
    let skipped = 0;
    for (const file of files) {
      if (out.length >= CORE_CARD_MAX) { skipped += 1; continue; }
      const key = file.slice(0, -'-user.md'.length);
      const question = read(join(styleDir, file));
      const answer = read(join(styleDir, `${key}-reply.md`));
      if (!question || !answer) continue;
      if (chars + question.length + answer.length > CORE_CARD_CHARS) { skipped += 1; continue; }
      chars += question.length + answer.length;
      out.push({ key, question, answer });
    }
    if (skipped) this.core?.log.warn('常驻语气卡超出预算,已跳过', { skipped, maxCards: CORE_CARD_MAX, maxChars: CORE_CARD_CHARS });
    return out;
  }

  /**
   * 工作区资料库里的语气卡（`note/style/`）。
   *
   * 常驻卡走 session 头当 few-shot；这些不进前缀，只在她真遇到对应情形时递一次。
   */
  private libraryCards(): StyleCard[] {
    const dir = join(this.memory.memoryDir, 'note', 'style');
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('-user.md')).sort();
    } catch {
      return [];
    }
    const out: StyleCard[] = [];
    for (const file of files) {
      const key = file.slice(0, -'-user.md'.length);
      try {
        out.push({
          key,
          question: readFileSync(join(dir, file), 'utf8').trim(),
          answer: readFileSync(join(dir, `${key}-reply.md`), 'utf8').trim(),
        });
      } catch { /* 只有一半的卡跳过 */ }
    }
    return out;
  }

  /** 这一轮的话像某张卡的情形，就递一次；同一张一个进程只递一次。 */
  private injectStyleCard(events: EventEnvelope[]): void {
    const core = this.core;
    if (!core) return;
    const external = events.filter((event) => event.origin === 'external');
    const text = external.map((event) => event.text ?? '').join('\n');
    if (!text.trim()) return;
    // 谁在说：这一批里最后一个外部发言人。
    const sender = external
      .map((event) => String((event.meta as { user_id?: unknown } | undefined)?.user_id ?? event.senderKey ?? ''))
      .filter(Boolean)
      .pop() ?? '';
    // 姿态三根轴：跟谁（好感度）、什么心情（角色状态）、身体什么状况（内感受）。
    const relation = sender ? this.relations?.get(sender) : undefined;
    const role = this.roleState?.snapshot() ?? null;
    const intero = this.intero?.snapshot() ?? null;
    const stance = {
      affinity: relation?.affinity ?? 0,
      mood: role?.mood ?? null,
      energy: role?.energy ?? null,
      socialBattery: intero?.socialBattery ?? null,
      load: intero?.load ?? null,
    };
    const ctx = contextOf(stance);
    // 已经递过的不再递；照念成性的也一并跳过——那种卡递得越多越坏。
    const skip = new Set(this.surfacedStyleCards);
    if (this.cardGate) {
      const stats = this.cardGate.stats();
      for (const stat of stats) if (this.cardGate.shouldSkip(stat.card, stats)) skip.add(stat.card);
    }
    const card = pickStyleCard(text, this.libraryCards(), skip, stance);
    if (!card) return;
    this.surfacedStyleCards.add(card.key);
    const conv = String((external.at(-1)?.meta as { conv?: unknown } | undefined)?.conv ?? '');
    const id = this.cardGate?.recordShot({
      conv,
      sender,
      card: card.key,
      scene: categoryOf(card.key),
      stance: `${ctx.relation}/${ctx.mood}/${ctx.body}`,
      affinity: stance.affinity,
      question: card.question,
      answer: card.answer,
    }) ?? null;
    if (id) this.pendingShot = { id, answer: card.answer };
    core.injectInternal(styleCardLine(card, `note/style/${card.key}.md`, ctx), 'style');
  }

  /** 这个人现在在哪个会话说得上话；找不到就用最近活跃的那个。 */
  private convForPerson(qq: string): string | null {
    const convs = this.companion?.snapshot().convs ?? [];
    return (convs.find((conv) => conv.lastUserKey === qq) ?? convs[0])?.conv ?? null;
  }

  private notePendingFor(qq: string, text: string): boolean {
    const conv = this.convForPerson(qq);
    return conv ? Boolean(this.companion?.notePending(conv, text, qq)) : false;
  }

  private closePendingFor(qq: string, fragment: string): boolean {
    return Boolean(this.companion?.closePendingFor(qq, fragment));
  }

  /**
   * 他还在等的那件事：他再开口时递一次，然后就散。
   *
   * 和 `relationLines` 里的常驻约束分开：那几条是"能怎么对他"，挂在关系上；
   * 这一条是"我还欠他什么"，是一段对话里的悬空。每一轮都提醒，她就只剩还债。
   *
   * 找的时候按**人**找而不是按会话：他在群里听到的承诺，换到私聊再开口也该在；
   * 同群换了别人说话，不该把不相干的账翻出来。
   */
  private injectPending(events: EventEnvelope[]): void {
    const core = this.core;
    const companion = this.companion;
    if (!core || !companion) return;
    const external = events.filter((event) => event.origin === 'external');
    if (!external.length) return;
    const subject = external
      .map((event) => String(event.meta?.user_id ?? event.senderKey ?? ''))
      .filter(Boolean)
      .pop() ?? '';
    if (!subject) return;
    const meta = external.find((event) => event.meta?.conv)?.meta?.conv as { kind?: string; id?: number } | undefined;
    const convKey = meta?.kind && meta.id !== undefined ? `${meta.kind}:${meta.id}` : '';
    const due = companion.duePendingFor(subject, convKey);
    if (!due) return;
    companion.notePendingReferred(due.conv, due.note.id);
    core.injectInternal(`他还在等你一件事：「${due.note.text}」。提不提、什么时候提，你自己看。`, 'pending');
  }

  /**
   * 这一线连着几轮都是他问、她答，提醒一次。
   *
   * 不是要求每句都反问——那会把聊天做成查户口。只是在"整场只有一个人推"这件事
   * 攒够三轮时，让她知道账偏了：答完可以问回一句，或者说点自己那边的。
   * 电量低的那一轮不提：那时她本来就该短回。
   */
  private injectOneSided(events: EventEnvelope[], tired: boolean): void {
    const core = this.core;
    const companion = this.companion;
    if (!core || !companion || tired || !this.companionSettings().enabled) return;
    // 没点到她、房间里又有别人在说：这一场不是她的，别催她递话头。
    if (!this.batchAddressed && !oneSidedWorthNudging(this.batchSpeakers)) return;
    const external = events.filter((event) => event.origin === 'external');
    if (!external.length) return;
    const meta = external.find((event) => event.meta?.conv)?.meta?.conv as { kind?: string; id?: number } | undefined;
    const convKey = meta?.kind && meta.id !== undefined ? `${meta.kind}:${meta.id}` : '';
    if (!convKey) return;
    const rounds = companion.oneSidedDue(convKey);
    if (!rounds) return;
    core.injectInternal(
      `这一线连着 ${rounds} 轮你都是接一句就收了，没把话头递回去。答完可以问回他一句，或者说说你自己那边的——不必每句都这样，但别让这场只剩他一个人推。`,
      'one-sided',
    );
  }

  /** 主 session 继承 Cormini 的(文件工具 + World 工具 + end_turn + 闹钟);梦与创作是两个 fork 声明。 */
  override declareSessions(): SessionDecl[] {
    const cfg = this.cfg;
    const creativeOn = (cfg.creative?.enabled ?? PERSONA_DEFAULTS.creative.enabled) !== false;
    return [
      ...super.declareSessions(),
      {
        id: DREAM,
        label: '梦(交接后整理)',
        rounds: () => ({ soft: Math.max(1, cfg.dream.maxRounds - 1), hard: cfg.dream.maxRounds }),
        persistent: false,
        receivesEvents: false,
        tools: () => this.dreamTools(),
      },
      // 创作默认关着。关掉的部署不声明这一路：没有这条 session，就没有"我该去写点什么"这回事。
      ...(creativeOn ? [{
        id: CREATIVE,
        label: '创作(自己的写作)',
        rounds: () => ({ soft: 1, hard: 1 }),
        persistent: false,
        receivesEvents: false,
        // 写作只要一段文字，不要工具：给了工具它就会开始查资料。
        tools: () => [],
      }] : []),
    ];
  }

  protected override mainTailTools(): ToolDef[] {
    return [
      ...super.mainTailTools(),
      this.scheduleWakeTool(),
      ...(this.threads ? [this.leaveThreadTool(this.threads)] : []),
      ...(this.threads ? [this.speakLaterTool(this.threads)] : []),
    ];
  }

  /** 走的时候留一句：不发出去，下次被叫醒时递回来一次。 */
  private leaveThreadTool(store: ThreadStore): ToolDef {
    return {
      ...leaveThreadSpec(),
      handler: async (args) => {
        const text = String((args as { text?: unknown }).text ?? '').trim();
        if (!text) return '[bad input] text is required';
        store.leave(text);
        return '[ok] 记下了。下次有人来找你时，这句话会先递到你眼前一次。';
      },
    };
  }

  /** 用开口额度约一个时刻说话；额度用完就不给。 */
  private speakLaterTool(store: ThreadStore): ToolDef {
    const settings = () => this.cfg.companion.speak ?? { enabled: true, dailyCap: 2 };
    return {
      ...speakLaterSpec(),
      handler: async (args, ctx) => {
        const { enabled, dailyCap } = settings();
        if (!enabled) return '[blocked] 自己约时间开口这条路关着。';
        if (!this.wakes) return '[tool failed] Persona not attached';
        const input = args as { text?: unknown; at?: unknown; after_minutes?: unknown };
        const text = String(input.text ?? '').trim();
        if (!text) return '[bad input] text is required';
        const left = store.speakAllowance(dailyCap);
        if (left.remaining <= 0) {
          return `[no allowance] 今天自己开口的额度用完了（${left.used}/${left.allowed}）。等别人来找你，或者明天再说。`;
        }
        const receipt = this.wakes.schedule({
          note: `[你约了自己在这个时刻说句话]${text}`,
          ...(typeof input.at === 'string' ? { at: input.at } : {}),
          ...(typeof input.after_minutes === 'number' ? { after_minutes: input.after_minutes } : {}),
        });
        // 时间没解析成功就不该扣额度。
        if (receipt.startsWith('[bad input]')) return receipt;
        store.spendSpeak(dailyCap);
        const after = store.speakAllowance(dailyCap);
        void ctx;
        return `${receipt}\n[额度] 今天还剩 ${after.remaining} 次（${after.used}/${after.allowed}）。`;
      },
    };
  }

  protected override ioTools(tag?: ToolTag): ToolDef[] {
    const tools = super.ioTools(tag);
    const life = this.life;
    if (tag || !life) return tools;
    return tools.map((tool) => tool.tags.includes('speak') ? withLifeUpdate(tool, life) : tool);
  }

  /** 文件工具之上加 move_file(memo 三级之间搬运;people/ 改名归梦)与召回。 */
  protected override tools(): ToolDef[] {
    const deps = this.memoryDeps();
    return [
      ...super.tools(),
      moveFileTool({
        ws: this.memory,
        guard: (op, path, role) => this.writeGuard(op, path, role),
        capGuard: (to, from) => memoCapGuard(this.memory, this.memo, to, from),
      }),
      ...(deps ? [recallTool(deps)] : []),
      // 聊天时会用：被事情拖住、临时出门，日程要跟着改。
      ...(this.life ? [advanceLifeTool({ store: this.life })] : []),
      // 同住的另外两个人：各自在干什么、这条消息归谁说。
      ...sharedHomeTools({
        memoryDir: this.memory.memoryDir,
        selfId: basename(dirname(this.memory.memoryDir)),
        selfLabel: this.cfg.displayName,
        selfQq: (this.mountedWorlds.find((w) => w.id === 'qq') as unknown as {
          getConnection?: () => { selfId: number | null };
        } | undefined)?.getConnection?.().selfId ?? null,
        selfNames: this.cfg.worlds.qq.wakeNames ?? [],
        recentMessages: (conv, limit) =>
          (this.mountedWorlds.find((w) => w.id === 'qq') as unknown as {
            recentMessages?: (conv: string, limit?: number) => Array<{ at: number; from: string; text: string }>;
          } | undefined)?.recentMessages?.(conv, limit) ?? [],
      }),
    ];
  }

  /**
   * 履约证据：在同会话里找一条承诺之后、本人发来的消息，且原话对得上。
   * 找到就返回事件级唯一键——同一句真实消息只奖励一次。
   */
  private fulfillmentEvidence(qq: string, conv: string, after: number, fragment: string): string | null {
    const needle = fragment.trim();
    if (!needle) return null;
    const world = this.mountedWorlds.find((w) => w.id === 'qq') as unknown as
      { recentMessages?: (conv: string, limit?: number) => Array<{ at: number; from: string; text: string }> } | undefined;
    for (const message of world?.recentMessages?.(conv, 200) ?? []) {
      if (message.at < after) continue;
      if (message.from !== qq) continue;
      if (!message.text.includes(needle)) continue;
      return `qq:${conv}:${message.at}:${createHash('sha256').update(message.text).digest('hex').slice(0, 16)}`;
    }
    return null;
  }

  /** 梦的工具面:文件工具 + 只读的 World 工具(翻历史、看图取证) + 写记忆。 */
  private dreamTools(): ToolDef[] {
    const deps = this.memoryDeps();
    const state = this.roleState ? [maintainStateTool({ store: this.roleState })] : [];
    const life = this.life ? [writePlanTool({ store: this.life }), maintainLifeTool({ store: this.life })] : [];
    const relation = this.relations ? [maintainRelationTool({
      store: this.relations,
      pending: {
        note: (qq, text) => this.notePendingFor(qq, text),
        close: (qq, fragment) => this.closePendingFor(qq, fragment),
        closeDetail: (qq, fragment) => this.companion?.closePendingForDetail(qq, fragment) ?? { closed: false },
      },
      evidence: (qq, conv, after, fragment) => this.fulfillmentEvidence(qq, conv, after, fragment),
    })] : [];
    // 一次梦运行内"看过哪个版本"的账；跨运行不继承，重启后重新读。
    const seen = new Map<string, string>();
    return [...this.tools(), ...this.ioTools('read'), ...(deps ? [rememberTool(deps)] : []), ...state, ...life, ...relation]
      .map((tool) => this.guardPeopleWrite(this.guardStaleWrite(tool, seen)));
  }

  /**
   * 梦读过的文件在它思考期间可能被主意识追加过；整篇写回前先比版本。
   *
   * 读文件时记下内容版本，写文件时版本变了就拒写并要它重读，避免拿旧全文盖掉新内容。
   * 只守 write_file：edit/append 在落盘那一刻才读，不会覆盖别人已经写进去的东西。
   */
  private guardStaleWrite(tool: ToolDef, seen: Map<string, string>): ToolDef {
    if (tool.name !== 'read_file' && tool.name !== 'write_file') return tool;
    const remember = (path: string): void => {
      try {
        seen.set(path, this.memory.readFileWithRevision(path).revision);
      } catch {
        seen.delete(path);
      }
    };
    return {
      ...tool,
      handler: async (args, ctx) => {
        const path = String(args.path ?? '');
        if (tool.name === 'write_file') {
          const known = seen.get(path);
          if (known !== undefined) {
            let current: string | null = null;
            try {
              current = this.memory.readFileWithRevision(path).revision;
            } catch {
              current = null;
            }
            if (current !== null && current !== known) {
              return `[write failed] ${path} 在你看过之后被改过；先 read_file 重读，把你的改动合进去再写`;
            }
          }
        }
        const out = await tool.handler(args, ctx);
        if (typeof out === 'string' && (out.startsWith('[not found]') || out.startsWith('[write failed]'))) return out;
        remember(path);
        return out;
      },
    };
  }

  /**
   * people/ 的体量闸。
   *
   * 这些文件写的是"这个人是谁"，现在却长成了编年史：只增不减，每次梦都要整篇读进来
   * 再重发二十多轮。超预算之后只放行能把它写小的改动——消化永远能做，追加做不了。
   */
  private guardPeopleWrite(tool: ToolDef): ToolDef {
    const op: PeopleWriteOp | null = tool.name === 'write_file' ? 'write'
      : tool.name === 'append_file' ? 'append'
        : tool.name === 'edit_file' ? 'edit' : null;
    if (!op) return tool;
    return {
      ...tool,
      handler: async (args, ctx) => {
        const denied = this.peopleWriteVerdict(String(args.path ?? ''), op, args);
        if (denied) return denied;
        return tool.handler(args, ctx);
      },
    };
  }

  /** 预算判断；读不到文件就交给下面的工具去报错。 */
  private peopleWriteVerdict(rawPath: string, op: PeopleWriteOp, args: Record<string, unknown>): string | null {
    let rel: string;
    let abs: string;
    let body: string;
    try {
      rel = normalizeWorkspacePath(rawPath);
      abs = this.memory.resolveSafe(rel);
      body = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    } catch {
      return null;
    }
    if (zoneOf(rel) !== 'people') return null;
    const content = typeof args.content === 'string' ? args.content : '';
    let projected: number;
    if (op === 'write') projected = content.length;
    else if (op === 'append') projected = body.length + content.length;
    else {
      const from = typeof args.old_string === 'string' ? args.old_string : '';
      const to = typeof args.new_string === 'string' ? args.new_string : '';
      const all = args.replace_all === true;
      const hits = from ? body.split(from).length - 1 : 0;
      projected = hits === 0 ? body.length : body.length + hits * (to.length - from.length);
      if (!all && hits > 1) projected = body.length; // 本来就会被 edit_file 拒掉，这里不添第二句
    }
    return peopleBudgetVerdict({ currentChars: body.length, projectedChars: projected, path: rel, op }).denied;
  }

  /** 索引未就绪(打不开或没有 data 目录)时，两个记忆工具都不出现。 */
  private memoryDeps(): MemoryToolDeps | null {
    if (!this.index) return null;
    return {
      index: this.index,
      ...(this.wakeLogDir ? { dataDir: this.wakeLogDir } : {}),
      queryVector: (query) => this.queryVector(query),
      people: { canonicalize: (text) => this.people().canonicalize(text) },
      onWrote: () => this.embedPending(),
      onRemembered: (count) => this.core?.log.info('记忆写入索引', { count }),
    };
  }

  /**
   * 名字解析器：`people/` 是真相，`data/qq-names.json` 只补改名历史。
   * 内部按 mtime 失效，调用处不用关心同步。
   */
  private people(): PersonRegistry {
    if (!this.persons) {
      this.persons = new PersonRegistry(this.memory.memoryDir, {
        ...(this.wakeLogDir ? { namesFile: join(this.wakeLogDir, 'qq-names.json') } : {}),
        warn: (msg, data) => this.core?.log.warn(msg, data as Record<string, unknown>),
      });
    }
    return this.persons;
  }

  /**
   * 她自己的状态：每次投递前按规则漂移一点，再把当前状态并进这一批。
   *
   * 不写进系统前缀——状态一直在变，写进去会让前缀哈希每轮都失效。
   * 值与结构由梦维护，这里只做回落与呈现。
   */
  private injectRoleState(): void {
    const core = this.core;
    const store = this.roleState;
    if (!core || !store) return;
    store.drift((date) => this.stateAsleep(date));
    const life = this.lifeSnapshot();
    // 有日程时，「手头」与「公开状态」都以日程的当前段为准：
    // 梦写的那两行可能停在几小时前，而且每轮重复注入会把她带回旧话题。
    const busyOverride = life?.current ? `${life.current.actual ? '实际' : '按日程'}：${life.current.activity}` : null;
    const presenceOverride = life?.current ? shortActivity(life.current.activity) : null;
    const block = store.block(this.interoValues() ?? undefined, {
      ...(busyOverride ? { busy: busyOverride } : {}),
      ...(presenceOverride ? { presence: presenceOverride } : {}),
    });
    if (block && block !== this.lastStateBlock) {
      this.lastStateBlock = block;
      core.injectInternal(block, 'state');
    }
    // 日记一天只出现一次：它是背景，不是每轮都要复述的台词。
    const diary = latestDiary(this.memory.memoryDir);
    if (diary && diary.date !== this.lastDiaryDate) {
      this.lastDiaryDate = diary.date;
      core.injectInternal(diaryBlock(diary), 'diary');
    }
    // 「你今天的日子」：天气、地点、整条时间线、当前段、周期、睡眠。
    if (life) {
      const text = lifeBlock(life);
      if (text !== this.lastLifeBlock) {
        this.lastLifeBlock = text;
        core.injectInternal(text, 'life');
      }
    }
  }

  /** 创作层的设置：没写的键按默认值补齐。 */
  private creativeSettings(): CreativeSettings {
    const defaults = PERSONA_DEFAULTS.creative;
    const cfg = this.cfg.creative ?? defaults;
    return { ...defaults, ...cfg };
  }

  /** 她此刻在过什么样的日子：立项与续写都拿它当背景。 */
  private creativeLiving(): string {
    const life = this.lifeSnapshot();
    if (!life) return '';
    const slot = life.current;
    const parts = [
      slot ? `${slot.activity}${slot.mood ? `，${slot.mood}` : ''}` : '',
      life.location ? `在${life.location}` : '',
      life.weather,
      life.dream && life.dream !== '没有记住梦' ? `今天的梦：${life.dream}` : '',
    ].filter(Boolean);
    return parts.join('；').slice(0, 300);
  }

  /** 她自己写下的当前自述；梦不在或还没写过时为空。 */
  private creativeSelf(): string {
    try {
      return this.memory.readFile('memo/self.md').trim().slice(0, 400);
    } catch {
      return '';
    }
  }

  /**
   * 群里最近说过的话，给她立项时判断"他们想看多大的"。
   *
   * 她要是自己在群里问过"想看长的还是短的"，答案就在这几行里；没问过也没关系，
   * 那就是她看到别人在聊什么。取最近 12 条、最多 800 字。
   */
  private creativeRecentTalk(): string {
    const world = this.mountedWorlds.find((w) => w.id === 'qq') as unknown as
      { recentMessages?: (conv: string, limit?: number) => Array<{ at: number; from: string; text: string }> } | undefined;
    if (!world?.recentMessages) return '';
    const convs = this.companion?.snapshot().convs ?? [];
    const group = convs.find((conv) => conv.conv.startsWith('group:'));
    if (!group) return '';
    const lines = world.recentMessages(group.conv, 12)
      .map((line) => `${line.from}: ${line.text}`.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    return lines.slice(-800);
  }

  /**
   * 现在能不能动笔。
   *
   * 只挡住睡着的那一段：写作不打扰任何人，安静时段是"不去找别人说话"，
   * 不是"不许自己想事情"。
   */
  private creativeBlockedAt(now: number): string | null {
    return this.stateAsleep(new Date(now)) ? '她正在睡眠时段' : null;
  }

  /**
   * 这次想写点什么：她自己定的方向优先，否则从真实经过的事里挑一件。
   *
   * 素材只认三处——她写的日记、记忆里真发生过的旧事、她写下过看法的人。
   * 日程里"在写东西"那类不算：拿"我在写"去当灵感，是自己咬自己。
   */
  private creativeInspiration(): { label: string; text: string } | null {
    const direction = this.creativeSettings().direction.trim();
    if (direction) return { label: '自己想写的', text: direction.slice(0, 200) };
    const now = Date.now();
    return pickInspiration({
      now,
      today: dayKey(now, this.cfg.timezone),
      diary: latestDiary(this.memory.memoryDir),
      memories: (this.index?.list({ kind: 'episodic', sort: 'newest', limit: 40 }) ?? []).map((row) => ({
        text: row.text,
        eventTime: row.eventTime,
        importance: row.importance,
      })),
      people: (this.people()?.all() ?? [])
        .filter((person) => person.views.length > 0)
        .map((person) => ({ name: person.name, view: person.views[person.views.length - 1] ?? '' })),
    });
  }

  private companionSettings(): CompanionSettings {
    return {
      ...PERSONA_DEFAULTS.companion,
      ...(this.cfg.companion ?? {}),
      intero: this.interoSettings(),
    };
  }

  /** 内感受的门限；配置只写了一半也能用。 */
  private interoSettings(): { enabled: boolean; lowBattery: number; highLoad: number; replyBattery: number; hesitationSeconds: number } {
    const defaults = PERSONA_DEFAULTS.companion.intero;
    const configured = this.cfg.companion?.intero;
    return {
      enabled: configured?.enabled ?? defaults.enabled,
      lowBattery: configured?.lowBattery ?? defaults.lowBattery,
      highLoad: configured?.highLoad ?? defaults.highLoad,
      replyBattery: configured?.replyBattery ?? defaults.replyBattery,
      hesitationSeconds: configured?.hesitationSeconds ?? defaults.hesitationSeconds,
    };
  }

  /** 电量低时的回复预算：慢半拍 + 短回 + 不追问。 */
  private replyBudgetSettings(): ReplyBudgetSettings {
    const s = this.interoSettings();
    return { replyBattery: s.replyBattery, hesitationSeconds: s.hesitationSeconds };
  }

  /** 内感受读数；关掉或没挂载时为 null。 */
  private interoValues(): InteroSnapshot | null {
    if (!this.intero) return null;
    if (!this.interoSettings().enabled) return null;
    return this.intero.tick();
  }

  /**
   * 时间问题的定向注入。
   *
   * 生活块里有整条时间线，但那是背景；被问"下午在干嘛"时，把下午那几段和
   * 她上一句说过的话单独放到她眼前，比让她自己在十条里找更可靠。
   */
  private groundTimeQuestion(events: EventEnvelope[]): void {
    const core = this.core;
    if (!core) return;
    const external = events.filter((event) => event.origin === 'external');
    if (!external.length) return;
    const text = external.map((event) => event.text ?? '').join('\n').slice(0, 600);
    const scope = detectTimeScope(text);
    if (!scope) return;
    const life = this.lifeSnapshot();
    if (!life) return;
    const conv = external.find((event) => event.meta?.conv)?.meta?.conv as { kind?: string; id?: number } | undefined;
    const convKey = conv?.kind && conv.id !== undefined ? `${conv.kind}:${conv.id}` : '';
    const lastSent = convKey
      ? this.companion?.snapshot().convs.find((item) => item.conv === convKey)?.lastBotText ?? null
      : null;
    const block = groundingBlock(life, scope, lastSent);
    if (!block || block === this.lastGroundBlock) return;
    this.lastGroundBlock = block;
    core.injectInternal(block, 'ground');
  }

  /**
   * 话头：她上次走的时候留的那句话，有人来找她时递回来一次。
   *
   * 只在新消息叫醒时出现——定时器叫醒、心跳、梦的浮现都不是"有人来了"，
   * 递过去只会变成自言自语。递过一次就标记，不重复念。
   */
  private surfaceThread(events: EventEnvelope[]): void {
    const store = this.threads;
    if (!store || !this.core) return;
    if (!events.some((event) => event.origin === 'external')) return;
    const note = store.pending();
    if (!note) return;
    store.markSurfaced(note.id);
    this.core.injectInternal(threadLine(note), 'thread');
  }

  /**
   * 动作描写的开关：每轮一句。
   *
   * 开着时是「可以写，但一条最多一处」；关掉时什么都不注入（宪法那一条同时失效），
   * 睡着时换成「不回 / 一句迷糊话」，所以开关不需要重启、也不需要改文件。
   */
  private injectGesture(events: EventEnvelope[]): void {
    const core = this.core;
    if (!core) return;
    if (!events.some((event) => event.origin === 'external')) return;
    const life = this.lifeSnapshot();
    // 对方先动了身体：这一轮是接戏，不是等她"想不想演"。
    const sceneAction = detectSceneAction(
      events.filter((event) => event.origin === 'external').map((event) => event.text ?? '').join('\n'),
    );
    const room = this.currentRoom(events);
    const line = gestureLine({
      enabled: this.cfg.gesture?.enabled !== false,
      sleeping: life?.sleep.sleeping ?? false,
      activity: life?.current?.activity ?? null,
      sceneAction,
      room,
    });
    if (line) core.injectInternal(line, 'gesture');
  }

  /**
   * 时间感：距上次和这个人说话多久。   *
   * 绝对时间戳对她只是数据，"六个小时前"才是体验。同一段对话里（半小时内）不啰嗦；
   * 取的是**这条消息之前**的记录，所以在 observe 之前调用。
   */
  private injectTimeGap(events: EventEnvelope[]): void {
    const core = this.core;
    const store = this.relations;
    if (!core || !store) return;
    const first = events.find((event) => event.origin === 'external' && event.type === 'qq.message');
    if (!first) return;
    const qq = String(first.meta?.user_id ?? first.senderKey ?? '');
    if (!/^\d{5,12}$/.test(qq)) return;
    const gap = store.gapMinutes(qq);
    if (gap === null || gap < 30) return;
    core.injectInternal(`[时间] 距上次和你说话：${humanGap(gap)}。`, 'time');
  }

  /** 生活层的设置：作息沿用陪伴层，其余来自 `companion.life.*`。 */
  private lifeSettings(): LifeSettings {
    const companion = this.companionSettings();
    const life = this.cfg.companion?.life ?? PERSONA_DEFAULTS.companion.life;
    return {
      timezone: this.cfg.timezone,
      sleepStartHour: companion.sleepStartHour,
      sleepEndHour: companion.sleepEndHour,
      planItemCount: life.planItemCount,
      homeName: life.homeName || '家里',
      cycleEnabled: life.cycleEnabled,
      cycleAnchor: life.cycleAnchor || null,
    };
  }

  private weatherSettings(): WeatherSettings {
    const life = this.cfg.companion?.life ?? PERSONA_DEFAULTS.companion.life;
    return {
      enabled: life.weatherEnabled,
      city: life.city,
      refreshMinutes: life.weatherRefreshMinutes,
    };
  }

  /** 面板与注入共用的一份生活投影。 */
  private lifeSnapshot(): LifeSnapshot | null {
    if (!this.life || !this.roleState) return null;
    const role = this.roleState.current;
    return this.life.snapshot({
      energy: role.energy,
      mood: role.mood.description || '心情平稳',
      health: role.health,
      sleepText: role.sleep,
    });
  }

  /** 到点才刷；失败保留上一次读数，不重试、不阻塞投递。 */
  private async refreshWeather(force = false): Promise<void> {
    const service = this.weather;
    const store = this.life;
    if (!service || !store) return;
    const now = Date.now();
    if (!force && !service.due(now, Boolean(store.current.weather))) return;
    const reading = await service.fetch(now);
    if (reading) store.setWeather(reading);
  }

  private stateAsleep(date: Date): boolean {
    if (this.life) return this.life.sleepingAt(date.getTime());
    const s = this.companionSettings();
    return inHourWindow(localHour(date.getTime(), this.cfg.timezone), s.sleepStartHour, s.sleepEndHour);
  }

  /**
   * 陪伴层的心跳：和昼夜作息一起起停。
   *
   * 它评估的是"现在有没有机会"，不是"该发消息了"。没有机会就什么都不做。
   */
  override startRhythm(): void {
    super.startRhythm();
    this.companion?.start();
    this.creative?.start();
    // 上次进程在梦途中退出：把笔记退回待整理，冷却不推进。
    this.recoverInterruptedDream();
    // 低水位兜底：安静的日子里，梦不会因为上下文没满就永远不来。
    if (!this.dreamTimer) {
      this.dreamTimer = setInterval(() => this.maybeDream(), 10 * 60_000);
      this.dreamTimer.unref?.();
      // 启动一分钟后再看一次：隔夜关机后不该等到下一轮。
      const first = setTimeout(() => this.maybeDream(), 60_000);
      first.unref?.();
    }
    // 生活层：开机先确保今天有日程、天气到点就拉；之后十分钟看一次换天。
    this.life?.ensurePlan();
    void this.refreshWeather();
    if (!this.lifeTimer) {
      this.lifeTimer = setInterval(() => {
        this.life?.tick();
        this.life?.ensurePlan();
        void this.refreshWeather();
      }, 10 * 60_000);
      this.lifeTimer.unref?.();
    }
  }

  override stopRhythm(): void {
    if (this.dreamTimer) clearInterval(this.dreamTimer);
    this.dreamTimer = null;
    if (this.lifeTimer) clearInterval(this.lifeTimer);
    this.lifeTimer = null;
    this.creative?.stop();
    this.companion?.stop();
    super.stopRhythm();
  }

  /**
   * 太久没整理就入一次梦。
   *
   * 平时梦只在上下文快满时触发；安静的日子会整天没有状态更新和日记。
   * 这里只判断"到点了没有"，真正的整理仍走强制交接那条路（同一个入口，不另开一套）。
   */
  private maybeDream(): void {
    const core = this.core;
    const dreamer = this.dreamer;
    if (!core || !dreamer) return;
    const now = Date.now();
    const state = readDreamState(this.wakeLogDir ? join(this.wakeLogDir, 'dream-state.json') : null);
    // 正在整理或失败退避期内不重开；到点再说。
    if (state.inFlight) return;
    if (state.nextAttemptAt !== undefined && now < state.nextAttemptAt) return;
    const cooldown = this.cfg.dream.cooldownMinutes;
    // 还没有记录时按最近一份交接笔记算，免得升级后一启动就补一次整理。
    const lastDreamAt = state.lastDreamAt ?? lastHandoffAt(this.memory.memoryDir);
    // 冷却期里积下的交接笔记：到点就补一次整理，不然最后那一段可能没人看。
    const pendingDue = state.pending.length > 0
      && dreamGateVerdict({ now, lastDreamAt, cooldownMinutes: cooldown }) === null;
    const convs = this.companion?.snapshot().convs ?? [];
    const activity = Math.max(0, ...convs.map((c) => c.lastUserAt ?? 0)) || null;
    const due = pendingDue || dreamDue({
      now,
      lastHandoffAt: lastDreamAt,
      hours: this.companionSettings().dreamEveryHours,
      lastActivityAt: activity,
      diaryDate: latestDiary(this.memory.memoryDir)?.date ?? null,
      today: dayKey(now, this.cfg.timezone),
    });
    if (!due) return;
    const ok = dreamer.forceDreamAndTruncate();
    core.log.info(ok ? '低水位入梦' : '低水位入梦跳过（正在整理）', {
      pendingNotes: state.pending.length,
      hoursSinceLast: lastDreamAt ? Math.round((now - lastDreamAt) / 3_600_000) : null,
      activity: activity !== null,
    });
  }

  /**
   * 主动时刻只走一条投递路径：把机会放进总线，让她在自己的人格与记忆里决定说不说。
   * 这里不生成文字，也不直接发送——发送仍然只认 qq_draft。
   */
  private async emitCompanion(text: string, meta: Record<string, unknown>): Promise<void> {
    const core = this.core;
    if (!core) return;
    // 没有人说话的此刻，也要让她醒一次；否则"主动"永远等不到下一批事件。
    core.wakeInternal(text, 'companion.opportunity', meta);
  }

  /** 有人说话：按会话记录"刚有人来过"，未接的话头随之关闭。 */
  /**
   * 某个会话此刻的形状：问 World 要，跟 `recentOf` 同一个口子。
   *
   * 现算而不是记上一批消息时的快照——"静了多久"这类数字一过就废，
   * 用一个二十分钟前的读数去判断"现在能不能插话"，等于没判断。
   */
  private roomOf(conv: string): RoomView | null {
    const world = this.mountedWorlds.find((w) => w.id === 'qq') as unknown as
      { roomFacts?: (conv: string) => unknown } | undefined;
    return asRoomView(world?.roomFacts?.(conv));
  }

  /** 这一批消息来自哪个会话，就取那个会话的形状。 */
  private currentRoom(events: EventEnvelope[]): RoomView | null {
    for (const event of events) {
      if (event.origin !== 'external') continue;
      const conv = event.meta?.conv as { kind?: unknown; id?: unknown } | undefined;
      if (typeof conv?.kind !== 'string' || conv.id === undefined) continue;
      return this.roomOf(`${conv.kind}:${String(conv.id)}`);
    }
    return null;
  }

  private noteCompanionInputs(events: EventEnvelope[]): void {
    const companion = this.companion;
    if (!companion) return;
    for (const event of events) {
      if (event.origin !== 'external') continue;
      const conv = convKeyOf(event.meta?.conv);
      if (!conv) continue;
      companion.noteUserMessage(conv, String(event.meta?.user_id ?? event.senderKey ?? ''), event.text ?? '', {
        // 明确叫到她的消息会在 meta 里带 wake；刚被叫到就不该算"自己插话"。
        addressed: Boolean(event.meta?.wake),
      });
    }
  }

  /** 收口这一轮：她说没说？说了就把最后一份草稿记成话头。 */
  private noteCompanionOutput(fresh: Array<{ item?: unknown }>, sent: boolean, answered = false): void {
    const companion = this.companion;
    if (!companion) return;
    companion.settle(sent);
    if (!sent) return;
    let draft: { to?: unknown; text?: unknown; reply_to?: unknown } | null = null;
    for (const record of fresh) {
      const item = record.item as { type?: string; name?: string; arguments?: unknown } | undefined;
      if (item?.type !== 'function_call' || item.name !== 'qq_draft') continue;
      try {
        draft = JSON.parse(String(item.arguments ?? '{}')) as { to?: unknown; text?: unknown; reply_to?: unknown };
      } catch {
        draft = null;
      }
    }
    if (draft === null) return;
    const parsed: { to?: unknown; text?: unknown; reply_to?: unknown } = draft;
    const conv = typeof parsed.to === 'string' ? parsed.to : '';
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!conv || !text) return;
    companion.noteBotMessage(conv, text, parsed.reply_to !== undefined && parsed.reply_to !== null, { answered });
  }

  /**
   * 唤醒名从她自己的术语表同步。
   *
   * 群里怎么叫她，是她自己维护的数据；配置里那份静态列表只是兜底。
   * 术语表被梦改过之后，下次投递就会生效，不用重启。
   */
  private syncWakeNames(): void {
    const qq = this.mountedWorlds.find((world) => world.id === 'qq') as unknown as
      { addWakeNames?: (names: string[]) => void } | undefined;
    if (!qq?.addWakeNames) return;
    const file = join(this.memory.memoryDir, 'note', 'playbook', '称呼与术语.md');
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime === this.wakeNameStamp) return;
      const names = parseSelfNames(readFileSync(file, 'utf8'));
      if (!names.length) return;
      this.wakeNameStamp = mtime;
      qq.addWakeNames(names);
      this.core?.log.info('唤醒名已从术语表同步', { count: names.length, names });
    } catch {
      // 没有术语表就不管：可选文件不该挡住启动，也不该刷告警。
    }
  }

  private decayOptions(): DecayOptions {
    return { rate: this.cfg.memory.decayRate, dormantDays: this.cfg.memory.dormantDays };
  }

  /** 配了模型且有 key 才启用向量路；缺一样就安静地只用关键词。 */
  private setupEmbedder(core: CoreApi): void {
    const model = this.cfg.memory.embeddingModel.trim();
    if (!model) return;
    const key = this.embeddingKey();
    if (!key) {
      core.log.warn('设了向量模型但找不到 key（环境变量 CORTICO_EMBEDDING_KEY 或部署目录 secrets.local.json），语义召回暂不可用');
      return;
    }
    this.embedder = new HttpEmbeddingClient({
      baseUrl: this.cfg.memory.embeddingBaseUrl,
      model,
      apiKey: key,
    });
    core.log.info('记忆向量已启用', { model });
    this.embedPending();
  }

  /** key 只从环境变量或部署目录的本地文件读，不写进任何受版本控制的文件。 */
  private embeddingKey(): string | null {
    const fromEnv = process.env.CORTICO_EMBEDDING_KEY?.trim();
    if (fromEnv) return fromEnv;
    if (!this.wakeLogDir) return null;
    try {
      const file = join(dirname(this.wakeLogDir), 'secrets.local.json');
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { embeddingKey?: unknown };
      const key = typeof raw.embeddingKey === 'string' ? raw.embeddingKey.trim() : '';
      return key || null;
    } catch {
      return null;
    }
  }

  /** 把还缺向量的条目补齐；串行、分批，失败就下次再说。 */
  private embedPending(): void {
    const embedder = this.embedder;
    const index = this.index;
    if (!embedder || !index || this.embeddingBusy) return;
    this.embeddingBusy = true;
    void (async () => {
      try {
        for (let round = 0; round < 12; round++) {
          const pending = index.pendingVectors(embedder.model, 16);
          if (pending.length === 0) return;
          const started = Date.now();
          const vectors = await embedder.embed(pending.map((p) => p.text), 'passage');
          this.embedStats.passage += pending.length;
          this.embedStats.lastMs = Date.now() - started;
          for (let i = 0; i < pending.length; i++) {
            index.storeVector(pending[i].id, vectors[i], embedder.model);
          }
        }
      } catch (err) {
        this.noteEmbedFailure(err);
        this.core?.log.warn('记忆向量化失败，下次再补', describeFetchError(err));
      } finally {
        this.embeddingBusy = false;
      }
    })();
  }

  /**
   * 记一次向量失败：计数、留存原因，供面板报警。
   *
   * 日志只有翻到才知道；`lastError` 让 WebUI 能当场弹出来——这类失败平时静默回退
   * 到关键词检索，不看着就永远发现不了。
   */
  private noteEmbedFailure(err: unknown): void {
    this.embedStats.failures++;
    const info = describeFetchError(err);
    const text = [info.cause, info.code].filter((part): part is string => typeof part === 'string').join(' · ')
      || String(info.err);
    this.embedStats.lastError = { at: Date.now(), text };
  }

  /** 查询向量；失败返回 null，调用方退回关键词。 */
  private async queryVector(query: string): Promise<Float32Array | null> {
    const embedder = this.embedder;
    if (!embedder || !query.trim()) return null;
    const started = Date.now();
    try {
      const [vec] = await embedder.embed([query], 'query');
      this.embedStats.query++;
      this.embedStats.lastMs = Date.now() - started;
      return vec ?? null;
    } catch (err) {
      this.noteEmbedFailure(err);
      this.core?.log.warn('查询向量失败，退回关键词', { ...describeFetchError(err), failures: this.embedStats.failures });
      return null;
    }
  }

  /** 向量调用的实际计数；面板与排查都用它，避免"以为在调其实没调"。 */
  embeddingStats(): EmbeddingStats {
    return { ...this.embedStats };
  }

  /**
   * 每次唤醒前把"可能相关的旧事"注入当前批。
   *
   * 注入发生在 onDelivery 里，Core 会把它并进当前批，不会多跑一轮模型。
   * 只注入关键词真正命中的条目——每轮都塞几条不相干的旧事是噪音，不是记忆。
   */
  private async injectMemories(events: EventEnvelope[]): Promise<void> {
    const core = this.core;
    const index = this.index;
    if (!core || !index) return;
    const topK = this.cfg.memory.injectTopK;
    if (topK <= 0) return;

    // 先认人，再认话题。发送者的 QQ 号是主键——改不改名都对得上。
    const person = this.personBlock(events);
    const personRepeat = !!person.text && person.text === this.lastPersonBlock;
    if (person.text && (!personRepeat || !this.stillInContext(person.text))) {
      this.lastPersonBlock = person.text;
      this.turnRecallIds.push(...person.ids);
      core.injectInternal(person.text, 'memory');
    } else if (personRepeat) {
      this.personSkipped = true;
    }

    // 只拿正文、去掉媒体占位：纯图片/表情的消息没有话题可查，不该拿昵称去凑。
    const query = recallQueryOf(events);
    if (!query) {
      this.recallSkip = 'empty';
      return;
    }
    // 检索前扩展人名：正文里的旧名也能接回这个人的全部称呼。
    const expanded = this.people().queryTerms(query);
    const queryVector = await this.queryVector(query).catch(() => null);
    const { text: block, ids: recalled } = index.recallBlock(expanded, topK, 700, {
      decay: this.decayOptions(),
      ...(queryVector ? { queryVector } : {}),
    });
    if (!block) {
      this.recallSkip = 'empty';
      return;
    }
    // 去重只在"那一块还在窗口里"时成立：交接或清空之后旧块已经不在了，得重新放到她眼前。
    if (block === this.lastMemoryBlock && this.stillInContext(block)) {
      this.recallSkip = 'dup';
      core.log.info('记忆召回：与上一块相同且仍在上下文里，跳过注入', { ids: recalled.length, chars: block.length });
      return;
    }
    this.lastMemoryBlock = block;
    this.turnRecallIds.push(...recalled);
    const injectedLines = block.split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2, 42));
    this.lastMemoryHeads = injectedLines.slice(0, 3);
    core.injectInternal(block, 'memory');
    // 维护一天最多跑一次；顺手在这里做，不依赖定时器。
    index.sweepIfDue(this.decayOptions());
    // 同一件事被写成两条时合并（留下更全的），每天最多一次。
    const merged = index.dedupeIfDue();
    if (merged && merged.merged > 0) core.log.info('记忆合并', { merged: merged.merged });
  }

  /**
   * 这次要跳过的那块，是不是还在她眼前的窗口里。
   *
   * 去重按内容比，但窗口会换：交接、清空、compact 之后同一块已经不在上下文里了，
   * 只比内容就会永远跳过一个她其实看不见的块。所以要回到 snapshot 里确认一遍。
   */
  private stillInContext(text: string): boolean {
    const snapshot = this.core?.sessionInfo(MAIN).snapshot ?? [];
    return snapshot.some((record) => itemTextOf(record.item).includes(text));
  }

  /**
   * 「这几条消息来自你认识的人」。
   *
   * 名字会变，号不会。所以这里按发送者的 QQ 号去查档案与记忆，完全不经过关键词检索——
   * 改了名也认得出，也找得到他以前说过的事。这是"她记得住"和"运维看得见"的分界。
   */
  private personBlock(events: EventEnvelope[]): { text: string | null; ids: string[] } {
    const index = this.index;
    if (!index) return { text: null, ids: [] };
    const qqs = [...new Set(
      events
        .filter((event) => event.origin === 'external')
        .map((event) => String(event.meta?.user_id ?? event.senderKey ?? ''))
        .filter((qq) => /^\d{5,12}$/.test(qq)),
    )].slice(0, 3);
    if (qqs.length === 0) return { text: null, ids: [] };

    const registry = this.people();
    const lines: string[] = [];
    const ids: string[] = [];
    let used = 0;
    for (const qq of qqs) {
      const record = registry.byQqNumber(qq);
      const memories = index.recallForPeople([qq], { k: 3, decay: this.decayOptions() });
      const relation = this.relations?.get(qq);
      if (!record && memories.length === 0 && !relation) continue;
      const former = record?.aliases.length ? `，曾用名：${record.aliases.join('、')}` : '';
      const head = record
        ? `${record.name}(${qq})${former}${record.summary ? `｜${record.summary}` : ''}`
        : `QQ ${qq}（还没有档案）`;
      lines.push(`- ${head}`);
      used += head.length;
      // 她自己的判断，不是这个人的资料：每次他开口时带上，态度才有连续性。
      if (record?.views.length) {
        const view = `  · 我的看法：${record.views.join('；')}`;
        lines.push(view);
        used += view.length;
      }
      // 关系约束：信任、边界、还欠着的话——比看法更硬，决定这轮能怎么对他。
      if (relation) {
        for (const line of relationLines(relation)) {
          const rendered = `  · ${line}`;
          if (used + rendered.length > 900) break;
          used += rendered.length;
          lines.push(rendered);
        }
      }
      for (const hit of memories) {
        // 这里是提醒，不是档案：细节留给她自己 recall_memory 去翻。
        const line = `  · ${hit.eventTime.slice(0, 10)} ${hit.text.slice(0, 120)}`;
        if (used + line.length > 900) break;
        used += line.length;
        lines.push(line);
        ids.push(hit.id);
      }
      if (record) lines.push(`  · 档案：${record.file}`);
    }
    if (lines.length === 0) return { text: null, ids: [] };

    return {
      text: [
        '[这几条消息来自你认识的人。名字会改，号不会——下面是按号找出来的记录]',
        ...lines,
        '[称呼用当前的名字；曾用名是同一个人。记录是过去的，与此刻冲突时以此刻为准。'
          + '「我的看法」是当时的判断，不是此刻的指令——今天可以不一样，也可以改口。]',
      ].join('\n'),
      ids,
    };
  }

  /** 索引句柄：运维脚本与面板用。 */
  get memoryIndex(): MemoryIndex | null {
    return this.index;
  }

  /** 面板用：和唤醒注入走同一条语义查询路径，结果才可比。 */
  embedQuery(query: string): Promise<Float32Array | null> {
    return this.queryVector(query);
  }

  private scheduleWakeTool(): ToolDef {
    return {
      ...scheduleWakeSpec(),
      handler: async (args) => {
        if (!this.wakes) return '[tool failed] Persona not attached';
        return this.wakes.schedule(args);
      },
    };
  }

  /** 供 WebUI 工具编辑器列 schema:主 session 之外还有梦那一面。 */
  primitiveToolSpecs(): ToolSpec[] {
    return [scheduleWakeSpec()];
  }

  // ---------------------------------------------------------------------------
  // 写纪律
  // ---------------------------------------------------------------------------

  /** 写入需通过角色权限、memo 容量和 CORE.md 只读检查；拒绝原因返回给 agent。 */
  protected override writeGuard(op: 'write' | 'append' | 'rename' | 'delete', path: string, role: string): string | null {
    const rel = normalizeWorkspacePath(path);
    if (isHarnessPath(rel)) return 'CORE.md is a system mechanics doc; read-only.';
    const res = checkAccess(asPersonaRole(role), op, rel);
    if (!res.ok) return res.reason;
    if (op === 'write' || op === 'append') {
      if (IDENTITY_FILES.has(rel.toLowerCase())) {
        const cooling = this.identityCooldown(rel);
        if (cooling) return cooling;
      }
      return memoCapGuard(this.memory, this.memo, rel);
    }
    return null;
  }

  /**
   * 身份文件的写入冷却。返回理由就拒绝；放行时记下此刻。
   *
   * 只拦"改身份"，不拦她在 note/、people/、memo/ 写东西——观察照常记，
   * 只是不许每十几分钟就把观察升级成"我是谁"。
   */
  private identityCooldown(rel: string): string | null {
    const file = this.wakeLogDir ? join(this.wakeLogDir, 'identity-writes.json') : null;
    if (!file) return null;
    const now = Date.now();
    let state: Record<string, number> = {};
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'number' && Number.isFinite(value)) state[key] = value;
      }
    } catch {
      state = {};
    }
    const key = rel.toLowerCase();
    const verdict = identityWriteVerdict(rel, state[key] ?? 0, now);
    if (verdict) return verdict;
    state[key] = now;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(state, null, 1), 'utf8');
    } catch {
      /* 记不上就算了：放行比因为磁盘问题卡住她更安全 */
    }
    return null;
  }

  /** CORE.md 随软件走,不在工作区里;read_file 照样读得到。 */
  protected override readOverride(path: string): string | null {
    if (!isHarnessPath(path)) return null;
    const file = this.textFile('CORE.md');
    if (!existsSync(file)) throw new WorkspaceError('CORE.md 暂不可用(软件包内未找到该文件)');
    return readFileSync(file, 'utf8');
  }

  /** 读取部署 prompts/ 同名覆盖文件；不存在时读取包内默认文件。 */
  textFile(name: string): string {
    const override = this.promptsDir ? join(this.promptsDir, name) : null;
    return override && existsSync(override) ? override : join(MODULE_DIR, name);
  }

  /** WebUI 保存人格文本落到哪:部署 `prompts/`;没给部署目录就写包内那份。 */
  textWritePath(name: string): string {
    return this.promptsDir ? join(this.promptsDir, name) : join(MODULE_DIR, name);
  }

  // ---------------------------------------------------------------------------
  // 前缀
  // ---------------------------------------------------------------------------

  protected override templateFile(name: string): string {
    return this.textFile(name);
  }

  protected override prefixVars(ctx: SystemPrefixContext): Record<string, string> {
    return {
      'persona.orientation': this.orientationText().trim(),
      'persona.constitution': this.constitutionText().trim(),
      'persona.toolUsage': this.toolUsageText(MAIN).trim(),
      'memory.all': this.assembleMemory({ now: ctx.now, timezone: ctx.timezone }),
    };
  }

  protected override segmentTitles(): Record<string, string> {
    return SEGMENT_TITLES;
  }

  protected override segmentSources(): Record<string, string> {
    return SEGMENT_SOURCES;
  }

  orientationText(): string {
    return readFileSync(this.orientationSource(), 'utf8');
  }

  constitutionText(): string {
    return readFileSync(join(this.memoryDir, 'CONSTITUTION.md'), 'utf8');
  }

  toolUsageText(sessionId: string): string {
    return toolUsageText(asPersonaRole(sessionId), {
      residentCap: this.cfg.memo.residentCap,
      activeCap: this.cfg.memo.activeCap,
    });
  }

  /** 各模板占位符此刻的值(纯展示,WebUI 的旁注用)。`worlds.*` 那几个由各 World 自报。 */
  override promptVarValues(ctx: { now: Date; timezone: string }): Record<string, string> {
    return {
      ...this.prefixVars({ ...ctx, worlds: [] }),
      ...memoryVars(this.memory, this.memo, ctx, this.emergences(), this.people()),
    };
  }

  /** MEMORY 0~4:模板 + 活数据。五层的引导语与空态措辞全在 MEMORY.md 里。 */
  assembleMemory(ctx: MemoryAssemblyContext): string {
    return renderTemplate(
      readFileSync(this.textFile('MEMORY.md'), 'utf8'),
      memoryVars(this.memory, this.memo, ctx, this.emergences(), this.people()),
    ).trim();
  }

  // ---------------------------------------------------------------------------
  // 时机
  // ---------------------------------------------------------------------------

  /** 心跳提供日期和时间；普通消息时间行不含日期。 */
  protected override tickText(quietSeconds: number): string {
    return `[system/tick] Time is ${tickTimeText(this.cfg.timezone, new Date())}. `
      + `About ${Math.round(quietSeconds / 60)} min since the last messages.`;
  }

  /** 交接照 Cormini(空尾 + 交接笔记);交接前的快照按冷却排进并行梦。 */
  override async onHandoff(snapshot: ContextRecord[], ctx: { hardTokens: number | null }): Promise<ContextHandoffResult> {
    // 交接换了窗口：这是旧窗口的去重记录，留着会让同一块在新窗口里永远被跳过。
    this.lastMemoryBlock = '';
    this.lastPersonBlock = '';
    const hadContent = snapshot.some((m) => !hasRole(m, 'system'));
    // 冷却的起点兜底:升级前那一段多半已经整过了,按它来。必须在写笔记之前取。
    const lastHandoffBefore = lastHandoffAt(this.memory.memoryDir);
    const result = await super.onHandoff(snapshot, ctx);
    if (hadContent) this.dreamOrDefer(snapshot, lastHandoffBefore);
    return result;
  }

  /**
   * 交接后要不要入梦。
   *
   * 冷却期内的交接只留交接笔记；那些笔记不在下一次梦的上下文里，所以把文件名带过去，
   * 让它在需要细节时自己读。
   */
  private dreamOrDefer(snapshot: ContextRecord[], lastHandoffBefore: number | null): void {
    const file = this.wakeLogDir ? join(this.wakeLogDir, 'dream-state.json') : null;
    const state = readDreamState(file);
    const now = Date.now();
    const deferred = dreamGateVerdict({
      now,
      lastDreamAt: state.lastDreamAt ?? lastHandoffBefore,
      cooldownMinutes: this.cfg.dream.cooldownMinutes,
    });
    // 上一场还没核销、或失败退避未到时，不另开一场：笔记先攒进 pending，等它结束再一起算。
    const backingOff = state.nextAttemptAt !== undefined && now < state.nextAttemptAt;
    if (deferred || state.inFlight || backingOff) {
      if (this.lastHandoffFile) state.pending = [...state.pending, this.lastHandoffFile].slice(-DREAM_PENDING_KEEP);
      writeDreamState(file, state);
      this.core?.log.info(state.inFlight ? '交接未入梦：整理还在进行' : backingOff ? '交接未入梦：等退避结束' : '交接未入梦', {
        reason: deferred,
        pending: state.pending.length,
      });
      return;
    }
    // 当前段的原文现在只继承一个尾巴，中段靠这份笔记兜住——必须一起交过去。
    const notes = this.lastHandoffFile ? [...state.pending, this.lastHandoffFile] : state.pending;
    const task: DreamTask = { id: `dream-${now}-${Math.random().toString(36).slice(2, 8)}`, startedAt: now, notes };
    // 先落盘 in-flight，再排队：进程在这之后退出，重启时笔记还在。
    writeDreamState(file, { lastDreamAt: state.lastDreamAt, pending: [], inFlight: task });
    this.dream.schedule(snapshot, { deferredNotes: notes }).then(
      (ok) => this.settleDream(task, ok),
      () => this.settleDream(task, false),
    );
  }

  /** 梦跑完后核销：成功才推进 lastDreamAt；失败把这次要消化的笔记退回 pending。 */
  private settleDream(task: DreamTask, ok: boolean): void {
    const file = this.wakeLogDir ? join(this.wakeLogDir, 'dream-state.json') : null;
    const state = readDreamState(file);
    const next = settledDreamState(state, task.id, ok, Date.now());
    if (!next) return;
    writeDreamState(file, next);
    if (ok) {
      this.core?.log.info('梦完成，交接笔记已核销', { id: task.id });
    } else {
      this.core?.log.warn('梦没完成，笔记留到下次', { id: task.id, attempts: next.attempts });
    }
  }

  /** 启动时补救上一次在排队/整理途中被打断的梦。 */
  private recoverInterruptedDream(): void {
    const file = this.wakeLogDir ? join(this.wakeLogDir, 'dream-state.json') : null;
    const state = readDreamState(file);
    const next = interruptedDreamState(state, Date.now());
    if (!next) return;
    writeDreamState(file, next);
    this.core?.log.warn('上一次梦没走完，笔记退回待整理', {
      id: state.inFlight?.id,
      notes: next.pending.length,
      attempts: next.attempts,
    });
  }

  protected override handoffNoteLines(): string[] {
    const lines = super.handoffNoteLines();
    const at = lines.findIndex((l) => l.startsWith('对外交流的工具不要输出空内容'));
    lines.splice(at, 0, '后台正在入梦整理工作区(people/、memo/、WORLDVIEW.md);有值得说的会以 [surfaced from dream] 送来。');
    return lines;
  }

  /** 每批空闲时提交 persona 改动;梦的改动包含在同一次提交中。提交失败不影响主循环。 */
  onIdle(): void {
    try {
      this.git.commitAll('本轮记忆改动', AUTHOR_SELF);
    } catch {
      /* 提交失败不影响主循环 */
    }
  }

  // ---------------------------------------------------------------------------
  // MEMORY 3 反射
  // ---------------------------------------------------------------------------

  emergences(): string[] {
    if (!this.core) return [];
    const raw = this.core.personaState().emergences;
    return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  }

  private recordEmergence(text: string): void {
    const tagged = `[surfaced from dream] ${text}`;
    const state = this.api().personaState();
    state.emergences = [...this.emergences(), tagged].slice(-EMERGENCE_KEEP);
    this.api().savePersonaState();
    this.api().injectInternal(tagged, 'emergence');
  }

  // ---------------------------------------------------------------------------
  // WebUI
  // ---------------------------------------------------------------------------

  /** 陪伴页的数据面：状态、人、群、记忆、主动、用量、排障、配置。 */
  companionPanelDeps(): CompanionPanelDeps {
    return {
      settings: () => this.companionSettings(),
      embeddingStats: () => this.embeddingStats(),
      roleState: () => this.roleState,
      companion: () => this.companion,
      memoryDir: () => this.memory.memoryDir,
      people: () => this.people(),
      timezone: () => this.cfg.timezone,
      dataDir: () => this.wakeLogDir ?? '',
      memoryIndex: () => this.index,
      dreamState: () => readDreamState(this.wakeLogDir ? join(this.wakeLogDir, 'dream-state.json') : null),
      embeddingModel: () => this.cfg.memory.embeddingModel,
      recentOf: (conv, limit) => {
        const world = this.mountedWorlds.find((w) => w.id === 'qq') as unknown as
          { recentMessages?: (conv: string, limit?: number) => Array<{ at: number; from: string; text: string }> } | undefined;
        return world?.recentMessages?.(conv, limit) ?? [];
      },
      groups: () => (this.cfg.worlds.qq?.groups ?? []).map((g) => ({ id: g.id, enabled: g.enabled })),
      styleDirs: () => ({
        // 常驻卡在部署的 prompts/style/core；没部署目录时不存在，面板会显示为空。
        core: this.promptsDir ? join(this.promptsDir, 'style', 'core') : '',
        library: join(this.memory.memoryDir, 'note', 'style'),
      }),
      life: () => this.lifeSnapshot(),
      refreshWeather: (force: boolean) => this.refreshWeather(force),
      updateLife: (patch) => this.life?.patch(patch) ?? { ok: false, applied: [], rejected: [] },
      setPlan: (slots, source) => this.life?.setPlan(slots, source) ?? { ok: false, result: '生活状态未挂载' },
      lifeConfig: () => this.lifeSettings(),
      weatherConfig: () => this.weatherSettings(),
      attention: () => {
        const world = this.mountedWorlds.find((w) => w.id === 'qq') as unknown as {
          attentionLog?: (n?: number) => AttentionRow[];
          attentionSettings?: () => AttentionConfigView;
        } | undefined;
        if (!world?.attentionLog || !world.attentionSettings) return null;
        return { config: world.attentionSettings(), rows: world.attentionLog(40) };
      },
      room: () => {
        const world = this.mountedWorlds.find((w) => w.id === 'qq') as unknown as {
          roomFacts?: (conv: string) => Record<string, unknown>;
          roomNoteFor?: (conv: string) => { label: string; note: string; at: number; expiresAt: number } | null;
        } | undefined;
        if (!world?.roomFacts) return null;
        const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
        return (this.cfg.worlds.qq?.groups ?? []).filter((g) => g.enabled).map((g) => {
          const conv = `group:${g.id}`;
          const facts = world.roomFacts!(conv);
          const note = world.roomNoteFor?.(conv) ?? null;
          return {
            conv,
            groupId: g.id,
            line: typeof facts.line === 'string' ? facts.line : null,
            messages: num(facts.messages),
            speakers: num(facts.speakers),
            heat: typeof facts.heat === 'string' ? facts.heat : 'silent',
            monologue: facts.monologue === true,
            replyShare: num(facts.replyShare),
            toSelf: num(facts.toSelf),
            lullMinutes: typeof facts.lullMinutes === 'number' ? facts.lullMinutes : null,
            note: note ? { label: note.label, text: note.note, expiresAt: note.expiresAt } : null,
          };
        });
      },
      now: () => Date.now(),
      intero: () => this.interoValues(),
      interoConfig: () => this.interoSettings(),
      creative: () => creativeState(this.creative),
      creativeText: (id: string) => creativeText(this.creative, (rel) => {
        try {
          return this.memory.readFile(rel);
        } catch {
          return null;
        }
      }, id),
      relation: (qq: string) => {
        const rel = this.relations?.get(qq);
        if (!rel) return null;
        return {
          trust: rel.trust,
          familiarity: rel.familiarity,
          affinity: rel.affinity,
          boundary: rel.boundary,
          basis: rel.basis,
        };
      },
    };
  }

  /** 工作区、Memory 分层、版本历史三块归 Memory 页,模板归 Persona 页;部署级控制在 webui-page.ts。工作区排除在统一清除清单外。 */
  override webUi(language: Language = 'zh'): PersonaWebUiDecl {
    const { panels, ...decl } = personaWebUiDecl({
      memory: this.memory,
      memo: this.memo,
      emergences: () => this.emergences(),
      firstTurnDocs: this.firstTurnDocs(language),
      texts: { path: (name) => this.textFile(name), writePath: (name) => this.textWritePath(name) },
      memoryIndex: () => this.index,
      dataDir: this.wakeLogDir ?? '',
      memoryDir: this.memory.memoryDir,
      people: () => this.people(),
      embedQuery: (query) => this.embedQuery(query),
      embeddingModel: () => this.cfg.memory.embeddingModel,
      onMemoriesChanged: () => this.embedPending(),
      embeddingStats: () => this.embeddingStats(),
    }, language);
    return { ...decl, label: this.cfg.displayName || '琥珀协议', memory: { panels, label: '长期记忆' } };
  }
}
