/** 时间感：隔了一阵子再说话，注入「距上次和你说话几小时」。同一段对话里不啰嗦。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

const GROUP = 424260;
const SELF = 5030;
const QQ = 80060001;
const HOUR = 3_600_000;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('时间感 · 间隔', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  afterAll(async () => {
    await mock?.close();
    tmp.cleanup();
  });

  it('隔了六小时：注入"6 小时前"；紧接着再说话不再重复', async () => {
    mock = new MockOneBot({
      port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: '测试群',
    });
    const port = await mock.start();

    const memoryDir = join(tmp.dir, 'persona');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(join(memoryDir, 'people'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    writeFileSync(join(memoryDir, 'people', `qq-${QQ}.md`), `甲(${QQ}) — 测试群友。\n`, 'utf8');
    // 上次说话在六小时前。
    writeFileSync(join(dataDir, 'relations.json'), JSON.stringify({
      version: 1,
      people: {
        [QQ]: {
          trust: 0.5, familiarity: 0.3, boundary: 0, debts: [],
          updatedAt: Date.now() - 6 * HOUR, basis: '',
        },
      },
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

    mock.emitGroupMessage({ user_id: QQ, nickname: '甲', text: 'claude 回来了' });
    await waitFor(() => transcript().includes('[时间] 距上次和你说话'));
    expect(transcript()).toContain('6 小时前');

    // 同一段对话里紧接着再说一句：间隔不到半小时，不该再念一遍。
    mock.emitGroupMessage({ user_id: QQ, nickname: '甲', text: 'claude 还在吗' });
    await sleep(1200);
    const count = (transcript().match(/距上次和你说话/g) ?? []).length;
    expect(count).toBe(1);

    await bot.stop();
  }, 30000);
});
