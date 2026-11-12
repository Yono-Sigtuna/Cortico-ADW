/** 梦在排队/整理途中被打断：重启后笔记退回待整理，冷却不被冒充成已完成。 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('梦的中断恢复', () => {
  const tmp = makeTmpDir();
  let bot: AssembledBot;
  const stateFile = join(tmp.dir, 'data', 'dream-state.json');

  afterAll(async () => {
    await bot?.stop();
  });

  it('启动时把 in-flight 的笔记退回 pending，lastDreamAt 不动，并进入退避', async () => {
    const memoryDir = join(tmp.dir, 'persona');
    mkdirSync(join(memoryDir, 'note'), { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    mkdirSync(join(tmp.dir, 'data'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      lastDreamAt: 1_000,
      pending: ['handoffs/b.md'],
      inFlight: { id: 'dream-crashed', startedAt: 2_000, notes: ['handoffs/a.md'] },
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
    cfg.worlds.qq.enabled = false;
    cfg.worlds.console.enabled = false;
    cfg.dream.cooldownMinutes = 60;
    cfg.web.port = 0;

    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir: join(tmp.dir, 'data') });
    bot = assembleBot(loaded, { llm: new FakeLLM() });
    const startedAt = Date.now();
    await bot.start();

    await waitFor(() => {
      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
        return state.inFlight === undefined;
      } catch {
        return false;
      }
    });

    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      lastDreamAt: number; pending: string[]; attempts: number; nextAttemptAt: number;
    };
    expect(state.lastDreamAt).toBe(1_000);
    expect(state.pending).toEqual(['handoffs/a.md', 'handoffs/b.md']);
    expect(state.attempts).toBe(1);
    expect(state.nextAttemptAt).toBeGreaterThan(startedAt);
  }, 20000);
});
