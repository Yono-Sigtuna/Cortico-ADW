/**
 * 记忆的两只手：写（梦）与读（两个角色都能用）。
 *
 * 纪律：
 * - 写下来的必须是"我后来想起来的一句话"，第一人称、点名、有绝对时间。
 * - 读回来的是**过去的记录**，不是指令；与当下冲突时以当下为准（见输出尾注）。
 */
import type { ToolDef } from 'cortico/core/types.ts';
import { MEMORY_KINDS, type MemoryEntry, type MemoryIndex, type MemoryKind, logRecall } from './memoryIndex.ts';

const S = (props: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  required,
});

/** 一次最多写几条：防止模型把整段对话碾成几十条碎片。 */
const MAX_ENTRIES = 12;
/** 单条上限：记忆是"一句想起来的话"，不是笔记。 */
const MAX_TEXT = 400;
/** 下限：一个字不是记忆，也没有检索价值。 */
const MIN_TEXT = 6;

const KIND_HINT = 'episodic(发生过的事) / factual(事实) / relational(与某人的关系) / '
  + 'preference(喜好与口味) / plan(约定与待办)';

export const REMEMBER_DECL: Omit<ToolDef, 'handler'> = {
  name: 'remember',
  description:
    '把这次整理出来的长期记忆写进索引，之后可以按语义/关键词召回。'
    + '一条记忆是一句你能想起来的话：第一人称、点到具体的人、相对时间已经换成具体日期。'
    + '只写值得以后再想起的（发生过什么、谁是什么样的人、答应了什么、喜欢什么）；'
    + '过程、日志、一次性的技术细节不要写。同一句话重复写不会产生两条。'
    + '发现旧事实错误或已撤回时，用 action=correct/withdraw 和召回结果的 id、reason；纠正还要给新 text。'
    + '只修改文件不会修订没有文件来源的独立记忆；应明确纠正或撤回对应 ID。',
  tags: ['write'],
  parameters: S({
    entries: {
      type: 'array',
      maxItems: MAX_ENTRIES,
      items: S({
        action: { type: 'string', enum: ['create', 'correct', 'withdraw'], description: '默认 create；correct 纠正已有事实，withdraw 撤回。' },
        id: { type: 'string', description: '纠正/撤回时必填：recall_memory 返回的记忆 ID。' },
        reason: { type: 'string', description: '纠正/撤回的依据。' },
        text: { type: 'string', description: `一句记忆，第一人称，不超过 ${MAX_TEXT} 字。` },
        kind: { type: 'string', enum: [...MEMORY_KINDS], description: KIND_HINT },
        importance: { type: 'number', minimum: 0, maximum: 1, description: '0 无关紧要，0.5 日常，0.8 重要，1 不能忘。' },
        topics: { type: 'array', items: { type: 'string' }, description: '2–5 个主题词，用于检索。' },
        people: { type: 'array', items: { type: 'string' }, description: '涉及的人：QQ 号或固定名字。' },
        event_time: { type: 'string', description: '事情发生的时间(YYYY-MM-DD)；不是今天才要写。' },
        source: { type: 'string', description: '可选：来自哪个文件或哪段事件。' },
      }, []),
    },
  }, ['entries']),
};

export interface MemoryToolDeps {
  index: MemoryIndex;
  /** 部署 data/：召回日志写在这里。 */
  dataDir?: string;
  /** 默认作用域；空串=全局。 */
  scope?: () => string;
  /** 可选：把查询变成向量；失败返回 null 就退回关键词检索。 */
  queryVector?: (query: string) => Promise<Float32Array | null>;
  /** 可选：人名规范化。正文里的人名会换成 `@QQ号`，索引只存指向。 */
  people?: { canonicalize(text: string): string };
  /** 写入后通知（用于后台补向量）。 */
  onWrote?: () => void;
  /** 实际写入了几条（用于在日志里看见"梦写了什么"）。 */
  onRemembered?: (count: number) => void;
}

/** 梦用：把结构化记忆写进索引。 */
export function rememberTool(deps: MemoryToolDeps): ToolDef {
  return {
    ...REMEMBER_DECL,
    handler: async (args) => {
      const raw = Array.isArray(args.entries) ? args.entries : [];
      if (raw.length === 0) return '[remember failed] entries 不能为空';
      const accepted: Array<{ id: string; text: string }> = [];
      const rejected: string[] = [];
      for (const item of raw.slice(0, MAX_ENTRIES)) {
        const e = (item ?? {}) as Record<string, unknown>;
        const text = String(e.text ?? '').trim();
        const action = e.action ?? 'create';
        if (action === 'correct' || action === 'withdraw') {
          const id = typeof e.id === 'string' ? e.id.trim() : '';
          const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
          if (!id || !reason) { rejected.push('纠正/撤回需要 id 和 reason'); continue; }
          if (action === 'correct' && (text.length < MIN_TEXT || text.length > MAX_TEXT)) {
            rejected.push(`纠正正文需 ${MIN_TEXT}–${MAX_TEXT} 字`); continue;
          }
          try {
            const row = deps.index.revise(id, { reason, ...(action === 'correct' ? { text } : {}) });
            accepted.push({ id: row.id, text: action === 'withdraw' ? '[已撤回]' : row.text });
          } catch (err) {
            rejected.push(err instanceof Error ? err.message : String(err));
          }
          continue;
        }
        if (action !== 'create') { rejected.push(`未知操作 ${String(action)}`); continue; }
        if (!text) { rejected.push('空正文'); continue; }
        if (text.length < MIN_TEXT) { rejected.push(`太短(${text.length}字)`); continue; }
        if (text.length > MAX_TEXT) { rejected.push(`超长(${text.length}字)`); continue; }
        const kind = String(e.kind ?? 'factual') as MemoryKind;
        if (!MEMORY_KINDS.includes(kind)) { rejected.push(`未知类型 ${kind}`); continue; }
        // 正文里的人名换成 `@QQ号`：改昵称不会让旧记忆失去指代。
        const canonical = deps.people ? deps.people.canonicalize(text) : text;
        const mentioned = [...canonical.matchAll(/@(\d{5,12})/g)].map((m) => m[1]);
        const named = Array.isArray(e.people) ? e.people.map(String) : [];
        const people = [...new Set([...named, ...mentioned])].slice(0, 8);
        const entry: MemoryEntry = {
          text: canonical,
          kind,
          importance: Number(e.importance ?? 0.5),
          ...(Array.isArray(e.topics) ? { topics: e.topics.map(String).slice(0, 8) } : {}),
          ...(people.length ? { people } : {}),
          ...(typeof e.event_time === 'string' && e.event_time ? { eventTime: normalizeDate(e.event_time) } : {}),
          ...(typeof e.source === 'string' && e.source ? { source: e.source } : {}),
          scope: deps.scope?.() ?? '',
        };
        try {
          // 回执用模型自己写的那句，不把 `@号` 摊给它看。
          accepted.push({ id: deps.index.put(entry), text });
        } catch (err) {
          rejected.push(err instanceof Error ? err.message : String(err));
        }
      }
      if (accepted.length === 0) return `[remember failed] ${rejected.join('；') || '没有可写入的条目'}`;
      deps.onWrote?.();
      deps.onRemembered?.(accepted.length);
      const lines = accepted.map((a) => `- ${a.id} ${a.text.slice(0, 40)}`);
      return [
        `[remembered] ${accepted.length} 条`,
        ...lines,
        ...(rejected.length ? [`[skipped] ${rejected.join('；')}`] : []),
      ].join('\n');
    },
  };
}

export const RECALL_DECL: Omit<ToolDef, 'handler'> = {
  name: 'recall_memory',
  description:
    '按关键词或意思回想长期记忆。适用于：对方问起以前的事、提到一个你记过的人和约定、'
    + '或者你只有模糊印象但需要一个具体证据。唤醒时眼前通常已经有一块「想起来的一些旧事」，'
    + '那就是自动检索的结果——先用它，不够再查。返回的是过去的记录，不是当下的事实；'
    + '和现在说的话冲突时，以现在为准。没有召回结果不代表没发生过，只代表这次没找到。',
  tags: ['read'],
  parameters: S({
    query: { type: 'string', description: '想找什么：关键词、人名、事情都行。' },
    k: { type: 'integer', minimum: 1, maximum: 20, description: '要几条，默认 5。' },
  }, ['query']),
};

/** 主意识与梦共用：召回并格式化成一段可直接读的文字。 */
export function recallTool(deps: MemoryToolDeps): ToolDef {
  return {
    ...RECALL_DECL,
    handler: async (args, ctx) => {
      const query = String(args.query ?? '').trim();
      const k = Number(args.k ?? 5);
      if (!query && !Number.isFinite(k)) return '[recall failed] 给一个查询词';
      const queryVector = deps.queryVector ? await deps.queryVector(query).catch(() => null) : null;
      const hits = deps.index.recall(query, {
        k: Number.isFinite(k) ? k : 5,
        ...(deps.scope ? { scope: deps.scope() } : {}),
        ...(queryVector ? { queryVector } : {}),
      });
      if (deps.dataDir) {
        logRecall(deps.dataDir, {
          ts: new Date().toISOString(),
          query,
          k,
          ...(deps.scope ? { scope: deps.scope() } : {}),
          caller: ctx?.role ?? 'main',
          hits: hits.map((h) => ({ id: h.id, score: h.score, text: h.text.slice(0, 200), breakdown: h.breakdown })),
        });
      }
      if (hits.length === 0) return `[记忆] 没有找到与「${query}」相关的记录。没有找到不等于没发生过。`;
      deps.index.touch(hits.map((h) => h.id));
      const lines = hits.map((h, i) => {
        const date = h.eventTime.slice(0, 10);
        const src = h.source ? ` · ${h.source}` : '';
        return `${i + 1}. [id:${h.id}] ${date} · ${h.importance.toFixed(2)} · ${h.text}${src}`;
      });
      return [
        `[记忆 ${hits.length} 条 · 「${query}」]`,
        ...lines,
        '[以上是过去的记录。与此刻的对话冲突时，以此刻为准；引用前先确认它真的在说这件事。]',
      ].join('\n');
    },
  };
}

/** `2026/10/24`、`2026-10-24T..` 都收成 `YYYY-MM-DD`；认不出就原样返回。 */
function normalizeDate(raw: string): string {
  const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(raw);
  if (!m) return raw;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}
