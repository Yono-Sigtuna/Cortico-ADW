/** 群聊形状：只数事实的那几个函数——窗口、占比、冷场、描述行。 */
import { describe, it, expect } from 'vitest';
import {
  RoomTracker,
  describeRoom,
  roomConfig,
  roomDigest,
  roomFacts,
  type RoomConfig,
  type RoomSample,
} from '../../../src/worlds/qq/room.ts';

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const cfg = (patch: Partial<RoomConfig> = {}): RoomConfig => roomConfig({ enabled: true, windowMinutes: 30, ...patch });

const sample = (patch: Partial<RoomSample> = {}): RoomSample => ({
  at: T0,
  senderKey: '1001',
  replyTo: null,
  question: false,
  emotional: false,
  filler: false,
  toSelf: false,
  ...patch,
});

describe('roomConfig', () => {
  it('缺的值走默认，窗口夹在 5–240 分钟', () => {
    expect(roomConfig()).toEqual({ enabled: true, windowMinutes: 30 });
    expect(roomConfig({ windowMinutes: 1 }).windowMinutes).toBe(5);
    expect(roomConfig({ windowMinutes: 999 }).windowMinutes).toBe(240);
    expect(roomConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe('roomFacts', () => {
  it('只数窗口内的消息；全部过期时是 silent，静默时长按最后一条算', () => {
    const c = cfg({ windowMinutes: 10 });
    const samples = [sample({ at: T0 - 30 * MIN }), sample({ at: T0 - 20 * MIN })];
    const f = roomFacts(samples, T0, c);
    expect(f.messages).toBe(0);
    expect(f.heat).toBe('silent');
    expect(Math.round(f.lullMinutes)).toBe(20);
  });

  it('人数、最大占比、接话比例、问她的条数', () => {
    const c = cfg();
    const samples = [
      sample({ at: T0 - 4 * MIN, senderKey: 'a' }),
      sample({ at: T0 - 3 * MIN, senderKey: 'a', replyTo: 'b' }),
      sample({ at: T0 - 2 * MIN, senderKey: 'b', toSelf: true, question: true }),
      sample({ at: T0 - 1 * MIN, senderKey: 'c', filler: true }),
    ];
    const f = roomFacts(samples, T0, c);
    expect(f.messages).toBe(4);
    expect(f.speakers).toBe(3);
    expect(f.topSender).toBe('a');
    expect(f.topMessages).toBe(2);
    expect(f.topShare).toBeCloseTo(0.5);
    expect(f.replyMessages).toBe(1);
    expect(f.replyShare).toBeCloseTo(0.25);
    expect(f.toSelfMessages).toBe(1);
    expect(f.questionMessages).toBe(1);
    expect(f.fillerMessages).toBe(1);
  });

  it('一个人占六成以上算独白；只有两个人的正常对话不算', () => {
    const c = cfg();
    const mono = roomFacts(
      [1, 2, 3, 4, 5].map((i) => sample({ at: T0 - i * MIN, senderKey: 'a' }))
        .concat([sample({ at: T0 - 6 * MIN, senderKey: 'b' })]),
      T0,
      c,
    );
    expect(mono.monologue).toBe(true);

    const pair = roomFacts(
      [1, 2, 3].map((i) => sample({ at: T0 - i * MIN, senderKey: i % 2 ? 'a' : 'b' })),
      T0,
      c,
    );
    expect(pair.monologue).toBe(false);
  });

  it('她自己的发言不进数字，但会让"这场还有她"成立', () => {
    const c = cfg();
    const talk = [
      sample({ at: T0 - 3 * MIN, senderKey: '1001' }),
      sample({ at: T0 - 2 * MIN, senderKey: '1002' }),
      sample({ at: T0 - MIN, senderKey: '1001' }),
    ];
    const before = roomFacts(talk, T0, c);
    expect(before.othersTalking).toBe(true);
    expect(before.lastSelfAt).toBeNull();

    // 她插一句：数字不变，但这不再是"没有她"的一场对谈。
    const after = roomFacts([...talk, sample({ at: T0 - 30_000, senderKey: '5004', self: true })], T0, c);
    expect(after.messages).toBe(3);
    expect(after.speakers).toBe(2);
    expect(after.othersTalking).toBe(false);
    expect(after.lastSelfAt).toBe(T0 - 30_000);
  });

  it('一个人连着说，不算"两个人在互相说"', () => {
    const c = cfg();
    const one = [1, 2, 3].map((i) => sample({ at: T0 - i * MIN, senderKey: '1001' }));
    expect(roomFacts(one, T0, c).othersTalking).toBe(false);
  });

  it('每分钟条数决定档位', () => {
    const c = cfg({ windowMinutes: 10 });
    const many = Array.from({ length: 80 }, (_, i) => sample({ at: T0 - i * 5_000 }));
    expect(roomFacts(many, T0, c).heat).toBe('flood');

    const few = Array.from({ length: 3 }, (_, i) => sample({ at: T0 - i * MIN }));
    expect(roomFacts(few, T0, c).heat).toBe('quiet');
  });
});

describe('describeRoom', () => {
  const c = cfg();

  it('没人说话时只说静了多久；一两条隔很久时说"只有几条"', () => {
    const none = roomFacts([sample({ at: T0 - 40 * MIN })], T0, c);
    expect(describeRoom(none, c)).toBe('近 30 分钟没人说话；最后一条在 40 分钟前。');

    const one = roomFacts([sample({ at: T0 - 12 * MIN })], T0, c);
    expect(describeRoom(one, c)).toBe('近 30 分钟只有 1 条；最后一条在 12 分钟前。');
  });

  it('独白要说出是谁占了多少；接话、问她、问句各自成句', () => {
    const samples = [
      sample({ at: T0 - 5 * MIN, senderKey: 'a' }),
      sample({ at: T0 - 4 * MIN, senderKey: 'a' }),
      sample({ at: T0 - 3 * MIN, senderKey: 'a', replyTo: 'b' }),
      sample({ at: T0 - 2 * MIN, senderKey: 'b', toSelf: true, question: true }),
      sample({ at: T0 - 1 * MIN, senderKey: 'a', question: true }),
      sample({ at: T0 - 1 * MIN, senderKey: 'c', question: true }),
    ];
    const line = describeRoom(roomFacts(samples, T0, c), c, { nameOf: (qq) => (qq === 'a' ? '阿明' : qq) });
    expect(line).toContain('6 条，3 人在说');
    expect(line).toContain('阿明 一个人占了 4 条');
    expect(line).toContain('1 条在接别人的话');
    expect(line).toContain('1 条在问你');
    expect(line).toContain('3 条是问句');
    expect(line!.endsWith('。')).toBe(true);
  });

  it('名字取不到就退回号码，不空着', () => {
    const samples = [1, 2, 3, 4].map((i) => sample({ at: T0 - i * MIN, senderKey: '3124' }));
    const line = describeRoom(roomFacts(samples, T0, c), c);
    expect(line).toContain('3124 一个人占了 4 条');
  });
});

describe('RoomTracker', () => {
  it('窗口外的样本被丢掉，facts 跟着变', () => {
    const tracker = new RoomTracker();
    const c = cfg({ windowMinutes: 10 });
    tracker.observe('group:1', sample({ at: T0 - 40 * MIN }), c);
    tracker.observe('group:1', sample({ at: T0, senderKey: 'b' }), c);
    expect(tracker.facts('group:1', T0, c).messages).toBe(1);
  });

  it('会话各记各的；关掉开关就什么都不记', () => {
    const tracker = new RoomTracker();
    const c = cfg();
    tracker.observe('group:1', sample(), c);
    expect(tracker.facts('group:2', T0, c).messages).toBe(0);

    const off = new RoomTracker();
    off.observe('group:1', sample(), cfg({ enabled: false }));
    expect(off.facts('group:1', T0, cfg({ enabled: false })).messages).toBe(0);
  });
});

describe('roomDigest', () => {
  it('给事件 meta 的那一份：取整、不带名字，静默时 lull 是 null', () => {
    const f = roomFacts([], T0, cfg());
    const d = roomDigest(f);
    expect(d.messages).toBe(0);
    expect(d.lullMinutes).toBeNull();
    expect(Object.keys(d).sort()).toEqual(
      ['heat', 'lullMinutes', 'messages', 'monologue', 'replyShare', 'speakers', 'toSelf'],
    );
  });
});
