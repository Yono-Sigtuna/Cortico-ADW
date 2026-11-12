import { messages as legacyMessages } from '../core/fixture-protocol.ts';
/** 对话线索：叫到或回过之后保持开启，不设过期；跨重启仍在；可以显式关闭。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, type AssembledBot } from '../../bots/corti-soulmate/assemble.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, toolReply, textReply, sleep } from '../core/helpers.ts';

const GROUP = 424245;
const SELF = 5003;

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

describe('QQ 对话线索', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;
  let mockPort = 0;
  let bot: AssembledBot;
  let llm: FakeLLM;

  const memoryDir = () => join(tmp.dir, 'persona');
  const dataDir = () => join(tmp.dir, 'data');

  async function startBot(): Promise<{ bot: AssembledBot; llm: FakeLLM }> {
    const cfg = makeCfg();
    cfg.worlds.qq = {
      ...cfg.worlds.qq,
      enabled: true,
      wsUrl: `ws://127.0.0.1:${mockPort}`,
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
    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir: memoryDir(), dataDir: dataDir() });
    const fake = new FakeLLM();
    const assembled = assembleBot(loaded, { llm: fake });
    await assembled.start();
    await assembled.qqWorld!.waitReady(5000);
    await waitFor(() => fake.calls.length >= 1);
    return { bot: assembled, llm: fake };
  }

  beforeAll(async () => {
    mock = new MockOneBot({
      port: 0,
      groupId: GROUP,
      selfId: SELF,
      selfNickname: 'bot',
      selfCard: 'botcard',
      groupName: '测试群',
    });
    mockPort = await mock.start();
    mkdirSync(join(memoryDir(), 'note'), { recursive: true });
    writeFileSync(join(memoryDir(), 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

    const started = await startBot();
    bot = started.bot;
    llm = started.llm;
  }, 20000);

  afterAll(async () => {
    await bot.stop();
    await mock.close();
  });

  it('叫到名字后，隔一段时间不叫名字也唤醒', async () => {
    // 她这轮要真的发出去：沉默后的短陈述不该单独叫醒她，
    // 所以"她说过话"必须按发出去算，只写正文不算。
    llm.script(toolReply([{ name: 'qq_draft', args: { follow_up: null, to: `group:${GROUP}`, text: '在。' } }]));
    mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: 'clau 在吗' });
    await waitFor(() => llm.calls.length >= 2);

    // 没有计时器：等多久都成立，这里只等一个明显的间隔。
    await sleep(700);
    const before = llm.calls.length;
    llm.script(textReply('嗯。'));
    mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: '我没事，真的。骗你的事我道歉' });
    await waitFor(() => llm.calls.length > before);
    expect(sessionText(bot)).toContain('骗你的事我道歉');
  });

  it('线索只对开线的人生效', async () => {
    const before = llm.calls.length;
    mock.emitGroupMessage({ user_id: 7002, nickname: '庚', text: '随便说一句，没有叫名字' });
    await sleep(400);
    expect(llm.calls.length).toBe(before);
  });

  it('线索开着，但这条是在跟别人说：不叫醒', async () => {
    // 自己先把线索打开：叫一声，线程就挂在 7001 身上了。
    const openCalls = llm.calls.length;
    llm.script(textReply('在。'));
    mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: 'clau 先说一句' });
    await waitFor(() => llm.calls.length > openCalls);
    await sleep(100);

    const before = llm.calls.length;
    // @ 了别人：跟她说和跟别人说，是两件事。
    mock.emitGroupMessage({
      user_id: 7001,
      nickname: '己',
      segments: [
        { type: 'at', data: { qq: '7002' } },
        { type: 'text', data: { text: ' 你刚才说的那个' } },
      ],
    });
    await sleep(400);
    expect(llm.calls.length).toBe(before);

    // 引用别人的消息：同样不是对她说的。
    const quoted = mock.emitGroupMessage({ user_id: 7002, nickname: '庚', text: '我在这儿说一句' });
    await sleep(200);
    mock.emitGroupMessage({
      user_id: 7001,
      nickname: '己',
      segments: [
        { type: 'reply', data: { id: String(quoted) } },
        { type: 'text', data: { text: ' 对，就这个' } },
      ],
    });
    await sleep(400);
    expect(llm.calls.length).toBe(before);
  });

  it('线索开着，但房间里两个人正在互相说：不叫醒', async () => {
    // 己先叫一声，把线开着（点名不受"旁听"规则影响）。
    const openCalls = llm.calls.length;
    llm.script(textReply('嗯。'));
    mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: 'clau 还在吗' });
    await waitFor(() => llm.calls.length > openCalls);
    await sleep(100);

    // 另一个人插进来，然后两人一来一回。
    mock.emitGroupMessage({ user_id: 7003, nickname: '辛', text: '我刚看完那篇讲缓存失效的文章，写得挺细' });
    await sleep(200);

    const before = llm.calls.length;
    mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: '那篇我上周也翻过，最后那段我还是没看懂' });
    await sleep(400);
    expect(llm.calls.length).toBe(before);
  });

  it('重启后线索仍然存在', async () => {
    await bot.stop();
    const started = await startBot();
    bot = started.bot;
    llm = started.llm;

    const before = llm.calls.length;
    llm.script(toolReply([{ name: 'qq_draft', args: { follow_up: null, to: `group:${GROUP}`, text: '嗯，回来了。' } }]));
    mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: '刚才洗了个澡，接着说吧。' });
    await waitFor(() => llm.calls.length > before);
    expect(sessionText(bot)).toContain('刚才洗了个澡');
  });

  it('可以用 qq_thread_close 关掉线索', async () => {
    const before = llm.calls.length;
    llm.script(
      toolReply([{ name: 'qq_thread_close', args: { to: `group:${GROUP}`, person: '7001' } }]),
      textReply('那就到这儿。'),
    );
    mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: '这句会唤醒并顺手关线。' });
    await waitFor(() => llm.calls.length > before);
    await waitFor(() => sessionText(bot).includes('[thread closed]'));

    const afterClose = llm.calls.length;
    mock.emitGroupMessage({ user_id: 7001, nickname: '己', text: '关了之后这句不该唤醒' });
    await sleep(400);
    expect(llm.calls.length).toBe(afterClose);
  });
});
