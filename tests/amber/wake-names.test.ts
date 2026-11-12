/** 从术语表的「我自己的称呼」一节省出唤醒名。 */
import { describe, it, expect } from 'vitest';
import { parseSelfNames } from '../../bots/amber/persona/wakeNames.ts';

const SAMPLE = `# 术语表与称呼解析

## 已知称呼

| 称呼 | 指谁 |
|---|---|
| 大肥鱼 | DeepSeek娘 |

## 我自己的称呼

Claude、克劳德、Claude娘、小橙、克劳德大小姐、昂贵橘子精（群昵称）、小克（群主专用）。别人给我起不冒犯的外号也可以接。

## 下一节

别把这段算进去。
`;

describe('唤醒名解析', () => {
  it('取「我自己的称呼」一节，去掉括号说明', () => {
    expect(parseSelfNames(SAMPLE)).toEqual([
      'Claude', '克劳德', 'Claude娘', '小橙', '克劳德大小姐', '昂贵橘子精', '小克',
    ]);
  });

  it('没有这一节就返回空，不猜', () => {
    expect(parseSelfNames('# 术语表\n\n## 已知称呼\n\n大肥鱼\n')).toEqual([]);
  });

  it('去重，并丢掉过短的碎片', () => {
    expect(parseSelfNames('## 我自己的称呼\n\n小克、小克、A、克劳德\n')).toEqual(['小克', '克劳德']);
  });
});
