/**
 * 梦的节流。
 *
 * 交接由上下文填满决定，热闹时十几分钟一次。梦要是跟着交接走，同一段群聊会被整理
 * 好几遍，而每次梦都要把当时的整段上下文重读二三十轮——一笔开销换不来第二份记忆。
 * 这里只回答一个问题：这次交接值不值得开一次梦。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 两次梦之间至少隔多少分钟；填 0 表示每次交接都入梦。 */
export const DREAM_COOLDOWN_MINUTES = 60;

/** 冷却期内最多记住几份没整理的交接笔记。 */
export const DREAM_PENDING_KEEP = 12;

/** 梦失败后的退避起点（分钟）；每失败一次翻倍，封顶两小时。 */
export const DREAM_RETRY_MINUTES = 15;

/** 一次已排队的整理。成功核销之前它一直留在状态里，重启后据此恢复。 */
export interface DreamTask {
  id: string;
  startedAt: number;
  /** 这次梦要消化的交接笔记（工作区相对路径）。 */
  notes: string[];
}

export interface DreamState {
  /** 上一次**成功完成**的梦的时刻；失败不推进它。 */
  lastDreamAt: number | null;
  /** 冷却期内交接、还没被任何一场梦看过的笔记（工作区相对路径）。 */
  pending: string[];
  /** 已排队或进行中的整理；成功才消费，进程中断后据此把笔记退回 pending。 */
  inFlight?: DreamTask;
  /** 连续失败次数；成功清零。 */
  attempts?: number;
  /** 失败退避到此为止；到点前不再重试。 */
  nextAttemptAt?: number;
}

export interface DreamGateInput {
  now: number;
  /** 上一次梦开始的时刻（毫秒）；0 或 null 表示从没做过。 */
  lastDreamAt: number | null;
  cooldownMinutes?: number;
}

/** 可以入梦返回 null；这次先只留交接笔记就返回一句话原因。 */
export function dreamGateVerdict(input: DreamGateInput): string | null {
  const cooldown = input.cooldownMinutes ?? DREAM_COOLDOWN_MINUTES;
  if (!Number.isFinite(cooldown) || cooldown <= 0) return null;
  const last = input.lastDreamAt;
  if (!last || !Number.isFinite(last)) return null;
  const wait = cooldown * 60_000;
  const elapsed = input.now - last;
  if (elapsed >= wait) return null;
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  const left = Math.max(1, Math.ceil((wait - elapsed) / 60_000));
  return `上一次整理在 ${minutes} 分钟前，还差约 ${left} 分钟；这一段先只留交接笔记。`;
}

export function readDreamState(file: string | null): DreamState {
  if (!file) return { lastDreamAt: null, pending: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const last = typeof raw.lastDreamAt === 'number' && Number.isFinite(raw.lastDreamAt) ? raw.lastDreamAt : null;
    const pending = Array.isArray(raw.pending) ? raw.pending.filter((n): n is string => typeof n === 'string') : [];
    const state: DreamState = { lastDreamAt: last, pending };
    // 旧文件没有这几项；只在存在时带上，读出来的形状保持兼容。
    const task = raw.inFlight as Record<string, unknown> | undefined;
    if (task && typeof task.id === 'string' && typeof task.startedAt === 'number' && Array.isArray(task.notes)) {
      state.inFlight = {
        id: task.id,
        startedAt: task.startedAt,
        notes: task.notes.filter((n): n is string => typeof n === 'string'),
      };
    }
    if (typeof raw.attempts === 'number' && Number.isFinite(raw.attempts)) state.attempts = raw.attempts;
    if (typeof raw.nextAttemptAt === 'number' && Number.isFinite(raw.nextAttemptAt)) {
      state.nextAttemptAt = raw.nextAttemptAt;
    }
    return state;
  } catch {
    return { lastDreamAt: null, pending: [] };
  }
}

/** 读不出来或写不进去都等于没有记录：下一次交接照常入梦。 */
export function writeDreamState(file: string | null, state: DreamState): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 1), 'utf8');
  } catch {
    /* 记不上就退回每次交接都入梦 */
  }
}

/** 失败退避：15 分钟起，每次翻倍，封顶两小时。 */
export function dreamRetryDelayMs(attempts: number): number {
  const step = Math.max(1, Math.min(attempts, 4));
  return Math.min(DREAM_RETRY_MINUTES * 2 ** (step - 1), 120) * 60_000;
}

function mergeNotes(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].slice(-DREAM_PENDING_KEEP);
}

/**
 * 进程在排队/整理途中退出：把这次要消化的笔记退回 pending，冷却不推进。
 * 返回 null 表示没有待恢复的任务。
 */
export function interruptedDreamState(state: DreamState, now: number): DreamState | null {
  if (!state.inFlight) return null;
  const attempts = (state.attempts ?? 0) + 1;
  return {
    lastDreamAt: state.lastDreamAt,
    pending: mergeNotes(state.inFlight.notes, state.pending),
    attempts,
    nextAttemptAt: now + dreamRetryDelayMs(attempts),
  };
}

/**
 * 一次整理结束后的状态：成功才推进 lastDreamAt 并核销；失败把笔记退回 pending。
 * taskId 对不上（已被后来的任务覆盖）时返回 null，不替别人改状态。
 */
export function settledDreamState(state: DreamState, taskId: string, ok: boolean, now: number): DreamState | null {
  if (state.inFlight?.id !== taskId) return null;
  if (ok) return { lastDreamAt: now, pending: state.pending };
  const attempts = (state.attempts ?? 0) + 1;
  return {
    lastDreamAt: state.lastDreamAt,
    pending: mergeNotes(state.inFlight.notes, state.pending),
    attempts,
    nextAttemptAt: now + dreamRetryDelayMs(attempts),
  };
}
