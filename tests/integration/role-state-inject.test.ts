/** 她自己的状态与日记会进入上下文；不是后台资料，是当轮的语气底色。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults, type AssembledBot } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, sleep } from '../core/helpers.ts';

const GROUP = 424250;
const SELF = 5008;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('状态与日记注入', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  afterAll(async () => {
    await mock?.close();
    tmp.cleanup();
  });

  it('唤醒时带上「她自己此刻的状态」和最近一篇日记', async () => {
    mock = new MockOneBot({
      port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: '测试群',
    });
    const port = await mock.start();

    const memoryDir = join(tmp.dir, 'persona');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(join(memoryDir, 'memo', 'diary'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    writeFileSync(
      join(memoryDir, 'memo', 'diary', '2026-10-25.md'),
      '# 十月二十五\n\n今天安静。台灯的事讲完了，我还有点记得那盏灯的亮度。\n',
      'utf8',
    );
    writeFileSync(join(dataDir, 'role-state.json'), JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      energy: 37,
      mood: { baseline: 5, joy: 4, anger: 2, sorrow: 5, fear: 2, intensity: 'mild', description: '有点困，心里还算稳' },
      sleep: '昨晚睡得浅',
      busy: '在读一本讲地形的书',
      health: null,
      presence: '阅读中',
      onlineMode: 'online',
      conditions: [],
      basis: '连着两天没睡好',
    }), 'utf8');
    // 有日程时「手头/公开状态」会以日程当前段为准：给一个覆盖全天的固定段，
    // 断言就不依赖跑测试的时刻。
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    writeFileSync(join(dataDir, 'life-state.json'), JSON.stringify({
      version: 1,
      day,
      refreshedAt: Date.now(),
      plan: {
        slots: [{ time: '00:00', end: '23:59', activity: '在读书，安静', mood: null, messageSeed: null, location: null }],
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
    };
    cfg.worlds.console.enabled = false;
    cfg.worlds.websearch.enabled = false;
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

    // 先把一条关于这个人的旧事放进索引：这一轮她会读到它，收口时要按结局再固化。
    const index = bot.persona.memoryIndex;
    if (!index) throw new Error('记忆索引未就绪');
    const seed = index.put({
      text: '甲之前提过台灯的事，说那盏灯有点旧了。',
      kind: 'episodic',
      importance: 0.5,
      eventTime: '2026-10-20',
      people: ['80010001'],
    });

    mock.emitGroupMessage({ user_id: 80010001, nickname: '甲', text: 'claude 在吗' });
    const transcript = () => legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    await waitFor(() => transcript().includes('[你自己此刻的状态]'));
    const text = transcript();
    expect(text).toContain('精力 37/100');
    expect(text).toContain('有点困，心里还算稳');
    // 有日程时，这两行以日程当前段为准（覆盖梦写的旧 busy / presence）。
    expect(text).toContain('手头：按日程：在读书，安静');
    expect(text).toContain('公开状态：在读书');
    expect(text).not.toContain('公开状态：阅读中');
    expect(text).toContain('[你最近写下的一天：2026-10-25]');
    expect(text).toContain('台灯的事讲完了');

    // 收口时按结局再固化：这一轮是静默（假模型回空），用上的那条旧事应当轻一点。
    const wakesFile = join(dataDir, 'wakes.jsonl');
    const wakeLines = (): Array<{ recall?: { ids: number; delta: number; changed: number } }> => (
      existsSync(wakesFile)
        ? readFileSync(wakesFile, 'utf8').trim().split('\n').filter(Boolean)
          .map((line) => JSON.parse(line) as { recall?: { ids: number; delta: number; changed: number } })
        : []
    );
    // 开局还有一条内部唤醒，它会先落盘；等的是"用上了记忆"的那一条。
    await waitFor(() => wakeLines().some((line) => (line.recall?.ids ?? 0) >= 1));
    const lastWake = [...wakeLines()].reverse().find((line) => (line.recall?.ids ?? 0) >= 1)!;
    expect(lastWake.recall?.ids).toBeGreaterThanOrEqual(1);
    expect(lastWake.recall?.delta).toBe(-0.01);
    expect(lastWake.recall?.changed).toBeGreaterThanOrEqual(1);
    expect(index.get(seed)?.importance).toBeCloseTo(0.49, 5);
    expect(lastWake.recall?.delta).toBe(-0.01);
    expect(lastWake.recall?.changed).toBeGreaterThanOrEqual(1);
    expect(index.get(seed)?.importance).toBeCloseTo(0.49, 5);

    // 内感受是投递时记的账：一条群消息之后，电量下降、负荷升高。
    const interoFile = join(dataDir, 'intero.json');
    await waitFor(() => existsSync(interoFile));
    const afterOne = JSON.parse(readFileSync(interoFile, 'utf8')) as { socialBattery: number; load: number };
    expect(afterOne.socialBattery).toBeLessThan(0.75);
    expect(afterOne.load).toBeGreaterThan(0.2);

    // 状态没变，但下一轮仍然要在场：「你在干嘛」这类问题不能只在状态变化那轮才看得到。
    const before = transcript().split('[你自己此刻的状态]').length - 1;
    mock.emitGroupMessage({ user_id: 80010001, nickname: '甲', text: 'claude 现在在干嘛呢' });
    await waitFor(() => transcript().split('[你自己此刻的状态]').length - 1 > before);
    const afterTwo = JSON.parse(readFileSync(interoFile, 'utf8')) as { socialBattery: number };
    expect(afterTwo.socialBattery).toBeLessThan(afterOne.socialBattery);

    await bot.stop();
  }, 30000);
});
