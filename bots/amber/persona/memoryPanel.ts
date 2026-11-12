/**
 * 「长期记忆」面板的服务端：声明 + 数据面。
 *
 * 它属于 `memory:<bot>` 那一页——记忆是独立的一层，不该塞进人格运维页。
 * 数据来自 `data/memory-index.db`：索引是文件与事件的投影，所以这里只读条目、
 * 改属性、删除索引行；来源文件不归它管。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldPanelDecl } from 'cortico/core/types.ts';
import { MEMORY_KINDS, memoryId, type MemoryIndex, type MemoryKind, type RecallHit } from './memoryIndex.ts';

export const MEMINDEX_PANEL: WorldPanelDecl = {
  id: 'memindex',
  // 页面本身已经叫「长期记忆」，面板再同名会分不清层级。
  title: '记忆索引',
};

export interface MemoryPanelDeps {
  /** 索引没打开（没有 data 目录）时为 null，面板会明确报错而不是假装空。 */
  memoryIndex(): MemoryIndex | null;
  dataDir(): string;
  /** 工作区根：图谱里的人物名从档案首行取。 */
  memoryDir(): string;
  /** 名字解析器：人物显示名用当前称呼，不用记忆里冻结的旧名。 */
  people?(): { displayOf(qq: string): string };
  /** 与唤醒注入同一条语义查询路径；没配向量时返回 null。 */
  embedQuery(query: string): Promise<Float32Array | null>;
  embeddingModel(): string;
  /** 导入新条目后通知（用于后台补向量）。 */
  onImported?(): void;
  /** 向量调用的实际计数；没有向量能力时不给。 */
  embeddingStats?(): { query: number; passage: number; failures: number; lastMs: number | null; lastError: { at: number; text: string } | null };
}

export interface PanelMemoryItem {
  id: string;
  text: string;
  kind: MemoryKind;
  topics: string[];
  people: string[];
  importance: number;
  eventTime: string;
  source: string | null;
  status: string;
  accessCount: number;
  lastAccessAt: string | null;
}

export interface PanelMemoryState {
  items: PanelMemoryItem[];
  total: number;
  offset: number;
  limit: number;
  stats: {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    avgImportance: number;
    sources: number;
    vectorized: number | null;
  };
  recalls: Array<{ ts?: string; query?: string; k?: number; caller?: string; hits?: Array<{ id?: string; score?: number; text?: string }> }>;
  /** 向量调用计数；没配向量时不出现。 */
  embedding?: { query: number; passage: number; failures: number; lastMs: number | null; lastError: { at: number; text: string } | null };
}

export interface PanelRecallHit {
  id: string;
  text: string;
  kind: string;
  eventTime: string;
  status: string;
  source: string | null;
  score: number;
  breakdown: { bm25: number; importance: number; recency: number; coverage: number; matched: number; rare: number; vector: number };
}

const MAX_LIMIT = 200;
/** 导出上限：一次导太多既慢又没人会看，超出的请先筛选。 */
const EXPORT_MAX = 5000;
/** 导入防护：文件和条数都要有上限，面板不是批量灌库的后门。 */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const IMPORT_MAX_ITEMS = 5000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 列表与导出共用同一套筛选口径，避免"看到的"和"导出的"不是一回事。 */
function filterOf(q: Record<string, unknown>): NonNullable<Parameters<MemoryIndex['list']>[0]> {
  const status = str(q.status);
  const kind = str(q.kind);
  const sort = str(q.sort);
  const sortValue = sort === 'oldest' || sort === 'importance' ? sort : undefined;
  return {
    ...(str(q.query) ? { query: str(q.query) } : {}),
    ...(status && status !== 'all' ? { status } : {}),
    ...(kind && kind !== 'all' ? { kind } : {}),
    ...(sortValue ? { sort: sortValue } : {}),
  };
}

/** `2026/10/24`、`2026-10-24T..` 都收成 `YYYY-MM-DD`；认不出就原样返回。 */
function normalizeDate(raw: string): string {
  const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(raw);
  if (!m) return raw;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 最近的召回记录：谁在什么时候查了什么、命中了哪几条。 */
export function readRecallTail(dataDir: string, limit: number): PanelMemoryState['recalls'] {
  const file = join(dataDir, 'recalls.jsonl');
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((line) => JSON.parse(line) as Record<string, unknown>) as PanelMemoryState['recalls'];
  } catch {
    return [];
  }
}

function itemOf(row: ReturnType<MemoryIndex['list']>[number]): PanelMemoryItem {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind,
    topics: row.topics,
    people: row.people,
    importance: row.importance,
    eventTime: row.eventTime,
    source: row.source ?? null,
    status: row.status,
    accessCount: row.accessCount,
    lastAccessAt: row.lastAccessAt,
  };
}

function listState(index: MemoryIndex, model: string, dataDir: string, q: Record<string, unknown>): PanelMemoryState {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit ?? 40) || 40));
  const offset = Math.max(0, Number(q.offset ?? 0) || 0);
  const filter = filterOf(q);
  const rows = index.list({ ...filter, limit, offset });
  return {
    items: rows.map(itemOf),
    // 筛选后的条数：分页按它算，不能拿全表总数。
    total: index.countFiltered(filter),
    offset,
    limit,
    stats: index.stats(model || undefined),
    recalls: readRecallTail(dataDir, 20),
  };
}

/** 人物显示名：档案里的当前称呼；没有档案就显示号——不编名字。 */
function personLabel(deps: MemoryPanelDeps, qq: string): string {
  return deps.people?.().displayOf(qq) || qq;
}

/** 图上显示的名字：人物用当前称呼，来源用文件名，主题取主干。 */
function labelFor(deps: MemoryPanelDeps, node: { id: string; type: string; label: string }): string {
  if (node.type === 'person') return personLabel(deps, node.id.slice(2));
  if (node.type === 'source') {
    const base = (node.label.split('/').pop() ?? node.label).replace(/\.md$/i, '');
    // 人物档案当来源时用人物名；案例文件去掉开头的日期，别让标签只剩一串数字。
    const person = /^qq-(\d+)$/i.exec(base);
    if (person) return personLabel(deps, person[1]);
    return base.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '');
  }
  // 主题多半是文档小标题；取「：」或「（」前的部分，剩下的当细节留在悬停里。
  const head = node.label.split(/[：:（(]/)[0]?.trim() ?? node.label;
  return head.length >= 2 ? head : node.label;
}

/**
 * 面板数据面。方法：
 * `list` / `recall` / `update` / `remove` / `bulk` / `export` / `import` / `graph` / `neighbors`。
 */
export async function memindexInvoke(
  deps: MemoryPanelDeps,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const index = deps.memoryIndex();
  if (!index) throw new Error('记忆索引不可用：部署没有 data 目录，或索引打不开');
  const model = deps.embeddingModel();
  const dataDir = deps.dataDir();

  if (method === 'list') {
    const q = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
    const state = listState(index, model, dataDir, q);
    return { ...state, ...(deps.embeddingStats ? { embedding: deps.embeddingStats() } : {}) };
  }

  if (method === 'recall') {
    const query = str(args[0]);
    const k = Math.min(20, Math.max(1, Number(args[1] ?? 5) || 5));
    if (!query) throw new Error('给一个查询词');
    // 面板是"试一下"，不算一次真实想起，所以不累加访问次数。
    const queryVector = model ? await deps.embedQuery(query).catch(() => null) : null;
    const hits = index.recall(query, { k, ...(queryVector ? { queryVector } : {}) });
    const out: PanelRecallHit[] = hits.map((hit: RecallHit) => ({
      id: hit.id,
      text: hit.text,
      kind: hit.kind,
      eventTime: hit.eventTime,
      status: hit.status,
      source: hit.source ?? null,
      score: hit.score,
      breakdown: hit.breakdown,
    }));
    return { hits: out, vector: Boolean(queryVector) };
  }

  if (method === 'update') {
    const id = str(args[0]);
    if (!id) throw new Error('缺少记忆 id');
    const patch = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
    const importance = patch.importance === undefined ? undefined : Number(patch.importance);
    const status = patch.status === 'active' || patch.status === 'dormant' ? patch.status : undefined;
    const row = index.update(id, {
      ...(importance !== undefined && Number.isFinite(importance) ? { importance } : {}),
      ...(status ? { status } : {}),
    });
    if (!row) throw new Error(`没有找到记忆 ${id}`);
    return { ok: true, result: `已更新 ${id}` };
  }

  if (method === 'remove') {
    const id = str(args[0]);
    if (!id) throw new Error('缺少记忆 id');
    if (!index.remove(id)) throw new Error(`没有找到记忆 ${id}`);
    return { ok: true, result: `已删除 ${id}` };
  }

  if (method === 'bulk') {
    const op = str(args[0]);
    const ids = Array.isArray(args[1]) ? args[1].map(String).filter(Boolean) : [];
    if (ids.length === 0) throw new Error('没有选中任何记忆');
    let done = 0;
    for (const id of ids) {
      if (op === 'remove') {
        if (index.remove(id)) done++;
      } else if (op === 'dormant' || op === 'active') {
        if (index.update(id, { status: op })) done++;
      } else {
        throw new Error(`未知的批量操作 ${op}`);
      }
    }
    const word = op === 'remove' ? '删除' : op === 'dormant' ? '休眠' : '唤醒';
    return { ok: true, result: `已${word} ${done} 条` };
  }

  if (method === 'export') {
    const q = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
    const ids = Array.isArray(q.ids) ? q.ids.map(String).filter(Boolean) : [];
    const rows = ids.length
      ? ids.map((id) => index.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row))
      : index.list({ ...filterOf(q), limit: EXPORT_MAX });
    // 导出不含向量：向量绑在具体模型上，换个模型就是废数据，导入后由后台重算。
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: rows.length,
      memories: rows.map((row) => ({
        id: row.id,
        text: row.text,
        kind: row.kind,
        topics: row.topics,
        people: row.people,
        importance: row.importance,
        event_time: row.eventTime,
        source: row.source ?? null,
        status: row.status,
        access_count: row.accessCount,
        last_access_at: row.lastAccessAt,
      })),
    };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return { filename: `memory-${stamp}.json`, content: JSON.stringify(payload, null, 2), count: rows.length };
  }

  if (method === 'import') {
    const raw = typeof args[0] === 'string' ? args[0] : '';
    const mode = str(args[1]) === 'overwrite' ? 'overwrite' : 'skip';
    if (!raw) throw new Error('没有收到文件内容');
    if (raw.length > IMPORT_MAX_BYTES) throw new Error(`文件太大（上限 ${IMPORT_MAX_BYTES / 1024 / 1024} MB）`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('不是合法的 JSON');
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { memories?: unknown } | null)?.memories;
    if (!Array.isArray(list)) throw new Error('JSON 里没有 memories 数组');
    if (list.length > IMPORT_MAX_ITEMS) throw new Error(`条目太多（上限 ${IMPORT_MAX_ITEMS} 条）`);

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const invalid: string[] = [];
    for (const [i, item] of list.entries()) {
      const e = (item ?? {}) as Record<string, unknown>;
      const text = str(e.text);
      if (!text) { invalid.push(`#${i + 1} 缺正文`); continue; }
      if (text.length > 400) { invalid.push(`#${i + 1} 超长`); continue; }
      const kindRaw = str(e.kind) as MemoryKind;
      const kind = MEMORY_KINDS.includes(kindRaw) ? kindRaw : 'factual';
      const id = str(e.id) || memoryId(text);
      const exists = Boolean(index.get(id));
      if (exists && mode === 'skip') { skipped++; continue; }
      index.put({
        id,
        text,
        kind,
        importance: Number(e.importance ?? 0.5),
        ...(Array.isArray(e.topics) ? { topics: e.topics.map(String) } : {}),
        ...(Array.isArray(e.people) ? { people: e.people.map(String) } : {}),
        ...(typeof e.event_time === 'string' && e.event_time ? { eventTime: normalizeDate(e.event_time) } : {}),
        ...(typeof e.source === 'string' && e.source ? { source: e.source } : {}),
      });
      if (exists) updated++; else added++;
    }
    if (added + updated > 0) deps.onImported?.();
    const bad = invalid.length ? ` · 无效 ${invalid.length}（${invalid.slice(0, 3).join('；')}）` : '';
    return {
      ok: true,
      result: `导入完成：新增 ${added} · 覆盖 ${updated} · 跳过 ${skipped}${bad}`,
      added,
      updated,
      skipped,
      invalid,
    };
  }

  if (method === 'graph') {
    const data = index.graphData({ labelOf: (node) => labelFor(deps, node) });
    const counts: Record<string, number> = { person: 0, topic: 0, source: 0 };
    for (const node of data.nodes) counts[node.type] = (counts[node.type] ?? 0) + 1;
    return {
      ...data,
      stats: { persons: counts.person, topics: counts.topic, sources: counts.source, edges: data.edges.length },
    };
  }

  if (method === 'neighbors') {
    const id = str(args[0]);
    if (!id) throw new Error('缺少节点 id');
    const out = index.neighbors(id);
    if (!out.node) throw new Error(`没有找到节点 ${id}`);
    return {
      node: { ...out.node, label: labelFor(deps, out.node) },
      neighbors: out.neighbors.map((n) => ({ node: { ...n.node, label: labelFor(deps, n.node) }, weight: n.weight })),
      memories: out.memories.map((row) => ({
        id: row.id,
        text: row.text,
        eventTime: row.eventTime,
        importance: row.importance,
        status: row.status,
        source: row.source ?? null,
      })),
    };
  }

  throw new Error(`未知面板方法: memindex.${method}`);
}
