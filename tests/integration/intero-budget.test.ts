/** 电量低接进投递层：慢半拍 + 本轮预算（给怎么说，不给禁令）。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults } from '../../bots/amber/assemble.ts';
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

describe('内感受 · 投递层', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  afterAll(async () => {
    await mock?.close();
    tmp.cleanup();
  });

  it('电量低时慢半拍，并在这一轮注入「可以说短一点」的预算', async () => {
    mock = new MockOneBot({
      port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: '测试群',
    });
    const port = await mock.start();

    const memoryDir = join(tmp.dir, 'persona');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(join(memoryDir, 'memo', 'diary'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    // 电量已经很低：今天被聊得太多了。
    writeFileSync(join(dataDir, 'intero.json'), JSON.stringify({
      version: 1, updatedAt: Date.now(), socialBattery: 0.1, load: 0.2,
    }), 'utf8');

    const cfg = compose();
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
    cfg.companion = {
      ...cfg.companion,
      intero: { enabled: true, lowBattery: 0.3, highLoad: 0.85, replyBattery: 0.35, hesitationSeconds: 1 },
    };

    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const bot = assembleBot(loaded, { llm: new FakeLLM() });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    const transcript = () => legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    const started = Date.now();
    mock.emitGroupMessage({ user_id: 80020001, nickname: '甲', text: 'claude 在吗' });
    await waitFor(() => transcript().includes('[本轮预算]'));
    const elapsed = Date.now() - started;

    // 1 秒上限 × (1 - 0.1/0.35) ≈ 0.71 秒；投递还要过合批窗口，所以只断言下界。
    expect(elapsed).toBeGreaterThanOrEqual(600);
    const text = transcript();
    expect(text).toContain('[本轮预算]');
    const budgetLine = text.split('\n').find((l) => l.startsWith('[本轮预算]')) ?? '';
    expect(budgetLine).toContain('短一点');
    expect(budgetLine).toContain('不想接可以不说');
    // 给的是「怎么说」，不是一串禁令。
    expect(budgetLine).not.toContain('不要');

    await bot.stop();
  }, 30000);

  function compose(): BotConfig {
    const cfg = composeDefaults() as BotConfig;
    cfg.providers = {
      fixture: {
        kind: 'openai-responses-compat',
        baseUrl: 'https://model.test',
        spec: { model: 'test-model', thinking: false, temperature: 1 },
      },
    };
    cfg.activeProvider = 'fixture';
    cfg.worlds.console.enabled = false;
    cfg.worlds.websearch.enabled = false;
    cfg.context.firstTurn = false;
    cfg.batching.quietGapMs = 60;
    cfg.batching.maxBatchAgeMs = 300;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;
    return cfg;
  }
});
