/** 梦跟着自己的冷却走，不跟着交接走：冷却期内的交接只留笔记。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

interface DreamState { lastDreamAt: number | null; pending: string[] }

describe('梦的冷却', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;
  let bot: AssembledBot;
  let llm: FakeLLM;
  let cfgRef: BotConfig;
  let stateFile = '';

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
    stateFile = join(tmp.dir, 'data', 'dream-state.json');
    mkdirSync(join(memoryDir, 'note'), { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

    const cfg = composeDefaults() as BotConfig;
    cfgRef = cfg;
    cfg.providers = {
      fixture: {
        kind: 'openai-responses-compat',
        baseUrl: 'https://model.test',
        spec: { model: 'test-model', thinking: true, reasoningEffort: 'low', temperature: 1 },
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
      wakeOnMentionOnly: false,
      wakeOnName: false,
    };
    cfg.worlds.console.enabled = false;
    cfg.dream.maxRounds = 1;
    cfg.dream.cooldownMinutes = 60;
    cfg.batching.quietGapMs = 40;
    cfg.batching.maxBatchAgeMs = 300;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;

    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir: join(tmp.dir, 'data') });
    llm = new FakeLLM();
    bot = assembleBot(loaded, { llm });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);
    await waitFor(() => llm.calls.length >= 1);
  }, 20000);

  afterAll(async () => {
    await bot.stop();
    await mock.close();
  });

  const state = (): DreamState | null => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8')) as DreamState;
    } catch {
      return null;
    }
  };

  /** 交接事务进行中时会拒绝，等它空下来再发。 */
  const forceHandoff = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      if (bot.dream.forceDreamAndTruncate()) return;
      await sleep(100);
    }
    throw new Error('交接请求一直没成功');
  };

  /** 一次唤醒收口才算这一批走完；只等模型被调用会在批次中途就往下走。 */
  const wakeCount = (): number => {
    try {
      return readFileSync(join(tmp.dir, 'data', 'wakes.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  it('第一次交接开梦并记下时刻；冷却期内的下一次只留笔记', async () => {
    // 先让上下文里有东西可整理:一次唤醒即可。
    const wakes0 = wakeCount();
    mock.emitGroupMessage({ user_id: 9001, nickname: '甲', text: '说句话' });
    await waitFor(() => wakeCount() > wakes0);
    await forceHandoff();
    await waitFor(() => state()?.lastDreamAt != null, 30000);
    const first = state()!;
    expect(first.lastDreamAt).toBeTypeOf('number');

    // 原文只继承一个尾巴，所以当前段那份笔记必须一起交给梦，否则中段两头落空。
    const notes = readdirSync(join(tmp.dir, 'persona', 'handoffs')).sort();
    const newest = notes[notes.length - 1]!.replace(/\.md$/, '');
    await waitFor(
      () => llm.calls.some((c) => JSON.stringify(c.messages).includes(newest)),
      15000,
    );

    const before = first.lastDreamAt;
    mock.emitGroupMessage({ user_id: 9002, nickname: '乙', text: '又说一句' });
    await waitFor(() => wakeCount() > wakes0 + 1);
    await forceHandoff();
    await waitFor(() => (state()?.pending.length ?? 0) > 0, 30000);

    const after = state()!;
    // 冷却期内不开梦:时刻没动,只多了一份待整理的交接笔记。
    expect(after.lastDreamAt).toBe(before);
    expect(after.pending.length).toBeGreaterThan(0);
    expect(after.pending.every((p) => p.startsWith('handoffs/') && p.endsWith('.md'))).toBe(true);
    expect(existsSync(join(tmp.dir, 'persona', after.pending[0]))).toBe(true);
  }, 90000);

  it('冷却关掉(0)后交接照常开梦', async () => {
    const seeded = Date.now() - 5000;
    writeFileSync(stateFile, JSON.stringify({ lastDreamAt: seeded, pending: [] }), 'utf8');
    cfgRef.dream.cooldownMinutes = 0;
    try {
      llm.fallback = () => textReply('');
      const wakes0 = wakeCount();
      // 直接 @：这条用例验的是冷却，不是唤醒形状；别让"上一条换人"把它筛掉。
      mock.emitGroupMessage({
        user_id: 9003,
        nickname: '丙',
        segments: [
          { type: 'at', data: { qq: String(SELF) } },
          { type: 'text', data: { text: ' 再来一句' } },
        ],
      });
      await waitFor(() => wakeCount() > wakes0);
      await forceHandoff();
      await waitFor(() => (state()?.lastDreamAt ?? 0) > seeded, 30000);
    } finally {
      cfgRef.dream.cooldownMinutes = 60;
    }
  }, 90000);
});
