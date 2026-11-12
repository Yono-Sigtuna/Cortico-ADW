/** 梦的提示词：一次只做该做的两三件事，而不是把整张清单跑一遍。 */
import { describe, it, expect } from 'vitest';
import { dreamOrientation, dreamTask } from '../../bots/amber/persona/subconscious/prompts.ts';

describe('梦的提示词 · 按需做事', () => {
  it('把职责拆成「每次必做两件」与「至多三件」', () => {
    const text = dreamOrientation();
    expect(text).toContain('One sleep is not the whole checklist');
    expect(text).toContain('at most three');
    expect(text).toContain('**Diary.**');
    expect(text).toContain('**Your own state.**');
    // 不能再是编号清单：那读起来就是"逐条做完"。
    expect(text).not.toMatch(/^1\. Merge duplicates/m);
  });

  it('任务里明说「三是上限不是配额」，小聊一场可以一件都不做', () => {
    const task = dreamTask({ nowText: '2026-10-31T21:00:00+08:00' });
    expect(task).toContain('Three is a ceiling, not a quota');
    expect(task).toContain('zero is the right number');
  });

  it('触发清单把原来的职责都接住了，没有丢东西', () => {
    const text = dreamOrientation();
    for (const key of [
      'people/qq-', '曾用名', '9000 characters', 'note/cases/', 'memo/archived/',
      'WORLDVIEW.md', '表情包.md', 'note/opinions/', 'CONSTITUTION.md', 'maintain_relation',
    ]) {
      expect(text).toContain(key);
    }
  });
});
