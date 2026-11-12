/**
 * 陪伴页的数据面：总览、用户、群聊、观察、世界知识、主动、学习、Token、排障、配置。
 *
 * 重点不在"每格都能画"，而在：诊断只读、路径不越界、没数据如实空着、
 * 配置写回走同一份补丁语义。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPANION_PANELS, companionInvoke, shortMood, type CompanionPanelDeps,
} from '../../bots/amber/persona/companionPanel.ts';
import { Companion } from '../../bots/amber/persona/companion/index.ts';
import { RoleStateStore, type RoleState } from '../../bots/amber/persona/companion/roleState.ts';
import { LifeStateStore, type LifeSettings } from '../../bots/amber/persona/companion/lifeState.ts';
import { PersonRegistry } from '../../bots/amber/persona/people.ts';
import type { CompanionSettings } from '../../bots/amber/persona/companion/state.ts';
import type { MemoryIndex } from '../../bots/amber/persona/memoryIndex.ts';
import { makeTmpDir } from '../core/helpers.ts';

const TZ = 'Asia/Shanghai';
const T = Date.parse('2026-10-25T06:00:00Z');

const settings = (patch: Partial<CompanionSettings> = {}): CompanionSettings => ({
  enabled: true,
  allowPrivate: true,
  allowGroups: true,
  participateGroups: true,
  topicWindowMinutes: 30,
  topicDailyCap: 1,
  dreamEveryHours: 6,
  dailyCap: 2,
  followupMinutes: 45,
  followupCooldownMinutes: 240,
  quietStartHour: 23,
  quietEndHour: 8,
  sleepStartHour: 2,
  sleepEndHour: 9,
  ...patch,
});

/** 只实现面板用到的那几个方法；真实索引的 SQL 由 memory-index.test.ts 管。 */
function fakeIndex(overrides: Partial<Record<keyof MemoryIndex, unknown>> = {}): MemoryIndex {
  return {
    count: () => 7,
    countForPerson: () => 3,
    recallForPeople: () => [{
      id: 'a', text: '他要的不是顺从', kind: 'relational', eventTime: '2026-10-20T10:00:00Z',
      importance: 0.6, score: 0.8, status: 'active', source: null, topics: [], people: ['90010001'],
      effective: 0.6, breakdown: { bm25: 0, importance: 0.6, recency: 0.7, coverage: 0, matched: 0, rare: 0, vector: 0 },
    }],
    list: () => [{
      id: 'm1', text: '今天很安静', kind: 'episodic', eventTime: '2026-10-25T02:00:00Z',
      importance: 0.5, status: 'active', source: null, topics: [], people: [],
    }],
    countFiltered: () => 12,
    vectorCount: () => 5,
    ...overrides,
  } as unknown as MemoryIndex;
}

describe('陪伴页数据面', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let deps: CompanionPanelDeps;
  let store: RoleStateStore;

  beforeEach(() => {
    tmp = makeTmpDir();
    mkdirSync(join(tmp.dir, 'memo', 'diary'), { recursive: true });
    mkdirSync(join(tmp.dir, 'people'), { recursive: true });
    mkdirSync(join(tmp.dir, 'note', 'style'), { recursive: true });
    writeFileSync(join(tmp.dir, 'WORLDVIEW.md'), '# 世界观\n\n群是一个茶馆。\n', 'utf8');
    writeFileSync(join(tmp.dir, 'CONSTITUTION.md'), '# 宪法\n\n认号不认名。\n', 'utf8');
    writeFileSync(join(tmp.dir, 'people', 'qq-90010001.md'), '橘子精(90010001) — 群主。\n\n## 我的看法\n- 2026-10-20 他要的不是顺从\n', 'utf8');
    writeFileSync(join(tmp.dir, 'people', 'qq-90010002.md'), '清鱼(90010002) — 群友。\n', 'utf8');
    writeFileSync(join(tmp.dir, 'note', 'style', '05-short-user.md'), '嗯\n', 'utf8');
    writeFileSync(join(tmp.dir, 'note', 'style', '05-short-reply.md'), '就这么一句。\n', 'utf8');
    writeFileSync(join(tmp.dir, 'memo', 'diary', '2026-10-24.md'), '# 二十四\n\n昨天很吵。\n', 'utf8');
    writeFileSync(join(tmp.dir, 'memo', 'diary', '2026-10-25.md'), '# 二十五\n\n今天安静。\n', 'utf8');
    writeFileSync(join(tmp.dir, 'usage.jsonl'), [
      JSON.stringify({
        ts: '2026-10-25T05:00:00Z',
        attempt: {
          startedAt: '2026-10-25T05:00:00Z', elapsedMs: 1200, purpose: 'generation', outcome: 'completed',
          origin: { instance: 'DeepSeek', model: 'deepseek-flash' },
          meters: { input: 100, output: 20, cachedInput: 40, total: 120 },
        },
      }),
      JSON.stringify({
        ts: '2026-10-24T05:00:00Z',
        attempt: {
          startedAt: '2026-10-24T05:00:00Z', purpose: 'dream', outcome: 'completed',
          origin: { instance: 'DeepSeek', model: 'deepseek-flash' },
          meters: { input: 200, output: 50, total: 250 },
        },
      }),
    ].join('\n'), 'utf8');
    writeFileSync(join(tmp.dir, 'wakes.jsonl'), [
      JSON.stringify({
        id: 'w1', ts: '2026-10-25T05:30:00Z', reason: 'thread', outcome: 'sent', durationMs: 3000,
        context: { estTokens: 1200, prefixChars: 900 },
        actions: { sent: '我在。' },
        events: [{ type: 'qq.message' }],
      }),
      JSON.stringify({
        id: 'w2', ts: '2026-10-25T05:40:00Z', reason: 'internal', outcome: 'silent', durationMs: 4000,
        context: { estTokens: 900, prefixChars: 900 },
        actions: {},
        events: [{ type: 'companion.opportunity' }],
      }),
    ].join('\n'), 'utf8');
    writeFileSync(join(tmp.dir, 'recalls.jsonl'), `${JSON.stringify({
      ts: '2026-10-25T05:00:00Z', query: '改名', caller: 'wake', hits: [{ text: '他改了名', score: 0.7 }],
    })}\n`, 'utf8');
    writeFileSync(join(tmp.dir, 'console.err.log'), 'boom\n', 'utf8');

    store = new RoleStateStore(tmp.dir, () => T);
    const lifeSettings = (): LifeSettings => ({
      timezone: TZ, sleepStartHour: 2, sleepEndHour: 9, planItemCount: 10,
      homeName: '家里', cycleEnabled: true, cycleAnchor: '2026-10-01',
    });
    const life = new LifeStateStore(tmp.dir, lifeSettings, () => T);
    life.ensurePlan();
    const companion = new Companion({
      dataDir: tmp.dir,
      timezone: TZ,
      settings: () => settings(),
      emit: async () => {},
      energy: () => 0.62,
      nameOf: (qq) => qq,
      now: () => T,
    });
    const people = new PersonRegistry(tmp.dir);
    deps = {
      settings: () => settings(),
      roleState: () => store,
      companion: () => companion,
      memoryDir: () => tmp.dir,
      people: () => people,
      timezone: () => TZ,
      dataDir: () => tmp.dir,
      memoryIndex: () => fakeIndex(),
      embeddingModel: () => 'm',
      recentOf: (conv) => (conv === 'group:730756767'
        ? [{ at: T - 60_000, from: '橘子精', text: '在吗' }]
        : []),
      groups: () => [{ id: 730756767, enabled: true }],
      styleDirs: () => ({ core: '', library: join(tmp.dir, 'note', 'style') }),
      life: () => life.snapshot({
        energy: store.current.energy,
        mood: store.current.mood.description,
        health: store.current.health,
        sleepText: store.current.sleep,
      }),
      refreshWeather: async () => {},
      updateLife: (patch) => life.patch(patch),
      setPlan: (slots, source) => life.setPlan(slots, source),
      lifeConfig: lifeSettings,
      weatherConfig: () => ({ enabled: false, city: '', refreshMinutes: 90 }),
      attention: () => ({
        config: { enabled: true, peripheryThreshold: 0.35, windowMinutes: 10, habituationMinutes: 30 },
        rows: [{
          at: T, ts: new Date(T).toISOString(), convKey: 'group:730756767', senderName: '甲',
          tier: 'background', score: 0.2, reasons: ['分 0.20 低于 0.35，只归档'], preview: '今天天气不错',
        }],
      }),
      now: () => T,
      intero: () => ({ socialBattery: 0.42, load: 0.21, updatedAt: T }),
      interoConfig: () => ({
        enabled: true, lowBattery: 0.3, highLoad: 0.85, replyBattery: 0.35, hesitationSeconds: 6,
      }),
      relation: (qq) => (qq === '90010001'
        ? {
            trust: 0.4, familiarity: 0.3, affinity: 0.12, boundary: 0.5,
            debts: [{ text: '答应告诉他检查结果', at: T }], basis: '越界言论：闭嘴',
          }
        : null),
    };
  });
  afterEach(() => tmp.cleanup());

  it('面板页签的 id 合法、不重复，且对得上浏览器的渲染表', () => {
    const ids = COMPANION_PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const panel of COMPANION_PANELS) expect(panel.id).toMatch(/^[a-z][a-z0-9-]*$/);
    // 页签由服务端声明、由浏览器渲染；少一个就是点了没反应。
    for (const id of ['overview', 'people', 'groups', 'observe', 'world', 'proactive', 'works', 'learning', 'tokens', 'troubleshoot', 'config']) {
      expect(ids).toContain(id);
    }
  });

  it('心情压成一个词：离基线最远的轴', () => {
    const base: RoleState['mood'] = { baseline: 5, joy: 5, anger: 5, sorrow: 5, fear: 5, intensity: null, description: '' };
    expect(shortMood({ ...base, joy: 7 })).toBe('轻快');
    expect(shortMood({ ...base, anger: 9, intensity: 'strong' })).toBe('很烦躁');
    expect(shortMood({ ...base, sorrow: 6 })).toBe('平稳');
    expect(shortMood({ ...base, fear: 8, sorrow: 9 })).toBe('低落');
  });

  it('总览一次给全：状态、额度、日记、入梦与唤醒', async () => {
    const st = await companionInvoke(deps, 'overview.state', []) as Record<string, unknown>;
    expect(st.enabled).toBe(true);
    expect((st.role as { energy: number }).energy).toBe(62);
    expect((st.diary as { date: string }).date).toBe('2026-10-25');
    expect((st.dream as { everyHours: number }).everyHours).toBe(6);
    expect((st.caps as { dailyCap: number }).dailyCap).toBe(2);
    const wakes = st.wakes as Array<{ id: string }>;
    expect(wakes[0]?.id).toBe('w2');
    expect((st.counts as { wakesToday: number }).wakesToday).toBeGreaterThan(0);
  });

  it('诊断只读：连看两次不会消耗额度', async () => {
    await companionInvoke(deps, 'overview.state', []);
    await companionInvoke(deps, 'proactive.state', []);
    expect(store.current.energy).toBe(62);
  });

  it('总览带今日八格、当前段与时间轴', async () => {
    const st = await companionInvoke(deps, 'overview.state', []) as {
      today: {
        weather: string; location: string; agendaCount: number; planSource: string;
        health: string; sleep: string; body: string; hunger: string; energy: number;
      } | null;
      current: { activity: string; time: string } | null;
      timeline: Array<{ state: string }>;
    };
    expect(st.today).toMatchObject({
      weather: '暂无天气信息',
      location: '家里',
      agendaCount: 10,
      planSource: 'fallback',
      health: '状态正常',
      hunger: '无饥饿感',
    });
    // T = 2026-10-25T06:00Z = 上海 14:00，落在第三段。
    expect(st.current?.activity).toBe('上午的安排');
    expect(st.timeline).toHaveLength(10);
    expect(st.today?.body).toBe('黄体期 第9/9天');
    expect((st as unknown as { intero: { socialBattery: number; gates: { enabled: boolean } } }).intero)
      .toMatchObject({ socialBattery: 0.42, load: 0.21, gates: { enabled: true } });
  });

  it('当前活动面板和睡眠状态都显示实际活动，不回退到原午休计划', async () => {
    const life = new LifeStateStore(tmp.dir, () => deps.lifeConfig!(), () => T);
    life.setPlan([{ time: '13:00', end: '15:00', activity: '午休', location: '卧室' }] as never);
    life.advance('在楼下吃饭', undefined, '楼下餐馆');
    deps.life = () => life.snapshot({ energy: 60, mood: '平稳', health: null, sleepText: null });
    const st = await companionInvoke(deps, 'overview.state', []) as {
      current: { activity: string } | null;
      today: { location: string; sleep: string };
    };
    expect(st.current?.activity).toBe('在楼下吃饭');
    expect(st.today.location).toBe('楼下餐馆');
    expect(st.today.sleep).not.toContain('睡眠中');
  });

  it('手动改生活事实后能回读', async () => {
    const out = await companionInvoke(deps, 'overview.saveLife', [{ hunger: '有点饿', outfit: '白衬衫' }]) as {
      ok: boolean; result: string;
    };
    expect(out.ok).toBe(true);
    const st = await companionInvoke(deps, 'overview.state', []) as {
      today: { hunger: string; outfit: string } | null;
    };
    expect(st.today?.hunger).toBe('有点饿');
    expect(st.today?.outfit).toBe('白衬衫');
  });

  it('用户列表带上记得几件事与最近互动', async () => {
    const rows = await companionInvoke(deps, 'people.list', []) as Array<{ qq: string; memories: number; views: number }>;
    expect(rows.map((r) => r.qq).sort()).toEqual(['90010001', '90010002']);
    expect(rows[0]?.memories).toBe(3);
    const withViews = rows.find((r) => r.qq === '90010001');
    expect(withViews?.views).toBe(1);
  });

  it('用户详情只读地列看法与最近记忆', async () => {
    const detail = await companionInvoke(deps, 'people.detail', ['90010001']) as {
      views: string[]; memories: Array<{ text: string }>; counts: { active: number; dormant: number };
      relation: { trust: number; boundary: number; debts: Array<{ text: string }> } | null;
    };
    expect(detail.views[0]).toContain('顺从');
    expect(detail.memories[0]?.text).toContain('顺从');
    expect(detail.counts.active).toBe(3);
    expect(detail.relation).toMatchObject({ trust: 0.4, boundary: 0.5 });
    expect(detail.relation?.debts[0]?.text).toContain('检查结果');
    await expect(companionInvoke(deps, 'people.detail', ['404'])).rejects.toThrow(/没有/);
  });

  it('没有 QQ 号的档案也能按文件名点开', async () => {
    writeFileSync(join(tmp.dir, 'people', 'deepseek.md'), 'DeepSeek娘：蓝发的同行。\n', 'utf8');
    const detail = await companionInvoke(deps, 'people.detail', ['people/deepseek.md']) as {
      person: { name: string; qq: string };
    };
    expect(detail.person.name).toBe('DeepSeek娘');
    expect(detail.person.qq).toBe('people/deepseek.md');
  });

  it('群聊状态合并监听名单与会话缓存，消息来自 World', async () => {
    const st = await companionInvoke(deps, 'groups.state', []) as {
      groups: Array<{ id: string; conv: string }>; caps: { topicDailyCap: number };
    };
    expect(st.groups[0]).toMatchObject({ id: '730756767', conv: 'group:730756767' });
    expect(st.caps.topicDailyCap).toBe(1);
    const msgs = await companionInvoke(deps, 'groups.messages', ['group:730756767', 10]) as Array<{ text: string }>;
    expect(msgs[0]?.text).toBe('在吗');
  });

  it('注意力判决带配置与理由，新的在前', async () => {
    const view = await companionInvoke(deps, 'groups.attention', []) as {
      config: { enabled: boolean; peripheryThreshold: number };
      rows: Array<{ tier: string; reasons: string[]; preview: string }>;
    };
    expect(view.config).toMatchObject({ enabled: true, peripheryThreshold: 0.35 });
    expect(view.rows[0]).toMatchObject({ tier: 'background', preview: '今天天气不错' });
    expect(view.rows[0]?.reasons.join('')).toContain('只归档');
  });

  it('观察：日记可读、越界日期被拒、记忆与召回有形状', async () => {
    const list = await companionInvoke(deps, 'observe.diaries', []) as Array<{ date: string }>;
    expect(list.map((r) => r.date)).toEqual(['2026-10-25', '2026-10-24']);
    const entry = await companionInvoke(deps, 'observe.diary', ['2026-10-24']) as { text: string };
    expect(entry.text).toContain('昨天很吵');
    await expect(companionInvoke(deps, 'observe.diary', ['../etc/passwd'])).rejects.toThrow(/没有/);

    const memories = await companionInvoke(deps, 'observe.memories', ['', 10]) as { items: Array<{ text: string }>; total: number };
    expect(memories.items[0]?.text).toBe('今天很安静');
    expect(memories.total).toBe(12);

    const recalls = await companionInvoke(deps, 'observe.recalls', [5]) as Array<{ query: string }>;
    expect(recalls[0]?.query).toBe('改名');
  });

  it('世界知识：世界观、宪法与 note/ 目录', async () => {
    const st = await companionInvoke(deps, 'world.state', []) as {
      worldview: string; constitution: string; files: Array<{ path: string }>;
    };
    expect(st.worldview).toContain('茶馆');
    expect(st.constitution).toContain('认号不认名');
    expect(st.files.map((f) => f.path)).toContain('note/style/05-short-reply.md');
  });

  it('主动：候选、诊断与记录分开给', async () => {
    const st = await companionInvoke(deps, 'proactive.state', []) as {
      diagnose: { ok: boolean; reason: string };
      candidates: unknown[];
      records: Array<{ id: string }>;
      caps: CompanionSettings;
    };
    expect(typeof st.diagnose.ok).toBe('boolean');
    expect(Array.isArray(st.candidates)).toBe(true);
    expect(st.records[0]?.id).toBe('w2');
    expect(st.caps.dailyCap).toBe(2);
  });

  it('学习：读得出资料库里的语气卡', async () => {
    const st = await companionInvoke(deps, 'learning.cards', []) as {
      cards: Array<{ tier: string; name: string; answer: string }>; library: number;
    };
    expect(st.library).toBe(1);
    expect(st.cards[0]?.name).toBe('05-short');
    expect(st.cards[0]?.answer).toContain('一句');
  });

  it('Token：今日与按供应商/用途拆分', async () => {
    const st = await companionInvoke(deps, 'tokens.state', []) as {
      today: { calls: number; input: number; output: number };
      providers: Array<{ name: string }>;
      purposes: Array<{ name: string }>;
      recent: Array<{ outcome: string }>;
    };
    expect(st.today.calls).toBe(1);
    expect(st.today.input).toBe(100);
    expect(st.providers[0]?.name).toBe('DeepSeek');
    expect(st.purposes.map((p) => p.name).sort()).toEqual(['dream', 'generation']);
    expect(st.recent.length).toBe(2);
  });

  it('排障：规模、唤醒、失败信号与错误日志', async () => {
    const st = await companionInvoke(deps, 'troubleshoot.state', []) as {
      run: { memoryTotal: number; vectors: number };
      wakes: Array<{ id: string }>;
      outcomes: Array<{ outcome: string; n: number }>;
      errors: string[];
    };
    expect(st.run.memoryTotal).toBe(7);
    expect(st.run.vectors).toBe(5);
    expect(st.wakes[0]?.id).toBe('w2');
    expect(st.outcomes.find((o) => o.outcome === 'sent')?.n).toBe(1);
    expect(st.errors).toEqual(['boom']);
  });

  it('配置写回角色状态，忽略的字段说清楚', async () => {
    const out = await companionInvoke(deps, 'config.saveState', [{ energy: 35, presence: '阅读中', mood: '开心' }]) as {
      ok: boolean; result: string; state: { energy: number; presence: string };
    };
    expect(out.ok).toBe(true);
    expect(out.state.energy).toBe(35);
    expect(out.state.presence).toBe('阅读中');
    expect(out.result).toContain('energy');
  });

  it('配置读得到生活项与天气设置', async () => {
    const st = await companionInvoke(deps, 'config.state', []) as {
      life: { city: string; weatherEnabled: boolean; homeName: string; planItemCount: number; cycleEnabled: boolean; cycleAnchor: string };
    };
    expect(st.life).toMatchObject({
      city: '', weatherEnabled: false, homeName: '家里', planItemCount: 10, cycleEnabled: true, cycleAnchor: '2026-10-01',
    });
  });

  it('未知方法报错，不静默成功', async () => {
    await expect(companionInvoke(deps, 'nope', [])).rejects.toThrow(/未知面板方法/);
  });
});
