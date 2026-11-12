/**
 * 记忆索引：把"想法"和"经历"变成可检索的条目。
 *
 * 来源文件派生的条目以文件版本为准；独立事实、纠正、撤回与修订历史以本库为准。
 * 文件回填保留修订历史和失效标记；不能通过删除数据库重建，否则会丢失独立事实的修订记录。
 *
 * 存储：`data/memory-index.db`（SQLite，node:sqlite 自带，无第三方依赖）。
 * 中文检索用 bigram 预分词灌进 FTS5：unicode61 不切中文，整句会变成一个 token。
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { mkdirSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { cosine, decodeVector, encodeVector } from './embeddings.ts';

/**
 * Vite 的解析器还不认识 `node:sqlite`，静态 import 会在测试里被改写成 `sqlite` 然后失败。
 * 运行时用 createRequire 取，类型仍走 import type（编译期擦除）。
 */
function openSqlite(path: string): DatabaseSync {
  const require = createRequire(import.meta.url);
  const { DatabaseSync: Ctor } = require('node:sqlite') as typeof import('node:sqlite');
  return new Ctor(path);
}

export function memorySourceRevision(memoryDir: string, source: string): string | null {
  const file = resolve(memoryDir, source);
  const rel = relative(resolve(memoryDir), file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return null;
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** 一条记忆的类型。只做粗分类，够检索和衰减用即可。 */
export type MemoryKind = 'episodic' | 'factual' | 'relational' | 'preference' | 'plan';

export const MEMORY_KINDS: readonly MemoryKind[] = ['episodic', 'factual', 'relational', 'preference', 'plan'];

export interface MemoryEntry {
  /** 不给就按正文+时间生成稳定 id。 */
  id?: string;
  /** 第一人称的一条记忆。 */
  text: string;
  kind: MemoryKind;
  topics?: string[];
  /** 涉及的人：QQ 号或固定名字。 */
  people?: string[];
  /** 0–1；决定衰减速度和召回排序。 */
  importance: number;
  /** 事情发生的时间（ISO）；缺省等于写入时间。 */
  eventTime?: string;
  /** 来源：文件相对路径，或 `event:<from>-<to>`。 */
  source?: string;
  /** 归属会话，用于隔离；缺省全局。 */
  scope?: string;
}

export interface MemoryRow extends MemoryEntry {
  id: string;
  /** 落库时一定会写入，所以这里是必填。 */
  eventTime: string;
  topics: string[];
  people: string[];
  createdAt: string;
  status: string;
  accessCount: number;
  lastAccessAt: string | null;
}

export interface RecallHit extends MemoryRow {
  score: number;
  /** 衰减后的重要性（原始值仍看 `importance`）。 */
  effective: number;
  /** 各维分数，供排查"为什么召回它"。 */
  breakdown: { bm25: number; importance: number; recency: number; coverage: number; matched: number; rare: number; vector: number };
}

export interface RecallOptions {
  k?: number;
  scope?: string;
  /** 只搜这些类型。 */
  kinds?: MemoryKind[];
  /** 只返回 active（休眠的不进自动注入，但仍可被主动召回）。 */
  activeOnly?: boolean;
  now?: Date;
  decay?: DecayOptions;
  /** 查询向量；给了就同时走向量路。 */
  queryVector?: Float32Array | null;
}

/** 图谱节点：人、主题、来源文件。 */
export type GraphNodeType = 'person' | 'topic' | 'source';

export interface GraphNode {
  /** `p:<QQ号>` / `t:<主题>` / `s:<来源路径>` */
  id: string;
  type: GraphNodeType;
  label: string;
  /** 出现过这条实体的记忆条数。 */
  count: number;
}

export interface GraphEdge {
  a: string;
  b: string;
  /** 同一条记忆里一起出现的次数。 */
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * 名字钩子：索引本身不认人，只负责存和取。
 *
 * - `canonicalize` 在写入前跑，把"小橘"换成 `@3124076548`——正文冻结的是指向，不是当时的称呼。
 * - `render` 在返回前跑，把指向和存量旧名换回档案里的当前称呼。
 * - `expand` 补检索词：改名之后，用旧名搜仍然命中。
 *
 * 不传时三者都是恒等，索引的行为与没有这层时完全一样。
 */
export interface MemoryNameHooks {
  canonicalize?: (text: string) => string;
  render?: (text: string) => string;
  expand?: (text: string) => string;
  sourceRevision?: (source: string) => string | null;
}

/** 衰减参数；缺省值与 persona 配置里的同名项一致。 */
export interface DecayOptions {
  /** 每日衰减率。 */
  rate?: number;
  /** 多少天没被想起就休眠。 */
  dormantDays?: number;
  /** 衰减下限，防止归零。 */
  floor?: number;
  /** 超过这么多天没访问，访问强化失效——没有永久免疫。 */
  accessWindowDays?: number;
}

const DECAY_DEFAULTS = { rate: 0.02, dormantDays: 90, floor: 0.05, accessWindowDays: 30 } as const;

const DAY_MS = 86_400_000;

/**
 * 有效重要性：`base × (1-r_eff)^天数`，从"上次被想起"算起。
 *
 * 访问会放慢衰减，但只在访问窗口内有效——一次热门不会变成永久免疫。
 * 下限 floor，避免归零后永远排不上来。
 */
export function effectiveImportance(
  row: { importance: number; createdAt: string; lastAccessAt: string | null; accessCount: number },
  now = new Date(),
  opts: DecayOptions = {},
): number {
  const rate = opts.rate ?? DECAY_DEFAULTS.rate;
  const floor = opts.floor ?? DECAY_DEFAULTS.floor;
  const windowDays = opts.accessWindowDays ?? DECAY_DEFAULTS.accessWindowDays;
  const base = clamp01(row.importance);
  const sinceAccess = row.lastAccessAt ? (now.getTime() - Date.parse(row.lastAccessAt)) / DAY_MS : Number.POSITIVE_INFINITY;
  const ref = row.lastAccessAt ? Math.max(0, sinceAccess) : Math.max(0, (now.getTime() - Date.parse(row.createdAt)) / DAY_MS);
  const reinforced = sinceAccess <= windowDays;
  const accessFactor = Math.min(row.accessCount, 10) / 10;
  const rEff = rate * (1 - (reinforced ? 0.5 * accessFactor : 0));
  const eff = base * Math.pow(Math.max(0, 1 - rEff), ref);
  return Math.max(floor, Math.min(1, eff));
}

/** CJK bigram + 拉丁词；FTS5 的 unicode61 不切中文，整句会变成一个 token。 */
export function tokenize(text: string): string {
  const chars = [...text];
  const grams: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    if (/[一-鿿]/.test(chars[i]) && /[一-鿿]/.test(chars[i + 1])) {
      grams.push(chars[i] + chars[i + 1]);
    }
  }
  // 纯数字不当检索词：时间戳里的 `23` 会和记忆里的 `2026-10-23` 撞上，制造假命中。
  const words = text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1 && /[a-z]/.test(w));
  return [...grams, ...words].join(' ');
}

/** 正文规范化后取哈希：同一句话重复写入不会变成两条记忆。 */
export function memoryId(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  topics        TEXT NOT NULL DEFAULT '[]',
  people        TEXT NOT NULL DEFAULT '[]',
  importance    REAL NOT NULL DEFAULT 0.5,
  created_at    TEXT NOT NULL,
  event_time    TEXT NOT NULL,
  source        TEXT,
  scope         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_access_at TEXT,
  embedding     BLOB,
  embedding_model TEXT
);
CREATE INDEX IF NOT EXISTS memories_scope_status ON memories(scope, status);
CREATE INDEX IF NOT EXISTS memories_event_time ON memories(event_time);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(tokens, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_revisions (
  seq INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL,
  previous TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_invalidations (
  identity TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
`;

/** 关掉 node:sqlite 的实验性告警；它只是提示，不影响行为。 */
function quietExperimental(): void {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (text.includes('SQLite is an experimental feature')) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
}

export class MemoryIndex {
  private db: DatabaseSync;
  private readonly log: { warn: (msg: string, data?: unknown) => void } | null;
  private readonly hooks: MemoryNameHooks;

  constructor(
    path: string,
    log?: { warn: (msg: string, data?: unknown) => void },
    hooks: MemoryNameHooks = {},
  ) {
    quietExperimental();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.log = log ?? null;
    this.hooks = hooks;
    this.db = openSqlite(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    const columns = this.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'source_revision')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN source_revision TEXT');
    }
  }

  private canonical(text: string): string {
    return this.hooks.canonicalize ? this.hooks.canonicalize(text) : text;
  }

  private render(text: string): string {
    return this.hooks.render ? this.hooks.render(text) : text;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // 关不掉不影响进程退出。
    }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    return Number(row?.n ?? 0);
  }

  /** 写入一条；已存在同 id 时更新正文与元数据（保留访问次数）。 */
  put(entry: MemoryEntry, now = new Date()): string {
    // 先换成 `@<号>`：id 由规范化后的正文算，改名前后写的同一句话不会变成两条。
    const text = this.canonical(entry.text.trim());
    if (!text) throw new Error('记忆正文不能为空');
    const legacyId = memoryId(text);
    const existing = entry.id ? undefined : this.db.prepare('SELECT kind, people, scope, event_time FROM memories WHERE id = ?').get(legacyId) as { kind: string; people: string; scope: string; event_time: string } | undefined;
    const people = [...new Set(entry.people ?? [])].sort();
    const identity = this.factIdentity({ ...entry, text, people });
    const invalidated = this.db.prepare('SELECT memory_id FROM memory_invalidations WHERE identity = ?')
      .get(identity) as { memory_id: string } | undefined;
    if (invalidated) throw new Error(`记忆已纠正或撤回：${invalidated.memory_id}，不能重新写入旧事实`);
    let sameIdentity = false;
    if (existing) {
      try {
        const previous = JSON.parse(existing.people) as unknown;
        sameIdentity = Array.isArray(previous)
          && JSON.stringify([...new Set(previous.map(String))].sort()) === JSON.stringify(people)
          && existing.kind === entry.kind && existing.scope === (entry.scope ?? '')
          && (!entry.eventTime || existing.event_time === entry.eventTime);
      } catch { /* 不确定身份时不覆盖旧记录 */ }
    }
    const id = entry.id ?? (existing && !sameIdentity
      ? memoryId(JSON.stringify([text, entry.kind, people, entry.scope ?? '', entry.eventTime ?? '']))
      : legacyId);
    const previous = this.db.prepare('SELECT text, status FROM memories WHERE id = ?').get(id) as { text: string; status: string } | undefined;
    if (previous?.status === 'withdrawn') {
      throw new Error(`记忆已撤回：${id}`);
    }
    const sourceRevision = entry.source && !entry.source.startsWith('event:')
      ? this.hooks.sourceRevision?.(entry.source) ?? null : null;
    const ts = now.toISOString();
    const eventTime = entry.eventTime ?? ts;
    const importance = clamp01(entry.importance);
    this.db.prepare(`
      INSERT INTO memories (id, text, kind, topics, people, importance, created_at, event_time, source, scope, status, source_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        kind = excluded.kind,
        topics = excluded.topics,
        people = excluded.people,
        importance = MAX(memories.importance, excluded.importance),
        event_time = excluded.event_time,
        source = excluded.source,
        source_revision = excluded.source_revision,
        status = CASE WHEN memories.status = 'stale' THEN 'active' ELSE memories.status END
    `).run(
      id, text, entry.kind, JSON.stringify(entry.topics ?? []), JSON.stringify(entry.people ?? []),
      importance, ts, eventTime, entry.source ?? null, entry.scope ?? '', sourceRevision,
    );
    this.reindex(id, text, entry.topics ?? []);
    return id;
  }

  private factIdentity(entry: MemoryEntry): string {
    return memoryId(JSON.stringify([
      this.canonical(entry.text).replace(/\s+/g, ' ').trim(), entry.kind,
      [...new Set(entry.people ?? [])].sort(), entry.scope ?? '',
    ]));
  }

  revise(id: string, change: { text?: string; reason: string }, now = new Date()): MemoryRow {
    const raw = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!raw) throw new Error(`找不到记忆：${id}`);
    if (!change.reason.trim()) throw new Error('纠正或撤回必须说明原因');
    if (raw.status === 'withdrawn') throw new Error(`记忆已撤回：${id}`);
    const previous = fromRow(raw);
    const replacement = change.text === undefined ? null : this.canonical(change.text.trim());
    if (replacement === '') throw new Error('纠正后的正文不能为空');
    if (replacement === previous.text) throw new Error('正文没有变化');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO memory_revisions(memory_id, previous, reason, changed_at) VALUES (?, ?, ?, ?)')
        .run(id, JSON.stringify(previous), change.reason.trim(), now.toISOString());
      this.db.prepare('INSERT OR IGNORE INTO memory_invalidations(identity, memory_id, reason, changed_at) VALUES (?, ?, ?, ?)')
        .run(this.factIdentity(previous), id, change.reason.trim(), now.toISOString());
      // 修订后的事实由这份记录负责，不再跟随旧来源文件的版本变化。
      this.db.prepare(`UPDATE memories SET text = ?, status = ?, source = NULL, source_revision = NULL,
        embedding = NULL, embedding_model = NULL WHERE id = ?`)
        .run(replacement ?? previous.text, replacement === null ? 'withdrawn' : 'active', id);
      this.reindex(id, replacement ?? previous.text, previous.topics);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(id)!;
  }

  revisionHistory(id: string): Array<{ previous: MemoryRow; reason: string; changedAt: string }> {
    const rows = this.db.prepare('SELECT previous, reason, changed_at FROM memory_revisions WHERE memory_id = ? ORDER BY seq')
      .all(id) as Array<{ previous: string; reason: string; changed_at: string }>;
    return rows.map((row) => ({ previous: JSON.parse(row.previous) as MemoryRow, reason: row.reason, changedAt: row.changed_at }));
  }

  syncSources(): number {
    if (!this.hooks.sourceRevision) return 0;
    const rows = this.db.prepare("SELECT id, source, source_revision FROM memories WHERE status IN ('active', 'dormant') AND source IS NOT NULL")
      .all() as Array<{ id: string; source: string; source_revision: string | null }>;
    const revisions = new Map<string, string | null>();
    let stale = 0;
    for (const row of rows) {
      if (!/\.md$/i.test(row.source)) continue;
      if (!revisions.has(row.source)) revisions.set(row.source, this.hooks.sourceRevision(row.source));
      if (row.source_revision !== null && revisions.get(row.source) === row.source_revision) continue;
      this.db.prepare("UPDATE memories SET status = 'stale' WHERE id = ?").run(row.id);
      stale++;
    }
    return stale;
  }

  /** FTS 行与 memories 同行号；重写前先清掉旧行。 */
  private reindex(id: string, text: string, topics: string[]): void {
    const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined;
    if (!row) return;
    // 被引用的人的全部称呼都进词元：改名之后，用旧名搜仍然找得到。
    const extra = this.hooks.expand ? this.hooks.expand(text) : '';
    this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rowid);
    this.db.prepare('INSERT INTO memories_fts(rowid, tokens) VALUES (?, ?)')
      .run(row.rowid, tokenize(`${text} ${topics.join(' ')} ${extra}`));
  }

  /**
   * 召回：BM25 为主，重要性与新鲜度做加权。
   * 查询词切不出 token（比如整句英文标点）时退化成按重要性+新鲜度取最近的。
   */
  recall(query: string, opts: RecallOptions = {}): RecallHit[] {
    this.syncSources();
    const k = Math.max(1, Math.min(50, opts.k ?? 5));
    const now = opts.now ?? new Date();
    const scope = opts.scope ?? null;
    const tokens = tokenize(query);
    const scopeSql = scope === null ? '' : "AND m.scope IN ('', ?)";
    const scopeArgs = scope === null ? [] : [scope];
    const kindSql = opts.kinds?.length ? `AND m.kind IN (${opts.kinds.map(() => '?').join(',')})` : '';
    const kindArgs = opts.kinds ?? [];
    // 休眠的记忆仍可被主动召回，只是不进自动注入。
    const statusSql = opts.activeOnly ? "AND m.status = 'active'" : "AND m.status IN ('active', 'dormant')";

    type Raw = { rowid: number; score: number; tokens: string };
    let raw: Raw[] = [];
    const terms = tokens ? [...new Set(tokens.split(' '))] : [];
    if (terms.length) {
      // FTS5 的隐式 AND 对整句查询太严：一句正常的话几乎不可能全词命中。
      // 改成 OR 取候选，再用"命中了多少比例的词"加权。
      const matchExpr = terms.map((t) => `"${t}"`).join(' OR ');
      try {
        raw = this.db.prepare(`
          SELECT f.rowid AS rowid, bm25(memories_fts) AS score, f.tokens AS tokens
          FROM memories_fts f
          JOIN memories m ON m.rowid = f.rowid
          WHERE memories_fts MATCH ? ${statusSql} ${scopeSql} ${kindSql}
          ORDER BY score LIMIT ?
        `).all(matchExpr, ...scopeArgs, ...kindArgs, k * 4) as Raw[];
      } catch (err) {
        // MATCH 语法错误（异常字符等）不该让整个召回失败。
        this.log?.warn('记忆检索失败，按最近记忆兜底', { err: String(err) });
      }
    }
    // 向量路：BM25 找不到的语义近邻只能靠它。条目数量级不大，全表扫一次足够快。
    const qv = opts.queryVector ?? null;
    if (qv && qv.length > 0) {
      const rows = this.db.prepare(`
        SELECT m.rowid AS rowid, m.embedding AS embedding FROM memories m
        WHERE m.embedding IS NOT NULL ${statusSql} ${scopeSql} ${kindSql}
      `).all(...scopeArgs, ...kindArgs) as Array<{ rowid: number; embedding: Uint8Array }>;
      const have = new Set(raw.map((r) => r.rowid));
      const nearest = rows
        .map((r) => ({ rowid: r.rowid, sim: cosine(qv, decodeVector(r.embedding) ?? new Float32Array(0)) }))
        .filter((r) => r.sim > 0.05)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k * 4);
      for (const hit of nearest) {
        if (have.has(hit.rowid)) continue;
        raw.push({ rowid: hit.rowid, score: 0, tokens: '' });
      }
    }
    if (raw.length === 0) {
      raw = this.db.prepare(`
        SELECT m.rowid AS rowid, 0 AS score, '' AS tokens FROM memories m
        WHERE 1 = 1 ${statusSql} ${scopeSql} ${kindSql}
        ORDER BY m.importance DESC, m.event_time DESC LIMIT ?
      `).all(...scopeArgs, ...kindArgs, k * 4) as Raw[];
    }

    // bm25() 越小越相关、且是负数。翻成正向再按本批最大值归一——
    // 不要用 min-max：只命中一条时 span 会塌成 0，分数全是 0。
    const top = Math.max(0, ...raw.map((r) => -r.score)) || 1;

    // 词频表：一个词出现在越少的记忆里，它命中就越说明"说的是这件事"。
    // 「你还」「记得」这类词到处都是，单独命中没有信息量。
    const df = new Map<string, number>();
    if (terms.length && raw.length) {
      for (const term of terms) {
        try {
          const row = this.db.prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?')
            .get(`"${term}"`) as { n: number } | undefined;
          df.set(term, Number(row?.n ?? 0));
        } catch {
          df.set(term, 0);
        }
      }
    }
    const total = this.count();
    const rareMax = Math.max(3, Math.ceil(total * 0.05));

    const hits: RecallHit[] = [];
    for (const r of raw) {
      const row = this.db.prepare('SELECT * FROM memories WHERE rowid = ?').get(r.rowid) as Record<string, unknown> | undefined;
      if (!row) continue;
      // 覆盖率：这句查询有多少个词真的出现在这条记忆里。
      const hitTerms = terms.filter((t) => r.tokens.includes(t));
      const matched = hitTerms.length;
      const rare = hitTerms.filter((t) => (df.get(t) ?? 0) <= rareMax).length;
      const present = terms.length ? matched / terms.length : 0;
      const bm25 = clamp01((-r.score / top) * (terms.length ? Math.max(0.15, present) : 0));
      const base = fromRow(row);
      // 排序用衰减后的重要性：很久没被想起的东西不该一直占前排。
      const effective = effectiveImportance(base, now, opts.decay);
      const ageDays = Math.max(0, (now.getTime() - Date.parse(String(row.event_time))) / 86_400_000);
      const recency = 1 / (1 + ageDays / 14);
      const vec = qv && qv.length > 0
        ? Math.max(0, cosine(qv, decodeVector(row.embedding as Uint8Array | null) ?? new Float32Array(0)))
        : 0;
      // 有向量时两路并重；没有就退回纯关键词 + 重要性。
      // 向量分在这个模型上全挤在 0.26–0.35，直接拿来当分数等于没排序；先按经验区间
      // 归一化，再和"稀有词命中"并重。权重来自 scripts/recall-eval.ts 的 14 条真实问话：
      // 0.4/0.45/0.15 在这组上 hit@5=100%、MRR 0.86，高于以词法为主的两版（93%/0.70）。
      const vecNorm = clamp01((vec - 0.22) / 0.28);
      const rareShare = Math.min(1, rare / 3);
      const lexical = clamp01(0.6 * bm25 + 0.4 * rareShare);
      const tie = 0.5 * effective + 0.5 * recency;
      const score = qv && qv.length > 0
        ? 0.4 * lexical + 0.45 * vecNorm + 0.15 * tie
        : 0.75 * lexical + 0.25 * tie;
      hits.push({
        ...base,
        text: this.render(base.text),
        effective,
        score,
        breakdown: { bm25, importance: effective, recency, coverage: present, matched, rare, vector: vec },
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /**
   * 按人召回：入口是 QQ 号，不是名字。
   *
   * 群友会改名，靠正文里的字符串去找一定会漏；`people` 列是写入时就记下的号，
   * 改名动不了它。这里不做关键词匹配，只回答"关于这个人的记忆有哪些"。
   * 换句话说：认人靠主键，认话题才靠词。
   */
  recallForPeople(
    qqs: readonly string[],
    opts: { k?: number; now?: Date; decay?: DecayOptions; includeDormant?: boolean } = {},
  ): RecallHit[] {
    this.syncSources();
    const ids = [...new Set(qqs.map((q) => q.trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    const k = Math.max(1, Math.min(50, opts.k ?? 5));
    const now = opts.now ?? new Date();
    const statusSql = opts.includeDormant ? "AND status IN ('active', 'dormant')" : "AND status = 'active'";
    // people 存的是 JSON 数组，带引号匹配不会把 3124 和 31241 混成一个。
    const where = ids.map(() => 'people LIKE ?').join(' OR ');
    const args = ids.map((qq) => `%"${qq}"%`);
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE (${where}) ${statusSql} ORDER BY event_time DESC LIMIT ?`,
    ).all(...args, Math.max(k * 8, 40)) as Array<Record<string, unknown>>;

    const hits: RecallHit[] = rows.map((row) => {
      const base = fromRow(row);
      const effective = effectiveImportance(base, now, opts.decay);
      const ageDays = Math.max(0, (now.getTime() - Date.parse(base.eventTime)) / 86_400_000);
      const recency = 1 / (1 + ageDays / 14);
      return {
        ...base,
        text: this.render(base.text),
        effective,
        // 这里没有查询词，BM25 与向量都无从谈起；排序只看"多重要、多久以前"。
        score: 0.6 * effective + 0.4 * recency,
        breakdown: { bm25: 0, importance: effective, recency, coverage: 0, matched: 0, rare: 0, vector: 0 },
      };
    });
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /** 某个人有几条被记得的事——注入块用它决定要不要提"你记得他几件事"。 */
  countForPerson(qq: string, includeDormant = false): number {
    const statusSql = includeDormant ? "AND status IN ('active', 'dormant')" : "AND status = 'active'";
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE people LIKE ? ${statusSql}`)
      .get(`%"${qq}"%`) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * 维护：把久未想起的条目转入休眠，把重新被想起的唤醒。
   * 衰减是读时算的，这里只改状态，不改分数——所以可以随时重算、不会累积误差。
   */
  sweep(decay: DecayOptions = {}, now = new Date()): { dormantized: number; revived: number } {
    const dormantDays = decay.dormantDays ?? DECAY_DEFAULTS.dormantDays;
    const rows = this.db.prepare('SELECT * FROM memories WHERE status IN (\'active\', \'dormant\')')
      .all() as Array<Record<string, unknown>>;
    let dormantized = 0;
    let revived = 0;
    for (const raw of rows) {
      const row = fromRow(raw);
      const eff = effectiveImportance(row, now, decay);
      const idleDays = row.lastAccessAt
        ? (now.getTime() - Date.parse(row.lastAccessAt)) / DAY_MS
        : (now.getTime() - Date.parse(row.createdAt)) / DAY_MS;
      const shouldSleep = idleDays >= dormantDays && eff <= 0.4 * clamp01(row.importance);
      if (shouldSleep && row.status === 'active') {
        this.db.prepare("UPDATE memories SET status = 'dormant' WHERE id = ?").run(row.id);
        dormantized++;
      } else if (!shouldSleep && row.status === 'dormant') {
        this.db.prepare("UPDATE memories SET status = 'active' WHERE id = ?").run(row.id);
        revived++;
      }
    }
    return { dormantized, revived };
  }

  /** 仅合并正文、主体、范围、时间和事件来源完全一致的条目。 */
  dedupe(opts: { threshold?: number; dryRun?: boolean } = {}): {
    pairs: Array<{ keep: string; drop: string; ratio: number; dropText: string }>;
    merged: number;
  } {
    const threshold = Math.min(0.95, Math.max(0.5, opts.threshold ?? 0.75));
    const rows = this.db.prepare(
      "SELECT id, text, kind, importance, event_time, people, scope, source FROM memories WHERE status = 'active'",
    ).all() as Array<{ id: string; text: string; kind: string; importance: number; event_time: string; people: string; scope: string; source: string | null }>;
    const grams = rows.map((row) => {
      const t = String(row.text).replace(/[\s\p{P}\p{S}]+/gu, '');
      const set = new Set<string>();
      for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
      return set;
    });
    const taken = new Set<number>();
    const pairs: Array<{ keep: string; drop: string; ratio: number; dropText: string }> = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (taken.has(i)) continue;
      for (let j = i + 1; j < rows.length; j += 1) {
        if (taken.has(j)) continue;
        if (rows[i].kind !== rows[j].kind || rows[i].scope !== rows[j].scope
          || rows[i].event_time !== rows[j].event_time || rows[i].people !== rows[j].people
          || !rows[i].source?.startsWith('event:') || rows[i].source !== rows[j].source
          || rows[i].text !== rows[j].text) continue;
        const A = grams[i];
        const B = grams[j];
        if (!A.size || !B.size) continue;
        let hit = 0;
        for (const g of A) if (B.has(g)) hit += 1;
        const ratio = hit / Math.min(A.size, B.size);
        if (ratio < threshold) continue;
        // 留下更全的：长度差得明显就留长的，否则比重要性，再不行留新的。
        const lenA = rows[i].text.length;
        const lenB = rows[j].text.length;
        let keepIdx = i;
        if (lenB >= lenA * 1.3) keepIdx = j;
        else if (lenA < lenB * 1.3) {
          if (Number(rows[j].importance) > Number(rows[i].importance)) keepIdx = j;
          else if (Number(rows[j].importance) === Number(rows[i].importance)
            && String(rows[j].event_time) > String(rows[i].event_time)) keepIdx = j;
        }
        const dropIdx = keepIdx === i ? j : i;
        pairs.push({ keep: rows[keepIdx].id, drop: rows[dropIdx].id, ratio, dropText: String(rows[dropIdx].text).slice(0, 60) });
        taken.add(i);
        taken.add(j);
        break;
      }
    }
    let merged = 0;
    if (!opts.dryRun) {
      const stmt = this.db.prepare("UPDATE memories SET status = 'merged' WHERE id = ? AND status = 'active'");
      for (const pair of pairs) {
        const r = stmt.run(pair.drop);
        merged += Number(r.changes ?? 0);
      }
    }
    return { pairs, merged };
  }

  /** 每天最多合并一次；和 sweep 一样，只在真跑过时记账。 */
  dedupeIfDue(now = new Date(), minHours = 24): { merged: number } | null {
    const last = this.meta('last_dedupe');
    if (last && now.getTime() - Date.parse(last) < minHours * 3_600_000) return null;
    const result = this.dedupe();
    this.setMeta('last_dedupe', now.toISOString());
    return { merged: result.merged };
  }

  /** 每天最多扫一次；维护本身很便宜，没必要每次投递都跑。 */
  sweepIfDue(decay: DecayOptions = {}, now = new Date(), minHours = 24): { dormantized: number; revived: number } | null {
    const last = this.meta('last_sweep');
    if (last && now.getTime() - Date.parse(last) < minHours * 3_600_000) return null;
    const result = this.sweep(decay, now);
    this.setMeta('last_sweep', now.toISOString());
    return result;
  }

  /**
   * 自动注入用的召回：只要关键词真的命中的条目，且只取 active。
   * 没有命中就返回 null——每一轮都塞几条不相干的旧事是噪音，不是记忆。
   */
  injectBlock(
    query: string,
    k: number,
    maxChars = 700,
    opts: { scope?: string; now?: Date; decay?: DecayOptions; queryVector?: Float32Array | null } = {},
  ): string | null {
    return this.recallBlock(query, k, maxChars, opts).text;
  }

  /**
   * 与 `injectBlock` 同样的筛选与排版，同时交出真正用上的条目 id。
   *
   * 「用上」= 真的进了那一段注入文本；被预算截掉的、没通过相关性过滤的都不算。
   * 收口时按这一轮的结果给它们一个很小的 importance 增量（再固化）。
   */
  recallBlock(
    query: string,
    k: number,
    maxChars = 700,
    opts: { scope?: string; now?: Date; decay?: DecayOptions; queryVector?: Float32Array | null } = {},
  ): { text: string | null; ids: string[] } {
    if (k <= 0) return { text: null, ids: [] };
    // 候选池大于 k，再按相关性和上下文预算筛选。
    const hits = this.recall(query, { k: Math.max(k, k * 3), activeOnly: true, ...opts })
      .filter((h) => (h.breakdown.bm25 > 0 && h.breakdown.rare >= 1) || h.breakdown.vector >= 0.3);
    if (hits.length === 0) return { text: null, ids: [] };
    const lines: string[] = [];
    const ids: string[] = [];
    let used = 0;
    for (const hit of hits) {
      const line = `${hit.eventTime.slice(0, 10)} · ${hit.text}`;
      if (used + line.length > maxChars) break;
      used += line.length;
      lines.push(`- ${line}`);
      ids.push(hit.id);
      if (ids.length >= k) break;
    }
    if (lines.length === 0) return { text: null, ids: [] };
    return {
      text: [
        '[想起来的一些旧事，可能和这几条消息有关]',
        ...lines,
        '[这些是过去的记录，已经替你检索过：先用这一块，不够再调 recall_memory。'
          + '与此刻说的话冲突时，以此刻为准；不要主动复述，用到再提。]',
      ].join('\n'),
      ids,
    };
  }

  /**
   * 再固化：这一轮用过这些记忆，结局好就稍微重要一点，冷场就稍微轻一点。
   * 增量必须很小——它是沉淀，不是投票。
   */
  bumpImportance(ids: readonly string[], delta: number): number {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length || !Number.isFinite(delta) || delta === 0) return 0;
    const stmt = this.db.prepare('UPDATE memories SET importance = MIN(1, MAX(0.05, importance + ?)) WHERE id = ?');
    let changed = 0;
    for (const id of unique) {
      const result = stmt.run(delta, id) as { changes?: number };
      changed += Number(result.changes ?? 0);
    }
    return changed;
  }

  /** 记一次访问：衰减会被它放慢，状态也可能由休眠转回 active。 */
  touch(ids: string[], now = new Date()): void {
    const ts = now.toISOString();
    const stmt = this.db.prepare('UPDATE memories SET access_count = access_count + 1, last_access_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(ts, id);
  }

  /** 写入一条条目的向量。换了模型时旧向量会被 pendingVectors 视为缺失并重算。 */
  storeVector(id: string, vec: Float32Array, model: string): void {
    this.db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?')
      .run(encodeVector(vec), model, id);
  }

  /** 还缺向量的条目：新写入的，或者换了 embedding 模型的。 */
  pendingVectors(model: string, limit = 200): Array<{ id: string; text: string }> {
    const rows = this.db.prepare(`
      SELECT id, text FROM memories
      WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model <> ?
      ORDER BY event_time DESC LIMIT ?
    `).all(model, limit) as Array<{ id: string; text: string }>;
    // 向量要按"读到的样子"算：`@3124076548` 对语义没意义，当前称呼才有。
    return rows.map((row) => ({ id: row.id, text: this.render(row.text) }));
  }

  /** 已向量化的条数，供统计与面板。 */
  vectorCount(model: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL AND embedding_model = ?',
    ).get(model) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** 单条读取，面板与工具共用。 */
  get(id: string): MemoryRow | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.renderRow(fromRow(row)) : null;
  }

  /** 出库前统一渲染：库里存的是指向，外面看到的应该是当前称呼。 */
  private renderRow(row: MemoryRow): MemoryRow {
    const text = this.render(row.text);
    return text === row.text ? row : { ...row, text };
  }

  /** 改一条的属性。词没变，FTS 与向量都不用重建。 */
  update(id: string, patch: { importance?: number; status?: 'active' | 'dormant' }): MemoryRow | null {
    const row = this.get(id);
    if (!row) return null;
    if (patch.importance !== undefined) {
      this.db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(clamp01(patch.importance), id);
    }
    if (patch.status && !['active', 'dormant'].includes(row.status)) {
      throw new Error(`失效记忆不能通过状态开关复活：${id}`);
    }
    if (patch.status) {
      this.db.prepare('UPDATE memories SET status = ? WHERE id = ?').run(patch.status, id);
    }
    return this.get(id);
  }

  /** 硬删除：连同 FTS 行一起清掉，不留残影。 */
  remove(id: string): boolean {
    const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined;
    if (!row) return false;
    this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rowid);
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return true;
  }

  /** 面板概览。 */
  stats(embeddingModel?: string): {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    avgImportance: number;
    sources: number;
    vectorized: number | null;
  } {
    const rows = this.db.prepare('SELECT kind, status, importance, source FROM memories').all() as Array<Record<string, unknown>>;
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const sources = new Set<string>();
    let sum = 0;
    for (const row of rows) {
      byKind[String(row.kind)] = (byKind[String(row.kind)] ?? 0) + 1;
      byStatus[String(row.status)] = (byStatus[String(row.status)] ?? 0) + 1;
      sum += Number(row.importance ?? 0);
      if (row.source) sources.add(String(row.source));
    }
    return {
      total: rows.length,
      byKind,
      byStatus,
      avgImportance: rows.length ? sum / rows.length : 0,
      sources: sources.size,
      vectorized: embeddingModel ? this.vectorCount(embeddingModel) : null,
    };
  }

  // -------------------------------------------------------------------------
  // 图谱：实体共现，不建新表
  // -------------------------------------------------------------------------
  //
  // 节点来自条目自带的字段（people / topics / source），边是"同一条记忆里一起出现"。
  // 不另建图存储：条目一改图就跟着变，没有第二个会漂移的真相。

  /** 图谱全量：节点按出现次数取前 maxNodes，边按权重取前 maxEdges。 */
  graphData(opts: { maxNodes?: number; maxEdges?: number; minTopicCount?: number; labelOf?: (node: GraphNode) => string } = {}): GraphData {
    const maxNodes = opts.maxNodes ?? 60;
    const maxEdges = opts.maxEdges ?? 240;
    const minTopicCount = opts.minTopicCount ?? 2;
    const rows = this.db.prepare('SELECT id, people, topics, source FROM memories').all() as Array<Record<string, unknown>>;

    const nodes = new Map<string, GraphNode>();
    const edgeWeight = new Map<string, number>();
    const bumpNode = (id: string, type: GraphNodeType, label: string): void => {
      const found = nodes.get(id);
      if (found) { found.count++; return; }
      nodes.set(id, { id, type, label, count: 1 });
    };

    for (const row of rows) {
      const ids: string[] = [];
      for (const person of parseArray(row.people)) {
        const id = `p:${person}`;
        bumpNode(id, 'person', person);
        ids.push(id);
      }
      for (const topic of parseArray(row.topics)) {
        const id = `t:${topic}`;
        bumpNode(id, 'topic', topic);
        ids.push(id);
      }
      const source = typeof row.source === 'string' ? row.source : '';
      if (source) {
        const id = `s:${source}`;
        bumpNode(id, 'source', source);
        ids.push(id);
      }
      // 一条记忆内两两相连；同一对在多条记忆里出现就累加权重。
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
          const key = `${a}\u0000${b}`;
          edgeWeight.set(key, (edgeWeight.get(key) ?? 0) + 1);
        }
      }
    }

    // 只出现一次的主题是文档标题碎片，不是可复用的实体，去掉它们连边也一起去。
    for (const node of [...nodes.values()]) {
      if (node.type === 'topic' && node.count < minTopicCount) nodes.delete(node.id);
    }

    const kept = [...nodes.values()].sort((a, b) => b.count - a.count).slice(0, maxNodes);
    const keptIds = new Set(kept.map((n) => n.id));
    const edges: GraphEdge[] = [];
    for (const [key, weight] of edgeWeight) {
      const [a, b] = key.split('\u0000');
      if (!keptIds.has(a) || !keptIds.has(b)) continue;
      edges.push({ a, b, weight });
    }
    edges.sort((x, y) => y.weight - x.weight);
    const outNodes = kept.map((n) => (opts.labelOf ? { ...n, label: opts.labelOf(n) } : n));
    return { nodes: outNodes, edges: edges.slice(0, maxEdges) };
  }

  /** 某个节点周边：相邻节点与把它们连起来的具体记忆。 */
  neighbors(nodeId: string, limit = 20): {
    node: GraphNode | null;
    neighbors: Array<{ node: GraphNode; weight: number }>;
    memories: MemoryRow[];
  } {
    const data = this.graphData({ maxNodes: 500, maxEdges: 5000, minTopicCount: 1 });
    const node = data.nodes.find((n) => n.id === nodeId) ?? null;
    if (!node) return { node: null, neighbors: [], memories: [] };
    const weights = new Map<string, number>();
    for (const edge of data.edges) {
      if (edge.a === nodeId) weights.set(edge.b, (weights.get(edge.b) ?? 0) + edge.weight);
      else if (edge.b === nodeId) weights.set(edge.a, (weights.get(edge.a) ?? 0) + edge.weight);
    }
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const neighbors = [...weights.entries()]
      .map(([id, weight]) => ({ node: byId.get(id), weight }))
      .filter((x): x is { node: GraphNode; weight: number } => Boolean(x.node))
      .sort((a, b) => b.weight - a.weight);

    const [kind, raw] = [nodeId.slice(0, 1), nodeId.slice(2)];
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY event_time DESC').all() as Array<Record<string, unknown>>;
    const memories = rows
      .filter((row) => {
        if (kind === 'p') return parseArray(row.people).includes(raw);
        if (kind === 't') return parseArray(row.topics).includes(raw);
        return String(row.source ?? '') === raw;
      })
      .slice(0, limit)
      .map((row) => this.renderRow(fromRow(row)));
    return { node, neighbors, memories };
  }

  /** 调试与面板用：按来源或状态列条目。 */
  /** 面板与运维用：按条件列条目，可按关键词过滤（走 FTS）。 */
  list(filter: {
    scope?: string;
    status?: string;
    source?: string;
    kind?: string;
    query?: string;
    limit?: number;
    offset?: number;
    sort?: 'newest' | 'oldest' | 'importance';
  } = {}): MemoryRow[] {
    const { sql: whereSql, args } = this.whereOf(filter);
    const order = filter.sort === 'oldest'
      ? 'event_time ASC'
      : filter.sort === 'importance'
        ? 'importance DESC, event_time DESC'
        : 'event_time DESC';
    const sql = `SELECT * FROM memories ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...args, filter.limit ?? 100, filter.offset ?? 0) as Array<Record<string, unknown>>;
    return rows.map((row) => this.renderRow(fromRow(row)));
  }

  /** 同一套筛选条件下的条数——分页要用它，不能用全表总数。 */
  countFiltered(filter: Parameters<MemoryIndex['list']>[0] = {}): number {
    const { sql: whereSql, args } = this.whereOf(filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM memories ${whereSql}`).get(...args) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  private whereOf(filter: NonNullable<Parameters<MemoryIndex['list']>[0]>): { sql: string; args: string[] } {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.scope !== undefined) { where.push('scope = ?'); args.push(filter.scope); }
    if (filter.status !== undefined) { where.push('status = ?'); args.push(filter.status); }
    if (filter.source !== undefined) { where.push('source = ?'); args.push(filter.source); }
    if (filter.kind !== undefined) { where.push('kind = ?'); args.push(filter.kind); }
    if (filter.query) {
      const terms = [...new Set(tokenize(filter.query).split(' ').filter(Boolean))];
      if (terms.length) {
        where.push('rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)');
        args.push(terms.map((t) => `"${t}"`).join(' OR '));
      }
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }

  replaceSource(source: string, entries: MemoryEntry[]): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE memories SET status = 'stale' WHERE source = ? AND status IN ('active', 'dormant')").run(source);
      let written = 0;
      for (const entry of entries) {
        const identity = this.factIdentity(entry);
        if (this.db.prepare('SELECT 1 FROM memory_invalidations WHERE identity = ?').get(identity)) continue;
        this.put({ ...entry, source });
        written++;
      }
      this.db.exec('COMMIT');
      return written;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 索引重建时使用：清空由某个来源派生出来的全部条目。 */
  dropBySource(source: string): number {
    const rows = this.db.prepare('SELECT rowid FROM memories WHERE source = ?').all(source) as Array<{ rowid: number }>;
    for (const r of rows) this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(r.rowid);
    this.db.prepare('DELETE FROM memories WHERE source = ?').run(source);
    return rows.length;
  }

  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function fromRow(row: Record<string, unknown>): MemoryRow {
  return {
    id: String(row.id),
    text: String(row.text),
    kind: String(row.kind) as MemoryKind,
    topics: parseArray(row.topics),
    people: parseArray(row.people),
    importance: Number(row.importance),
    createdAt: String(row.created_at),
    eventTime: String(row.event_time),
    ...(row.source ? { source: String(row.source) } : {}),
    scope: String(row.scope ?? ''),
    status: String(row.status),
    accessCount: Number(row.access_count ?? 0),
    lastAccessAt: row.last_access_at ? String(row.last_access_at) : null,
  };
}

function parseArray(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** 召回日志：和 wakes.jsonl 对等，回答"她为什么想起这件事"。 */
export function logRecall(
  dir: string,
  record: {
    ts: string;
    query: string;
    k: number;
    scope?: string;
    hits: Array<{ id: string; score: number; text: string; breakdown: unknown }>;
    caller: string;
  },
): void {
  try {
    const file = `${dir}/recalls.jsonl`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify({ version: 1, ...record }) + '\n', 'utf8');
  } catch {
    // 日志写不进去不影响召回本身。
  }
}
