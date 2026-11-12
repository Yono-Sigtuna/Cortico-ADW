/** 动作描写开关：开着会有「[动作] 可以写」的提示，关掉连这句提示都没有。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

const GROUP = 424270;
const SELF = 5040;
const QQ = 80070001;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

function makeCfg(port: number, gestureEnabled: boolean): BotConfig {
  const cfg = composeDefaults() as BotConfig;
  cfg.providers = {
    fixture: {
      kind: 'openai-responses-compat',
      baseUrl: 'https://model.test',
      spec: { model: 'test-model', thinking: false, temperature: 1 },
    },
  };
  cfg.activeProvider = 'fixture';
  cfg.gesture = { enabled: gestureEnabled };
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
  return cfg;
}

describe('动作描写 · 开关', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  afterAll(async () => {
    await mock?.close();
    tmp.cleanup();
  });

  async function runOnce(enabled: boolean, tag: string): Promise<string> {
    mock = new MockOneBot({
      port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: '测试群',
    });
    const port = await mock.start();
    const memoryDir = join(tmp.dir, `persona-${tag}`);
    const dataDir = join(tmp.dir, `data-${tag}`);
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    // 固定成"醒着"：否则按作息/兜底日程不同，注入的是睡觉那一版。
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    writeFileSync(join(dataDir, 'life-state.json'), JSON.stringify({
      version: 1, day, refreshedAt: Date.now(),
      plan: {
        slots: [{ time: '00:00', end: '23:59', activity: '在群里待着', mood: null, messageSeed: null, location: null }],
        generatedAt: Date.now(), source: 'dream',
      },
      weather: null, locationOverride: null, hunger: '无饥饿感', dream: '没有记住梦', outfit: null, cycleAnchor: null,
    }), 'utf8');

    const cfg = makeCfg(port, enabled);
    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const bot = assembleBot(loaded, { llm: new FakeLLM() });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    const transcript = () => legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    mock.emitGroupMessage({ user_id: QQ, nickname: '甲', text: 'claude 在吗' });
    // 等真正的投递发生（只有 system 前缀时 transcript 也非空，不能用长度判）。
    await waitFor(() => transcript().includes('claude 在吗'));
    if (enabled) await waitFor(() => transcript().includes('[动作]'));
    await sleep(300);
    const text = transcript();
    await bot.stop();
    await mock.close();
    return text;
  }

  it('开着：每轮注入一句许可', async () => {
    const text = await runOnce(true, 'on');
    expect(text).toContain('[动作]');
    expect(text).toContain('最多一处');
  }, 30000);

  it('关掉：连这句提示都不出现', async () => {
    const text = await runOnce(false, 'off');
    expect(text).not.toContain('[动作]');
  }, 30000);
});
