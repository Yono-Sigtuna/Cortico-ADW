/** 群友改名：显示名变了要被她知道，而且旧名要留下。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults, type AssembledBot } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

const GROUP = 424248;
const SELF = 5006;
const USER = 8001;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('QQ 改名检测', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  beforeAll(async () => {
    mock = new MockOneBot({
      port: 0,
      groupId: GROUP,
      selfId: SELF,
      selfNickname: 'bot',
      selfCard: 'botcard',
      groupName: '测试群',
    });
  });

  afterAll(async () => {
    await mock.close();
    tmp.cleanup();
  });

  it('换了群名片就记一笔，并投一条内部事件', async () => {
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
      catchupMaxMessages: 50,
    };
    cfg.worlds.console.enabled = false;
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

    // 第一次见到这个人：只记下称呼，不该产生改名事件。
    mock.emitGroupMessage({ user_id: USER, nickname: '橘子', card: '小橘', text: '今天好热' });
    await waitFor(() => bot.core.store.range({ source: 'qq' }).some((e) => e.type === 'qq.message'));
    expect(bot.core.store.range({ source: 'qq' }).some((e) => e.type === 'qq.rename')).toBe(false);

    // 换了群名片。
    mock.emitGroupMessage({ user_id: USER, nickname: '橘子', card: '橘子精', text: '今天还是好热' });
    await waitFor(() => bot.core.store.range({ source: 'qq' }).some((e) => e.type === 'qq.rename'));

    const rename = bot.core.store.range({ source: 'qq' }).find((e) => e.type === 'qq.rename')!;
    expect(rename.origin).toBe('internal');
    expect(rename.text).toContain('小橘');
    expect(rename.text).toContain('橘子精');

    const ledger = JSON.parse(readFileSync(join(dataDir, 'qq-names.json'), 'utf8')) as Record<string, {
      name: string;
      history: Array<{ name: string }>;
    }>;
    expect(ledger[String(USER)].name).toBe('橘子精');
    expect(ledger[String(USER)].history.map((h) => h.name)).toContain('小橘');

    // 同一个人再用新名片说话，不该重复报改名。
    const before = bot.core.store.range({ source: 'qq' }).filter((e) => e.type === 'qq.rename').length;
    mock.emitGroupMessage({ user_id: USER, nickname: '橘子', card: '橘子精', text: '还是我' });
    await sleep(400);
    const after = bot.core.store.range({ source: 'qq' }).filter((e) => e.type === 'qq.rename').length;
    expect(after).toBe(before);

    await bot.stop();
  });
});
