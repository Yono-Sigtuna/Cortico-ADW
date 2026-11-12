/** 结构自查：发出去之后附一句，管句式不管词表。 */
import { describe, expect, it } from 'vitest';
import { slopAside } from '../../../src/worlds/qq/world.ts';

describe('AI 感的结构自查', () => {
  it('把关系写成交易时点出来', () => {
    expect(slopAside('钱我出一半，力气你出全部，账本上得写清楚本金')).toContain('交易词');
  });

  it('对仗句点出来', () => {
    expect(slopAside('风我先去替你吹着，你端着碗过来')).toContain('对仗');
    expect(slopAside('米你出一半，钱我出全部')).toContain('对仗');
  });

  it('客服式确认点出来', () => {
    expect(slopAside('收到，收声。')).toContain('客服式');
    expect(slopAside('记住了，这事我不提了。')).toContain('客服式');
  });

  it('把对方的话引一遍再回，点出来', () => {
    expect(slopAside('「无bug版」——那得是你真跑过一次才算数吧')).toContain('复述题面');
  });

  it('正常说话不打扰', () => {
    expect(slopAside('（把碗往旁边一推）那你先歇着，我不吵你。')).toBeNull();
    expect(slopAside('哈，这图我懂。')).toBeNull();
  });
});
