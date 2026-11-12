/** 梦的出口闸门：今天还只有临时排程时，第一次 surface 必须让位给写日程。 */
import { describe, it, expect } from 'vitest';
import { makeSurfaceTool } from '../../bots/amber/persona/subconscious/index.ts';

const call = async (tool: ReturnType<typeof makeSurfaceTool>, text: string): Promise<string> => {
  const out = await tool.handler({ text } as never, {} as never);
  return typeof out === 'string' ? out : String((out as { text?: unknown }).text ?? '');
};

describe('梦的出口 · surface 闸门', () => {
  it('日程还是临时排程：第一次被拦，写完之后第二次通过', async () => {
    let needsPlan = true;
    let blocked = 0;
    const surfaced = { text: null as string | null };
    const tool = makeSurfaceTool({
      surfaced,
      nudged: { value: false },
      needsDailyPlan: () => needsPlan,
      onBlocked: () => { blocked += 1; },
    });

    const first = await call(tool, '今天把那段报错看完了。');
    expect(first).toContain('surface blocked');
    expect(first).toContain('write_daily_plan');
    expect(surfaced.text).toBeNull();
    expect(blocked).toBe(1);

    // 梦去写了日程。
    needsPlan = false;
    const second = await call(tool, '今天把那段报错看完了。');
    expect(second).toContain('sleep summary captured');
    expect(surfaced.text).toBe('今天把那段报错看完了。');
  });

  it('只拦一次：第二次坚持结束就放行，避免死循环', async () => {
    const surfaced = { text: null as string | null };
    const tool = makeSurfaceTool({ surfaced, nudged: { value: false }, needsDailyPlan: () => true });
    expect(await call(tool, '第一句')).toContain('surface blocked');
    expect(await call(tool, '第一句')).toContain('sleep summary captured');
    expect(surfaced.text).toBe('第一句');
  });

  it('已经有她自己的日程时不拦', async () => {
    const surfaced = { text: null as string | null };
    const tool = makeSurfaceTool({ surfaced, nudged: { value: false }, needsDailyPlan: () => false });
    expect(await call(tool, '平稳的一天。')).toContain('sleep summary captured');
  });

  it('没有接上生活层时完全保持旧行为', async () => {
    const surfaced = { text: null as string | null };
    const tool = makeSurfaceTool({ surfaced });
    expect(await call(tool, '照旧。')).toContain('sleep summary captured');
  });

  it('空文本仍然拒绝，且不会消耗那次拦截', async () => {
    const surfaced = { text: null as string | null };
    const nudged = { value: false };
    const tool = makeSurfaceTool({ surfaced, nudged, needsDailyPlan: () => true });
    expect(await call(tool, '   ')).toContain('bad input');
    expect(nudged.value).toBe(false);
    expect(await call(tool, '写完了。')).toContain('surface blocked');
  });
});
