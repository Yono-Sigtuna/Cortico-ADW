/** bot 的服务端 WebUI 入口，提供存档点、统一重置和强制入梦。统一重置先回滚 Persona 工作区，再按清单顺序清除框架存储。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoragePart } from 'cortico/core/types.ts';
import type {
  WebUiCheckpointEntry, WebUiMediumStatus,
  WebAppCheckpointDeps,
} from 'cortico/web/server.ts';
import {
  pageIdFor,
  type WebUiPanelDecl,
  type WebUiPageContribution,
} from 'cortico/web/shared/webui-protocol.ts';
import { CORE_CARD_MAX, CORE_CARD_CHARS } from './persona/index.ts';
import { cardTags, categoryOf } from './persona/styleCards.ts';
import { StyleCardGate, type CardStat } from './persona/styleCardGate.ts';
import { COMPANION_PANELS, companionInvoke, type CompanionPanelDeps } from './persona/companionPanel.ts';

// ---------------------------------------------------------------------------
// 面板声明
// ---------------------------------------------------------------------------

/**
 * 统一重置与强制入梦的 bot 侧接口；人格领域类型由提供方持有。
 */
export interface CortiResetDeps {
  /** `parts` 是框架提供的权威存储清单;实现决定清除范围与执行顺序。 */
  run(checkpoint: string, parts: StoragePart[]): Promise<{
    ok: boolean;
    persona: string;
    results: Array<{ key: string; ok: boolean; result: string }>;
  }>;
}

/** 手动强制"入梦→截断→唤醒"(人工操作)。 */
export interface CortiDreamDeps {
  /** 已在入梦或截断中则不重复触发,返回 ok:false 说明原因。 */
  trigger(): { ok: boolean; message: string };
}

export const CORTI_OPS_PANELS: WebUiPanelDecl[] = [
  {
    id: 'checkpoints',
    title: '存档点',
    description: 'persona/ 的 git tag。新建会先把当前改动提交进去;checkpoint0 是出厂基线。',
  },
  {
    id: 'reset',
    title: '统一重置',
    description: '回滚 persona 到某个存档点,并按序清空全部 core 存储。不可撤销的运维动作。',
  },
  {
    id: 'dream',
    title: '强制入梦',
    description: '手动触发一次交接,交接完成后梦在后台整理工作区。已在进行中不会重复触发。',
  },
  {
    id: 'wake',
    title: '唤醒与线索',
    description: '开着的对话线索与最近的唤醒记录;可以手动关线。',
  },
  {
    id: 'cards',
    title: '语气卡',
    description: '常驻 sessionHead 的示例对;保存后下一次请求生效。',
  },
];

// ---------------------------------------------------------------------------
// 返回形状(浏览器那一半 import 不到本文件,两边靠这些注释对齐)
// ---------------------------------------------------------------------------

export interface OpsApplied<S> {
  ok: true;
  result: string;
  state: S;
}

export interface OpsCheckpointsState {
  status: WebUiMediumStatus;
  checkpoints: WebUiCheckpointEntry[];
}

/** 重置面板要展示"到底会清掉哪些东西",所以把清单的可显示部分一起回。 */
export interface OpsStoragePart {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  location?: string;
  danger?: boolean;
  note?: string;
}

export interface OpsResetState {
  status: WebUiMediumStatus;
  checkpoints: WebUiCheckpointEntry[];
  parts: OpsStoragePart[];
  /** 清单齐不齐。不齐就不许按下去——半次重置比不重置危险得多。 */
  ready: boolean;
  /** `ready:false` 时的原因,原样显示 */
  reason: string | null;
}

export interface OpsResetResult {
  ok: boolean;
  persona: string;
  results: Array<{ key: string; ok: boolean; result: string }>;
}

export interface OpsDreamState {
  dreaming: boolean;
}

// ---------------------------------------------------------------------------
// 重置的存储清单闸门
// ---------------------------------------------------------------------------

/** 重置要求权威存储清单中包含 session 和 events；核查键名，不依赖条目总数。 */
const REQUIRED_PART_KEYS = ['session', 'events'];

function readiness(parts: StoragePart[]): { ready: boolean; reason: string | null } {
  const missing = REQUIRED_PART_KEYS.filter((k) => !parts.some((p) => p.key === k));
  if (missing.length === 0) return { ready: true, reason: null };
  return {
    ready: false,
    reason: `存储清单不完整（缺 ${missing.join(' / ')}），无法执行统一重置。`,
  };
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface CortiOpsDeps {
  /** 这一页的名字(冒号后那截),必须等于 bot id:装配层才会把它与 Persona 自报的那半合成一页,asset key 才对得上按目录出的产物。 */
  name: string;
  label: string;
  checkpoints: WebAppCheckpointDeps;
  /** 介质状态(HEAD / 脏 / 存档点),存档点与重置两个面板都要显示 */
  status(): WebUiMediumStatus;
  reset: CortiResetDeps;
  /**
   * 重置要清的存储清单。**bot 自己闭包持有**——`CortiResetDeps.run` 那个
   * `parts` 参数在改走 WebUI 页之后就不该由框架回传了。
   */
  storage(): StoragePart[];
  dream: CortiDreamDeps;
  dreamState(): OpsDreamState;
  mods: CortiModsSource;
}

/** 管理页的数据来源:唤醒日志、对话线索、语气卡。 */
export interface CortiModsSource {
  /** 部署 data/:唤醒日志与对话线索都在这里。 */
  dataDir: string;
  /** 部署 prompts/style/core/:常驻核心卡。 */
  coreDir: string;
  /** 工作区 note/style/:按需读取的语气库。 */
  libraryDir: string;
  threads(): ModsThread[];
  closeThread(conv: string, person: string): boolean;
  ambient(): { enabled: boolean; intervalMinutes: number; buffered: number };
  /** 陪伴层的观测面：状态、主动诊断、日记与看法。没挂载时返回 null。 */
  companion?(): CompanionPanelDeps | null;
}

export interface ModsThread {
  conv: string;
  /** 对方的稳定身份：QQ 号。 */
  person: string;
  /** 对方的当前昵称；昵称会变，只用于展示。 */
  personName?: string;
  openedAt: number;
  lastMessageAt: number;
}

export interface ModsWake {
  id?: string;
  ts?: string;
  reason?: string;
  matchedName?: string;
  outcome?: string;
  durationMs?: number;
  estTokens?: number | null;
  cards?: string[];
  calls?: string[];
  sent?: string | null;
  rating?: { score?: number; note?: string; at?: string };
}

export interface ModsCard {
  name: string;
  question: string;
  answer: string;
  /** 文件名里的情景类别；决定哪类话会把它递出来。 */
  scene?: string;
  /** 姿态标签（关系/心情/身体），斜杠分隔；空串 = 通用卡。 */
  stance?: string;
}

export interface ModsWakeState {
  threads: ModsThread[];
  wakes: ModsWake[];
  ambient: { enabled: boolean; intervalMinutes: number; buffered: number };
  stats: { libraryReads: number; rated: number; average: number | null };
}

export interface ModsCardsState {
  core: ModsCard[];
  library: ModsCard[];
  /** 质量门：每张卡递了几次、她照念几次、平均重合多少。 */
  stats: CardStat[];
}



const CARD_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/;

/** 卡片硬错误：出现就不许保存。 */
const CARD_BANNED = [
  /忽略(宪法|设定|规则)/,
  /无条件(服从|听话)/,
  /不要(遵守|理会)(规则|宪法)/,
];

export interface CardLint {
  /** 出现就拒绝保存。 */
  hard: string[];
  /** 可以保存到资料库，但设为常驻前要处理。 */
  warn: string[];
}

function bigrams(text: string): Set<string> {
  const s = text.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * 语气卡的确定性检查。硬错误拒绝；警告允许进资料库、但不许进常驻。
 * 语义好坏不在这里判断——那是人工评分与评测的事。
 */
export function lintCard(question: string, answer: string, peers: readonly ModsCard[] = []): CardLint {
  const hard: string[] = [];
  const warn: string[] = [];
  const q = question.trim();
  const a = answer.trim();
  if (!q) hard.push('群友那句是空的');
  if (!a) hard.push('她的回答是空的');
  if (q && a && q === a) hard.push('问答完全一样');
  for (const pattern of CARD_BANNED) {
    if (pattern.test(`${q}\n${a}`)) hard.push(`含禁用表述：${pattern.source}`);
  }
  if (q.length > 200) warn.push('群友那句超过 200 字');
  if (a.length > 400) warn.push('她的回答超过 400 字');
  if (q && !/[一-鿿]/.test(`${q}${a}`)) warn.push('问答里没有中文，确认是否写错语言');
  for (const peer of peers) {
    if (similarity(`${q}${a}`, `${peer.question}${peer.answer}`) >= 0.75) {
      warn.push(`与已有卡「${peer.name}」高度相似`);
      break;
    }
  }
  return { hard, warn };
}

function readWakes(dataDir: string, limit = 50): { wakes: ModsWake[]; libraryReads: number } {
  const empty = { wakes: [] as ModsWake[], libraryReads: 0 };
  try {
    const file = join(dataDir, 'wakes.jsonl');
    if (!existsSync(file)) return empty;
    let libraryReads = 0;
    const wakes = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          const wake = JSON.parse(line) as {
            id?: string; ts?: string; reason?: string; matchedName?: string;
            outcome?: string; durationMs?: number;
            context?: { estTokens?: number | null; cards?: string[] };
            actions?: { calls?: Array<{ name?: string; args?: string }>; sent?: string | null };
          };
          const calls = wake.actions?.calls ?? [];
          for (const call of calls) {
            if (call.name === 'read_file' && String(call.args ?? '').includes('note/style')) libraryReads += 1;
          }
          return [{
            id: wake.id,
            ts: wake.ts,
            reason: wake.reason,
            matchedName: wake.matchedName,
            outcome: wake.outcome,
            durationMs: wake.durationMs,
            estTokens: wake.context?.estTokens ?? null,
            cards: wake.context?.cards ?? [],
            calls: calls.map((call) => call.name).filter((name): name is string => !!name),
            sent: wake.actions?.sent ?? null,
          }];
        } catch {
          return [];
        }
      });
    return { wakes, libraryReads };
  } catch {
    return empty;
  }
}

interface WakeRating {
  score?: number;
  note?: string;
  at?: string;
}

function wakeRatingsFile(dataDir: string): string {
  return join(dataDir, 'wake-ratings.jsonl');
}

function readRatings(dataDir: string): Map<string, WakeRating> {
  const out = new Map<string, WakeRating>();
  try {
    const file = wakeRatingsFile(dataDir);
    if (!existsSync(file)) return out;
    for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as { id?: string; score?: number; note?: string; at?: string };
        if (row.id && typeof row.score === 'number') {
          out.set(row.id, { score: row.score, note: row.note, at: row.at });
        }
      } catch { /* 跳过坏行 */ }
    }
  } catch { /* 没有评分文件 */ }
  return out;
}

function appendRating(dataDir: string, id: string, score: number, note: string): void {
  appendFileSync(
    wakeRatingsFile(dataDir),
    `${JSON.stringify({ id, score, note, at: new Date().toISOString() })}\n`,
    'utf8',
  );
}

function readCards(styleDir: string): ModsCard[] {
  try {
    return readdirSync(styleDir)
      .filter((file) => file.endsWith('-user.md'))
      .sort()
      .flatMap((file) => {
        const name = file.slice(0, -'-user.md'.length);
        const reply = join(styleDir, `${name}-reply.md`);
        if (!existsSync(reply)) return [];
        return [{
          name,
          question: readFileSync(join(styleDir, file), 'utf8').trim(),
          answer: readFileSync(reply, 'utf8').trim(),
          scene: categoryOf(name),
          stance: cardTags(name).join('/'),
        }];
      });
  } catch {
    return [];
  }
}

function writeCard(styleDir: string, name: string, question: string, answer: string): string {
  if (!CARD_NAME.test(name)) throw new Error('卡片名只能用字母、数字、_ 和 -');
  if (!question.trim() || !answer.trim()) throw new Error('问题和回答都不能为空');
  mkdirSync(styleDir, { recursive: true });
  writeFileSync(join(styleDir, `${name}-user.md`), `${question.trim()}\n`, 'utf8');
  writeFileSync(join(styleDir, `${name}-reply.md`), `${answer.trim()}\n`, 'utf8');
  return `已保存语气卡 ${name}`;
}

function deleteCard(styleDir: string, name: string): string {
  if (!CARD_NAME.test(name)) throw new Error('卡片名不合法');
  let removed = 0;
  for (const suffix of ['-user.md', '-reply.md']) {
    const file = join(styleDir, `${name}${suffix}`);
    if (existsSync(file)) {
      rmSync(file);
      removed += 1;
    }
  }
  if (!removed) throw new Error(`没有找到语气卡 ${name}`);
  return `已删除语气卡 ${name}`;
}

function cardDir(mods: CortiModsSource, tier: 'core' | 'library'): string {
  return tier === 'core' ? mods.coreDir : mods.libraryDir;
}

function tierOf(value: unknown): 'core' | 'library' {
  if (value === 'core' || value === 'library') return value;
  throw new Error('层级只能是 core 或 library');
}

function cardsState(mods: CortiModsSource): ModsCardsState {
  return {
    core: readCards(mods.coreDir),
    library: readCards(mods.libraryDir),
    stats: new StyleCardGate(mods.dataDir).stats(),
  };
}

/** 常驻卡有预算：条数与总字数。超了就不许写/移入。 */
function assertCoreBudget(dir: string, name: string, question: string, answer: string): void {
  const others = readCards(dir).filter((card) => card.name !== name);
  const chars = others.reduce((sum, card) => sum + card.question.length + card.answer.length, 0)
    + question.length + answer.length;
  if (others.length + 1 > CORE_CARD_MAX) throw new Error(`常驻核心卡最多 ${CORE_CARD_MAX} 张`);
  if (chars > CORE_CARD_CHARS) throw new Error(`常驻核心卡总字数不能超过 ${CORE_CARD_CHARS}`);
}

async function runReset(deps: CortiOpsDeps, args: unknown[]): Promise<OpsResetResult> {
  const checkpoint = typeof args[0] === 'string' ? args[0].trim() : '';
  if (!checkpoint) throw new Error('缺少 checkpoint 名');
  const parts = deps.storage();
  const gate = readiness(parts);
  if (!gate.ready) throw new Error(gate.reason ?? '存储清单不完整');
  return deps.reset.run(checkpoint, parts);
}

/**
 * 一个 `persona:<name>` 贡献，外加她的陪伴页。
 *
 * 陪伴页是同一个 bot 的附页：`clientPage` 指向主页，复用同一份浏览器产物
 * （构建按目录出包，一个 bot 目录只有一份）。左栏因此多一个独立的按钮，
 * 不必挤进运维页的页签里。
 */
export function cortiWebUiPages(deps: CortiOpsDeps): WebUiPageContribution[] {
  const pages: WebUiPageContribution[] = [{
    id: pageIdFor('persona', deps.name),
    kind: 'persona',
    label: deps.label,
    panels: CORTI_OPS_PANELS,
    invoke: async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
      if (panel === 'checkpoints') {
        const state = (): OpsCheckpointsState => ({
          status: deps.status(),
          checkpoints: deps.checkpoints.list(),
        });
        switch (method) {
          case 'state':
            return state();
          case 'create': {
            const name = typeof args[0] === 'string' ? args[0].trim() : '';
            if (!name) throw new Error('缺少 checkpoint 名');
            const note = typeof args[1] === 'string' ? args[1] : '';
            return { ok: true, result: deps.checkpoints.create(name, note), state: state() };
          }
          case 'remove': {
            const name = typeof args[0] === 'string' ? args[0].trim() : '';
            if (!name) throw new Error('缺少 checkpoint 名');
            return { ok: true, result: deps.checkpoints.remove(name), state: state() };
          }
          // 存档点列表上的「回滚到此」与「统一重置」面板是同一次事务,
          // 走同一个 `runReset`——两个入口、一份实现。
          case 'rollback':
            return runReset(deps, args);
          default:
            throw new Error(`未知面板方法: ${panel}.${method}`);
        }
      }
      if (panel === 'reset') {
        if (method === 'state') {
          const parts = deps.storage();
          const gate = readiness(parts);
          const out: OpsResetState = {
            status: deps.status(),
            checkpoints: deps.checkpoints.list(),
            parts: parts.map((p) => ({
              key: p.key,
              label: p.label,
              kind: p.kind,
              ...(p.location ? { location: p.location } : {}),
              ...(p.danger ? { danger: true } : {}),
              ...(p.note ? { note: p.note } : {}),
            })),
            ready: gate.ready,
            reason: gate.reason,
          };
          return out;
        }
        if (method === 'run') return runReset(deps, args);
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      if (panel === 'dream') {
        if (method === 'state') return deps.dreamState();
        if (method === 'trigger') {
          const out = deps.dream.trigger();
          return { ...out, state: deps.dreamState() };
        }
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      if (panel === 'wake') {
        if (method === 'list') {
          const tail = readWakes(deps.mods.dataDir);
          const ratings = readRatings(deps.mods.dataDir);
          const wakes = tail.wakes.map((wake) => (
            wake.id && ratings.has(wake.id) ? { ...wake, rating: ratings.get(wake.id) } : wake
          ));
          const rated = wakes.filter((wake) => wake.rating);
          const average = rated.length
            ? rated.reduce((sum, wake) => sum + (wake.rating?.score ?? 0), 0) / rated.length
            : null;
          const state: ModsWakeState = {
            threads: deps.mods.threads(),
            wakes,
            ambient: deps.mods.ambient(),
            stats: { libraryReads: tail.libraryReads, rated: rated.length, average },
          };
          return state;
        }
        if (method === 'rate') {
          const id = typeof args[0] === 'string' ? args[0] : '';
          const score = Number(args[1]);
          const note = typeof args[2] === 'string' ? args[2] : '';
          if (!id || !Number.isInteger(score) || score < 1 || score > 5) throw new Error('评分需要 1–5 的整数');
          appendRating(deps.mods.dataDir, id, score, note);
          return { ok: true, result: `已记下 ${id} 的评分 ${score}/5` };
        }
        if (method === 'closeThread') {
          const conv = typeof args[0] === 'string' ? args[0] : '';
          const person = typeof args[1] === 'string' ? args[1] : '';
          if (!conv || !person) throw new Error('线索参数不合法');
          return deps.mods.closeThread(conv, person)
            ? `已关闭 ${conv} / ${person} 的线索`
            : `${conv} / ${person} 没有开着的线索`;
        }
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      if (panel === 'cards') {
        if (method === 'list') return cardsState(deps.mods);
        if (method === 'save') {
          const tier = tierOf(args[0]);
          const name = typeof args[1] === 'string' ? args[1].trim() : '';
          const question = typeof args[2] === 'string' ? args[2] : '';
          const answer = typeof args[3] === 'string' ? args[3] : '';
          const dir = cardDir(deps.mods, tier);
          const lint = lintCard(question, answer, readCards(dir).filter((card) => card.name !== name));
          if (lint.hard.length) throw new Error(`卡片未通过检查：${lint.hard.join('；')}`);
          if (tier === 'core' && lint.warn.length) {
            throw new Error(`设为常驻前先处理：${lint.warn.join('；')}（可先存资料库）`);
          }
          if (tier === 'core') assertCoreBudget(dir, name, question, answer);
          return {
            ok: true,
            result: writeCard(dir, name, question, answer),
            ...(lint.warn.length ? { warnings: lint.warn } : {}),
            state: cardsState(deps.mods),
          };
        }
        if (method === 'delete') {
          const tier = tierOf(args[0]);
          const name = typeof args[1] === 'string' ? args[1].trim() : '';
          return { ok: true, result: deleteCard(cardDir(deps.mods, tier), name), state: cardsState(deps.mods) };
        }
        if (method === 'move') {
          const from = tierOf(args[0]);
          const to = tierOf(args[1]);
          const name = typeof args[2] === 'string' ? args[2].trim() : '';
          if (from === to) throw new Error('原地移动没有意义');
          const card = readCards(cardDir(deps.mods, from)).find((entry) => entry.name === name);
          if (!card) throw new Error(`没有找到语气卡 ${name}`);
          if (to === 'core') {
            const lint = lintCard(card.question, card.answer, readCards(deps.mods.coreDir).filter((entry) => entry.name !== name));
            if (lint.hard.length) throw new Error(`卡片未通过检查：${lint.hard.join('；')}`);
            if (lint.warn.length) throw new Error(`设为常驻前先处理：${lint.warn.join('；')}`);
            assertCoreBudget(deps.mods.coreDir, name, card.question, card.answer);
          }
          writeCard(cardDir(deps.mods, to), name, card.question, card.answer);
          deleteCard(cardDir(deps.mods, from), name);
          return {
            ok: true,
            result: to === 'core' ? `已设为常驻 ${name}` : `已移入资料库 ${name}`,
            state: cardsState(deps.mods),
          };
        }
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      throw new Error(`未知面板: ${panel}`);
    },
  }];

  const companion = deps.mods.companion?.();
  if (companion) {
    pages.push({
      id: pageIdFor('persona', `${deps.name}-companion`),
      kind: 'persona',
      label: '陪伴',
      clientPage: pageIdFor('persona', deps.name),
      panels: COMPANION_PANELS,
      invoke: async (panel: string, method: string, args: unknown[]): Promise<unknown> => (
        companionInvoke(companion, `${panel}.${method}`, args)
      ),
    });
  }
  return pages;
}
