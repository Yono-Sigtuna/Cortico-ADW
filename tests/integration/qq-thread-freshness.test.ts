/** 线索保鲜期：冷掉的线索只对点名、@、引用和问句叫醒。 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, type AssembledBot } from '../../bots/corti-soulmate/assemble.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, textReply, toolReply, sleep } from '../core/helpers.ts';

const GROUP = 424247;
const SELF = 5006;

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('线索保鲜期', () => {
  const tmp = makeTmpDir();
  let n = 0;

  /** 起一个 bot；`hotMinutes` 决定线索多久算冷，0 = 一开就冷。 */
  async function start(hotMinutes: number): Promise<{ bot: AssembledBot; llm: FakeLLM; mock: MockOneBot }> {
    n += 1;
    const mock = new MockOneBot({
      port: 0,
      groupId: GROUP,
      selfId: SELF,
      selfNickname: 'bot',
      selfCard: 'botcard',
      groupName: '测试群',
    });
    const port = await mock.start();
    const memoryDir = join(tmp.dir, `persona-${n}`);
    const dataDir = join(tmp.dir, `data-${n}`);
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
      threadHotMinutes: hotMinutes,
    };
    cfg.worlds.console.enabled = false;
    cfg.batching.quietGapMs = 60;
    cfg.batching.maxBatchAgeMs = 400;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;

    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const llm = new FakeLLM();
    const bot = assembleBot(loaded, { llm });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);
    await waitFor(() => llm.calls.length >= 1);
    return { bot, llm, mock };
  }

  /** 叫一声把线索开出来，并等她答完这一轮。 */
  async function openThread(llm: FakeLLM, mock: MockOneBot): Promise<void> {
    const before = llm.calls.length;
    // 要真的发出去：只写正文不算说过话，会被当成"她沉默过一次"而静音紧接着的短陈述。
    llm.script(toolReply([{ name: 'qq_draft', args: { follow_up: null, to: `group:${GROUP}`, text: '在。' } }]));
    mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: 'clau 在吗' });
    await waitFor(() => llm.calls.length > before);
    await sleep(120);
  }

  it('冷掉的线索：陈述句不叫醒', async () => {
    const { bot, llm, mock } = await start(0);
    try {
      await openThread(llm, mock);
      const before = llm.calls.length;
      mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: '我昨晚把那个东西自己修好了，折腾到三点' });
      await sleep(500);
      expect(llm.calls.length).toBe(before);
    } finally {
      await bot.stop();
      await mock.close();
    }
  });

  it('冷掉的线索：问句仍然叫醒', async () => {
    const { bot, llm, mock } = await start(0);
    try {
      await openThread(llm, mock);
      const before = llm.calls.length;
      llm.script(textReply('嗯。'));
      mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: '你觉得那个方案靠谱吗？' });
      await waitFor(() => llm.calls.length > before);
    } finally {
      await bot.stop();
      await mock.close();
    }
  });

  it('热着的线索：陈述句照常叫醒', async () => {
    const { bot, llm, mock } = await start(360);
    try {
      await openThread(llm, mock);
      const before = llm.calls.length;
      llm.script(textReply('嗯。'));
      mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: '我昨晚把那个东西自己修好了，折腾到三点' });
      await waitFor(() => llm.calls.length > before);
    } finally {
      await bot.stop();
      await mock.close();
    }
  });

  it('点名不受保鲜期影响：冷线索里叫名字照样醒', async () => {
    const { bot, llm, mock } = await start(0);
    try {
      await openThread(llm, mock);
      const before = llm.calls.length;
      llm.script(textReply('在。'));
      mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: 'claude 你还在吗' });
      await waitFor(() => llm.calls.length > before);
    } finally {
      await bot.stop();
      await mock.close();
    }
  });
});
