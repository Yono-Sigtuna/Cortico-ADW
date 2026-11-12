/** 群话题参与：正在聊、她懂、轮不到她、今天没接过——四道判据缺一不可。 */
import { describe, it, expect } from 'vitest';
import { topicCandidate, type TopicInput } from '../../bots/amber/persona/companion/sources.ts';
import { emptyConv, type CompanionSettings, type ConvState } from '../../bots/amber/persona/companion/state.ts';
import { makeTmpDir } from '../core/helpers.ts';
import { Companion } from '../../bots/amber/persona/companion/index.ts';

const T = Date.parse('2026-10-25T06:00:00Z'); // 本地 14:00
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

const msg = (at: number, from: string, text: string) => ({ at, from, text });

const conv = (patch: Partial<ConvState> = {}): ConvState => ({
  ...emptyConv(),
  lastUserKey: '9002',
  lastUserAt: T - MIN,
  recent: [
    msg(T - 20 * MIN, '9002', '新显卡是真的贵'),
    msg(T - 18 * MIN, '9003', '贵也算了，功耗更离谱'),
    msg(T - 16 * MIN, '9002', '我在看评测，温度上到八十多'),
    msg(T - 14 * MIN, '9003', '那机箱得多大'),
    msg(T - 12 * MIN, '9002', '反正我不打算换'),
    msg(T - 10 * MIN, '9003', '等你换的时候再说'),
  ],
  ...patch,
});

const input = (patch: Partial<TopicInput> = {}): TopicInput => ({
  conv: 'group:730756767',
  subject: '9003',
  now: T,
  hour: 14,
  convState: conv(),
  settings: settings(),
  topicToday: 0,
  recall: () => [{ text: '群里上次讨论显卡是三个月前，他最后没换。', eventTime: '2026-07-20', kind: 'episodic' }],
  viewsOf: () => ['他要的不是顺从，是被认真对待'],
  nameOf: (qq) => `某人(${qq})`,
  ...patch,
});

describe('群话题参与', () => {
  it('几个人来回聊、她记得相关的事 → 有机会，由头里带对话、记忆和看法', () => {
    const hit = topicCandidate(input());
    expect(hit).not.toBeNull();
    const summary = hit!.thoughts[0].summary;
    expect(summary).toContain('群里正在聊');
    expect(summary).toContain('你记得相关的事');
    expect(summary).toContain('你对某人(9003)的看法');
    expect(summary).toContain('只是附和');
  });

  it('一个人连发六条不算在聊', () => {
    const solo = conv({
      recent: Array.from({ length: 6 }, (_, i) => msg(T - (20 - i) * MIN, '9002', `第 ${i} 句`)),
    });
    expect(topicCandidate(input({ convState: solo }))).toBeNull();
  });

  it('条数不够不算在聊', () => {
    const thin = conv({ recent: [msg(T - 10 * MIN, '9002', '在吗'), msg(T - 9 * MIN, '9003', '在')] });
    expect(topicCandidate(input({ convState: thin }))).toBeNull();
  });

  it('刚被叫到 → 那是正常回复，不是插话', () => {
    expect(topicCandidate(input({ convState: conv({ lastAddressedAt: T - 3 * MIN }) }))).toBeNull();
  });

  it('她刚在群里说过 → 让位', () => {
    expect(topicCandidate(input({ convState: conv({ lastBotAt: T - 5 * MIN }) }))).toBeNull();
  });

  it('检索不到相关记忆 → 没有可说的', () => {
    expect(topicCandidate(input({ recall: () => [] }))).toBeNull();
  });

  it('今天已经接过一次 → 不再接', () => {
    expect(topicCandidate(input({ topicToday: 1 }))).toBeNull();
  });

  it('没有开启群话题参与 → 不接', () => {
    expect(topicCandidate(input({ settings: settings({ participateGroups: false }) }))).toBeNull();
  });

  it('私聊里不产生话题机会', () => {
    expect(topicCandidate(input({ conv: 'private:9003' }))).toBeNull();
  });

  it('记忆检索抛错时安静放弃，不炸掉评估', () => {
    expect(topicCandidate(input({ recall: () => { throw new Error('索引坏了'); } }))).toBeNull();
  });
});

describe('话题机会的记账', () => {
  it('推过一次就计入 topicToday，今天不再推第二次', async () => {
    const tmp = makeTmpDir();
    try {
      let now = T;
      const emitted: string[] = [];
      const c = new Companion({
        dataDir: tmp.dir,
        timezone: 'Asia/Shanghai',
        settings: () => settings(),
        emit: async (text) => { emitted.push(text); },
        energy: () => 1,
        nameOf: (qq) => `某人(${qq})`,
        recall: () => [{ text: '群里上次讨论显卡是三个月前。', eventTime: '2026-07-20', kind: 'episodic' }],
        viewsOf: () => [],
        now: () => now,
      });
      for (const m of conv().recent) c.noteUserMessage('group:730756767', m.from, m.text, { at: m.at });
      now = T;
      expect(await c.evaluate()).toBe(true);
      expect(emitted[0]).toContain('群里正在聊');
      // 她还没决定说不说，但这次机会已经用掉。
      expect(c.snapshot().topicToday).toBe(1);
      expect(await c.evaluate()).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('群话题参与 · 房间形状', () => {
  const view = (patch: Partial<NonNullable<TopicInput['room']>> = {}) => ({
    messages: 6,
    speakers: 2,
    heat: 'quiet',
    monologue: false,
    replyShare: 0.3,
    toSelf: 0,
    lullMinutes: 3,
    ...patch,
  });

  it('窗口里六条、之后静了二十分钟：那不是正在聊', () => {
    expect(topicCandidate(input({ room: view({ lullMinutes: 20 }) }))).toBeNull();
  });

  it('消息还在涌的时候也轮不到她', () => {
    expect(topicCandidate(input({ room: view({ heat: 'flood' }) }))).toBeNull();
  });

  it('群里真在一来一回地聊着，她不插话', () => {
    for (const heat of ['normal', 'busy']) {
      expect(topicCandidate(input({ room: view({ heat }) })), heat).toBeNull();
    }
  });

  it('刚说过、正接话的时候照常成立', () => {
    expect(topicCandidate(input({ room: view() }))).not.toBeNull();
  });

  it('不知道形状时按旧判据走，不受影响', () => {
    expect(topicCandidate(input())).not.toBeNull();
  });
});
