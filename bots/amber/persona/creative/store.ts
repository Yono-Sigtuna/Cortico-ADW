/**
 * 作品书柜的落盘状态：写到哪、还剩多少、下一次什么时候。
 *
 * 正文不进这个文件——它在她自己的工作区里，是一个能读、能接着写的普通文本。
 * 这里只放"这轮该不该写"要用的机械事实，坏了可以重建。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  emptyBible,
  emptyState,
  nextMilestone,
  type Chapter,
  type CreativeRun,
  type CreativeState,
  type ShareOffer,
  type StoryBible,
  type Volume,
  type VolumePlan,
  type Work,
} from './models.ts';

export class CreativeStore {
  private readonly file: string | null;
  private readonly log: { warn(msg: string, data?: unknown): void } | null;
  private state: CreativeState;

  constructor(dataDir: string | null, day: string, log?: { warn(msg: string, data?: unknown): void }) {
    this.file = dataDir ? join(dataDir, 'creative.json') : null;
    this.log = log ?? null;
    this.state = this.load(day);
  }

  get current(): CreativeState {
    return this.state;
  }

  /** 每天第一次用到时滚动：额度归零，昨天的进度留着。 */
  tick(day: string): CreativeState {
    if (day !== this.state.day) {
      this.state.day = day;
      this.state.chunksToday = 0;
      this.state.sharesToday = 0;
    }
    return this.state;
  }

  works(): Work[] {
    return this.state.works;
  }

  work(id: string): Work | null {
    return this.state.works.find((item) => item.id === id) ?? null;
  }

  add(work: Work): void {
    this.state.works.push(work);
    this.state.works = this.state.works.slice(-20);
    this.save();
  }

  /** 把改动写回并落盘。传进来的是同一个对象引用时也成立。返回是否真的写下去了。 */
  update(work: Work): boolean {
    const at = this.state.works.findIndex((item) => item.id === work.id);
    if (at >= 0) this.state.works[at] = work;
    return this.save();
  }

  noteRun(run: CreativeRun): void {
    this.state.lastRun = run;
    this.save();
  }

  /** 有人接走了一次分享机会：记次，不再给第二次。 */
  consumeOffer(workId: string, milestone: ShareOffer['milestone']): void {
    const work = this.work(workId);
    if (!work) return;
    if (!work.disclosed.includes(milestone)) work.disclosed.push(milestone);
    work.pendingShare = null;
    this.state.sharesToday += 1;
    this.save();
  }

  /** 此刻手上待分享的那一份；没有就 null。只返回最该给的一条。 */
  offer(): ShareOffer | null {
    for (const work of [...this.state.works].reverse()) {
      if (work.pendingShare) return work.pendingShare;
    }
    return null;
  }

  /** 推进之后重新算一次节点，够格就挂起一个分享机会。 */
  refreshOffer(work: Work, snippet: string): ShareOffer | null {
    if (work.pendingShare) return work.pendingShare;
    const milestone = nextMilestone(work);
    if (!milestone) return null;
    const offer: ShareOffer = {
      workId: work.id,
      title: work.title,
      workType: work.workType,
      milestone,
      snippet,
      currentChars: work.currentChars,
      targetChars: work.targetChars,
      chunkCount: work.chunkCount,
    };
    work.pendingShare = offer;
    this.save();
    return offer;
  }

  save(): boolean {
    if (!this.file) return true;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      this.log?.warn('作品书柜写入失败', { error: String(err) });
      return false;
    }
  }

  private load(day: string): CreativeState {
    const fallback = emptyState(day);
    if (!this.file || !existsSync(this.file)) return fallback;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CreativeState>;
      if (raw.version !== 1 || !Array.isArray(raw.works)) return fallback;
      return {
        version: 1,
        day: typeof raw.day === 'string' ? raw.day : day,
        chunksToday: Number(raw.chunksToday ?? 0) || 0,
        sharesToday: Number(raw.sharesToday ?? 0) || 0,
        works: raw.works.filter(isWork).map(normalizeWork),
        lastRun: isRun(raw.lastRun) ? raw.lastRun : null,
      };
    } catch (err) {
      this.log?.warn('作品书柜读取失败，按空书柜继续', { error: String(err) });
      return fallback;
    }
  }
}

function isWork(value: unknown): value is Work {
  const w = value as Partial<Work>;
  return !!w && typeof w.id === 'string' && typeof w.title === 'string' && typeof w.file === 'string';
}

function isRun(value: unknown): value is CreativeRun {
  const r = value as Partial<CreativeRun>;
  return !!r && typeof r.at === 'number' && typeof r.ok === 'boolean' && typeof r.reason === 'string';
}

/** 老数据缺字段时补齐，不让一个空数组变成 `undefined.map`。 */
function normalizeWork(raw: Work): Work {
  const bible = (raw.bible ?? emptyBible()) as Partial<StoryBible>;
  const chunk = raw.pendingChunk;
  const pendingChunk = chunk && typeof chunk.text === 'string' && typeof chunk.at === 'number'
    ? { text: chunk.text, at: chunk.at }
    : undefined;
  const chapter = raw.pendingChapter;
  const pendingChapter = chapter
    && [chapter.start, chapter.end, chapter.at, chapter.failures, chapter.nextAttemptAt]
      .every((value) => typeof value === 'number' && Number.isFinite(value))
    ? {
        start: chapter.start,
        end: chapter.end,
        at: chapter.at,
        failures: chapter.failures,
        nextAttemptAt: chapter.nextAttemptAt,
      }
    : undefined;
  return {
    ...raw,
    pendingChunk,
    pendingChapter,
    status: raw.status === 'finished' ? 'finished' : 'drafting',
    bible: {
      mainline: String(bible.mainline ?? ''),
      themes: Array.isArray(bible.themes) ? bible.themes.filter(isText) : [],
      openThreads: Array.isArray(bible.openThreads) ? bible.openThreads.filter(isText) : [],
      facts: Array.isArray(bible.facts) ? bible.facts.filter(isText) : [],
      nextDirection: String(bible.nextDirection ?? ''),
      keywords: Array.isArray(bible.keywords) ? bible.keywords.filter(isText) : [],
      recentOutlines: Array.isArray(bible.recentOutlines) ? bible.recentOutlines.filter(isText) : [],
    },
    disclosed: Array.isArray(raw.disclosed) ? raw.disclosed : [],
    pendingShare: raw.pendingShare ?? null,
    failures: Number(raw.failures ?? 0) || 0,
    lastError: String(raw.lastError ?? ''),
    chunkCount: Number(raw.chunkCount ?? 0) || 0,
    currentChars: Number(raw.currentChars ?? 0) || 0,
    targetChars: Number(raw.targetChars ?? 0) || 0,
    // 长篇：老书柜里没有这几样，补齐成"短篇"。写了一半的长篇不会因此丢卷章。
    volumes: Array.isArray(raw.volumes)
      ? raw.volumes.filter(isVolume).map((volume) => ({
          index: Number(volume.index) || 0,
          title: String(volume.title ?? ''),
          summary: String(volume.summary ?? ''),
          chapters: (Array.isArray(volume.chapters) ? volume.chapters : [])
            .filter(isChapter)
            .map((chapter) => ({
              index: Number(chapter.index) || 0,
              summary: String(chapter.summary ?? ''),
              chars: Number(chapter.chars ?? 0) || 0,
              facts: Array.isArray(chapter.facts) ? chapter.facts.filter(isText) : [],
            })),
        }))
      : [],
    chapterStart: Number(raw.chapterStart ?? 0) || 0,
    volumePlan: Array.isArray(raw.volumePlan) ? raw.volumePlan.filter(isVolumePlan) : [],
  };
}

function isVolume(value: unknown): value is Volume {
  const volume = value as Partial<Volume>;
  return !!volume && typeof volume.index === 'number' && typeof volume.title === 'string';
}

function isChapter(value: unknown): value is Chapter {
  const chapter = value as Partial<Chapter>;
  return !!chapter && typeof chapter.index === 'number' && typeof chapter.summary === 'string';
}

function isVolumePlan(value: unknown): value is VolumePlan {
  const plan = value as Partial<VolumePlan>;
  return !!plan && typeof plan.title === 'string';
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
