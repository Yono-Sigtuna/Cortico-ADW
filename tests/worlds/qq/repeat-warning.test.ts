/** 草稿的重复提醒：同一会话里刚发过很接近的话，回执里点出来。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nullLogger } from '../../../src/core/util.ts';
import type { ToolCallContext, ToolDef } from '../../../src/core/types.ts';
import { QQWorld } from '../../../src/worlds/qq/world.ts';
import { MockOneBot } from '../../helpers/mock-onebot.ts';
import { FakeHost } from './helpers.ts';

const GROUP = 424244;
const SELF = 5012;
const ctx = { role: 'main', log: nullLogger() } as unknown as ToolCallContext;

let mock: MockOneBot;
let mod: QQWorld;
let host: FakeHost;
let port: number;

beforeEach(async () => {
  mock = new MockOneBot({
    port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: '群',
  });
  port = await mock.start();
  host = new FakeHost();
  mod = new QQWorld({ wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP], privates: [], token: '' });
  await mod.start(host);
  await mod.waitReady();
});

afterEach(async () => {
  await mod.stop();
  await mock.close();
});

const tool = (name: string): ToolDef => {
  const found = mod.tools().find((item) => item.name === name);
  if (!found) throw new Error(`缺少工具 ${name}`);
  return found;
};

const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const out = await tool(name).handler(args, ctx);
  return typeof out === 'string' ? out : String((out as { text?: unknown }).text ?? '');
};

describe('草稿 · 重复提醒', () => {
  it('最近几句里说过很接近的话，草稿回执会提醒；不一样的话不提醒', async () => {
    const first = '在收拾记录，把自己昨天答错的地方又核了一遍';
    expect(await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: first })).not.toContain('repeat warning');

    const second = '我去泡杯茶，你等会儿';
    expect(await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: second })).not.toContain('repeat warning');

    // 隔了一句再复读第一句：历史里最近五句都要参与比较。
    const nearRepeat = await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: `${first}。越翻越没面子` });
    expect(nearRepeat).toContain('repeat warning');
    expect(nearRepeat).toContain('别原样再说一遍');

    const fresh = await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '刚看完一页书，眼睛有点酸' });
    expect(fresh).not.toContain('repeat warning');
  });

  it('宣布不接也算开口：第二次拒绝时提醒「沉默就是回答」', async () => {
    const first = await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '具体的真事不评，编个假的我陪你拆。' });
    expect(first).toContain('[silence hint]');
    // 第一次：提醒她「要划界线就明说」，不是催她别发。
    expect(first).toContain('真要划界线就明说');
    expect(await run('qq_confirm', { decision: 'send' })).toContain('sent');

    // 第二遍换个说法还是在宣布不接：直接告诉她可以不回。
    const second = await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '对，这类我都不评。' });
    expect(second).toContain('[silence hint]');
    expect(second).toContain('不回复就是回答');
    expect(second).toContain('end_turn');

    // 不是拒绝的正常回复不该有这条提示。
    const normal = await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '那题我先拆主办方，再说跑者。' });
    expect(normal).not.toContain('[silence hint]');
  });

  it('动作密度：一条最多一处；最近五条里两条带动作后，第三条提示纯文字', async () => {
    const two = await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '(把书合上)(抬头)嗯？' });
    expect(two).toContain('[gesture]');
    expect(two).toContain('最多 1 处');
    await run('qq_confirm', { decision: 'cancel' });

    const a = await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '（翻身）……再睡五分钟' });
    expect(a).not.toContain('[gesture]');
    expect(a).toContain('sent'); // 干净的一版直接发,不再走确认

    const b = await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '（揉眼睛）几点了' });
    expect(b).not.toContain('[gesture]');
    expect(b).toContain('sent');

    const c = await run('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '（打哈欠）这就起' });
    expect(c).toContain('[gesture]');
    expect(c).toContain('纯文字');
  });
});

describe('动作密度按部署可配', () => {
  /** 换一份放开限制的实例：同一条两处动作的消息，默认会被退回，放开后直接发。 */
  const permissive = async (gesture: { maxPerMessage: number; maxRecent: number; windowSize: number }, refusalHint: boolean): Promise<QQWorld> => {
    await mod.stop();
    const relaxed = new QQWorld({
      wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP], privates: [], token: '',
      gesture, refusalHint,
    });
    await relaxed.start(host);
    await relaxed.waitReady();
    return relaxed;
  };

  const draft = async (world: QQWorld, text: string): Promise<string> => {
    const found = world.tools().find((item) => item.name === 'qq_draft');
    if (!found) throw new Error('缺少工具 qq_draft');
    const out = await found.handler({ follow_up: null, to: `group:${GROUP}`, text }, ctx);
    return typeof out === 'string' ? out : String((out as { text?: unknown }).text ?? '');
  };

  it('把上限设成 0 之后，一条里的多处动作不再被退回', async () => {
    const relaxed = await permissive({ maxPerMessage: 0, maxRecent: 0, windowSize: 5 }, true);
    try {
      const out = await draft(relaxed, '(把书合上)(抬头)嗯？');
      expect(out).not.toContain('[gesture]');
      expect(out).toContain('sent');
    } finally { await relaxed.stop(); }
  });

  it('关掉 refusalHint 后，「不接」这类台词不再被当成拒绝', async () => {
    const relaxed = await permissive({ maxPerMessage: 1, maxRecent: 2, windowSize: 5 }, false);
    try {
      const out = await draft(relaxed, '这事我不接，别问了。');
      expect(out).not.toContain('[silence hint]');
    } finally { await relaxed.stop(); }
  });
});
