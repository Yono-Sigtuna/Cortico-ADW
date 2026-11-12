/** World 提供"某个会话最近在聊什么"：群里没叫到她的消息也要能取到。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults, type AssembledBot } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

const GROUP = 424251;
const SELF = 5009;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('最近消息', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  beforeAll(() => {
    mock = new MockOneBot({
      port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: '测试群',
    });
  });
  afterAll(async () => {
    await mock.close();
    tmp.cleanup();
  });

  it('没叫到她的群消息也在，正文只剩内容', async () => {
    const port = await mock.start();
    const memoryDir = join(tmp.dir, 'persona');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

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
    cfg.worlds.websearch.enabled = false;
    cfg.context.firstTurn = false;
    cfg.batching.quietGapMs = 60;
    cfg.batching.maxBatchAgeMs = 300;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;

    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const bot: AssembledBot = assembleBot(loaded, { llm: new FakeLLM() });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    // 都没叫到她 → archive-only，不会进投递批次。
    mock.emitGroupMessage({ user_id: 8001, nickname: '甲', text: '第一句：显卡好贵' });
    mock.emitGroupMessage({ user_id: 8002, nickname: '乙', text: '第二句：功耗更离谱' });
    mock.emitGroupMessage({ user_id: 8001, nickname: '甲', text: '第三句：我在看评测' });
    mock.emitGroupMessage({ user_id: 8002, nickname: '乙', text: '第四句：机箱得多大' });
    mock.emitGroupMessage({ user_id: 8001, nickname: '甲', text: '第五句：反正我不换' });
    mock.emitGroupMessage({ user_id: 8002, nickname: '乙', text: '第六句：等你换再说' });

    await waitFor(() => bot.core.store.range({ source: 'qq' }).filter((e) => e.type === 'qq.message').length >= 6);

    const recent = bot.qqWorld!.recentMessages(`group:${GROUP}`, 20);
    expect(recent).toHaveLength(6);
    expect(recent[0].text).toContain('显卡好贵');
    expect(recent[0].text).not.toContain('#');
    expect(recent[0].from).toBe('8001');
    expect(recent[5].from).toBe('8002');

    await bot.stop();
  }, 30000);
});
