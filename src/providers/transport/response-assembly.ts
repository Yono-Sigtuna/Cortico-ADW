import { createResponse, type OutputItem, type Request, type Response, type StreamEvent } from '../../protocol/open-responses/index.ts';
import { ResponseAccumulator, ResponseProtocolError } from '../../protocol/open-responses/stream.ts';
import { standardUsage, unknownMeters, type TokenMeters } from '../../core/generation.ts';
import { chatMeters, responseMeters } from './response-meters.ts';

export interface ResponseAssembly {
  feed(payload: unknown, emit: (event: StreamEvent) => void): void;
  finish(emit: (event: StreamEvent) => void): Response;
  snapshot(): Response | null;
  meters(): TokenMeters;
  serviceTier(): string | null;
}

/**
 * In a completed response, function calls without a status become `completed`; items that carry a
 * status and responses that are not completed pass through unchanged. Some Responses-compatible
 * endpoints omit the item status, and Core executes only calls whose status is `completed`.
 */
export function normalizeCompletedFunctionCalls(response: Response): Response {
  if (response.status !== 'completed') return response;
  let changed = false;
  const output = response.output.map((item) => {
    if (item.type !== 'function_call') return item;
    const status = (item as unknown as { status?: string | null }).status;
    if (status !== undefined && status !== null) return item;
    changed = true;
    return { ...item, status: 'completed' as const };
  });
  return changed ? { ...response, output } : response;
}

/** 正文增量该挂在哪一段上：`summary` 走 summary_index，其余走 content_index。 */
interface MissingPart {
  summary: boolean;
  type: 'output_text' | 'refusal' | 'reasoning_text' | 'summary_text';
}

const DELTA_PARTS: Record<string, MissingPart> = {
  'response.output_text.delta': { summary: false, type: 'output_text' },
  'response.refusal.delta': { summary: false, type: 'refusal' },
  'response.reasoning.delta': { summary: false, type: 'reasoning_text' },
  'response.reasoning_summary_text.delta': { summary: true, type: 'summary_text' },
};

function emptyPart(type: MissingPart['type']): Record<string, unknown> {
  if (type === 'refusal') return { type: 'refusal', refusal: '' };
  if (type === 'output_text') return { type: 'output_text', text: '', annotations: [] };
  return { type, text: '' };
}

/**
 * Validate native Responses Items before notifying observers.
 * Normalize response.reasoning_text.* to the schema name response.reasoning.* before validation.
 * Endpoints that skip `content_part.added` get it filled in before the delta reaches validation.
 */
export class NativeResponseAssembly implements ResponseAssembly {
  private readonly accumulator = new ResponseAccumulator();
  private usage = unknownMeters();
  private tier: string | null = null;
  /** 已经开过的段落：`<item>/<content|summary>/<index>`。 */
  private readonly parts = new Set<string>();
  /** 补进流里的段落条数：后续事件的序列号整体后移这么多，保持严格递增。 */
  private shift = 0;
  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    if (!payload || typeof payload !== 'object') throw new ResponseProtocolError('Invalid native Responses event');
    if ('type' in payload && (payload.type === 'response.reasoning_text.delta' || payload.type === 'response.reasoning_text.done'))
      payload = { ...payload, type: payload.type.replace('reasoning_text', 'reasoning') };
    let event = payload as StreamEvent;
    if ('response' in event) {
      const raw = event.response;
      if (!raw || typeof raw.id !== 'string' || typeof raw.model !== 'string' || !Array.isArray(raw.output)) throw new ResponseProtocolError('Invalid native Responses resource');
      if (typeof raw.service_tier === 'string') this.tier = raw.service_tier;
      if (raw.usage) this.usage = responseMeters(raw.usage);
      event = { ...event, response: { ...createResponse(raw.id, { model: raw.model }), ...raw, usage: standardUsage(this.usage) } };
    }
    const forwarded = this.openMissingPart(event, emit);
    this.accumulator.accept(forwarded);
    emit(forwarded);
    if (forwarded.type === 'error') throw new ResponseProtocolError(`Native response error: ${JSON.stringify(forwarded)}`);
  }

  /**
   * 有的 Responses 兼容端点只发 `output_item.added` 和正文增量，中间那条 `content_part.added` 从来不发。
   * 规范里增量挂在段落上，少了段落整条流会被判成乱序（`Delta before content part`），一次都收不进来。
   * 这里在增量到达前把缺的那一段补成空的——只补段落，内容仍由增量累加。
   *
   * 序列号必须严格递增，补进来的一条要占号，所以从它往后的事件统一后移一位（`shift`）。
   */
  private openMissingPart(event: StreamEvent, emit: (event: StreamEvent) => void): StreamEvent {
    const raw = event as unknown as {
      type: string; item_id?: unknown; output_index?: unknown; content_index?: unknown;
      summary_index?: unknown; sequence_number?: number;
    };
    if (raw.type === 'response.content_part.added' || raw.type === 'response.reasoning_summary_part.added') {
      this.mark(raw);
    }
    const kind = DELTA_PARTS[raw.type];
    const index = kind ? (kind.summary ? raw.summary_index : raw.content_index) : undefined;
    const inject = kind !== undefined && typeof raw.item_id === 'string' && typeof index === 'number'
      && !this.parts.has(`${raw.item_id}/${kind.summary ? 'summary' : 'content'}/${index}`);
    if (!inject || !kind || typeof index !== 'number') {
      return { ...event, sequence_number: (raw.sequence_number ?? 0) + this.shift } as StreamEvent;
    }
    this.parts.add(`${raw.item_id}/${kind.summary ? 'summary' : 'content'}/${index}`);
    const base = (raw.sequence_number ?? 0) + this.shift;
    const part = emptyPart(kind.type);
    const synthetic = kind.summary
      ? { type: 'response.reasoning_summary_part.added', sequence_number: base,
          item_id: raw.item_id, output_index: raw.output_index ?? 0, summary_index: index, part }
      : { type: 'response.content_part.added', sequence_number: base,
          item_id: raw.item_id, output_index: raw.output_index ?? 0, content_index: index, part };
    const forwarded = synthetic as unknown as StreamEvent;
    this.accumulator.accept(forwarded);
    emit(forwarded);
    this.shift += 1;
    return { ...event, sequence_number: base + 1 } as StreamEvent;
  }

  private mark(event: { item_id?: unknown; content_index?: unknown; summary_index?: unknown }): void {
    if (typeof event.item_id !== 'string') return;
    const summary = typeof event.summary_index === 'number';
    const index = summary ? event.summary_index : event.content_index;
    if (typeof index !== 'number') return;
    this.parts.add(`${event.item_id}/${summary ? 'summary' : 'content'}/${index}`);
  }
  finish(): Response { return normalizeCompletedFunctionCalls(this.accumulator.finish()); }
  snapshot(): Response | null { return this.accumulator.snapshot(); }
  serviceTier(): string | null { return this.tier; }
  meters(): TokenMeters { return structuredClone(this.usage); }
}

type NativeChunk = {
  id?: string; model?: string; service_tier?: string;
  choices?: Array<{ index?: number; finish_reason?: string | null; delta?: {
    content?: string | null; refusal?: string | null; reasoning_content?: string | null;
    tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
  } }>;
  usage?: Record<string, unknown> | null;
};
type MutableOutput = { id: string; type: string; status?: string; content?: any[]; summary?: any[]; call_id?: string; name?: string; arguments?: string; role?: string };

/** Chat's finish_reason closes its Items; a new tool index never closes a previous call. */
export class ChatResponseAssembly implements ResponseAssembly {
  private readonly response: Response;
  private readonly accumulator = new ResponseAccumulator();
  private sequence = 0;
  private started = false;
  private finishReason: string | null = null;
  private usage = unknownMeters();
  private tier: string | null = null;
  private readonly calls = new Map<number, number>();
  private readonly textSlots = new Map<string, number>();
  private readonly pendingCalls = new Map<number, NonNullable<NonNullable<NonNullable<NativeChunk['choices']>[number]['delta']>['tool_calls']>>();
  private readonly output: MutableOutput[] = [];
  /** The Item that received the last delta is the one a length or filter stop cut short. */
  private lastTouched: number | null = null;

  constructor(request: Request) { this.response = createResponse(`resp_${crypto.randomUUID()}`, request); }

  private send(event: Record<string, unknown>, emit: (event: StreamEvent) => void): void {
    const complete = structuredClone({ ...event, sequence_number: this.sequence++ }) as StreamEvent;
    this.accumulator.accept(complete);
    emit(complete);
  }
  private start(chunk: NativeChunk, emit: (event: StreamEvent) => void): void {
    if (this.started) return;
    if (chunk.id) this.response.id = chunk.id;
    if (chunk.model) this.response.model = chunk.model;
    this.send({ type: 'response.created', response: this.response }, emit);
    this.started = true;
  }
  private add(index: number, item: MutableOutput, emit: (event: StreamEvent) => void): void {
    if (this.output[index]) throw new ResponseProtocolError('Native Chat output indices overlap');
    this.output[index] = item;
    this.send({ type: 'response.output_item.added', output_index: index, item }, emit);
  }
  private text(kind: 'reasoning' | 'content' | 'refusal', delta: string, emit: (event: StreamEvent) => void): void {
    let index = this.textSlots.get(kind);
    if (index === undefined) {
      index = this.output.length;
      const item = kind === 'reasoning'
        ? { type: 'reasoning', id: `rs_${crypto.randomUUID()}`, summary: [], content: [] }
        : { type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'in_progress', content: [] };
      this.add(index, item, emit);
      this.textSlots.set(kind, index);
      const part = kind === 'reasoning' ? { type: 'reasoning_text', text: '' }
        : kind === 'refusal' ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
      this.send({ type: 'response.content_part.added', output_index: index, item_id: item.id, content_index: 0, part }, emit);
      this.output[index].content = [part];
    }
    const item = this.output[index];
    this.send({ type: kind === 'reasoning' ? 'response.reasoning.delta' : kind === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta',
      output_index: index, item_id: item.id, content_index: 0, delta, ...(kind === 'content' ? { logprobs: [] } : {}) }, emit);
    const field = kind === 'refusal' ? 'refusal' : 'text';
    item.content![0][field] += delta;
    this.lastTouched = index;
  }
  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    const chunk = payload as NativeChunk;
    this.start(chunk, emit);
    if (chunk.usage) this.usage = chatMeters(chunk.usage);
    if (chunk.service_tier) this.response.service_tier = this.tier = chunk.service_tier;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.index !== undefined && choice.index !== 0) throw new ResponseProtocolError('Multiple Chat choices are unsupported');
    const delta = choice.delta;
    if (delta?.reasoning_content) this.text('reasoning', delta.reasoning_content, emit);
    if (delta?.content) this.text('content', delta.content, emit);
    if (delta?.refusal) this.text('refusal', delta.refusal, emit);
    for (const call of delta?.tool_calls ?? []) {
      if (!Number.isInteger(call.index) || call.index < 0) throw new ResponseProtocolError('Invalid native tool index');
      const pending = this.pendingCalls.get(call.index) ?? [];
      pending.push(call);
      this.pendingCalls.set(call.index, pending);
    }
    for (const nativeIndex of [...this.pendingCalls.keys()].sort((a, b) => a - b)) {
      if (!this.calls.has(nativeIndex) && nativeIndex !== this.calls.size) break;
      for (const call of this.pendingCalls.get(nativeIndex)!) {
        let index = this.calls.get(call.index);
        if (index === undefined) {
          if (!call.id || !call.function?.name) throw new ResponseProtocolError('Native function call lacks identity');
          index = this.output.length;
          this.calls.set(call.index, index);
          this.add(index, { type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: call.id,
            name: call.function.name, arguments: '', status: 'in_progress' }, emit);
        }
        const item = this.output[index];
        if ((call.id && call.id !== item.call_id) || (call.function?.name && call.function.name !== item.name)) throw new ResponseProtocolError('Native function identity changed');
        const fragment = call.function?.arguments;
        if (fragment) {
          this.send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: fragment }, emit);
          item.arguments += fragment;
        }
        this.lastTouched = index;
      }
      this.pendingCalls.delete(nativeIndex);
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }
  /** A length or content-filter stop cuts only the Item that was still being written; earlier Items are complete. */
  finish(emit: (event: StreamEvent) => void): Response {
    if (!this.finishReason) throw new ResponseProtocolError('Chat transport ended without finish_reason');
    if (this.pendingCalls.size) throw new ResponseProtocolError('Missing native function index');
    const incomplete = this.finishReason === 'length' || this.finishReason === 'content_filter';
    for (let index = 0; index < this.output.length; index++) {
      const item = this.output[index];
      if (!item) throw new ResponseProtocolError('Missing native function index');
      if (item.type === 'function_call') {
        this.send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments }, emit);
      } else {
        const part = item.content![0];
        this.send({ type: 'response.content_part.done', output_index: index, item_id: item.id, content_index: 0, part }, emit);
      }
      if (item.type !== 'reasoning') item.status = incomplete && index === this.lastTouched ? 'incomplete' : 'completed';
      this.send({ type: 'response.output_item.done', output_index: index, item }, emit);
    }
    this.response.output = this.output as OutputItem[];
    this.response.usage = standardUsage(this.usage);
    this.response.status = incomplete ? 'incomplete' : 'completed';
    this.response.completed_at = Math.floor(Date.now() / 1000);
    this.response.incomplete_details = incomplete ? { reason: this.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } : null;
    this.send({ type: `response.${this.response.status}`, response: this.response }, emit);
    return this.accumulator.finish();
  }
  snapshot(): Response | null { return this.accumulator.snapshot(); }
  serviceTier(): string | null { return this.tier; }
  meters(): TokenMeters { return structuredClone(this.usage); }
}

export function parseChatResponse(raw: unknown, request: Request): { response: Response; meters: TokenMeters; serviceTier: string | null } {
  const data = raw as { id?: string; model?: string; usage?: Record<string, unknown>; choices?: Array<{ index?: number; finish_reason?: string | null; message?: Record<string, any> }> };
  const choice = data.choices?.[0] as { message?: Record<string, any>; finish_reason?: string | null } | undefined;
  if (!choice?.message) throw new ResponseProtocolError('Native Chat response lacks choices[0].message');
  const assembler = new ChatResponseAssembly(request);
  assembler.feed({ ...data, choices: [{ index: 0, delta: { ...choice.message,
    tool_calls: choice.message.tool_calls?.map((call: any, index: number) => ({ ...call, index })) }, finish_reason: choice.finish_reason }] }, () => {});
  const response = assembler.finish(() => {});
  return { response, meters: assembler.meters(), serviceTier: assembler.serviceTier() };
}
