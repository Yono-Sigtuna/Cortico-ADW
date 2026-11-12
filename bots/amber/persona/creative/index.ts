/**
 * 她自己的创作：没人叫她的时候，她会写点自己的东西。
 *
 * 这一层只决定"现在轮到写了吗"，以及一段写完怎么更新本子。发出去仍然只走主动层：
 * 写完的片段变成一个分享机会挂在那儿，由陪伴层看群里的情形决定要不要递给她。
 */
import type { Logger } from 'cortico/core/types.ts';

import {
  advanceDelayMs,
  applyExtract,
  chapterCharsOf,
  chapterCountOf,
  chaptersPerVolumeOf,
  chunkBudget,
  cleanChunk,
  currentVolume,
  emptyBible,
  keywordsOf,
  longFormContext,
  longFormOn,
  maturity,
  maxTargetCharsOf,
  nextVolumeTitle,
  pickScale,
  repeatsEarlier,
  retryDelayMs,
  SCALE_BANDS,
  type CreativeRun,
  type CreativeSettings,
  type Extract,
  type ShareOffer,
  type Volume,
  type VolumePlan,
  type Work,
} from './models.ts';
import { CreativeStore } from './store.ts';
import {
  chapterSummaryPrompt,
  chunkPrompt,
  parseJsonObject,
  projectPrompt,
  reviewPrompt,
  volumeSummaryPrompt,
  type CreativeBrief,
} from './prompt.ts';

/** 创作线程的 session id：一个没有工具的 fork，只用来生成文字。 */
export const CREATIVE = 'creative';

/** 审稿的最低分：三项都过线才算这一段站得住。 */
const REVIEW_MIN_SCORE = 7;/** 一段最多重写几版（含第一版）。 */
const MAX_ATTEMPTS = 2;
/** 本子里留几段大纲，用来避开重复的套路。 */
const OUTLINE_KEEP = 6;

export interface CreativeDeps {
  dataDir: string | null;
  timezone: string;
  /** 热配置：WebUI 改了下一轮就生效。 */
  settings: () => CreativeSettings;
  /** 她此刻在过什么样的日子；没有生活状态时给空串。 */
  living: () => string;
  /** 她自己写下的当前自述（`memo/self.md`）。 */
  self: () => string;
  /** 群里最近说过的话：她要是问过"想看长的还是短的"，答案就在这儿。 */
  recent?: () => string;
  /** 精力 0–1：写不动的那会儿就少写。 */
  energy: () => number;
  /** 现在能不能动笔；能就 null，不能就返回一句原因（安静时段、睡着）。 */
  blockedAt: (now: number) => string | null;
  /** 这一次想写点什么；没有灵感时 null。 */
  inspiration: () => { label: string; text: string } | null;
  /** 一次模型调用，返回正文。用 fork 走，不占主会话的上下文。 */
  generate: (prompt: string) => Promise<string>;
  /** 工作区正文的读写。 */
  read: (relPath: string) => string | null;
  write: (relPath: string, text: string) => void;
  /** 带版本的读；给了它才做条件写，读取到生成之间别人改过正文就不会被旧全文盖掉。 */
  readForUpdate?: (relPath: string) => { text: string; revision: string } | null;
  /** 条件写：版本没变才落盘。返回 false 表示期间被改过。 */
  writeIfUnchanged?: (relPath: string, text: string, base: string | null) => boolean;
  /** 列一层目录下的文件名（不带路径）。她可能自己把正文改了名，靠它跟上。 */
  list?: (dir: string) => string[];
  /** 本地日期键 `YYYY-MM-DD`。 */
  day: (now: number) => string;
  log: Logger;
  now?: () => number;
  /** 多久看一眼该不该写。默认 10 分钟。 */
  intervalMs?: number;
}

export class Creative {
  private readonly store: CreativeStore;
  private readonly d: CreativeDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** 上一次立项调用失败的时刻：模型调不通时不要每十分钟重开一次。 */
  private startFailedAt: number | null = null;

  constructor(d: CreativeDeps) {
    this.d = d;
    this.store = new CreativeStore(d.dataDir, d.day(this.now()), d.log);
  }

  start(): void {
    if (this.timer) return;
    const every = Math.max(60_000, this.d.intervalMs ?? 10 * 60_000);
    this.timer = setInterval(() => {
      void this.step().catch((err) => this.d.log.warn('创作推进失败', { err: String(err) }));
    }, every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store.save();
  }

  /** 面板与排障用。 */
  snapshot(): { settings: CreativeSettings; works: Work[]; chunksToday: number; sharesToday: number; lastRun: CreativeRun | null } {
    return {
      settings: this.d.settings(),
      works: this.store.works(),
      chunksToday: this.store.current.chunksToday,
      sharesToday: this.store.current.sharesToday,
      lastRun: this.store.current.lastRun,
    };
  }

  /** 此刻挂着的分享机会；关掉分享、或者今天给够了就没有。 */
  offer(): ShareOffer | null {
    const settings = this.d.settings();
    if (!settings.shareEnabled) return null;
    if (this.store.current.sharesToday >= settings.shareDailyCap) return null;
    return this.store.offer();
  }

  /** 主动层把它用了。 */
  consume(offer: ShareOffer): void {
    this.store.consumeOffer(offer.workId, offer.milestone);
    this.d.log.info('创作分享给出去了', { work: offer.workId, milestone: offer.milestone });
  }

  /** 现在为什么不动笔；能动笔且有活儿时 null。只读。 */
  gate(at = this.now()): string | null {
    const settings = this.d.settings();
    if (!settings.enabled) return '创作关着';
    this.store.tick(this.d.day(at));
    if (this.store.current.chunksToday >= settings.maxChunksPerDay) {
      return `今天已经写了 ${this.store.current.chunksToday}/${settings.maxChunksPerDay} 段`;
    }
    const blocked = this.d.blockedAt(at);
    if (blocked) return blocked;
    const due = this.store.works().filter((work) => work.status === 'drafting' && work.nextAdvanceAt <= at);
    if (due.length === 0 && !this.canStart(at)) return '手上没有该续写的作品，也没有新念头';
    return null;
  }

  /**
   * 看一眼该不该写；写了就返回这一段的结果。
   *
   * 同一时刻只跑一次：模型调用是慢的，重叠两轮会把同一段写两遍。
   */
  async step(at = this.now()): Promise<CreativeRun | null> {
    if (this.busy) return null;
    const settings = this.d.settings();
    this.store.tick(this.d.day(at));
    if (settings.enabled) {
      // 上一次段落的账没结完（进程中途退出）：先按正文核对，再决定这一轮做什么。
      const unaccounted = this.store.works().find((work) => work.pendingChunk);
      if (unaccounted) this.reconcilePendingChunk(unaccounted, this.d.read(unaccounted.file) ?? '', settings);
      // 收章摘要的待办独立于写作：作品已完结、额度用完，也照样补。
      const pendingChapter = this.store.works()
        .find((work) => work.pendingChapter && work.pendingChapter.nextAttemptAt <= at);
      if (pendingChapter) return await this.closePendingChapter(pendingChapter, at, settings);
    }
    const blocked = this.gate(at);
    if (blocked) {
      // 开关关掉时不记流水：那不是一次尝试。
      if (settings.enabled) this.record(at, false, blocked, null, 0, 0);
      return null;
    }
    this.busy = true;
    const started = this.now();
    try {
      const due = this.store.works().filter((work) => work.status === 'drafting' && work.nextAdvanceAt <= at);
      if (due.length > 0) return await this.advance(due[0], started);
      if (this.canStart(at)) return await this.begin(started);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** 手上空着、离上一部开张够久、而且真有个想写的由头。 */
  private canStart(now: number): boolean {
    const settings = this.d.settings();
    const drafting = this.store.works().filter((work) => work.status === 'drafting');
    if (drafting.length >= Math.max(1, settings.maxActiveWorks)) return false;
    const latest = this.store.works().reduce((last, work) => Math.max(last, work.createdAt), 0);
    if (latest > 0 && now - latest < 6 * 3_600_000) return false;
    if (this.startFailedAt !== null && now - this.startFailedAt < 60 * 60_000) return false;
    return this.d.inspiration() !== null;
  }

  /** 开一部新的。 */
  private async begin(at: number): Promise<CreativeRun | null> {
    const source = this.d.inspiration();
    if (!source) return null;
    const settings = this.d.settings();
    const allowLong = longFormOn(settings);
    const brief = this.brief();
    let raw: string;
    try {
      raw = await this.d.generate(projectPrompt({
        brief,
        inspiration: source.text,
        sourceLabel: source.label,
        allowLong,
        maxTarget: maxTargetCharsOf(settings),
      }));
    } catch (err) {
      // 模型这一阵调不通：记下来，一小时内不再试，免得每十分钟重开一次。
      this.startFailedAt = at;
      this.d.log.warn('立项调用失败', { err: String(err) });
      return this.record(at, false, `立项调用失败：${clipError(err)}`, null, 0, this.now() - at);
    }
    const payload = parseJsonObject(raw);
    if (!payload) {
      return this.record(at, false, '立项没有拿到可用的结果', null, 0, this.now() - at);
    }
    const title = text(payload.title, 24) || '无名';
    const id = idOf(at, title);
    // 写多大是她自己定的：她说的档位为准，认不出来才按字数推。
    const scale = pickScale(payload.scale, Number(payload.target_chars), allowLong);
    const [scaleMin, scaleMax] = SCALE_BANDS[scale];
    const upper = scale === '长' ? Math.min(scaleMax, maxTargetCharsOf(settings)) : scaleMax;
    const targetChars = clampInt(payload.target_chars, Math.round((scaleMin + upper) / 2), scaleMin, upper);
    // 同名不覆盖：那是她自己写过的东西，不是缓存。
    const base = `创作/${safeName(title)}.md`;
    const file = this.d.read(base) === null ? base : `创作/${safeName(title)}-${id.slice(-4)}.md`;
    const work: Work = {
      id,
      title,
      workType: text(payload.work_type, 30) || '短篇小说',
      premise: text(payload.premise, 140) || source.text.slice(0, 140),
      tone: text(payload.tone, 40),
      pointOfView: text(payload.point_of_view, 30) || '第三人称有限视角',
      targetChars,
      currentChars: 0,
      status: 'drafting',
      file,
      sourceLabel: source.label,
      sourceText: source.text.slice(0, 200),
      bible: { ...emptyBible(), mainline: text(payload.premise, 140), nextDirection: text(payload.next_direction, 140) },
      chunkCount: 0,
      nextAdvanceAt: at,
      createdAt: at,
      lastAdvancedAt: 0,
      failures: 0,
      lastError: '',
      disclosed: [],
      pendingShare: null,
      volumes: [],
      chapterStart: 0,
      volumePlan: scale === '短' ? [] : toVolumePlan(payload.volumes),
      scale,
    };
    this.store.add(work);
    this.d.log.info('开了一部作品', { title: work.title, workType: work.workType, scale, chars: work.targetChars });
    // 立项之后紧接着写第一段：光有设定不叫写了东西。
    return await this.advance(work, at);
  }

  /** 续写一段：大纲 → 正文 → 自审（不过就重写） → 更新本子。 */
  private async advance(work: Work, at: number): Promise<CreativeRun | null> {
    const started = this.now();
    const settings = this.d.settings();
    // 收章是长篇的事：她自己选了短，就算长篇这一档开着也不收。
    const long = longFormOn(settings) && (work.scale ?? '短') !== '短';
    const budget = chunkBudget(settings, this.d.energy());
    const remaining = Math.max(0, work.targetChars - work.currentChars);
    if (remaining <= 0) {
      work.status = 'finished';
      work.nextAdvanceAt = Number.MAX_SAFE_INTEGER;
      this.store.update(work);
      return this.record(at, true, '这一部写完了', work, 0, this.now() - started);
    }
    let snapshot = this.d.readForUpdate?.(work.file) ?? null;
    let body = snapshot ? snapshot.text : (this.d.read(work.file) ?? '');
    if (!body) {
      // 她可能自己把正文改了名：跟上去，别把前面写的当成空白重来一遍。
      this.adoptRenamedFile(work);
      snapshot = this.d.readForUpdate?.(work.file) ?? null;
      body = snapshot ? snapshot.text : (this.d.read(work.file) ?? '');
    }
    const paragraphs = splitParagraphs(body);
    const recent = paragraphs.slice(-3).join('\n\n').slice(-900);
    const brief = this.brief();

    let accepted: { text: string } | null = null;
    let verdict: Record<string, unknown> | null = null;
    try {
      let notice = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const drafted = cleanChunk(await this.d.generate(chunkPrompt({
          work,
          brief,
          recent,
          budget: Math.min(budget, remaining),
          remaining,
          notice,
          longContext: long ? longFormContext(work) : '',
        })), budget);
        if (!drafted) {
          notice = 'The last attempt came back empty. Write the actual prose this time.';
          continue;
        }
        if (repeatsEarlier(drafted, paragraphs.slice(-12))) {
          notice = 'This is nearly the same as an earlier stretch. Change the imagery, the sentence shape and what actually happens.';
          continue;
        }
        const review = parseJsonObject(await this.d.generate(reviewPrompt({ work, text: drafted, recent })));
        if (!review) {
          // 审稿没给出可用结果：不因为一次格式错误就把写好的丢掉。
          accepted = { text: drafted };
          break;
        }
        if (review.passed !== false && scoresOk(review)) {
          accepted = { text: drafted };
          verdict = review;
          break;
        }
        notice = rewriteNotice(review);
      }
    } catch (err) {
      return this.fail(work, at, started, `调用失败：${clipError(err)}`, 0);
    }
    if (!accepted) {
      return this.fail(work, at, started, '写出来的几版都没站住', 0);
    }

    // 先记下"这一段要写进去"，再动正文：中途退出时下次据此核对，不重复写。
    work.pendingChunk = { text: accepted.text, at };
    if (!this.store.update(work)) {
      work.pendingChunk = undefined;
      return this.fail(work, at, started, '书柜写入失败，这一段没有落进正文', 0);
    }
    const merged = this.commitChunk(work.file, body, snapshot?.revision ?? null, accepted.text);
    if (merged === null) {
      work.pendingChunk = undefined;
      this.store.update(work);
      return this.fail(work, at, started, '正文在生成期间被改动；重读后仍没能安全合并', 0);
    }
    work.currentChars += accepted.text.length;
    work.chunkCount += 1;
    work.lastAdvancedAt = at;
    work.failures = 0;
    work.lastError = '';
    work.nextAdvanceAt = at + advanceDelayMs(settings, work.id);
    if (work.currentChars >= work.targetChars) {
      work.status = 'finished';
      work.nextAdvanceAt = Number.MAX_SAFE_INTEGER;
    }
    work.pendingChunk = undefined;
    this.store.current.chunksToday += 1;
    if (!this.store.update(work)) {
      // 正文已经写进去了，账没落盘：把待办留在内存里，下一次按正文补账，不谎报成功。
      work.pendingChunk = { text: accepted.text, at };
      return this.fail(work, at, started, '正文已写，书柜没保存；下次按正文补账', 0);
    }

    // 长篇：到量就收章。摘要调用失败只丢这一次摘要，正文与进度已经落盘。
    if (long) {
      try {
        await this.maybeCloseChapter(work, merged, settings);
      } catch (err) {
        this.d.log.warn('收章失败，下一次再收', { title: work.title, err: clipError(err) });
      }
    }

    // 本子跟着那次审稿一起回来。它缺席（审稿没给出 JSON）只丢这一次的记录，正文照留。
    if (verdict) {
      work.bible = applyExtract(work.bible, toExtract(verdict));
      const move = text(verdict.this_stretch, 40);
      if (move) {
        work.bible = {
          ...work.bible,
          recentOutlines: [...work.bible.recentOutlines, `- ${move}`].slice(-OUTLINE_KEEP),
        };
      }
      this.store.update(work);
    }
    this.store.refreshOffer(work, accepted.text.slice(-260));
    this.d.log.info('写了一段', {
      title: work.title,
      chars: accepted.text.length,
      total: `${work.currentChars}/${work.targetChars}`,
      maturity: Math.round(maturity(work)),
      next: Math.round((work.nextAdvanceAt - at) / 60_000),
    });
    return this.record(at, true, `写了 ${accepted.text.length} 字`, work, accepted.text.length, this.now() - started);
  }

  /**
   * 她把正文改了名：跟着新名字走。
   *
   * 作品记录里存的是立项时那个文件名。她自己用文件工具改了名，记录就指向一个不存在的路径——
   * 下一段会当成空白重写，前面几万字成了孤儿。只在"已经写过东西、且创作目录里只有一个
   * 没被别的作品占着的 .md、而且它确实装着差不多份量的正文"时才认。
   */
  private adoptRenamedFile(work: Work): void {
    if (!work.currentChars) return;
    const names = this.d.list?.('创作') ?? [];
    const claimed = new Set(this.store.works().filter((item) => item.id !== work.id).map((item) => item.file));
    const free = names
      .filter((name) => name.endsWith('.md'))
      .map((name) => `创作/${name}`)
      .filter((rel) => !claimed.has(rel));
    if (free.length !== 1) return;
    const adopted = free[0];
    const text = this.d.read(adopted) ?? '';
    if (text.trim().length < Math.max(200, work.currentChars * 0.5)) return;
    const previous = work.file;
    work.file = adopted;
    const base = adopted.split('/').pop()?.replace(/\.md$/, '') ?? '';
    if (base) work.title = base.slice(0, 24);
    this.store.update(work);
    this.d.log.info('正文被改名了，跟着走', { from: previous, to: adopted, title: work.title });
  }

  /**
   * 一章写够了：留一句摘要，够一卷就收卷。
   *
   * 这是长篇唯一撑得住的理由——写到第三十章时，前面二十九章只剩这些句子。
   * 写满一章才收；收尾那一章不论长短都收。
   */
  /**
   * 上次写正文前留下的段落账：正文末尾有这段，就说明写成了，补记字数与进度；
   * 没有就当那次没写成，丢掉待办。返回是否补记成功。
   */
  private reconcilePendingChunk(work: Work, body: string, settings: CreativeSettings): boolean {
    const pending = work.pendingChunk;
    if (!pending) return false;
    const done = body.trimEnd().endsWith(pending.text.trimEnd());
    if (done) {
      work.currentChars += pending.text.length;
      work.chunkCount += 1;
      work.lastAdvancedAt = pending.at;
      work.failures = 0;
      work.lastError = '';
      work.nextAdvanceAt = pending.at + advanceDelayMs(settings, work.id);
      if (work.currentChars >= work.targetChars) {
        work.status = 'finished';
        work.nextAdvanceAt = Number.MAX_SAFE_INTEGER;
      }
      const long = longFormOn(settings) && (work.scale ?? '短') !== '短';
      if (long && work.status === 'finished') {
        work.pendingChapter = {
          start: work.chapterStart,
          end: body.length,
          at: pending.at,
          failures: 0,
          nextAttemptAt: this.now(),
        };
      }
    }
    work.pendingChunk = undefined;
    this.store.update(work);
    this.d.log.info(done ? '补记了上次写成的段落' : '上次段落没写进正文，待办作废', { title: work.title });
    return done;
  }

  /** 补一章迟到的摘要；作品已完结也走这里。 */
  private async closePendingChapter(work: Work, at: number, settings: CreativeSettings): Promise<CreativeRun> {
    const started = this.now();
    const pending = work.pendingChapter!;
    const body = this.d.read(work.file) ?? '';
    const end = Math.min(pending.end, body.length);
    const chapterText = body.slice(pending.start, end).trim();
    const index = chapterCountOf(work) + 1;
    if (chapterText.length < 60) {
      work.pendingChapter = undefined;
      this.store.update(work);
      return this.record(at, true, '待收的那一截不够成章，作罢', work, 0, this.now() - started);
    }
    let summary = '';
    let facts: string[] = [];
    try {
      const payload = parseJsonObject(await this.d.generate(chapterSummaryPrompt({
        work,
        index,
        text: chapterText.slice(-Math.max(2000, chapterCharsOf(settings) * 2)),
      })));
      summary = text(payload?.summary, 160);
      facts = Array.isArray(payload?.facts)
        ? payload.facts.map((item) => text(item, 60)).filter(Boolean).slice(0, 3)
        : [];
    } catch (err) {
      this.d.log.warn('补收章摘要失败', { title: work.title, index, err: clipError(err) });
    }
    if (!summary) {
      const failures = pending.failures + 1;
      work.pendingChapter = { ...pending, failures, nextAttemptAt: at + retryDelayMs(failures) };
      this.store.update(work);
      return this.record(at, false, '收章摘要还没拿到', work, 0, this.now() - started);
    }
    await this.applyChapter(work, end, chapterText, index, summary, facts, settings);
    return this.record(at, true, `补收了第 ${index} 章的摘要`, work, 0, this.now() - started);
  }

  /** 把一章写进卷里；当场收章与补收章共用。 */
  private async applyChapter(
    work: Work,
    end: number,
    chapterText: string,
    index: number,
    summary: string,
    facts: string[],
    settings: CreativeSettings,
  ): Promise<void> {
    let volume = currentVolume(work);
    if (!volume) {
      const volumeIndex = work.volumes.length + 1;
      volume = { index: volumeIndex, title: nextVolumeTitle(work, volumeIndex), summary: '', chapters: [] };
      work.volumes.push(volume);
    }
    volume.chapters.push({ index, summary, chars: chapterText.length, facts });
    work.chapterStart = end;
    if (facts.length) {
      const merged = [...work.bible.facts, ...facts.filter((fact) => !work.bible.facts.includes(fact))];
      work.bible = { ...work.bible, facts: merged.slice(-12) };
    }
    work.pendingChapter = undefined;
    this.store.update(work);
    this.d.log.info('收了一章', {
      title: work.title,
      chapter: index,
      volume: volume.index,
      chars: chapterText.length,
    });

    // 攒够一卷就收；整部写完时最后一卷哪怕没攒够也收掉，不然它永远没有整卷摘要。
    if (volume.chapters.length >= chaptersPerVolumeOf(settings) || work.status === 'finished') {
      await this.closeVolume(work, volume);
    }
  }

  private async maybeCloseChapter(work: Work, body: string, settings: CreativeSettings): Promise<void> {
    if (work.pendingChapter) return;
    const grown = body.length - work.chapterStart;
    const ending = work.status === 'finished';
    if (!ending && grown < chapterCharsOf(settings)) return;
    const chapterText = body.slice(work.chapterStart).trim();
    // 收尾那一小截也要留摘要；只是短到不足 60 字就没必要了。
    if (chapterText.length < (ending ? 60 : 200)) return;

    const index = chapterCountOf(work) + 1;
    let summary = '';
    let facts: string[] = [];
    try {
      const payload = parseJsonObject(await this.d.generate(chapterSummaryPrompt({
        work,
        index,
        // 一章最多一万多字；全给模型也只是一次短调用。
        text: chapterText.slice(-Math.max(2000, chapterCharsOf(settings) * 2)),
      })));
      summary = text(payload?.summary, 160);
      facts = Array.isArray(payload?.facts)
        ? payload.facts.map((item) => text(item, 60)).filter(Boolean).slice(0, 3)
        : [];
    } catch (err) {
      this.d.log.warn('收章摘要调用失败', { title: work.title, index, err: clipError(err) });
    }
    // 摘要没写成就不收这一章：留着下一次再压，总比往上下文里塞一句垃圾强。
    // 但一章不能无限长——超过三倍篇幅还没压下来，就用最后 80 字兜底收掉。
    // 那一章的范围先存下来：哪怕作品已经完结，以后也能按这个区间补摘要。
    if (!summary) {
      if (grown <= chapterCharsOf(settings) * 3) {
        work.pendingChapter = {
          start: work.chapterStart,
          end: body.length,
          at: this.now(),
          failures: 0,
          nextAttemptAt: this.now() + retryDelayMs(1),
        };
        this.store.update(work);
        this.d.log.warn('收章没有拿到摘要，记成待办', { title: work.title, index, grown });
        return;
      }
      summary = chapterText.slice(-80);
    }

    await this.applyChapter(work, body.length, chapterText, index, summary, facts, settings);
  }

  /** 收一卷：几章压成一段更远的记忆。失败就用章摘要拼一个。 */
  private async closeVolume(work: Work, volume: Volume): Promise<void> {
    let summary = '';
    try {
      const payload = parseJsonObject(await this.d.generate(volumeSummaryPrompt({ work, volume })));
      summary = text(payload?.summary, 300);
    } catch (err) {
      this.d.log.warn('收卷摘要调用失败', { title: work.title, volume: volume.index, err: clipError(err) });
    }
    if (!summary) summary = volume.chapters.map((chapter) => chapter.summary).join(' ').slice(-300);
    volume.summary = summary;
    this.store.update(work);
    this.d.log.info('收了一卷', { title: work.title, volume: volume.index, chapters: volume.chapters.length });
  }

  /**
   * 把新段接到正文后面再落盘。
   *
   * 读和写之间隔着模型调用；有版本号就做条件写，被改过就重读、把新段接到最新正文后，
   * 不拿生成前那份旧全文覆盖她手动补的内容。冲突后文件消失（被改名或删掉）时不重建旧路径。
   */
  private commitChunk(file: string, baseBody: string, baseRevision: string | null, chunk: string): string | null {
    const merge = (body: string): string => body.trim() ? `${body.trimEnd()}\n\n${chunk}` : chunk;
    const write = (body: string): string => {
      const merged = merge(body);
      this.d.write(file, `${merged}\n`);
      return merged;
    };
    if (!this.d.writeIfUnchanged) return write(baseBody);
    let body = baseBody;
    let revision = baseRevision;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const merged = merge(body);
      if (this.d.writeIfUnchanged(file, `${merged}\n`, revision)) return merged;
      const fresh = this.d.readForUpdate?.(file) ?? null;
      if (!fresh) return null;
      body = fresh.text;
      revision = fresh.revision;
    }
    return null;
  }

  private fail(work: Work, at: number, started: number, reason: string, chars: number): CreativeRun {
    work.failures += 1;
    work.lastError = reason;
    work.nextAdvanceAt = at + retryDelayMs(work.failures);
    this.store.update(work);
    this.d.log.warn('这一段没写成', { title: work.title, reason, failures: work.failures });
    return this.record(at, false, reason, work, chars, this.now() - started);
  }

  private record(at: number, ok: boolean, reason: string, work: Work | null, chars: number, ms: number): CreativeRun {
    const run: CreativeRun = { at, ok, reason, workId: work?.id ?? null, chars, ms };
    this.store.noteRun(run);
    return run;
  }

  private brief(): CreativeBrief {
    return {
      living: this.d.living(),
      self: this.d.self(),
      direction: this.d.settings().direction,
      recent: this.d.recent?.() ?? '',
    };
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
}

/** 一部作品的分享机会在不在，决定主动层要不要多一个话头。 */
export function offerOf(creative: Creative | null): ShareOffer | null {
  return creative?.offer() ?? null;
}

function splitParagraphs(body: string): string[] {
  return body.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
}

function clipError(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').slice(0, 120);
}

function scoresOk(review: Record<string, unknown>): boolean {
  const pick = (key: string): number => {
    const value = Number(review[key]);
    return Number.isFinite(value) ? value : REVIEW_MIN_SCORE;
  };
  return pick('persona_score') >= REVIEW_MIN_SCORE
    && pick('progress_score') >= REVIEW_MIN_SCORE
    && pick('repetition_score') >= REVIEW_MIN_SCORE;
}

function rewriteNotice(review: Record<string, unknown>): string {
  const notes: string[] = [];
  const focus = text(review.rewrite, 140);
  if (focus) notes.push(focus);
  const issues = Array.isArray(review.issues) ? review.issues.filter((item) => typeof item === 'string').slice(0, 2) : [];
  if (issues.length) notes.push(`要改的地方：${issues.join('；')}`);
  return notes.length ? `The draft did not hold. ${notes.join(' ')}` : 'The draft did not hold. Rewrite this stretch with a different approach.';
}

/** 立项时排的卷目：最多六卷，每卷一行标题加一句要推进到哪。 */
function toVolumePlan(value: unknown): VolumePlan[] {
  if (!Array.isArray(value)) return [];
  const out: VolumePlan[] = [];
  for (const item of value) {
    const entry = item as { title?: unknown; premise?: unknown } | null;
    const title = text(entry?.title, 24);
    if (!title) continue;
    out.push({ title, premise: text(entry?.premise, 80) });
    if (out.length >= 6) break;
  }
  return out;
}

function toExtract(payload: Record<string, unknown>): Extract {  const list = (value: unknown, size: number, width: number): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      const line = text(item, width);
      if (line && !out.includes(line)) out.push(line);
      if (out.length >= size) break;
    }
    return out;
  };
  return {
    mainline: text(payload.mainline_direction, 140),
    themes: list(payload.themes_used, 3, 20),
    advanced: list(payload.threads_advanced, 2, 40),
    resolved: list(payload.threads_resolved, 1, 40),
    fresh: list(payload.new_threads, 2, 40),
    facts: list(payload.important_facts, 3, 60),
    keywords: list(payload.keywords, 6, 16),
    nextDirection: text(payload.next_direction, 140),
  };
}

function text(value: unknown, limit: number): string {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) : flat;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function idOf(at: number, title: string): string {
  const words = keywordsOf(title, 2).join('');
  return `${at.toString(36)}${words ? `-${words.slice(0, 8)}` : ''}`;
}

/** 文件名不能带路径分隔符和 Windows 保留字符。 */
function safeName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\r\n\t]/g, '').trim();
  return (cleaned || '未命名').slice(0, 40);
}
