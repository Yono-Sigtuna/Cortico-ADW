/** 注意力显著性在世界里的落点：三档 → 投递/缓冲/归档，以及"为什么没注意"的记录。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QQWorld } from '../../../src/worlds/qq/world.ts';
import { MockOneBot } from '../../helpers/mock-onebot.ts';
import { FakeHost, waitUntil } from './helpers.ts';

const GROUP = 424242;
const SELF = 5000;

let mock: MockOneBot;
let mod: QQWorld;
let host: FakeHost;
let port: number;

beforeEach(async () => {
  mock = new MockOneBot({
    port: 0,
    groupId: GROUP,
    selfId: SELF,
    selfNickname: 'bot',
    selfCard: 'botcard',
    groupName: '深夜食堂',
  });
  port = await mock.start();
  host = new FakeHost();
  mod = new QQWorld({
    wsUrl: `ws://127.0.0.1:${port}`,
    groups: [GROUP],
    privates: [],
    token: '',
    wakeOnMentionOnly: true,
    wakeOnName: true,
    wakeNames: ['claude'],
    attention: { enabled: true, peripheryThreshold: 0.35, windowMinutes: 10, habituationMinutes: 30 },
  });
  await mod.start(host);
  await mod.waitReady();
});

afterEach(async () => {
  await mod.stop();
  await mock.close();
});

const messages = () => host.pushed.filter((p) => p.event.type === 'qq.message');

describe('注意力 · 世界', () => {
  it('定时背景不单独投递，明确点名时带上同群不同人的上下文', async () => {
    await mod.stop();
    mod = new QQWorld({
      wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP], privates: [], token: '',
      wakeOnMentionOnly: true, wakeOnName: true, wakeNames: ['claude'],
      ambientInterject: true, ambientIntervalMinutes: 0.002,
      attention: { enabled: true, peripheryThreshold: 0.35, windowMinutes: 10, habituationMinutes: 30 },
    });
    await mod.start(host);
    await mod.waitReady();
    mock.emitGroupMessage({ user_id: 3007, nickname: '甲', text: '我看完了那本科幻小说' });
    mock.emitGroupMessage({ user_id: 3008, nickname: '乙', text: '结尾确实很有意思' });
    await waitUntil(() => messages().length === 2, 'ambient-conversation');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(host.pushed.filter((item) => item.event.type === 'qq.ambient')).toHaveLength(0);
    mock.emitGroupMessage({ user_id: 3007, nickname: '甲', text: 'claude 你怎么看？' });
    await waitUntil(() => messages().length === 3, 'ambient-addressed');
    const ambient = host.pushed.filter((item) => item.event.type === 'qq.ambient').at(-1)!;
    expect(ambient.event.text).toContain('我看完了那本科幻小说');
    expect(ambient.event.text).toContain('结尾确实很有意思');
    expect(ambient.opts?.trigger).toBe('piggyback');
  });

  it('引用自己发出的消息时，即使没有线索也会投递', async () => {
    const draft = mod.tools().find((item) => item.name === 'qq_draft')!;
    await draft.handler({ follow_up: null, to: `group:${GROUP}`, text: '这是一条之前发出的消息。' }, { role: 'main', log: host.log });
    const sent = host.pushed.find((item) => item.event.type === 'qq.self')!;
    const id = sent.event.meta!.message_id;
    mock.emitGroupMessage({ user_id: 3001, nickname: '甲', segments: [
      { type: 'reply', data: { id: String(id) } },
      { type: 'text', data: { text: '刚才那句话是什么意思？' } },
    ] });
    await waitUntil(() => messages().length === 1, 'reply-to-self');
    expect(messages()[0]!.opts?.deliver).not.toBe(false);
  });

  it('重建索引后仍认得自己发出的消息', async () => {
    const draft = mod.tools().find((item) => item.name === 'qq_draft')!;
    await draft.handler({ follow_up: null, to: `group:${GROUP}`, text: '这是重启前发出的消息。' }, { role: 'main', log: host.log });
    const id = host.pushed.find((item) => item.event.type === 'qq.self')!.event.meta!.message_id;
    await mod.stop();
    mod = new QQWorld({
      wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP], privates: [], token: '',
      wakeOnMentionOnly: true, wakeOnName: true, wakeNames: ['claude'],
      attention: { enabled: true, peripheryThreshold: 0.35, windowMinutes: 10, habituationMinutes: 30 },
    });
    await mod.start(host);
    await mod.waitReady();
    mock.emitGroupMessage({ user_id: 3001, nickname: '甲', segments: [
      { type: 'reply', data: { id: String(id) } },
      { type: 'text', data: { text: '请解释刚才那句话。' } },
    ] });
    await waitUntil(() => messages().length === 1, 'reply-to-self-after-restart');
    expect(messages()[0]!.opts?.deliver).not.toBe(false);
  });

  it('发言人昵称包含唤醒名时，不把普通正文当成点名', async () => {
    mock.emitGroupMessage({ user_id: 3009, nickname: 'claude爱好者', text: '今天晚饭吃面条' });
    await waitUntil(() => messages().length === 1, 'name-in-sender');
    expect(messages()[0]!.opts?.deliver).toBe(false);
    expect(messages()[0]!.event.meta?.wake).toBeUndefined();
  });

  it('正文含冒号时保留完整正文', async () => {
    mock.emitGroupMessage({ user_id: 3010, nickname: '乙', text: '这个报错为什么: 最后一行是空的' });
    await waitUntil(() => messages().length === 1, 'colon-in-body');
    expect(messages()[0]!.event.meta?.body).toBe('这个报错为什么: 最后一行是空的');
  });

  it('群名含唤醒名不触发点名，正文明确叫她仍然生效', async () => {
    await mod.stop();
    await mock.close();
    mock = new MockOneBot({ port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: 'claude 交流群: 日常' });
    port = await mock.start();
    mod = new QQWorld({
      wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP], privates: [], token: '',
      wakeOnMentionOnly: true, wakeOnName: true, wakeNames: ['claude'],
      attention: { enabled: true, peripheryThreshold: 0.35, windowMinutes: 10, habituationMinutes: 30 },
    });
    await mod.start(host);
    await mod.waitReady();
    mock.emitGroupMessage({ user_id: 3101, nickname: '甲', text: '今天晚饭吃面条' });
    await waitUntil(() => messages().length === 1, 'group-name-only');
    expect(messages()[0].event.text).toContain('claude 交流群');
    expect(messages()[0].event.meta?.wake).toBeUndefined();
    expect(messages()[0].opts?.deliver).toBe(false);
    mock.emitGroupMessage({ user_id: 3102, nickname: '乙', text: 'claude 在吗？' });
    await waitUntil(() => messages().length === 2, 'explicit-name');
    expect(messages()[1].event.meta?.wake).toBe('name');
    expect(messages()[1].opts?.deliver).not.toBe(false);
  });

  it('@他人的显示名含唤醒名不算叫她，@自己仍立即投递', async () => {
    mock.emitGroupMessage({ user_id: 3111, nickname: 'claude爱好者', text: '今天晚饭吃面条' });
    await waitUntil(() => messages().length === 1, 'learn-other-display-name');
    mock.emitGroupMessage({ user_id: 3112, nickname: '甲', segments: [
      { type: 'at', data: { qq: '3111' } },
      { type: 'text', data: { text: '今天晚饭吃面条' } },
    ] });
    await waitUntil(() => messages().length === 2, 'mention-other-name');
    expect(messages()[1].event.text).toContain('@claude爱好者');
    expect(messages()[1].event.meta?.wake).toBeUndefined();
    expect(messages()[1].opts?.deliver).toBe(false);
    mock.emitGroupMessage({ user_id: 3113, nickname: '乙', segments: [
      { type: 'at', data: { qq: String(SELF) } },
      { type: 'text', data: { text: ' 现在能看到吗？' } },
    ] });
    await waitUntil(() => messages().length === 3, 'mention-self-control');
    expect(messages()[2].event.meta?.wake).toBe('mention');
    expect(messages()[2].opts?.deliver).not.toBe(false);
  });

  it.each([
    'claude 为什么会这样: Error: detail: 最后一行是空的',
    'claude 地址是 https://service.invalid/a:b?value=x:y ，报错原因: 原始正文要保留',
    'claude 第一行: 原因\n第二行：补充说明: 最后的问题仍在这里？',
  ])('多冒号或 URL 的正文完整保留：%s', async (body) => {
    mock.emitGroupMessage({ user_id: 3121, nickname: '甲: 日常: claude爱好者', text: body });
    await waitUntil(() => messages().length === 1, 'structured-body');
    expect(messages()[0].event.meta?.body).toBe(body);
    expect(messages()[0].event.meta?.wake).toBe('name');
  });

  it('引用别人的消息时，冒号后的正文仍完整，不因昵称或引用误判为引用自己', async () => {
    const id = mock.emitGroupMessage({ user_id: 3131, nickname: 'claude爱好者', text: '今天晚饭吃面条' });
    await waitUntil(() => messages().length === 1, 'quoted-other-message');
    const body = '为什么这样: 原因: 后面还有一个问题？';
    mock.emitGroupMessage({ user_id: 3132, nickname: '甲: 乙', segments: [
      { type: 'reply', data: { id: String(id) } },
      { type: 'text', data: { text: body } },
    ] });
    await waitUntil(() => messages().length === 2, 'reply-body');
    expect(String(messages()[1].event.meta?.body)).toContain(body);
    expect(messages()[1].event.meta?.wake).not.toBe('mention');
    expect(messages()[1].event.meta?.wake).not.toBe('name');
  });

  it('归档的转发展开后仍不单独投递', async () => {
    mock.setMockForward('ambient-forward', [
      { sender: { nickname: '乙', user_id: 3008 }, content: [{ type: 'text', data: { text: '这是转发内容' } }] },
    ]);
    mock.emitGroupMessage({ user_id: 3007, nickname: '甲', segments: [
      { type: 'forward', data: { id: 'ambient-forward' } },
    ] });
    await waitUntil(() => host.pushed.some((item) => item.event.type === 'qq.forward'), 'ambient-forward');
    expect(messages()[0]!.opts?.deliver).toBe(false);
    expect(host.pushed.find((item) => item.event.type === 'qq.forward')!.opts?.deliver).toBe(false);
    mock.emitGroupMessage({ user_id: 3007, nickname: '甲', text: 'claude 你怎么看这段？' });
    await waitUntil(() => messages().length === 2, 'forward-followup');
    const ambient = host.pushed.filter((item) => item.event.type === 'qq.ambient').at(-1)!;
    expect(ambient.event.text).toContain('这是转发内容');
  });

  it('普通群消息只归档，不投递，并留下"为什么没注意"', async () => {
    mock.emitGroupMessage({ user_id: 3001, nickname: '甲', text: '今天天气不错' });
    await waitUntil(() => messages().length === 1, 'q1');
    const rec = messages()[0]!;
    expect(rec.opts?.deliver).toBe(false);
    expect(rec.event.meta?.attention).toMatchObject({ tier: 'background' });
    const log = mod.attentionLog();
    expect(log[0]).toMatchObject({ tier: 'background', senderName: '甲', convKey: `group:${GROUP}` });
    expect(log[0]!.reasons.join('')).toContain('只归档');
  });

  it('线索开着也不等于每句都叫醒：纯附和归档，真问题才醒', async () => {
    // 先叫一声，开出一条线索。
    mock.emitGroupMessage({ user_id: 3003, nickname: '丙', text: 'claude 在吗' });
    await waitUntil(() => messages().length === 1, 'q-wake');
    expect(messages()[0]!.opts?.deliver).not.toBe(false);

    // 线索开着，但只是一句笑：不值得跑一轮模型。
    mock.emitGroupMessage({ user_id: 3003, nickname: '丙', text: '哈哈哈哈' });
    await waitUntil(() => messages().length === 2, 'q-filler');
    expect(messages()[1]!.opts?.deliver).toBe(false);
    expect(messages()[1]!.event.meta?.attention).toMatchObject({ tier: 'background' });

    // 同一线索上的真问题照常叫醒。
    mock.emitGroupMessage({ user_id: 3003, nickname: '丙', text: '刚才你说的那个报错要怎么改？' });
    await waitUntil(() => messages().length === 3, 'q-real');
    expect(messages()[2]!.opts?.deliver).not.toBe(false);
    expect(messages()[2]!.event.meta?.wake).toBe('thread');

    // 群里正吵、这句是丙在接路人的话——有内容也不为它醒。
    // 线索只说明"他再开口你能听见"，不说明"他说的每句都是给你的"。
    // （显著性分数会被"群里 15 条正吵、负荷高"压到 background，不能拿它当判据；
    //   这里判的是形状：上一条换了人，而且最近三条里没有她。）
    for (let i = 0; i < 12; i++) {
      mock.emitGroupMessage({ user_id: 3100 + i, nickname: `路人${i}`, text: `刷屏第 ${i} 句` });
    }
    await waitUntil(() => messages().length >= 15, 'q-busy');
    const before = messages().length;
    mock.emitGroupMessage({ user_id: 3003, nickname: '丙', text: '你才是大肥鱼！' });
    await waitUntil(() => messages().length === before + 1, 'q-substantive');
    expect(messages().at(-1)!.opts?.deliver).toBe(false);
  });

  it('纯附和与纯表情即便不能叫醒', async () => {
    mock.emitGroupMessage({ user_id: 3004, nickname: '丁', text: 'claude 在吗' });
    await waitUntil(() => messages().length === 1, 'filler-wake');

    mock.emitGroupMessage({ user_id: 3004, nickname: '丁', text: '[表情:大怨种]' });
    await waitUntil(() => messages().length === 2, 'filler-sticker');
    expect(messages()[1]!.opts?.deliver).toBe(false);

    mock.emitGroupMessage({ user_id: 3004, nickname: '丁', text: '嗯嗯' });
    await waitUntil(() => messages().length === 3, 'filler-ack');
    expect(messages()[2]!.opts?.deliver).toBe(false);
  });

  it('第一次开口的提问进缓冲；被叫到时搭车带出', async () => {
    mock.emitGroupMessage({ user_id: 3002, nickname: '乙', text: '这个报错怎么修？' });
    await waitUntil(() => messages().length === 1, 'q-first');
    expect(messages()[0]!.opts?.deliver).toBe(false);
    expect(messages()[0]!.event.meta?.attention).toMatchObject({ tier: 'periphery' });

    mock.emitGroupMessage({ user_id: 3002, nickname: '乙', text: 'claude 在吗' });
    await waitUntil(
      () => messages().length === 2 && host.pushed.some((p) => p.event.type === 'qq.ambient'),
      'wake-with-ambient',
    );
    const wake = messages()[1]!;
    expect(wake.opts?.deliver).not.toBe(false);
    expect(wake.event.meta?.attention).toMatchObject({ tier: 'focus' });
    const ambient = host.pushed.find((p) => p.event.type === 'qq.ambient')!;
    expect(ambient.event.text).toContain('这个报错怎么修');
  });

  it('同一句提问复读到第二遍就降成背景', async () => {
    mock.emitGroupMessage({ user_id: 3003, nickname: '丙', text: '这个怎么办' });
    await waitUntil(() => messages().length === 1, 'q-once');
    expect(messages()[0]!.event.meta?.attention).toMatchObject({ tier: 'periphery' });

    mock.emitGroupMessage({ user_id: 3003, nickname: '丙', text: '这个怎么办' });
    await waitUntil(() => messages().length === 2, 'q-twice');
    expect(messages()[1]!.event.meta?.attention).toMatchObject({ tier: 'background' });
    const log = mod.attentionLog();
    expect(log[0]!.reasons.join('')).toContain('同一句话已经出现 1 次');
  });

  it('记录新的在前，且带分数与理由', async () => {
    mock.emitGroupMessage({ user_id: 3004, nickname: '丁', text: '今天好热' });
    await waitUntil(() => messages().length === 1, 'r1');
    mock.emitGroupMessage({ user_id: 3005, nickname: '戊', text: '有人知道怎么配吗' });
    await waitUntil(() => messages().length === 2, 'r2');
    const log = mod.attentionLog();
    expect(log[0]!.senderName).toBe('戊');
    expect(log[1]!.senderName).toBe('丁');
    expect(typeof log[0]!.score).toBe('number');
    expect(mod.attentionSettings()).toMatchObject({ enabled: true, peripheryThreshold: 0.35 });
  });

  it('被判成"他们在聊"的那句也进背景：她照样不插嘴，但下次醒来能看见', async () => {
    // 先跟戊开出一条线索。
    mock.emitGroupMessage({ user_id: 3007, nickname: '戊', text: 'claude 在吗' });
    await waitUntil(() => messages().length === 1, 'p-wake');

    // 己插一句，戊再接一句——上一条换了人、她没在这三条里，判成"两个人自顾自聊"。
    // 这句从她的世界里消失是不对的：不叫醒和不知情是两件事。
    mock.emitGroupMessage({ user_id: 3008, nickname: '己', text: '在读外语文学' });
    await waitUntil(() => messages().length === 2, 'p-other');
    mock.emitGroupMessage({ user_id: 3007, nickname: '戊', text: '这外语正经嘛' });
    await waitUntil(() => messages().length === 3, 'p-sidelined');
    expect(messages()[2]!.opts?.deliver).toBe(false);

    // 戊下次真正找她时，那句「这外语正经嘛」搭车带出来。
    mock.emitGroupMessage({ user_id: 3007, nickname: '戊', text: 'claude 你也来说说' });
    await waitUntil(
      () => messages().length === 4 && host.pushed.some((p) => p.event.type === 'qq.ambient'),
      'p-catchup',
    );
    const ambient = host.pushed.filter((p) => p.event.type === 'qq.ambient').at(-1)!;
    expect(ambient.event.text).toContain('这外语正经嘛');
  });
});
