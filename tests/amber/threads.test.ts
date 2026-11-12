/** 话头与开口预算：留一句给下次、提过一次不再提、额度每天滚动并带一点结转。 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { join } from 'node:path';
import { ThreadStore, threadLine } from '../../bots/amber/persona/threads.ts';
import { makeTmpDir } from '../core/helpers.ts';

const TZ = 'Asia/Shanghai';
/** 2026-10-27 10:00 上海 */
const DAY1 = Date.parse('2026-10-27T02:00:00Z');
const DAY2 = Date.parse('2026-10-28T02:00:00Z');

describe('话头', () => {
  const tmp = makeTmpDir();
  let clock = DAY1;
  let store: ThreadStore;
  let seq = 0;

  afterAll(() => tmp.cleanup());

  beforeEach(() => {
    seq += 1;
    clock = DAY1;
    store = new ThreadStore(join(tmp.dir, `threads-${seq}.json`), () => TZ, () => clock);
  });

  it('留下一句，下次被叫醒时能拿到；提过一次就不再提', () => {
    const note = store.leave('刚才想问他那句话还没说完');
    expect(store.pending()?.id).toBe(note.id);
    expect(store.pending()?.text).toContain('还没说完');
    store.markSurfaced(note.id);
    expect(store.pending()).toBeNull();
  });

  it('最多留五条：再留就挤掉最旧的', () => {
    for (let i = 1; i <= 7; i++) {
      clock += 1000;
      store.leave(`第 ${i} 句`);
    }
    const all = store.all();
    expect(all.length).toBe(5);
    expect(all[0]!.text).toBe('第 3 句');
    expect(all[4]!.text).toBe('第 7 句');
  });

  it('已经提过的先被挤掉', () => {
    const first = store.leave('提过的那句');
    store.markSurfaced(first.id);
    for (let i = 1; i <= 5; i++) store.leave(`新的 ${i}`);
    expect(store.all().some((t) => t.id === first.id)).toBe(false);
  });

  it('递回来的话带上"还作数吗"，不是命令', () => {
    const note = store.leave('想问他昨晚到底睡没睡');
    const line = threadLine(note);
    expect(line).toContain('你走的时候留了句话');
    expect(line).toContain('想问他昨晚到底睡没睡');
    expect(line).toContain('还作数吗');
  });
});

describe('开口预算', () => {
  const tmp = makeTmpDir();
  let clock = DAY1;
  let store: ThreadStore;
  let seq = 0;

  afterAll(() => tmp.cleanup());

  beforeEach(() => {
    seq += 1;
    clock = DAY1;
    store = new ThreadStore(join(tmp.dir, `speak-${seq}.json`), () => TZ, () => clock);
  });

  it('当天两次；用完就不给', () => {
    expect(store.speakAllowance(2)).toMatchObject({ used: 0, allowed: 2, remaining: 2 });
    expect(store.spendSpeak(2)).toBe(true);
    expect(store.spendSpeak(2)).toBe(true);
    expect(store.speakAllowance(2).remaining).toBe(0);
    expect(store.spendSpeak(2)).toBe(false);
  });

  it('昨天全没用：带一次过来，allowed 封顶 1.5 倍', () => {
    expect(store.speakAllowance(2).allowed).toBe(2); // 今天是第一天
    clock = DAY2;
    expect(store.speakAllowance(2)).toMatchObject({ used: 0, allowed: 3, remaining: 3 });
  });

  it('昨天用完：不带结转', () => {
    store.spendSpeak(2);
    store.spendSpeak(2);
    clock = DAY2;
    expect(store.speakAllowance(2)).toMatchObject({ used: 0, allowed: 2, remaining: 2 });
  });

  it('封顶不会被多天累积突破', () => {
    clock = DAY2;
    clock = DAY1 + 3 * 24 * 3600 * 1000;
    expect(store.speakAllowance(2).allowed).toBeLessThanOrEqual(3);
  });
});
