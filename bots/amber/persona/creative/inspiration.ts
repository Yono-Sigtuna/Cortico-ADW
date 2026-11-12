/**
 * 一部作品的由来：从她真经过的事里挑一件。
 *
 * 三处来源，按"离现在多近、多重"排：她自己写的日记、梦筛过一遍的旧事、她在意的人。
 * 日程上写着"在写东西"不算——拿"我在写"去当灵感，是自己咬自己。
 */

export interface DiarySource {
  /** `YYYY-MM-DD`。 */
  date: string;
  text: string;
}

export interface MemorySource {
  text: string;
  /** ISO 时间。 */
  eventTime: string;
  importance: number;
}

export interface PersonSource {
  name: string;
  /** 她在档案里写下的最后一条看法。 */
  view: string;
}

export interface InspirationInput {
  now: number;
  /** 本地日期键。 */
  today: string;
  diary: DiarySource | null;
  /** 记忆索引里最近的旧事，新的在前。 */
  memories: readonly MemorySource[];
  people: readonly PersonSource[];
}

export interface Inspiration {
  label: string;
  text: string;
}

const DAY_MS = 86_400_000;
/** 超过这么多天的日记就不再是"最近的日子"。 */
const DIARY_FRESH_DAYS = 3;
/** 往前看几天的事。 */
const LOOKBACK_DAYS = 3;
/** 一次取几件旧事拼成由头。 */
const MEMORY_ITEMS = 3;
const MAX_CHARS = 400;

/**
 * 挑一件当作这部作品由头的事。
 *
 * 顺序就是判据：今天/前两天的日记 → 这几天里最重要的几件旧事 → 她写下过看法的人。
 * 都没有，就不写。没有由头硬开一部，写出来的是字，不是东西。
 */
export function pickInspiration(input: InspirationInput): Inspiration | null {
  const diaryText = flat(input.diary?.text ?? '').slice(0, MAX_CHARS);
  if (diaryText && isFresh(input.diary?.date ?? '', input.now)) {
    const label = input.diary?.date === input.today ? '今天的日记' : `日记里的 ${input.diary?.date}`;
    return { label, text: diaryText };
  }

  const cutoff = input.now - LOOKBACK_DAYS * DAY_MS;
  const recent = input.memories
    .filter((item) => {
      const at = Date.parse(item.eventTime);
      return Number.isFinite(at) && at >= cutoff && flat(item.text);
    })
    .sort((a, b) => b.importance - a.importance)
    .slice(0, MEMORY_ITEMS);
  if (recent.length) {
    return {
      label: `这几天的事（${recent.length} 件）`,
      text: recent.map((item) => flat(item.text)).join('；').slice(0, MAX_CHARS),
    };
  }

  const person = input.people.find((item) => flat(item.view));
  if (person) return { label: `她写过的 ${person.name}`, text: flat(person.view).slice(0, MAX_CHARS) };

  return null;
}

/** `YYYY-MM-DD` 按当天零点算；解析不了就当不新鲜。 */
function isFresh(date: string, now: number): boolean {
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(at) && now - at <= DIARY_FRESH_DAYS * DAY_MS;
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
