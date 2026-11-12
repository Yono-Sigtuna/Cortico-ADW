/** 语气卡的质量门：递了几次、她照念几次、什么时候该停用。 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StyleCardGate } from '../../bots/amber/persona/styleCardGate.ts';
import { makeTmpDir } from '../core/helpers.ts';

const SHOT = {
  conv: 'group:1',
  sender: '3124076548',
  card: '10-affection-cold',
  scene: 'affection',
  stance: 'cold/even/steady',
  affinity: 0.02,
  question: '亲一下',
  answer: '先把你的手放下。',
};

describe('语气卡质量门', () => {
  const tmp = makeTmpDir();
  afterAll(() => tmp.cleanup());
  // 每个用例一个干净目录，免得账串在一起。
  let seq = 0;
  const freshDir = (): string => {
    seq += 1;
    const dir = join(tmp.dir, `gate-${seq}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('递一次、回一次，账上能对上', () => {
    const gate = new StyleCardGate(freshDir());
    const id = gate.recordShot(SHOT)!;
    expect(id).toBeTruthy();
    gate.recordResult(id, true, '行吧，手放下了', SHOT.answer);
    const [stat] = gate.stats();
    expect(stat!.card).toBe('10-affection-cold');
    expect(stat!.shots).toBe(1);
    expect(stat!.sent).toBe(1);
    expect(stat!.recited).toBe(0);
    expect(stat!.avgEcho).toBeGreaterThan(0);
  });

  it('照念会被记下来；递三次、照念两次就停用', () => {
    const gate = new StyleCardGate(freshDir());
    for (let i = 0; i < 3; i += 1) {
      const id = gate.recordShot(SHOT)!;
      // 回得和卡上一模一样，就是照台词念。
      gate.recordResult(id, true, SHOT.answer, SHOT.answer);
    }
    const stats = gate.stats();
    const stat = stats.find((item) => item.card === SHOT.card)!;
    expect(stat.recited).toBe(3);
    expect(gate.shouldSkip(SHOT.card, stats)).toBe(true);
  });

  it('没开口也算一条账：递了卡她还是没话', () => {
    const gate = new StyleCardGate(freshDir());
    const id = gate.recordShot({ ...SHOT, card: '01-tech' })!;
    gate.recordResult(id, false, '', SHOT.answer);
    const stat = gate.stats().find((item) => item.card === '01-tech')!;
    expect(stat.silent).toBe(1);
    expect(stat.recited).toBe(0);
  });

  it('只递过一两次、或者偶尔照念一次，不停用', () => {
    const gate = new StyleCardGate(freshDir());
    for (let i = 0; i < 3; i += 1) {
      const id = gate.recordShot({ ...SHOT, card: '06-interject' })!;
      gate.recordResult(id, true, i === 0 ? SHOT.answer : '你呢', SHOT.answer);
    }
    const stats = gate.stats();
    expect(gate.shouldSkip('06-interject', stats)).toBe(false);
  });

  it('没有目录就什么都不做', () => {
    const gate = new StyleCardGate(null);
    expect(gate.recordShot(SHOT)).toBeNull();
    expect(gate.stats()).toEqual([]);
    expect(gate.shouldSkip('any')).toBe(false);
  });

  it('坏行不影响后面的账', () => {
    const dir = freshDir();
    const gate = new StyleCardGate(dir);
    const id = gate.recordShot(SHOT)!;
    gate.recordResult(id, true, '手放下了', SHOT.answer);
    expect(existsSync(join(dir, 'style-cards.jsonl'))).toBe(true);
    expect(gate.stats().length).toBeGreaterThan(0);
  });
});
