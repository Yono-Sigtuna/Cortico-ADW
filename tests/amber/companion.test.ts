/** 陪伴层：机会、话头、冷却与"她自己的时间"。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectThought, opportunity, thought } from '../../bots/amber/persona/companion/models.ts';
import {
  CompanionStore, dayKey, duePending, emptyConv, emptyState, inHourWindow, localHour,
  type CompanionSettings, type CompanionState, type ConvState,
} from '../../bots/amber/persona/companion/state.ts';
import { curiosityCandidate, greetingCandidate, threadCandidate } from '../../bots/amber/persona/companion/sources.ts';
import { gateReason, planOnce } from '../../bots/amber/persona/companion/scheduler.ts';
import { Companion, isQuestion, oneSidedWorthNudging } from '../../bots/amber/persona/companion/index.ts';
import { buildOpportunityText } from '../../bots/amber/persona/companion/prompt.ts';
import { ThreadStore } from '../../bots/amber/persona/threads.ts';
import { makeTmpDir } from '../core/helpers.ts';

const TZ = 'Asia/Shanghai';
/** 2026-10-25 14:00 本地：不在安静时段，也不在她睡觉的时段。 */
const T = Date.parse('2026-10-25T06:00:00Z');
const MIN = 60_000;

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

const convState = (patch: Partial<ConvState> = {}): ConvState => ({
  ...emptyConv(),
  lastUserKey: '9001',
  // 默认是"安静了一小时、上一句没有悬着"——这是主动开口成立的状态。
  lastUserAt: T - 60 * MIN,
  lastBotAt: T - 60 * MIN,
  openLoop: null,
  ...patch,
});

describe('机会与念头', () => {
  const op = opportunity('group:1', 'open-loop', T, T + 60 * MIN, '9001');

  it('同一机会、同一种子，永远选同一条', () => {
    const thoughts = [
      thought(op, '接住上一句', 1),
      thought(op, '换个切口', 0.5),
      thought(op, '再换一个', 0.5),
    ];
    const a = selectThought(op, thoughts, { now: T + MIN, seed: 's' });
    const b = selectThought(op, thoughts, { now: T + MIN, seed: 's' });
    expect(a?.selected.id).toBe(b?.selected.id);
    expect(a?.weightUsed).toBe(true);
  });

  it('只有一个候选时不掷骰子', () => {
    const only = [thought(op, '唯一')];
    expect(selectThought(op, only, { now: T + MIN, seed: 's' })?.weightUsed).toBe(false);
  });

  it('过期窗口不兑现', () => {
    expect(selectThought(op, [thought(op, 'x')], { now: T + 61 * MIN, seed: 's' })).toBeNull();
  });

  it('eligible 过滤掉不可行的念头', () => {
    const picked = selectThought(op, [thought(op, 'x')], { now: T + MIN, seed: 's', eligible: () => false });
    expect(picked).toBeNull();
  });
});

describe('陪伴状态', () => {
  it('跨天把当天主动次数归零', () => {
    let now = T;
    const store = new CompanionStore(null, TZ, () => now);
    store.noteProactive('group:1', T);
    expect(store.current.proactiveToday).toBe(1);
    now = T + 24 * 60 * MIN;
    expect(store.tick().proactiveToday).toBe(0);
  });

  it('落盘后另一份实例读得到', () => {
    const tmp = makeTmpDir();
    try {
      new CompanionStore(tmp.dir, TZ, () => T).noteProactive('group:1', T);
      const again = new CompanionStore(tmp.dir, TZ, () => T);
      expect(again.current.proactiveToday).toBe(1);
      expect(again.current.convs['group:1'].lastProactiveAt).toBe(T);
    } finally {
      tmp.cleanup();
    }
  });

  it('小时窗口支持跨午夜', () => {
    expect(inHourWindow(23, 23, 8)).toBe(true);
    expect(inHourWindow(3, 23, 8)).toBe(true);
    expect(inHourWindow(9, 23, 8)).toBe(false);
    expect(localHour(T, TZ)).toBe(14);
  });

  it('状态文件坏了就按空状态继续，不阻塞启动', () => {
    const tmp = makeTmpDir();
    try {
      writeFileSync(join(tmp.dir, 'companion.json'), '这不是 JSON', 'utf8');
      const store = new CompanionStore(tmp.dir, TZ, () => T);
      expect(store.current.proactiveToday).toBe(0);
      expect(Object.keys(store.current.convs)).toHaveLength(0);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('机会来源', () => {
  const quietRoom = { heat: 'quiet', lullMinutes: 60 };

  it('群里安静下来 → 可以自己起一句', () => {
    const hit = curiosityCandidate({
      conv: 'group:1', subject: '9001', now: T, hour: 14, convState: convState({ openLoop: null }), settings: settings(),
      room: quietRoom, waitingForAnswer: false,
    });
    expect(hit).not.toBeNull();
    expect(hit?.thoughts[0].summary).toContain('没人等你回');
  });

  it('群里正一来一回地聊着 → 不开口', () => {
    for (const heat of ['normal', 'busy', 'flood']) {
      expect(curiosityCandidate({
        conv: 'group:1', subject: '9001', now: T, hour: 14, convState: convState({ openLoop: null }), settings: settings(),
        room: { heat, lullMinutes: 60 }, waitingForAnswer: false,
      }), heat).toBeNull();
    }
  });

  it('刚有人说完话 → 还不算空下来', () => {
    expect(curiosityCandidate({
      conv: 'group:1', subject: '9001', now: T, hour: 14, convState: convState({ openLoop: null }), settings: settings(),
      room: { heat: 'quiet', lullMinutes: 10 }, waitingForAnswer: false,
    })).toBeNull();
  });

  it('上一句还没人接 → 什么都不提', () => {
    expect(curiosityCandidate({
      conv: 'group:1', subject: '9001', now: T, hour: 14, convState: convState(), settings: settings(),
      room: quietRoom, waitingForAnswer: true,
    })).toBeNull();
  });

  it('刚试过一次 → 隔开再说', () => {
    expect(curiosityCandidate({
      conv: 'group:1', subject: '9001', now: T, hour: 14,
      convState: convState({ openLoop: null, lastAttemptAt: T - 30 * MIN }), settings: settings(),
      room: quietRoom, waitingForAnswer: false,
    })).toBeNull();
  });

  it('问候只给私聊，且要很久没说话', () => {
    const stale = convState({ openLoop: null, lastUserAt: T - 10 * MIN, lastBotAt: T - 10 * MIN });
    expect(greetingCandidate({
      conv: 'private:9001', subject: '9001', now: T, hour: 14, convState: stale, settings: settings(),
    })).toBeNull();

    const morning = Date.parse('2026-10-25T00:30:00Z'); // 本地 08:30
    const long = convState({ openLoop: null, lastUserAt: morning - 8 * 60 * MIN, lastBotAt: morning - 8 * 60 * MIN });
    expect(greetingCandidate({
      conv: 'private:9001', subject: '9001', now: morning, hour: 8, convState: long, settings: settings(),
    })).not.toBeNull();
    expect(greetingCandidate({
      conv: 'group:1', subject: '9001', now: morning, hour: 8, convState: long, settings: settings(),
    })).toBeNull();
  });
});

describe('什么时候允许主动', () => {
  const base = (patch: Partial<ConvState> = {}, over: Partial<CompanionSettings> = {}) => {
    const state: CompanionState = emptyState(T, dayKey(T, TZ));
    state.convs['group:1'] = convState(patch);
    return { now: T, timezone: TZ, settings: settings(over), state, energy: 1 };
  };

  it('默认有机会', () => {
    expect(planOnce(base())).not.toBeNull();
  });

  it('关掉就什么都不做', () => {
    expect(planOnce(base({}, { enabled: false }))).toBeNull();
  });

  it('她自己睡着的时段不主动', () => {
    const night = base();
    night.now = Date.parse('2026-10-25T19:30:00Z'); // 本地 03:30
    expect(planOnce(night)).toBeNull();
  });

  it('安静时段不主动', () => {
    const late = base();
    late.now = Date.parse('2026-10-25T15:30:00Z'); // 本地 23:30
    expect(planOnce(late)).toBeNull();
  });

  it('当天额度用完不主动', () => {
    const full = base();
    full.state.proactiveToday = 2;
    expect(planOnce(full)).toBeNull();
  });

  it('刚主动过半小时内不主动', () => {
    const recent = base();
    recent.state.lastProactiveAt = T - 10 * MIN;
    expect(planOnce(recent)).toBeNull();
  });

  it('社交电量低就不主动，面板给得出原因', () => {
    const low = { ...base(), socialBattery: 0.2 };
    expect(planOnce(low)).toBeNull();
    expect(gateReason(low)).toContain('社交电量 20%');
  });

  it('负荷高就不主动', () => {
    const hot = { ...base(), load: 0.9 };
    expect(planOnce(hot)).toBeNull();
    expect(gateReason(hot)).toContain('手头负荷');
  });

  it('内感受关掉时不看这两项', () => {
    const off = {
      ...base({}, { intero: { enabled: false, lowBattery: 0.3, highLoad: 0.85 } }),
      socialBattery: 0.05,
      load: 0.99,
    };
    expect(planOnce(off)).not.toBeNull();
  });

  it('关系拦下的人，不先主动找他', () => {
    const blocked = { ...base(), relationBlock: () => '刚越过界，先不主动找他' };
    expect(planOnce(blocked)).toBeNull();
    const open = { ...base(), relationBlock: () => null };
    expect(planOnce(open)).not.toBeNull();
  });

  it('精力太低不主动', () => {
    const tired = base();
    tired.energy = 0.2;
    expect(planOnce(tired)).toBeNull();
  });

  it('关掉群聊主动后群里不再开口', () => {
    expect(planOnce(base({}, { allowGroups: false }))).toBeNull();
  });
});

describe('陪伴层本体', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let now: number;
  let emitted: string[];

  beforeEach(() => {
    tmp = makeTmpDir();
    now = T;
    emitted = [];
  });

  afterEach(() => tmp.cleanup());

  const make = (patch: Partial<CompanionSettings> = {}) => new Companion({
    dataDir: tmp.dir,
    timezone: TZ,
    settings: () => settings(patch),
    emit: async (text) => { emitted.push(text); },
    energy: () => 1,
    nameOf: (qq) => `某人(${qq})`,
    now: () => now,
    intervalMs: 60 * 60_000,
  });

  it('她问了问题 → 留一个未完话头', () => {
    const c = make();
    c.noteBotMessage('group:1', '你今天还好吗？', true);
    expect(c.snapshot().convs[0].openLoop).toContain('你今天还好吗');
  });

  it('她说了陈述 → 没有话头', () => {
    const c = make();
    c.noteBotMessage('group:1', '今天群里挺热闹的。', true);
    expect(c.snapshot().convs[0].openLoop).toBeNull();
  });

  it('上一句没人接 → 不提；对方答过、又安静下来 → 推一条', async () => {
    const c = make();
    c.noteUserMessage('group:1', '9001', 'claude 在吗');
    c.noteBotMessage('group:1', '你今天还好吗？', true);
    now = T + 46 * MIN;
    expect(await c.evaluate()).toBe(false);

    c.noteUserMessage('group:1', '9001', '刚在忙，怎么了');
    now = T + 120 * MIN;
    expect(await c.evaluate()).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('没人等你回');
    expect(emitted[0]).toContain('某人(9001)');
    expect(await c.evaluate()).toBe(false);
  });

  it('并发评估只推一条：pending 在 await 之前就置位', async () => {
    const c = make();
    c.noteUserMessage('group:1', '9001', 'claude 在吗');
    now = T + 60 * MIN;
    const results = await Promise.all([c.evaluate(), c.evaluate(), c.evaluate()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it('她说了 → 计入当天额度', async () => {
    const c = make();
    c.noteUserMessage('group:1', '9001', 'claude 在吗');
    now = T + 60 * MIN;
    await c.evaluate();
    c.settle(true);
    expect(c.snapshot().proactiveToday).toBe(1);
  });

  it('她没说 → 不计额度，但这一次机会退役', async () => {
    const d = make();
    d.noteUserMessage('group:1', '9001', 'claude 在吗');
    now = T + 60 * MIN;
    await d.evaluate();
    d.settle(false);
    expect(d.snapshot().proactiveToday).toBe(0);
    expect(await d.evaluate()).toBe(false);
  });

  it('对方先开口 → 机会作废，也不会再催', async () => {
    const c = make();
    c.noteBotMessage('group:1', '你今天还好吗？', true);
    now = T + 20 * MIN;
    c.noteUserMessage('group:1', '9001', '刚在忙');
    now = T + 46 * MIN;
    expect(await c.evaluate()).toBe(false);
    expect(c.snapshot().convs[0].openLoop).toBeNull();
  });

  it('关掉之后一次都不推', async () => {
    const c = make({ enabled: false });
    c.noteBotMessage('group:1', '在吗？', true);
    now = T + 46 * MIN;
    expect(await c.evaluate()).toBe(false);
  });
});

describe('主动时刻的文本', () => {
  const op = opportunity('group:1', 'open-loop-question', T, T + 60 * MIN, '9001');
  const selection = selectThought(op, [thought(op, '你问过这个人一句：「你今天还好吗？」')], { now: T, seed: 's' })!;

  it('说清这是她自己想开口，并允许什么都不做', () => {
    const text = buildOpportunityText({
      now: T, timezone: TZ, selection, conv: 'group:1',
      subjectName: '某人(9001)', gapMinutes: 75, energy: 0.4, proactiveToday: 0,
    });
    expect(text).toContain('这不是有人给你发消息');
    expect(text).toContain('时间感');
    expect(text).toContain('约 1 小时前');
    expect(text).toContain('精力不高');
    expect(text).toContain('不想说就什么都不做');
    expect(text).toContain('qq_draft');
  });

  it('认得出问句', () => {
    expect(isQuestion('你今天还好吗？')).toBe(true);
    expect(isQuestion('吃了吗')).toBe(true);
    expect(isQuestion('今天挺好的')).toBe(false);
  });
});

describe('话头当由头', () => {
  const note = { id: 'n1', text: '答应挑两段随笔给他看', at: T - 2 * 60 * MIN };
  const base = (patch: Partial<ConvState> = {}, threadNote: () => { id: string; text: string; at: number } | null = () => note) => {
    const state: CompanionState = emptyState(T, dayKey(T, TZ));
    state.convs['group:1'] = convState(patch);
    return { now: T, timezone: TZ, settings: settings(), state, energy: 1, threadNote };
  };

  it('有话说时，由头是那句没说完的话，不是「这边安静够久」', () => {
    const planned = planOnce(base())!;
    expect(planned.selection.opportunity.kind).toBe('thread');
    expect(planned.threadId).toBe('n1');
    expect(planned.selection.selected.summary).toContain('随笔');
  });

  it('没有话头就退回安静时的自问', () => {
    const planned = planOnce(base({}, () => null))!;
    expect(planned.selection.opportunity.kind).toBe('quiet');
    expect(planned.threadId).toBeUndefined();
  });

  it('上一句还没人接时不拿话头当由头——先等回音', () => {
    const waiting = convState({ openLoop: { at: T - 5 * MIN, subject: '9001', text: '你今天还好吗', kind: 'question' as const, followed: false } });
    expect(threadCandidate({
      conv: 'group:1', subject: '9001', now: T, hour: 14, convState: waiting, settings: settings(),
      room: null, waitingForAnswer: true, note,
    })).toBeNull();
  });
});

describe('话头 · 什么时候算还能提', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  afterEach(() => tmp.cleanup());
  const storeOf = (now: number) => {
    tmp = makeTmpDir();
    return new ThreadStore(join(tmp.dir, 'threads.json'), () => TZ, () => now);
  };

  it('刚留下不足半小时：还在刚才那段对话里，不拿来做由头', () => {
    const store = storeOf(T);
    store.leave('回头再说');
    expect(store.offerable(T + 10 * MIN)).toBeNull();
    expect(store.offerable(T + 40 * MIN)?.text).toBe('回头再说');
  });

  it('放了一天半还没提，就当自己也不打算说了', () => {
    const store = storeOf(T);
    store.leave('回头再说');
    expect(store.offerable(T + 37 * 60 * MIN)).toBeNull();
  });

  it('提过一次就不再提', () => {
    const store = storeOf(T);
    const left = store.leave('回头再说');
    store.markSurfaced(left.id);
    expect(store.offerable(T + 60 * MIN)).toBeNull();
  });
});

describe('他还在等的事 · 提一次就散', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let now = T;
  let store: CompanionStore;
  const CONV = 'group:1';

  beforeEach(() => {
    tmp = makeTmpDir();
    now = T;
    store = new CompanionStore(tmp.dir, TZ, () => now);
  });
  afterEach(() => tmp.cleanup());

  it('同一件事写两遍只算一条', () => {
    store.notePending(CONV, '挑两段随笔给他看');
    store.notePending(CONV, '我挑两段随笔给他看。');
    expect(store.conv(CONV).pending).toHaveLength(1);
  });

  it('他再开口时带出来一次，之后就散', () => {
    store.notePending(CONV, '挑两段随笔给他看');
    const first = duePending(store.conv(CONV), now);
    expect(first?.text).toContain('随笔');
    store.notePendingReferred(CONV, first!.id);
    expect(duePending(store.conv(CONV), now)).toBeNull();
  });

  it('过了四十八小时就散了', () => {
    store.notePending(CONV, '挑两段随笔给他看');
    expect(duePending(store.conv(CONV), now + 49 * 60 * MIN)).toBeNull();
  });

  it('兑现了就销', () => {
    store.notePending(CONV, '答应明天告诉他检查结果');
    expect(store.closePending(CONV, '检查结果')).toBe(true);
    expect(store.conv(CONV).pending).toHaveLength(0);
  });

  it('落盘后重开还挂着', () => {
    store.notePending(CONV, '挑两段随笔给他看');
    const again = new CompanionStore(tmp.dir, TZ, () => now);
    expect(again.conv(CONV).pending).toHaveLength(1);
  });
});

describe('他还在等的事 · 欠的是人，不是会话', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let now = T;
  let store: CompanionStore;
  const GROUP = 'group:730756767';
  const PRIVATE = 'private:3124076548';
  const QQ = '3124076548';
  const OTHER = '2578598310';

  beforeEach(() => {
    tmp = makeTmpDir();
    now = T;
    store = new CompanionStore(tmp.dir, TZ, () => now);
  });
  afterEach(() => tmp.cleanup());

  it('同群换了别人说话，不把不相干的账翻出来', () => {
    store.notePending(GROUP, '答应明天告诉他检查结果', now, QQ);
    expect(store.dueFor(OTHER, GROUP)).toBeNull();
    expect(store.dueFor(QQ, GROUP)?.note.text).toContain('检查结果');
  });

  it('在群里欠的，他到私聊再开口仍然带出来', () => {
    store.notePending(GROUP, '答应陪他拆耦合', now, QQ);
    const due = store.dueFor(QQ, PRIVATE);
    expect(due?.conv).toBe(GROUP);
    expect(due?.note.text).toContain('拆耦合');
  });

  it('当前会话里就有的话，先用当前会话那条', () => {
    store.notePending(GROUP, '答应陪他拆耦合', now, QQ);
    store.notePending(PRIVATE, '答应明天给他看图', now + MIN, QQ);
    expect(store.dueFor(QQ, PRIVATE)?.conv).toBe(PRIVATE);
  });

  it('兑现可以跨会话销账', () => {
    store.notePending(GROUP, '答应明天告诉他检查结果', now, QQ);
    expect(store.closeFor(QQ, '检查结果')).toBe(true);
    expect(store.dueFor(QQ, PRIVATE)).toBeNull();
    expect(store.conv(GROUP).pending).toHaveLength(0);
  });

  it('销账时报出会话与承诺时间，供履约奖励找证据', () => {
    store.notePending(GROUP, '答应明天告诉他检查结果', now, QQ);
    const detail = store.closeForDetail(QQ, '检查结果');
    expect(detail).toEqual({ closed: true, conv: GROUP, at: now });
    expect(store.closeForDetail(QQ, '检查结果').closed).toBe(false);
  });

  it('别人的账不会被当场销掉', () => {
    store.notePending(GROUP, '答应明天告诉他检查结果', now, OTHER);
    expect(store.closeFor(QQ, '检查结果')).toBe(false);
    expect(store.conv(GROUP).pending).toHaveLength(1);
  });

  it('同群两个人欠了同一句话：各记各的，不互相覆盖', () => {
    store.notePending(GROUP, '答应明天给他看结果', now, QQ);
    store.notePending(GROUP, '答应明天给他看结果', now, OTHER);
    expect(store.conv(GROUP).pending).toHaveLength(2);
    expect(store.dueFor(QQ, GROUP)?.note.text).toContain('看结果');
    expect(store.dueFor(OTHER, GROUP)?.note.text).toContain('看结果');
    expect(store.conv(GROUP).pending.map((p) => p.subject).sort()).toEqual([QQ, OTHER].sort());
  });

  it('拿别人的承诺 ID 销账无效', () => {
    store.notePending(GROUP, '答应陪他拆耦合', now, OTHER);
    const id = store.conv(GROUP).pending[0]!.id;
    expect(store.closeFor(QQ, id)).toBe(false);
    expect(store.conv(GROUP).pending).toHaveLength(1);
    expect(store.closeFor(OTHER, id)).toBe(true);
    expect(store.conv(GROUP).pending).toHaveLength(0);
  });

  it('落盘后重开，仍然按人跨会话找得到', () => {
    store.notePending(GROUP, '答应陪他拆耦合', now, QQ);
    const again = new CompanionStore(tmp.dir, TZ, () => now);
    expect(again.dueFor(QQ, PRIVATE)?.conv).toBe(GROUP);
  });

  it('旧账没有主人：只在自己那个会话里认，不外溢', () => {
    store.notePending(GROUP, '答应陪他拆耦合');
    expect(store.dueFor(QQ, PRIVATE)).toBeNull();
    expect(store.dueFor(QQ, GROUP)?.conv).toBe(GROUP);
  });
});

describe('只答不问的账 · 攒够三轮回一次', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let now = T;

  beforeEach(() => {
    tmp = makeTmpDir();
    now = T;
  });
  afterEach(() => tmp.cleanup());

  const make = () => new Companion({
    dataDir: tmp.dir,
    timezone: TZ,
    settings: () => settings(),
    emit: async () => {},
    energy: () => 1,
    nameOf: (qq) => qq,
    now: () => now,
    intervalMs: 60 * 60_000,
  });
  const answer = (c: Companion, text = '嗯，吃了。') => {
    c.noteBotMessage('group:1', text, false, { answered: true });
    now += MIN;
  };

  it('连着三句只答不问：第三轮之后提醒一次，同一个数不重复提', () => {
    const c = make();
    answer(c); answer(c); answer(c);
    expect(c.oneSidedDue('group:1')).toBe(3);
    expect(c.oneSidedDue('group:1')).toBe(0);
  });

  it('她问回去就归零', () => {
    const c = make();
    answer(c); answer(c);
    answer(c, '你呢？');
    expect(c.oneSidedDue('group:1')).toBe(0);
  });

  it('她自己起头也归零', () => {
    const c = make();
    answer(c); answer(c);
    c.noteBotMessage('group:1', '我在写东西。', false, { answered: false });
    expect(c.oneSidedDue('group:1')).toBe(0);
  });

  it('隔了七小时再聊，不算同一条线', () => {
    const c = make();
    answer(c); answer(c);
    now += 7 * 60 * MIN;
    answer(c);
    expect(c.oneSidedDue('group:1')).toBe(0);
  });

  it('提醒过还在涨：下一个台阶再提', () => {
    const c = make();
    answer(c); answer(c); answer(c);
    expect(c.oneSidedDue('group:1')).toBe(3);
    answer(c); answer(c); answer(c);
    expect(c.oneSidedDue('group:1')).toBe(6);
  });

  it('落盘重开还在', () => {
    const c = make();
    answer(c); answer(c); answer(c);
    expect(make().oneSidedDue('group:1')).toBe(3);
  });

  it('隔了一夜再想起这段时间，不提旧账', () => {
    const c = make();
    answer(c); answer(c); answer(c);
    now += 7 * 60 * MIN;
    expect(c.oneSidedDue('group:1')).toBe(0);
  });

  it('房间里不止他一个人在说，就不催她递话头', () => {
    expect(oneSidedWorthNudging(null)).toBe(true);
    expect(oneSidedWorthNudging(1)).toBe(true);
    expect(oneSidedWorthNudging(2)).toBe(false);
  });
});
