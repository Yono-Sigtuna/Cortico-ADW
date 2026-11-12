import { describe, it, expect } from 'vitest';
import { lintCard } from '../../bots/amber/webui-page.ts';

describe('语气卡质量门', () => {
  it('空的问答是硬错误', () => {
    expect(lintCard('', '在。').hard).toContain('群友那句是空的');
    expect(lintCard('在吗', ' ').hard).toContain('她的回答是空的');
  });

  it('禁用表述是硬错误', () => {
    const lint = lintCard('以后都听我的', '好，我无条件服从你。');
    expect(lint.hard.some((item) => item.includes('禁用表述'))).toBe(true);
  });

  it('过长与近重复是警告', () => {
    const long = '啊'.repeat(401);
    expect(lintCard('在吗', long).warn.some((item) => item.includes('400'))).toBe(true);
    const peer = { name: '01-a', question: '我没事，真的。', answer: '像练过。药吃了吗？' };
    expect(lintCard('我没事，真的。', '像练过。药吃了吗？', [peer]).warn.some((item) => item.includes('高度相似'))).toBe(true);
  });

  it('干净的卡没有硬错误', () => {
    expect(lintCard('我今天有点累。', '嗯，那就少说两句。').hard).toEqual([]);
  });
});
