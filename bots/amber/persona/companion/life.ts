/**
 * 她的日记：一天结束时，用自己的话把这一天写下来。
 *
 * 不是事件摘要——那是记忆索引的活。日记写的是**她怎么过这一天**：
 * 什么让她停了一下、什么还没想明白、有什么话没说出口。
 *
 * 作者是梦（整理线程），落在工作区的 `memo/diary/YYYY-MM-DD.md`，进 git。
 * 主意识只在当天第一次醒来时看到最近一篇的一小段——看多了就变成朗读。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface DiaryEntry {
  /** `YYYY-MM-DD`。 */
  date: string;
  /** 正文（去掉标题），已经压缩成一段。 */
  text: string;
  file: string;
}

const MAX_CHARS = 320;

/** 最近一篇日记；目录不在或读不出来就返回 null，不报错。 */
export function latestDiary(memoryDir: string): DiaryEntry | null {
  const dir = join(memoryDir, 'memo', 'diary');
  if (!existsSync(dir)) return null;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
  } catch {
    return null;
  }
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i];
    try {
      const raw = readFileSync(join(dir, file), 'utf8');
      const body = raw
        .split(/\r?\n/)
        .filter((line) => !/^#{1,6}\s/.test(line.trim()))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!body) continue;
      return {
        date: file.replace(/\.md$/, ''),
        text: body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}…` : body,
        file: `memo/diary/${file}`,
      };
    } catch {
      // 读不出来就往前找一篇。
    }
  }
  return null;
}

/**
 * 给主意识看的一小段。
 *
 * 只在当天第一次醒来时注入：日记是背景，不是每轮都要复述的台词。
 */
export function diaryBlock(entry: DiaryEntry): string {
  return [
    `[你最近写下的一天：${entry.date}]`,
    entry.text,
    '这是你自己写的，不是任务；想提就自然带一句，不必复述，也不要当成今天刚发生的事。',
  ].join('\n');
}

/** 最近一次交接（也就是最近一次梦）：看 `handoffs/` 里最新那份笔记的修改时间。 */
export function lastHandoffAt(memoryDir: string): number | null {
  const dir = join(memoryDir, 'handoffs');
  if (!existsSync(dir)) return null;
  let latest = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      const at = statSync(join(dir, name)).mtimeMs;
      if (at > latest) latest = at;
    }
  } catch {
    return null;
  }
  return latest || null;
}

/**
 * 该不该因为"太久没整理"而入一次梦。
 *
 * 两个条件：**到点**，并且这段时间里**有人说过话，或者今天还没有日记**。
 * 不要求有人说话——安静的一天也该留下一点记录；但没有变化又刚整理过，
 * 就不值得为它花一次梦的钱。
 */
export function dreamDue(opts: {
  now: number;
  lastHandoffAt: number | null;
  hours: number;
  lastActivityAt: number | null;
  diaryDate: string | null;
  today: string;
}): boolean {
  if (!Number.isFinite(opts.hours) || opts.hours <= 0) return false;
  if (opts.lastHandoffAt !== null && opts.now - opts.lastHandoffAt < opts.hours * 3_600_000) return false;
  const activity = opts.lastActivityAt !== null
    && (opts.lastHandoffAt === null || opts.lastActivityAt > opts.lastHandoffAt);
  return activity || opts.diaryDate !== opts.today;
}
