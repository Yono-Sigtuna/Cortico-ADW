/** 内感受：事件驱动的社交电量与负荷——扣分、复读、回落、持久化与状态块。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope } from '../../src/core/types.ts';
import { InteroStore, interoLine, normalizeRepeat, replyBudget, replyBudgetLine } from '../../bots/amber/persona/companion/intero.ts';
import { RoleStateStore } from '../../bots/amber/persona/companion/roleState.ts';
import { makeTmpDir } from '../core/helpers.ts';

const T = Date.parse('2026-10-26T06:00:00Z');
const MIN = 60_000;

const event = (patch: Partial<EventEnvelope> = {}): EventEnvelope => ({
  cursor: 1,
  type: 'qq.message',
  ts: new Date(T).toISOString(),
  source: 'qq',
  origin: 'external',
  text: '#1 [群「g」 14:00] 甲(3001): 在吗',
  senderKey: '3001',
  ...patch,
});

describe('内感受 · 扣分与回落', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let now = T;
  let store: InteroStore;

  beforeEach(() => {
    tmp = makeTmpDir();
    now = T;
    store = new InteroStore(tmp.dir, () => now);
  });
  afterEach(() => tmp.cleanup());

  it('初始电量与负荷', () => {
    expect(store.values()).toEqual({ socialBattery: 0.75, load: 0.2 });
  });

  it('一条群消息：掉电、升负荷；其它事件不算', () => {
    store.observe([event()]);
    const after = store.values();
    // 没被叫到的群消息只掉一点：群里热闹不等于有人来找她。
    expect(after.socialBattery).toBeCloseTo(0.748, 3);
    expect(after.load).toBeCloseTo(0.206, 3);

    store.observe([
      event({ type: 'qq.ambient', origin: 'external', senderKey: undefined }),
      event({ type: 'qq.message', origin: 'internal' }),
      event({ type: 'qq.image', senderKey: '3001' }),
    ]);
    expect(store.values().socialBattery).toBeCloseTo(after.socialBattery, 3);
  });

  it('复读掉得更多：同一句第二、三次扣 0.05 起', () => {
    const text = '#1 [群「g」 14:00] 甲(3001): 在吗';
    store.observe([event({ text })]);
    const one = store.values().socialBattery;
    store.observe([event({ text })]);
    const two = store.values().socialBattery;
    store.observe([event({ text })]);
    const three = store.values().socialBattery;
    expect(one - two).toBeGreaterThan(0.05);
    expect(two - three).toBeGreaterThan(0.05);
  });

  it('耗电看是不是冲她来的：被点名 > 线索续上 > 群里普通一句', () => {
    const start = store.values().socialBattery;
    store.observe([event({ cursor: 2, senderKey: '3101' })]);
    const ambient = store.values().socialBattery;
    store.observe([event({ cursor: 3, senderKey: '3102', meta: { wake: 'thread' } })]);
    const thread = store.values().socialBattery;
    store.observe([event({ cursor: 4, senderKey: '3103', meta: { wake: 'mention' } })]);
    const named = store.values().socialBattery;
    expect(start - ambient).toBeLessThan(0.005);
    expect(ambient - thread).toBeGreaterThan(0.005);
    expect(thread - named).toBeGreaterThan(ambient - thread);
  });

  it('复读窗口之外不再加罚', () => {    const text = '#1 [群「g」 14:00] 甲(3001): 在吗';
    store.observe([event({ text })]);
    const one = store.values().socialBattery;
    now += 11 * MIN;
    store.observe([event({ text })]);
    const two = store.values().socialBattery;
    // 11 分钟里还回了一点电，所以差值应小于一次普通扣分 + 复读罚。
    expect(one - two).toBeLessThan(0.06);
  });

  it('安静下来：电量回、负荷落，各按半衰期', () => {
    store.observe(Array.from({ length: 8 }, (_, i) => event({ cursor: i + 1, senderKey: String(3001 + i) })));
    const busy = store.values();
    now += 30 * MIN;
    const after = store.tick();
    expect(after.load).toBeCloseTo(busy.load / 2, 2);
    expect(after.socialBattery).toBeGreaterThan(busy.socialBattery);
    expect(after.socialBattery).toBeLessThan(1);
  });

  it('她开口才掉电；没发出去不算', () => {
    const before = store.values().socialBattery;
    store.noteTurn({ sent: false });
    expect(store.values().socialBattery).toBe(before);
    store.noteTurn({ sent: true });
    expect(store.values().socialBattery).toBeCloseTo(before - 0.006, 3);
  });

  it('说一整天的话也不会掉到短回的线以下', () => {
    // 今天真实发生了 75 次 qq_draft。按 0.02 一句算，光说话就把整条电量说穿了，
    // 到了晚上她只剩"行，都依你"这种句子。
    for (let i = 0; i < 75; i += 1) store.noteTurn({ sent: true });
    expect(store.values().socialBattery).toBeGreaterThan(0.25);
  });

  it('掉电有下限，不会掉到负数', () => {
    for (let i = 0; i < 100; i += 1) {
      store.observe([event({ cursor: i + 1, senderKey: String(4000 + i) })]);
    }
    expect(store.values().socialBattery).toBeGreaterThanOrEqual(0.02);
  });

  it('说出去的话有人接：回一点电，聊得起来不会一路掉到底', () => {
    store.noteTurn({ sent: true });
    const afterSend = store.values().socialBattery;
    // 同一时刻、有人接着她的话说：回 0.01，再扣这一条 thread 的 0.008，净是回升。
    store.observe([event({ meta: { wake: 'thread' } })]);
    expect(store.values().socialBattery).toBeGreaterThan(afterSend);
  });

  it('过了窗口才有人接，不算被接住', () => {
    store.noteTurn({ sent: true });
    now += 20 * MIN;
    const afterTick = store.tick().socialBattery;
    store.observe([event({ cursor: 2, meta: { wake: 'thread' } })]);
    expect(store.values().socialBattery).toBeCloseTo(afterTick - 0.008, 3);
  });

  it('一次回复只回一次电：连着两条接话也只算被接住一次', () => {
    store.noteTurn({ sent: true });
    store.observe([event({ meta: { wake: 'thread' } })]);
    const once = store.values().socialBattery;
    store.observe([event({ cursor: 2, senderKey: '3002', meta: { wake: 'thread' } })]);
    expect(store.values().socialBattery).toBeLessThan(once);
  });

  it('说出去的话没人接：过了窗口扣一笔，而且只扣一次', () => {
    store.noteTurn({ sent: true });
    const start = store.values().socialBattery;
    now += 20 * MIN;
    // 只按时间回电会到的位置；实际应该比它低一笔"没人接"。
    const rechargeOnly = start + (1 - start) * (1 - Math.pow(0.5, 20 / 90));
    const after = store.tick().socialBattery;
    expect(after).toBeCloseTo(rechargeOnly - 0.006, 3);
    store.tick();
    expect(store.values().socialBattery).toBeCloseTo(after, 5);
  });

  it('说出去的时刻写进盘：重启之后窗口内的接话仍然算数', () => {
    store.noteTurn({ sent: true });
    const reopened = new InteroStore(tmp.dir, () => now);
    expect(reopened.current.lastSentAt).toBe(T);
    now += 3 * MIN;
    const before = reopened.tick().socialBattery;
    reopened.observe([event({ cursor: 2, meta: { wake: 'thread' } })]);
    expect(reopened.values().socialBattery).toBeGreaterThan(before);
  });

  it('落盘后重开还能读到', () => {
    store.observe([event()]);
    const file = join(tmp.dir, 'intero.json');
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const again = new InteroStore(tmp.dir, () => now);
    expect(again.values().socialBattery).toBeCloseTo(raw.socialBattery, 6);
  });

  it('坏文件回默认值', () => {
    const file = join(tmp.dir, 'intero.json');
    writeFileSync(file, '{bad', 'utf8');
    const again = new InteroStore(tmp.dir, () => now);
    expect(again.values()).toEqual({ socialBattery: 0.75, load: 0.2 });
  });
});

describe('内感受 · 文案与状态块', () => {
  it('低电量/高负荷各有一句话，正常时不唠叨', () => {
    expect(interoLine({ socialBattery: 0.2, load: 0.1 })).toContain('社交电量很低');
    expect(interoLine({ socialBattery: 0.4, load: 0.1 })).toContain('说话会更省');
    expect(interoLine({ socialBattery: 0.9, load: 0.9 })).toContain('手头负荷');
    expect(interoLine({ socialBattery: 0.8, load: 0.2 })).toBeNull();
  });

  it('状态块只在低电量时多一行', () => {
    const tmp = makeTmpDir();
    try {
      const role = new RoleStateStore(tmp.dir, () => T);
      expect(role.block()).not.toContain('社交电量');
      expect(role.block({ socialBattery: 0.2, load: 0.1 })).toContain('社交电量很低');
      expect(role.block({ socialBattery: 0.9, load: 0.2 })).not.toContain('社交电量');
    } finally {
      tmp.cleanup();
    }
  });

  it('复读归一化去掉前缀与标点', () => {
    expect(normalizeRepeat('#1 [群「g」 14:00] 甲(3001): 在吗！'))
      .toBe(normalizeRepeat('#2 [群「g」 14:05] 甲(3001): 在吗'));
  });
});

describe('内感受 · 回复预算', () => {
  const cfg = { replyBattery: 0.35, hesitationSeconds: 6 };

  it('电量正常：不短回、不延迟', () => {
    expect(replyBudget({ socialBattery: 0.6 }, cfg)).toEqual({ short: false, delayMs: 0 });
  });

  it('刚压线：短回，但几乎不延迟', () => {
    const out = replyBudget({ socialBattery: 0.34 }, cfg);
    expect(out.short).toBe(true);
    expect(out.delayMs).toBeLessThan(300);
  });

  it('电量越低延迟越长，最多等于上限', () => {
    expect(replyBudget({ socialBattery: 0.175 }, cfg).delayMs).toBe(3000);
    expect(replyBudget({ socialBattery: 0 }, cfg).delayMs).toBe(6000);
  });

  it('预算说明只在低电量时出现，并明确不许追问', () => {
    const line = replyBudgetLine({ socialBattery: 0.2 }, cfg);
    expect(line).toContain('短一点');
    expect(line).toContain('不想接可以不说');
    // 低电量是给"怎么说"，不是一串禁令——禁令会把她变成只会点头的人。
    expect(line).not.toContain('不要');
    expect(replyBudgetLine({ socialBattery: 0.8 }, cfg)).toBeNull();
  });
});
