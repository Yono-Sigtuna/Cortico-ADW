import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QQWorld } from '../../../src/worlds/qq/world.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { MockOneBot } from '../../helpers/mock-onebot.ts';
import { FakeHost } from './helpers.ts';

const GROUP = 424242;
const ctx = { role: 'main', log: nullLogger() };
let mock: MockOneBot;
let world: QQWorld;
let host: FakeHost;
let dir: string;
let port: number;
let blocked = '';
const follow_up = { action: '把茶端回来接着聊', person: '10001', kind: 'scene', after_minutes: 1 };
const textOf = (v: unknown) => typeof v === 'string' ? v : (v as { text: string }).text;
const call = async (name: string, args: Record<string, unknown>) => world.tools().find((t) => t.name === name)!.handler(args, ctx);
const list = async (): Promise<Array<{ id: string; status: string }>> => JSON.parse(textOf(await call('qq_continue', { decision: 'list' })));
async function start() {
  world = new QQWorld({ wsUrl: `ws://127.0.0.1:${port}`, groups: [GROUP], privates: [], token: '', dataDir: dir, apiTimeoutMs: 200, blacklist: () => blocked });
  await world.start(host); await world.waitReady();
}
function due() {
  (world as unknown as { deliverContinuations(): void }).deliverContinuations();
}
function advance(minutes: number) { vi.setSystemTime(Date.now() + minutes * 60_000); }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qq-action-loop-'));
  blocked = '';
  host = new FakeHost();
  mock = new MockOneBot({ port: 0, groupId: GROUP, selfId: 5000 });
  port = await mock.start();
  await start();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(async () => {
  vi.useRealTimers(); await world.stop(); await mock.close(); rmSync(dir, { recursive: true, force: true });
});

describe('短时行动的发送与接续', () => {
  it('发送契约要求显式选择；漏填不出站，也不留下可确认草稿', async () => {
    const draft = world.tools().find((t) => t.name === 'qq_draft')!;
    const result = textOf(await draft.handler({ to: `group:${GROUP}`, text: '我去烧水，你坐着等。' }, ctx));
    expect(result).toContain('[bad input]');
    expect(result).toContain('follow_up');
    expect(mock.received.filter((r) => r.action === 'send_group_msg')).toHaveLength(0);
    expect(mock.outbox).toHaveLength(0);
    expect(await list()).toEqual([]);
    expect(textOf(await call('qq_confirm', { decision: 'send' }))).toContain('no draft');
    expect(draft.parameters.required).toContain('follow_up');
  });
  it('显式 null 正常发送，不建立接续行动', async () => {
    const result = textOf(await call('qq_draft', { to: `group:${GROUP}`, text: '早，今天在读书。', follow_up: null }));
    expect(result).toContain('[sent #');
    expect(mock.outbox).toHaveLength(1);
    expect(await list()).toEqual([]);
  });
  it('非 null 的无效选择被拒，不能拿 false 或空对象跳过登记', async () => {
    for (const value of [false, '', {}, []]) {
      const result = textOf(await call('qq_draft', { to: `group:${GROUP}`, text: '无效参数', follow_up: value }));
      expect(result).toContain('[bad input]');
    }
    expect(mock.outbox).toHaveLength(0);
  });
  it('同一次发言登记，到点交付一次，真实发送后才结账', async () => {
    const receipt = textOf(await call('qq_draft', { to: `group:${GROUP}`, text: '我去泡一杯，等我一下。', follow_up }));
    expect(receipt).toContain('[sent #'); expect(receipt).toContain('[continuation scheduled]');
    const [task] = await list(); expect(task.status).toBe('waiting');
    advance(1); due(); due();
    expect(host.deferred.filter((d) => d.spec.type === 'qq.continuation')).toHaveLength(1);
    const event = host.deferred.find((d) => d.spec.type === 'qq.continuation')!;
    expect(String(await event.spec.render())).toContain('共同虚构场景');
    expect((await list())[0].status).toBe('ready');
    expect(textOf(await call('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '茶好了，先小口尝。', continuation_id: task.id }))).toContain('[sent #');
    expect(await list()).toEqual([]);
    expect(textOf(await call('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '重复发送', continuation_id: task.id }))).toContain('[bad input]');
  });
  it('被扣草稿不建行动；confirm 成功才激活', async () => {
    const out = await call('qq_draft', { to: `group:${GROUP}`, text: '（放下杯子）（拿起茶壶）等我一下。', follow_up });
    expect(textOf(out)).toContain('[draft held'); expect(await list()).toEqual([]);
    await call('qq_confirm', { decision: 'send' });
    expect((await list())[0].status).toBe('waiting');
  });
  it('明确拒绝不激活；重试成功只保留一项', async () => {
    mock.setActionHandler('send_group_msg', () => ({ retcode: 100, message: '拒绝' }));
    expect(textOf(await call('qq_draft', { to: `group:${GROUP}`, text: '我去拿杯子。', follow_up }))).toContain('[send failed]');
    expect((await list())[0].status).toBe('prepared');
    advance(2); due(); expect(host.deferred).toHaveLength(0);
    mock.setActionHandler('send_group_msg', () => ({ data: { message_id: 8888 } }));
    await call('qq_confirm', { decision: 'send' });
    expect(await list()).toHaveLength(1); expect((await list())[0].status).toBe('waiting');
  });
  it('重启恢复，取消后已排队的通知在投递时作废', async () => {
    await call('qq_draft', { to: `group:${GROUP}`, text: '稍等我泡杯茶。', follow_up });
    const [task] = await list();
    await world.stop(); await start();
    advance(1); due();
    const event = host.deferred.find((d) => d.spec.type === 'qq.continuation')!;
    await call('qq_continue', { decision: 'cancel', id: task.id });
    expect(await event.spec.render()).toBeNull();
    expect(await list()).toEqual([]);
  });
  it('延后不提前投递；真实任务明确提醒不能凭时间宣告完成', async () => {
    await call('qq_draft', { to: `group:${GROUP}`, text: '我查一下，回来告诉你。', follow_up: { ...follow_up, kind: 'task' } });
    const [task] = await list(); advance(1); due();
    await call('qq_continue', { decision: 'delay', id: task.id, after_minutes: 2 });
    expect(await host.deferred[0].spec.render()).toBeNull();
    advance(2); due();
    expect(String(await host.deferred.at(-1)!.spec.render())).toContain('不能编造完成');
  });
  it('暂停积压到过期、或等待者被拉黑，投递时不再唤醒', async () => {
    await call('qq_draft', { to: `group:${GROUP}`, text: '我去端茶。', follow_up });
    advance(1); due();
    advance(31);
    expect(await host.deferred[0].spec.render()).toBeNull();
    expect(await list()).toEqual([]);
    await call('qq_draft', { to: `group:${GROUP}`, text: '稍等我拿一本书。', follow_up });
    advance(1); due(); blocked = '10001';
    expect(await host.deferred.at(-1)!.spec.render()).toBeNull();
    expect(await list()).toEqual([]);
  });
  it('候选被取消后，confirm 不能再发出原先让人等待的话', async () => {
    mock.setActionHandler('send_group_msg', () => ({ retcode: 100, message: '拒绝' }));
    await call('qq_draft', { to: `group:${GROUP}`, text: '我去拿点茶叶。', follow_up });
    const [task] = await list();
    await call('qq_continue', { decision: 'cancel', id: task.id });
    const before = mock.received.filter((r) => r.action === 'send_group_msg').length;
    expect(textOf(await call('qq_confirm', { decision: 'send' }))).toContain('已取消');
    expect(mock.received.filter((r) => r.action === 'send_group_msg')).toHaveLength(before);
  });
  it('接续超时保持未知，不能换一次调用自动重发', async () => {
    await call('qq_draft', { to: `group:${GROUP}`, text: '我去拿茶匙。', follow_up });
    const [task] = await list();
    mock.setActionHandler('send_group_msg', () => null);
    expect(textOf(await call('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '茶匙拿到了。', continuation_id: task.id }))).toContain('结果未知');
    expect((await list())[0].status).toBe('uncertain');
    const before = mock.received.filter((r) => r.action === 'send_group_msg').length;
    expect(textOf(await call('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '茶匙拿到了。', continuation_id: task.id }))).toContain('[bad input]');
    expect(textOf(await call('qq_confirm', { decision: 'send' }))).toContain('[send uncertain]');
    expect(mock.received.filter((r) => r.action === 'send_group_msg')).toHaveLength(before);
  });
  it('已渲染但事件未落库时重启，能重新投递而不重发聊天', async () => {
    await call('qq_draft', { to: `group:${GROUP}`, text: '稍等我烧点水。', follow_up });
    advance(1); due();
    await host.deferred[0].spec.render();
    await world.stop();
    host.deferred.length = 0;
    await start();
    expect(host.deferred.filter((d) => d.spec.type === 'qq.continuation')).toHaveLength(1);
    expect(mock.outbox).toHaveLength(1);
  });
  it('接续发送明确失败可重试，未确认发送不算完成', async () => {
    await call('qq_draft', { to: `group:${GROUP}`, text: '我去拿茶杯。', follow_up });
    const [task] = await list();
    mock.setActionHandler('send_group_msg', () => ({ retcode: 100, message: '拒绝' }));
    expect(textOf(await call('qq_draft', { follow_up: null, to: `group:${GROUP}`, text: '杯子拿回来了。', continuation_id: task.id }))).toContain('[send failed]');
    expect((await list())[0].status).toBe('ready');
    mock.setActionHandler('send_group_msg', () => ({ data: { message_id: 8889 } }));
    await call('qq_confirm', { decision: 'send' }); expect(await list()).toEqual([]);
  });
});
