/** 关系约束真的进了上下文：越界会被记录，约束行会出现在她读到的前缀边上。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

const GROUP = 424252;
const SELF = 5010;
const QQ = 80030001;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('关系约束 · 投递', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  afterAll(async () => {
    await mock?.close();
    tmp.cleanup();
  });

  it('预置边界与欠账后，约束行进入上下文；越界言论会写回关系状态', async () => {
    mock = new MockOneBot({
      port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: '测试群',
    });
    const port = await mock.start();

    const memoryDir = join(tmp.dir, 'persona');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(join(memoryDir, 'memo', 'diary'), { recursive: true });
    mkdirSync(join(memoryDir, 'people'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    writeFileSync(join(memoryDir, 'people', `qq-${QQ}.md`), `甲(${QQ}) — 测试群友。\n`, 'utf8');
    writeFileSync(join(dataDir, 'relations.json'), JSON.stringify({
      version: 1,
      people: {
        [QQ]: {
          trust: 0.2, familiarity: 0.4, boundary: 0.7,
          updatedAt: Date.now(), basis: '越界言论：闭嘴',
        },
      },
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

    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const bot = assembleBot(loaded, { llm: new FakeLLM() });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    const transcript = () => legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    mock.emitGroupMessage({ user_id: QQ, nickname: '甲', text: 'claude 在吗' });
    await waitFor(() => transcript().includes('刚越过界'));
    const text = transcript();
    expect(text).toContain('刚越过界');
    expect(text).toContain('谈不上信任');
    // 「他还在等的事」已经搬去会话状态（ConvState.pending），不再写进关系约束行。
    expect(text).not.toContain('还欠他一句答复');

    // 再来一条明确的越界言论：关系状态要跟着变，而不是只写进上下文。
    const before = JSON.parse(readFileSync(join(dataDir, 'relations.json'), 'utf8')).people[QQ];
    mock.emitGroupMessage({ user_id: QQ, nickname: '甲', text: 'claude 闭嘴，你个废物' });
    await waitFor(() => {
      const file = join(dataDir, 'relations.json');
      if (!existsSync(file)) return false;
      const now = JSON.parse(readFileSync(file, 'utf8')).people[QQ];
      return now.boundary > before.boundary;
    });
    const after = JSON.parse(readFileSync(join(dataDir, 'relations.json'), 'utf8')).people[QQ];
    expect(after.trust).toBeLessThan(0.2);
    expect(after.boundary).toBeGreaterThanOrEqual(0.7);

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
