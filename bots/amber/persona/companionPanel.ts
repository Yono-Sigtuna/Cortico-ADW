/**
 * 陪伴页的数据面：她此刻什么状态、认识谁、群里什么气候、为什么（不）开口、
 * 学来的表达、花了多少 token、哪里不对、参数怎么调。
 *
 * 这不是管理台。改状态的入口只用于排障与演练；她自己的状态应当由梦来写。
 * 分区对齐 AstrBot「我会永远陪着你」的陪伴面板：总览 / 用户 / 群聊 / 观察 /
 * 世界知识 / 主动 / 学习 / Token / 排障 / 配置——但不照抄界面，每一格都接
 * Cortico 真实有的数据；没有数据就如实写没有，不摆空壳。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { WorldPanelDecl } from 'cortico/core/types.ts';
import type { Companion } from './companion/index.ts';
import type { CompanionSettings } from './companion/state.ts';
import { dayKey } from './companion/state.ts';
import type { RoleState, RoleStateStore } from './companion/roleState.ts';
import { dreamDue, lastHandoffAt } from './companion/life.ts';
import type { PersonRegistry } from './people.ts';
import type { MemoryIndex } from './memoryIndex.ts';
import { readRecallTail } from './memoryPanel.ts';
import type { AgendaSlot, LifeSettings, LifeSnapshot, SlotView } from './companion/lifeState.ts';
import type { InteroSnapshot } from './companion/intero.ts';
import type { CreativeStateView, CreativeWorkRow } from './creativePanel.ts';

// ---------------------------------------------------------------------------
// 面板声明
// ---------------------------------------------------------------------------

export const COMPANION_PANELS: WorldPanelDecl[] = [
  { id: 'overview', title: '总览', description: '她此刻的状态、今天的主动额度、最近醒来的记录。' },
  { id: 'people', title: '用户', description: '她认识的每个人：当前称呼、记得几件事、最近一次说话。' },
  { id: 'groups', title: '群聊', description: '每个群现在什么气候、她会不会接话、最近的消息。' },
  { id: 'observe', title: '观察', description: '日记、最近的记忆与召回、她对每个人的看法。' },
  { id: 'world', title: '世界知识', description: '她的世界观、宪法与笔记目录——她当作真的那些东西。' },
  { id: 'proactive', title: '主动', description: '此刻的判定、候选与来源、节奏与额度。' },
  { id: 'works', title: '作品', description: '她自己写的那些东西：写到哪、什么时候写的、本子上记了什么。' },
  { id: 'learning', title: '学习', description: '她学来的表达：常驻语气卡与资料库。' },
  { id: 'tokens', title: 'Token', description: '今天与最近七天的消耗，按供应商与用途拆开。' },
  { id: 'troubleshoot', title: '排障', description: '唤醒记录、入梦、失败信号与记忆规模。' },
  { id: 'config', title: '配置', description: '陪伴层的开关与节奏；手动改状态只用于排障。' },
];

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

export interface CompanionPanelDeps {
  settings(): CompanionSettings;
  /** 向量接口最近一次失败；有就说明召回正在退回关键词。 */
  embeddingStats?(): { lastError: { at: number; text: string } | null };
  roleState(): RoleStateStore | null;
  companion(): Companion | null;
  memoryDir(): string;
  people(): PersonRegistry | null;
  /** 本地时区：判断"今天有没有日记"、切分 Token 的日与小时。 */
  timezone(): string;
  /** 唤醒日志、用量、召回记录、错误日志都在这里。 */
  dataDir(): string;
  memoryIndex(): MemoryIndex | null;
  /** 梦的节流状态：上一次梦、以及还没整理的交接笔记。缺省时按交接笔记时间算。 */
  dreamState?(): { lastDreamAt: number | null; pending: string[] };
  /** 向量补齐用的模型名；统计"补到哪一步"要按它算。 */
  embeddingModel(): string;
  /** 某个会话最近的消息；群里没叫到她的消息不进投递批次，只能问 World 要。 */
  recentOf(conv: string, limit: number): Array<{ at: number; from: string; text: string }>;
  /** 监听名单里的群。 */
  groups(): Array<{ id: string | number; enabled: boolean }>;
  /** 语气卡两个目录：常驻（部署 prompts/style/core）与资料库（工作区 note/style）。 */
  styleDirs(): { core: string; library: string };
  /** 她今天怎么过：日程、天气、周期、地点。没挂载时为 null。 */
  life(): LifeSnapshot | null;
  /** 立刻拉一次天气；false 时只在到点才拉。 */
  refreshWeather(force: boolean): Promise<void>;
  updateLife(patch: { hunger?: string | null; dream?: string | null; outfit?: string | null; cycleAnchor?: string | null }): {
    ok: boolean; applied: string[]; rejected: string[];
  };
  setPlan(slots: AgendaSlot[], source: 'dream' | 'fallback'): { ok: boolean; result: string };
  lifeConfig(): LifeSettings;
  /** 天气开关与城市（读取用，写入走 setConfig）。 */
  weatherConfig(): { enabled: boolean; city: string; refreshMinutes: number };
  /** 注意力判决：最近谁说了什么、为什么没注意。没挂 QQ 时为 null。 */
  attention(): { config: AttentionConfigView; rows: AttentionRow[] } | null;
  /** 各监听群此刻的形状。没挂 QQ 时为 null。 */
  room?(): RoomRow[] | null;
  /** 她自己的创作：书柜、本子、这一会儿为什么没写。没挂载时为 null。 */
  creative?(): CreativeStateView | null;
  /** 打开一部作品的正文。 */
  creativeText?(id: string): { work: CreativeWorkRow; text: string } | null;
  /** 内感受：社交电量与负荷。没挂载或关掉时为 null。 */
  intero(): InteroSnapshot | null;
  interoConfig(): { enabled: boolean; lowBattery: number; highLoad: number; replyBattery: number; hesitationSeconds: number };
  /** 关系约束：信任、熟悉度、好感度、边界、欠着的话。没记录时返回 null。 */
  relation(qq: string): { trust: number; familiarity: number; affinity: number; boundary: number; basis: string } | null;
  /** 面板用的时钟；不传就取当前时间。测试靠它固定日期。 */
  now?(): number;
}

export interface AttentionConfigView {
  enabled: boolean;
  peripheryThreshold: number;
  windowMinutes: number;
  habituationMinutes: number;
}

export interface AttentionRow {
  at: number;
  ts: string;
  convKey: string;
  senderName: string;
  tier: string;
  score: number;
  reasons: string[];
  preview: string;
}

/** 一个群此刻的形状：World 数出来的数字，加上她自己写的判断。 */
export interface RoomRow {
  conv: string;
  groupId: number | string;
  /** 她这一轮会看到的那一行；没有消息时为 null。 */
  line: string | null;
  messages: number;
  speakers: number;
  heat: string;
  monologue: boolean;
  replyShare: number;
  toSelf: number;
  lullMinutes: number | null;
  note: { label: string; text: string; expiresAt: number } | null;
}

// ---------------------------------------------------------------------------
// 形状（浏览器那一半 import 不到本文件，两边靠这些注释对齐）
// ---------------------------------------------------------------------------

export interface OverviewState {
  enabled: boolean;
  /** 向量接口最近一次失败；非 null 说明召回正在退回关键词，面板要报警。 */
  embeddingError: { at: number; text: string } | null;
  role: RoleState | null;
  caps: { proactiveToday: number; dailyCap: number; topicToday: number; topicDailyCap: number };
  diary: { date: string; text: string } | null;
  dream: { lastHandoffAt: number | null; pendingNotes: number; everyHours: number; lastActivityAt: number | null; due: boolean };
  wakes: WakeRow[];
  convs: ConvRow[];
  counts: { wakesToday: number; sentToday: number };
  /** 今日八格；生活层没挂载时为 null。 */
  today: TodayFacts | null;
  current: SlotView | null;
  next: SlotView | null;
  timeline: SlotView[];
  /** 内感受：事件驱动，不来自梦。 */
  intero: { socialBattery: number; load: number; updatedAt: number; gates: { enabled: boolean; lowBattery: number; highLoad: number } } | null;
}

export interface TodayFacts {
  date: string;
  refreshedAt: number;
  weather: string;
  location: string;
  /** 一格里的短词：轻快 / 烦躁 / 低落 / 不安 / 平稳。 */
  mood: string;
  /** 完整心境，放 title。 */
  moodDetail: string;
  agendaCount: number;
  planSource: 'dream' | 'fallback' | 'none';
  health: string;
  /** 空字符串 = 没有图也没有文字，面板显示「暂无穿搭图」。 */
  outfit: string;
  sleep: string;
  body: string;
  cycleName: string | null;
  cycleDay: number | null;
  cycleDays: number | null;
  hunger: string;
  dreamText: string;
  energy: number;
}

export interface WakeRow {
  id: string | null;
  ts: string | null;
  reason: string | null;
  outcome: string | null;
  durationMs: number | null;
  estTokens: number | null;
  prefixChars: number | null;
  types: string[];
  sent: string | null;
}

export interface ConvRow {
  conv: string;
  lastUserKey: string | null;
  lastUserAt: number | null;
  lastBotAt: number | null;
  openLoop: string | null;
  followed: boolean;
  lastAttemptAt: number | null;
}

export interface PersonRow {
  qq: string;
  name: string;
  summary: string;
  aliases: string[];
  views: number;
  memories: number;
  lastSeenAt: number | null;
  file: string;
}

export interface PersonDetail {
  person: PersonRow;
  views: string[];
  memories: Array<{ text: string; eventTime: string; kind: string; score: number }>;
  counts: { active: number; dormant: number };
  /** 关系约束的机器状态；没有记录时为 null。 */
  relation: { trust: number; familiarity: number; affinity: number; boundary: number; basis: string } | null;
}

export interface GroupsState {
  groups: Array<{
    id: string;
    enabled: boolean;
    conv: string;
    lastUserAt: number | null;
    lastBotAt: number | null;
    openLoop: string | null;
    lastAttemptAt: number | null;
  }>;
  diagnose: { ok: boolean; reason: string };
  caps: { participateGroups: boolean; topicWindowMinutes: number; topicDailyCap: number; topicToday: number };
}

export interface MemoryItem {
  text: string;
  kind: string;
  eventTime: string;
  status: string;
  source: string | null;
  importance: number;
}

export interface RecallRecord {
  ts: string | null;
  query: string | null;
  caller: string | null;
  hits: Array<{ text: string; score: number }>;
}

export interface WorldState {
  files: Array<{ path: string; size: number; mtime: number }>;
  worldview: string;
  constitution: string;
  memoryDir: string;
}

export interface ProactiveState {
  diagnose: { ok: boolean; reason: string };
  gate: string | null;
  candidates: Array<{ conv: string; kind: string; summary: string }>;
  convs: ConvRow[];
  caps: CompanionSettings;
  records: WakeRow[];
}

export interface CardRow {
  tier: 'core' | 'library';
  name: string;
  question: string;
  answer: string;
  mtime: number;
}

export interface TokensState {
  today: { calls: number; input: number; output: number; cached: number };
  days: Array<{ date: string; calls: number; input: number; output: number }>;
  providers: Array<{ name: string; calls: number; total: number }>;
  purposes: Array<{ name: string; calls: number; total: number }>;
  recent: Array<{
    ts: string | null; instance: string; model: string; purpose: string;
    input: number; output: number; elapsedMs: number | null; outcome: string;
  }>;
}

export interface TroubleshootState {
  run: {
    enabled: boolean;
    energy: number | null;
    updatedAt: number | null;
    memoryTotal: number | null;
    vectors: number | null;
    prefixChars: number | null;
  };
  wakes: WakeRow[];
  outcomes: Array<{ outcome: string; n: number }>;
  dream: OverviewState['dream'];
  errors: string[];
}

export interface ConfigState {
  group: string;
  settings: CompanionSettings;
  role: RoleState | null;
  life: {
    city: string;
    weatherEnabled: boolean;
    weatherRefreshMinutes: number;
    homeName: string;
    planItemCount: number;
    cycleEnabled: boolean;
    cycleAnchor: string;
  };
  intero: { enabled: boolean; lowBattery: number; highLoad: number; replyBattery: number; hesitationSeconds: number };
}

// ---------------------------------------------------------------------------
// 读文件的小工具
// ---------------------------------------------------------------------------

const DIARY_DIR = ['memo', 'diary'] as const;
const DIARY_MAX = 4000;
/** 世界知识与宪法只给开头：面板不是编辑器，全文在工作区里。 */
const DOC_MAX = 6000;

function diaryDir(memoryDir: string): string {
  return join(memoryDir, ...DIARY_DIR);
}

function diaryFiles(memoryDir: string): string[] {
  const dir = diaryDir(memoryDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
}

function readDiary(memoryDir: string, date: string): { date: string; text: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const file = join(diaryDir(memoryDir), `${date}.md`);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    return { date, text: raw.length > DIARY_MAX ? `${raw.slice(0, DIARY_MAX)}…` : raw };
  } catch {
    return null;
  }
}

/** 读文件末尾若干行；坏行不抛错——日志被截断时不该整页报错。 */
function tailLines(file: string, limit: number): string[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

function readJsonl<T>(file: string, limit: number): T[] {
  return tailLines(file, limit).flatMap((line) => {
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}

function readHead(file: string, max: number): string {
  if (!existsSync(file)) return '';
  try {
    const raw = readFileSync(file, 'utf8');
    return raw.length > max ? `${raw.slice(0, max)}…` : raw;
  } catch {
    return '';
  }
}

interface WakeRecord {
  id?: string;
  ts?: string;
  reason?: string;
  outcome?: string;
  durationMs?: number;
  context?: { estTokens?: number | null; prefixChars?: number };
  actions?: { sent?: string | null };
  events?: Array<{ type?: string }>;
}

interface UsageRecord {
  ts?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  attempt?: {
    startedAt?: string;
    elapsedMs?: number;
    purpose?: string;
    outcome?: string;
    origin?: { instance?: string; model?: string };
    meters?: { input?: number; output?: number; cachedInput?: number; total?: number };
  };
}

function wakeRow(raw: WakeRecord): WakeRow {
  const types = [...new Set((raw.events ?? []).map((e) => e.type).filter((t): t is string => !!t))];
  return {
    id: raw.id ?? null,
    ts: raw.ts ?? null,
    reason: raw.reason ?? null,
    outcome: raw.outcome ?? null,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : null,
    estTokens: raw.context?.estTokens ?? null,
    prefixChars: raw.context?.prefixChars ?? null,
    types,
    sent: raw.actions?.sent ?? null,
  };
}

/** 最近的唤醒（新的在前）。 */
function readWakes(dataDir: string, limit: number): WakeRow[] {
  return readJsonl<WakeRecord>(join(dataDir, 'wakes.jsonl'), limit).reverse().map(wakeRow);
}

function localDate(ms: number, timezone: string): string {
  return dayKey(ms, timezone);
}

/** 从 ISO 时间戳推本地日期；坏值返回 null。 */
function isoLocalDate(iso: string | undefined, timezone: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? localDate(ms, timezone) : null;
}

function usageMeters(rec: UsageRecord): { input: number; output: number; cached: number; total: number } {
  const m = rec.attempt?.meters;
  const input = Number(m?.input ?? rec.promptTokens ?? 0) || 0;
  const output = Number(m?.output ?? rec.completionTokens ?? 0) || 0;
  const cached = Number(m?.cachedInput ?? 0) || 0;
  const total = Number(m?.total ?? input + output) || 0;
  return { input, output, cached, total };
}

/** 心情压成一个词：离开基线最远的那一轴；都贴着基线就是「平稳」。 */
export function shortMood(mood: RoleState['mood']): string {
  const axes: Array<[number, string]> = [
    [mood.joy - mood.baseline, '轻快'],
    [mood.anger - mood.baseline, '烦躁'],
    [mood.sorrow - mood.baseline, '低落'],
    [mood.fear - mood.baseline, '不安'],
  ];
  axes.sort((a, b) => b[0] - a[0]);
  const [delta, label] = axes[0]!;
  if (delta <= 1) return '平稳';
  return mood.intensity === 'strong' ? `很${label}` : label;
}

// ---------------------------------------------------------------------------
// 数据面
// ---------------------------------------------------------------------------

/**
 * 面板数据面。每个页签一组方法：
 * `overview` / `people` / `groups` / `observe` / `world` / `proactive` /
 * `learning` / `tokens` / `troubleshoot` / `config`。
 */
export async function companionInvoke(
  deps: CompanionPanelDeps,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const settings = deps.settings();
  const store = deps.roleState();
  const companion = deps.companion();
  const memoryDir = deps.memoryDir();
  const timezone = deps.timezone();
  const now = deps.now ? deps.now() : Date.now();
  const convs = (): ConvRow[] => companion?.snapshot().convs ?? [];
  const companionWakes = (limit: number): WakeRow[] => readWakes(deps.dataDir(), 120)
    .filter((w) => w.types.some((t) => t.startsWith('companion')))
    .slice(0, limit);

  if (method === 'overview.state') {
    const files = diaryFiles(memoryDir);
    const diary = files.length ? readDiary(memoryDir, files[0].replace(/\.md$/, '')) : null;
    const last = lastHandoffAt(memoryDir);
    // 梦按自己的冷却走，"上次整理"不再等于"上次交接"。
    const ds = deps.dreamState?.();
    const lastDreamAt = ds?.lastDreamAt ?? last;
    const snap = companion?.snapshot();
    const lastActivityAt = Math.max(0, ...(snap?.convs ?? []).map((c) => c.lastUserAt ?? 0)) || null;
    const wakes = readWakes(deps.dataDir(), 400);
    const today = localDate(now, timezone);
    const life = deps.life();
    const state: OverviewState = {
      enabled: settings.enabled,
      embeddingError: deps.embeddingStats?.().lastError ?? null,
      role: store?.snapshot() ?? null,
      caps: {
        proactiveToday: snap?.proactiveToday ?? 0,
        dailyCap: settings.dailyCap,
        topicToday: snap?.topicToday ?? 0,
        topicDailyCap: settings.topicDailyCap,
      },
      diary,
      dream: {
        lastHandoffAt: lastDreamAt,
        pendingNotes: ds?.pending.length ?? 0,
        everyHours: settings.dreamEveryHours,
        lastActivityAt,
        due: dreamDue({
          now,
          lastHandoffAt: lastDreamAt,
          hours: settings.dreamEveryHours,
          lastActivityAt,
          diaryDate: diary?.date ?? null,
          today,
        }),
      },
      wakes: wakes.slice(0, 8),
      convs: convs(),
      counts: {
        wakesToday: wakes.filter((w) => isoLocalDate(w.ts ?? undefined, timezone) === today).length,
        sentToday: wakes.filter((w) => w.outcome === 'sent' && isoLocalDate(w.ts ?? undefined, timezone) === today).length,
      },
      today: life
        ? {
            date: life.date,
            refreshedAt: life.refreshedAt,
            weather: life.weather,
            location: life.location,
            mood: store ? shortMood(store.current.mood) : life.mood,
            moodDetail: life.mood,
            agendaCount: life.agendaCount,
            planSource: life.planSource,
            health: life.health,
            outfit: life.outfit,
            sleep: life.sleep.text,
            body: life.body,
            cycleName: life.cycle?.phase.name ?? null,
            cycleDay: life.cycle?.dayInPhase ?? null,
            cycleDays: life.cycle?.phase.days ?? null,
            hunger: life.hunger,
            dreamText: life.dream,
            energy: life.energy,
          }
        : null,
      current: life?.current ?? null,
      next: life?.next ?? null,
      timeline: life?.slots ?? [],
      intero: (() => {
        const value = deps.intero();
        return value ? { ...value, gates: deps.interoConfig() } : null;
      })(),
    };
    return state;
  }

  if (method === 'overview.refreshWeather') {
    await deps.refreshWeather(true);
    const life = deps.life();
    return life ? { weather: life.weather, refreshedAt: life.refreshedAt } : { weather: '暂无天气信息', refreshedAt: null };
  }

  if (method === 'overview.saveLife') {
    const patch = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
    const result = deps.updateLife({
      ...(patch.hunger !== undefined ? { hunger: patch.hunger as string | null } : {}),
      ...(patch.dream !== undefined ? { dream: patch.dream as string | null } : {}),
      ...(patch.outfit !== undefined ? { outfit: patch.outfit as string | null } : {}),
      ...(patch.cycleAnchor !== undefined ? { cycleAnchor: patch.cycleAnchor as string | null } : {}),
    });
    return {
      ok: result.ok,
      result: result.ok
        ? `已更新：${result.applied.join('、')}${result.rejected.length ? `（忽略 ${result.rejected.join('、')}）` : ''}`
        : `没有可用的字段${result.rejected.length ? `：${result.rejected.join('、')}` : ''}`,
      life: deps.life(),
    };
  }

  if (method === 'people.list') {
    const people = deps.people();
    if (!people) return [];
    const index = deps.memoryIndex();
    // 群会话记的是"最后说话的人"，私聊记的是对方；两种都算她最近见过这个人。
    const lastSeen = new Map<string, number>();
    for (const conv of convs()) {
      const key = conv.lastUserKey ?? conv.conv.split(':')[1] ?? '';
      if (key && conv.lastUserAt) lastSeen.set(key, Math.max(lastSeen.get(key) ?? 0, conv.lastUserAt));
    }
    return people.all().map((p): PersonRow => ({
      qq: p.qq || p.file,
      name: p.name,
      summary: p.summary,
      aliases: p.aliases,
      views: p.views.length,
      memories: index && p.qq ? index.countForPerson(p.qq) : 0,
      lastSeenAt: lastSeen.get(p.qq) || null,
      file: p.file,
    }));
  }

  if (method === 'people.detail') {
    const qq = typeof args[0] === 'string' ? args[0].trim() : '';
    if (!qq) throw new Error('缺少 QQ 号');
    const people = deps.people();
    // 没 QQ 号的老档案（AI 同伴那类）用文件名点开，别在列表里给出点不动的行。
    const record = people?.byQqNumber(qq) ?? people?.all().find((p) => p.file === qq) ?? null;
    if (!record) throw new Error(`没有 ${qq} 的档案`);
    const index = deps.memoryIndex();
    const active = index ? index.countForPerson(record.qq) : 0;
    const detail: PersonDetail = {
      person: {
        qq: record.qq || record.file,
        name: record.name,
        summary: record.summary,
        aliases: record.aliases,
        views: record.views.length,
        memories: active,
        lastSeenAt: null,
        file: record.file,
      },
      views: record.views,
      memories: index
        ? index.recallForPeople([record.qq], { k: 12, includeDormant: true }).map((hit) => ({
            text: hit.text,
            eventTime: hit.eventTime,
            kind: hit.kind,
            score: Number(hit.score.toFixed(3)),
          }))
        : [],
      counts: {
        active,
        dormant: index ? index.countForPerson(record.qq, true) - active : 0,
      },
      relation: record.qq ? deps.relation(record.qq) : null,
    };
    return detail;
  }

  if (method === 'groups.state') {
    const snap = convs();
    const byConv = new Map(snap.map((c) => [c.conv, c]));
    const groups = deps.groups().map((g) => {
      const id = String(g.id);
      const conv = `group:${id}`;
      const row = byConv.get(conv);
      return {
        id,
        enabled: g.enabled,
        conv,
        lastUserAt: row?.lastUserAt ?? null,
        lastBotAt: row?.lastBotAt ?? null,
        openLoop: row?.openLoop ?? null,
        lastAttemptAt: row?.lastAttemptAt ?? null,
      };
    });
    const state: GroupsState = {
      groups,
      diagnose: companion?.diagnose() ?? { ok: false, reason: '陪伴层未挂载' },
      caps: {
        participateGroups: settings.participateGroups,
        topicWindowMinutes: settings.topicWindowMinutes,
        topicDailyCap: settings.topicDailyCap,
        topicToday: companion?.snapshot().topicToday ?? 0,
      },
    };
    return state;
  }

  if (method === 'groups.messages') {
    const conv = typeof args[0] === 'string' ? args[0] : '';
    if (!conv) throw new Error('缺少会话');
    const limit = Math.max(1, Math.min(60, Number(args[1] ?? 20) || 20));
    return deps.recentOf(conv, limit);
  }

  if (method === 'groups.attention') {
    const view = deps.attention();
    if (!view) throw new Error('QQ 世界未挂载，注意力数据不可用');
    return view;
  }

  if (method === 'groups.room') {
    const rows = deps.room?.();
    if (!rows) throw new Error('QQ 世界未挂载，群聊形状不可用');
    return rows;
  }

  if (method === 'works.state') {
    const view = deps.creative?.();
    if (!view) throw new Error('创作层未挂载');
    return view;
  }

  if (method === 'works.text') {
    const id = typeof args[0] === 'string' ? args[0] : '';
    if (!id) throw new Error('缺少作品 id');
    const found = deps.creativeText?.(id);
    if (!found) throw new Error(`没有这部作品：${id}`);
    return found;
  }

  if (method === 'observe.diaries') {
    return diaryFiles(memoryDir).map((name) => {
      const date = name.replace(/\.md$/, '');
      let size = 0;
      try {
        size = statSync(join(diaryDir(memoryDir), name)).size;
      } catch {
        size = 0;
      }
      return { date, size };
    });
  }

  if (method === 'observe.diary') {
    const date = typeof args[0] === 'string' ? args[0] : '';
    if (!date) throw new Error('缺少日期');
    const entry = readDiary(memoryDir, date);
    if (!entry) throw new Error(`没有 ${date} 的日记`);
    return entry;
  }

  if (method === 'observe.memories') {
    const query = typeof args[0] === 'string' ? args[0].trim() : '';
    const limit = Math.max(1, Math.min(100, Number(args[1] ?? 30) || 30));
    const index = deps.memoryIndex();
    if (!index) throw new Error('记忆索引不可用');
    const filter = { limit, sort: 'newest' as const, ...(query ? { query } : {}) };
    const rows = index.list(filter);
    return {
      items: rows.map((row): MemoryItem => ({
        text: row.text,
        kind: row.kind,
        eventTime: row.eventTime,
        status: row.status,
        source: row.source ?? null,
        importance: Number(row.importance.toFixed(2)),
      })),
      total: index.countFiltered(filter),
    };
  }

  if (method === 'observe.recalls') {
    const limit = Math.max(1, Math.min(40, Number(args[0] ?? 8) || 8));
    return readRecallTail(deps.dataDir(), limit).map((rec): RecallRecord => ({
      ts: typeof rec.ts === 'string' ? rec.ts : null,
      query: typeof rec.query === 'string' ? rec.query : null,
      caller: typeof rec.caller === 'string' ? rec.caller : null,
      hits: (Array.isArray(rec.hits) ? rec.hits : [])
        .slice(0, 2)
        .map((hit) => ({
          text: typeof hit?.text === 'string' ? hit.text : '',
          score: typeof hit?.score === 'number' ? Number(hit.score.toFixed(3)) : 0,
        })),
    }));
  }

  if (method === 'observe.views') {
    const people = deps.people();
    if (!people) return [];
    return people.all()
      .filter((p) => p.views.length > 0)
      .map((p) => ({ qq: p.qq || p.file, name: p.name, file: p.file, summary: p.summary, views: p.views }));
  }

  if (method === 'world.state') {
    const files: WorldState['files'] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 2 || !existsSync(dir) || files.length >= 80) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.startsWith('.') || files.length >= 80) continue;
        const full = join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        files.push({
          path: relative(memoryDir, full).split(sep).join('/'),
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
    };
    walk(join(memoryDir, 'note'), 0);
    const state: WorldState = {
      files: files.sort((a, b) => b.mtime - a.mtime),
      worldview: readHead(join(memoryDir, 'WORLDVIEW.md'), DOC_MAX),
      constitution: readHead(join(memoryDir, 'CONSTITUTION.md'), DOC_MAX),
      memoryDir,
    };
    return state;
  }

  if (method === 'proactive.state') {
    const seen = companion?.inspect();
    const state: ProactiveState = {
      diagnose: companion?.diagnose() ?? { ok: false, reason: '陪伴层未挂载' },
      gate: seen?.gate ?? null,
      candidates: seen?.candidates ?? [],
      convs: convs(),
      caps: settings,
      records: companionWakes(8),
    };
    return state;
  }

  if (method === 'learning.cards') {
    const dirs = deps.styleDirs();
    const rows: CardRow[] = [];
    for (const tier of ['core', 'library'] as const) {
      const dir = tier === 'core' ? dirs.core : dirs.library;
      if (!existsSync(dir)) continue;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of names) {
        if (!file.endsWith('-user.md')) continue;
        const name = file.slice(0, -'-user.md'.length);
        const reply = join(dir, `${name}-reply.md`);
        if (!existsSync(reply)) continue;
        let mtime = 0;
        try {
          mtime = statSync(reply).mtimeMs;
        } catch {
          mtime = 0;
        }
        rows.push({
          tier,
          name,
          question: readHead(join(dir, file), 400).trim(),
          answer: readHead(reply, 800).trim(),
          mtime,
        });
      }
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    return {
      cards: rows,
      core: rows.filter((r) => r.tier === 'core').length,
      library: rows.filter((r) => r.tier === 'library').length,
    };
  }

  if (method === 'tokens.state') {
    const records = readJsonl<UsageRecord>(join(deps.dataDir(), 'usage.jsonl'), 4000);
    const today = localDate(now, timezone);
    const acc = { calls: 0, input: 0, output: 0, cached: 0 };
    const days = new Map<string, { date: string; calls: number; input: number; output: number }>();
    const providers = new Map<string, { name: string; calls: number; total: number }>();
    const purposes = new Map<string, { name: string; calls: number; total: number }>();
    const recent: TokensState['recent'] = [];

    for (const rec of records) {
      const meters = usageMeters(rec);
      const date = isoLocalDate(rec.attempt?.startedAt ?? rec.ts, timezone);
      if (date) {
        const day = days.get(date) ?? { date, calls: 0, input: 0, output: 0 };
        day.calls += 1;
        day.input += meters.input;
        day.output += meters.output;
        days.set(date, day);
      }
      if (date === today) {
        acc.calls += 1;
        acc.input += meters.input;
        acc.output += meters.output;
        acc.cached += meters.cached;
      }
      const instance = rec.attempt?.origin?.instance ?? '未知';
      const provider = providers.get(instance) ?? { name: instance, calls: 0, total: 0 };
      provider.calls += 1;
      provider.total += meters.total;
      providers.set(instance, provider);
      const purpose = rec.attempt?.purpose ?? 'generation';
      const slot = purposes.get(purpose) ?? { name: purpose, calls: 0, total: 0 };
      slot.calls += 1;
      slot.total += meters.total;
      purposes.set(purpose, slot);
    }

    // 最近的调用取文件末尾：文件按时间追加，前八条是最旧的。
    for (const rec of records.slice(-8).reverse()) {
      const meters = usageMeters(rec);
      recent.push({
        ts: rec.attempt?.startedAt ?? rec.ts ?? null,
        instance: rec.attempt?.origin?.instance ?? '未知',
        model: rec.attempt?.origin?.model ?? rec.model ?? '—',
        purpose: rec.attempt?.purpose ?? 'generation',
        input: meters.input,
        output: meters.output,
        elapsedMs: rec.attempt?.elapsedMs ?? null,
        outcome: rec.attempt?.outcome ?? '—',
      });
    }

    const state: TokensState = {
      today: acc,
      days: [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 7),
      providers: [...providers.values()].sort((a, b) => b.total - a.total),
      purposes: [...purposes.values()].sort((a, b) => b.total - a.total),
      recent: recent.reverse(),
    };
    return state;
  }

  if (method === 'troubleshoot.state') {
    const dataDir = deps.dataDir();
    const all = readWakes(dataDir, 200);
    const index = deps.memoryIndex();
    const last = lastHandoffAt(memoryDir);
    const ds = deps.dreamState?.();
    const lastDreamAt = ds?.lastDreamAt ?? last;
    const snap = companion?.snapshot();
    const lastActivityAt = Math.max(0, ...(snap?.convs ?? []).map((c) => c.lastUserAt ?? 0)) || null;
    const files = diaryFiles(memoryDir);
    const diary = files.length ? readDiary(memoryDir, files[0].replace(/\.md$/, '')) : null;
    const outcomes = new Map<string, number>();
    for (const w of all) outcomes.set(w.outcome ?? '?', (outcomes.get(w.outcome ?? '?') ?? 0) + 1);
    const model = deps.embeddingModel();
    const state: TroubleshootState = {
      run: {
        enabled: settings.enabled,
        energy: store ? Math.round(store.current.energy) : null,
        updatedAt: store?.current.updatedAt ?? null,
        memoryTotal: index ? index.count() : null,
        vectors: index && model ? index.vectorCount(model) : null,
        prefixChars: all[0]?.prefixChars ?? null,
      },
      wakes: all.slice(0, 12),
      outcomes: [...outcomes.entries()].map(([outcome, n]) => ({ outcome, n })).sort((a, b) => b.n - a.n),
      dream: {
        lastHandoffAt: lastDreamAt,
        pendingNotes: ds?.pending.length ?? 0,
        everyHours: settings.dreamEveryHours,
        lastActivityAt,
        due: dreamDue({
          now,
          lastHandoffAt: lastDreamAt,
          hours: settings.dreamEveryHours,
          lastActivityAt,
          diaryDate: diary?.date ?? null,
          today: localDate(now, timezone),
        }),
      },
      errors: tailLines(join(dataDir, 'console.err.log'), 12),
    };
    return state;
  }

  if (method === 'config.state') {
    const life = deps.lifeConfig();
    const weather = deps.weatherConfig();
    const state: ConfigState = {
      group: 'amber',
      settings,
      role: store?.snapshot() ?? null,
      life: {
        city: weather.city,
        weatherEnabled: weather.enabled,
        weatherRefreshMinutes: weather.refreshMinutes,
        homeName: life.homeName,
        planItemCount: life.planItemCount,
        cycleEnabled: life.cycleEnabled,
        cycleAnchor: life.cycleAnchor ?? '',
      },
      intero: deps.interoConfig(),
    };
    return state;
  }

  if (method === 'config.saveLife') {
    const patch = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
    const result = deps.updateLife({
      ...(patch.hunger !== undefined ? { hunger: patch.hunger as string | null } : {}),
      ...(patch.dream !== undefined ? { dream: patch.dream as string | null } : {}),
      ...(patch.outfit !== undefined ? { outfit: patch.outfit as string | null } : {}),
      ...(patch.cycleAnchor !== undefined ? { cycleAnchor: patch.cycleAnchor as string | null } : {}),
    });
    return {
      ok: result.ok,
      result: result.ok
        ? `已更新：${result.applied.join('、')}${result.rejected.length ? `（忽略 ${result.rejected.join('、')}）` : ''}`
        : `没有可用的字段${result.rejected.length ? `：${result.rejected.join('、')}` : ''}`,
    };
  }

  if (method === 'config.saveState') {
    if (!store) throw new Error('角色状态不可用（没有 data 目录）');
    const patch = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
    const result = store.patch(patch);
    return {
      ok: result.ok,
      result: result.ok
        ? `已更新：${result.applied.join('、')}${result.rejected.length ? `（忽略 ${result.rejected.join('、')}）` : ''}`
        : `没有可用的字段${result.rejected.length ? `：${result.rejected.join('、')}` : ''}`,
      state: store.snapshot(),
    };
  }

  throw new Error(`未知面板方法: companion.${method}`);
}
