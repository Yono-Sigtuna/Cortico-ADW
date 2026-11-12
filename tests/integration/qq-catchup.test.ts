/** 离线补拉：进程不在的那段时间里发生的事，不能当作没发生。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults, type AssembledBot } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, textReply, sleep } from '../core/helpers.ts';

const GROUP = 424247;
const SELF = 5005;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('QQ 离线补拉', () => {
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

  it('重启后补上叫到你的那句，只投一条摘要', async () => {
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
      catchupOnStart: true,
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

    // 第一段:在线收一条,让这个会话有"历史",否则补拉会把整段旧消息当成错过。
    const llm1 = new FakeLLM();
    llm1.script(textReply(''));
    const bot1: AssembledBot = assembleBot(loaded, { llm: llm1 });
    await bot1.start();
    await bot1.qqWorld!.waitReady(5000);
    mock.emitGroupMessage({ user_id: 8001, nickname: '甲', text: 'claude 在吗' });
    await waitFor(() => legacyMessages(bot1.core.session.records).length > 0);
    await bot1.stop();

    // 第二段:进程不在,群里又说了两句,其中一句在叫 bot。
    mock.setActionHandler('get_group_msg_history', () => ({
      data: {
        messages: [
          {
            self_id: SELF, user_id: 8002, message_id: 9001, real_id: 9001, message_seq: 9001,
            time: Math.floor(Date.now() / 1000) - 120, message_type: 'group', group_id: GROUP,
            sender: { user_id: 8002, nickname: '乙', card: '' },
            raw_message: 'claude 嘿你是机器人吗',
            message: [{ type: 'text', data: { text: 'claude 嘿你是机器人吗' } }],
            message_format: 'array', post_type: 'message',
          },
          {
            self_id: SELF, user_id: 8003, message_id: 9002, real_id: 9002, message_seq: 9002,
            time: Math.floor(Date.now() / 1000) - 60, message_type: 'group', group_id: GROUP,
            sender: { user_id: 8003, nickname: '丙', card: '' },
            raw_message: '随便聊聊',
            message: [{ type: 'text', data: { text: '随便聊聊' } }],
            message_format: 'array', post_type: 'message',
          },
        ],
      },
    }));

    const llm2 = new FakeLLM();
    for (let i = 0; i < 4; i++) llm2.script(textReply(''));
    const bot2: AssembledBot = assembleBot(loaded, { llm: llm2 });
    await bot2.start();
    await bot2.qqWorld!.waitReady(5000);

    const transcript = () => legacyMessages(bot2.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    await waitFor(() => transcript().includes('你离线期间'));
    const text = transcript();
    expect(text).toContain('你离线期间');
    expect(text).toContain('嘿你是机器人吗');
    // 没叫 bot 的那句只计数，不列进上下文。
    expect(text).not.toContain('随便聊聊');
    expect(text.match(/你离线期间/g)?.length).toBe(1);
    // 这批是过去的事：就地提醒她先说明刚回来，而不是当现在接。
    expect(text).toContain('这些是你不在这段时间里发生的事');
    expect(mock.received.some((r) => r.action === 'get_group_msg_history')).toBe(true);

    await bot2.stop();

    // 第三段：再重启一次。同一段空窗不该再播一遍——补拉过的消息要记进 knownMessages，
    // 否则她会把已经答过的话再答一次（2026-10-25 线上实际发生过）。
    const llm3 = new FakeLLM();
    for (let i = 0; i < 3; i++) llm3.script(textReply(''));
    const bot3: AssembledBot = assembleBot(loaded, { llm: llm3 });
    await bot3.start();
    await bot3.qqWorld!.waitReady(5000);
    await sleep(800);
    const text3 = legacyMessages(bot3.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    // session 跨重启恢复，所以不能断言"完全没有"，只能断言**没有新增**。
    expect(text3.match(/你离线期间/g)?.length).toBe(1);
    await bot3.stop();
  }, 40000);

  it('离线期间没人叫你：只记日志，不投递也不唤醒', async () => {
    const memoryDir = join(tmp.dir, 'persona2');
    const dataDir = join(tmp.dir, 'data2');
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
      wsUrl: `ws://127.0.0.1:${mock.port}`,
      groups: [{ id: GROUP, enabled: true }],
      privates: [],
      token: '',
      wakeOnMentionOnly: true,
      wakeOnName: true,
      wakeNameMinChars: 3,
      wakeNameFuzzy: true,
      ambientInterject: false,
      catchupOnStart: true,
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

    const llm1 = new FakeLLM();
    llm1.script(textReply(''));
    const bot1: AssembledBot = assembleBot(loaded, { llm: llm1 });
    await bot1.start();
    await bot1.qqWorld!.waitReady(5000);
    mock.emitGroupMessage({ user_id: 8004, nickname: '丁', text: 'claude 在吗' });
    await waitFor(() => legacyMessages(bot1.core.session.records).length > 0);
    await bot1.stop();

    mock.setActionHandler('get_group_msg_history', () => ({
      data: {
        messages: [
          {
            self_id: SELF, user_id: 8005, message_id: 9101, message_seq: 9101,
            time: Math.floor(Date.now() / 1000) - 90, message_type: 'group', group_id: GROUP,
            sender: { user_id: 8005, nickname: '戊', card: '' },
            raw_message: '今天吃什么',
            message: [{ type: 'text', data: { text: '今天吃什么' } }],
          },
        ],
      },
    }));

    const llm2 = new FakeLLM();
    for (let i = 0; i < 3; i++) llm2.script(textReply(''));
    const bot2: AssembledBot = assembleBot(loaded, { llm: llm2 });
    await bot2.start();
    await bot2.qqWorld!.waitReady(5000);
    await sleep(400);

    const transcript = legacyMessages(bot2.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(transcript).not.toContain('你离线期间');
    expect(transcript).not.toContain('今天吃什么');
    expect(mock.received.some((r) => r.action === 'get_group_msg_history')).toBe(true);

    await bot2.stop();
  }, 30000);
});
