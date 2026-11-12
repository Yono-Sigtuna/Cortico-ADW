import { messages as legacyMessages } from '../core/fixture-protocol.ts';
/** 名字唤醒：前缀、一次笔误、注意力窗口、非唤醒消息不打扰。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, type AssembledBot } from '../../bots/corti-soulmate/assemble.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, textReply, sleep } from '../core/helpers.ts';

const GROUP = 424243;
const SELF = 5001;

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

function sessionText(bot: AssembledBot): string {
  return legacyMessages(bot.core.session.records)
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

describe('QQ 名字唤醒与注意力窗口', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;
  let bot: AssembledBot;
  let llm: FakeLLM;

  beforeAll(async () => {
    mock = new MockOneBot({
      port: 0,
      groupId: GROUP,
      selfId: SELF,
      selfNickname: 'bot',
      selfCard: 'botcard',
      groupName: '测试群',
    });
    const port = await mock.start();

    const memoryDir = join(tmp.dir, 'persona');
    mkdirSync(join(memoryDir, 'note'), { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

    const cfg = makeCfg();
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
    };
    cfg.worlds.console.enabled = false;
    cfg.batching.quietGapMs = 60;
    cfg.batching.maxBatchAgeMs = 400;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;

    const loaded = makeLoaded({
      config: cfg,
      rootDir: tmp.dir,
      memoryDir,
      dataDir: join(tmp.dir, 'data'),
    });

    llm = new FakeLLM();
    bot = assembleBot(loaded, { llm });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);
    await waitFor(() => llm.calls.length >= 1);
  }, 15000);

  afterAll(async () => {
    await bot.stop();
    await mock.close();
  });

  it('没有叫到名字的群消息不唤醒', async () => {
    const before = llm.calls.length;
    mock.emitGroupMessage({ user_id: 3001, nickname: '甲', text: 'class 里有个 bug' });
    await sleep(400);
    expect(llm.calls.length).toBe(before);
  });

  it('前缀名 clau 能唤醒，并带上紧接着的正文', async () => {
    const before = llm.calls.length;
    llm.script(textReply('嗯，先休息。'));
    mock.emitGroupMessage({ user_id: 3002, nickname: '乙', text: 'clau' });
    await sleep(30);
    mock.emitGroupMessage({ user_id: 3002, nickname: '乙', text: '我今天感冒了，医生让我早点休息' });

    await waitFor(() => llm.calls.length > before);
    const all = sessionText(bot);
    expect(all).toContain('clau');
    expect(all).toContain('我今天感冒了');
  });

  it('一次笔误也能唤醒', async () => {
    const before = llm.calls.length;
    llm.script(textReply('嗯。'));
    mock.emitGroupMessage({ user_id: 3003, nickname: '丙', text: 'cluade 在吗' });
    await waitFor(() => llm.calls.length > before);
  });

  it('运行时追加的名字也能唤醒（来自她的术语表，不是改配置）', async () => {
    // 「小克」不在配置的 wakeNames 里；它由 Persona 从术语表同步进来。
    bot.qqWorld!.addWakeNames(['小克']);
    const before = llm.calls.length;
    llm.script(textReply('在。'));
    mock.emitGroupMessage({ user_id: 3004, nickname: '丁', text: '小克小克，出来一下' });
    await waitFor(() => llm.calls.length > before);
    expect(sessionText(bot)).toContain('小克小克');
  });
});
