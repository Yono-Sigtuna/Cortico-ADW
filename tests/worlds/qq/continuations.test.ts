import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QQContinuations } from '../../../src/worlds/qq/continuations.ts';

const dirs: string[] = [];
function make() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-continuations-'));
  dirs.push(dir);
  return { dir, store: new QQContinuations(dir) };
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const spec = { action: '泡好茶后接着聊', person: '10001', kind: 'scene' as const, after_minutes: 1 };

describe('QQ 短时接续', () => {
  it('未确认发送不唤醒；发送确认后按原会话到期', () => {
    const { store } = make();
    const task = store.prepare('group:1', '我去泡茶，等我一下', spec, 1000);
    expect(store.due(100000)).toEqual([]);
    store.activate(task.id, 2000);
    expect(store.due(61999)).toEqual([]);
    expect(store.due(62000).map((t) => t.id)).toEqual([task.id]);
    expect(store.get(task.id)?.conv).toBe('group:1');
  });
  it('重启恢复等待任务，已通知任务不会重复唤醒', () => {
    const { store, dir } = make();
    const task = store.prepare('group:1', '稍等', spec, 1000);
    store.activate(task.id, 1000);
    const resumed = new QQContinuations(dir);
    expect(resumed.due(61000)).toHaveLength(1);
    resumed.markReady(task.id);
    expect(new QQContinuations(dir).due(61000)).toEqual([]);
    expect(new QQContinuations(dir).list()).toHaveLength(1);
  });
  it('取消与延后按 ID 寻址，不影响另一人或会话', () => {
    const { store } = make();
    const a = store.prepare('group:1', '稍等', spec, 1000);
    const b = store.prepare('group:2', '稍等', { ...spec, person: '20002' }, 1000);
    store.activate(a.id, 1000); store.activate(b.id, 1000);
    store.delay(a.id, 2, 2000);
    expect(store.due(61000).map((t) => t.id)).toEqual([b.id]);
    store.finish(b.id, 'cancelled');
    expect(store.due(61000)).toEqual([]);
    expect(store.due(122000).map((t) => t.id)).toEqual([a.id]);
  });
  it('逾期不补演完成；结果未知保持未结，不重复唤醒', () => {
    const { store } = make();
    const a = store.prepare('group:1', '稍等', spec, 1000);
    store.activate(a.id, 1000);
    expect(store.due(61_000 + 30 * 60_000 + 1)).toEqual([]);
    expect(store.get(a.id)?.status).toBe('expired');
    const b = store.prepare('group:1', '稍等', spec, 1000);
    store.activate(b.id, 1000); store.uncertain(b.id);
    expect(store.due(62000)).toEqual([]);
    expect(store.get(b.id)?.status).toBe('uncertain');
  });
  it('真实任务到点仅提醒查看结果，不标记完成', () => {
    const { store } = make();
    const task = store.prepare('private:10001', '我查一下', { ...spec, kind: 'task' }, 1000);
    store.activate(task.id, 1000);
    expect(store.due(61000)[0].kind).toBe('task');
    store.markReady(task.id);
    expect(store.get(task.id)?.status).toBe('ready');
  });
});
