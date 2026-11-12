/** 话头：留过的那一句，下次有人来找她时递回来一次，之后不再重复。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

const GROUP = 424255;
const SELF = 5020;
const QQ = 80050001;
const LINE = '[你走的时候留了句话]';

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('话头 · 递回来一次', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  afterAll(async () => {
    await mock?.close();
    tmp.cleanup();
  });

  it('下次被叫醒时出现一次，之后的唤醒不再重复', async () => {
    mock = new MockOneBot({
      port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: '测试群',
    });
    const port = await mock.start();

    const memoryDir = join(tmp.dir, 'persona');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    writeFileSync(join(dataDir, 'threads.json'), JSON.stringify({
      version: 1,
      threads: [{ id: 't1', text: '想问他昨晚到底睡没睡', at: Date.now() - 60_000 }],
      speak: { day: '', used: 0, carry: 0 },
    }), 'utf8');

    const cfg = composeDefaults() as BotConfig;
    cfg.providers = {
      fixture: {
        kind: 'openai-responses-compat',
        baseUrl: 'https://model.test',
        spec: { model: 'test-model', thinking: false, temperature: 1 },
      },
    };
    cfg.activeProvider = 'fixture';
    cfg.worlds.qq = {
      ...cfg.worlds.qq,
      enabled: true,
      wsUrl: `ws://127.0.0.1:${port}`,
      groups: [{ id: GROUP, enabled: true }],
      privates: [],
      token: '',
      wakeOnMentionOnly: true,
      wakeOnName: true,
      wakeNameMinChars: 3,
      wakeNameFuzzy: true,
      ambientInterject: false,
      catchupOnStart: false,
    };
    cfg.worlds.console.enabled = false;
    cfg.context.firstTurn = false;
    cfg.batching.quietGapMs = 60;
    cfg.batching.maxBatchAgeMs = 300;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;

    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const bot = assembleBot(loaded, { llm: new FakeLLM() });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    const transcript = () => legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    mock.emitGroupMessage({ user_id: QQ, nickname: '甲', text: 'claude 在吗' });
    await waitFor(() => transcript().includes(LINE));
    expect(transcript()).toContain('想问他昨晚到底睡没睡');
    expect(transcript()).toContain('还作数吗');

    mock.emitGroupMessage({ user_id: QQ, nickname: '甲', text: 'claude 在不在' });
    await sleep(1200);
    const count = (transcript().match(/你走的时候留了句话/g) ?? []).length;
    expect(count).toBe(1);

    await bot.stop();
  }, 30000);
});
