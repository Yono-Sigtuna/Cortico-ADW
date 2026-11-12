/**
 * 她自己的作品：一部作品分很多次写完，每次一小段。
 *
 * 这里只有类型与纯函数，不碰文件也不调模型。判据全是状态——写到哪、还剩多少、
 * 离上次多久——没有随机数：随机不是创作，是抽奖。
 */

/** 一部作品此刻的长程记忆。它替代不了正文，只记住续写靠什么不跑偏。 */
export interface StoryBible {
  /** 一句话：现在真正推进到哪条主线。 */
  mainline: string;
  themes: string[];
  /** 埋下还没收的线索。 */
  openThreads: string[];
  /** 后续不能写错的事实（人物、时间、地点、已发生的事）。 */
  facts: string[];
  /** 下一段最自然该写什么。 */
  nextDirection: string;
  /** 检索用的词，也是判断"和前面像不像"的锚。 */
  keywords: string[];
  /** 最近几段的大纲，用来避开重复的套路。 */
  recentOutlines: string[];
}

export function emptyBible(): StoryBible {
  return { mainline: '', themes: [], openThreads: [], facts: [], nextDirection: '', keywords: [], recentOutlines: [] };
}

/** 长篇的一章：写完才留一句摘要，给几十万字之后的自己回看。 */
export interface Chapter {
  index: number;
  /** 这一章写了什么，一两句话。 */
  summary: string;
  /** 这一章写了多少字。 */
  chars: number;
  /** 这一章定下、后面不能写错的事。 */
  facts: string[];
}

/** 一卷：几章合成一段更远的记忆。收卷之后，前面的章就不再单独带进上下文。 */
export interface Volume {
  index: number;
  title: string;
  /** 整卷的一句话；空 = 这一卷还没收。 */
  summary: string;
  chapters: Chapter[];
}

/** 立项时排的卷目：写到第几卷就用第几条。 */
export interface VolumePlan {
  title: string;
  premise: string;
}

/** 这一部打算写多大。由她立项时自己定，不是配置说了算。 */
export type WorkScale = '短' | '中' | '长';

/** 三档各自的字数区间（长篇的上限再被 `maxTargetChars` 压一次）。 */
export const SCALE_BANDS: Record<WorkScale, [number, number]> = {
  短: [300, 5200],
  中: [20000, 60000],
  长: [60000, 300000],
};

/**
 * 她说的这一部算哪一档。
 *
 * 以她自己写的 `scale` 为准；认不出来就按她给的字数推。长篇没放开时一律短——
 * 那是能力的闸，不是审美的闸。
 */
export function pickScale(raw: unknown, targetChars: number, allowLong: boolean): WorkScale {
  if (!allowLong) return '短';
  const said = String(raw ?? '').trim();
  if (said === '短' || said === '中' || said === '长') return said;
  const number = Number(targetChars);
  if (Number.isFinite(number) && number >= SCALE_BANDS.长[0]) return '长';
  if (Number.isFinite(number) && number >= SCALE_BANDS.中[0]) return '中';
  return '短';
}

/** 有一次机会让她自己提一句的作品节点。 */
export type Milestone = 'opening' | 'midpoint' | 'finished';

export interface ShareOffer {
  workId: string;
  title: string;
  workType: string;
  milestone: Milestone;
  /** 要递到她眼前的那一段。 */
  snippet: string;
  currentChars: number;
  targetChars: number;
  chunkCount: number;
}

export interface Work {
  id: string;
  title: string;
  workType: string;
  premise: string;
  tone: string;
  pointOfView: string;
  targetChars: number;
  currentChars: number;
  status: 'drafting' | 'finished';
  /** 正文路径，相对工作区。 */
  file: string;
  /** 灵感从哪来：她今天的哪件事、哪个梦。 */
  sourceLabel: string;
  sourceText: string;
  bible: StoryBible;
  chunkCount: number;
  /** 到这个时刻才轮到下一次续写。 */
  nextAdvanceAt: number;
  createdAt: number;
  lastAdvancedAt: number;
  /** 连续失败次数：退避按它算，成功清零。 */
  failures: number;
  lastError: string;
  /** 已经递过的里程碑，同一个不递第二次。 */
  disclosed: Milestone[];
  /** 待她开口的分享机会；有人接走了就清空。 */
  pendingShare: ShareOffer | null;
  /** 长篇的卷与章；短篇是空数组。 */
  volumes: Volume[];
  /** 当前这一章从正文的哪个字符位置开始。 */
  chapterStart: number;
  /** 立项时排的卷目；写到第几卷就用第几条。 */
  volumePlan: VolumePlan[];
  /** 立项时她自己定的规模。短篇也有，用来记录她当时怎么想的。 */
  scale?: WorkScale;
  /**
   * 已写进正文、但还没核对账目的那一段。
   * 先记它再写正文，进程中途退出时下次据此判断写没写成，不重复写。
   */
  pendingChunk?: { text: string; at: number };
  /** 已到收章点但摘要没生成出来的区间；作品完结了也继续补。 */
  pendingChapter?: { start: number; end: number; at: number; failures: number; nextAttemptAt: number };
}

export interface CreativeSettings {
  enabled: boolean;
  /** 每次写多少字。 */
  chunkChars: number;
  /** 同时进行中的作品数上限。 */
  maxActiveWorks: number;
  /** 两次续写之间隔多久：区间内按作品 id 取一个稳定值，不掷骰子。 */
  advanceMinutes: [number, number];
  /** 一天最多写几段。 */
  maxChunksPerDay: number;
  /** 允许她把自己写的东西拿出来说一句。 */
  shareEnabled: boolean;
  /** 一天最多分享几次。 */
  shareDailyCap: number;
  /** 创作方向；空 = 跟着此时此地的日子走。 */
  direction: string;
  /** 长篇：目标字数放宽到几万到几十万，按章推进、按卷压缩。 */
  longForm?: boolean;
  /** 长篇每章多少字：到量就收一章、写摘要。 */
  chapterChars?: number;
  /** 长篇每卷几章。 */
  chaptersPerVolume?: number;
  /** 长篇目标字数的上限。 */
  maxTargetChars?: number;
}

/** 一次推进的结果，给日志与面板看。 */
export interface CreativeRun {
  at: number;
  ok: boolean;
  /** 为什么没写，或写成了什么。 */
  reason: string;
  workId: string | null;
  chars: number;
  ms: number;
}

export interface CreativeState {
  version: 1;
  /** 本地日期，用于每日额度滚动。 */
  day: string;
  chunksToday: number;
  sharesToday: number;
  works: Work[];
  lastRun: CreativeRun | null;
}

export function emptyState(day: string): CreativeState {
  return { version: 1, day, chunksToday: 0, sharesToday: 0, works: [], lastRun: null };
}

/** 正文里不能出现的东西：标题、说明、JSON、系统旁白。 */
const LEADING_LABEL = /^(?:正文|续写|片段|第[一二三四五六七八九十\d]+段)[：:]\s*/;

/** 去掉模型偶尔贴回来的代码围栏与"正文："前缀，再把长度收进预算。 */
export function cleanChunk(raw: string, budget: number): string {
  let text = String(raw ?? '').trim();
  text = text.replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
  text = text.replace(LEADING_LABEL, '').trim();
  if (text.length > budget + 80) {
    text = text.slice(0, budget + 80).replace(/[，,、；;：:]+$/, '').trim();
    if (text && !/[。！？…]$/.test(text)) text += '。';
  }
  return text;
}

/** 两段文字的二元组重合度：0–1。用来挡"换皮重写同一段"。 */
export function textSimilarity(left: string, right: string): number {
  const a = String(left ?? '').replace(/\s+/g, '').toLowerCase();
  const b = String(right ?? '').replace(/\s+/g, '').toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (text: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / Math.max(1, ga.size + gb.size - shared);
}

/** 与最近几段中任何一段过像，就算重复。 */
export const SIMILARITY_LIMIT = 0.72;

export function repeatsEarlier(text: string, recent: readonly string[]): boolean {
  return recent.some((item) => textSimilarity(text, item) >= SIMILARITY_LIMIT);
}

/** 中文词元：两到六字；英文与数字按整词。 */
export function keywordsOf(text: string, limit = 10): string[] {
  const tokens = String(text ?? '').match(/[一-鿿]{2,6}|[A-Za-z0-9_-]{3,24}/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const word = token.trim().toLowerCase();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

/** 这次写多少：底数按精力缩放，写不动就少写。 */
export function chunkBudget(settings: CreativeSettings, energy: number): number {
  const base = Math.max(60, Math.min(1200, settings.chunkChars));
  const scaled = energy < 0.4 ? base * 0.72 : energy > 0.82 ? base * 1.12 : base;
  return Math.max(60, Math.min(1200, Math.round(scaled)));
}

/**
 * 一部作品成熟到什么程度：0–100。
 *
 * 只看客观进度——写了多少、几段、留了几条线索和事实——不看文笔评价。
 * 分享的门槛建在它上面，所以"什么时候拿出来说"不靠运气。
 */
export function maturity(work: Work): number {
  const ratio = work.targetChars > 0 ? work.currentChars / work.targetChars : 0;
  return Math.min(
    100,
    Math.min(28, work.currentChars / 6.5) +
      Math.min(22, work.chunkCount * 5) +
      Math.min(18, work.bible.openThreads.length * 4) +
      Math.min(16, work.bible.facts.length * 5) +
      Math.min(16, ratio * 24),
  );
}

/**
 * 此刻该不该把它拿给别人看。
 *
 * 三个节点：刚成形（真的立住了，不是只开了个头）、过半、写完。每个只给一次机会，
 * 给过就不再提——同一件事反复说，等的是夸奖，不是分享。
 */
export function nextMilestone(work: Work): Milestone | null {
  const done = (m: Milestone): boolean => work.disclosed.includes(m);
  if (work.status === 'finished' && !done('finished')) return 'finished';
  // 长篇按卷给机会：收掉第一卷算"刚成形"，写到计划的一半算"过半"。
  // 按字数比例的话，三十万字要写到四万二才第一次拿出来——那不是节奏，是等。
  if (work.volumes.length > 0) {
    const closed = closedVolumes(work).length;
    if (!done('opening') && closed >= 1) return 'opening';
    const planned = work.volumePlan.length;
    const half = Math.max(2, planned >= 2 ? Math.ceil(planned / 2) : 2);
    if (!done('midpoint') && closed >= half) return 'midpoint';
    return null;
  }
  const score = maturity(work);
  const ratio = work.targetChars > 0 ? work.currentChars / work.targetChars : 0;
  if (!done('midpoint') && ratio >= 0.52 && work.chunkCount >= 3 && score >= 52) return 'midpoint';
  // 门槛跟目标字数走：三千多字的长篇写了两百字就拿出来，那不叫成形，那叫刚起笔。
  if (!done('opening') && work.currentChars >= Math.max(180, work.targetChars * 0.14) && work.chunkCount >= 2 && score >= 34) return 'opening';
  return null;
}

/** 写完之后隔多久才想起下一部：不是立刻，也不是隔一天。 */
export const NEXT_WORK_GAP_MS = 6 * 3_600_000;

/** 退避：连续失败时下一次推得更远，最多六小时。 */
export function retryDelayMs(failures: number): number {
  const step = Math.max(0, failures - 1);
  return Math.min(360, 30 * 2 ** Math.min(step, 4)) * 60_000;
}

/** 续写间隔：按作品 id 在区间里取一个稳定值，同一部作品每次都一样。 */
export function advanceDelayMs(settings: CreativeSettings, workId: string): number {
  const [lo, hi] = settings.advanceMinutes;
  const min = Math.max(1, Math.round(lo));
  const max = Math.max(min, Math.round(hi));
  let hash = 0;
  for (let i = 0; i < workId.length; i += 1) hash = (hash * 31 + workId.charCodeAt(i)) >>> 0;
  const minutes = min + (hash % (max - min + 1));
  return minutes * 60_000;
}

/** 从一次抽取的结果更新本子。数组有上限，旧的不无限堆。 */
export interface Extract {
  mainline: string;
  themes: string[];
  advanced: string[];
  resolved: string[];
  fresh: string[];
  facts: string[];
  keywords: string[];
  nextDirection: string;
}

export function applyExtract(bible: StoryBible, extract: Extract): StoryBible {
  const push = (list: string[], items: readonly string[], cap: number): string[] => {
    const out = [...list];
    for (const item of items) if (item && !out.includes(item)) out.push(item);
    return out.slice(-cap);
  };
  const themes = push(bible.themes, extract.themes, 6);
  const resolved = push([], extract.resolved, 20);
  const stillOpen = bible.openThreads.filter((thread) => !resolved.includes(thread));
  const openThreads = push(stillOpen, [...extract.advanced, ...extract.fresh], 12);
  return {
    mainline: extract.mainline || bible.mainline,
    themes,
    openThreads,
    facts: push(bible.facts, extract.facts, 12),
    nextDirection: extract.nextDirection || bible.nextDirection,
    keywords: push(bible.keywords, extract.keywords, 20),
    recentOutlines: bible.recentOutlines,
  };
}

// ---------------------------------------------------------------------------
// 长篇：分卷、分章，靠摘要把几十万字接起来
// ---------------------------------------------------------------------------

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

export function longFormOn(settings: CreativeSettings): boolean {
  return settings.longForm === true;
}

/** 长篇一章写多少字。短篇不看这个。 */
export function chapterCharsOf(settings: CreativeSettings): number {
  return clampInt(settings.chapterChars, 3000, 800, 12000);
}

/** 长篇一卷几章。 */
export function chaptersPerVolumeOf(settings: CreativeSettings): number {
  return clampInt(settings.chaptersPerVolume, 8, 2, 20);
}

/** 长篇目标字数的上限。 */
export function maxTargetCharsOf(settings: CreativeSettings): number {
  return clampInt(settings.maxTargetChars, 300000, 20000, 1000000);
}

/** 手上这一卷：最后一条还没收卷的就是它。 */
export function currentVolume(work: Work): Volume | null {
  const last = work.volumes[work.volumes.length - 1];
  return last && !last.summary.trim() ? last : null;
}

/** 已经收了卷的那些，新的在后。 */
export function closedVolumes(work: Work): Volume[] {
  return work.volumes.filter((volume) => volume.summary.trim().length > 0);
}

/**
 * 长篇续写要带的那一段"更早的事"：前面各卷各一行，本卷各章各一行。
 *
 * 写第 20 章时看不到第 3 章，靠的就是这两层摘要。卷的条数封顶，章的条数由
 * `chaptersPerVolume` 自然封顶——再加长也不会把上下文撑大。
 */
export function longFormContext(work: Work, maxVolumes = 8): string {
  const closed = closedVolumes(work);
  const open = currentVolume(work);
  const earlier = closed.slice(-maxVolumes);
  const lines: string[] = [];
  if (earlier.length) {
    lines.push('Earlier volumes:');
    for (const volume of earlier) lines.push(`- Vol.${volume.index}《${volume.title}》 ${volume.summary}`);
  }
  if (open && open.chapters.length) {
    lines.push(`This volume (Vol.${open.index}《${open.title}》) so far:`);
    for (const chapter of open.chapters) lines.push(`- Ch.${chapter.index} ${chapter.summary}`);
  }
  return lines.join('\n');
}

/** 整部作品写到第几章了（跨卷累加）。 */
export function chapterCountOf(work: Work): number {
  return work.volumes.reduce((total, volume) => total + volume.chapters.length, 0);
}

/** 下一卷的名字：立项时排过的就用它，没排过就按序号。 */
export function nextVolumeTitle(work: Work, index: number): string {
  const planned = work.volumePlan[index - 1];
  return planned?.title?.trim() || `第${index}卷`;
}
