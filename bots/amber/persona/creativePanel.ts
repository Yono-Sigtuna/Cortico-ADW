/**
 * 作品页的数据面：她手上在写什么、写到哪、为什么这会儿没写。
 *
 * 只读。正文直接读工作区里那个文件——面板看到的就是她明天会读到的那份。
 */
import { maturity, type CreativeRun, type CreativeSettings, type StoryBible, type Work } from './creative/models.ts';
import type { Creative } from './creative/index.ts';

export interface CreativeBibleView {
  mainline: string;
  themes: string[];
  openThreads: string[];
  facts: string[];
  nextDirection: string;
}

export interface CreativeChapterView {
  index: number;
  summary: string;
  chars: number;
}

export interface CreativeVolumeView {
  index: number;
  title: string;
  /** 空 = 这一卷还没收。 */
  summary: string;
  chapters: CreativeChapterView[];
}

export interface CreativeWorkRow {
  id: string;
  title: string;
  workType: string;
  premise: string;
  tone: string;
  status: 'drafting' | 'finished';
  file: string;
  currentChars: number;
  targetChars: number;
  chunkCount: number;
  maturity: number;
  createdAt: number;
  lastAdvancedAt: number;
  /** 下一次轮到它；写完的没有下一次。 */
  nextAdvanceAt: number | null;
  /** 长篇的卷章；短篇是空数组。 */
  volumes: CreativeVolumeView[];
  /** 立项时她自己定的规模：短 / 中 / 长。 */
  scale: string;
  failures: number;
  lastError: string;
  disclosed: string[];
  pendingShare: string | null;
  sourceLabel: string;
  sourceText: string;
  bible: CreativeBibleView;
}

export interface CreativeStateView {
  enabled: boolean;
  settings: CreativeSettings;
  chunksToday: number;
  sharesToday: number;
  /** 现在为什么不动笔；能动笔时 null。 */
  gate: string | null;
  lastRun: CreativeRun | null;
  works: CreativeWorkRow[];
}

export function creativeState(creative: Creative | null): CreativeStateView | null {
  if (!creative) return null;
  const snap = creative.snapshot();
  return {
    enabled: snap.settings.enabled,
    settings: snap.settings,
    chunksToday: snap.chunksToday,
    sharesToday: snap.sharesToday,
    gate: creative.gate(),
    lastRun: snap.lastRun,
    works: snap.works.map(workRow),
  };
}

/** 一部作品的正文；不存在时返回 null。 */
export function creativeText(creative: Creative | null, read: (relPath: string) => string | null, id: string): { work: CreativeWorkRow; text: string } | null {
  if (!creative) return null;
  const work = creative.snapshot().works.find((item) => item.id === id);
  if (!work) return null;
  return { work: workRow(work), text: read(work.file) ?? '' };
}

function workRow(work: Work): CreativeWorkRow {
  return {
    id: work.id,
    title: work.title,
    workType: work.workType,
    premise: work.premise,
    tone: work.tone,
    status: work.status,
    file: work.file,
    currentChars: work.currentChars,
    targetChars: work.targetChars,
    chunkCount: work.chunkCount,
    maturity: Math.round(maturity(work)),
    createdAt: work.createdAt,
    lastAdvancedAt: work.lastAdvancedAt,
    nextAdvanceAt: Number.isFinite(work.nextAdvanceAt) ? work.nextAdvanceAt : null,
    scale: work.scale ?? '',
    volumes: (work.volumes ?? []).map((volume) => ({
      index: volume.index,
      title: volume.title,
      summary: volume.summary,
      chapters: (volume.chapters ?? []).map((chapter) => ({
        index: chapter.index,
        summary: chapter.summary,
        chars: chapter.chars,
      })),
    })),
    failures: work.failures,
    lastError: work.lastError,
    disclosed: work.disclosed,
    pendingShare: work.pendingShare ? work.pendingShare.milestone : null,
    sourceLabel: work.sourceLabel,
    sourceText: work.sourceText,
    bible: bibleView(work.bible),
  };
}

function bibleView(bible: StoryBible): CreativeBibleView {
  return {
    mainline: bible.mainline,
    themes: bible.themes,
    openThreads: bible.openThreads,
    facts: bible.facts,
    nextDirection: bible.nextDirection,
  };
}
