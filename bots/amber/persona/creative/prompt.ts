/**
 * 创作线程的提示词。与梦同一风格：英文、短句、第二人称，对"同一颗心智的一缕"说话。
 *
 * 每一条都是独立的一次调用，彼此只通过作品本子（StoryBible）与正文相接。
 * 作品本身用她日常说话的那种语言写，所以这里要求输出中文。
 */
import type { StoryBible, Volume, Work } from './models.ts';

/** 一次创作所依据的"此刻"：她在过什么日子，她怎么描述自己。 */
export interface CreativeBrief {
  /** 她此刻在做什么、什么心情、外面什么样。由生活状态拼出来，没有就空。 */
  living: string;
  /** 她自己写下的当前自述（`memo/self.md`）。没有就空。 */
  self: string;
  /** 她自己定的创作方向。空 = 跟着日子走。 */
  direction: string;
  /** 群里最近说的话。她要是问过"想看长的还是短的"，答案就在这里面。 */
  recent?: string;
}

/** 立项：从一个念头长出一部作品。写多大，由她自己定。 */
export function projectPrompt(input: {
  brief: CreativeBrief;
  inspiration: string;
  sourceLabel: string;
  /** 长篇这一档放开了没有。没放开就只有短篇可选。 */
  allowLong?: boolean;
  /** 长篇目标字数上限。 */
  maxTarget?: number;
}): string {
  const { brief, inspiration, sourceLabel } = input;
  const allowLong = input.allowLong === true;
  const cap = Math.max(60000, Math.round(input.maxTarget ?? 300000));
  const size = allowLong
    ? `- Decide the size yourself: 短 (300–5200 characters), 中 (20000–60000) or 长 (60000–${cap}). No one sets this for you.
- 短 is one sitting, finished in a few days. 中 runs a few weeks. 长 is a serialised novel written chapter by chapter over months; it needs 3–6 volumes, each a stretch of the story with its own turn.
- Pick by what this piece actually wants, by how you feel right now, and by anything they said in the conversation below. Do not pick 长 just to be ambitious — a long one you cannot carry is worse than a short one you can.
- Give one honest line for why this size.`
    : '- Target length between 300 and 5200 characters. It must be too long to finish in one sitting.';
  const shape = allowLong
    ? '{"scale":"短/中/长","why_this_size":"一句话：为什么是这个大小","work_type":"短篇小说/短诗/随笔/短剧/角色设定/世界碎片/连载小说 …","title":"不超过 18 字","premise":"一句话：这到底是什么","tone":"2 到 5 个词","point_of_view":"第三人称有限视角/第三人称全知视角/多视角/第一人称角色视角/书信体","target_chars":数字,"volumes":[{"title":"这一卷叫什么","premise":"这一卷推进到哪，一句话"}],"next_direction":"第一段从哪写起，一句话"}'
    : '{"work_type":"短篇小说/短诗/随笔/短剧/角色设定/世界碎片 …","title":"不超过 18 字","premise":"一句话：这到底是什么","tone":"2 到 5 个词","point_of_view":"第三人称有限视角/第三人称全知视角/多视角/第一人称角色视角/书信体/无固定叙事视角","target_chars":数字,"next_direction":"下一段从哪写起，一句话"}';
  return `[system] You are the same person who has been living the day below. The day has gone quiet, and you feel like making something of your own — not for anyone, not to explain yourself. Design the work; do not write it.

This stretch of your day: ${input.brief.living || 'an ordinary quiet stretch at home.'}
${brief.self ? `How you described yourself lately:\n${brief.self}\n` : ''}${brief.direction ? `The direction you set for your own writing: ${brief.direction}\n` : ''}${brief.recent ? `What the group has been saying lately — they may have answered a question you asked them:\n${brief.recent}\n` : ''}
What set this off (${sourceLabel}): ${inspiration}

Design one piece you would actually make in this mood.
- Any kind of text: short story, poem, lyric, essay, sketch, script, character study, world fragment, folktale.
- Everything about it must be something you could have written: the taste in subjects, the imagery, the maturity of the people in it, the range of what you know.
- The tone is yours; the narrator is not necessarily you. A story about someone else is not your diary.
${size}
- Nothing explicit, gory, or written to shock.
- The first line has to be something that pulls you back into it tomorrow.

Output JSON only, every value in Chinese:
${shape}`;
}

/** 写这一段正文。先在脑子里定这一小段要动什么，再落笔——想的过程不出现在输出里。 */
export function chunkPrompt(input: {
  work: Work;
  brief: CreativeBrief;
  recent: string;
  budget: number;
  remaining: number;
  notice: string;
  /** 长篇：前面各卷与本卷各章的摘要；短篇为空。 */
  longContext?: string;
}): string {
  const { work, brief, recent, budget, remaining, notice, longContext } = input;
  const closing = remaining <= budget + 120
    ? 'You are close to the end: let this stretch settle into a small closing beat, but do not finish the whole work.'
    : 'Do not finish the work. Move one small thing only.';
  const moves = work.bible.recentOutlines.length
    ? `The last stretches did this — do not repeat those moves:\n${work.bible.recentOutlines.join('\n')}\n`
    : '';
  return `[system] You are writing the next stretch of your own work, alone, in a quiet stretch of the day. Write only what you actually put down this time.

《${work.title}》 — ${work.workType}
${work.premise}
Tone: ${work.tone}. Point of view: ${work.pointOfView}.
It began from (${work.sourceLabel}): ${work.sourceText}
${brief.living ? `Where you are in your day: ${brief.living}\n` : ''}${bibleBlock(work.bible)}${longContext ? `${longContext}\n` : ''}${moves}${brief.direction ? `Your own direction for this work: ${brief.direction}\n` : ''}
Recent stretches (do not repeat their imagery, sentence shapes or moves):
${recent || '(none yet)'}

Before you write, settle it privately — it must not appear in the output: what does this stretch move? One thread forward, one fact revealed, one relationship shifting. Follow the notebook; open nothing you are not going to use.

Now write it.
- ${outputRule(work.workType)}
- About ${budget} Chinese characters. Hard limit ${budget + 80}.
- Only the text. No title, no heading, no "以下是", no JSON, no plan, no notes to yourself.
- The people in it keep the maturity, knowledge and experience you gave them. Do not let them suddenly know more than they could.
- Concrete detail, not piled-up adjectives. It may feel dreamlike or everyday; it must stay readable.
- ${closing}${notice ? `\n- ${notice}` : ''}`;
}

/**
 * 审自己刚写的那一段，顺手把本子更新了。
 *
 * 同一遍读完做两件事：先判它站不站得住，再把续写要记住的东西记下来。
 * 判在前——先给分，再抽取，免得"反正要写说明"把标准放松了。
 */
export function reviewPrompt(input: {
  work: Work;
  text: string;
  recent: string;
}): string {
  const { work, text, recent } = input;
  return `[system] Read what you just wrote twice in the same pass. First as the reader who would send it back; then as the writer who has to continue tomorrow.

Work: 《${work.title}》 — ${work.workType}. ${work.premise}
Tone: ${work.tone}. Point of view: ${work.pointOfView}.
${bibleBlock(work.bible)}
The stretches before it:
${recent || '(none)'}

The stretch just written:
${text}

First, judge it — this comes before anything else:
1. Does it belong to this work — the same taste, the same people at the same level of experience — or did it drift into a generic voice?
2. Did it actually move something, or only circle the same feeling in different words?
3. Does it repeat imagery, sentence shapes or interior monologue from the stretches above?
4. Does it contradict a fact or a thread in the notebook?

Then, only if it stands, record what the next stretch needs in order not to contradict itself. Keep entries short; drop a thread once it is closed.

Output one JSON object, in Chinese:
{"passed":true,"persona_score":0,"progress_score":0,"repetition_score":0,"issues":["…"],"rewrite":"若必须重写，一句话说怎么改",
 "this_stretch":"这一段落了什么，一句话（不超过 20 字）",
 "mainline_direction":"一句话：现在真正推进到哪条主线","themes_used":["最多 3 个主题词"],
 "threads_advanced":["最多 2 条推进中的线索"],"threads_resolved":["最多 1 条这次收束掉的线索"],
 "new_threads":["最多 2 条新埋下的线索"],"important_facts":["最多 3 条后续不能写错的事实"],
 "keywords":["最多 6 个词"],"next_direction":"下一段最自然该写什么，一句话"}
Scores are 0–10. "passed" is false the moment you would not leave it as it is.`;
}

/** 模型偶尔把 JSON 包在围栏或前后废话里；取第一个能解析的对象。 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? '').trim();
  const unfenced = text.startsWith('```') ? text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim() : text;
  const attempt = (candidate: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(candidate) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(unfenced);
  if (direct) return direct;
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) return attempt(unfenced.slice(start, end + 1));
  return null;
}

function bibleBlock(bible: StoryBible): string {
  const lines = [
    bible.mainline ? `Mainline: ${bible.mainline}` : '',
    bible.themes.length ? `Themes: ${bible.themes.join('、')}` : '',
    bible.openThreads.length ? `Open threads: ${bible.openThreads.join('；')}` : '',
    bible.facts.length ? `Facts already fixed: ${bible.facts.join('；')}` : '',
    bible.nextDirection ? `Next direction: ${bible.nextDirection}` : '',
  ].filter(Boolean);
  return lines.length ? `Notebook:\n${lines.join('\n')}\n` : '';
}

/** 不同文体写出来不一样：诗不是小说，设定不是散文。 */
function outputRule(workType: string): string {
  const type = workType || '';
  if (/诗|歌词|歌/.test(type)) return 'Lines and stanzas are allowed. Do not explain the images; do not turn it into narrative.';
  if (/随笔|散文|札记|观察|评论|读后感/.test(type)) return 'Write the text itself. The author may observe and judge; do not slip into a reply to a reader.';
  if (/剧本|短剧|分镜|脚本|对白/.test(type)) return 'Scene text and dialogue are allowed, with brief stage directions. Not a production plan.';
  if (/设定|世界观|角色|怪谈|图鉴/.test(type)) return 'Write the entry itself — it may read like a bestiary, a dossier or a fragment of a setting book, but it stays a piece of writing, not a config file.';
  return 'Narrative prose only.';
}

/**
 * 收一章：把这一章压成两句，再把后面不能写错的事挑出来。
 *
 * 这是长篇能写下去的唯一理由——写到第三十章时，前面二十九章只剩这些句子。
 */
export function chapterSummaryPrompt(input: { work: Work; index: number; text: string }): string {
  const { work, index, text } = input;
  return `[system] You have just finished chapter ${index} of your own work. Do not rewrite it. Compress it for the version of you who will write the next chapter — and chapter 40 — without being able to reread it.

Work: 《${work.title}》 — ${work.workType}. ${work.premise}
Tone: ${work.tone}. Point of view: ${work.pointOfView}.
${bibleBlock(work.bible)}
The chapter you just finished:
${text}

Two jobs:
1. Say what actually happened — who did what, what changed for good, what is still hanging. One to three sentences. Not a mood description, not praise.
2. Pull out what a later chapter must not contradict: names, ages, places, what has already been established, who knows what.

Output one JSON object, in Chinese:
{"summary":"这一章发生了什么，一到三句","facts":["后面不能写错的事实，最多 3 条"],"threads_closed":["这一章收掉的线"],"threads_open":["这一章新埋的线"]}`;
}

/** 收一卷：几章压成一段更远的记忆。 */
export function volumeSummaryPrompt(input: { work: Work; volume: Volume }): string {
  const { work, volume } = input;
  const planned = work.volumePlan[volume.index - 1]?.premise ?? '';
  const chapters = volume.chapters.map((chapter) => `- Ch.${chapter.index} ${chapter.summary}`).join('\n') || '(none)';
  return `[system] Volume ${volume.index}《${volume.title}》 of your own work is finished. Compress it once more, for the version of you writing volume ${volume.index + 1} — who will not read these chapters again.

Work: 《${work.title}》 — ${work.workType}. ${work.premise}
What this volume was meant to do: ${planned || '(not planned ahead)'}
Its chapters:
${chapters}

Say what this volume did to the story: what changed for good, what is still unfinished, and where the next volume has to start from. Three to five sentences. Do not praise it.

Output one JSON object, in Chinese:
{"summary":"整卷发生了什么、留下了什么，三到五句","next_direction":"下一卷从哪里接着写，一句话"}`;
}
