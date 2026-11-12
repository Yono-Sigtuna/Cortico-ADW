/**
 * 陪伴页的浏览器实现：十个页签，各取自己那一份数据。
 *
 * 分区对齐 AstrBot「我会永远陪着你」的陪伴面板，但内容只用 Cortico 真有的东西：
 * 状态与日记来自梦，人来自 people/ 与记忆索引，主动来自陪伴层的判定，
 * 用量来自 usage.jsonl，排障来自唤醒日志。没有数据的格子如实写没有。
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { autoload, errText, setMsg } from '../../cormini/webui/shared.ts';

// ---------------------------------------------------------------------------
// 服务端形状（bots/amber/persona/companionPanel.ts）
// ---------------------------------------------------------------------------

interface Mood {
  baseline: number;
  joy: number;
  anger: number;
  sorrow: number;
  fear: number;
  intensity: string | null;
  description: string;
}

interface RoleStateView {
  energy: number;
  mood: Mood;
  sleep: string | null;
  busy: string | null;
  health: string | null;
  presence: string | null;
  onlineMode: string | null;
  conditions: Array<{ kind: string; text: string; expiresAt: string | null }>;
  basis: string;
  updatedAt: number;
}

interface ConvRow {
  conv: string;
  lastUserAt: number | null;
  lastBotAt: number | null;
  openLoop: string | null;
  followed: boolean;
  lastAttemptAt: number | null;
}

interface WakeRow {
  id: string | null;
  ts: string | null;
  reason: string | null;
  outcome: string | null;
  durationMs: number | null;
  estTokens: number | null;
  prefixChars: number | null;
  types: string[];
  sent: string | null;
}

interface Settings {
  enabled: boolean;
  allowPrivate: boolean;
  allowGroups: boolean;
  participateGroups: boolean;
  topicWindowMinutes: number;
  topicDailyCap: number;
  dreamEveryHours: number;
  dailyCap: number;
  followupMinutes: number;
  followupCooldownMinutes: number;
  quietStartHour: number;
  quietEndHour: number;
  sleepStartHour: number;
  sleepEndHour: number;
}

interface SlotView {
  time: string;
  end: string;
  activity: string;
  mood: string | null;
  messageSeed: string | null;
  location: string | null;
  state: 'planned' | 'active' | 'completed';
  startMin: number;
  endMin: number;
}

interface TodayFacts {
  date: string;
  refreshedAt: number;
  weather: string;
  location: string;
  mood: string;
  moodDetail: string;
  agendaCount: number;
  planSource: 'dream' | 'fallback' | 'none';
  health: string;
  outfit: string;
  sleep: string;
  body: string;
  cycleName: string | null;
  cycleDay: number | null;
  cycleDays: number | null;
  hunger: string;
  dreamText: string;
  energy: number;
}

interface OverviewState {
  enabled: boolean;
  /** 向量接口最近一次失败；非 null 说明召回正在退回关键词。 */
  embeddingError: { at: number; text: string } | null;
  role: RoleStateView | null;
  caps: { proactiveToday: number; dailyCap: number; topicToday: number; topicDailyCap: number };
  diary: { date: string; text: string } | null;
  dream: { lastHandoffAt: number | null; everyHours: number; lastActivityAt: number | null; due: boolean };
  wakes: WakeRow[];
  convs: ConvRow[];
  counts: { wakesToday: number; sentToday: number };
  today: TodayFacts | null;
  current: SlotView | null;
  next: SlotView | null;
  timeline: SlotView[];
  intero: {
    socialBattery: number;
    load: number;
    updatedAt: number;
    gates: { enabled: boolean; lowBattery: number; highLoad: number };
  } | null;
}

interface PersonRow {
  qq: string;
  name: string;
  summary: string;
  aliases: string[];
  views: number;
  memories: number;
  lastSeenAt: number | null;
  file: string;
}

interface PersonDetail {
  person: PersonRow;
  views: string[];
  memories: Array<{ text: string; eventTime: string; kind: string; score: number }>;
  counts: { active: number; dormant: number };
  relation: { trust: number; familiarity: number; affinity: number; boundary: number; basis: string } | null;
}

interface GroupsState {
  groups: Array<{
    id: string; enabled: boolean; conv: string;
    lastUserAt: number | null; lastBotAt: number | null; openLoop: string | null; lastAttemptAt: number | null;
  }>;
  diagnose: { ok: boolean; reason: string };
  caps: { participateGroups: boolean; topicWindowMinutes: number; topicDailyCap: number; topicToday: number };
}

interface AttentionConfigView {
  enabled: boolean;
  peripheryThreshold: number;
  windowMinutes: number;
  habituationMinutes: number;
}

interface AttentionRow {
  at: number;
  ts: string;
  convKey: string;
  senderName: string;
  tier: string;
  score: number;
  reasons: string[];
  preview: string;
}

/** 一个群此刻的形状：World 数出来的数字，加上她自己写的判断。 */
interface RoomRow {
  conv: string;
  groupId: number | string;
  line: string | null;
  messages: number;
  speakers: number;
  heat: string;
  monologue: boolean;
  replyShare: number;
  toSelf: number;
  lullMinutes: number | null;
  note: { label: string; text: string; expiresAt: number } | null;
}

interface CreativeBibleView {
  mainline: string;
  themes: string[];
  openThreads: string[];
  facts: string[];
  nextDirection: string;
}

interface CreativeChapterView {
  index: number;
  summary: string;
  chars: number;
}

interface CreativeVolumeView {
  index: number;
  title: string;
  summary: string;
  chapters: CreativeChapterView[];
}

interface CreativeWorkRow {
  id: string;
  title: string;
  workType: string;
  premise: string;
  tone: string;
  status: 'drafting' | 'finished';
  file: string;
  currentChars: number;
  targetChars: number;
  chunkCount: number;
  maturity: number;
  createdAt: number;
  lastAdvancedAt: number;
  nextAdvanceAt: number | null;
  failures: number;
  lastError: string;
  disclosed: string[];
  pendingShare: string | null;
  sourceLabel: string;
  sourceText: string;
  bible: CreativeBibleView;
  /** 长篇才有。 */
  volumes?: CreativeVolumeView[];
  /** 短 / 中 / 长。 */
  scale?: string;
}

interface CreativeStateView {
  enabled: boolean;
  chunksToday: number;
  sharesToday: number;
  gate: string | null;
  settings: {
    chunkChars: number;
    maxActiveWorks: number;
    advanceMinutes: [number, number];
    maxChunksPerDay: number;
    shareEnabled: boolean;
    shareDailyCap: number;
    direction: string;
  };
  lastRun: { at: number; ok: boolean; reason: string; chars: number; ms: number } | null;
  works: CreativeWorkRow[];
}

interface MemoryItem {
  text: string;
  kind: string;
  eventTime: string;
  status: string;
  source: string | null;
  importance: number;
}

interface RecallRecord {
  ts: string | null;
  query: string | null;
  caller: string | null;
  hits: Array<{ text: string; score: number }>;
}

interface WorldState {
  files: Array<{ path: string; size: number; mtime: number }>;
  worldview: string;
  constitution: string;
  memoryDir: string;
}

interface ProactiveState {
  diagnose: { ok: boolean; reason: string };
  gate: string | null;
  candidates: Array<{ conv: string; kind: string; summary: string }>;
  convs: ConvRow[];
  caps: Settings;
  records: WakeRow[];
}

interface CardRow {
  tier: 'core' | 'library';
  name: string;
  question: string;
  answer: string;
  mtime: number;
}

interface TokensState {
  today: { calls: number; input: number; output: number; cached: number };
  days: Array<{ date: string; calls: number; input: number; output: number }>;
  providers: Array<{ name: string; calls: number; total: number }>;
  purposes: Array<{ name: string; calls: number; total: number }>;
  recent: Array<{
    ts: string | null; instance: string; model: string; purpose: string;
    input: number; output: number; elapsedMs: number | null; outcome: string;
  }>;
}

interface TroubleshootState {
  run: {
    enabled: boolean; energy: number | null; updatedAt: number | null;
    memoryTotal: number | null; vectors: number | null; prefixChars: number | null;
  };
  wakes: WakeRow[];
  outcomes: Array<{ outcome: string; n: number }>;
  dream: OverviewState['dream'];
  errors: string[];
}

interface ConfigState {
  group: string;
  settings: Settings;
  role: RoleStateView | null;
  life: {
    city: string;
    weatherEnabled: boolean;
    weatherRefreshMinutes: number;
    homeName: string;
    planItemCount: number;
    cycleEnabled: boolean;
    cycleAnchor: string;
  };
  intero: { enabled: boolean; lowBattery: number; highLoad: number; replyBattery: number; hesitationSeconds: number };
}

interface ViewRow {
  qq: string;
  name: string;
  file: string;
  summary: string;
  views: string[];
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function when(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function whenIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? when(ms) : iso.slice(0, 16).replace('T', ' ');
}

function ago(ms: number | null | undefined): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  const min = Math.round(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.round(hr / 24)} 天前`;
}

function num(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function outcomePill(ctx: WebUiPanelContext, outcome: string | null): HTMLElement {
  const tone = outcome === 'sent' ? 'on' : outcome === 'silent' ? 'plain' : 'off';
  return ctx.ui.pill(outcome ?? '—', tone);
}

function refreshButton(ctx: WebUiPanelContext, reload: () => void): HTMLElement {
  const bar = ctx.ui.actions();
  bar.append(ctx.ui.h('span', 'grow'), ctx.ui.button('刷新', { size: 'sm', variant: 'plain', onClick: reload }));
  return bar;
}

function dreamLine(dream: OverviewState['dream']): string {
  const since = dream.lastHandoffAt ? ago(dream.lastHandoffAt) : null;
  return `整理：${since ? `上次 ${since}` : '还没入过梦'}`
    + ` · 兜底 ${dream.everyHours > 0 ? `${dream.everyHours} 小时` : '关闭'}`
    + ` · 现在${dream.due ? '会' : '不会'}入梦`;
}

// ---------------------------------------------------------------------------
// 总览
// ---------------------------------------------------------------------------

/** 向量接口失败只弹一次：刷新面板不该重复报警，新的一次要能弹出来。 */
const EMBED_ALERT_KEY = 'amber.embedding-alert-at';
function embedAlertOnce(at: number, text: string, toast: (text: string) => void): void {
  try {
    const store = globalThis.localStorage;
    if (Number(store.getItem(EMBED_ALERT_KEY) ?? 0) >= at) return;
    store.setItem(EMBED_ALERT_KEY, String(at));
  } catch { /* 存不了就每次都弹，总比漏报强 */ }
  toast(`记忆向量接口失败：${text}`);
}

const overviewPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<OverviewState>(ctx, {
      loading: '读取她此刻的状态…',
      failed: '陪伴层不可用',
      load: () => ctx.invoke<OverviewState>('state'),
      render: (st, reload) => {
        const out: Node[] = [];
        const facts = st.today;
        // 向量接口挂了会静默退回关键词检索——不主动报，就永远发现不了。
        if (st.embeddingError) {
          const bar = ui.rowbar();
          bar.append(
            ui.msgline(`记忆向量接口失败：${st.embeddingError.text}（${new Date(st.embeddingError.at).toLocaleString()}）——这几轮召回已退回关键词。`, true),
          );
          out.push(bar);
          embedAlertOnce(st.embeddingError.at, st.embeddingError.text, (text) => ui.toast(text, 'bad'));
        }

        // —— 今日：八格事实 ——
        const today = ui.sheet({ title: '今日', en: 'today' });
        const head = ui.h('div', 'today-head');
        head.appendChild(ui.h('span', 'date', facts ? `${facts.date} · 已刷新 ${clockText()}` : '等待刷新'));
        const weatherBtn = ui.button('刷新天气', {
          size: 'sm',
          variant: 'plain',
          onClick: () => {
            weatherBtn.disabled = true;
            void ctx.invoke('refreshWeather').then(
              () => { weatherBtn.disabled = false; reload(); },
              () => { weatherBtn.disabled = false; },
            );
          },
        });
        head.appendChild(weatherBtn);
        today.body.appendChild(head);

        if (facts) {
          const grid = ui.h('div', 'today-grid');
          const cell = (k: string, v: string, sub?: string, title?: string): HTMLElement => {
            const box = ui.h('div', 'today-cell');
            box.appendChild(ui.h('span', 'k', k));
            const value = ui.h('div', 'v', v || '暂无数据');
            value.title = title || v || '';
            box.appendChild(value);
            if (sub) box.appendChild(ui.h('span', 'sub', sub));
            return box;
          };
          grid.append(
            cell('天气', facts.weather, facts.weather === '暂无天气信息' ? '没接天气源' : ''),
            cell('地点', facts.location, '按日程推断'),
            cell('心情', facts.mood, '', facts.moodDetail),
            cell('日程', `${facts.agendaCount} 个时间段`,
              facts.planSource === 'dream' ? '梦写的' : facts.planSource === 'fallback' ? '临时排程' : ''),
            cell('健康', facts.health),
            cell('穿搭', facts.outfit || '暂无穿搭图', facts.outfit ? '文字记录' : '未接生图'),
            cell('睡眠', facts.sleep),
            cell('身体', facts.cycleName
              ? `${facts.cycleName} 第${facts.cycleDay}/${facts.cycleDays}天`
              : facts.body),
          );
          today.body.appendChild(grid);
          if (facts.planSource === 'fallback') {
            today.body.appendChild(ui.h('div', 'today-note', '今天的日程还是临时排程——下一次入梦会由她重写。'));
          }
        } else {
          today.body.appendChild(ui.placeholder('生活层未挂载。'));
        }

        const chips = ui.rowbar();
        chips.append(
          ui.chip(`精力 ${facts?.energy ?? (st.role ? Math.round(st.role.energy) : '—')}`, 'accent'),
          ...(st.intero
            ? [
                ui.chip(
                  `电量 ${Math.round(st.intero.socialBattery * 100)}%`,
                  st.intero.socialBattery < st.intero.gates.lowBattery ? 'warn' : 'plain',
                ),
                ui.chip(
                  `负荷 ${Math.round(st.intero.load * 100)}%`,
                  st.intero.load > st.intero.gates.highLoad ? 'warn' : 'plain',
                ),
              ]
            : []),
          ui.chip(`主动 ${st.caps.proactiveToday}/${st.caps.dailyCap}`),
          ui.chip(`接话题 ${st.caps.topicToday}/${st.caps.topicDailyCap}`),
          ui.chip(`今天醒 ${st.counts.wakesToday} 次`),
          ui.chip(`说过 ${st.counts.sentToday} 次`),
        );
        today.body.appendChild(chips);
        out.push(today.el);

        if (st.intero) {
          const intero = st.intero;
          const sheet = ui.foldSheet('overview-intero', {
            title: '内感受',
            en: 'intero',
            desc: '从消息流算出来的两个慢变量：有人来找会掉电，复读掉得更多；短时间消息堆进来负荷升高。它们决定她要不要主动开口，不来自梦。',
          });
          const bar = (label: string, value: number, limit: number, over: string, color: string): HTMLElement => {
            const box = ui.h('div');
            box.appendChild(ui.h('div', 'now-meta', `${label} ${Math.round(value * 100)}%（${over} ${Math.round(limit * 100)}% 时不主动）`));
            const track = ui.h('div', 'energybar');
            const fill = ui.h('i');
            fill.style.width = `${Math.max(2, Math.min(100, Math.round(value * 100)))}%`;
            fill.style.background = color;
            track.appendChild(fill);
            box.appendChild(track);
            return box;
          };
          sheet.body.append(
            bar('社交电量', intero.socialBattery, intero.gates.lowBattery, '低于', 'var(--accent)'),
            bar('负荷', intero.load, intero.gates.highLoad, '高于', 'var(--warn)'),
            ui.h('div', 'text-secondary',
              `更新时间：${when(intero.updatedAt)} · 门：${intero.gates.enabled ? '开' : '关'}`),
          );
          out.push(sheet.el);
        }

        // —— 当前：她这一时段在做什么 ——
        const current = ui.sheet({ title: '当前', en: 'current' });
        if (st.current) {
          current.body.appendChild(ui.h('div', 'now-activity', st.current.activity));
          current.body.appendChild(ui.h('div', 'now-meta',
            `${st.current.time}–${st.current.end} · ${stateText(st.current.state)}`
            + `${st.current.mood ? ` · ${st.current.mood}` : ''}`));
          if (st.current.messageSeed) current.body.appendChild(ui.h('div', 'now-seed', st.current.messageSeed));
          const energy = facts?.energy ?? (st.role ? Math.round(st.role.energy) : 0);
          const bar = ui.h('div', 'energybar');
          const fill = ui.h('i');
          fill.style.width = `${Math.max(0, Math.min(100, energy))}%`;
          bar.appendChild(fill);
          current.body.append(ui.h('div', 'now-meta', `体力 ${energy}/100`), bar);
          const now = ui.h('div', 'now-grid');
          const item = (k: string, v: string): void => {
            now.appendChild(ui.h('span', 'k', k));
            const value = ui.h('span', 'v', v || '暂无');
            value.title = v || '';
            now.appendChild(value);
          };
          item('状态', facts?.health ?? '');
          item('睡眠', facts?.sleep ?? '');
          item('饥饿', facts?.hunger ?? '');
          item('梦境', facts?.dreamText ?? '');
          item('位置', facts?.location ?? '');
          item('心情', facts?.mood ?? '');
          current.body.appendChild(now);
        } else {
          current.body.appendChild(ui.placeholder('暂无当前计划时段。'));
        }
        out.push(current.el);

        // —— 日程：一整天的时间轴 ——
        const agenda = ui.sheet({ title: '日程', en: 'agenda' });
        if (st.timeline.length) {
          const list = ui.h('div', 'agenda');
          for (const slot of st.timeline) {
            const row = ui.h('div', `agenda-row${slot.state === 'active' ? ' is-active' : ''}${slot.state === 'completed' ? ' is-done' : ''}`);
            row.appendChild(ui.h('span', 't', `${slot.time}–${slot.end}`));
            const body = ui.h('div');
            body.appendChild(ui.h('div', 'a', slot.activity));
            const meta = [stateText(slot.state), slot.mood, slot.location].filter(Boolean).join(' · ');
            if (meta) body.appendChild(ui.h('div', 'm', meta));
            row.appendChild(body);
            list.appendChild(row);
          }
          agenda.body.appendChild(list);
        } else {
          agenda.body.appendChild(ui.placeholder('今天还没有日程。'));
        }
        out.push(agenda.el);

        // —— 日记 / 最近醒来：折叠，不抢今天的版面 ——
        const diary = ui.foldSheet('overview-diary', { title: '日记', en: 'diary', desc: '一天一篇，由梦写。' });
        if (st.diary) {
          diary.body.appendChild(ui.h('pre', 'mono', st.diary.text.slice(0, 600)));
        } else {
          diary.body.appendChild(ui.placeholder('还没有日记。下一次入梦之后，她会写第一篇。'));
        }
        diary.body.appendChild(ui.h('div', 'text-secondary', dreamLine(st.dream)));
        out.push(diary.el);

        const wakes = ui.foldSheet('overview-wakes', { title: '最近醒来', en: 'wakes', desc: '为什么醒、花了多久、说了没有。' });
        const table = ui.table({ head: ['时间', '原因', '结果', '耗时', '上下文', '事件'] });
        if (!st.wakes.length) table.clear('还没有唤醒记录。');
        for (const wake of st.wakes) {
          table.addRow([
            { text: whenIso(wake.ts), cls: 'mono' },
            { text: wake.reason ?? '—', cls: 'txt' },
            outcomePill(ctx, wake.outcome),
            { text: wake.durationMs ? `${(wake.durationMs / 1000).toFixed(1)}s` : '—', cls: 'mono' },
            { text: wake.estTokens ? `${num(wake.estTokens)} tok` : '—', cls: 'mono' },
            { text: wake.types.join(' / ') || '—', cls: 'mono' },
          ]);
        }
        wakes.body.append(table.el, refreshButton(ctx, reload));
        out.push(wakes.el);
        return out;
      },
    });
  },
};

function clockText(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stateText(state: SlotView['state']): string {
  return state === 'active' ? '进行中' : state === 'completed' ? '已过去' : '还没到';
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

const peoplePanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<PersonRow[]>(ctx, {
      loading: '读取人物档案…',
      failed: '人物档案不可用',
      load: () => ctx.invoke<PersonRow[]>('list'),
      render: (rows, reload) => {
        const sheet = ui.sheet({
          title: '她认识的人',
          en: 'people',
          desc: '主键是 QQ 号；昵称会变，档案跟着号走。点一行看她记得这个人的哪些事。',
        });
        const table = ui.table({ head: ['名字', 'QQ', '记得', '看法', '最近说话', '一句话'] });
        if (!rows.length) table.clear('people/ 里还没有档案。');
        for (const row of rows.slice().sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))) {
          const tr = table.addRow([
            { text: row.name, cls: 'txt' },
            { text: row.qq, cls: 'mono' },
            { text: row.memories, cls: 'mono' },
            { text: row.views, cls: 'mono' },
            { text: row.lastSeenAt ? ago(row.lastSeenAt) : '—', cls: 'mono' },
            { text: row.summary || row.aliases.join('、') || '—', cls: 'txt' },
          ]);
          tr.style.cursor = 'pointer';
          tr.addEventListener('click', () => {
            void ctx.invoke<PersonDetail>('detail', [row.qq]).then(
              (detail) => openPerson(ctx, detail),
              (err: unknown) => ui.toast(`读不出 ${row.name}: ${errText(err)}`, 'bad'),
            );
          }, { signal: ctx.signal });
        }
        sheet.body.appendChild(table.el);
        sheet.body.appendChild(refreshButton(ctx, reload));
        return [sheet.el];
      },
    });
  },
};

function openPerson(ctx: WebUiPanelContext, detail: PersonDetail): void {
  const { ui } = ctx;
  const body = ui.h('div');
  const person = detail.person;
  body.appendChild(ui.kv([
    { k: 'QQ', v: person.qq },
    { k: '档案', v: ui.h('span', 'mono', person.file) },
    { k: '一句话', v: person.summary || '—' },
    { k: '曾用名/别名', v: person.aliases.length ? person.aliases.join('、') : '—' },
    { k: '记得的事', v: `进行中 ${detail.counts.active} · 休眠 ${detail.counts.dormant}` },
  ]));
  if (detail.relation) {
    const rel = detail.relation;
    const pct = (value: number): string => `${Math.round(value * 100)}%`;
    body.appendChild(ui.section('关系约束', '不是看法，是这一轮能怎么对他：信任低会收紧，刚越界不主动，欠着的话要兑现。'
      + '好感度是稀缺的——全场加起来有上限，所以最多只有两三个人能被真正在意。'));
    body.appendChild(ui.kv([
      { k: '好感度', v: pct(rel.affinity) },
      { k: '信任', v: pct(rel.trust) },
      { k: '熟悉', v: pct(rel.familiarity) },
      { k: '边界', v: rel.boundary > 0 ? pct(rel.boundary) : '没有未修复的越界' },
      { k: '依据', v: rel.basis || '—' },
    ]));
  }
  body.appendChild(ui.section('我的看法', `档案里的「## 我的看法」，随这个人一起进上下文。`));
  if (detail.views.length) {
    for (const view of detail.views) body.appendChild(ui.h('div', 'txt', `· ${view}`));
  } else {
    body.appendChild(ui.placeholder('还没写过看法。'));
  }
  body.appendChild(ui.section('最近的记忆', '按重要度与新鲜度排，包含已休眠的。'));
  if (detail.memories.length) {
    const table = ui.table({ head: ['时间', '类型', '记忆', '分'] });
    for (const memory of detail.memories) {
      table.addRow([
        { text: memory.eventTime.slice(0, 10), cls: 'mono' },
        { text: memory.kind, cls: 'mono' },
        { text: memory.text, cls: 'txt' },
        { text: memory.score.toFixed(2), cls: 'mono' },
      ]);
    }
    body.appendChild(table.el);
  } else {
    body.appendChild(ui.placeholder('索引里还没有关于这个人的条目。'));
  }
  ui.drawer(`${person.name}(${person.qq})`, body);
}

// ---------------------------------------------------------------------------
// 群聊
// ---------------------------------------------------------------------------

const groupsPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<GroupsState>(ctx, {
      loading: '读取群聊观测…',
      failed: '群聊观测不可用',
      load: () => ctx.invoke<GroupsState>('state'),
      render: (st, reload) => {
        const out: Node[] = [];
        const head = ui.sheet({
          title: '群聊观测',
          en: 'groups',
          desc: '群里没叫到她的消息不进唤醒批次；这里看的是她会不会接，以及最近到底在聊什么。',
        });
        const verdict = ui.pill(st.diagnose.ok ? '有机会' : '现在不会', st.diagnose.ok ? 'on' : 'off');
        const bar = ui.rowbar();
        bar.append(verdict, ui.h('span', 'txt', st.diagnose.reason));
        head.body.appendChild(bar);
        head.body.appendChild(ui.h(
          'div',
          'text-secondary',
          `接群话题：${st.caps.participateGroups ? '开' : '关'}`
          + ` · 今天 ${st.caps.topicToday}/${st.caps.topicDailyCap} 次 · 窗口 ${st.caps.topicWindowMinutes} 分钟`,
        ));

        const table = ui.table({ head: ['群', '监听', '对方上次', '她上次', '未完话头', '最近尝试'] });
        if (!st.groups.length) table.clear('监听名单里没有群。');
        for (const g of st.groups) {
          table.addRow([
            { text: g.id, cls: 'mono' },
            ui.pill(g.enabled ? '在听' : '停用', g.enabled ? 'on' : 'off'),
            { text: g.lastUserAt ? when(g.lastUserAt) : '—', cls: 'mono' },
            { text: g.lastBotAt ? when(g.lastBotAt) : '—', cls: 'mono' },
            { text: g.openLoop ? g.openLoop.slice(0, 40) : '—', cls: 'txt' },
            { text: g.lastAttemptAt ? ago(g.lastAttemptAt) : '—', cls: 'mono' },
          ]);
        }
        head.body.appendChild(table.el);

        const logSheet = ui.sheet({ title: '最近的消息', en: 'messages', desc: 'World 记得的最近几条，不进上下文，只给这里看。' });
        const picker = ui.select({
          options: st.groups.map((g) => ({ value: g.conv, label: `群 ${g.id}` })),
          value: st.groups[0]?.conv,
        });
        const log = ui.log({ variant: 'conversation', maxHeight: '360px', empty: '这个会话还没有消息。' });
        const loadMessages = (conv: string): void => {
          log.clear();
          void ctx.invoke<Array<{ at: number; from: string; text: string }>>('messages', [conv, 30]).then(
            (msgs) => {
              for (const msg of msgs) log.append(`[${when(msg.at).slice(6)}] ${msg.from}：${msg.text}`);
            },
            (err: unknown) => { log.append(`读取失败：${errText(err)}`, 'bad'); },
          );
        };
        picker.addEventListener('change', () => { loadMessages(picker.value); }, { signal: ctx.signal });
        if (st.groups[0]) loadMessages(st.groups[0].conv);
        const bar2 = ui.rowbar();
        bar2.append(picker);
        logSheet.body.append(bar2, log.el, refreshButton(ctx, reload));
        // —— 群聊形状：此刻几个人在说、谁占了大半、她怎么看 ——
        const roomSheet = ui.sheet({
          title: '此刻',
          en: 'room',
          desc: '近半小时能数出来的事实：几条消息、几个人在说、有没有人在接谁的话、静了多久。这里不做气氛判断——在玩梗还是在较真，是她自己读上下文读出来的。',
        });
        const roomBody = ui.h('div');
        roomSheet.body.appendChild(roomBody);
        const heatText: Record<string, string> = {
          silent: '基本没人',
          quiet: '冷清',
          normal: '正常',
          busy: '热闹',
          flood: '在刷屏',
        };
        const loadRoom = (): void => {
          roomBody.replaceChildren(ui.placeholder('读取形状…'));
          void ctx.invoke<RoomRow[]>('room').then(
            (rows) => {
              if (ctx.signal.aborted) return;
              const table = ui.table({ head: ['群', '此刻', '档次', '接话', '问她', '静默', '她的判断'] });
              if (!rows.length) table.clear('监听名单里没有群。');
              for (const row of rows) {
                table.addRow([
                  { text: `群 ${row.groupId}`, cls: 'mono' },
                  { text: row.line ?? '这个窗口里还没有消息', cls: 'txt' },
                  { text: heatText[row.heat] ?? row.heat, cls: 'mono' },
                  { text: `${Math.round(row.replyShare * 100)}%`, cls: 'mono' },
                  { text: String(row.toSelf), cls: 'mono' },
                  { text: row.lullMinutes === null ? '—' : `${row.lullMinutes} 分钟`, cls: 'mono' },
                  {
                    text: row.note ? `${row.note.label}${row.note.text ? `——${row.note.text}` : ''}` : '—',
                    cls: 'txt',
                  },
                ]);
              }
              roomBody.replaceChildren(table.el, refreshButton(ctx, loadRoom));
            },
            (err: unknown) => {
              if (!ctx.signal.aborted) roomBody.replaceChildren(ui.placeholder(`群聊形状不可用：${errText(err)}`));
            },
          );
        };
        loadRoom();
        // —— 注意力：没有叫到她的消息，为什么没注意 ——
        const attentionSheet = ui.sheet({
          title: '注意力',
          en: 'attention',
          desc: '没叫到你的群消息怎么判决：焦点照常醒来；缓冲的随下次唤醒搭车或进背景摘要；背景只归档、不唤醒。',
        });
        const attentionBody = ui.h('div');
        attentionSheet.body.appendChild(attentionBody);
        const loadAttention = (): void => {
          attentionBody.replaceChildren(ui.placeholder('读取判决…'));
          void ctx.invoke<{ config: AttentionConfigView; rows: AttentionRow[] }>('attention').then(
            (view) => {
              if (ctx.signal.aborted) return;
              const cfg = view.config;
              const table = ui.table({ head: ['时间', '会话', '谁', '档', '分', '为什么', '内容'] });
              if (!view.rows.length) table.clear('还没有判决记录。');
              for (const row of view.rows) {
                table.addRow([
                  { text: whenIso(row.ts), cls: 'mono' },
                  { text: row.convKey, cls: 'mono' },
                  { text: row.senderName, cls: 'txt' },
                  ui.pill(
                    row.tier === 'focus' ? '焦点' : row.tier === 'periphery' ? '缓冲' : '背景',
                    row.tier === 'focus' ? 'on' : row.tier === 'periphery' ? 'plain' : 'off',
                  ),
                  { text: row.score.toFixed(2), cls: 'mono' },
                  { text: row.reasons.join('；'), cls: 'txt' },
                  { text: row.preview, cls: 'txt' },
                ]);
              }
              attentionBody.replaceChildren(
                ui.h('div', 'text-secondary',
                  `显著性 ${cfg.enabled ? '开' : '关'} · 进缓冲线 ${cfg.peripheryThreshold.toFixed(2)}`
                  + ` · 负荷窗口 ${cfg.windowMinutes} 分钟 · 复读窗口 ${cfg.habituationMinutes} 分钟`),
                table.el,
                refreshButton(ctx, loadAttention),
              );
            },
            (err: unknown) => {
              if (!ctx.signal.aborted) attentionBody.replaceChildren(ui.placeholder(`注意力数据不可用：${errText(err)}`));
            },
          );
        };
        loadAttention();
        out.push(head.el, logSheet.el, roomSheet.el, attentionSheet.el);
        return out;
      },
    });
  },
};

// ---------------------------------------------------------------------------
// 观察
// ---------------------------------------------------------------------------

const observePanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const shell = ui.sheet({
      title: '生活观察',
      en: 'observe',
      desc: '日记、记忆、召回记录、对人的看法——她脑袋里现在装着什么。',
    });
    const seg = ui.segmented([
      { value: 'diary', label: '日记' },
      { value: 'memory', label: '记忆' },
      { value: 'recall', label: '召回' },
      { value: 'views', label: '看法' },
    ], { value: 'diary', onSelect: (value) => { views.get(value)?.(); } });
    const body = ui.h('div');
    shell.body.append(seg.el, body);

    const showDiary = (): void => {
      body.replaceChildren(ui.placeholder('读取日记…'));
      void ctx.invoke<Array<{ date: string; size: number }>>('diaries').then(
        (rows) => {
          if (ctx.signal.aborted) return;
          if (!rows.length) {
            body.replaceChildren(ui.placeholder('还没有日记。下一次入梦之后，她会写第一篇。'));
            return;
          }
          const text = ui.h('pre', 'mono', '');
          const picker = ui.rowbar();
          const load = (date: string): void => {
            void ctx.invoke<{ date: string; text: string }>('diary', [date]).then(
              (entry) => { text.textContent = entry.text.trim() || '（这一篇是空的）'; },
              (err: unknown) => { text.textContent = `读不出来：${errText(err)}`; },
            );
          };
          for (const row of rows.slice(0, 10)) {
            picker.appendChild(ui.button(`${row.date} · ${num(row.size)}B`, {
              size: 'sm',
              variant: 'plain',
              onClick: () => load(row.date),
            }));
          }
          body.replaceChildren(picker, text);
          load(rows[0]!.date);
        },
        (err: unknown) => { body.replaceChildren(ui.placeholder(`日记读取失败：${errText(err)}`)); },
      );
    };

    const showMemory = (query = ''): void => {
      body.replaceChildren(ui.placeholder('读取记忆…'));
      void ctx.invoke<{ items: MemoryItem[]; total: number }>('memories', [query, 40]).then(
        (res) => {
          if (ctx.signal.aborted) return;
          const search = ui.input({ type: 'search', placeholder: '按关键词找（走 FTS，旧昵称也能命中）', value: query });
          search.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') showMemory(search.value.trim());
          }, { signal: ctx.signal });
          const table = ui.table({ head: ['时间', '类型', '状态', '重要度', '记忆'] });
          if (!res.items.length) table.clear('没有匹配的条目。');
          for (const item of res.items) {
            table.addRow([
              { text: item.eventTime.slice(0, 10), cls: 'mono' },
              { text: item.kind, cls: 'mono' },
              { text: item.status, cls: 'mono' },
              { text: String(item.importance), cls: 'mono' },
              { text: item.text, cls: 'txt' },
            ]);
          }
          body.replaceChildren(
            ui.rowbar(),
            ui.h('div', 'text-secondary', `共 ${res.total} 条，按新旧列出最近 ${res.items.length} 条。`),
            search,
            table.el,
          );
        },
        (err: unknown) => { body.replaceChildren(ui.placeholder(`记忆读取失败：${errText(err)}`)); },
      );
    };

    const showRecall = (): void => {
      body.replaceChildren(ui.placeholder('读取召回记录…'));
      void ctx.invoke<RecallRecord[]>('recalls', [10]).then(
        (rows) => {
          if (ctx.signal.aborted) return;
          const table = ui.table({ head: ['时间', '谁在查', '查询', '最高命中'] });
          if (!rows.length) table.clear('还没有召回记录。');
          for (const row of rows) {
            const top = row.hits[0];
            table.addRow([
              { text: whenIso(row.ts), cls: 'mono' },
              { text: row.caller ?? '—', cls: 'mono' },
              { text: row.query ?? '—', cls: 'txt' },
              { text: top ? `${top.text.slice(0, 80)}（${top.score.toFixed(2)}）` : '—', cls: 'txt' },
            ]);
          }
          body.replaceChildren(table.el);
        },
        (err: unknown) => { body.replaceChildren(ui.placeholder(`召回读取失败：${errText(err)}`)); },
      );
    };

    const showViews = (): void => {
      body.replaceChildren(ui.placeholder('读取看法…'));
      void ctx.invoke<ViewRow[]>('views').then(
        (rows) => {
          if (ctx.signal.aborted) return;
          const table = ui.table({ head: ['人', '档案', '她的看法'] });
          if (!rows.length) table.clear('档案里还没有「## 我的看法」小节。');
          for (const row of rows) {
            table.addRow([
              { text: `${row.name}(${row.qq})`, cls: 'txt' },
              { text: row.file, cls: 'mono' },
              { text: row.views.join('；'), cls: 'txt' },
            ]);
          }
          body.replaceChildren(table.el);
        },
        (err: unknown) => { body.replaceChildren(ui.placeholder(`看法读取失败：${errText(err)}`)); },
      );
    };

    const views = new Map<string, () => void>([
      ['diary', showDiary],
      ['memory', () => showMemory()],
      ['recall', showRecall],
      ['views', showViews],
    ]);
    ctx.root.appendChild(shell.el);
    showDiary();
  },
};

// ---------------------------------------------------------------------------
// 世界知识
// ---------------------------------------------------------------------------

const worldPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<WorldState>(ctx, {
      loading: '读取世界知识…',
      failed: '世界知识不可用',
      load: () => ctx.invoke<WorldState>('state'),
      render: (st, reload) => {
        const out: Node[] = [];
        const worldview = ui.foldSheet('companion-world', {
          title: '世界观',
          en: 'WORLDVIEW.md',
          desc: '她当作真的那些设定。全文在工作区里；面板只给开头。',
          defaultOpen: true,
        });
        worldview.body.appendChild(st.worldview
          ? ui.h('pre', 'mono', st.worldview)
          : ui.placeholder('WORLDVIEW.md 还没有内容。'));
        out.push(worldview.el);

        const constitution = ui.foldSheet('companion-constitution', {
          title: '宪法',
          en: 'CONSTITUTION.md',
          desc: '长期原则。改完要重载系统前缀才对当前 session 生效。',
        });
        constitution.body.appendChild(st.constitution
          ? ui.h('pre', 'mono', st.constitution)
          : ui.placeholder('CONSTITUTION.md 还没有内容。'));
        out.push(constitution.el);

        const notes = ui.sheet({ title: '笔记目录', en: 'note/', desc: `${st.memoryDir} 下的 note/，按改动时间排。` });
        const table = ui.table({ head: ['路径', '大小', '改动'] });
        if (!st.files.length) table.clear('note/ 还是空的。');
        for (const file of st.files.slice(0, 60)) {
          table.addRow([
            { text: file.path, cls: 'mono' },
            { text: `${num(file.size)}B`, cls: 'mono' },
            { text: when(file.mtime), cls: 'mono' },
          ]);
        }
        notes.body.append(table.el, refreshButton(ctx, reload));
        out.push(notes.el);
        return out;
      },
    });
  },
};

// ---------------------------------------------------------------------------
// 主动
// ---------------------------------------------------------------------------

const proactivePanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<ProactiveState>(ctx, {
      loading: '读取主动判定…',
      failed: '陪伴层不可用',
      load: () => ctx.invoke<ProactiveState>('state'),
      render: (st, reload) => {
        const out: Node[] = [];
        const head = ui.sheet({
          title: '此刻的判定',
          en: 'proactive',
          desc: '先看能不能，再看说什么。诊断是只读的，不会消耗这次机会。',
        });
        const verdict = ui.pill(st.diagnose.ok ? '有机会' : '现在不会', st.diagnose.ok ? 'on' : 'off');
        const bar = ui.rowbar();
        bar.append(verdict, ui.h('span', 'txt', st.diagnose.reason));
        head.body.appendChild(bar);
        if (st.gate) head.body.appendChild(ui.h('div', 'text-secondary', `卡在：${st.gate}`));
        head.body.appendChild(ui.h(
          'div',
          'text-secondary',
          `节奏：每天最多 ${st.caps.dailyCap} 次 · 等回音 ${st.caps.followupMinutes} 分钟`
          + ` · 同会话间隔 ${st.caps.followupCooldownMinutes} 分钟`
          + ` · 不打扰 ${st.caps.quietStartHour}–${st.caps.quietEndHour} 点`
          + ` · 她睡觉 ${st.caps.sleepStartHour}–${st.caps.sleepEndHour} 点`,
        ));

        const candidates = ui.table({ head: ['来源', '会话', '由头'] });
        if (!st.candidates.length) candidates.clear('此刻没有够格的话头。');
        for (const c of st.candidates) {
          candidates.addRow([
            { text: c.kind === 'quiet' ? '空下来时的自问' : c.kind === 'topic' ? '群话题' : c.kind === 'creative' ? '自己的作品' : c.kind === 'thread' ? '上次留的话' : '时段问候', cls: 'mono' },
            { text: c.conv, cls: 'mono' },
            { text: c.summary.slice(0, 200), cls: 'txt' },
          ]);
        }
        head.body.appendChild(ui.h('div', 'text-secondary', `候选 ${st.candidates.length} 条`));
        head.body.appendChild(candidates.el);
        out.push(head.el);

        const convs = ui.sheet({ title: '会话状态', en: 'convs', desc: '她记得谁、谁还欠她一句话。' });
        const table = ui.table({ head: ['会话', '对方上次', '她上次', '未完话头', '状态', '最近尝试'] });
        if (!st.convs.length) table.clear('还没有任何会话记录。');
        for (const conv of st.convs) {
          table.addRow([
            { text: conv.conv, cls: 'mono' },
            { text: conv.lastUserAt ? when(conv.lastUserAt) : '—', cls: 'mono' },
            { text: conv.lastBotAt ? when(conv.lastBotAt) : '—', cls: 'mono' },
            { text: conv.openLoop ? conv.openLoop.slice(0, 40) : '—', cls: 'txt' },
            { text: conv.openLoop ? (conv.followed ? '已尝试过' : '待接') : '—', cls: 'mono' },
            { text: conv.lastAttemptAt ? ago(conv.lastAttemptAt) : '—', cls: 'mono' },
          ]);
        }
        convs.body.appendChild(table.el);
        out.push(convs.el);

        const records = ui.sheet({ title: '主动记录', en: 'records', desc: '她因为主动机会醒来的那几次。' });
        const recTable = ui.table({ head: ['时间', '原因', '结果', '耗时', '说了'] });
        if (!st.records.length) recTable.clear('还没有主动记录。');
        for (const rec of st.records) {
          recTable.addRow([
            { text: whenIso(rec.ts), cls: 'mono' },
            { text: rec.reason ?? '—', cls: 'mono' },
            outcomePill(ctx, rec.outcome),
            { text: rec.durationMs ? `${(rec.durationMs / 1000).toFixed(1)}s` : '—', cls: 'mono' },
            { text: rec.sent ? rec.sent.slice(0, 80) : '—', cls: 'txt' },
          ]);
        }
        records.body.append(recTable.el, refreshButton(ctx, reload));
        out.push(records.el);
        return out;
      },
    });
  },
};

// ---------------------------------------------------------------------------
// 作品
// ---------------------------------------------------------------------------

const worksPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<CreativeStateView>(ctx, {
      loading: '读取书柜…',
      failed: '创作层不可用',
      load: () => ctx.invoke<CreativeStateView>('state'),
      render: (st, reload) => {
        const out: Node[] = [];
        const head = ui.sheet({
          title: '她自己写的东西',
          en: 'works',
          desc: '没人叫她的时候写的。正文就在工作区里，她明天读到的就是这一份。',
        });
        const bar = ui.rowbar();
        bar.append(
          ui.pill(st.enabled ? '在写' : '关着', st.enabled ? 'on' : 'off'),
          ui.h('span', 'txt', st.gate ?? '这会儿可以动笔'),
        );
        head.body.appendChild(bar);
        head.body.appendChild(ui.h(
          'div',
          'text-secondary',
          `今天 ${st.chunksToday}/${st.settings.maxChunksPerDay} 段 · 分享 ${st.sharesToday}/${st.settings.shareDailyCap}`
          + ` · 每次约 ${st.settings.chunkChars} 字 · 间隔 ${st.settings.advanceMinutes[0]}–${st.settings.advanceMinutes[1]} 分钟`
          + ` · 同时最多 ${st.settings.maxActiveWorks} 部`,
        ));
        if (st.settings.direction) head.body.appendChild(ui.h('div', 'text-secondary', `创作方向：${st.settings.direction}`));
        if (st.lastRun) {
          head.body.appendChild(ui.h(
            'div',
            'text-secondary',
            `上一次：${when(st.lastRun.at)} ${st.lastRun.ok ? '写成' : '没写成'} · ${st.lastRun.reason}`
            + (st.lastRun.ms ? ` · ${(st.lastRun.ms / 1000).toFixed(1)}s` : ''),
          ));
        }

        const table = ui.table({ head: ['作品', '类型', '进度', '成熟', '段', '状态', '下次'] });
        if (!st.works.length) table.clear('书柜还是空的。');
        for (const work of st.works.slice().reverse()) {
          const tr = table.addRow([
            { text: work.title, cls: 'txt' },
            { text: work.workType, cls: 'mono' },
            { text: `${work.currentChars}/${work.targetChars}`, cls: 'mono' },
            { text: String(work.maturity), cls: 'mono' },
            { text: String(work.chunkCount), cls: 'mono' },
            { text: work.status === 'finished' ? '写完了' : work.pendingShare ? `在写 · 待分享(${work.pendingShare})` : '在写', cls: 'mono' },
            { text: work.nextAdvanceAt ? when(work.nextAdvanceAt) : '—', cls: 'mono' },
          ]);
          tr.style.cursor = 'pointer';
          tr.addEventListener('click', () => {
            void ctx.invoke<{ work: CreativeWorkRow; text: string }>('text', [work.id]).then(
              (found) => openWork(ctx, found),
              (err: unknown) => ui.toast(`读不出《${work.title}》: ${errText(err)}`, 'bad'),
            );
          }, { signal: ctx.signal });
        }
        head.body.appendChild(table.el);
        head.body.appendChild(refreshButton(ctx, reload));
        out.push(head.el);
        return out;
      },
    });
  },
};

function openWork(ctx: WebUiPanelContext, found: { work: CreativeWorkRow; text: string }): void {
  const { ui } = ctx;
  const { work } = found;
  const body = ui.h('div');
  body.appendChild(ui.kv([
    { k: '类型', v: work.workType },
    { k: '一句话', v: work.premise || '—' },
    { k: '规模', v: work.scale ? `${work.scale}篇 · 目标 ${work.targetChars} 字` : `目标 ${work.targetChars} 字` },
    { k: '气质', v: work.tone || '—' },
    { k: '正文', v: ui.h('span', 'mono', work.file) },
    { k: '写到这里', v: `${work.currentChars}/${work.targetChars} 字 · ${work.chunkCount} 段 · 成熟度 ${work.maturity}` },
    { k: '起于', v: `${work.sourceLabel}：${work.sourceText || '—'}` },
  ]));
  body.appendChild(ui.section('本子', '续写靠它不跑偏；每次写完由她自己更新。'));
  body.appendChild(ui.kv([
    { k: '主线', v: work.bible.mainline || '—' },
    { k: '主题', v: work.bible.themes.join('、') || '—' },
    { k: '未收的线索', v: work.bible.openThreads.join('；') || '—' },
    { k: '已固定的事实', v: work.bible.facts.join('；') || '—' },
    { k: '下一段', v: work.bible.nextDirection || '—' },
  ]));
  if (work.lastError) body.appendChild(ui.h('div', 'text-secondary', `上一次没写成：${work.lastError}`));
  if (work.disclosed.length) body.appendChild(ui.h('div', 'text-secondary', `已提起过的节点：${work.disclosed.join('、')}`));
  if (work.volumes && work.volumes.length) {
    body.appendChild(ui.section('卷章', '长篇每写完一章留一句摘要；收卷后整卷压成一段。写到后面靠的就是这些句子。'));
    for (const volume of work.volumes) {
      const state = volume.summary ? volume.summary : '（这一卷还没收）';
      body.appendChild(ui.h('div', 'text-secondary', `Vol.${volume.index}《${volume.title}》 —— ${state}`));
      for (const chapter of volume.chapters) {
        body.appendChild(ui.h('div', 'txt', `第 ${chapter.index} 章 · ${chapter.chars} 字　${chapter.summary}`));
      }
    }
  }
  body.appendChild(ui.section('正文', '工作区里的原文。'));
  if (found.text.trim()) {
    for (const paragraph of found.text.split(/\n{2,}/).filter((item) => item.trim())) {
      body.appendChild(ui.h('div', 'txt', paragraph.trim()));
    }
  } else {
    body.appendChild(ui.placeholder('还没有正文。'));
  }
  ui.drawer(`《${work.title}》`, body);
}

// ---------------------------------------------------------------------------
// 学习
// ---------------------------------------------------------------------------

const learningPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<{ cards: CardRow[]; core: number; library: number }>(ctx, {
      loading: '读取语气卡…',
      failed: '语气库不可用',
      load: () => ctx.invoke('cards'),
      render: (st, reload) => {
        const head = ui.sheet({
          title: '表达学习',
          en: 'style',
          desc: '她学来的说法：常驻卡每次都进上下文，资料库按需读取。',
        });
        head.body.appendChild(ui.statgrid([
          { k: '常驻', v: st.core, unit: '张', accent: true },
          { k: '资料库', v: st.library, unit: '张' },
          { k: '最近改动', v: st.cards[0] ? when(st.cards[0].mtime) : '—' },
        ]));
        const table = ui.table({ head: ['层', '名字', '群友那句', '她的回答', '改动'] });
        if (!st.cards.length) table.clear('还没有语气卡。');
        for (const card of st.cards) {
          table.addRow([
            ui.pill(card.tier === 'core' ? '常驻' : '资料库', card.tier === 'core' ? 'on' : 'plain'),
            { text: card.name, cls: 'mono' },
            { text: card.question, cls: 'txt' },
            { text: card.answer, cls: 'txt' },
            { text: when(card.mtime), cls: 'mono' },
          ]);
        }
        head.body.append(table.el, refreshButton(ctx, reload));
        return [head.el];
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

const tokensPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<TokensState>(ctx, {
      loading: '汇总用量…',
      failed: '用量记录不可用',
      load: () => ctx.invoke<TokensState>('state'),
      render: (st, reload) => {
        const out: Node[] = [];
        const head = ui.sheet({ title: '今天', en: 'usage', desc: '按本地日期切；数据来自 data/usage.jsonl。' });
        head.body.appendChild(ui.statgrid([
          { k: '调用', v: st.today.calls, unit: '次', accent: true },
          { k: '输入', v: num(st.today.input), unit: 'tok' },
          { k: '输出', v: num(st.today.output), unit: 'tok' },
          { k: '命中缓存', v: num(st.today.cached), unit: 'tok' },
        ]));
        out.push(head.el);

        const days = ui.sheet({ title: '最近七天', en: 'daily' });
        const dtable = ui.table({ head: ['日期', '调用', '输入', '输出'] });
        if (!st.days.length) dtable.clear('还没有用量记录。');
        for (const day of st.days) {
          dtable.addRow([
            { text: day.date, cls: 'mono' },
            { text: day.calls, cls: 'mono' },
            { text: num(day.input), cls: 'mono' },
            { text: num(day.output), cls: 'mono' },
          ]);
        }
        days.body.appendChild(dtable.el);
        out.push(days.el);

        const split = ui.sheet({ title: '按供应商与用途', en: 'split' });
        const ptable = ui.table({ head: ['供应商', '调用', '总 token'] });
        if (!st.providers.length) ptable.clear('—');
        for (const p of st.providers) {
          ptable.addRow([{ text: p.name, cls: 'mono' }, { text: p.calls, cls: 'mono' }, { text: num(p.total), cls: 'mono' }]);
        }
        const ttable = ui.table({ head: ['用途', '调用', '总 token'] });
        if (!st.purposes.length) ttable.clear('—');
        for (const p of st.purposes) {
          ttable.addRow([{ text: p.name, cls: 'mono' }, { text: p.calls, cls: 'mono' }, { text: num(p.total), cls: 'mono' }]);
        }
        split.body.append(ptable.el, ui.h('div', 'text-secondary', '按用途'), ttable.el);
        out.push(split.el);

        const recent = ui.sheet({ title: '最近调用', en: 'recent' });
        const rtable = ui.table({ head: ['时间', '供应商', '模型', '用途', '输入/输出', '耗时', '结果'] });
        if (!st.recent.length) rtable.clear('还没有调用记录。');
        for (const r of st.recent) {
          rtable.addRow([
            { text: whenIso(r.ts), cls: 'mono' },
            { text: r.instance, cls: 'mono' },
            { text: r.model, cls: 'mono' },
            { text: r.purpose, cls: 'mono' },
            { text: `${num(r.input)} / ${num(r.output)}`, cls: 'mono' },
            { text: r.elapsedMs ? `${(r.elapsedMs / 1000).toFixed(1)}s` : '—', cls: 'mono' },
            { text: r.outcome, cls: 'mono' },
          ]);
        }
        recent.body.append(rtable.el, refreshButton(ctx, reload));
        out.push(recent.el);
        return out;
      },
    });
  },
};

// ---------------------------------------------------------------------------
// 排障
// ---------------------------------------------------------------------------

const troubleshootPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<TroubleshootState>(ctx, {
      loading: '读取运行诊断…',
      failed: '运行诊断不可用',
      load: () => ctx.invoke<TroubleshootState>('state'),
      render: (st, reload) => {
        const out: Node[] = [];
        const head = ui.sheet({ title: '链路与规模', en: 'run', desc: '状态卡最近一次更新时间、记忆规模、前缀大小。' });
        head.body.appendChild(ui.statgrid([
          { k: '主动层', v: st.run.enabled ? '开' : '关', accent: st.run.enabled },
          { k: '精力', v: st.run.energy ?? '—', unit: '/100' },
          { k: '记忆条数', v: st.run.memoryTotal ?? '—' },
          { k: '已补向量', v: st.run.vectors ?? '—' },
          { k: '前缀字数', v: st.run.prefixChars ?? '—' },
        ]));
        head.body.appendChild(ui.h(
          'div',
          'text-secondary',
          `状态更新：${st.run.updatedAt ? when(st.run.updatedAt) : '—'} · ${dreamLine(st.dream)}`,
        ));
        const outcomes = ui.rowbar();
        for (const o of st.outcomes) outcomes.appendChild(ui.pill(`${o.outcome} ${o.n}`, o.outcome === 'sent' ? 'on' : 'plain'));
        if (st.outcomes.length) head.body.appendChild(outcomes);
        out.push(head.el);

        const wakes = ui.sheet({ title: '最近唤醒', en: 'wakes' });
        const table = ui.table({ head: ['时间', '原因', '结果', '耗时', '上下文', '事件'] });
        if (!st.wakes.length) table.clear('还没有唤醒记录。');
        for (const wake of st.wakes) {
          table.addRow([
            { text: whenIso(wake.ts), cls: 'mono' },
            { text: wake.reason ?? '—', cls: 'txt' },
            outcomePill(ctx, wake.outcome),
            { text: wake.durationMs ? `${(wake.durationMs / 1000).toFixed(1)}s` : '—', cls: 'mono' },
            { text: wake.estTokens ? `${num(wake.estTokens)} tok` : '—', cls: 'mono' },
            { text: wake.types.join(' / ') || '—', cls: 'mono' },
          ]);
        }
        wakes.body.appendChild(table.el);
        out.push(wakes.el);

        const errors = ui.sheet({ title: '最近的错误', en: 'errors', desc: 'console.err.log 末尾几行；空就是没报错。' });
        if (st.errors.length) {
          errors.body.appendChild(ui.h('pre', 'mono', st.errors.join('\n')));
        } else {
          errors.body.appendChild(ui.placeholder('错误日志是空的。'));
        }
        errors.body.appendChild(refreshButton(ctx, reload));
        out.push(errors.el);
        return out;
      },
    });
  },
};

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const configPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    autoload<ConfigState>(ctx, {
      loading: '读取陪伴层配置…',
      failed: '配置不可用',
      load: () => ctx.invoke<ConfigState>('state'),
      render: (st) => {
        const out: Node[] = [];
        const settings = st.settings;
        const sheet = ui.sheet({
          title: '陪伴层',
          en: 'companion',
          desc: '改了就写回部署配置，热生效；不需要重启。',
        });

        const toggles = ui.rowbar();
        const boxes = {
          enabled: ui.checkbox('允许她主动开口', { checked: settings.enabled }),
          allowPrivate: ui.checkbox('私聊里可以主动', { checked: settings.allowPrivate }),
          allowGroups: ui.checkbox('群里可以主动', { checked: settings.allowGroups }),
          participateGroups: ui.checkbox('接群里正在聊的话题', { checked: settings.participateGroups }),
        };
        for (const box of Object.values(boxes)) toggles.appendChild(box.el);
        sheet.body.appendChild(toggles);

        const number = (label: string, value: number): HTMLInputElement => ui.input({
          type: 'number',
          value: String(value),
          placeholder: label,
        });
        const dailyCap = number('每天最多主动几次', settings.dailyCap);
        const topicDailyCap = number('每天最多接几次话题', settings.topicDailyCap);
        const topicWindowMinutes = number('多久之内算正在聊（分钟）', settings.topicWindowMinutes);
        const followupMinutes = number('多久之后可以接一句（分钟）', settings.followupMinutes);
        const followupCooldownMinutes = number('同一会话间隔（分钟）', settings.followupCooldownMinutes);
        const dreamEveryHours = number('多久不整理就入梦（小时）', settings.dreamEveryHours);
        const quietStartHour = number('不打扰开始（时）', settings.quietStartHour);
        const quietEndHour = number('不打扰结束（时）', settings.quietEndHour);
        const sleepStartHour = number('她睡觉开始（时）', settings.sleepStartHour);
        const sleepEndHour = number('她睡觉结束（时）', settings.sleepEndHour);

        sheet.body.appendChild(ui.kv([
          { k: '每天主动上限', v: dailyCap },
          { k: '每天接话题上限', v: topicDailyCap },
          { k: '话题窗口（分钟）', v: topicWindowMinutes },
          { k: '等回音（分钟）', v: followupMinutes },
          { k: '同会话间隔（分钟）', v: followupCooldownMinutes },
          { k: '低水位入梦（小时）', v: dreamEveryHours },
          { k: '不打扰开始（时）', v: quietStartHour },
          { k: '不打扰结束（时）', v: quietEndHour },
          { k: '睡觉开始（时）', v: sleepStartHour },
          { k: '睡觉结束（时）', v: sleepEndHour },
        ]));

        const msg = ui.msgline('');
        const save = ui.button('保存配置', { variant: 'primary', onClick: () => { void submit(); } });
        const bar = ui.actions();
        bar.append(msg, ui.h('span', 'grow'), save);
        sheet.body.appendChild(bar);

        const submit = async (): Promise<void> => {
          save.disabled = true;
          try {
            const values: Record<string, number | boolean> = {
              'companion.enabled': boxes.enabled.checked,
              'companion.allowPrivate': boxes.allowPrivate.checked,
              'companion.allowGroups': boxes.allowGroups.checked,
              'companion.participateGroups': boxes.participateGroups.checked,
            };
            // 空着的数字格不提交：清空一格不该把它变成 0，更不该因此整次保存失败。
            const numeric: Array<[string, HTMLInputElement]> = [
              ['companion.dailyCap', dailyCap],
              ['companion.topicDailyCap', topicDailyCap],
              ['companion.topicWindowMinutes', topicWindowMinutes],
              ['companion.followupMinutes', followupMinutes],
              ['companion.followupCooldownMinutes', followupCooldownMinutes],
              ['companion.dreamEveryHours', dreamEveryHours],
              ['companion.quietStartHour', quietStartHour],
              ['companion.quietEndHour', quietEndHour],
              ['companion.sleepStartHour', sleepStartHour],
              ['companion.sleepEndHour', sleepEndHour],
            ];
            for (const [key, input] of numeric) {
              if (input.value.trim() !== '') values[key] = Number(input.value);
            }
            const receipt = await ctx.setConfig(st.group, values);
            setMsg(msg, receipt);
            ui.toast(receipt, 'ok');
          } catch (err) {
            setMsg(msg, `保存失败：${errText(err)}`, true);
          } finally {
            save.disabled = false;
          }
        };
        out.push(sheet.el);

        // —— 生活：天气城市、周期、排程段数 ——
        const life = ui.sheet({
          title: '生活',
          en: 'life',
          desc: '天气走 Open-Meteo（免 key），城市名会先地理编码；周期没校准日期就只是瞎猜。',
        });
        const city = ui.input({ placeholder: '城市名，例如 上海', value: st.life.city });
        const homeName = ui.input({ placeholder: '家里', value: st.life.homeName });
        const planCount = ui.input({ type: 'number', value: String(st.life.planItemCount) });
        const refreshMin = ui.input({ type: 'number', value: String(st.life.weatherRefreshMinutes) });
        const anchor = ui.input({ placeholder: 'YYYY-MM-DD', value: st.life.cycleAnchor });
        const weatherOn = ui.checkbox('查天气', { checked: st.life.weatherEnabled });
        const cycleOn = ui.checkbox('模拟生理周期（28 天六阶段）', { checked: st.life.cycleEnabled });
        life.body.appendChild(ui.kv([
          { k: '城市', v: city },
          { k: '天气', v: weatherOn.el },
          { k: '刷新间隔（分钟）', v: refreshMin },
          { k: '「家」怎么写', v: homeName },
          { k: '一天几段日程', v: planCount },
          { k: '周期', v: cycleOn.el },
          { k: '周期起始日', v: anchor },
        ]));
        const lifeMsg = ui.msgline('');
        const saveLifeCfg = ui.button('保存生活配置', { variant: 'primary', onClick: () => { void submitLifeConfig(); } });
        const lifeBar = ui.actions();
        lifeBar.append(lifeMsg, ui.h('span', 'grow'), saveLifeCfg);
        life.body.appendChild(lifeBar);

        const submitLifeConfig = async (): Promise<void> => {
          saveLifeCfg.disabled = true;
          try {
            const values: Record<string, string | number | boolean> = {
              'companion.life.city': city.value.trim(),
              'companion.life.weatherEnabled': weatherOn.checked,
              'companion.life.homeName': homeName.value.trim() || '家里',
              'companion.life.cycleEnabled': cycleOn.checked,
              'companion.life.cycleAnchor': anchor.value.trim(),
            };
            if (refreshMin.value.trim()) values['companion.life.weatherRefreshMinutes'] = Number(refreshMin.value);
            if (planCount.value.trim()) values['companion.life.planItemCount'] = Number(planCount.value);
            const receipt = await ctx.setConfig(st.group, values);
            setMsg(lifeMsg, receipt);
            ui.toast(receipt, 'ok');
          } catch (err) {
            setMsg(lifeMsg, `保存失败：${errText(err)}`, true);
          } finally {
            saveLifeCfg.disabled = false;
          }
        };
        out.push(life.el);

        // —— 生活事实：饿不饿、梦、穿搭 ——
        const facts = ui.sheet({
          title: '生活事实',
          en: 'life.facts',
          desc: '梦也会写这三项；这里只用于手动更正。穿搭没有生图后端时只留空，今日卡显示「暂无穿搭图」。',
        });
        const hunger = ui.input({ placeholder: '有点饿 / 无饥饿感', value: '' });
        const dreamText = ui.input({ placeholder: '昨晚的梦 / 没有记住梦', value: '' });
        const outfit = ui.input({ placeholder: '白衬衫，外套搭在椅背上', value: '' });
        facts.body.appendChild(ui.kv([
          { k: '饥饿', v: hunger },
          { k: '梦境', v: dreamText },
          { k: '穿搭', v: outfit },
        ]));
        const factsMsg = ui.msgline('');
        const saveFacts = ui.button('保存生活事实', { variant: 'plain', onClick: () => { void submitFacts(); } });
        const factsBar = ui.actions();
        factsBar.append(factsMsg, ui.h('span', 'grow'), saveFacts);
        facts.body.appendChild(factsBar);

        const submitFacts = async (): Promise<void> => {
          saveFacts.disabled = true;
          try {
            const patch: Record<string, unknown> = {};
            if (hunger.value.trim()) patch.hunger = hunger.value.trim();
            if (dreamText.value.trim()) patch.dream = dreamText.value.trim();
            if (outfit.value.trim()) patch.outfit = outfit.value.trim();
            if (!Object.keys(patch).length) {
              setMsg(factsMsg, '没有填任何一项', true);
              return;
            }
            const res = await ctx.invoke<{ ok: boolean; result: string }>('saveLife', [patch]);
            setMsg(factsMsg, res.result, !res.ok);
            ui.toast(res.result, res.ok ? 'ok' : 'bad');
          } catch (err) {
            setMsg(factsMsg, `保存失败：${errText(err)}`, true);
          } finally {
            saveFacts.disabled = false;
          }
        };
        out.push(facts.el);

        // —— 内感受：门限 ——
        const interoSheet = ui.sheet({
          title: '内感受',
          en: 'intero',
          desc: '电量与负荷从消息流算出来；低电量或高负荷时她不主动开口。改的是门限，不是数值。',
        });
        const interoOn = ui.checkbox('启用内感受的门', { checked: st.intero.enabled });
        const lowBattery = ui.input({ type: 'number', value: String(st.intero.lowBattery) });
        const highLoad = ui.input({ type: 'number', value: String(st.intero.highLoad) });
        const replyBattery = ui.input({ type: 'number', value: String(st.intero.replyBattery) });
        const hesitation = ui.input({ type: 'number', value: String(st.intero.hesitationSeconds) });
        interoSheet.body.appendChild(ui.kv([
          { k: '启用', v: interoOn.el },
          { k: '电量低到（0–1）', v: lowBattery },
          { k: '负荷高到（0–1）', v: highLoad },
          { k: '电量低到就短回（0–1）', v: replyBattery },
          { k: '最慢半拍（秒）', v: hesitation },
        ]));
        const interoMsg = ui.msgline('');
        const saveIntero = ui.button('保存内感受设置', { variant: 'primary', onClick: () => { void submitIntero(); } });
        const interoBar = ui.actions();
        interoBar.append(interoMsg, ui.h('span', 'grow'), saveIntero);
        interoSheet.body.appendChild(interoBar);

        const submitIntero = async (): Promise<void> => {
          saveIntero.disabled = true;
          try {
            const values: Record<string, number | boolean> = {
              'companion.intero.enabled': interoOn.checked,
            };
            if (lowBattery.value.trim()) values['companion.intero.lowBattery'] = Number(lowBattery.value);
            if (highLoad.value.trim()) values['companion.intero.highLoad'] = Number(highLoad.value);
            if (replyBattery.value.trim()) values['companion.intero.replyBattery'] = Number(replyBattery.value);
            if (hesitation.value.trim()) values['companion.intero.hesitationSeconds'] = Number(hesitation.value);
            const receipt = await ctx.setConfig(st.group, values);
            setMsg(interoMsg, receipt);
            ui.toast(receipt, 'ok');
          } catch (err) {
            setMsg(interoMsg, `保存失败：${errText(err)}`, true);
          } finally {
            saveIntero.disabled = false;
          }
        };
        out.push(interoSheet.el);

        const role = ui.sheet({
          title: '手动改状态',
          en: 'role.state',
          desc: '只用于排障与演练。正常由梦在整理时更新；改完下一次请求就生效。',
        });
        const energy = ui.input({ type: 'number', placeholder: '精力 0–100', value: st.role ? String(Math.round(st.role.energy)) : '' });
        const presence = ui.input({ placeholder: '公开状态（≤8 字）', value: st.role?.presence ?? '' });
        const busy = ui.input({ placeholder: '在做的事 / 注意力在哪', value: st.role?.busy ?? '' });
        const desc = ui.input({ placeholder: '一句心境', value: st.role?.mood.description ?? '' });
        const inputs = ui.rowbar();
        inputs.append(energy, presence, busy, desc);
        const stateMsg = ui.msgline('');
        const saveState = ui.button('保存状态', {
          variant: 'plain',
          onClick: () => { void submitState(); },
        });
        const stateBar = ui.actions();
        stateBar.append(stateMsg, ui.h('span', 'grow'), saveState);
        role.body.append(inputs, stateBar);
        out.push(role.el);

        const submitState = async (): Promise<void> => {
          saveState.disabled = true;
          try {
            const patch: Record<string, unknown> = { basis: '面板手动调整' };
            if (energy.value.trim()) patch.energy = Number(energy.value);
            patch.presence = presence.value.trim() || null;
            patch.busy = busy.value.trim() || null;
            if (desc.value.trim()) patch.mood = { description: desc.value.trim() };
            const res = await ctx.invoke<{ ok: boolean; result: string }>('saveState', [patch]);
            setMsg(stateMsg, res.result, !res.ok);
            ui.toast(res.result, res.ok ? 'ok' : 'bad');
          } catch (err) {
            setMsg(stateMsg, `保存失败：${errText(err)}`, true);
          } finally {
            saveState.disabled = false;
          }
        };

        return out;
      },
    });
  },
};

// ---------------------------------------------------------------------------

export const companionPanels: Record<string, WebUiPanel> = {
  overview: overviewPanel,
  people: peoplePanel,
  groups: groupsPanel,
  observe: observePanel,
  world: worldPanel,
  proactive: proactivePanel,
  works: worksPanel,
  learning: learningPanel,
  tokens: tokensPanel,
  troubleshoot: troubleshootPanel,
  config: configPanel,
};
