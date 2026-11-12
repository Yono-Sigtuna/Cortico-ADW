/** 语气卡的分类与按场景取用：情形对上才递一张。 */
import { describe, it, expect } from 'vitest';
import {
  CARD_TRIGGERS, RECITE_ECHO, bodyOf, cardEcho, categoryOf, moodOf, parseCardKey, pickStyleCard,
  relationOf, styleCardLine,
  type StyleCard,
} from '../../bots/amber/persona/styleCards.ts';

const CARDS: StyleCard[] = [
  { key: '05-short', question: '嗯', answer: '嗯。' },
  { key: '06-interject', question: '所以呢', answer: '所以我先听听你怎么想。' },
  { key: '07-no-appease', question: '对不起，都怪我', answer: '别急着认，先把事说清。' },
  { key: '10-affection-deflect', question: '亲一下', answer: '先把你的手放下。' },
  { key: '01-tech', question: '这个报错怎么解', answer: '贴日志和那几行代码。' },
];

describe('语气卡 · 分类', () => {
  it('类别就是编号后面那个词；带后缀的切掉后缀', () => {
    expect(categoryOf('05-short')).toBe('short');
    expect(categoryOf('08-aftercare-bite')).toBe('aftercare');
    expect(categoryOf('10-affection-deflect')).toBe('affection');
    expect(categoryOf('no-prefix-here')).toBe('no-prefix-here');
  });

  it('每一类都有触发词，没有空表', () => {
    for (const key of Object.keys(CARD_TRIGGERS)) {
      expect(CARD_TRIGGERS[key]).toBeInstanceOf(RegExp);
    }
  });
});

describe('语气卡 · 按场景取用', () => {
  it('情形对上才给；对不上就不塞', () => {
    expect(pickStyleCard('这个报错我搞了三个小时', CARDS)?.key).toBe('01-tech');
    expect(pickStyleCard('我今天面试又失败了', CARDS)).toBeNull(); // comfort 类没有卡
    expect(pickStyleCard('今天天气不错', CARDS)).toBeNull();
  });

  it('一轮只递一张，按编号优先', () => {
    const both = pickStyleCard('对不起，都怪我，所以呢', CARDS)!;
    expect(both.key).toBe('06-interject');
  });

  it('递过的跳过，换下一张或干脆没有', () => {
    const skip = new Set(['06-interject']);
    expect(pickStyleCard('对不起，都怪我，所以呢', CARDS, skip)?.key).toBe('07-no-appease');
    expect(pickStyleCard('所以呢', CARDS, new Set(['06-interject']))).toBeNull();
  });

  it('一半空的卡不算卡', () => {
    const broken: StyleCard[] = [{ key: '01-tech', question: '报错了吗', answer: '  ' }];
    expect(pickStyleCard('这里报错了吗', broken)).toBeNull();
  });

  it('递过去的写法说清这是她自己说过的话，不是台词', () => {
    const line = styleCardLine(CARDS[4]!, 'note/style/01-tech.md');
    expect(line).toContain('这个报错怎么解');
    expect(line).toContain('像就用');
    expect(line).toContain('note/style/01-tech.md');
  });
});

describe('语气卡 · 姿态', () => {
  it('好感度换算成四档，刻度贴着真实账本（实测最高 0.164）', () => {
    expect(relationOf(0)).toBe('newcomer');
    expect(relationOf(0.019)).toBe('newcomer');
    expect(relationOf(0.02)).toBe('cold');
    expect(relationOf(0.08)).toBe('warm');
    expect(relationOf(0.164)).toBe('warm');
    expect(relationOf(0.2)).toBe('close');
  });

  it('心情取最强的那一维；四维都平就是 even', () => {
    expect(moodOf({ baseline: 6, joy: 6, anger: 2, sorrow: 2, fear: 2 })).toBe('even');
    expect(moodOf({ baseline: 6, joy: 8, anger: 1, sorrow: 1, fear: 1 })).toBe('bright');
    expect(moodOf({ baseline: 6, joy: 2, anger: 1, sorrow: 7, fear: 1 })).toBe('low');
    expect(moodOf({ baseline: 6, joy: 2, anger: 8, sorrow: 1, fear: 1 })).toBe('irritated');
    expect(moodOf(null)).toBe('even');
  });

  it('精力、社交电量、负荷合成生理档', () => {
    expect(bodyOf(62, 0.82, 0.1)).toBe('steady');
    expect(bodyOf(20, 0.9, 0.1)).toBe('spent');
    expect(bodyOf(90, 0.2, 0.1)).toBe('spent');
    expect(bodyOf(90, 0.9, 0.7)).toBe('spent');
    expect(bodyOf(85, 0.9, 0.1)).toBe('fresh');
  });

  it('标签写在文件名尾部，判完标签剩下的才是场景', () => {
    expect(parseCardKey('10-affection-close')).toEqual({ scene: 'affection', tags: { relation: 'close' } });
    expect(parseCardKey('08-aftercare-bite')).toEqual({ scene: 'aftercare', tags: {} });
    expect(parseCardKey('14-affection-close-bright')).toEqual({
      scene: 'affection', tags: { relation: 'close', mood: 'bright' },
    });
    expect(categoryOf('07-no-appease')).toBe('no-appease');
  });

  it('场景对不上不递；姿态对不上也不递', () => {
    const cards: StyleCard[] = [
      { key: '10-affection-cold', question: '亲一下', answer: '先把你的手放下。' },
      { key: '11-affection-close', question: '亲一下', answer: '……就一下。' },
    ];
    expect(pickStyleCard('亲一下', cards, new Set(), { affinity: 0.03 })?.key).toBe('10-affection-cold');
    expect(pickStyleCard('亲一下', cards, new Set(), { affinity: 0.3 })?.key).toBe('11-affection-close');
    // 暖档：两张都不属于这一档，宁可这一轮不递。
    expect(pickStyleCard('亲一下', cards, new Set(), { affinity: 0.15 })).toBeNull();
  });

  it('不分姿态的卡哪一档都递；不给读数时按最保守的算', () => {
    const plain: StyleCard[] = [{ key: '01-tech', question: '报错', answer: '贴日志。' }];
    expect(pickStyleCard('报错了', plain, new Set(), { affinity: 2 })?.key).toBe('01-tech');
    expect(pickStyleCard('报错了', plain)?.key).toBe('01-tech');
    const onlyClose: StyleCard[] = [{ key: '11-tease-close', question: '哈哈哈', answer: '笑够了没。' }];
    expect(pickStyleCard('哈哈哈', onlyClose)).toBeNull();
  });

  it('越具体越优先：两轴都对上的卡压过只对一轴的', () => {
    const cards: StyleCard[] = [
      { key: '10-affection', question: '亲一下', answer: '通用。' },
      { key: '14-affection-close', question: '亲一下', answer: '一轴。' },
      { key: '15-affection-close-bright', question: '亲一下', answer: '两轴。' },
    ];
    const bright = { baseline: 6, joy: 8, anger: 1, sorrow: 1, fear: 1 };
    expect(pickStyleCard('亲一下', cards, new Set(), { affinity: 0.3, mood: bright })?.key).toBe('15-affection-close-bright');
    // 心情只是平常时，两轴那张失效，退到一轴那张。
    const even = { baseline: 6, joy: 6, anger: 2, sorrow: 2, fear: 2 };
    expect(pickStyleCard('亲一下', cards, new Set(), { affinity: 0.3, mood: even })?.key).toBe('14-affection-close');
    // 关系没到：只剩通用卡。
    expect(pickStyleCard('亲一下', cards, new Set(), { affinity: 0.01, mood: even })?.key).toBe('10-affection');
  });
});

describe('语气卡 · 照念检测', () => {
  it('回话和卡上那句几乎一样，就算照念', () => {
    const answer = '先把你的手放下。';
    expect(cardEcho(answer, '先把你的手放下')).toBeGreaterThanOrEqual(RECITE_ECHO);
    expect(cardEcho(answer, '行吧，手我放下了')).toBeLessThan(RECITE_ECHO);
    expect(cardEcho(answer, '')).toBe(0);
  });
});
