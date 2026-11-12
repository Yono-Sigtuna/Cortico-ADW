/**
 * 附件与运行日志的保留策略：按月份，只留最近 N 个月。
 *
 * 只碰两个目录：
 *   - `data/media/`  —— 群图的本地缓存，按内容哈希命名。删掉只是「这些老图不能再展开」，
 *                      句柄还在、历史消息的文本形态不变（`LogBlobStore.read` 找不到就返回 null）。
 *   - `data/runs/`   —— 每次进程运行的日志目录。`index.jsonl` 里本来就有指向已删目录的行，
 *                      WebUI 点进去没有内容而已，不是新的故障类型。
 *
 * **不碰 `memory/`。** 那是她的工作区：她特意存下来的图（`external/qq/images/`）、笔记、
 * git 仓库都在里面，不是缓存。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runsDirOf } from './run.ts';

export interface RetentionResult {
  mediaRemoved: number;
  mediaBytes: number;
  runsRemoved: number;
  runsBytes: number;
}

/** `r-YYYYMMDD-HHMMSS-xxxx`：日期来自 id 本身，不信目录 mtime（复制/备份会改写它）。 */
const RUN_ID = /^r-(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-f]{4}$/;

/** 保留线：当前时刻往回推 N 个自然月。 */
export function retentionCutoff(months: number, now = Date.now()): number {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff.getTime();
}

/**
 * 清掉早于保留线的附件与运行目录，返回删了多少。
 *
 * 目录不存在、单个文件删不掉都不影响别的：这一层是收尾，不是主流程。
 */
export function pruneStorage(dataDir: string, months: number, now = Date.now()): RetentionResult {
  const result: RetentionResult = { mediaRemoved: 0, mediaBytes: 0, runsRemoved: 0, runsBytes: 0 };
  if (!(months > 0)) return result;
  const cutoff = retentionCutoff(months, now);

  const mediaDir = join(dataDir, 'media');
  if (existsSync(mediaDir)) {
    for (const name of readdirSync(mediaDir)) {
      const path = join(mediaDir, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        rmSync(path, { force: true });
        result.mediaRemoved += 1;
        result.mediaBytes += stat.size;
      } catch { /* 删不掉就留着，下次再试 */ }
    }
  }

  const runsDir = runsDirOf(dataDir);
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir)) {
      const match = RUN_ID.exec(name);
      if (!match) continue;
      const started = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
      if (started >= cutoff) continue;
      const path = join(runsDir, name);
      try {
        const bytes = dirBytes(path);
        rmSync(path, { recursive: true, force: true });
        result.runsRemoved += 1;
        result.runsBytes += bytes;
      } catch { /* 同上 */ }
    }
  }

  return result;
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirBytes(path) : statSync(path).size;
    } catch { /* 统计失败不影响删除 */ }
  }
  return total;
}
