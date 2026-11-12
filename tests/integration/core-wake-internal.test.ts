/** Persona 主动排队一条内部事件：没人说话时也能让她醒一次。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults, type AssembledBot } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('主动唤醒', () => {
  const tmp = makeTmpDir();
  let bot: AssembledBot | null = null;

  beforeAll(() => {
    const memoryDir = join(tmp.dir, 'persona');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
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
    cfg.worlds.qq.enabled = false;
    cfg.worlds.console.enabled = false;
    cfg.worlds.websearch.enabled = false;
    cfg.context.firstTurn = false;
    cfg.batching.quietGapMs = 60;
    cfg.batching.maxBatchAgeMs = 300;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;

    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    bot = assembleBot(loaded, { llm: new FakeLLM() });
  });

  afterAll(() => {
    tmp.cleanup();
  });

  it('没有外部消息时，内部事件也会把她叫醒并进入上下文', async () => {
    const b = bot!;
    await b.start();

    const transcript = () => legacyMessages(b.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(transcript()).not.toContain('[主动时刻]');

    b.core.wakeInternal('[主动时刻] 现在是下午。没有人说话，但你想开口。', 'companion.opportunity');
    await waitFor(() => transcript().includes('[主动时刻]'));
    expect(transcript()).toContain('没有人说话');

    await b.stop();
  }, 30000);
});
