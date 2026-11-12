/** 自动注入：唤醒前按当批消息检索长期记忆，命中才注入，不命中不塞。 */
import { messages as legacyMessages } from '../core/fixture-protocol.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults, type AssembledBot } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MemoryIndex } from '../../bots/amber/persona/memoryIndex.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, textReply, sleep } from '../core/helpers.ts';

const BLOCK_HEAD = '[想起来的一些旧事，可能和这几条消息有关]';

const GROUP = 424248;
const SELF = 5006;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

function makeCfg(port: number): BotConfig {
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
  };
  cfg.worlds.console.enabled = false;
  cfg.context.firstTurn = false;
  cfg.batching.quietGapMs = 60;
  cfg.batching.maxBatchAgeMs = 300;
  cfg.tick.dayIntervalMinutes = [999, 999];
  cfg.tick.nightIntervalMinutes = null;
  cfg.web.port = 0;
  cfg.memory = { decayRate: 0.02, dormantDays: 90, injectTopK: 3, embeddingModel: '', embeddingBaseUrl: '' };
  return cfg;
}

describe('记忆自动注入', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;

  beforeAll(async () => {
    mock = new MockOneBot({ port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', selfCard: 'botcard', groupName: '测试群' });
    await mock.start();
  });

  afterAll(async () => {
    await mock.close();
    tmp.cleanup();
  });

  it('当批消息命中旧事时注入，且带免疫声明', async () => {
    const memoryDir = join(tmp.dir, 'persona');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

    // 预置一条与稍后消息相关的记忆。
    const seed = new MemoryIndex(join(dataDir, 'memory-index.db'));
    seed.put({ text: '群主说他 2026-10-23 面试又失败了，后来没再提。', kind: 'episodic', importance: 0.7, eventTime: '2026-10-23' });
    seed.close();

    const cfg = makeCfg(mock.port);
    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const llm = new FakeLLM();
    llm.script(textReply(''));
    const bot: AssembledBot = assembleBot(loaded, { llm });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    mock.emitGroupMessage({ user_id: 8001, nickname: '辛', text: 'claude 面试那事你还记得吗' });
    const transcript = () => legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    await waitFor(() => transcript().includes(BLOCK_HEAD));
    const text = transcript();
    expect(text).toContain('面试');
    expect(text).toContain('过去的记录');

    await bot.stop();
  }, 30000);

  it('当批消息与旧事无关时不注入', async () => {
    const memoryDir = join(tmp.dir, 'persona2');
    const dataDir = join(tmp.dir, 'data2');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

    const seed = new MemoryIndex(join(dataDir, 'memory-index.db'));
    seed.put({ text: '群主说他 2026-10-23 面试又失败了，后来没再提。', kind: 'episodic', importance: 0.7 });
    seed.close();

    const cfg = makeCfg(mock.port);
    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const llm = new FakeLLM();
    llm.script(textReply(''));
    const bot: AssembledBot = assembleBot(loaded, { llm });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    mock.emitGroupMessage({ user_id: 8002, nickname: '壬', text: 'claude 今天天气怎么样' });
    await waitFor(() => legacyMessages(bot.core.session.records).length > 0);
    await sleep(300);

    const text = legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(text).not.toContain(BLOCK_HEAD);

    await bot.stop();
  }, 30000);

  it('同一块不再重复注入，但窗口清空后必须重新注入', async () => {
    const memoryDir = join(tmp.dir, 'persona4');
    const dataDir = join(tmp.dir, 'data4');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

    const seed = new MemoryIndex(join(dataDir, 'memory-index.db'));
    seed.put({ text: '群主说他 2026-10-23 面试又失败了，后来没再提。', kind: 'episodic', importance: 0.7, eventTime: '2026-10-23' });
    seed.close();

    const cfg = makeCfg(mock.port);
    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const llm = new FakeLLM();
    llm.script(textReply(''));
    const bot: AssembledBot = assembleBot(loaded, { llm });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    const reads = () => {
      try {
        return readFileSync(join(dataDir, 'wakes.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, any>);
      } catch {
        return [] as Array<Record<string, any>>;
      }
    };
    // 只看外部唤醒：开场的内部轮不算数。
    const external = () => reads().filter((w) => w.reason !== 'internal');
    const lastExternal = () => external()[external().length - 1]!;
    const transcript = () => legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    // 第一次：召回到，正常注入。
    mock.emitGroupMessage({ user_id: 8003, nickname: '癸', text: 'claude 面试那事你还记得吗' });
    await waitFor(() => transcript().includes(BLOCK_HEAD));
    await waitFor(() => (lastExternal()?.recall?.ids ?? 0) > 0);
    // 唤醒日志里记下注入块的前三条，事后能直接看出她当时眼前是哪几条旧事。
    expect((lastExternal().recall.heads ?? []).join(' ')).toContain('面试');
    expect(lastExternal().recall.skipped).toBeUndefined();

    // 第二次同一句话：块一字不差、还在窗口里——不重复占位，但记录里说明是为什么。
    mock.emitGroupMessage({ user_id: 8003, nickname: '癸', text: 'claude 面试那事你还记得吗' });
    await waitFor(() => external().length >= 2);
    expect(lastExternal().recall.ids).toBe(0);
    expect(lastExternal().recall.skipped).toBe('dup');

    // 窗口清空：那块已经不在了，同一句话必须重新放到她眼前。
    await bot.core.loop.clearSession();
    await waitFor(() => !transcript().includes(BLOCK_HEAD));
    mock.emitGroupMessage({ user_id: 8003, nickname: '癸', text: 'claude 面试那事你还记得吗' });
    await waitFor(() => transcript().includes(BLOCK_HEAD));
    await waitFor(() => external().length >= 3);
    expect(lastExternal().recall.ids).toBeGreaterThan(0);
    expect(lastExternal().recall.skipped).toBeUndefined();

    await bot.stop();
  }, 40000);

  it('群友改名之后，按 QQ 号仍然认得出来、找得到旧事', async () => {
    const memoryDir = join(tmp.dir, 'persona3');
    const dataDir = join(tmp.dir, 'data3');
    mkdirSync(join(memoryDir, 'people'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    // 他已经改名叫「橘子精」，档案里记着曾用名，还有她自己的看法。
    writeFileSync(
      join(memoryDir, 'people', 'qq-90010001.md'),
      '橘子精(90010001) — 群主。\n\n## 曾用名\n- 小橘\n\n## 我的看法\n- 2026-10-20 他要的不是顺从，是被认真对待\n',
      'utf8',
    );

    // 这条记忆写在改名之前，正文里只有旧名，而且与这次的消息毫无字面关系。
    const seed = new MemoryIndex(join(dataDir, 'memory-index.db'));
    seed.put({
      text: '小橘说他女儿今年上小学了，为此特意搬了家。',
      kind: 'episodic',
      importance: 0.7,
      eventTime: '2026-08-01',
      people: ['90010001'],
    });
    seed.close();

    const cfg = makeCfg(mock.port);
    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const llm = new FakeLLM();
    llm.script(textReply(''));
    const bot: AssembledBot = assembleBot(loaded, { llm });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    mock.emitGroupMessage({ user_id: 90010001, nickname: '橘子', card: '橘子精', text: 'claude 在吗' });
    const transcript = () => legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    await waitFor(() => transcript().includes('[这几条消息来自你认识的人'));
    const text = transcript();
    expect(text).toContain('橘子精(90010001)');
    expect(text).toContain('曾用名：小橘');
    expect(text).toContain('我的看法：');
    expect(text).toContain('他要的不是顺从');
    expect(text).toContain('女儿今年上小学');

    await bot.stop();
  }, 30000);

  it('纯表情叫醒：没有话题就不召回，别拿昵称凑', async () => {
    const memoryDir = join(tmp.dir, 'persona7');
    const dataDir = join(tmp.dir, 'data7');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

    const seed = new MemoryIndex(join(dataDir, 'memory-index.db'));
    seed.put({ text: '娶万里花，做万年梦 在我这儿改过三次昵称，每次只换一个字。', kind: 'episodic', importance: 0.9 });
    seed.close();

    const cfg = makeCfg(mock.port);
    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
    const llm = new FakeLLM();
    llm.script(textReply(''));
    const bot: AssembledBot = assembleBot(loaded, { llm });
    await bot.start();
    await bot.qqWorld!.waitReady(5000);

    // 只 @ 一下加一个表情：正文里没有任何话题词。
    mock.emitGroupMessage({
      user_id: 8101,
      nickname: '娶万里花，做万年梦',
      segments: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'face', data: { id: '1' } }],
    });
    await waitFor(() => legacyMessages(bot.core.session.records).length > 0);
    await sleep(500);

    const text = legacyMessages(bot.core.session.records)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(text).not.toContain(BLOCK_HEAD);

    await bot.stop();
  }, 30000);
});
