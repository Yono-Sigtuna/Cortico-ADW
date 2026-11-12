/** 保留期清理：只动 data/media 与 data/runs，按月份算，工作区一律不碰。 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneStorage, retentionCutoff } from '../../src/core/storageRetention.ts';
import { makeTmpDir } from './helpers.ts';

const NOW = Date.parse('2026-11-02T12:00:00+08:00');

function touch(path: string, at: number): void {
  const seconds = at / 1000;
  utimesSync(path, seconds, seconds);
}

describe('保留期清理', () => {
  const tmp = makeTmpDir();
  afterAll(() => tmp.cleanup());
  let seq = 0;
  const freshData = (): string => {
    seq += 1;
    const dir = join(tmp.dir, `data-${seq}`);
    mkdirSync(join(dir, 'media'), { recursive: true });
    mkdirSync(join(dir, 'runs'), { recursive: true });
    return dir;
  };

  it('保留线是往回推 N 个自然月', () => {
    const six = retentionCutoff(6, NOW);
    expect(new Date(six).getFullYear()).toBe(2026);
    expect(new Date(six).getMonth()).toBe(4); // 5 月（0 基）
    expect(retentionCutoff(0, NOW)).toBe(NOW);
  });

  it('七个月前的附件删掉，五个月前的留着', () => {
    const dir = freshData();
    const old = join(dir, 'media', 'old.png');
    const recent = join(dir, 'media', 'recent.jpg');
    writeFileSync(old, 'x'.repeat(100));
    writeFileSync(recent, 'y'.repeat(50));
    touch(old, Date.parse('2026-04-02T12:00:00+08:00'));
    touch(recent, Date.parse('2026-06-02T12:00:00+08:00'));

    const result = pruneStorage(dir, 6, NOW);
    expect(result.mediaRemoved).toBe(1);
    expect(result.mediaBytes).toBe(100);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('运行目录按 id 里的日期算，不信 mtime', () => {
    const dir = freshData();
    const oldRun = join(dir, 'runs', 'r-20260402-120000-abcd');
    const recentRun = join(dir, 'runs', 'r-20261001-120000-abcd');
    const notARun = join(dir, 'runs', 'something-else');
    for (const path of [oldRun, recentRun, notARun]) mkdirSync(path, { recursive: true });
    writeFileSync(join(oldRun, 'log.jsonl'), 'z'.repeat(30));
    // 把旧目录的 mtime 改成今天：仍然要被删，因为判据是 id
    touch(oldRun, NOW);
    writeFileSync(join(recentRun, 'log.jsonl'), 'w'.repeat(10));

    const result = pruneStorage(dir, 6, NOW);
    expect(result.runsRemoved).toBe(1);
    expect(result.runsBytes).toBe(30);
    expect(existsSync(oldRun)).toBe(false);
    expect(existsSync(recentRun)).toBe(true);
    expect(existsSync(notARun)).toBe(true);
  });

  it('工作区里的东西一个都不动', () => {
    const dir = freshData();
    mkdirSync(join(dir, 'memory', 'external'), { recursive: true });
    const kept = join(dir, 'memory', 'external', 'old-saved.png');
    writeFileSync(kept, 'k');
    touch(kept, Date.parse('2025-01-01T00:00:00+08:00'));

    pruneStorage(dir, 6, NOW);
    expect(existsSync(kept)).toBe(true);
  });

  it('目录不存在、或保留月数为 0 时什么都不做', () => {
    seq += 1;
    const empty = join(tmp.dir, `empty-${seq}`);
    expect(pruneStorage(empty, 6, NOW)).toEqual({ mediaRemoved: 0, mediaBytes: 0, runsRemoved: 0, runsBytes: 0 });

    const dir = freshData();
    const old = join(dir, 'media', 'old.png');
    writeFileSync(old, 'x');
    touch(old, Date.parse('2026-04-02T12:00:00+08:00'));
    expect(pruneStorage(dir, 0, NOW).mediaRemoved).toBe(0);
    expect(existsSync(old)).toBe(true);
  });
});
