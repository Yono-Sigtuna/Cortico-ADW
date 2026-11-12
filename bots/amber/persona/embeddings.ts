/**
 * 向量化客户端：把一条记忆/一句查询变成向量，用于语义召回。
 *
 * 只是 BM25 的补充——调用失败、没配 key、超时，都退回纯关键词检索，
 * 记忆系统的其余部分不受影响。
 */
export interface EmbeddingOptions {
  /** OpenAI 兼容的 embeddings 端点根地址，例如 https://host/v1 */
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  /** 一次最多送多少条。 */
  batchSize?: number;
}

export interface EmbeddingClient {
  readonly model: string;
  /** `query` 与 `passage` 分开：检索模型通常按用途区分向量。 */
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_BATCH = 8;

/** 向量调用的计数与最近一次失败。面板拿 `lastError` 报警，不用去翻日志。 */
export interface EmbeddingStats {
  query: number;
  passage: number;
  failures: number;
  lastMs: number | null;
  lastError: { at: number; text: string } | null;
}

/**
 * 把一次 fetch 失败摊开写进日志。
 *
 * Node 的 fetch 失败时只会说 "fetch failed"，真正的原因在 `err.cause` 里：
 * `ECONNRESET`、`UND_ERR_CONNECT_TIMEOUT`、`ENOTFOUND`、TLS 告警……
 * 不把它带出来，日志里就只剩一句"失败了"，分不清是网络、DNS 还是证书。
 */
export function describeFetchError(error: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { err: String(error) };
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    out.cause = `${cause.name}: ${cause.message}`;
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') out.code = code;
    const inner = (cause as { cause?: unknown }).cause;
    if (inner instanceof Error) out.cause2 = `${inner.name}: ${inner.message}`;
  } else if (cause !== undefined) {
    out.cause = String(cause);
  }
  return out;
}

export class HttpEmbeddingClient implements EmbeddingClient {
  readonly model: string;

  constructor(private readonly opts: EmbeddingOptions) {
    this.model = opts.model;
  }

  async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    const size = this.opts.batchSize ?? DEFAULT_BATCH;
    for (let i = 0; i < texts.length; i += size) {
      out.push(...await this.one(texts.slice(i, i + size), kind));
    }
    return out;
  }

  private async one(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT);
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: texts,
          model: this.model,
          input_type: kind,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`向量服务返回 ${res.status}: ${detail.slice(0, 200)}`);
      }
      const body = await res.json() as { data?: Array<{ embedding?: number[] }> };
      const rows = body.data ?? [];
      if (rows.length !== texts.length) {
        throw new Error(`向量条数不符：要 ${texts.length} 条，拿到 ${rows.length} 条`);
      }
      return rows.map((row) => {
        const vec = row.embedding ?? [];
        if (!vec.length) throw new Error('向量为空');
        return Float32Array.from(vec);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 向量存成 BLOB：先写长度，再按小端 float32 排列，读回时维度可校验。 */
export function encodeVector(vec: Float32Array): Uint8Array {
  const out = new Uint8Array(4 + vec.length * 4);
  new DataView(out.buffer).setUint32(0, vec.length, true);
  out.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), 4);
  return out;
}

export function decodeVector(raw: Uint8Array | null | undefined): Float32Array | null {
  if (!raw || raw.byteLength < 4) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const dim = view.getUint32(0, true);
  if (dim === 0 || raw.byteLength !== 4 + dim * 4) return null;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = view.getFloat32(4 + i * 4, true);
  return out;
}

/** 余弦相似度；任一向量为零向量时返回 0。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
