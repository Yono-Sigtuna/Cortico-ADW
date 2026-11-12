/** Immutable model inputs under data/runs/<run>/prompts; the index contains summaries only. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fstatSync, readSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request } from '../protocol/open-responses/index.ts';
import { GenerationError, type GenerateOptions, type ResponseClient, type PromptTransportSnapshot } from './generation.ts';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import { currentAnchors } from './log-context.ts';
import type { PromptSummary, PromptDetail, PromptList, PromptTurn, PromptResult } from './prompt-types.ts';

function appendLine(file: string, row: unknown): void {
  if (existsSync(file)) {
    const fd = openSync(file, 'r+');
    try {
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10) {
        const bytes = readFileSync(file);
        ftruncateSync(fd, bytes.lastIndexOf(10) + 1);
      }
    } finally { closeSync(fd); }
  }
  appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}
function lines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  // A crash may leave the final append without its terminating newline.
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  return complete.split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}
function promptDir(dataDir: string, run: string): string {
  if (!/^r-[A-Za-z0-9-]+$/.test(run)) throw new Error('Invalid run id');
  return join(dataDir, 'runs', run, 'prompts');
}
function validId(id: string): void {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid prompt id');
}
function summaries(dir: string): PromptSummary[] {
  const latest = new Map<string, PromptSummary>();
  for (const row of lines<PromptSummary>(join(dir, 'index.jsonl'))) latest.set(row.id, row);
  return [...latest.values()].sort((a, b) => b.sequence - a.sequence);
}
export function readPromptList(dataDir: string, run: string, opts: { session?: string; before?: number; limit?: number } = {}): PromptList {
  const dir = promptDir(dataDir, run);
  const all = summaries(dir).filter(row => (!opts.session || row.sessionId === opts.session) && (opts.before === undefined || row.sequence < opts.before));
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const items = all.slice(0, limit);
  const ids = new Set(items.map(row => row.turnId).filter(Boolean));
  const turns = new Map<string, PromptTurn>();
  for (const turn of lines<PromptTurn>(join(dir, 'turns.jsonl'))) if (ids.has(turn.id)) turns.set(turn.id, turn);
  return { recorded: existsSync(join(dir, 'index.jsonl')), items, nextBefore: all.length > items.length ? items.at(-1)!.sequence : null,
    turns: [...turns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)) };
}
export function readPromptDetail(dataDir: string, run: string, id: string): PromptDetail | null {
  const dir = promptDir(dataDir, run); validId(id);
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  const input = JSON.parse(readFileSync(file, 'utf8')) as Omit<PromptDetail, 'summary' | 'attempts'>;
  const summary = summaries(dir).find(row => row.id === id);
  if (!summary) return null;
  const resultFile = join(dir, `${id}.result.json`);
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) as PromptResult : undefined;
  return { ...input, summary, attempts: lines<PromptTransportSnapshot>(join(dir, `${id}.attempts.jsonl`)),
    ...(result ? { result } : {}), toolResults: lines<ContextRecord>(join(dir, `${id}.tools.jsonl`)) };
}

export class PromptLog {
  private readonly dir: string;
  private sequence = 0;
  private listeners: Array<(row: PromptSummary) => void> = [];
  private turnListeners: Array<(turn: PromptTurn) => void> = [];
  private activeTurns = new Map<string, PromptTurn>();
  private toolCalls = new Map<string, { id: string; summary: PromptSummary; publish: () => void }>();
  constructor(runDir: string, private readonly run: string, private readonly onError: (message: string) => void) {
    this.dir = join(runDir, 'prompts');
    this.safe(() => { mkdirSync(this.dir, { recursive: true }); this.sequence = summaries(this.dir)[0]?.sequence ?? 0; });
  }
  onChange(cb: (row: PromptSummary) => void): void { this.listeners.push(cb); }
  onTurnChange(cb: (turn: PromptTurn) => void): void { this.turnListeners.push(cb); }
  private publishTurn(turn: PromptTurn): void {
    this.safe(() => appendLine(join(this.dir, 'turns.jsonl'), turn));
    for (const cb of this.turnListeners) { try { cb({ ...turn }); } catch { /* Observer isolation. */ } }
  }
  beginTurn(sessionId: string): { id: string; end(): void } {
    const turn: PromptTurn = { id: randomUUID(), run: this.run, sessionId, startedAt: new Date().toISOString(), calls: 0 };
    this.activeTurns.set(turn.id, turn); this.publishTurn(turn);
    return { id: turn.id, end: () => {
      if (!this.activeTurns.delete(turn.id)) return;
      turn.endedAt = new Date().toISOString(); this.publishTurn(turn);
      for (const [key, call] of this.toolCalls) if (call.summary.turnId === turn.id) this.toolCalls.delete(key);
    } };
  }
  recordToolResult(record: ContextRecord, sessionId: string): void {
    if (record.item.type !== 'function_call_output') return;
    const key = JSON.stringify([sessionId, record.item.call_id]);
    const call = this.toolCalls.get(key); if (!call) return;
    if (!this.safe(() => appendLine(join(this.dir, `${call.id}.tools.jsonl`), record))) call.summary.storageError = true;
    call.summary.toolResultCount = (call.summary.toolResultCount ?? 0) + 1;
    call.publish(); this.toolCalls.delete(key);
  }
  private safe(fn: () => void): boolean {
    try { fn(); return true; } catch (error) {
      try { this.onError(`Prompt snapshot storage failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* Observers do not change generation. */ }
      return false;
    }
  }
  start(request: Request, options: GenerateOptions = {}) {
    const anchors = currentAnchors();
    const summary: PromptSummary = {
      id: randomUUID(), run: this.run, sequence: ++this.sequence,
      sessionId: options.sessionId ?? anchors.sess ?? '', role: options.role ?? '',
      round: options.round ?? anchors.round ?? null, startedAt: new Date().toISOString(),
      ...(options.turnId ? { turnId: options.turnId, turnRound: options.turnRound } : {}),
      model: request.model ?? '', outcome: 'pending', attempts: 0, storageError: false,
    };
    const publish = () => {
      if (!this.safe(() => appendLine(join(this.dir, 'index.jsonl'), summary))) summary.storageError = true;
      for (const cb of this.listeners) { try { cb({ ...summary }); } catch { /* Observer isolation. */ } }
    };
    const turn = options.turnId ? this.activeTurns.get(options.turnId) : undefined;
    if (turn) { turn.calls++; this.publishTurn(turn); }
    const saved = this.safe(() => writeFileSync(join(this.dir, `${summary.id}.json`), JSON.stringify({ request, context: options.context ?? null }), { encoding: 'utf8', flag: 'wx' }));
    summary.storageError = !saved; publish();
    return {
      transport: (info: PromptTransportSnapshot) => {
        const { generationId, attemptId, ordinal, startedAt, body, diagnostic } = info;
        const snapshot = { generationId, attemptId, ordinal, startedAt, body, diagnostic };
        if (!this.safe(() => appendLine(join(this.dir, `${summary.id}.attempts.jsonl`), snapshot))) summary.storageError = true;
        summary.attempts++; publish();
      },
      finish: (outcome: 'completed' | 'failed' | 'aborted', responseId?: string, result?: PromptResult) => {
        if (result) {
          if (!this.safe(() => writeFileSync(join(this.dir, `${summary.id}.result.json`), JSON.stringify(result), { encoding: 'utf8', flag: 'wx' }))) summary.storageError = true;
          summary.outputCount = result.response?.output.length ?? 0;
          summary.toolCallCount = result.response?.output.filter(item => item.type === 'function_call').length ?? 0;
          for (const item of result.response?.output ?? []) if (item.type === 'function_call') {
            this.toolCalls.set(JSON.stringify([summary.sessionId, item.call_id]), { id: summary.id, summary, publish });
          }
        }
        summary.outcome = outcome; summary.finishedAt = new Date().toISOString();
        if (responseId) summary.responseId = responseId;
        publish();
      },
    };
  }
}

/** Binding captures the underlying endpoint once; every subsequent call still gets its own snapshot. */
export function observeResponseClient(client: ResponseClient, log: PromptLog): ResponseClient {
  return {
    ...(client.bind ? { bind: () => observeResponseClient(client.bind!(), log) } : {}),
    respond: async (request, options = {}) => {
      const capture = log.start(request, options);
      try {
        const result = await client.respond(request, { ...options, onRequest: info => {
          capture.transport(info);
          try { options.onRequest?.(info); } catch { /* Observer isolation. */ }
        } });
        capture.finish('completed', result.response.id, { response: result.response, partial: result.response.status !== 'completed' });
        return result;
      } catch (error) {
        const partial = error instanceof GenerationError ? error.partial : null;
        capture.finish(options.signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'aborted' : 'failed', partial?.id,
          { response: partial, partial: !!partial, error: { name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error), ...(error instanceof GenerationError ? { status: error.status } : {}) } });
        throw error;
      }
    },
  };
}
