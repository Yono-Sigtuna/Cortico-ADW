/** 日记：她自己写下的那一天。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diaryBlock, dreamDue, lastHandoffAt, latestDiary } from '../../bots/amber/persona/companion/life.ts';
import { makeTmpDir } from '../core/helpers.ts';

describe('日记', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let dir: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    dir = join(tmp.dir, 'memo', 'diary');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  it('没有日记目录时安静返回 null', () => {
    const empty = makeTmpDir();
    try {
      expect(latestDiary(empty.dir)).toBeNull();
    } finally {
      empty.cleanup();
    }
  });

  it('取最近一篇，去掉标题，压成一段', () => {
    writeFileSync(join(dir, '2026-10-24.md'), '# 十月二十四\n\n昨天很吵。\n\n我在想那句话。\n', 'utf8');
    writeFileSync(join(dir, '2026-10-25.md'), '# 十月二十五\n\n今天安静。台灯的事讲完了。\n', 'utf8');
    const entry = latestDiary(tmp.dir);
    expect(entry?.date).toBe('2026-10-25');
    expect(entry?.text).toBe('今天安静。台灯的事讲完了。');
    expect(entry?.file).toBe('memo/diary/2026-10-25.md');
  });

  it('两段之间空白压成一个空格，不保留换行', () => {
    writeFileSync(join(dir, '2026-10-25.md'), '第一段。\n\n第二段。\n', 'utf8');
    expect(latestDiary(tmp.dir)?.text).toBe('第一段。 第二段。');
  });

  it('很长的日记会截断', () => {
    writeFileSync(join(dir, '2026-10-25.md'), '字'.repeat(1000), 'utf8');
    const text = latestDiary(tmp.dir)?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(321);
    expect(text.endsWith('…')).toBe(true);
  });

  it('最新一篇只有标题就往前找，不会给一天空白', () => {
    writeFileSync(join(dir, '2026-10-24.md'), '前天的事。\n', 'utf8');
    writeFileSync(join(dir, '2026-10-25.md'), '### 只有标题\n', 'utf8');
    expect(latestDiary(tmp.dir)?.date).toBe('2026-10-24');
  });

  it('注入块说清这是她写的、不是任务', () => {
    const block = diaryBlock({ date: '2026-10-25', text: '今天安静。', file: 'memo/diary/2026-10-25.md' });
    expect(block).toContain('2026-10-25');
    expect(block).toContain('你自己写的');
    expect(block).toContain('不必复述');
  });
});

describe('最近一次交接', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let dir: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    dir = join(tmp.dir, 'handoffs');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  it('没有 handoffs 目录 → null', () => {
    const empty = makeTmpDir();
    try {
      expect(lastHandoffAt(empty.dir)).toBeNull();
    } finally {
      empty.cleanup();
    }
  });

  it('取最新那份笔记的修改时间', () => {
    const older = join(dir, '2026-10-24T10-00-00Z.md');
    const newer = join(dir, '2026-10-25T09-00-00Z.md');
    writeFileSync(older, '# 一', 'utf8');
    writeFileSync(newer, '# 二', 'utf8');
    utimesSync(older, new Date('2026-10-24T10:00:00Z'), new Date('2026-10-24T10:00:00Z'));
    utimesSync(newer, new Date('2026-10-25T09:00:00Z'), new Date('2026-10-25T09:00:00Z'));
    expect(lastHandoffAt(tmp.dir)).toBe(Date.parse('2026-10-25T09:00:00Z'));
  });
});

describe('低水位入梦', () => {
  const H = 3_600_000;
  const now = Date.parse('2026-10-25T12:00:00Z');
  const base = { now, hours: 6, today: '2026-10-25' };

  it('没到点不入梦', () => {
    expect(dreamDue({ ...base, lastHandoffAt: now - 3 * H, lastActivityAt: now - H, diaryDate: null })).toBe(false);
  });

  it('到点且这段时间有人说话 → 入梦', () => {
    expect(dreamDue({ ...base, lastHandoffAt: now - 7 * H, lastActivityAt: now - H, diaryDate: '2026-10-25' })).toBe(true);
  });

  it('到点、没人说话、今天已有日记 → 不花这次钱', () => {
    expect(dreamDue({ ...base, lastHandoffAt: now - 7 * H, lastActivityAt: now - 9 * H, diaryDate: '2026-10-25' })).toBe(false);
  });

  it('到点、没人说话、今天还没有日记 → 入梦（安静的一天也要留记录）', () => {
    expect(dreamDue({ ...base, lastHandoffAt: now - 7 * H, lastActivityAt: now - 9 * H, diaryDate: '2026-10-24' })).toBe(true);
  });

  it('设成 0 小时等于关掉', () => {
    expect(dreamDue({ ...base, hours: 0, lastHandoffAt: null, lastActivityAt: now - H, diaryDate: null })).toBe(false);
  });

  it('从没入过梦但有活动 → 入梦', () => {
    expect(dreamDue({ ...base, lastHandoffAt: null, lastActivityAt: now - H, diaryDate: '2026-10-25' })).toBe(true);
  });
});
