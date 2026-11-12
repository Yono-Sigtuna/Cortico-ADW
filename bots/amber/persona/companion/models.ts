/**
 * 主动联系的四段式：机会 → 证据 → 念头 → 计划。
 *
 * 抄自 AstrBot「我会永远陪着你」的核心模型，但只保留形状：
 * - **机会**是一段时间窗，过期就是没了，不排进积压（late backlog 会让"想起来了"变成"补作业"）。
 * - **念头**是"此刻能说的一个方向"，带权重；多个念头里选一个，不是全说。
 * - 选择必须是确定性的：同一个机会 + 同一个种子，永远选同一条。
 *   否则一次重试就会换一个说法，人不会这样。
 */
import { createHash } from 'node:crypto';

export type ThoughtKind = 'conversation' | 'share';

export interface Opportunity {
  id: string;
  /** 会话键：`group:730756767` / `private:3124076548`。 */
  conv: string;
  kind: string;
  openedAt: number;
  expiresAt: number;
  /** 说给谁。群里主动时只对着一个人。 */
  subject?: string;
}

export interface Thought {
  id: string;
  opportunity: Opportunity;
  kind: ThoughtKind;
  /** 给模型看的由头：一句具体的话，不是分类名。 */
  summary: string;
  weight: number;
}

export interface ThoughtSelection {
  opportunity: Opportunity;
  selected: Thought;
  feasibleCount: number;
  weightUsed: boolean;
}

/** 一个机会连同它此刻的候选念头。 */
export interface Candidate {
  opportunity: Opportunity;
  thoughts: Thought[];
}

export function digest(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 24);
}

export function opportunity(
  conv: string,
  kind: string,
  openedAt: number,
  expiresAt: number,
  subject?: string,
): Opportunity {
  return {
    id: `${kind}-${digest([conv, kind, openedAt, subject ?? ''])}`,
    conv,
    kind,
    openedAt,
    expiresAt,
    ...(subject ? { subject } : {}),
  };
}

export function thought(op: Opportunity, summary: string, weight = 1, kind: ThoughtKind = 'conversation'): Thought {
  return {
    id: `thought-${digest([op.id, summary])}`,
    opportunity: op,
    kind,
    summary,
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
  };
}

/** 过期窗口不兑现：机会没了就是没了。 */
export function isExpired(op: Opportunity, now: number): boolean {
  return now >= op.expiresAt;
}

/**
 * 至多选一个。单个候选不掷骰子（权重无意义），多个候选按种子加权。
 * 种子由调用方给稳定值（会话 + 机会 id），不要用墙钟。
 */
export function selectThought(
  op: Opportunity,
  thoughts: readonly Thought[],
  opts: { now: number; seed: string; eligible?: (t: Thought) => boolean },
): ThoughtSelection | null {
  if (isExpired(op, opts.now)) return null;
  const ok = opts.eligible ?? (() => true);
  const feasible = thoughts.filter((t) => t.opportunity.id === op.id && t.weight > 0 && ok(t));
  if (feasible.length === 0) return null;
  if (feasible.length === 1) {
    return { opportunity: op, selected: feasible[0], feasibleCount: 1, weightUsed: false };
  }
  return { opportunity: op, selected: weightedPick(feasible, opts.seed, op), feasibleCount: feasible.length, weightUsed: true };
}

/** 同一个种子必得同一条：人不会因为重试就换一个念头，只是权重高的更容易先冒出来。 */
function weightedPick(thoughts: readonly Thought[], seed: string, op: Opportunity): Thought {
  const raw = createHash('sha256').update(`${seed}\u001f${op.id}`).digest();
  const unit = Number(raw.readBigUInt64BE(0)) / 2 ** 64;
  const largest = Math.max(...thoughts.map((t) => t.weight));
  const weights = thoughts.map((t) => t.weight / largest);
  const total = weights.reduce((a, b) => a + b, 0);
  const threshold = unit * total;
  let sum = 0;
  for (let i = 0; i < thoughts.length; i++) {
    sum += weights[i];
    if (threshold < sum) return thoughts[i];
  }
  return thoughts[thoughts.length - 1];
}
