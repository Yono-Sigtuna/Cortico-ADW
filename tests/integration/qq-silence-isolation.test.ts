import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, type AssembledBot } from '../../bots/corti-soulmate/assemble.ts';
import { itemText } from '../../src/protocol/open-responses/context.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, sleep, textReply, toolReply } from '../core/helpers.ts';

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('等待实际回合结束超时');
    await sleep(10);
  }
}

describe('QQ 沉默 · 实际投递与会话隔离', () => {
  it('真实 Core 收束 A 的沉默后，B 仍投递并回复，A 的短陈述仍只归档', async () => {
    const tmp = makeTmpDir();
    const groupA = 424280;
    const groupB = 424281;
    const self = 5010;
    const mock = new MockOneBot({ port: 0, groupId: groupA, selfId: self, selfNickname: 'bot' });
    let bot: AssembledBot | undefined;
    try {
      const port = await mock.start();
      const memoryDir = join(tmp.dir, 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。');
      const cfg = makeCfg();
      cfg.worlds.qq = {
        ...cfg.worlds.qq,
        enabled: true, wsUrl: `ws://127.0.0.1:${port}`,
        groups: [{ id: groupA, enabled: true }, { id: groupB, enabled: true }],
        privates: [], wakeOnMentionOnly: true, wakeOnName: false,
        catchupOnStart: false, ambientInterject: false,
        room: { ...cfg.worlds.qq.room, enabled: false },
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

      const speak = (group: number, text: string) => toolReply([
        { name: 'qq_draft', args: { follow_up: null, to: `group:${group}`, text } },
      ]);
      const turn = async (group: number, user: number, text: string, reply: ReturnType<typeof textReply>, mention = false) => {
        const before = llm.calls.length;
        llm.script(reply);
        const id = mock.emitGroupMessage({ group_id: group, user_id: user, segments: [
          ...(mention ? [{ type: 'at', data: { qq: String(self) } }] : []),
          { type: 'text', data: { text } },
        ] });
        await waitFor(() => llm.calls.length > before && bot!.core.loop.getStatus().phase.state === 'idle');
        return id;
      };
      await turn(groupA, 9701, '先聊两句。', speak(groupA, '我在，先说你想聊的。'), true);
      await turn(groupB, 9702, '先聊两句。', speak(groupB, '嗯，这边也听到了。'), true);
      await turn(groupA, 9701, '这几页资料已经整理好了。', textReply(''));
      const bId = await turn(groupB, 9702, '这本书我已经看完了。', speak(groupB, '书里的那一段我看到了。'));
      expect(bot.core.store.range({ source: 'qq' }).find((event) => Number(event.meta?.message_id) === bId)?.contextDelivery).toBe('deliver');
      expect(mock.outbox.some((sent) => Number(sent.params.group_id) === groupB)).toBe(true);

      const short = '我先把资料放回桌上。';
      const aId = mock.emitGroupMessage({ group_id: groupA, user_id: 9701, text: short });
      await waitFor(() => bot!.core.store.range({ source: 'qq' }).some((event) => Number(event.meta?.message_id) === aId));
      expect(bot.core.store.range({ source: 'qq' }).find((event) => Number(event.meta?.message_id) === aId)?.contextDelivery).toBe('archive-only');
      expect(bot.core.session.records.map((entry) => itemText(entry.item)).join('\n')).not.toContain(short);
    } finally {
      await bot?.stop();
      await mock.close();
      tmp.cleanup();
    }
  }, 30000);
});
