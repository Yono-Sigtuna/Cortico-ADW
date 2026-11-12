/**
 * 同住的另外两只可以叫醒本实例——吵架、接梗、联手都得靠这条。
 * 连续互接超过预算后**降速**（不是静音）：之后最多每 N 秒叫醒一次。
 * 静音会让两个人在同一段里各说各的；降速只让画面慢下来。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QQWorld } from '../../../src/worlds/qq/world.ts';
import { MockOneBot } from '../../helpers/mock-onebot.ts';
import { FakeHost, waitUntil } from './helpers.ts';

const GROUP = 424242;
const SELF = 5000;
const HUMAN = 9701;
const SIBLING = 9702;

let mock: MockOneBot;
let world: QQWorld | null;
let host: FakeHost;
let port: number;

async function boot(extra: Record<string, unknown> = {}) {
  world = new QQWorld({
    wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP], privates: [], token: '',
    wakeOnMentionOnly: true, room: { enabled: false }, siblingIds: [SIBLING], ...extra,
  });
  await world.start(host);
  await world.waitReady();
}

beforeEach(async () => {
  mock = new MockOneBot({ groupId: GROUP, selfId: SELF });
  port = await mock.start();
  host = new FakeHost();
  await boot();
});

afterEach(async () => {
  if (world) await world.stop();
  world = null;
  await mock.close();
});

/** 时间基准：用显式 time 控制"隔了多久"，不依赖真实时钟。 */
const T0 = 1_800_000_000;

async function deliver(user: number, atSec: number) {
  const id = mock.emitGroupMessage({
    group_id: GROUP, user_id: user, time: atSec, segments: [
      { type: 'at', data: { qq: String(SELF) } },
      { type: 'text', data: { text: '这事你怎么看' } },
    ],
  });
  await waitUntil(() => host.pushed.some((p) => Number(p.event.meta?.message_id) === id), '消息入队');
  return host.pushed.find((p) => Number(p.event.meta?.message_id) === id)!;
}

const woke = (p: { opts?: { deliver?: boolean } }) => p.opts?.deliver !== false;

describe('同住 AI 可以吵，但会降速', () => {
  it('预算之内的互接照常叫醒', async () => {
    await world!.stop();
    world = null;
    await boot({ siblingWakeBudget: 2, siblingWakeThrottleSeconds: 90 });
    expect(woke(await deliver(SIBLING, T0))).toBe(true);
    expect(woke(await deliver(SIBLING, T0 + 1))).toBe(true);
  });

  it('超出预算后不是静音，是每 90 秒放一拍', async () => {
    await world!.stop();
    world = null;
    await boot({ siblingWakeBudget: 1, siblingWakeThrottleSeconds: 90 });
    expect(woke(await deliver(SIBLING, T0))).toBe(true);        // 预算内
    expect(woke(await deliver(SIBLING, T0 + 10))).toBe(false);  // 超出预算，太快
    expect(woke(await deliver(SIBLING, T0 + 200))).toBe(true);  // 隔够了，放行
    expect(woke(await deliver(SIBLING, T0 + 210))).toBe(false); // 又太快
  });

  it('真人插一句话就把预算重新给满', async () => {
    await world!.stop();
    world = null;
    await boot({ siblingWakeBudget: 1, siblingWakeThrottleSeconds: 900 });
    expect(woke(await deliver(SIBLING, T0))).toBe(true);
    expect(woke(await deliver(SIBLING, T0 + 10))).toBe(false);
    expect(woke(await deliver(HUMAN, T0 + 20))).toBe(true);
    expect(woke(await deliver(SIBLING, T0 + 30))).toBe(true);
  });

  it('降速也能关掉：预算用完后彻底不叫醒', async () => {
    await world!.stop();
    world = null;
    await boot({ siblingWakeBudget: 1, siblingWakeThrottleSeconds: 0 });
    expect(woke(await deliver(SIBLING, T0))).toBe(true);
    expect(woke(await deliver(SIBLING, T0 + 100))).toBe(false);
  });

  it('消息里叫的是同住的别人，就不叫醒我', async () => {
    await world!.stop();
    world = null;
    await boot({ wakeOnMentionOnly: false, siblingNames: ['白龙', 'bug龙'] });
    const named = mock.emitGroupMessage({
      group_id: GROUP, user_id: HUMAN, time: T0,
      segments: [{ type: 'text', data: { text: 'bug龙，睡了没' } }],
    });
    await waitUntil(() => host.pushed.some((p) => Number(p.event.meta?.message_id) === named), '消息入队');
    expect(woke(host.pushed.find((p) => Number(p.event.meta?.message_id) === named)!)).toBe(false);
  });

  it('没人被点名时照常叫醒——差异只来自 siblingNames', async () => {
    await world!.stop();
    world = null;
    await boot({ wakeOnMentionOnly: false, siblingNames: ['白龙', 'bug龙'] });
    const plain = mock.emitGroupMessage({
      group_id: GROUP, user_id: HUMAN, time: T0 + 1,
      segments: [{ type: 'text', data: { text: '今天群里挺安静的，都睡了吗' } }],
    });
    await waitUntil(() => host.pushed.some((p) => Number(p.event.meta?.message_id) === plain), '消息入队');
    expect(woke(host.pushed.find((p) => Number(p.event.meta?.message_id) === plain)!)).toBe(true);
  });
});
