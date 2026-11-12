/** 召回查询：只留正文，去掉媒体占位与链接，纯媒体消息不检索。 */
import { describe, it, expect } from 'vitest';
import { cleanRecallQuery, recallQueryOf } from '../../bots/amber/persona/recallQuery.ts';

describe('cleanRecallQuery', () => {
  it('去掉图片占位和链接', () => {
    expect(cleanRecallQuery('[图片 https://multimedia.nt.qq.com.cn/download?x=1] 今天好热')).toBe('今天好热');
    expect(cleanRecallQuery('看这个 https://a.test/b 是不是很离谱')).toBe('看这个 是不是很离谱');
  });

  it('去掉语音、表情、回复与转发的占位', () => {
    expect(cleanRecallQuery('[表情:大怨种]')).toBe('');
    expect(cleanRecallQuery('[QQ表情]确实')).toBe('确实');
    expect(cleanRecallQuery('[回复#842485102]就是说')).toBe('就是说');
    expect(cleanRecallQuery('[转发的聊天记录,正在展开中...]你看这个')).toBe('你看这个');
    expect(cleanRecallQuery('[语音 transcribe]')).toBe('');
  });

  it('去掉称呼：@一张嘴不是话题', () => {
    expect(cleanRecallQuery('@bot(你) [表情:大怨种]')).toBe('');
    expect(cleanRecallQuery('@阿明，上次那事怎么样了')).toBe('上次那事怎么样了');
  });

  it('正文原样保留，不裁剪人名和标点', () => {
    expect(cleanRecallQuery('阿明说「显卡又涨价了」，你怎么看？')).toBe('阿明说「显卡又涨价了」，你怎么看？');
  });

  it('合并空白', () => {
    expect(cleanRecallQuery('  显卡   又\n涨价了  ')).toBe('显卡 又 涨价了');
  });
});

describe('recallQueryOf', () => {
  const external = (patch: Record<string, unknown>) => ({ origin: 'external', ...patch });

  it('优先用 meta.body：渲染外壳（消息号/群名/昵称）不进查询', () => {
    const q = recallQueryOf([
      external({
        text: '#1727548506 [群「测试群」 15:09] 娶万里花，做万年梦(3124076548): 显卡又涨价了',
        meta: { body: '显卡又涨价了' },
      }),
    ]);
    expect(q).toBe('显卡又涨价了');
  });

  it('没有 body 时退回 text', () => {
    expect(recallQueryOf([external({ text: '显卡又涨价了' })])).toBe('显卡又涨价了');
  });

  it('纯图片或纯表情的一批：没有查询', () => {
    expect(recallQueryOf([
      external({ text: '#1 [群「测试群」 15:09] 甲(1): [图片 https://x.test/a.jpg]', meta: { body: '[图片 https://x.test/a.jpg]' } }),
      external({ text: '#2 [群「测试群」 15:10] 乙(2): [表情:大怨种]', meta: { body: '[表情:大怨种]' } }),
    ])).toBe('');
  });

  it('内部事件不参与', () => {
    expect(recallQueryOf([{ origin: 'internal', text: '[system] 进程重启' }])).toBe('');
  });
});
