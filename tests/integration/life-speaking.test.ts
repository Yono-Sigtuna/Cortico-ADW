import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults, type AssembledBot } from '../../bots/amber/assemble.ts';
import { itemText } from '../../src/protocol/open-responses/context.ts';
import type { LifeStateStore } from '../../bots/amber/persona/companion/lifeState.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep, toolReply } from '../core/helpers.ts';

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('等待活动与发言提交超时');
    await sleep(10);
  }
}

describe('发言附带活动 · 实际装配', () => {
  it('漏填先拒发，同次补齐活动后才发出，并在真实请求 schema 中声明契约', async () => {
    const tmp = makeTmpDir();
    const group = 424289;
    const self = 5021;
    const mock = new MockOneBot({ port: 0, groupId: group, selfId: self, selfNickname: 'bot' });
    let bot: AssembledBot | undefined;
    try {
      const port = await mock.start();
      const memoryDir = join(tmp.dir, 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。');
      const cfg = composeDefaults();
      cfg.providers = { fixture: { kind: 'openai-responses-compat', baseUrl: 'https://model.test', spec: { model: 'test-model', thinking: false, temperature: 1 } } };
      cfg.activeProvider = 'fixture';
      cfg.worlds.qq = {
        ...cfg.worlds.qq, enabled: true, wsUrl: `ws://127.0.0.1:${port}`,
        groups: [{ id: group, enabled: true }], privates: [], catchupOnStart: false,
      };
      cfg.worlds.console.enabled = false;
      cfg.batching.quietGapMs = 20;
      cfg.batching.maxBatchAgeMs = 100;
      cfg.tick.dayIntervalMinutes = [999, 999];
      cfg.tick.nightIntervalMinutes = null;
      cfg.web.port = 0;
      const llm = new FakeLLM();
      bot = assembleBot(makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir: join(tmp.dir, 'data') }), { llm });
      await bot.start();
      await bot.qqWorld!.waitReady();
      await waitFor(() => llm.calls.length > 0 && bot!.core.loop.getStatus().phase.state === 'idle');
      const life = (bot.persona as unknown as { life: LifeStateStore }).life;
      life.setPlan([]);
      const until = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .format(new Date(Date.now() + 10 * 60_000));
      llm.script(
        toolReply([{ name: 'qq_draft', args: { follow_up: null, to: `group:${group}`, text: '漏填时不应发出。' } }]),
        toolReply([{ name: 'qq_draft', args: {
          follow_up: null, to: `group:${group}`, text: '窗边。我到这里了。',
          life_update: { doing: '在窗边站着', location: '家里·窗边', sleeping: false, until },
        } }]),
      );
      mock.emitGroupMessage({ user_id: 9801, segments: [
        { type: 'at', data: { qq: String(self) } },
        { type: 'text', data: { text: ' 来窗边站一会儿吧。' } },
      ] });
      await waitFor(() => mock.outbox.length > 0 && bot!.core.loop.getStatus().phase.state === 'idle');
      expect(mock.outbox).toHaveLength(1);
      expect(JSON.stringify(mock.outbox[0].params)).toContain('窗边。我到这里了。');
      expect(JSON.stringify(mock.outbox[0].params)).not.toContain('漏填时不应发出');
      expect(life.current.actualActivity).toMatchObject({ activity: '在窗边站着', location: '家里·窗边', sleeping: false });
      expect(life.current.plan?.slots).toEqual([]);
      const draft = llm.calls.at(-1)?.tools?.find((tool) => tool.name === 'qq_draft');
      expect(draft?.parameters.required).toEqual(expect.arrayContaining(['follow_up', 'life_update']));
      const original = bot.qqWorld!.tools().find((tool) => tool.name === 'qq_draft')!;
      expect(original.parameters.required).not.toContain('life_update');
      const receipts = bot.core.session.records.filter((entry) => entry.item.type === 'function_call_output').map((entry) => itemText(entry.item));
      expect(receipts.some((text) => text.includes('[life failed]') && text.includes('life_update'))).toBe(true);
      expect(receipts.some((text) => text.includes('[life advanced]') && text.includes('[sent #'))).toBe(true);

      const callsBeforeCancel = llm.calls.length;
      llm.script(
        toolReply([{ name: 'qq_draft', args: {
          follow_up: null, to: `group:${group}`, text: '（放下杯子）（坐下来）我回到桌边了。',
          life_update: { doing: '回到桌边读两行', location: '家里·书桌', sleeping: false, until },
        } }]),
        toolReply([{ name: 'qq_confirm', args: { decision: 'cancel', life_update: null } }]),
      );
      mock.emitGroupMessage({ user_id: 9802, segments: [
        { type: 'at', data: { qq: String(self) } },
        { type: 'text', data: { text: ' 回到桌边读两行吧。' } },
      ] });
      await waitFor(() => llm.calls.length >= callsBeforeCancel + 2 && bot!.core.loop.getStatus().phase.state === 'idle');
      expect(mock.outbox).toHaveLength(1);
      expect(life.current.actualActivity?.activity).toBe('回到桌边读两行');
      const afterCancel = bot.core.session.records.filter((entry) => entry.item.type === 'function_call_output').map((entry) => itemText(entry.item));
      expect(afterCancel.some((text) => text.includes('[draft held'))).toBe(true);
      expect(afterCancel.some((text) => text.includes('[draft discarded'))).toBe(true);

      llm.script(toolReply([{ name: 'qq_draft', args: {
        follow_up: null, to: `group:${group}`, text: '坐五分钟，翻两页画册。',
        life_update: { doing: '在沙发翻画册', location: '家里·沙发', sleeping: false, duration_minutes: 5 },
      } }]));
      mock.emitGroupMessage({ user_id: 9803, segments: [
        { type: 'at', data: { qq: String(self) } },
        { type: 'text', data: { text: ' 陪我坐五分钟翻两页画册吧。' } },
      ] });
      await waitFor(() => mock.outbox.length === 2 && bot!.core.loop.getStatus().phase.state === 'idle');
      expect(life.current.actualActivity?.activity).toBe('在沙发翻画册');
      expect(life.current.actualActivity!.endsAt - life.current.actualActivity!.startedAt).toBe(5 * 60_000);
      const relativeSchema = llm.calls.at(-1)?.tools?.find((tool) => tool.name === 'qq_draft');
      const properties = relativeSchema?.parameters.properties as Record<string, { properties?: Record<string, unknown> }>;
      expect(properties.life_update.properties).toHaveProperty('duration_minutes');
    } finally {
      await bot?.stop();
      await mock.close();
      tmp.cleanup();
    }
  }, 30000);
});
