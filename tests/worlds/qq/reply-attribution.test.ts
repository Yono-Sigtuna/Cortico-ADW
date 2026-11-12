import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nullLogger } from '../../../src/core/util.ts';
import { QQWorld } from '../../../src/worlds/qq/world.ts';
import { MockOneBot } from '../../helpers/mock-onebot.ts';
import { FakeHost, waitUntil } from './helpers.ts';

const GROUP = 424242;
const OTHER = GROUP + 1;
const SELF = 5000;
const A = 9701;
const B = 9702;
const ctx = { role: 'main' as const, log: nullLogger() };
let mock: MockOneBot;
let world: QQWorld;
let host: FakeHost;
let now: number;
let clock: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  now = Date.now();
  clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  mock = new MockOneBot({ groupId: GROUP, selfId: SELF });
  const port = await mock.start();
  host = new FakeHost();
  world = new QQWorld({
    wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP, OTHER], privates: [A], token: '',
    wakeOnMentionOnly: true, threadHotMinutes: 1, room: { enabled: false },
  });
  await world.start(host);
  await world.waitReady();
});

afterEach(async () => {
  await world.stop();
  await mock.close();
  clock.mockRestore();
});

async function receive(user: number, options: { mention?: boolean; delivered?: boolean; group?: number } = {}) {
  const id = mock.emitGroupMessage({ group_id: options.group ?? GROUP, user_id: user, segments: [
    ...(options.mention ? [{ type: 'at', data: { qq: String(SELF) } }] : []),
    { type: 'text', data: { text: '我把画册放在桌子上了。' } },
  ] });
  await waitUntil(() => host.pushed.some(p => Number(p.event.meta?.message_id) === id), '消息归档');
  const pushed = host.pushed.find(p => Number(p.event.meta?.message_id) === id)!;
  if (options.delivered !== false && pushed.opts?.deliver !== false) {
    world.onEventsSettled([pushed.event], 'delivered');
  }
  return { ...pushed, id };
}

async function send(extra: Record<string, unknown> = {}) {
  const result = await world.tools().find(t => t.name === 'qq_draft')!.handler({
    follow_up: null, to: `group:${GROUP}`, text: '画册那一页我看到了。', ...extra,
  }, ctx);
  return typeof result === 'string' ? result : result.text;
}

async function coldThreads() {
  await receive(A, { mention: true });
  await receive(B, { mention: true });
  now += 120_000;
}

async function expectOnlyAWarm() {
  expect((await receive(A)).opts?.deliver).not.toBe(false);
  expect((await receive(B)).opts?.deliver).toBe(false);
}

describe('发送的回复对象与线索热度', () => {
  it('引用甲而乙最后入站，只刷新甲的冷线索', async () => {
    await coldThreads();
    const a = await receive(A, { mention: true });
    await receive(B, { mention: true });
    expect(String(await send({ reply_to: String(a.id) }))).toContain('[sent');
    await expectOnlyAWarm();
  });

  it('无引用时仅使用已投递对象，不使用之后只归档的乙', async () => {
    await coldThreads();
    await receive(A, { mention: true });
    expect((await receive(B)).opts?.deliver).toBe(false);
    expect(String(await send())).toContain('[sent');
    await expectOnlyAWarm();
  });

  it('发送等待回执期间乙被投递，不改变已开始发送的归属', async () => {
    await coldThreads();
    await receive(A, { mention: true });
    let release!: (reply: { data: { message_id: number } }) => void;
    mock.setActionHandler('send_group_msg', () => new Promise(resolve => { release = resolve; }));
    const pending = send();
    await waitUntil(() => Boolean(release), '发送请求到达协议端');
    try {
      await receive(B, { mention: true });
    } finally {
      release({ data: { message_id: 80001 } });
    }
    expect(String(await pending)).toContain('[sent');
    await expectOnlyAWarm();
  });

  it('同一草稿的第二拍继续归属引用对象，不被间隔中的乙带走', async () => {
    await coldThreads();
    const a = await receive(A, { mention: true });
    const pending = send({ reply_to: String(a.id), more: '这幅画的颜色我也很喜欢。' });
    await waitUntil(() => host.pushed.some(p => p.event.type === 'qq.self'), '第一拍已确认');
    await receive(B, { mention: true });
    expect(String(await pending)).toContain('[sent');
    expect(mock.outbox).toHaveLength(2);
    await expectOnlyAWarm();
  });

  it('明确发送失败不刷新引用对象或最后入站者', async () => {
    await coldThreads();
    const a = await receive(A, { mention: true });
    await receive(B, { mention: true });
    mock.setActionHandler('send_group_msg', () => ({ retcode: 100, message: 'rejected' }));
    expect(String(await send({ reply_to: String(a.id) }))).toContain('[send failed');
    expect((await receive(A)).opts?.deliver).toBe(false);
    expect((await receive(B)).opts?.deliver).toBe(false);
  });

  it.each(['unknown', 'other-conversation'])('无效引用 %s 不发送也不刷新线索', async kind => {
    await coldThreads();
    await receive(A, { mention: true });
    await receive(B, { mention: true });
    const id = kind === 'unknown' ? 999999 : (await receive(A, { mention: true, group: OTHER })).id;
    expect(String(await send({ reply_to: String(id) }))).toContain('[send failed');
    expect(mock.outbox).toHaveLength(0);
    expect((await receive(A)).opts?.deliver).toBe(false);
    expect((await receive(B)).opts?.deliver).toBe(false);
  });

  it('私聊发出消息直接建立该目标的线索', async () => {
    expect(String(await send({ to: `private:${A}` }))).toContain('[sent');
    expect(world.threadSnapshot().some(t => t.conv === `private:${A}` && t.person === String(A))).toBe(true);
  });
});
