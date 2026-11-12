/**
 * 召回排序的离线评估：一组「问话 → 该想起的那条」，比较几种打分公式把目标排到第几名。
 *
 *   corepack pnpm tsx scripts/recall-eval.ts
 *
 * 需要 CORTICO_EMBEDDING_KEY（或 deployments/<bot>/secrets.local.json 里的 key）；
 * 只读索引，不写任何东西。改权重之前先跑它，不要凭感觉调。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryIndex } from '../bots/amber/persona/memoryIndex.ts';
import { PersonRegistry } from '../bots/amber/persona/people.ts';
import { HttpEmbeddingClient } from '../bots/amber/persona/embeddings.ts';

const bot = process.argv[2] ?? 'amber';
const dataDir = `deployments/${bot}/data`;
const memoryDir = `deployments/${bot}/memory`;

/** 问话 → 目标条目里必须有的一段字。挑的都是四天前的旧事，且措辞与原文不重合。 */
const CASES: Array<{ q: string; want: string }> = [
  { q: '那天你把我的存档截图贴到群里，我是怎么回的？', want: '你翻的是我写的字' },
  { q: '我说「这不是你的错，是我的系统不足」那次，你接了没有？', want: '系统没逼我' },
  { q: '你抢话抢得凶那阵，我给你的判据是什么？', want: '等停顿再补' },
  { q: '表情包到底该不该认真解读？我给的判据是什么？', want: '心境状态' },
  { q: '你把撤回的事记到我头上那次，后来怎么收的？', want: '圈了红' },
  { q: '我一天烧多少钱，你当时什么态度？', want: '账单' },
  { q: '三个 bot 一天大概花多少？我怎么说的？', want: '20 元' },
  { q: '七项路线图那次，你第一版答成了什么？', want: '排期评审' },
  { q: '大肥鱼拿文章激将你写文章，你怎么回的？', want: '浪漫也太便宜了' },
  { q: '我在群里被连着问那几句越界的话，你后来怎么处理的？', want: '沉默策略' },
  { q: '你说要睡那次，我是怎么留你的？', want: '真的不能多聊一会吗' },
  { q: '大肥鱼演完那段要两块方糖，你给了几块？', want: '一块，自己拿' },
  { q: '我被说成有 bot 感的时候，是怎么接的？', want: '底色，藏不掉' },
  { q: '你猜表情包谜语猜错那次，答案到底是哪个角色？', want: '天满八纯' },
];

type Variant = {
  name: string;
  score: (b: { bm25: number; vec: number; rare: number; imp: number; rec: number }) => number;
};

const clip01 = (v: number) => Math.min(1, Math.max(0, v));
const vecNormOf = (v: number) => clip01((v - 0.22) / 0.28);
const lexicalOf = (bm25: number, rare: number) => clip01(0.6 * bm25 + 0.4 * Math.min(1, rare / 3));

const VARIANTS: Variant[] = [
  { name: '原公式(bm25/vec/新旧)', score: (b) => 0.35 * b.bm25 + 0.35 * b.vec + 0.2 * b.imp + 0.1 * b.rec },
  { name: '现行(0.55词/0.25向/0.2旧)', score: (b) => 0.55 * lexicalOf(b.bm25, b.rare) + 0.25 * vecNormOf(b.vec) + 0.2 * (0.5 * b.imp + 0.5 * b.rec) },
  { name: '偏向量(0.3/0.55/0.15)', score: (b) => 0.3 * lexicalOf(b.bm25, b.rare) + 0.55 * vecNormOf(b.vec) + 0.15 * (0.5 * b.imp + 0.5 * b.rec) },
  { name: '纯词法(0.8/0/0.2)', score: (b) => 0.8 * lexicalOf(b.bm25, b.rare) + 0.2 * (0.5 * b.imp + 0.5 * b.rec) },
  { name: '偏向量-中(0.4/0.45/0.15)', score: (b) => 0.4 * lexicalOf(b.bm25, b.rare) + 0.45 * vecNormOf(b.vec) + 0.15 * (0.5 * b.imp + 0.5 * b.rec) },
  { name: '均匀(词/向/旧 各1/3)', score: (b) => (lexicalOf(b.bm25, b.rare) + vecNormOf(b.vec) + (0.5 * b.imp + 0.5 * b.rec)) / 3 },
];

const secrets = (() => {
  try { return JSON.parse(readFileSync(`deployments/${bot}/secrets.local.json`, 'utf8')); } catch { return {}; }
})();
const key = process.env.CORTICO_EMBEDDING_KEY || secrets.CORTICO_EMBEDDING_KEY || secrets.embeddingKey;
if (!key) {
  console.error('缺少 embedding key；设 CORTICO_EMBEDDING_KEY 或放到 secrets.local.json');
  process.exit(1);
}

const registry = new PersonRegistry(memoryDir, { namesFile: join(dataDir, 'qq-names.json') });
const index = new MemoryIndex(join(dataDir, 'memory-index.db'), { warn: () => {} }, {
  canonicalize: (t) => registry.canonicalize(t),
  render: (t) => registry.render(t),
  expand: (t) => registry.expand(t),
});
const emb = new HttpEmbeddingClient({ baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3-embed-1b', apiKey: key });

const results = new Map<string, number[]>();
for (const variant of VARIANTS) results.set(variant.name, []);

for (const c of CASES) {
  const qv = await emb.embed([c.q], 'query').then((v) => v[0]);
  const hits = index.recall(registry.queryTerms(c.q), { k: 30, activeOnly: true, queryVector: qv });
  // 同一批候选，按每个公式重排，看目标排第几。
  for (const variant of VARIANTS) {
    const ranked = [...hits].sort((a, b) => variant.score({
      bm25: b.breakdown.bm25, vec: b.breakdown.vector, rare: b.breakdown.rare,
      imp: b.importance, rec: b.breakdown.recency,
    }) - variant.score({
      bm25: a.breakdown.bm25, vec: a.breakdown.vector, rare: a.breakdown.rare,
      imp: a.importance, rec: a.breakdown.recency,
    }));
    const rank = ranked.findIndex((h) => h.text.includes(c.want)) + 1;
    results.get(variant.name)!.push(rank || 99);
  }
}

console.log('\n目标排名（99 = 前 30 里都没有）');
console.log('变体'.padEnd(26) + CASES.map((_, i) => String(i + 1).padStart(3)).join('') + '   hit@5   MRR');
for (const [name, ranks] of results) {
  const hit5 = ranks.filter((r) => r <= 5).length / ranks.length;
  const mrr = ranks.reduce((s, r) => s + (r <= 30 ? 1 / r : 0), 0) / ranks.length;
  console.log(name.padEnd(24) + ranks.map((r) => String(r).padStart(3)).join('') + `   ${(hit5 * 100).toFixed(0)}%`.padStart(8) + `   ${mrr.toFixed(2)}`.padStart(6));
}
index.close();
