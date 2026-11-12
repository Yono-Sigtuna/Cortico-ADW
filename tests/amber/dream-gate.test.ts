/** 梦的节流：冷却期内交接只留笔记，到点才开一次梦。 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DREAM_COOLDOWN_MINUTES, DREAM_PENDING_KEEP, dreamGateVerdict, dreamRetryDelayMs,
  interruptedDreamState, readDreamState, settledDreamState, writeDreamState,
} from '../../bots/amber/persona/dreamGate.ts';
import { dreamDeferredNotes } from '../../bots/amber/persona/subconscious/prompts.ts';

const MINUTE = 60_000;

describe('梦的节流', () => {
  it('没做过梦、或已经过了冷却：放行', () => {
    const now = 1_000 * MINUTE;
    expect(dreamGateVerdict({ now, lastDreamAt: null })).toBeNull();
    expect(dreamGateVerdict({ now, lastDreamAt: now - DREAM_COOLDOWN_MINUTES * MINUTE })).toBeNull();
    expect(dreamGateVerdict({ now, lastDreamAt: now - 6 * 60 * MINUTE })).toBeNull();
  });

  it('冷却期内：返回还差多久，并说明这一段只留笔记', () => {
    const now = 1_000 * MINUTE;
    const verdict = dreamGateVerdict({ now, lastDreamAt: now - 15 * MINUTE })!;
    expect(verdict).toContain('15 分钟前');
    expect(verdict).toContain('45 分钟');
    expect(verdict).toContain('只留交接笔记');
  });

  it('填 0 等于关掉节流：每次交接都入梦', () => {
    const now = 1_000 * MINUTE;
    expect(dreamGateVerdict({ now, lastDreamAt: now - MINUTE, cooldownMinutes: 0 })).toBeNull();
  });

  it('状态读写：读不出来时当作没有记录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-state-'));
    const file = join(dir, 'dream-state.json');
    try {
      expect(readDreamState(file)).toEqual({ lastDreamAt: null, pending: [] });
      writeFileSync(file, '{ 坏掉的 json', 'utf8');
      expect(readDreamState(file)).toEqual({ lastDreamAt: null, pending: [] });
      expect(readDreamState(null)).toEqual({ lastDreamAt: null, pending: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('状态读写：往返不丢字段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-state-'));
    const file = join(dir, 'dream-state.json');
    try {
      const state = { lastDreamAt: 1_234, pending: ['handoffs/a.md', 'handoffs/b.md'] };
      writeDreamState(file, state);
      expect(readDreamState(file)).toEqual(state);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(state);
      expect(DREAM_PENDING_KEEP).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('被跳过的交接笔记会点名给梦，说明它们不在上下文里', () => {
    const line = dreamDeferredNotes(['handoffs/a.md', 'handoffs/b.md']);
    expect(line).toContain('handoffs/a.md, handoffs/b.md');
    expect(line).toContain('not in the context above');
    expect(line).toContain('most recent stretch only');
  });
});

describe('梦的任务核销', () => {
  const task = { id: 'd1', startedAt: 950, notes: ['handoffs/a.md'] };

  it('进程中断：in-flight 的笔记退回 pending，冷却不推进', () => {
    const state = { lastDreamAt: 900, pending: ['handoffs/b.md'], inFlight: task };
    const next = interruptedDreamState(state, 1000)!;
    expect(next.lastDreamAt).toBe(900);
    expect(next.pending).toEqual(['handoffs/a.md', 'handoffs/b.md']);
    expect(next.inFlight).toBeUndefined();
    expect(next.attempts).toBe(1);
    expect(next.nextAttemptAt).toBe(1000 + dreamRetryDelayMs(1));
  });

  it('没有 in-flight 时中断恢复什么也不做', () => {
    expect(interruptedDreamState({ lastDreamAt: 900, pending: ['a'] }, 1000)).toBeNull();
  });

  it('成功核销：lastDreamAt 用完成时刻，期间新攒的 pending 留给下一场', () => {
    const state = { lastDreamAt: 900, pending: ['handoffs/c.md'], inFlight: task };
    expect(settledDreamState(state, 'd1', true, 1200)).toEqual({
      lastDreamAt: 1200,
      pending: ['handoffs/c.md'],
    });
  });

  it('失败核销：笔记退回 pending，退避按连续失败次数增长', () => {
    const failed = settledDreamState({ lastDreamAt: 900, pending: [], inFlight: task }, 'd1', false, 1000)!;
    expect(failed.lastDreamAt).toBe(900);
    expect(failed.pending).toEqual(['handoffs/a.md']);
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAt).toBe(1000 + dreamRetryDelayMs(1));
    const again = settledDreamState({ ...failed, pending: [], inFlight: task }, 'd1', false, 2000)!;
    expect(again.attempts).toBe(2);
    expect(again.nextAttemptAt).toBe(2000 + dreamRetryDelayMs(2));
    expect(dreamRetryDelayMs(9)).toBe(120 * 60_000);
  });

  it('任务 ID 对不上时不改状态：后来那场梦的账归它自己', () => {
    const state = { lastDreamAt: 900, pending: [], inFlight: task };
    expect(settledDreamState(state, 'other', true, 1000)).toBeNull();
    expect(settledDreamState(state, 'other', false, 1000)).toBeNull();
  });

  it('状态往返：in-flight、失败次数与退避时刻都不丢', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-state-'));
    const file = join(dir, 'dream-state.json');
    try {
      const state = {
        lastDreamAt: 1, pending: ['handoffs/x.md'], inFlight: task, attempts: 2, nextAttemptAt: 3,
      };
      writeDreamState(file, state);
      expect(readDreamState(file)).toEqual(state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
