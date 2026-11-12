import { messages as legacyMessages } from '../core/fixture-protocol.ts';
/** 唤醒日志：一次唤醒一条，记录原因、上下文（前缀/卡片/事件）和动作。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBot, composeDefaults, type AssembledBot } from '../../bots/amber/assemble.ts';
import type { BotConfig } from '../../bots/amber/index.ts';
import { MockOneBot } from '../helpers/mock-onebot.ts';
import { FakeLLM, makeLoaded, makeTmpDir, toolReply, textReply, sleep } from '../core/helpers.ts';

const GROUP = 424246;
const SELF = 5004;

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

function readWakes(dataDir: string): Array<Record<string, any>> {
  try {
    return readFileSync(join(dataDir, 'wakes.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  } catch {
    return [];
  }
}

describe('amber 唤醒日志', () => {
  const tmp = makeTmpDir();
  let mock: MockOneBot;
  let bot: AssembledBot;
  let llm: FakeLLM;
  let dataDir = '';

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
    dataDir = join(tmp.dir, 'data');
    mkdirSync(join(memoryDir, 'note'), { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');
    // 常驻核心卡在 prompts/style/core/；资料库在工作区 note/style/，不该进每轮前缀。
    mkdirSync(join(tmp.dir, 'prompts', 'style', 'core'), { recursive: true });
    writeFileSync(join(tmp.dir, 'prompts', 'FIRST_TURN_USER.md'), '在吗？\n', 'utf8');
    writeFileSync(join(tmp.dir, 'prompts', 'FIRST_TURN_REPLY.md'), '在。\n', 'utf8');
    writeFileSync(join(tmp.dir, 'prompts', 'style', 'core', '01-comfort-user.md'), '我没事，真的。\n', 'utf8');
    writeFileSync(join(tmp.dir, 'prompts', 'style', 'core', '01-comfort-reply.md'), '像练过。药吃了吗？\n', 'utf8');
    mkdirSync(join(memoryDir, 'note', 'style'), { recursive: true });
    writeFileSync(join(memoryDir, 'note', 'style', '99-library-user.md'), '资料库里的问题\n', 'utf8');
    writeFileSync(join(memoryDir, 'note', 'style', '99-library-reply.md'), '资料库里的回答\n', 'utf8');

    const cfg = composeDefaults() as BotConfig;
    cfg.providers = {
      fixture: {
        kind: 'openai-responses-compat',
        baseUrl: 'https://model.test',
        spec: { model: 'test-model', thinking: true, reasoningEffort: 'low', temperature: 1 },
      },
    };
    cfg.activeProvider = 'fixture';
    // 单边提醒在陪伴层里，测试要打开它。
    cfg.companion = { ...cfg.companion, enabled: true };
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
      // 分数线拉高，好让"没人叫她的问句"稳定落在 background 档——这正是要验证的那一类。
      attention: { enabled: true, peripheryThreshold: 0.99, windowMinutes: 10, habituationMinutes: 30 },
    };
    cfg.worlds.console.enabled = false;
    cfg.context.firstTurn = true;
    cfg.batching.quietGapMs = 60;
    cfg.batching.maxBatchAgeMs = 400;
    cfg.tick.dayIntervalMinutes = [999, 999];
    cfg.tick.nightIntervalMinutes = null;
    cfg.web.port = 0;

    const loaded = makeLoaded({ config: cfg, rootDir: tmp.dir, memoryDir, dataDir });
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

  it('记下为什么醒、带了哪些卡、说了什么', async () => {
    llm.script(toolReply([{ name: 'qq_draft', args: { life_update: null, follow_up: null, to: `group:${GROUP}`, text: '在。' } }]));
    mock.emitGroupMessage({ user_id: 8001, nickname: '辛', text: 'clau 在吗' });
    await waitFor(() => mock.outbox.some((o) => o.action === 'send_group_msg'));

    await waitFor(() => readWakes(dataDir).some((w) => String(w.reason).includes('name')));
    const wake = [...readWakes(dataDir)].reverse().find((w) => String(w.reason).includes('name'))!;
    expect(String(wake.reason)).toContain('name');
    expect(wake.matchedName).toBe('claude');
    expect(wake.events.some((e: { wake?: string }) => e.wake === 'name')).toBe(true);
    expect(wake.context.cards).toEqual(expect.arrayContaining(['first', '01-comfort']));
    expect(wake.context.cards).not.toContain('99-library');
    expect(wake.context.prefixHash).toMatch(/^[0-9a-f]{16}$/);
    expect(wake.context.prefixChars).toBeGreaterThan(0);
    expect(wake.actions.calls.map((c: { name: string }) => c.name)).toContain('qq_draft');
    expect(String(wake.actions.sent)).toContain('[sent #');
    expect(wake.outcome).toBe('sent');
  });

  it('不说话也会记一条 silent', async () => {
    const nameCount = () => readWakes(dataDir).filter((w) => String(w.reason).includes('name')).length;
    const before = nameCount();
    llm.script(textReply(''));
    mock.emitGroupMessage({ user_id: 8002, nickname: '壬', text: 'claude' });
    await waitFor(() => nameCount() > before);
    const wake = [...readWakes(dataDir)].reverse().find((w) => String(w.reason).includes('name'))!;
    expect(String(wake.reason)).toContain('name');
    expect(wake.outcome).toBe('silent');
    expect(legacyMessages(bot.core.session.records).length).toBeGreaterThan(0);
  });

  it('写了正文却没调用工具：记为 unsent-text 并纠偏一次', async () => {
    const before = llm.calls.length;
    llm.script(textReply('这段是想说的话，但没有走 qq_draft。'));
    mock.emitGroupMessage({ user_id: 8003, nickname: '癸', text: 'claude 说点什么' });

    await waitFor(() => readWakes(dataDir).some((w) => w.outcome === 'unsent-text'));
    const wake = [...readWakes(dataDir)].reverse().find((w) => w.outcome === 'unsent-text')!;
    expect(wake.actions.sent).toBeNull();
    expect((wake.actions.assistant as string[]).join('')).toContain('没有走 qq_draft');

    // 纠偏会再发起一轮模型调用；空回复结束，不会无限循环。
    await waitFor(() => llm.calls.length >= before + 2);
    const nudge = readWakes(dataDir).filter((w) => String(w.reason).includes('internal'));
    expect(nudge.length).toBeGreaterThan(0);
  });

  it('被点名、写了正文、但这轮也调了工具：仍记为 unsent-text 并纠偏', async () => {
    const before = llm.calls.length;
    // 和真实那次一样：答案写在正文里，手上还顺手做了别的活（这里是读文件）。
    llm.script(toolReply(
      [{ name: 'read_file', args: { path: 'note/style/99-library-user.md' } }],
      '煮了碗青菜面，配两个煎蛋。',
    ));
    mock.emitGroupMessage({ user_id: 8004, nickname: '甲', text: 'claude 晚餐吃什么' });

    const hit = () => readWakes(dataDir)
      .find((w) => (w.actions?.assistant as string[] | undefined)?.join('').includes('青菜面'));
    await waitFor(() => Boolean(hit()));
    const wake = hit()!;
    expect(wake.outcome).toBe('unsent-text');
    expect(wake.actions.sent).toBeNull();
    expect(wake.actions.calls.map((c: { name: string }) => c.name)).toContain('read_file');

    // 纠偏同样会再发起一轮。
    await waitFor(() => llm.calls.length >= before + 2);
  });

  it('线索里叫醒、调过工具、写了正文却没发：仍记为 unsent-text 并纠偏', async () => {
    // 她查完资料把答案写在正文里，一个字都没发出去。这一轮确实调过工具，
    // 但那不叫"说过了"——工具不改变任何外部状态。
    const openOut = mock.outbox.length;
    llm.script(toolReply([{ name: 'qq_draft', args: { life_update: null, follow_up: null, to: `group:${GROUP}`, text: '嗯，我在听。' } }]));
    mock.emitGroupMessage({ user_id: 8009, nickname: '庚', text: 'claude 先聊两句' });
    await waitFor(() => mock.outbox.length > openOut);

    // 房间里还有别人在说：换个人插一句，房间就不再是"一对一"。
    mock.emitGroupMessage({ user_id: 8010, nickname: '辛', text: '我也在' });
    await sleep(200);

    const before = llm.calls.length;
    llm.script(toolReply(
      [{ name: 'read_file', args: { path: 'note/style/99-library-user.md' } }],
      '答案写在这里，没走 qq_draft。',
    ));
    mock.emitGroupMessage({ user_id: 8009, nickname: '庚', text: '那这个到底怎么算' });

    const hit = () => readWakes(dataDir)
      .find((w) => (w.actions?.assistant as string[] | undefined)?.join('').includes('没走 qq_draft'));
    await waitFor(() => Boolean(hit()), 15000);
    const wake = hit()!;
    expect(wake.outcome).toBe('unsent-text');
    expect(wake.actions.sent).toBeNull();
    expect(wake.actions.calls.map((c: { name: string }) => c.name)).toContain('read_file');

    // 纠偏会再发起一轮。
    await waitFor(() => llm.calls.length >= before + 2);
  });

  it('连着三轮只答不问：下一轮投递时递一次「把话头递回去」', async () => {
    // 上下文是累积的：只看"又多了几次"，不看"里面有没有"。
    const count = () => (JSON.stringify(llm.calls[llm.calls.length - 1]?.messages ?? [])
      .match(/没把话头递回去/g) ?? []).length;
    const baseline = count();
    for (let i = 0; i < 3; i++) {
      const outBefore = mock.outbox.length;
      llm.script(toolReply([{ name: 'qq_draft', args: { life_update: null, follow_up: null, to: `group:${GROUP}`, text: `嗯，第 ${i + 1} 次。` } }]));
      mock.emitGroupMessage({ user_id: 8005, nickname: '乙', text: `claude 第 ${i + 1} 问问你` });
      await waitFor(() => mock.outbox.length > outBefore);
    }
    const callsBefore = llm.calls.length;
    llm.script(toolReply([{ name: 'qq_draft', args: { life_update: null, follow_up: null, to: `group:${GROUP}`, text: '那你呢' } }]));
    mock.emitGroupMessage({ user_id: 8005, nickname: '乙', text: 'claude 还有呢' });
    await waitFor(() => llm.calls.length > callsBefore);
    expect(count()).toBe(baseline + 1);
  });

  it('旁听的一轮：没点名、房间里还有别人，写下的正文同样拿到一次纠偏', async () => {
    // 丙先叫一声，她答一句——这一句会记进房间，所以她还在场，不会被线索降级静音。
    const openOut = mock.outbox.length;
    llm.script(toolReply([{ name: 'qq_draft', args: { life_update: null, follow_up: null, to: `group:${GROUP}`, text: '嗯。' } }]));
    mock.emitGroupMessage({ user_id: 8006, nickname: '丙', text: 'claude 先叫一声' });
    await waitFor(() => mock.outbox.length > openOut);

    // 另一个人插一句：房间窗口里就有两个人在说了。
    mock.emitGroupMessage({ user_id: 8007, nickname: '戊', text: '我也在' });
    await sleep(200);

    const count = () => (JSON.stringify(llm.calls[llm.calls.length - 1]?.messages ?? [])
      .match(/你上一轮写下的文字没有发出去/g) ?? []).length;
    const baseline = count();
    llm.script(textReply('这句我想了想，没发。'));
    mock.emitGroupMessage({ user_id: 8006, nickname: '丙', text: '他们俩聊得挺热闹' });
    // 纠偏不是逼她开口，是把话交还给她：发不发由她定，不想说就 end_turn。
    // 放过的代价是写好的回复一个字都没出去，那个更贵。
    await waitFor(() => count() > baseline);
  });

  it('没叫到她的问句进背景：那个人下次叫她时一起递到', async () => {
    // 陌生人提个问：没点名、没开线，不该叫醒她。
    const quiet = llm.calls.length;
    mock.emitGroupMessage({ user_id: 8008, nickname: '己', text: '这个设置该怎么配，有没有人懂' });
    await sleep(400);
    expect(llm.calls.length).toBe(quiet);

    // 同一个人下次点名找她，那句问话跟着背景一起递到。
    const openOut = mock.outbox.length;
    llm.script(toolReply([{ name: 'qq_draft', args: { life_update: null, follow_up: null, to: `group:${GROUP}`, text: '在。' } }]));
    mock.emitGroupMessage({ user_id: 8008, nickname: '己', text: 'claude 你在吗' });
    await waitFor(() => mock.outbox.length > openOut);
    const last = JSON.stringify(llm.calls[llm.calls.length - 1]?.messages ?? []);
    expect(last).toContain('这个设置该怎么配');
  });
});
