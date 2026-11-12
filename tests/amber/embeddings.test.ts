/** 向量：编解码、余弦、以及"关键词搜不到时靠语义找回"。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryIndex } from '../../bots/amber/persona/memoryIndex.ts';
import { cosine, decodeVector, describeFetchError, encodeVector } from '../../bots/amber/persona/embeddings.ts';

describe('向量工具', () => {
  it('编码后能原样读回，维度不符时返回 null', () => {
    const vec = Float32Array.from([0.5, -0.25, 1]);
    const raw = encodeVector(vec);
    const back = decodeVector(raw);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual([0.5, -0.25, 1]);
    expect(decodeVector(raw.slice(0, raw.length - 2))).toBeNull();
    expect(decodeVector(null)).toBeNull();
  });

  it('余弦：同向为 1，正交为 0，零向量为 0', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1, 5);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
    expect(cosine(Float32Array.from([1]), Float32Array.from([1, 1]))).toBe(0);
  });
});

describe('向量召回', () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex(':memory:');
  });

  afterEach(() => index.close());

  it('关键词完全搜不到时，向量能把语义相近的那条找回来', () => {
    const a = index.put({ text: '群主说他面试又失败了。', kind: 'episodic', importance: 0.6 });
    const b = index.put({ text: '今天群里在聊新显卡。', kind: 'episodic', importance: 0.6 });
    index.storeVector(a, Float32Array.from([1, 0]), 'test-model');
    index.storeVector(b, Float32Array.from([0, 1]), 'test-model');

    // 查询词与两条都没有字面重叠，只能靠向量。
    const hits = index.recall('工作不顺', { queryVector: Float32Array.from([0.98, 0.2]), k: 2 });
    expect(hits[0].text).toContain('面试');
    expect(hits[0].breakdown.vector).toBeGreaterThan(hits[1].breakdown.vector);
  });

  it('缺向量的条目会被列为待补，写入后不再重复', () => {
    const id = index.put({ text: '一条还没向量化的记忆。', kind: 'factual', importance: 0.5 });
    expect(index.pendingVectors('m1', 10).map((p) => p.id)).toEqual([id]);
    index.storeVector(id, Float32Array.from([1, 0]), 'm1');
    expect(index.pendingVectors('m1', 10)).toEqual([]);
    expect(index.vectorCount('m1')).toBe(1);
    // 换模型视为缺失，需要重算。
    expect(index.pendingVectors('m2', 10).map((p) => p.id)).toEqual([id]);
  });

  it('向量命中也会进自动注入', () => {
    const a = index.put({ text: '群主说他面试又失败了。', kind: 'episodic', importance: 0.6 });
    index.storeVector(a, Float32Array.from([1, 0]), 'test-model');
    const block = index.injectBlock('工作不顺', 3, 700, { queryVector: Float32Array.from([0.99, 0.1]) });
    expect(block).toContain('面试');
    // 语义上不沾边时不注入。
    expect(index.injectBlock('工作不顺', 3, 700, { queryVector: Float32Array.from([0, 1]) })).toBeNull();
  });
});

describe('fetch 失败的可读化', () => {
  it('把 Node 藏在 cause 里的真实原因带出来', () => {
    // Node 只会说 "TypeError: fetch failed"；真正是 ECONNRESET 还是超时，在 cause 里。
    const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
    const out = describeFetchError(outer);
    expect(out.err).toBe('TypeError: fetch failed');
    expect(out.cause).toBe('Error: read ECONNRESET');
    expect(out.code).toBe('ECONNRESET');
  });

  it('再深一层的 cause 也带出来；没有 cause 时不多编字段', () => {
    const deep = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    const mid = Object.assign(new Error('socket hang up'), { cause: deep });
    expect(describeFetchError(Object.assign(new Error('x'), { cause: mid })).cause2).toBe('Error: connect timeout');
    expect(describeFetchError(new Error('普通错误'))).toEqual({ err: 'Error: 普通错误' });
  });
});
