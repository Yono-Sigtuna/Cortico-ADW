/**
 * TavilyClient:Tavily Search API 的最小客户端。
 * 按 web_search 工具的 mode 决定 topic 与 include_answer / include_images,
 * 统一映射成"带编号来源的证据"(title/url/snippet)。retry/timeout 骨架:
 * 429/5xx/超时退避重试,其余错误直抛。
 */
import type { Logger } from '../../core/types.ts';
import { nullLogger } from '../../core/util.ts';

export type SearchMode = 'auto' | 'answer' | 'links' | 'news' | 'images';
export type Freshness = 'any' | 'day' | 'week' | 'month' | 'year';
export type SearchDepth = 'basic' | 'advanced';

export interface TavilyResult {
  title: string;
  url: string;
  snippet: string;
}

export interface TavilyImage {
  url: string;
  title: string;
}

export interface TavilySearchOptions {
  mode: SearchMode;
  fresh: Freshness;
  /** 期望条数(1-6,由工具层校验范围) */
  n: number;
}

export interface TavilySearchOutcome {
  /** 实际用的检索面,如实标注 */
  endpoint: string;
  /** 模型写的直接答案;没要 or 没生成时为空串 */
  answer: string;
  images: TavilyImage[];
  results: TavilyResult[];
}

export interface TavilyClientConfig {
  apiKey: string;
  searchDepth: SearchDepth;
  /** 结果偏向的国家(小写英文名,如 china);空串不发 */
  country: string;
  timeoutMs: number;
}

export class TavilyApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'TavilyApiError';
    this.status = status;
  }
}

const ENDPOINT = 'https://api.tavily.com/search';
/** 结果摘录上限:Tavily 的 content 是 1.2k 字上下的大块,全塞进上下文不划算 */
const SNIPPET_MAX = 400;
const ANSWER_MAX = 900;
const IMAGE_TITLE_MAX = 80;
/** HTTP 429 / 5xx 的有限退避间隔。 */
const RETRY_DELAYS_MS = [1000, 3000];

const TIME_RANGE: Record<Freshness, string | undefined> = {
  any: undefined,
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
};

function cleanText(s: unknown, max: number): string {
  const t = (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

interface RawTavilyResult {
  title?: string;
  url?: string;
  content?: string;
}
interface RawTavilyImage {
  url?: string;
  description?: string;
}
interface TavilySearchResponse {
  answer?: string | null;
  images?: RawTavilyImage[];
  results?: RawTavilyResult[];
}

export class TavilyClient {
  private readonly cfg: TavilyClientConfig;
  private readonly log: Logger;

  constructor(cfg: TavilyClientConfig, log: Logger = nullLogger()) {
    this.cfg = cfg;
    this.log = log;
  }

  async search(q: string, opts: TavilySearchOptions): Promise<TavilySearchOutcome> {
    const mode = opts.mode === 'auto' ? 'links' : opts.mode;
    const body: Record<string, unknown> = {
      query: q,
      search_depth: this.cfg.searchDepth,
      max_results: opts.n,
      include_answer: mode === 'answer' ? 'advanced' : false,
      include_raw_content: false,
      include_images: mode === 'images',
      include_image_descriptions: mode === 'images',
    };
    if (mode === 'news') body.topic = 'news';
    if (this.cfg.country && mode !== 'news') body.country = this.cfg.country;
    const range = TIME_RANGE[opts.fresh];
    if (range) body.time_range = range;

    const data = await this.post<TavilySearchResponse>(body);
    const results = (data.results ?? []).map((r) => ({
      title: cleanText(r.title, 120) || '(untitled)',
      url: String(r.url ?? ''),
      snippet: cleanText(r.content, SNIPPET_MAX),
    }));
    const images = mode === 'images'
      ? (data.images ?? []).slice(0, opts.n).map((i) => ({
          url: String(i.url ?? ''),
          title: cleanText(i.description, IMAGE_TITLE_MAX),
        }))
      : [];

    return {
      endpoint: mode === 'news' ? 'news' : mode === 'images' ? 'general + images' : 'general',
      answer: cleanText(data.answer, ANSWER_MAX),
      images,
      results,
    };
  }

  /** POST + 鉴权头 + 超时 + 429/5xx/超时退避重试;其余错误直抛 */
  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify(body);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        this.log.warn(`Tavily请求重试 #${attempt},等待${delay}ms`, { err: String(lastErr) });
        await new Promise((r) => setTimeout(r, delay));
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: payload,
          signal: ac.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new TavilyApiError(`Tavily API ${res.status}${detailOf(text)}`, res.status);
          if (res.status === 429 || res.status >= 500) {
            lastErr = err;
            continue;
          }
          throw err;
        }
        return JSON.parse(text) as T;
      } catch (e) {
        if (e instanceof TavilyApiError && e.status !== 429 && e.status < 500) throw e;
        // 网络错误/超时(AbortError)/可重试的TavilyApiError
        lastErr = e;
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastErr instanceof TavilyApiError) throw lastErr;
    throw new TavilyApiError(`Tavily请求失败(重试${RETRY_DELAYS_MS.length}次后放弃): ${String(lastErr)}`, 0);
  }
}

/** 错误体是 `{detail: {error}}` 或 `{detail}`;取不到就留空 */
function detailOf(text: string): string {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown })?.detail;
    const msg = typeof detail === 'string'
      ? detail
      : typeof (detail as { error?: unknown })?.error === 'string'
        ? String((detail as { error: string }).error)
        : '';
    return msg ? ` (${msg})` : '';
  } catch {
    return '';
  }
}
