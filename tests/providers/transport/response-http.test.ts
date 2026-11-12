/**
 * generate 的重试策略:429 按 Retry-After 决定下一次等待,408 与网络错误同入重试集。
 * Fixture 借道共享传输。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIHttpClient } from '../../../src/providers/transport/chat.ts';
import type { NativeChatMessage } from '../../../src/providers/transport/native-types.ts';
import type { Logger, ModelSpec, ToolSchema } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

class Fixture extends OpenAIHttpClient {
  constructor(log: Logger = nullLogger()) { super('https://fixture.test', log); }
  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Record<string, unknown> {
    return { model: spec.model, messages };
  }
  protected headers(): Record<string, string> { return { 'Content-Type': 'application/json' }; }
}
const ok = () => new Response(JSON.stringify({ id: 'r1', model: 'test', choices: [{ index: 0, message: { content: 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));

describe('request body', () => {
  it('a lone surrogate in the context goes out as U+FFFD; whole pairs are kept', async () => {
    let sent = '';
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { sent = String(init.body); return ok(); });
    await new Fixture().respond({ model: 'test', input: [{ type: 'message', role: 'user', content: 'cut \ud83c here 🎤' }] });
    expect(JSON.parse(sent).messages[0].content).toBe('cut � here 🎤');
    expect(sent).not.toMatch(/\\ud83c/i);
  });
});

describe('request size', () => {
  it('上游 400 时把上一次成功的尺寸和这一次发出去的并排记下来', async () => {
    const errors: Array<{ msg: string; data?: unknown }> = [];
    const log = {
      ...nullLogger(),
      error: (msg: string, data?: unknown) => { errors.push({ msg, data }); },
    } as Logger;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response('{"error":{"message":"too big"}}', { status: 400 })));
    const client = new Fixture(log);
    await client.respond({ model: 'test', input: 'hi' });
    await expect(client.respond({ model: 'test', input: 'hi' })).rejects.toThrow();

    const hit = errors.find((line) => line.msg.includes('尺寸对照'));
    expect(hit).toBeTruthy();
    const data = hit?.data as {
      previousSuccess: { items: number; chars: number; largestItemChars: number } | null;
      failed: { items: number; chars: number; largestItemChars: number; status: number };
    };
    expect(data.previousSuccess?.items).toBeGreaterThan(0);
    expect(data.previousSuccess?.chars).toBeGreaterThan(0);
    expect(data.failed.status).toBe(400);
    expect(data.failed.items).toBe(data.previousSuccess?.items);
  });
});

describe('retry policy', () => {
  it('waits out the Retry-After interval before retrying a 429', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher);
    const promise = new Fixture().respond({ model: 'test', input: 'hi' });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ response: { status: 'completed' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries a 408 request timeout', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('timeout', { status: 408 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher);
    const promise = new Fixture().respond({ model: 'test', input: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toMatchObject({ response: { status: 'completed' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('waits out a long Retry-After; the caller signal is the only bound', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '3600' } }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher);
    const promise = new Fixture().respond({ model: 'test', input: 'hi' });
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ response: { status: 'completed' } });
  });
});

describe('network failure detail', () => {
  it('the retry log and the final error carry the cause code and message', async () => {
    vi.useFakeTimers();
    const text = 'fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate)';
    const cause = Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed', { cause }); });
    const retries: unknown[] = [];
    const log = { ...nullLogger(), warn: (_msg: string, meta?: Record<string, unknown>) => retries.push(meta?.err) };
    const promise = new Fixture(log).respond({ model: 'test', input: 'hi' });
    const settled = expect(promise).rejects.toThrow(text);
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    expect(retries.length).toBeGreaterThan(0);
    expect(new Set(retries)).toEqual(new Set([text]));
  });
});
