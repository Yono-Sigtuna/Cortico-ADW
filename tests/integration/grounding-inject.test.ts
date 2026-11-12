/** 问"下午在干嘛"时，下午那几段与上一句会被定向放到她眼前。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

const GROUP = 424253;
const SELF = 5013;
const QQ = 80040001;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('时间问题 · 定向注入', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  afterAll(async () => {
    await mock?.close();
    tmp.cleanup();
  });

  it('问下午：注入下午的段与上一句，不再只有「现在」', async () => {
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

    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    writeFileSync(join(dataDir, 'life-state.json'), JSON.stringify({
      version: 1,
      day,
      refreshedAt: Date.now(),
      plan: {
        slots: [
          { time: '14:00', end: '15:00', activity: '把昨晚的对话翻回去核一遍', mood: null, messageSeed: null, location: null },
          { time: '15:00', end: '16:00', activity: '整理笔记：把示例当台词那条补上', mood: null, messageSeed: null, location: null },
          { time: '19:00', end: '21:00', activity: '群里的时间，看着他们刷图', mood: null, messageSeed: null, location: null },
        ],
        generatedAt: Date.now(),
        source: 'dream',
      },
      weather: null,
      locationOverride: null,
      hunger: '无饥饿感',
      dream: '没有记住梦',
      outfit: null,
      cycleAnchor: null,
    }), 'utf8');
    // 上一句：她刚在群里说过什么。
    writeFileSync(join(dataDir, 'companion.json'), JSON.stringify({
      version: 1,
      day,
      proactiveToday: 0,
      topicToday: 0,
      lastProactiveAt: null,
      convs: {
        [`group:${GROUP}`]: {
          lastUserAt: Date.now(),
          lastUserKey: String(QQ),
          lastUserText: '在吗',
          lastBotAt: Date.now() - 60_000,
          lastBotText: '在收拾记录，核昨天答错的地方',
          recent: [],
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

    mock.emitGroupMessage({ user_id: QQ, nickname: '甲', text: 'claude 下午在干嘛' });
    await waitFor(() => transcript().includes('[他问的是你的下午]'));
    const text = transcript();
    expect(text).toContain('[他问的是你的下午]');
    expect(text).toContain('把昨晚的对话翻回去核一遍');
    expect(text).toContain('整理笔记');
    expect(text).toContain('你上一句已经说过');
    expect(text).toContain('在收拾记录');
    expect(text).toContain('别把同一件事再说一遍');

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
