/** 注意力显著性：判决的纯函数部分——权重、三档、理由。 */
import { describe, it, expect } from 'vitest';
import {
  attentionConfig, isFillerMessage, looksEmotional, looksQuestion, normalizeForRepeat, scoreMessage,
  type SalienceFacts,
} from '../../../src/worlds/qq/salience.ts';

const cfg = (patch = {}) => attentionConfig({ enabled: true, ...patch });

const facts = (patch: Partial<SalienceFacts> = {}): SalienceFacts => ({
  addressed: false,
  kind: 'group',
  windowMessages: 0,
  senderMessages: 0,
  repeats: 0,
  question: false,
  emotional: false,
  firstToday: false,
  ...patch,
});

describe('注意力 · 判决', () => {
  it('叫到她了或私聊，永远是焦点', () => {
    expect(scoreMessage(facts({ addressed: true }), cfg()).tier).toBe('focus');
    expect(scoreMessage(facts({ kind: 'private' }), cfg()).tier).toBe('focus');
  });

  it('注意力关着时保持旧行为：没叫到的进缓冲', () => {
    const off = attentionConfig({ enabled: false });
    expect(scoreMessage(facts(), off)).toMatchObject({ tier: 'periphery' });
  });

  it('普通群消息只有底分，落在背景', () => {
    const out = scoreMessage(facts(), cfg());
    expect(out.tier).toBe('background');
    expect(out.score).toBeCloseTo(0.2);
    expect(out.reasons.at(-1)).toContain('只归档');
  });

  it('第一次开口 + 提问，够进缓冲', () => {
    const out = scoreMessage(facts({ firstToday: true, question: true }), cfg());
    expect(out.score).toBeCloseTo(0.43);
    expect(out.tier).toBe('periphery');
    expect(out.reasons).toContain('在问具体问题');
  });

  it('复读会把它压回背景', () => {
    const once = scoreMessage(facts({ question: true, repeats: 0 }), cfg());
    const twice = scoreMessage(facts({ question: true, repeats: 1 }), cfg());
    expect(once.tier).toBe('periphery');
    expect(twice.tier).toBe('background');
    expect(twice.reasons.join('')).toContain('同一句话已经出现 1 次');
  });

  it('群里正吵时门槛实际变高', () => {
    const calm = scoreMessage(facts({ question: true }), cfg());
    const busy = scoreMessage(facts({ question: true, windowMessages: 12 }), cfg());
    expect(calm.tier).toBe('periphery');
    expect(busy.tier).toBe('background');
    expect(busy.reasons.join('')).toContain('负荷高');
  });

  it('恰好压线算进缓冲', () => {
    const ok = scoreMessage(facts({ question: true }), cfg({ peripheryThreshold: 0.35 }));
    expect(ok.score).toBeCloseTo(0.35);
    expect(ok.tier).toBe('periphery');
    const stricter = scoreMessage(facts({ question: true }), cfg({ peripheryThreshold: 0.36 }));
    expect(stricter.tier).toBe('background');
  });

  it('连续说话加一点分', () => {
    const out = scoreMessage(facts({ senderMessages: 2 }), cfg());
    expect(out.score).toBeCloseTo(0.25);
  });
});

describe('注意力 · 文本信号', () => {
  it('提问与情绪的词表', () => {
    expect(looksQuestion('这个怎么办？')).toBe(true);
    expect(looksQuestion('今天吃了面')).toBe(false);
    expect(looksEmotional('笑死我了！！！')).toBe(true);
    expect(looksEmotional('好的')).toBe(false);
  });

  it('复读归一化：标点、空白、链接、图片占位', () => {
    const a = normalizeForRepeat('好耶！！！');
    const b = normalizeForRepeat('  好耶  ');
    expect(a).toBe(b);
    expect(normalizeForRepeat('看这个 https://x.test/a?b=1')).toBe(normalizeForRepeat('看这个 https://y.test/c'));
    expect(normalizeForRepeat('[图片 abc123]')).toBe(normalizeForRepeat('[图片 def456]'));
  });
});

describe('纯附和判定', () => {  it('笑、应答、单个表情算废话；有内容的不算', () => {
    for (const t of ['哈哈哈哈', '哈哈哈！', '嗯嗯', '好的', '收到', '？', '……', '[表情:大怨种]', '6']) {
      expect(isFillerMessage(t), t).toBe(true);
    }
    for (const t of ['你才是大肥鱼！', '在吗', '刚才那个报错怎么改', '[图片 abc]', '好哇！你们俩官商勾结！']) {
      expect(isFillerMessage(t), t).toBe(false);
    }
  });
});

describe('注意力 · 房间形状', () => {
  it('冷场之后的第一条加分，理由写清楚静了多久', () => {
    const quietRoom = scoreMessage(facts({ lullMinutes: 25 }), cfg());
    const steady = scoreMessage(facts({ lullMinutes: 1 }), cfg());
    expect(quietRoom.score).toBeCloseTo(steady.score + 0.05);
    expect(quietRoom.reasons.some((r) => r.includes('静了 25 分钟'))).toBe(true);
  });

  it('独白扣分：一个人连着说的第 N 条比冷场后的第一条轻', () => {
    const mono = scoreMessage(facts({ monologue: true }), cfg());
    expect(mono.score).toBeCloseTo(0.15);
    expect(mono.reasons).toContain('这个群基本是一个人在连着说，别人只是偶尔插嘴');
  });

  it('窗口为空时 lullMinutes 是 Infinity：不加分，也不把 Infinity 写进理由', () => {
    const out = scoreMessage(facts({ lullMinutes: Infinity }), cfg());
    expect(out.score).toBeCloseTo(0.2);
    expect(out.reasons.join('；')).not.toContain('静了');
  });
});
