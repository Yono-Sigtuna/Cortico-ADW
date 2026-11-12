/** Immutable per-call input metadata, independent of the WebUI runtime. */
import type { Request, Response } from '../protocol/open-responses/index.ts';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import type { PromptTransportSnapshot } from './generation.ts';
export interface PromptSummary {
  id: string;
  run: string;
  sequence: number;
  sessionId: string;
  role: string;
  round: number | null;
  turnId?: string;
  turnRound?: number;
  outputCount?: number;
  toolCallCount?: number;
  toolResultCount?: number;
  model: string;
  startedAt: string;
  finishedAt?: string;
  responseId?: string;
  outcome: 'pending' | 'completed' | 'failed' | 'aborted';
  attempts: number;
  storageError: boolean;
}
export interface PromptTurn {
  id: string;
  run: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  calls: number;
}
export interface PromptResult {
  response: Response | null;
  partial: boolean;
  error?: { name: string; message: string; status?: number };
}
export interface PromptDetail {
  summary: PromptSummary;
  request: Request;
  context: readonly ContextRecord[] | null;
  attempts: PromptTransportSnapshot[];
  result?: PromptResult;
  toolResults?: ContextRecord[];
}
export interface PromptList {
  recorded: boolean;
  items: PromptSummary[];
  nextBefore: number | null;
  turns?: PromptTurn[];
}
