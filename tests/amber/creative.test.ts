/** 她自己的创作：书柜、本子、一次续写的来路与退路。 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  longFormContext,
  maturity,
  maxTargetCharsOf,
  nextMilestone,
  pickScale,
  repeatsEarlier,
  retryDelayMs,
  textSimilarity,
  type CreativeSettings,
  type Volume,
  type Work,
} from '../../bots/amber/persona/creative/models.ts';
import { CreativeStore } from '../../bots/amber/persona/creative/store.ts';
import { Creative, type CreativeDeps } from '../../bots/amber/persona/creative/index.ts';
import { parseJsonObject } from '../../bots/amber/persona/creative/prompt.ts';
import { planOnce, type ScheduleInput } from '../../bots/amber/persona/companion/scheduler.ts';
import { pickInspiration } from '../../bots/amber/persona/creative/inspiration.ts';
import { emptyConv, emptyState, type CompanionSettings } from '../../bots/amber/persona/companion/state.ts';
import { makeTmpDir } from '../core/helpers.ts';

const DAY = '2026-10-25';
const T = Date.parse('2026-10-25T06:00:00Z');

const settings = (patch: Partial<CreativeSettings> = {}): CreativeSettings => ({
  enabled: true,
  chunkChars: 220,
  maxActiveWorks: 1,
  advanceMinutes: [95, 320],
  maxChunksPerDay: 6,
  shareEnabled: true,
  shareDailyCap: 1,
  direction: '',
  ...patch,
});

function work(patch: Partial<Work> = {}): Work {
  return {
    id: 'w1',
    title: '窗边的雨',
    workType: '短篇小说',
    premise: '一个人等一场不会停的雨',
    tone: '安静',
    pointOfView: '第三人称有限视角',
    targetChars: 900,
    currentChars: 0,
    status: 'drafting',
    file: '创作/窗边的雨.md',
    sourceLabel: '昨晚的梦',
    sourceText: '梦里在下雨',
    bible: emptyBible(),
    chunkCount: 0,
    nextAdvanceAt: T,
    createdAt: T,
    lastAdvancedAt: 0,
    failures: 0,
    lastError: '',
    disclosed: [],
    pendingShare: null,
    volumes: [],
    chapterStart: 0,
    volumePlan: [],
    ...patch,
  };
}

/** 一段像样的正文：长度够、和二元的重复度低。 */
const prose = (seed: string, length = 200): string => {
  const bits = ['雨落在窗沿上', '她把杯子往里面挪了挪', '楼下的灯一盏一盏灭', '风把纸页翻开又合上', '他终于开口说了一句', '走廊尽头有人咳嗽'];
  return Array.from({ length: Math.ceil(length / 9) }, (_, i) => `${bits[(i + seed.length) % bits.length]}${seed.slice(i % seed.length, (i % seed.length) + 1)}`).join('，') + '。';
};

function makeCreative(
  script: string[],
  overrides: Partial<CreativeDeps> = {},
  seed: Work[] = [],
): { creative: Creative; dir: string; prompts: string[]; files: Map<string, string>; clock: { now: number } } {
  const dir = makeTmpDir().dir;
  const prompts: string[] = [];
  const files = new Map<string, string>();
  const clock = { now: T };
  const queue = [...script];
  if (seed.length) {
    writeFileSync(join(dir, 'creative.json'), JSON.stringify({
      version: 1, day: DAY, chunksToday: 0, sharesToday: 0, works: seed, lastRun: null,
    }), 'utf8');
  }
  const deps: CreativeDeps = {
    dataDir: dir,
    timezone: 'Asia/Shanghai',
    settings: () => settings(),
    living: () => '在窗边看书',
    self: () => '最近在读一本讲雨的书',
    energy: () => 0.7,
    blockedAt: () => null,
    inspiration: () => ({ label: '昨晚的梦', text: '梦里在下雨' }),
    generate: async (prompt: string) => {
      prompts.push(prompt);
      return queue.shift() ?? '';
    },
    read: (rel) => files.get(rel) ?? null,
    write: (rel, text) => { files.set(rel, text); },
    readForUpdate: (rel) => {
      const text = files.get(rel);
      return text === undefined ? null : { text, revision: `${text.length}:${text}` };
    },
    writeIfUnchanged: (rel, text, base) => {
      const current = files.get(rel);
      const revision = current === undefined ? null : `${current.length}:${current}`;
      if (revision !== base) return false;
      files.set(rel, text);
      return true;
    },
    day: () => DAY,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as CreativeDeps['log'],
    now: () => clock.now,
    ...overrides,
  };
  return { creative: new Creative(deps), dir, prompts, files, clock };
}

const projectJson = JSON.stringify({
  work_type: '短篇小说',
  title: '窗边的雨',
  premise: '一个人等一场不会停的雨',
  tone: '安静',
  point_of_view: '第三人称有限视角',
  target_chars: 900,
  next_direction: '从窗边开始写',
});

const passReview = JSON.stringify({
  passed: true, persona_score: 8, progress_score: 8, repetition_score: 8, issues: [], rewrite: '',
  this_stretch: '他读到那张纸条',
  mainline_direction: '雨没有停的意思',
  themes_used: ['等待'],
  threads_advanced: ['他在等谁'],
  threads_resolved: [],
  new_threads: ['楼下有人搬走'],
  important_facts: ['雨从傍晚下起'],
  keywords: ['雨', '窗'],
  next_direction: '让他开口',
});
const failReview = JSON.stringify({ passed: false, persona_score: 4, progress_score: 4, repetition_score: 4, issues: ['空转'], rewrite: '写一件真发生的事' });

describe('纯函数', () => {
  it('相同的两段相识度为 1，毫无重合的近 0', () => {
    expect(textSimilarity('雨落在窗沿上', '雨落在窗沿上')).toBe(1);
    expect(textSimilarity('雨落在窗沿上', 'ABCDEF')).toBe(0);
  });

  it('最近几段里有太像的，就算重复', () => {
    const line = '雨落在窗沿上，她把杯子往里面挪了挪。';
    expect(repeatsEarlier(line, ['完全不同的另一件事。'])).toBe(false);
    expect(repeatsEarlier(line, [line])).toBe(true);
  });

  it('精力低时少写，高时多写，但都在 60–1200 之间', () => {
    expect(chunkBudget(settings({ chunkChars: 220 }), 0.2)).toBeLessThan(220);
    expect(chunkBudget(settings({ chunkChars: 220 }), 0.95)).toBeGreaterThan(220);
    expect(chunkBudget(settings({ chunkChars: 5000 }), 1)).toBe(1200);
    expect(chunkBudget(settings({ chunkChars: 10 }), 0)).toBe(60);
  });

  it('写完的那一段去掉标题与围栏，长度收进预算', () => {
    expect(cleanChunk('```text\n正文：雨停了。\n```', 100)).toBe('雨停了。');
    expect(cleanChunk('啊'.repeat(400), 100).length).toBeLessThanOrEqual(181);
  });

  it('成熟度只看客观进度', () => {
    const raw = work({ currentChars: 0, chunkCount: 0 });
    const grown = work({ currentChars: 700, chunkCount: 5, bible: { ...emptyBible(), openThreads: ['a'], facts: ['b'] } });
    expect(maturity(raw)).toBeLessThan(maturity(grown));
    expect(maturity(grown)).toBeLessThanOrEqual(100);
  });

  it('三个节点各给一次：刚成形、过半、写完；只写了一段不算成形', () => {
    expect(nextMilestone(work({ currentChars: 200, chunkCount: 1 }))).toBeNull();
    // 长期目标的字数也要够：三千多字的坑写了二百字，那是刚起笔。
    expect(nextMilestone(work({ currentChars: 227, chunkCount: 1, targetChars: 3400 }))).toBeNull();
    expect(nextMilestone(work({ currentChars: 200, chunkCount: 2 }))).toBe('opening');
    expect(nextMilestone(work({ currentChars: 200, chunkCount: 2, disclosed: ['opening'] }))).toBeNull();
    expect(nextMilestone(work({ currentChars: 600, chunkCount: 4, disclosed: ['opening'] }))).toBe('midpoint');
    expect(nextMilestone(work({ status: 'finished', disclosed: ['opening', 'midpoint'] }))).toBe('finished');
  });

  it('本子：收束掉的线索从未结里移走，重复的不再追加', () => {
    const before = { ...emptyBible(), openThreads: ['旧线索', '他为什么走'] };
    const after = applyExtract(before, {
      mainline: '雨还在下',
      themes: ['等待'],
      advanced: ['他为什么走'],
      resolved: ['旧线索'],
      fresh: ['楼下有人搬走'],
      facts: ['雨从傍晚下起'],
      keywords: ['雨'],
      nextDirection: '让他开口',
    });
    expect(after.openThreads).toEqual(['他为什么走', '楼下有人搬走']);
    expect(after.mainline).toBe('雨还在下');
    expect(after.facts).toEqual(['雨从傍晚下起']);
    expect(applyExtract(after, { ...after, mainline: '', themes: [], advanced: [], resolved: [], fresh: [], facts: ['雨从傍晚下起'], keywords: [], nextDirection: '' }).facts)
      .toEqual(['雨从傍晚下起']);
  });

  it('续写间隔按作品稳定取值，失败退避不超过六小时', () => {
    const a = advanceDelayMs(settings(), 'w1');
    const b = advanceDelayMs(settings(), 'w1');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(95 * 60_000);
    expect(a).toBeLessThanOrEqual(320 * 60_000);
    expect(retryDelayMs(1)).toBe(30 * 60_000);
    expect(retryDelayMs(20)).toBe(360 * 60_000);
  });

  it('模型把 JSON 包在围栏或废话里也能取出来', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('好的，结果如下：{"a":2} 以上。')).toEqual({ a: 2 });
    expect(parseJsonObject('没有')).toBeNull();
  });
});

describe('书柜', () => {
  it('写进 data/creative.json，重开还能读回来', () => {
    const dir = makeTmpDir().dir;
    const store = new CreativeStore(dir, DAY);
    store.add(work({ id: 'w2', title: '第二部' }));
    const reopened = new CreativeStore(dir, DAY);
    expect(reopened.works().map((item) => item.title)).toEqual(['第二部']);
    expect(reopened.works()[0].bible.themes).toEqual([]);
  });

  it('换天只把今日额度归零，作品留着', () => {
    const dir = makeTmpDir().dir;
    const store = new CreativeStore(dir, DAY);
    store.add(work());
    store.current.chunksToday = 4;
    store.save();
    store.tick('2026-10-26');
    expect(store.current.chunksToday).toBe(0);
    expect(store.works()).toHaveLength(1);
  });

  it('分享机会给一次就消掉，同一个节点不会再挂上来', () => {
    const dir = makeTmpDir().dir;
    const store = new CreativeStore(dir, DAY);
    const w = work({ currentChars: 600, chunkCount: 2, targetChars: 4000 });
    store.add(w);
    const offer = store.refreshOffer(w, '雨落在窗沿上。');
    expect(offer?.milestone).toBe('opening');
    expect(store.offer()?.workId).toBe('w1');
    store.consumeOffer('w1', 'opening');
    expect(store.offer()).toBeNull();
    expect(store.current.sharesToday).toBe(1);
    expect(store.works()[0].disclosed).toEqual(['opening']);
  });
});

describe('推进', () => {
  it('手上没东西时开一部，接着写第一段，正文落进工作区', async () => {
    const chunk = prose('甲乙丙丁');
    const { creative, files, prompts } = makeCreative([projectJson, chunk, passReview]);
    const run = await creative.step();
    expect(run?.ok).toBe(true);
    const stored = creative.snapshot().works;
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('窗边的雨');
    expect(stored[0].chunkCount).toBe(1);
    expect(stored[0].currentChars).toBeGreaterThan(0);
    expect(files.get('创作/窗边的雨.md')?.trim()).toContain(chunk.slice(0, 10));
    expect(stored[0].bible.mainline).toBe('雨没有停的意思');
    // 立项 → 正文 → 审稿（顺带更新本子）：一次一段只花三次调用。
    expect(prompts).toHaveLength(3);
    // 只写了一段还不成形，别急着让她拿出去说。
    expect(creative.offer()).toBeNull();
  });

  it('审稿不过就重写一版，过了才收进书柜', async () => {
    const first = prose('旧的意象');
    const second = '风把窗帘掀起来，她伸手按住，指节发白。楼下的车灯扫过天花板，又走了。';
    const { creative, files } = makeCreative([projectJson, first, failReview, second, passReview]);
    const run = await creative.step();
    expect(run?.ok).toBe(true);
    expect(files.get('创作/窗边的雨.md')).toContain(second);
    expect(files.get('创作/窗边的雨.md')).not.toContain(first.slice(0, 8));
  });

  it('生成期间正文被手动改过：重读合并，不拿旧全文覆盖', async () => {
    const chunk = prose('并发段落');
    const w = work({ file: '创作/窗边的雨.md', currentChars: 40, chunkCount: 1 });
    const queue = [chunk, passReview];
    let files!: Map<string, string>;
    const made = makeCreative([], {
      generate: async () => {
        const next = queue.shift() ?? '';
        // 模型还在生成时，她主意识里追加了一段。
        if (next === chunk) files.set(w.file, '最早的一段。\n\n她手动补进去的一段。\n');
        return next;
      },
    }, [w]);
    files = made.files;
    files.set(w.file, '最早的一段。\n');

    const run = await made.creative.step();
    expect(run?.ok).toBe(true);
    const final = files.get(w.file)!;
    expect(final).toContain('她手动补进去的一段');
    expect(final).toContain(chunk.slice(0, 10));
  });

  it('生成期间正文被改名：不把旧路径重新写出来', async () => {
    const chunk = prose('改名段落');
    const w = work({ file: '创作/窗边的雨.md', currentChars: 40, chunkCount: 1 });
    const queue = [chunk, passReview];
    let files!: Map<string, string>;
    const made = makeCreative([], {
      generate: async () => {
        const next = queue.shift() ?? '';
        if (next === chunk) {
          files.delete(w.file);
          files.set('创作/新名字.md', '改名前的正文\n');
        }
        return next;
      },
    }, [w]);
    files = made.files;
    files.set(w.file, '改名前的正文\n');

    const run = await made.creative.step();
    expect(run?.ok).toBe(false);
    expect(run?.reason).toContain('改动');
    expect(files.has(w.file)).toBe(false);
    expect(files.get('创作/新名字.md')).toBe('改名前的正文\n');
  });

  it('进程在正文写完后退出：下次按正文补记账目，不重复写', async () => {
    const chunk = '补记用的那一段。';
    const w = work({
      file: '创作/窗边的雨.md',
      currentChars: 40,
      chunkCount: 1,
      nextAdvanceAt: T,
      pendingChunk: { text: chunk, at: T - 1000 },
    });
    const { creative, files, prompts, clock } = makeCreative([], {}, [w]);
    files.set(w.file, `最早的一段。\n\n${chunk}\n`);
    clock.now = T;

    await creative.step();
    const saved = creative.snapshot().works[0];
    expect(saved.currentChars).toBe(40 + chunk.length);
    expect(saved.chunkCount).toBe(2);
    expect(saved.pendingChunk).toBeUndefined();
    // 账已经补上；这一轮没有为了同一段再调一次模型。
    expect(prompts).toHaveLength(0);
  });

  it('进程在正文写入前退出：待办作废，不把没写成的段落算进去', async () => {
    const w = work({
      currentChars: 40,
      chunkCount: 1,
      nextAdvanceAt: T + 10_000,
      pendingChunk: { text: '根本没写进正文的一段。', at: T - 1000 },
    });
    const { creative, files, clock } = makeCreative([], {}, [w]);
    files.set(w.file, '最早的一段。\n');
    clock.now = T;

    await creative.step();
    const saved = creative.snapshot().works[0];
    expect(saved.currentChars).toBe(40);
    expect(saved.chunkCount).toBe(1);
    expect(saved.pendingChunk).toBeUndefined();
  });

  it('作品完结后才拿到摘要：从待办里补收最后一章', async () => {
    const long = settings({ longForm: true, chapterChars: 800, chaptersPerVolume: 8 });
    const body = `${'很早以前他在这条街上住过，街尽头是个修车铺。'.repeat(40)}\n`;
    const w = work({
      scale: '长',
      targetChars: 900,
      currentChars: 900,
      status: 'finished',
      chunkCount: 4,
      file: '创作/收尾.md',
      nextAdvanceAt: Number.MAX_SAFE_INTEGER,
      pendingChapter: { start: 0, end: body.length, at: T - 1000, failures: 0, nextAttemptAt: T - 1 },
    });
    const { creative, files, prompts, clock } = makeCreative(
      [
        JSON.stringify({ summary: '他走了', facts: ['他叫林'] }),
        JSON.stringify({ summary: '整卷：他离开了' }),
      ],
      { settings: () => long },
      [w],
    );
    files.set(w.file, body);
    clock.now = T;

    const run = await creative.step();
    expect(run?.ok).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('You have just finished chapter'))).toBe(true);
    const saved = creative.snapshot().works[0];
    expect(saved.pendingChapter).toBeUndefined();
    expect(saved.volumes[0].chapters[0].summary).toContain('他走了');
    expect(saved.volumes[0].summary).toContain('离开');
  });

  it('补摘要失败：待办留着，退避后再试，不冒充收章', async () => {
    const long = settings({ longForm: true, chapterChars: 800 });
    const body = `${'很早以前他在这条街上住过，街尽头是个修车铺。'.repeat(40)}\n`;
    const w = work({
      scale: '长',
      targetChars: 900,
      currentChars: 900,
      status: 'finished',
      chunkCount: 4,
      file: '创作/收尾.md',
      nextAdvanceAt: Number.MAX_SAFE_INTEGER,
      pendingChapter: { start: 0, end: body.length, at: T - 1000, failures: 0, nextAttemptAt: T - 1 },
    });
    const { creative, files, clock } = makeCreative([''], { settings: () => long }, [w]);
    files.set(w.file, body);
    clock.now = T;

    const run = await creative.step();
    expect(run?.ok).toBe(false);
    const saved = creative.snapshot().works[0];
    expect(saved.volumes).toEqual([]);
    expect(saved.pendingChapter?.failures).toBe(1);
    expect(saved.pendingChapter!.nextAttemptAt).toBeGreaterThan(T);
  });

  it('书柜落盘失败：不报告成功，也不把正文写进去', async () => {
    const chunk = prose('落盘失败');
    const w = work({ file: '创作/窗边的雨.md', currentChars: 40, chunkCount: 1 });
    const { creative, dir, files, clock } = makeCreative([chunk, passReview], {}, [w]);
    files.set(w.file, '最早的一段。\n');
    clock.now = T;
    // 让 creative.json 变成目录：原子写换名必然失败。
    rmSync(join(dir, 'creative.json'));
    mkdirSync(join(dir, 'creative.json'));

    const run = await creative.step();
    expect(run?.ok).toBe(false);
    // 先记待办再动正文；待办都没落盘，正文就不该动。
    expect(files.get(w.file)).toBe('最早的一段。\n');
    expect(creative.snapshot().works[0].pendingChunk).toBeUndefined();
  });

  it('两版都没站住就不写进书柜，退避之后再来', async () => {
    const { creative } = makeCreative([
      projectJson, prose('第一版'), failReview, prose('第二版', 180), failReview,
    ]);
    const run = await creative.step();
    expect(run?.ok).toBe(false);
    const stored = creative.snapshot().works[0];
    expect(stored.chunkCount).toBe(0);
    expect(stored.failures).toBe(1);
    expect(stored.nextAdvanceAt).toBeGreaterThan(T);
    expect(stored.lastError).toBe('写出来的几版都没站住');
  });

  it('和最近几段太像的那一版不算写成', async () => {
    const same = prose('同一段');
    const { creative, clock } = makeCreative([
      projectJson, same, passReview,
      same, prose('换过的', 160), failReview,
    ]);
    await creative.step();
    // 下一段要等到续写间隔之后。
    clock.now += 6 * 3_600_000;
    const run = await creative.step();
    expect(run?.ok).toBe(false);
    expect(creative.snapshot().works[0].chunkCount).toBe(1);
  });

  it('她睡着的时候不写，也不消耗额度', async () => {
    const { creative } = makeCreative([], { blockedAt: () => '她自己的睡眠时段（2–9 点）' });
    expect(creative.gate()).toContain('睡眠');
    expect(await creative.step()).toBeNull();
    expect(creative.snapshot().chunksToday).toBe(0);
  });

  it('今天的额度用完了就不再写', async () => {
    const { creative } = makeCreative([], { settings: () => settings({ maxChunksPerDay: 0 }) });
    expect(creative.gate()).toBe('今天已经写了 0/0 段');
  });

  it('没有灵感、也没有该续写的作品时不动笔', async () => {
    const { creative } = makeCreative([], { inspiration: () => null });
    expect(creative.gate()).toBe('手上没有该续写的作品，也没有新念头');
  });

  it('立项时模型调不通：记一笔，一小时内不再试', async () => {
    const { creative } = makeCreative([], {
      generate: async () => { throw new Error('ECONNRESET'); },
    });
    const run = await creative.step();
    expect(run?.ok).toBe(false);
    expect(run?.reason).toContain('ECONNRESET');
    // 同一个小时里再评估一次：不再打模型。
    expect(await creative.step()).toBeNull();
  });

  it('续写时模型调不通：作品留着，按退避再来', async () => {
    let calls = 0;
    const { creative } = makeCreative([], {
      generate: async () => {
        calls += 1;
        if (calls === 1) return projectJson;
        if (calls > 2) throw new Error('timeout');
        return prose('调不通', 160);
      },
    });
    const run = await creative.step();
    expect(run?.ok).toBe(false);
    const stored = creative.snapshot().works[0];
    expect(stored.chunkCount).toBe(0);
    expect(stored.failures).toBe(1);
    expect(stored.nextAdvanceAt).toBeGreaterThan(T);
    expect(stored.lastError).toContain('timeout');
  });

  it('写着的时候不重叠跑第二轮', async () => {
    const queue = [projectJson, prose('慢的'), passReview];
    const held: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => { held.release = resolve; });
    const { creative } = makeCreative([], {
      generate: async () => {
        if (queue.length === 3) await gate;
        return queue.shift() ?? '';
      },
    });
    const first = creative.step();
    expect(await creative.step()).toBeNull();
    held.release?.();
    await first;
    expect(creative.snapshot().works).toHaveLength(1);
  });
});

describe('分享', () => {
  it('分享机会用掉就没了，记一次也不会再挂上来', () => {
    const dir = makeTmpDir().dir;
    const pending = {
      workId: 'w1', title: '窗边的雨', workType: '短篇小说', milestone: 'opening' as const,
      snippet: '雨落在窗沿上。', currentChars: 260, targetChars: 4000, chunkCount: 1,
    };
    const state = {
      version: 1,
      day: DAY,
      chunksToday: 0,
      sharesToday: 0,
      works: [work({ currentChars: 260, chunkCount: 1, targetChars: 4000, pendingShare: pending })],
      lastRun: null,
    };
    writeFileSync(join(dir, 'creative.json'), JSON.stringify(state), 'utf8');
    const { creative } = makeCreative([], { dataDir: dir });
    const offer = creative.offer();
    expect(offer?.title).toBe('窗边的雨');
    creative.consume(offer!);
    expect(creative.offer()).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, 'creative.json'), 'utf8')).works[0].pendingShare).toBeNull();
  });

  it('关掉分享或者今天给够了，就不再有话头', () => {    const dir = makeTmpDir().dir;
    const base = {
      version: 1,
      day: DAY,
      chunksToday: 0,
      sharesToday: 0,
      works: [work({ currentChars: 260, chunkCount: 1, targetChars: 4000, pendingShare: { workId: 'w1', title: '窗边的雨', workType: '短篇小说', milestone: 'opening', snippet: '雨', currentChars: 260, targetChars: 4000, chunkCount: 1 } })],
      lastRun: null,
    };
    writeFileSync(join(dir, 'creative.json'), JSON.stringify(base), 'utf8');
    expect(makeCreative([], { dataDir: dir }).creative.offer()).not.toBeNull();
    expect(makeCreative([], { dataDir: dir, settings: () => settings({ shareEnabled: false }) }).creative.offer()).toBeNull();
    writeFileSync(join(dir, 'creative.json'), JSON.stringify({ ...base, sharesToday: 1 }), 'utf8');
    expect(makeCreative([], { dataDir: dir }).creative.offer()).toBeNull();
  });
});

describe('素材从哪来', () => {
  const NOW = Date.parse('2026-10-30T11:00:00Z');
  const input = (patch: Record<string, unknown> = {}) => ({
    now: NOW,
    today: '2026-10-30',
    diary: null as { date: string; text: string } | null,
    memories: [] as Array<{ text: string; eventTime: string; importance: number }>,
    people: [] as Array<{ name: string; view: string }>,
    ...patch,
  });

  it('有今天的日记，就从日记里长出来', () => {
    const picked = pickInspiration(input({
      diary: { date: '2026-10-30', text: '今天群里吵了一架，最后谁也没说服谁。' },
    }));
    expect(picked?.label).toBe('今天的日记');
    expect(picked?.text).toContain('吵了一架');
  });

  it('日记旧了就不算，退回这几天真发生过的事', () => {
    const picked = pickInspiration(input({
      diary: { date: '2026-10-20', text: '很久以前的一天。' },
      memories: [{ text: '阿明说他下个月搬家', eventTime: '2026-10-29T12:00:00Z', importance: 0.8 }],
    }));
    expect(picked?.label).toContain('这几天的事');
    expect(picked?.text).toContain('搬家');
  });

  it('这几天的事按重要度挑，不超过三件', () => {
    const picked = pickInspiration(input({
      memories: [
        { text: '次要的事', eventTime: '2026-10-29T12:00:00Z', importance: 0.2 },
        { text: '最要紧的事', eventTime: '2026-10-29T13:00:00Z', importance: 0.9 },
        { text: '第三件', eventTime: '2026-10-29T14:00:00Z', importance: 0.5 },
        { text: '第四件', eventTime: '2026-10-29T15:00:00Z', importance: 0.4 },
      ],
    }));
    expect(picked?.text.startsWith('最要紧的事')).toBe(true);
    expect(picked?.text.split('；')).toHaveLength(3);
    expect(picked?.text).not.toContain('次要的事');
  });

  it('三天以外的事不进素材', () => {
    const picked = pickInspiration(input({
      memories: [{ text: '上周的事', eventTime: '2026-10-20T12:00:00Z', importance: 1 }],
    }));
    expect(picked).toBeNull();
  });

  it('没有日记也没有旧事时，写她留下过看法的人', () => {
    const picked = pickInspiration(input({
      people: [{ name: '阿明', view: '他嘴上说得轻松，其实很在意别人记不记得。' }],
    }));
    expect(picked?.label).toContain('阿明');
    expect(picked?.text).toContain('很在意');
  });

  it('三处都空着就不写——没有由头硬开一部，写出来的是字，不是东西', () => {
    expect(pickInspiration(input())).toBeNull();
  });
});

describe('把它拿出来说', () => {
  const offer = {
    workId: 'w1', title: '窗边的雨', workType: '短篇小说', milestone: 'opening' as const,
    snippet: '雨落在窗沿上，她把杯子往里面挪了挪。', currentChars: 260, targetChars: 4000, chunkCount: 1,
  };

  const companionSettings: CompanionSettings = {
    enabled: true,
    allowPrivate: true,
    allowGroups: true,
    participateGroups: true,
    topicWindowMinutes: 30,
    topicDailyCap: 1,
    dreamEveryHours: 6,
    dailyCap: 2,
    followupMinutes: 45,
    followupCooldownMinutes: 240,
    quietStartHour: 3,
    quietEndHour: 4,
    sleepStartHour: 5,
    sleepEndHour: 6,
  };

  const input = (patch: Record<string, unknown> = {}): ScheduleInput => {
    const state = emptyState(T, DAY);
    state.convs['group:730756767'] = {
      ...emptyConv(),
      lastUserKey: '9001',
      lastUserAt: T - 60 * 60_000,
      lastBotAt: T - 60 * 60_000,
    };
    return {
      now: T,
      timezone: 'Asia/Shanghai',
      settings: companionSettings,
      state,
      energy: 0.7,
      creativeOffer: () => offer,
      roomOf: () => ({ heat: 'quiet', lullMinutes: 60, messages: 3, speakers: 2, monologue: false, replyShare: 0.2, toSelf: 0 } as never),
      ...patch,
    } as ScheduleInput;
  };

  it('安静下来时，手上那一段会变成一句可以说的话', () => {
    const planned = planOnce(input());
    expect(planned?.selection.opportunity.kind).toBe('creative');
    expect(planned?.creative?.title).toBe('窗边的雨');
  });

  it('群里正聊着就不拿出来', () => {
    const busy = input({ roomOf: () => ({ heat: 'busy', lullMinutes: 1, messages: 12, speakers: 3, monologue: false, replyShare: 0.4, toSelf: 0 } as never) });
    expect(planOnce(busy)).toBeNull();
  });

  it('她上一句还没人接的时候也不提', () => {
    const waiting = input();
    waiting.state.convs['group:730756767'].openLoop = { at: T - 10 * 60_000, text: '你还没答我', kind: 'question', subject: '9001', followed: false };
    expect(planOnce(waiting)).toBeNull();
  });

  it('手上没有作品时，主动层照旧', () => {
    const planned = planOnce(input({ creativeOffer: () => null }));
    expect(planned?.selection.opportunity.kind).not.toBe('creative');
  });
});

describe('长篇 · 卷章与摘要', () => {
  const longSettings = settings({ longForm: true, chapterChars: 800, chaptersPerVolume: 8 });

  it('阈值有边界：章 800–12000，卷 2–20，目标上限 20000–1000000', () => {
    expect(chapterCharsOf(settings({ chapterChars: 10 }))).toBe(800);
    expect(chapterCharsOf(settings({ chapterChars: 99999 }))).toBe(12000);
    expect(chaptersPerVolumeOf(settings({ chaptersPerVolume: 0 }))).toBe(2);
    expect(maxTargetCharsOf(settings({ maxTargetChars: 1 }))).toBe(20000);
  });

  it('上下文只带：前面各卷各一行，本卷各章各一行', () => {
    const w = work({
      volumes: [
        { index: 1, title: '第一卷', summary: '他离开了村子', chapters: [{ index: 1, summary: '旧章的话', chars: 900, facts: [] }] },
        {
          index: 2,
          title: '第二卷',
          summary: '',
          chapters: [
            { index: 2, summary: '他到了城里', chars: 900, facts: [] },
            { index: 3, summary: '他丢了钱', chars: 900, facts: [] },
          ],
        },
      ],
    });
    const context = longFormContext(w);
    expect(context).toContain('Vol.1《第一卷》 他离开了村子');
    // 收了卷就不再逐章带——否则写久了照样撑爆。
    expect(context).not.toContain('旧章的话');
    expect(context).toContain('This volume (Vol.2《第二卷》) so far:');
    expect(context).toContain('Ch.3 他丢了钱');
    expect(chapterCountOf(w)).toBe(3);
    expect(currentVolume(w)?.index).toBe(2);
  });

  it('没有卷时上下文是空的：短篇照旧', () => {
    expect(longFormContext(work())).toBe('');
  });

  it('老书柜没有 volumes 字段也能读，按短篇补齐', () => {
    const dir = makeTmpDir().dir;
    writeFileSync(join(dir, 'creative.json'), JSON.stringify({
      version: 1, day: DAY, chunksToday: 0, sharesToday: 0, lastRun: null,
      works: [work()],
    }), 'utf8');
    const store = new CreativeStore(dir, DAY);
    expect(store.works()[0].volumes).toEqual([]);
    expect(store.works()[0].chapterStart).toBe(0);
  });

  it('一章写够了就收章：摘要进卷，正文不动', async () => {
    const w = work({ scale: '长', targetChars: 60000, currentChars: 900, chunkCount: 4, file: '创作/长夜.md' });
    const { creative, dir, prompts, files, clock } = makeCreative(
      [
        prose('窗子', 220),
        passReview,
        JSON.stringify({ summary: '他等到天亮，雨没停', facts: ['他叫林'] }),
      ],
      { settings: () => longSettings },
      [w],
    );
    files.set(w.file, `${'很早以前他在这条街上住过，街尽头是个修车铺。'.repeat(40)}\n`);
    clock.now = T;

    const run = await creative.step();
    expect(run?.ok).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('You have just finished chapter 1'))).toBe(true);

    const saved = JSON.parse(readFileSync(join(dir, 'creative.json'), 'utf8'));
    const chapters = saved.works[0].volumes[0].chapters;
    expect(chapters).toHaveLength(1);
    expect(chapters[0].summary).toContain('天亮');
    // 正文没有被摘要改写，反而更长
    expect(files.get(w.file)!.length).toBeGreaterThan(900);
  });

  it('够一卷就收卷：整卷压成一段，后面只带这句', async () => {
    const tight = settings({ longForm: true, chapterChars: 800, chaptersPerVolume: 2 });
    const w = work({
      scale: '长',
      targetChars: 60000,
      currentChars: 900,
      chunkCount: 4,
      file: '创作/长夜.md',
      // 第一卷已经有一章了，这一章收掉就是第二卷。
      volumes: [{ index: 1, title: '第一卷', summary: '', chapters: [{ index: 1, summary: '他出了门，没带伞', chars: 900, facts: [] }] }],
    });
    const { creative, dir, prompts, files, clock } = makeCreative(
      [
        prose('窗子', 220),
        passReview,
        JSON.stringify({ summary: '他等到天亮', facts: [] }),
        JSON.stringify({ summary: '整卷：他等到了雨停' }),
      ],
      { settings: () => tight },
      [w],
    );
    files.set(w.file, `${'很早以前他在这条街上住过，街尽头是个修车铺。'.repeat(40)}\n`);
    clock.now = T;

    await creative.step();
    expect(prompts.some((prompt) => prompt.includes('is finished. Compress it once more'))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, 'creative.json'), 'utf8'));
    expect(saved.works[0].volumes[0].summary).toContain('雨停');
  });

  it('写多大她说了算：说"长"就按长档，卷目照排', async () => {
    const longProject = JSON.stringify({
      scale: '长',
      why_this_size: '这个故事要写很多年',
      work_type: '连载小说',
      title: '长夜',
      premise: '一个人在城市里慢慢老去',
      tone: '沉',
      point_of_view: '第三人称有限视角',
      target_chars: 80000,
      volumes: [{ title: '第一卷 进城', premise: '他刚到城里' }],
      next_direction: '从火车站开始',
    });
    const { creative } = makeCreative(
      [longProject, prose('甲乙丙丁'), passReview],
      { settings: () => settings({ longForm: true }) },
    );
    await creative.step();
    const saved = creative.snapshot().works[0];
    expect(saved.scale).toBe('长');
    expect(saved.targetChars).toBe(80000);
    expect(saved.volumePlan).toHaveLength(1);
    expect(saved.volumePlan[0].title).toBe('第一卷 进城');
  });

  it('明明能写长，她选了短，就还是短——闸只放开能力，不替她决定', async () => {
    const { creative } = makeCreative(
      [projectJson, prose('甲乙丙丁'), passReview],
      { settings: () => settings({ longForm: true }) },
    );
    await creative.step();
    const saved = creative.snapshot().works[0];
    expect(saved.scale).toBe('短');
    expect(saved.targetChars).toBe(900);
    expect(saved.volumePlan).toEqual([]);
  });

  it('长篇没放开时，她想写长也只能写短', async () => {
    const wantsLong = JSON.stringify({ ...JSON.parse(projectJson), scale: '长', target_chars: 90000 });
    const { creative } = makeCreative(
      [wantsLong, prose('甲乙丙丁'), passReview],
      { settings: () => settings({ longForm: false }) },
    );
    await creative.step();
    const saved = creative.snapshot().works[0];
    expect(saved.scale).toBe('短');
    expect(saved.targetChars).toBeLessThanOrEqual(5200);
  });

  it('pickScale：认她说的话，认不出就按字数推', () => {
    expect(pickScale('中', 0, true)).toBe('中');
    expect(pickScale('长', 0, true)).toBe('长');
    expect(pickScale('', 30000, true)).toBe('中');
    expect(pickScale('', 90000, true)).toBe('长');
    expect(pickScale('长', 90000, false)).toBe('短');
  });

  it('短篇写完了也不收章：收章是长篇的事', async () => {
    const short = settings({ longForm: true, chapterChars: 800 });
    const w = work({ scale: '短', targetChars: 900, currentChars: 800, chunkCount: 4, file: '创作/短.md' });
    const { creative, files, clock } = makeCreative(
      [prose('窗子', 220), passReview, JSON.stringify({ summary: '不该出现' })],
      { settings: () => short },
      [w],
    );
    files.set(w.file, `${'很早以前他在这条街上住过，街尽头是个修车铺。'.repeat(40)}\n`);
    clock.now = T;

    await creative.step();
    const saved = creative.snapshot().works[0];
    expect(saved.status).toBe('finished');
    expect(saved.volumes).toEqual([]);
  });

  it('收章没有摘要就不收：留着下次再压，不往上下文里塞垃圾', async () => {
    const long = settings({ longForm: true, chapterChars: 800 });
    const w = work({ scale: '长', targetChars: 60000, currentChars: 900, chunkCount: 4, file: '创作/长夜.md' });
    const { creative, files, clock } = makeCreative(
      [prose('窗子', 220), passReview, ''],
      { settings: () => long },
      [w],
    );
    files.set(w.file, `${'很早以前他在这条街上住过，街尽头是个修车铺。'.repeat(40)}\n`);
    clock.now = T;

    await creative.step();
    const saved = creative.snapshot().works[0];
    expect(saved.volumes).toEqual([]);
    // 正文和进度照常落盘
    expect(saved.currentChars).toBeGreaterThan(900);
  });

  it('长篇按卷给分享机会：收掉第一卷就成形，写到一半的卷算过半', () => {
    const vols = (closed: number, open: boolean): Volume[] => {
      const out: Volume[] = [];
      for (let i = 1; i <= closed; i += 1) {
        out.push({ index: i, title: `第${i}卷`, summary: '收了', chapters: [{ index: i, summary: '动了点什么', chars: 3000, facts: [] }] });
      }
      if (open) out.push({ index: closed + 1, title: '正在写', summary: '', chapters: [] });
      return out;
    };
    const plan = [{ title: '一', premise: '' }, { title: '二', premise: '' }, { title: '三', premise: '' }, { title: '四', premise: '' }];
    // 还没收卷：什么都不给
    expect(nextMilestone(work({ scale: '长', targetChars: 300000, volumes: [] }))).toBeNull();
    // 收掉第一卷：成形
    const one = work({ scale: '长', targetChars: 300000, volumes: vols(1, true), volumePlan: plan });
    expect(nextMilestone(one)).toBe('opening');
    // 计划四卷，一半是两卷：只收了一卷时不给过半
    expect(nextMilestone({ ...one, disclosed: ['opening'] })).toBeNull();
    // 收掉两卷：过半
    expect(nextMilestone({ ...one, disclosed: ['opening'], volumes: vols(2, true) })).toBe('midpoint');
  });

  it('整部写完时最后一卷也收掉：不然它永远没有整卷摘要', async () => {
    const long = settings({ longForm: true, chapterChars: 800, chaptersPerVolume: 8 });
    const w = work({
      scale: '长',
      targetChars: 900,
      currentChars: 850,
      chunkCount: 4,
      file: '创作/收尾.md',
      volumes: [{ index: 1, title: '第一卷', summary: '', chapters: [{ index: 1, summary: '开头', chars: 3000, facts: [] }] }],
    });
    const { creative, dir, files, clock } = makeCreative(
      [
        prose('窗子', 220),
        passReview,
        JSON.stringify({ summary: '他走了' }),
        JSON.stringify({ summary: '整卷：他离开了' }),
      ],
      { settings: () => long },
      [w],
    );
    files.set(w.file, `${'很早以前他在这条街上住过，街尽头是个修车铺。'.repeat(40)}\n`);
    clock.now = T;

    await creative.step();
    const saved = JSON.parse(readFileSync(join(dir, 'creative.json'), 'utf8'));
    expect(saved.works[0].status).toBe('finished');
    expect(saved.works[0].volumes[0].summary).toContain('离开');
  });

  it('她把正文改了名：作品跟着新文件走，不把前面当成空白', async () => {
    const w = work({ title: '六秒内的回执', file: '创作/六秒内的回执.md', targetChars: 60000, currentChars: 900, chunkCount: 4 });
    const names: string[] = [];
    const { creative, files, clock } = makeCreative(
      [prose('窗子', 220), passReview],
      { settings: () => settings({ longForm: true }), list: (dir) => (dir === '创作' ? names : []) },
      [w],
    );
    const oldText = '很早以前他在这条街上住过，街尽头是个修车铺。'.repeat(40);
    files.set('创作/差一百一十四秒.md', `${oldText}\n`);
    names.push('差一百一十四秒.md');
    clock.now = T;

    await creative.step();
    const saved = creative.snapshot().works[0];
    expect(saved.file).toBe('创作/差一百一十四秒.md');
    expect(saved.title).toBe('差一百一十四秒');
    // 新一段接在旧正文后面，而不是另起一个文件
    expect(files.get('创作/差一百一十四秒.md')!.length).toBeGreaterThan(oldText.length + 50);
    expect(files.get('创作/六秒内的回执.md')).toBeUndefined();
  });
});
