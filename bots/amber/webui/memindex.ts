/**
 * 面板 `memindex` —— 长期记忆的运维台，挂在 Memory 页。
 *
 * 三块：筛选 + 列表（可勾选批量操作、逐行改重要性/休眠/删除）、召回测试、
 * 最近召回。索引是文件与事件的投影，所以这里删的是索引行，来源文件不受影响。
 *
 * 召回测试不累加访问次数：那是运维在看，不是她真的想起。
 */

import type { WebUiPanelContext, WebUiPanel, WebUiTable } from 'cortico/web/shared/client-panel.ts';
import { autoload, errText, setMsg } from '../../cormini/webui/shared.ts';

interface MemoryItem {
  id: string;
  text: string;
  kind: string;
  topics: string[];
  people: string[];
  importance: number;
  eventTime: string;
  source: string | null;
  status: string;
  accessCount: number;
  lastAccessAt: string | null;
}

interface MemoryStats {
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  avgImportance: number;
  sources: number;
  vectorized: number | null;
}

interface RecallEntry {
  ts?: string;
  query?: string;
  k?: number;
  caller?: string;
  hits?: Array<{ id?: string; score?: number; text?: string }>;
}

interface MemoryView {
  items: MemoryItem[];
  total: number;
  offset: number;
  limit: number;
  stats: MemoryStats;
  recalls: RecallEntry[];
  embedding?: {
    query: number; passage: number; failures: number; lastMs: number | null;
    lastError: { at: number; text: string } | null;
  };
}

interface GraphNode {
  id: string;
  type: 'person' | 'topic' | 'source';
  label: string;
  count: number;
}

interface GraphEdge { a: string; b: string; weight: number }

interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { persons: number; topics: number; sources: number; edges: number };
}

interface NeighborView {
  node: GraphNode;
  neighbors: Array<{ node: GraphNode; weight: number }>;
  memories: Array<{ id: string; text: string; eventTime: string; importance: number; status: string; source: string | null }>;
}

interface RecallHit {
  id: string;
  text: string;
  kind: string;
  eventTime: string;
  status: string;
  source: string | null;
  score: number;
  breakdown: { bm25: number; importance: number; recency: number; coverage: number; matched: number; rare: number; vector: number };
}

const KIND_LABEL: Record<string, string> = {
  episodic: '经历',
  factual: '事实',
  relational: '关系',
  preference: '喜好',
  plan: '约定',
};

export const memIndexPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    autoload<MemoryView>(ctx, {
      loading: '读取记忆索引…',
      failed: '记忆索引不可用',
      load: () => ctx.invoke<MemoryView>('list', [{ limit: 20, offset: 0 }]),
      render: (view, reload) => [render(ctx, view, reload)],
    });
  },
};

function render(ctx: WebUiPanelContext, view: MemoryView, reload: () => void): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '长期记忆',
    en: 'memory index',
    desc: '索引是文件与事件的投影：删掉可以按来源重建。休眠的条目仍可被主动召回，只是不再自动冒出来。',
  });
  const tabbar = ui.rowbar();
  const host = ui.h('div');

  const panes: Record<string, HTMLElement> = {
    manage: manageSheet(ctx, view, reload),
    graph: graphBox(ctx),
    recall: recallBox(ctx),
    overview: overviewPane(ctx, view),
  };
  const tabs: Array<[string, string]> = [
    ['manage', '记忆管理'],
    ['graph', '知识图谱'],
    ['recall', '召回测试'],
    ['overview', '概览'],
  ];
  const buttons = new Map<string, HTMLElement>();
  const show = (key: string): void => {
    host.replaceChildren(panes[key]);
    for (const [k, el] of buttons) el.style.fontWeight = k === key ? '600' : '400';
  };
  for (const [key, label] of tabs) {
    const button = ui.button(label, { size: 'sm', variant: key === 'manage' ? 'primary' : 'plain', onClick: () => show(key) });
    buttons.set(key, button);
    tabbar.appendChild(button);
  }
  show('manage');

  sheet.body.append(tabbar, host);
  return sheet.el;
}

/** 概览：统计卡 + 最近召回。 */
function overviewPane(ctx: WebUiPanelContext, view: MemoryView): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: '概览', en: 'overview', desc: '索引的整体状态；数字来自实时统计，不是缓存的旧值。' });
  const stats = view.stats;
  const tiles = ui.rowbar();
  tiles.append(
    ui.stat({ k: '记忆条目', v: stats.total }),
    ui.stat({ k: '休眠', v: stats.byStatus.dormant ?? 0 }),
    ui.stat({ k: '已向量化', v: stats.vectorized === null ? '未启用' : stats.vectorized }),
    ui.stat({ k: '来源文件', v: stats.sources }),
    ui.stat({ k: '平均重要性', v: stats.avgImportance.toFixed(2) }),
  );
  const kinds = ui.msgline(Object.entries(stats.byKind).map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`).join(' · '));
  const embedding = view.embedding
    ? ui.msgline(
      `向量调用：查询 ${view.embedding.query} 次 · 建档 ${view.embedding.passage} 条`
      + ` · 失败 ${view.embedding.failures} 次`
      + (view.embedding.lastMs === null ? '' : ` · 最近一次 ${view.embedding.lastMs}ms`),
    )
    : ui.msgline('向量未启用：只用关键词检索。');
  sheet.body.append(tiles, kinds, embedding);
  const failed = view.embedding?.lastError ?? null;
  if (failed) {
    sheet.body.append(
      ui.msgline(`记忆向量接口失败：${failed.text}（${new Date(failed.at).toLocaleString()}）——这几轮已退回关键词检索。`, true),
    );
    alertOnce(ctx, failed.at, failed.text);
  }
  sheet.body.append(recallLog(ctx, view.recalls));
  return sheet.el;
}

/** 一次失败只弹一次：刷新面板不该重复报警，但新的一次要能弹出来。 */
const EMBED_ALERT_KEY = 'amber.embedding-alert-at';
function alertOnce(ctx: WebUiPanelContext, at: number, text: string): void {
  try {
    const store = globalThis.localStorage;
    if (Number(store.getItem(EMBED_ALERT_KEY) ?? 0) >= at) return;
    store.setItem(EMBED_ALERT_KEY, String(at));
  } catch { /* 存不了就每次都弹，总比漏报强 */ }
  ctx.ui.toast(`记忆向量接口失败：${text}`, 'bad');
}

/** 记忆管理：筛选、列表、批量操作、分页、导入导出。 */
function manageSheet(ctx: WebUiPanelContext, view: MemoryView, reload: () => void): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '记忆管理',
    en: 'memories',
    desc: '按条件筛条目；可改重要性、切休眠、批量删除，也可以导出与导入。',
  });
  const state = {
    offset: 0,
    limit: 20,
    total: view.total,
    selected: new Set<string>(),
    items: view.items,
  };

  const statsEl = ui.msgline(statsText(view.stats));
  sheet.body.appendChild(statsEl);
  const msg = ui.msgline('');

  // ── 工具栏 ────────────────────────────────────────────────
  const bar = ui.rowbar();
  const search = ui.input({ type: 'search', placeholder: '关键字（正文 / 主题）…', cls: 'grow' });
  const status = ui.select({
    value: 'all',
    options: [
      { value: 'all', label: '全部状态' },
      { value: 'active', label: '清醒' },
      { value: 'dormant', label: '休眠' },
    ],
  });
  const kind = ui.select({
    value: 'all',
    options: [{ value: 'all', label: '全部类型' }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))],
  });
  const sort = ui.select({
    value: 'newest',
    options: [
      { value: 'newest', label: '最新发生' },
      { value: 'oldest', label: '最早发生' },
      { value: 'importance', label: '重要性高到低' },
    ],
  });
  const pageSize = ui.select({
    value: '20',
    options: [
      { value: '20', label: '20 条/页' },
      { value: '50', label: '50 条/页' },
      { value: '100', label: '100 条/页' },
    ],
  });
  bar.append(search, status, kind, sort, pageSize, uidButton(ctx, '筛选', () => { void load(0); }, 'primary'));

  // ── 批量条 ────────────────────────────────────────────────
  const bulkBar = ui.rowbar();
  const selInfo = ui.h('span', 'text-secondary', '已选 0 条');
  bulkBar.append(
    selInfo,
    ui.button('全选本页', { size: 'sm', variant: 'plain', onClick: () => {
      for (const item of state.items) state.selected.add(item.id);
      draw();
    } }),
    ui.button('清空选择', { size: 'sm', variant: 'plain', onClick: () => {
      state.selected.clear();
      draw();
    } }),
    ui.button('休眠', { size: 'sm', variant: 'plain', onClick: () => { void bulk('dormant'); } }),
    ui.button('唤醒', { size: 'sm', variant: 'plain', onClick: () => { void bulk('active'); } }),
    ui.button('删除', { size: 'sm', variant: 'plain', onClick: () => { void bulk('remove'); } }),
    ui.h('span', 'grow'),
    ui.button('刷新', { size: 'sm', variant: 'plain', onClick: () => { void load(state.offset); } }),
  );

  const list = ui.table({ head: ['', '时间', '类型', '正文', '重要', '状态', '来源', '操作'] });
  const pager = ui.rowbar();
  const pageInfo = ui.h('span', 'text-secondary');

  const load = async (offset: number): Promise<void> => {
    try {
      state.offset = offset;
      state.limit = Number(pageSize.value) || 20;
      const next = await ctx.invoke<MemoryView>('list', [{
        query: search.value.trim(),
        status: status.value,
        kind: kind.value,
        sort: sort.value,
        limit: state.limit,
        offset,
      }]);
      state.total = next.total;
      state.items = next.items;
      // 统计条要跟着刷新：改了状态却显示旧数字，比不显示更糟。
      statsEl.textContent = statsText(next.stats);
      // 选中项跟着筛选走：不在当前结果里的选择留着也没用，清掉更不容易误删。
      state.selected.clear();
      draw();
    } catch (err) {
      setMsg(msg, `读取失败: ${errText(err)}`, true);
    }
  };

  // 操作后的就地刷新：只重取列表与统计，不重挂整块面板——否则操作回执会被一起重建掉。
  const refreshRows = (): void => { void load(state.offset); };

  const bulk = async (op: 'dormant' | 'active' | 'remove'): Promise<void> => {
    const ids = [...state.selected];
    if (ids.length === 0) { setMsg(msg, '先勾选条目', true); return; }
    if (op === 'remove') {
      const ok = await ui.confirm({
        title: `删除 ${ids.length} 条记忆?`,
        body: '只删除索引行；来源文件不受影响，重跑 backfill 会加回来。',
      });
      if (!ok) return;
    }
    try {
      const out = await ctx.invoke<{ ok: boolean; result: string }>('bulk', [op, ids]);
      setMsg(msg, out.result);
      state.selected.clear();
      refreshRows();
    } catch (err) {
      setMsg(msg, `批量操作失败: ${errText(err)}`, true);
    }
  };

  const draw = (): void => {
    selInfo.textContent = `已选 ${state.selected.size} 条`;
    drawRows(ctx, list, state.items, state.selected, msg, () => { draw(); }, () => { refreshRows(); });
    const from = state.total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + state.items.length, state.total);
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    const page = Math.min(pages, Math.floor(state.offset / state.limit) + 1);
    pageInfo.textContent = `第 ${page} / ${pages} 页 · 共 ${state.total} 条（${from}–${to}）`;
    prev.disabled = state.offset <= 0;
    next.disabled = state.offset + state.items.length >= state.total;
  };

  const prev = ui.button('上一页', { size: 'sm', variant: 'plain', onClick: () => { void load(Math.max(0, state.offset - state.limit)); } });
  const next = ui.button('下一页', { size: 'sm', variant: 'plain', onClick: () => { void load(state.offset + state.limit); } });
  pager.append(prev, next, pageInfo);

  search.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') void load(0);
  });
  status.addEventListener('change', () => { void load(0); });
  kind.addEventListener('change', () => { void load(0); });
  sort.addEventListener('change', () => { void load(0); });
  pageSize.addEventListener('change', () => { void load(0); });

  draw();
  sheet.body.append(
    bar, bulkBar, list.el, pager,
    graphBox(ctx),
    transferBox(ctx, () => ({
      query: search.value.trim(),
      status: status.value,
      kind: kind.value,
      sort: sort.value,
    }), () => [...state.selected], () => { refreshRows(); }),
    recallBox(ctx), recallLog(ctx, view.recalls), msg,
  );
  return sheet.el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

const NODE_COLOR: Record<string, string> = {
  person: '#e0a458',
  topic: '#5b8def',
  source: '#7d8590',
};

/** 知识图谱：人物 / 主题 / 来源的共现关系，点节点看它连着什么。 */
function graphBox(ctx: WebUiPanelContext): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '知识图谱',
    en: 'knowledge graph',
    desc: '节点来自每条记忆自带的人物、主题与来源；边是「同一条记忆里一起出现」。不另建图存储——条目一改，图跟着变。',
  });
  const msg = ui.msgline('加载图谱…');
  const canvas = ui.h('div');
  const detail = ui.h('div');

  const showNode = async (id: string): Promise<void> => {
    try {
      const out = await ctx.invoke<NeighborView>('neighbors', [id]);
      const head = ui.rowbar();
      head.append(
        ui.pill(out.node.label, 'plain'),
        ui.pill(`${out.node.count} 条记忆`, 'plain'),
      );
      const chips = ui.rowbar();
      for (const n of out.neighbors.slice(0, 12)) {
        chips.appendChild(ui.button(`${n.node.label}·${n.weight}`, {
          size: 'sm',
          variant: 'plain',
          onClick: () => { void showNode(n.node.id); },
        }));
      }
      const list = ui.table({ head: ['时间', '正文'] });
      if (!out.memories.length) list.clear('这个节点还没有关联记忆。');
      for (const m of out.memories) {
        list.addRow([
          { text: m.eventTime.slice(0, 10), cls: 'mono' },
          { text: m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text, cls: 'txt' },
        ]);
      }
      detail.replaceChildren(head, chips, list.el);
    } catch (err) {
      detail.replaceChildren(ui.msgline(`读取节点失败: ${errText(err)}`));
    }
  };

  void (async () => {
    try {
      const data = await ctx.invoke<GraphView>('graph', []);
      msg.textContent = data.nodes.length
        ? `人物 ${data.stats.persons} · 主题 ${data.stats.topics} · 来源 ${data.stats.sources} · 关系 ${data.stats.edges}`
        : '还没有可以成图的实体：记忆里没有人物或主题。';
      if (!data.nodes.length) return;

      const W = 560;
      const H = 360;
      const cx = W / 2;
      const cy = H / 2;
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: String(H) });

      // 人物放内圈、主题与来源放外圈：一眼能看出"谁"和"什么"是两层。
      const persons = data.nodes.filter((n) => n.type === 'person');
      const rest = data.nodes.filter((n) => n.type !== 'person');
      const pos = new Map<string, { x: number; y: number; r: number }>();
      const place = (nodes: GraphNode[], radius: number): void => {
        nodes.forEach((node, i) => {
          const angle = (Math.PI * 2 * i) / Math.max(1, nodes.length) - Math.PI / 2;
          pos.set(node.id, {
            x: cx + Math.cos(angle) * radius,
            y: cy + Math.sin(angle) * radius,
            r: 4 + Math.min(18, node.count) ** 0.5 * 1.5,
          });
        });
      };
      place(persons, persons.length > 1 ? 78 : 0);
      place(rest, rest.length > 1 ? 158 : 60);

      for (const edge of data.edges) {
        const a = pos.get(edge.a);
        const b = pos.get(edge.b);
        if (!a || !b) continue;
        svg.appendChild(svgEl('line', {
          x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1),
          stroke: '#8b949e',
          'stroke-opacity': (0.12 + Math.min(edge.weight, 6) * 0.07).toFixed(2),
          'stroke-width': Math.min(3, 0.6 + edge.weight * 0.35).toFixed(2),
        }));
      }

      const labelNodes = new Set(
        [...data.nodes].sort((a, b) => b.count - a.count).slice(0, 14).map((n) => n.id),
      );
      for (const node of data.nodes) {
        const p = pos.get(node.id);
        if (!p) continue;
        const circle = svgEl('circle', {
          cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: p.r.toFixed(1),
          fill: NODE_COLOR[node.type] ?? '#888',
          'fill-opacity': '0.85',
          stroke: '#0d1117',
          'stroke-width': '1',
          cursor: 'pointer',
        });
        circle.addEventListener('click', () => { void showNode(node.id); });
        const title = svgEl('title', {});
        title.textContent = `${node.label} · ${node.count} 条`;
        circle.appendChild(title);
        svg.appendChild(circle);
        if (labelNodes.has(node.id)) {
          const text = svgEl('text', {
            x: p.x.toFixed(1),
            y: (p.y + p.r + 11).toFixed(1),
            'text-anchor': 'middle',
            'font-size': '10',
            fill: 'currentColor',
            'fill-opacity': '0.85',
            'pointer-events': 'none',
          });
          text.textContent = node.label.length > 10 ? `${node.label.slice(0, 10)}…` : node.label;
          svg.appendChild(text);
        }
      }

      const legend = ui.rowbar();
      legend.append(
        ui.pill('人物', 'plain'),
        ui.pill('主题', 'plain'),
        ui.pill('来源文件', 'plain'),
        ui.h('span', 'text-secondary', '点节点看关联'),
      );
      canvas.replaceChildren(legend, svg);
    } catch (err) {
      msg.textContent = `图谱不可用: ${errText(err)}`;
    }
  })();

  sheet.body.append(msg, canvas, detail);
  return sheet.el;
}

/** 小工具：带 primary 样式的按钮（ui.button 的 variant 走选项，包一层少写重复）。 */
function uidButton(ctx: WebUiPanelContext, label: string, onClick: () => void, variant: 'primary' | 'plain' = 'plain'): HTMLElement {
  return ctx.ui.button(label, { size: 'sm', variant, onClick });
}

function statsText(stats: MemoryStats): string {
  const kinds = Object.entries(stats.byKind).map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`).join(' · ');
  const dormant = stats.byStatus.dormant ?? 0;
  const vec = stats.vectorized === null ? '未启用' : `${stats.vectorized}/${stats.total}`;
  return `共 ${stats.total} 条 · ${kinds} · 休眠 ${dormant} · 平均重要性 ${stats.avgImportance.toFixed(2)}`
    + ` · 来源 ${stats.sources} 个 · 已向量化 ${vec}`;
}

function drawRows(
  ctx: WebUiPanelContext,
  list: WebUiTable,
  items: MemoryItem[],
  selected: Set<string>,
  msg: HTMLElement,
  refresh: () => void,
  refreshRows: () => void,
): void {
  const { ui } = ctx;
  list.clear(items.length ? undefined : '没有符合条件的记忆。');
  for (const item of items) {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(item.id);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(item.id);
      else selected.delete(item.id);
      refresh();
    });

    const importance = ui.input({ type: 'number', value: item.importance.toFixed(2), cls: 'mono' });
    importance.min = '0';
    importance.max = '1';
    importance.step = '0.1';
    importance.style.width = '64px';
    importance.addEventListener('change', () => {
      void (async () => {
        const value = Number(importance.value);
        if (!Number.isFinite(value)) { setMsg(msg, '重要性要是 0–1 的数字', true); return; }
        try {
          const out = await ctx.invoke<{ ok: boolean; result: string }>('update', [item.id, { importance: value }]);
          setMsg(msg, out.result);
          refreshRows();
        } catch (err) {
          setMsg(msg, `更新失败: ${errText(err)}`, true);
        }
      })();
    });

    const actions = ui.rowbar();
    actions.append(
      ui.button(item.status === 'active' ? '休眠' : '唤醒', {
        size: 'sm',
        variant: 'plain',
        onClick: () => {
          void (async () => {
            try {
              const nextStatus = item.status === 'active' ? 'dormant' : 'active';
              const out = await ctx.invoke<{ ok: boolean; result: string }>('update', [item.id, { status: nextStatus }]);
              setMsg(msg, out.result);
              refreshRows();
            } catch (err) {
              setMsg(msg, `更新失败: ${errText(err)}`, true);
            }
          })();
        },
      }),
      ui.button('删', {
        size: 'sm',
        variant: 'plain',
        onClick: () => {
          void (async () => {
            const ok = await ui.confirm({
              title: '删除这条记忆?',
              body: `${item.text.slice(0, 120)}\n\n只删除索引行；来源文件不受影响，重跑 backfill 会把它加回来。`,
            });
            if (!ok) return;
            try {
              const out = await ctx.invoke<{ ok: boolean; result: string }>('remove', [item.id]);
              setMsg(msg, out.result);
              refreshRows();
            } catch (err) {
              setMsg(msg, `删除失败: ${errText(err)}`, true);
            }
          })();
        },
      }),
    );

    list.addRow([
      { el: check },
      { text: item.eventTime.slice(0, 10), cls: 'mono' },
      ui.pill(KIND_LABEL[item.kind] ?? item.kind, 'plain'),
      { text: item.text.length > 90 ? `${item.text.slice(0, 90)}…` : item.text, cls: 'txt' },
      { el: importance },
      ui.pill(item.status === 'active' ? '清醒' : '休眠', 'plain'),
      { text: item.source ?? '—', cls: 'mono' },
      { el: actions },
    ]);
  }
}

/** 导入与导出：导的是索引行，不含向量（向量绑模型，换模型就废）。 */
function transferBox(
  ctx: WebUiPanelContext,
  filter: () => Record<string, string>,
  selectedIds: () => string[],
  refreshRows: () => void,
): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '导入与导出',
    en: 'export / import',
    desc: '导出是 JSON 索引行，不含向量——导入后会在后台按当前模型重算。导入按 id 判重：跳过已存在，或覆盖同 id。',
  });
  const msg = ui.msgline('');

  // 导出
  const exportRow = ui.rowbar();
  const scope = ui.select({
    value: 'filtered',
    options: [
      { value: 'filtered', label: '当前筛选结果' },
      { value: 'selected', label: '仅选中项' },
    ],
  });
  exportRow.append(scope, ui.button('导出 JSON', {
    size: 'sm',
    variant: 'primary',
    onClick: () => {
      void (async () => {
        try {
          const ids = scope.value === 'selected' ? selectedIds() : [];
          if (scope.value === 'selected' && ids.length === 0) { setMsg(msg, '还没有勾选任何条目', true); return; }
          const out = await ctx.invoke<{ filename: string; content: string; count: number }>('export', [{
            ...filter(),
            ...(ids.length ? { ids } : {}),
          }]);
          const blob = new Blob([out.content], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = out.filename;
          a.click();
          URL.revokeObjectURL(url);
          setMsg(msg, `已导出 ${out.count} 条 → ${out.filename}`);
        } catch (err) {
          setMsg(msg, `导出失败: ${errText(err)}`, true);
        }
      })();
    },
  }));

  // 导入
  const importRow = ui.rowbar();
  const mode = ui.select({
    value: 'skip',
    options: [
      { value: 'skip', label: '跳过已存在' },
      { value: 'overwrite', label: '覆盖同 id' },
    ],
  });
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'application/json,.json';
  file.style.display = 'none';
  file.addEventListener('change', () => {
    void (async () => {
      const picked = file.files?.[0];
      if (!picked) return;
      try {
        if (picked.size > 5 * 1024 * 1024) { setMsg(msg, '文件超过 5 MB', true); file.value = ''; return; }
        const text = await picked.text();
        const ok = await ui.confirm({
          title: `导入 ${picked.name}?`,
          body: `${(picked.size / 1024).toFixed(1)} KB · 模式：${mode.value === 'overwrite' ? '覆盖同 id' : '跳过已存在'}\n\n只写索引，不动来源文件。`,
        });
        if (!ok) { file.value = ''; return; }
        const out = await ctx.invoke<{ ok: boolean; result: string }>('import', [text, mode.value]);
        setMsg(msg, out.result);
        refreshRows();
      } catch (err) {
        setMsg(msg, `导入失败: ${errText(err)}`, true);
      } finally {
        file.value = '';
      }
    })();
  });
  importRow.append(
    mode,
    ui.button('选择文件导入…', { size: 'sm', variant: 'plain', onClick: () => file.click() }),
    file,
  );

  sheet.body.append(exportRow, importRow, msg);
  return sheet.el;
}

/** 召回测试：把每一路的得分摊开，回答「为什么召回它」。 */
function recallBox(ctx: WebUiPanelContext): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '召回测试',
    en: 'recall',
    desc: '和唤醒注入走同一条检索路径。分项说明它是靠关键词、语义，还是仅仅因为重要/新鲜被排上来。Ctrl / ⌘ + Enter 直接执行。',
  });
  const row = ui.rowbar();
  const query = ui.input({ type: 'search', placeholder: '她如果想起这件事，会问什么？', cls: 'grow' });
  const kInput = ui.input({ type: 'number', value: '5' });
  kInput.min = '1';
  kInput.max = '20';
  kInput.style.width = '64px';
  const result = ui.h('div');
  const msg = ui.msgline('');

  const run = async (): Promise<void> => {
    const value = query.value.trim();
    if (!value) { setMsg(msg, '先写一个查询', true); return; }
    const k = Math.min(20, Math.max(1, Number(kInput.value) || 5));
    try {
      const out = await ctx.invoke<{ hits: RecallHit[]; vector: boolean }>('recall', [value, k]);
      msg.textContent = out.vector
        ? `向量路已启用 · 命中 ${out.hits.length} 条`
        : `只用关键词检索 · 命中 ${out.hits.length} 条`;
      result.replaceChildren(
        ...(out.hits.length
          ? out.hits.map((hit, i) => hitCard(ctx, hit, i + 1, out.vector))
          : [ui.msgline('没有命中。')]),
      );
    } catch (err) {
      setMsg(msg, `召回失败: ${errText(err)}`, true);
    }
  };
  query.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run();
    else if (e.key === 'Enter') void run();
  });
  row.append(query, kInput, ui.button('执行召回', { size: 'sm', variant: 'primary', onClick: () => { void run(); } }));
  sheet.body.append(row, msg, result);
  return sheet.el;
}

function hitCard(ctx: WebUiPanelContext, hit: RecallHit, rank: number, vectorOn: boolean): HTMLElement {
  const { ui } = ctx;
  const card = ui.h('div', 'mem-hit');
  card.style.cssText = 'border-top:1px solid var(--line,#2a2a2a);padding:8px 0';

  const head = ui.rowbar();
  head.append(
    ui.h('span', 'mono', `#${rank}`),
    ui.pill(hit.score.toFixed(3), 'plain'),
    ui.pill(hit.status === 'active' ? '清醒' : '休眠', 'plain'),
    ui.pill(KIND_LABEL[hit.kind] ?? hit.kind, 'plain'),
  );
  card.appendChild(head);
  card.appendChild(ui.h('div', 'txt', hit.text));

  const chipRow = ui.rowbar();
  const chips: Array<[string, number]> = [
    ['关键词', hit.breakdown.bm25],
    ['语义', hit.breakdown.vector],
    ['重要', hit.breakdown.importance],
    ['新鲜', hit.breakdown.recency],
  ];
  for (const [label, value] of chips) {
    if (value > 0) chipRow.appendChild(ui.pill(`${label} ${value.toFixed(2)}`, 'plain'));
  }
  if (vectorOn && hit.breakdown.vector === 0) chipRow.appendChild(ui.pill('未向量化', 'plain'));
  card.appendChild(chipRow);
  card.appendChild(ui.h('div', 'text-secondary', `${hit.eventTime.slice(0, 10)}${hit.source ? ` · ${hit.source}` : ''}`));
  return card;
}

function recallLog(ctx: WebUiPanelContext, recalls: RecallEntry[]): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '最近召回',
    en: 'recalls.jsonl',
    desc: '她实际查过什么、查到几条。面板里的召回测试不计入这里。',
  });
  const table = ui.table({ head: ['时间', '查询', '调用方', '命中'] });
  if (!recalls.length) table.clear('还没有召回记录。');
  for (const entry of recalls) {
    table.addRow([
      { text: (entry.ts ?? '').replace('T', ' ').slice(0, 19), cls: 'mono' },
      { text: entry.query ?? '', cls: 'txt' },
      { text: entry.caller ?? '', cls: 'mono' },
      { text: String(entry.hits?.length ?? 0), cls: 'mono' },
    ]);
  }
  sheet.body.appendChild(table.el);
  return sheet.el;
}
