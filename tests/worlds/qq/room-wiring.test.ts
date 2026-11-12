/**
 * 群聊形状接进事件流：消息进来会记账、事件带 meta.room、投递时多出一行「群里此刻」。
 * 纯函数的数字在 room.test.ts；这里验的是接线。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockOneBot } from '../../helpers/mock-onebot.ts';
import { QQWorld } from '../../../src/worlds/qq/world.ts';
import { FakeHost, waitUntil } from './helpers.ts';

const GROUP = 424243;
const SELF = 5001;

let mock: MockOneBot;
let mod: QQWorld;
let host: FakeHost;

beforeEach(async () => {
  mock = new MockOneBot({
    port: 0,
    groupId: GROUP,
    selfId: SELF,
    selfNickname: 'bot',
    selfCard: 'botcard',
    groupName: '测试群',
  });
  const port = await mock.start();
  host = new FakeHost();
  mod = new QQWorld({
    wsUrl: `ws://127.0.0.1:${port}`,
    groups: [GROUP],
    privates: [],
    token: '',
    // 本文件只验形状，判决的档位另有测试；注意力开着才能走到打分那一层。
    wakeOnName: true,
    wakeNames: ['claude'],
    attention: { enabled: true },
  });
  await mod.start(host);
  await mod.waitReady();
});

afterEach(async () => {
  await mod.stop();
  await mock.close();
});

const messages = () => host.store.events.filter((e) => e.type === 'qq.message');
const roomSpecs = () => host.deferred.filter((d) => d.spec.type === 'qq.room');

describe('群聊形状接线', () => {
  it('三条消息之后：形状进 meta，投递时一行事实，重复渲染不再说一遍', async () => {
    const first = mock.emitGroupMessage({ user_id: 9001, nickname: '甲', text: '今天好热' });
    mock.emitGroupMessage({
      user_id: 9002,
      nickname: '乙',
      segments: [
        { type: 'reply', data: { id: String(first) } },
        { type: 'text', data: { text: '是啊，开空调' } },
      ],
    });
    mock.emitGroupMessage({ user_id: 9001, nickname: '甲', text: 'claude 你觉得呢' });

    await waitUntil(() => messages().length >= 3 && roomSpecs().length > 0);

    const last = messages()[messages().length - 1]!;
    const room = last.meta?.room as Record<string, unknown> | undefined;
    expect(room).toBeTruthy();
    expect(room!.messages).toBe(3);
    expect(room!.speakers).toBe(2);
    expect(room!.toSelf).toBe(1);

    const spec = roomSpecs()[0]!.spec as { render: () => string | null };
    const line = spec.render();
    expect(line).toContain('[群里此刻]');
    expect(line).toContain('3 条，2 人在说');
    expect(line).toContain('1 条在接别人的话');
    // 数字没变就不再说一遍——每轮重复同一句只是白付 token。
    expect(spec.render()).toBeNull();
  });

  it('自己给自己记的群判断会出现在那一行里，过期后自己消失', async () => {
    mock.emitGroupMessage({ user_id: 9001, nickname: '甲', text: 'claude 在吗' });
    await waitUntil(() => roomSpecs().length > 0);

    mod.markRoom(`group:${GROUP}`, '在玩梗', '拿昨天的截图互相甩', 90);
    const spec = roomSpecs().at(-1)!.spec as { render: () => string | null };
    const line = spec.render();
    expect(line).toContain('你的判断：在玩梗——拿昨天的截图互相甩');

    // 判断换了就不该被去重压掉：mark 时清掉上一行。
    mod.markRoom(`group:${GROUP}`, '有人在较真', '', 90);
    const again = (roomSpecs().at(-1)!.spec as { render: () => string | null }).render();
    expect(again).toContain('你的判断：有人在较真');

    expect(mod.roomNoteFor(`group:${GROUP}`, Date.now() + 91 * 60_000)).toBeNull();
  });

  it('roomFacts 现算：静下来的会变成"只有几条"', async () => {
    mock.emitGroupMessage({ user_id: 9001, nickname: '甲', text: 'claude 一句话' });
    await waitUntil(() => messages().length >= 1);
    const facts = mod.roomFacts(`group:${GROUP}`);
    expect(facts.messages).toBe(1);
    expect(facts.speakers).toBe(1);
  });

  it('刚起进程、窗口还空着：不把"没有上一条"当成静了很久', async () => {
    // 注意力关着才是 focus → 不写 attention 理由；这里要看的是判决理由里不许出现 "静了 Infinity"。
    mock.emitGroupMessage({ user_id: 9001, nickname: '甲', text: '第一句话' });
    await waitUntil(() => messages().length >= 1);
    const reasons = (messages()[0]!.meta?.attention as { reasons?: string[] } | undefined)?.reasons ?? [];
    expect(reasons.join('；')).not.toContain('静了');
    expect(reasons.join('；')).not.toContain('Infinity');
  });
});
