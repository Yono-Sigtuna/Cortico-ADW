/**
 * memidx:记忆索引的运维命令。
 *
 *   pnpm memidx [--bot <name>] stats
 *   pnpm memidx [--bot <name>] search "面试"
 *   pnpm memidx [--bot <name>] dedupe [--dry] [--threshold 0.75]
 *   pnpm memidx [--bot <name>] backfill [--dry]
 *
 * backfill 是**结构化投影**，不调 LLM：把现有文件切成一条条记忆灌进索引，
 * 让第一天就有东西可召回。梦之后会继续增量写入。重跑同一份文件不会产生重复。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deploymentRoot } from '../src/paths.ts';
import { MemoryIndex, memorySourceRevision, type MemoryEntry, type MemoryKind } from '../bots/amber/persona/memoryIndex.ts';
import { PersonRegistry } from '../bots/amber/persona/people.ts';
import { HttpEmbeddingClient } from '../bots/amber/persona/embeddings.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const has = (name: string): boolean => argv.includes(name);
/** 位置参数：跳过 `--flag value` 与裸开关。 */
function positional(): string[] {
  const withValue = new Set(['--bot', '--data', '--memory', '--k']);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (withValue.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}
const pos = positional();
const command = pos[0] ?? 'stats';

function deploymentsRoot(): string {
  return deploymentRoot();
}

const bot = flag('--bot');
const dataDir = flag('--data') ?? (bot ? join(deploymentsRoot(), bot, 'data') : null);
const memoryDir = flag('--memory') ?? (bot ? join(deploymentsRoot(), bot, 'memory') : null);
if (!dataDir) {
  console.error('需要 --bot <部署名> 或 --data <目录>');
  process.exit(1);
}
if (!existsSync(dataDir)) {
  console.error(`目录不存在: ${dataDir}`);
  process.exit(1);
}

// 和线上同一套名字解析：backfill 写入时规范化，search 读出来时渲染。
const registry = memoryDir && existsSync(memoryDir)
  ? new PersonRegistry(memoryDir, { namesFile: join(dataDir, 'qq-names.json') })
  : null;
const index = new MemoryIndex(join(dataDir, 'memory-index.db'), { warn: (m, d) => console.warn(m, d) }, registry ? {
  canonicalize: (text) => registry.canonicalize(text),
  render: (text) => registry.render(text),
  expand: (text) => registry.expand(text),
  sourceRevision: (source) => memorySourceRevision(memoryDir!, source),
} : {});

if (command === 'stats') {
  const total = index.count();
  const all = index.list({ limit: 500 });
  const byKind = new Map<string, number>();
  for (const row of all) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  console.log(`记忆条目: ${total}`);
  console.log('按类型: ' + [...byKind.entries()].map(([k, n]) => `${k} ${n}`).join(' · '));
  console.log(`平均重要性: ${all.length ? (all.reduce((s, r) => s + r.importance, 0) / all.length).toFixed(2) : '—'}`);
  const sources = new Set(all.map((r) => r.source ?? '(无来源)'));
  console.log(`来源文件: ${sources.size}`);
  const model = deploymentValue('memory.embeddingModel') || '';
  if (model) console.log(`已向量化: ${index.vectorCount(model)} / ${total}（${model}）`);
} else if (command === 'search') {
  const query = pos[1] ?? '';
  const k = Number(flag('--k') ?? 5);
  // 配了向量模型就一起走语义路，和线上召回保持一致。
  const model = deploymentValue('memory.embeddingModel') ?? '';
  const key = model ? embeddingKey() : null;
  const baseUrl = deploymentValue('memory.embeddingBaseUrl') ?? '';
  let queryVector: Float32Array | null = null;
  if (model && key && baseUrl) {
    try {
      const client = new HttpEmbeddingClient({ baseUrl, model, apiKey: key });
      const [vec] = await client.embed([query], 'query');
      queryVector = vec ?? null;
    } catch (err) {
      console.warn(`向量查询失败，只用关键词：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const hits = index.recall(query, { k, ...(queryVector ? { queryVector } : {}) });
  if (hits.length === 0) console.log(`没有找到与「${query}」相关的记忆。`);
  for (const [i, h] of hits.entries()) {
    console.log(`${i + 1}. [${h.score.toFixed(3)}] ${h.eventTime.slice(0, 10)} ${h.kind} ${h.importance.toFixed(2)}`);
    console.log(`   ${h.text}`);
    if (h.source) console.log(`   来源: ${h.source}`);
    console.log(`   分数: bm25=${h.breakdown.bm25.toFixed(3)} 向量=${h.breakdown.vector.toFixed(3)} 重要=${h.breakdown.importance.toFixed(2)}`);
  }
} else if (command === 'dedupe') {
  const dry = has('--dry');
  const threshold = Number(flag('--threshold') ?? 0.75);
  const result = index.dedupe({ threshold, dryRun: dry });
  console.log(`${dry ? '[dry] ' : ''}阈值 ${threshold}：近重复 ${result.pairs.length} 组，${dry ? '待合并' : '已合并'} ${dry ? result.pairs.length : result.merged} 条`);
  for (const pair of result.pairs) console.log(`- ${pair.ratio.toFixed(2)}  ${pair.dropText}`);
} else if (command === 'embed') {
  const model = flag('--model') ?? deploymentValue('memory.embeddingModel') ?? '';
  if (!model) {
    console.error('没有配置向量模型：用 --model 指定，或在部署 config.json 的 memory.embeddingModel 里填。');
    process.exit(1);
  }
  const key = embeddingKey();
  if (!key) {
    console.error('找不到 key：设 CORTICO_EMBEDDING_KEY，或写 <部署>/secrets.local.json 的 embeddingKey。');
    process.exit(1);
  }
  const baseUrl = flag('--base-url') ?? deploymentValue('memory.embeddingBaseUrl') ?? '';
  if (!baseUrl) {
    console.error('没有配置 embeddingBaseUrl。');
    process.exit(1);
  }
  const client = new HttpEmbeddingClient({ baseUrl, model, apiKey: key });
  let done = 0;
  for (;;) {
    const pending = index.pendingVectors(model, 8);
    if (pending.length === 0) break;
    let vectors: Float32Array[] | null = null;
    for (let attempt = 1; attempt <= 3 && !vectors; attempt++) {
      try {
        vectors = await client.embed(pending.map((p) => p.text), 'passage');
      } catch (err) {
        console.warn(`第 ${attempt} 次失败：${err instanceof Error ? err.message : String(err)}`);
        if (attempt === 3) {
          console.error(`放弃，已向量化 ${done} 条；补齐后可重跑。`);
          process.exit(1);
        }
      }
    }
    for (let i = 0; i < pending.length; i++) index.storeVector(pending[i].id, vectors![i], model);
    done += pending.length;
    console.log(`已向量化 ${done} 条…`);
  }
  console.log(`完成：${index.vectorCount(model)} / ${index.count()}（${model}）`);
} else if (command === 'backfill') {
  if (!memoryDir || !existsSync(memoryDir)) {
    console.error(`memory 目录不存在: ${memoryDir ?? '(未指定)'}`);
    process.exit(1);
  }
  const dry = has('--dry');
  let files = 0;
  let entries = 0;
  if (!dry) index.syncSources();
  for (const file of walk(memoryDir)) {
    const rel = relative(memoryDir, file).split(sep).join('/');
    const parsed = parseFile(file, rel);
    files++;
    entries += parsed.length;
    if (dry) continue;
    index.replaceSource(rel, parsed);
  }
  console.log(`${dry ? '[dry] ' : ''}从 ${files} 个文件得到 ${entries} 条记忆；索引现有 ${dry ? index.count() : index.count()} 条`);
} else {
  console.error(`未知命令: ${command}（可用 stats / search / backfill）`);
  process.exit(1);
}

/** 读部署 config.json 里的一个点号路径值。 */
function deploymentValue(key: string): string | null {
  if (!dataDir) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, '..', 'config.json'), 'utf8')) as Record<string, unknown>;
    let cur: unknown = raw;
    for (const part of key.split('.')) {
      if (!cur || typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === 'string' ? cur : null;
  } catch {
    return null;
  }
}

/** key 只从环境变量或部署目录的本地文件读。 */
function embeddingKey(): string | null {
  const env = process.env.CORTICO_EMBEDDING_KEY?.trim();
  if (env) return env;
  if (!dataDir) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, '..', 'secrets.local.json'), 'utf8')) as { embeddingKey?: unknown };
    return typeof raw.embeddingKey === 'string' && raw.embeddingKey.trim() ? raw.embeddingKey.trim() : null;
  } catch {
    return null;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (name.toLowerCase().endsWith('.md')) out.push(abs);
  }
  return out.sort();
}

/**
 * 进索引的是"记得住的东西"：人、案例、观察、世界观。
 * 宪法是身份不是记忆；语气卡是风格样本；playbook 是操作手册；
 * handoffs 与 memo 是当班的临时状态，下一次交接就变样，都不进。
 */
function included(rel: string): boolean {
  const lower = rel.toLowerCase();
  if (lower === 'constitution.md') return false;
  if (lower.startsWith('note/style/')) return false;
  if (lower.startsWith('note/playbook/')) return false;
  if (lower.startsWith('handoffs/')) return false;
  if (lower.startsWith('memo/')) return false;
  return true;
}

function parseFile(abs: string, rel: string): MemoryEntry[] {
  if (!included(rel)) return [];
  const text = readFileSync(abs, 'utf8');
  const out: MemoryEntry[] = [];
  const uid = /^people\/qq-(\d+)\.md$/i.exec(rel)?.[1];

  if (rel.startsWith('people/')) {
    const lines = text.split(/\r?\n/);
    const head = (lines[0] ?? '').trim();
    if (head) {
      out.push({
        text: head,
        kind: 'relational',
        importance: 0.8,
        ...(uid ? { people: [uid] } : {}),
        source: rel,
      });
    }
    // 「## 曾用名」是名字历史，不是一条经历，不进索引。
    let inFormer = false;
    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      if (/^#{1,6}\s/.test(trimmed)) {
        inFormer = /^#{1,4}\s*(曾用名|旧名|以前的称呼)/.test(trimmed);
        continue;
      }
      if (inFormer) continue;
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim();
      // 观察条目常常一整行一条；太短的（标题、空行）跳过。
      if (!bullet || bullet.length < 12) continue;
      const eventTime = eventTimeOf(bullet) ?? dateInName(rel);
      out.push({
        text: bullet,
        kind: 'episodic',
        importance: 0.45,
        ...(eventTime ? { eventTime } : {}),
        ...(uid ? { people: [uid] } : {}),
        source: rel,
      });
    }
    return out;
  }

  // note/ 与 WORLDVIEW.md：文件标题与各级小标题都进 topics（正文里的标题行会被剥掉，
  // 不带上它们，"话太密"这种只出现在标题里的词就检索不到）；正文按空行和列表项切碎。
  const kind: MemoryKind = /worldview/i.test(rel) ? 'factual' : 'episodic';
  const importance = /worldview/i.test(rel) ? 0.7 : 0.5;
  const title = /^#\s+(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  for (const section of text.split(/\r?\n(?=#{1,4}\s)/)) {
    const heading = /^#{1,4}\s+(.*)$/m.exec(section)?.[1]?.trim() ?? '';
    const body = section.replace(/^#{1,4}\s+.*$/gm, '');
    const topics = [title, heading].filter(Boolean);
    for (const chunk of chunksOf(body)) {
      const eventTime = eventTimeOf(chunk) ?? dateInName(rel);
      out.push({
        text: chunk.slice(0, 400),
        kind,
        importance,
        ...(eventTime ? { eventTime } : {}),
        ...(topics.length ? { topics: [...new Set(topics)].slice(0, 3) } : {}),
        source: rel,
      });
    }
  }
  return out;
}

/** 条目开头常写着日期；用它当发生时间，新鲜度才是真的。 */
function eventTimeOf(text: string): string | undefined {
  const m = /^\s*(?:[-*]\s*|\d+[.)、]\s*)?(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : undefined;
}

/** 文件名里的日期作为兜底，比如 `2026-10-23-话太密与风凉话.md`。 */
function dateInName(rel: string): string | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(rel.split('/').pop() ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** 空行与列表项都是条目的边界；续行（缩进但无标记）跟着上一条。 */
function chunksOf(body: string): string[] {
  return body
    .split(/\r?\n(?=\s*(?:[-*]|\d+[.)、])\s)|\r?\n\s*\r?\n/)
    .map((s) => s.replace(/\s*\r?\n\s*/g, ' ').trim())
    .filter((s) => s.length >= 20);
}
