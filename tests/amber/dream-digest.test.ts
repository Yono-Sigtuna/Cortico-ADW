/** 梦只吃"这一段时间发生了什么"：注入块、思考、工具回执都不进它的上下文。 */
import { describe, it, expect } from 'vitest';
import { functionCall, functionResult, message, record } from '../../src/protocol/open-responses/context.ts';
import { episodeDigest, episodeLines } from '../../bots/amber/persona/subconscious/digest.ts';

const T = '2026-10-31T09:00:00+08:00';

/** 一轮典型的注入：整段都是注入块，一个字的事件都没有。 */
const injected = (text: string, spans: Array<{ start: number; chars: number; type: string }>) => message('user', text, {
  internals: spans.map((s, i) => ({ cursor: i + 1, ts: T, source: 'persona', ...s })),
});

/** 按 loop.ts 的写法造一帧：表头 + 事件正文换行拼接，sidecar 记录每段的位置和类型。 */
const frameResult = (callId: string, events: Array<{ text: string; type: string }>) => {
  const header = `[${events.length} new event${events.length === 1 ? '' : 's'}]`;
  let start = header.length + 1;
  const refs = events.map((e, i) => {
    const ref = { cursor: 100 + i, ts: T, type: e.type, source: 'qq', start, chars: e.text.length };
    start += e.text.length + 1;
    return ref;
  });
  return functionResult(callId, [header, ...events.map((e) => e.text)].join('\n'), {
    frame: { events: refs },
  });
};

describe('梦的增量事件 · 只留事实', () => {
  it('助手正文没有发送回执时不记为对外发言', () => {
    const lines = episodeLines([message('assistant', '我答应明天把资料发给你。')]);
    expect(lines.join('\n')).not.toContain('[我说]');
  });

  it('扣下的草稿经确认发送后只记一次已发送', () => {
    const lines = episodeLines([
      functionCall('d1', 'qq_draft', '{"text":"明天我把资料给你"}'),
      functionResult('d1', '[draft held → 群]'),
      functionCall('c1', 'qq_confirm', '{"decision":"send"}'),
      functionResult('c1', '[sent #9001 → 群]'),
    ]);
    expect(lines).toEqual(['[我说] 明天我把资料给你']);
  });

  it('两拍只有第一拍成功时不把第二拍记为已发', () => {
    const lines = episodeLines([
      functionCall('d2', 'qq_draft', '{"text":"第一拍","more":"第二拍"}'),
      functionResult('d2', '[send failed] [sent #9001 → 群]\n第二拍明确失败，可重试'),
    ]);
    expect(lines).toContain('[我说] 第一拍');
    expect(lines.join('\n')).not.toContain('[我说] 第二拍');
  });

  it('首发明确失败后确认重试成功，记录实际发出的内容', () => {
    const lines = episodeLines([
      functionCall('d5', 'qq_draft', '{"text":"重试后发出的话"}'),
      functionResult('d5', '[send failed] retcode=100; call confirm again to retry or cancel'),
      functionCall('c5', 'qq_confirm', '{"decision":"send"}'),
      functionResult('c5', '[sent #9003 → 群]'),
    ]);
    expect(lines).toEqual(['[我说] 重试后发出的话']);
  });

  it('取消草稿后不记为已发送', () => {
    const lines = episodeLines([
      functionCall('d3', 'qq_draft', '{"text":"这句话取消"}'),
      functionResult('d3', '[draft held → 群]'),
      functionCall('c3', 'qq_confirm', '{"decision":"cancel"}'),
      functionResult('c3', '[draft discarded (群)]'),
    ]);
    expect(lines.join('\n')).not.toContain('[我说] 这句话取消');
  });

  it('部分成功后确认补发，不重复记第一拍', () => {
    const lines = episodeLines([
      functionCall('d4', 'qq_draft', '{"text":"第一拍","more":"第二拍"}'),
      functionResult('d4', '[send failed] [sent #9001 → 群]\n第二拍明确失败，可重试'),
      functionCall('c4', 'qq_confirm', '{"decision":"send"}'),
      functionResult('c4', '[sent #9001 → 群]\n[sent #9002 → 群]'),
    ]);
    expect(lines).toEqual(['[我说] 第一拍 / 第二拍']);
  });

  it('注入块全部剥掉：一轮没有事件就不留一行', () => {
    const text = '[你自己此刻的状态]\n精力 87/100；准备休息\n[你今天的日子]\n09:00 起床';
    const lines = episodeLines([
      injected(text, [
        { start: 0, chars: '[你自己此刻的状态]\n精力 87/100；准备休息\n'.length, type: 'state' },
        { start: '[你自己此刻的状态]\n精力 87/100；准备休息\n'.length, chars: '[你今天的日子]\n09:00 起床'.length, type: 'ground' },
      ]),
    ]);
    expect(lines).toHaveLength(0);
  });

  it('注入块之外的正文留下：事件和注入拼在一条消息里时只丢注入', () => {
    const event = '#1 [群「g」 09:00] 甲(3001): 在吗\n';
    const state = '[你自己此刻的状态]\n精力 62/100';
    const lines = episodeLines([
      injected(event + state, [{ start: event.length, chars: state.length, type: 'state' }]),
    ]);
    expect(lines).toEqual(['#1 [群「g」 09:00] 甲(3001): 在吗']);
  });

  it('位置对不上就整段保留：宁可多读，也不切出半句话', () => {
    const lines = episodeLines([injected('原文', [{ start: 99, chars: 40, type: 'state' }])]);
    expect(lines).toEqual(['原文']);
  });

  it('外部事件走回执：留回执，不留那次调用', () => {
    const lines = episodeLines([
      functionCall('c1', 'external_event_frame', '{}'),
      functionResult('c1', '#1 [群「g」 09:06] 甲(3001): 咕咕嘎'),
    ]);
    expect(lines).toEqual(['#1 [群「g」 09:06] 甲(3001): 咕咕嘎']);
  });

  it('别的工具只留一行，回执一律不留——工作区在盘上', () => {
    const lines = episodeLines([
      functionCall('c2', 'read_file', '{"path":"note/cases/a.md"}'),
      functionResult('c2', '很长很长的文件内容'.repeat(200)),
    ]);
    expect(lines).toEqual(['[工具] read_file note/cases/a.md']);
  });

  it('说出的话记下来，第二段气泡也记', () => {
    const lines = episodeLines([
      functionCall('c3', 'qq_draft', '{"text":"早。","more":"今天有课吗"}'),
      functionResult('c3', '[sent #9001 → 群「g」]\n[sent #9002 → 群「g」]'),
    ]);
    expect(lines).toEqual(['[我说] 早。 / 今天有课吗']);
  });

  it('没发出去的草稿不算她说过：回执失败就整条不留', () => {
    const lines = episodeLines([
      functionCall('c3', 'qq_draft', '{"text":"早。","reply_to":"1"}'),
      functionResult('c3', '[send failed] no recorded QQ message with id #1; cannot quote-reply'),
    ]);
    expect(lines).toHaveLength(0);
  });

  it('草稿被扣下还没确认时，标成"起草"，不冒充说过', () => {
    const lines = episodeLines([
      functionCall('c3', 'qq_draft', '{"text":"等我一下"}'),
      functionResult('c3', '[draft held → 群「g」] 你写这条的时候他又发了一条'),
    ]);
    expect(lines).toEqual(['[我起草，可能没发出] 等我一下']);
  });

  it('发图只记"图"，不记链接', () => {
    const lines = episodeLines([
      functionCall('c4', 'qq_draft', '{"image":"https://x/y.png"}'),
      functionResult('c4', '[sent #9002 → 群「g」]'),
    ]);
    expect(lines).toEqual(['[我说] （图）']);
  });

  it('交接笔记不算事件：它在盘上，也已经作为 deferredNotes 递过去了', () => {
    const lines = episodeLines([
      functionCall('c6', 'external_event_frame', '{}'),
      functionResult('c6', '[1 new event]\n# 交接笔记 · 最近的一段(00:13–08:50)'),
    ]);
    expect(lines).toHaveLength(0);
  });

  it('混帧：交接材料和新消息在同一帧时只丢交接材料', () => {
    const handoff = '# 交接笔记 · 最近的一段(16:07–18:09)\n旧内容';
    const said = '#1 [群「g」 09:06] 甲(3001): 咕咕嘎';
    const lines = episodeLines([
      functionCall('c7', 'external_event_frame', '{}'),
      frameResult('c7', [{ text: handoff, type: 'handoff-note' }, { text: said, type: 'qq.message' }]),
    ]);
    expect(lines).toEqual([said]);
  });

  it('user 投递模式：事件段按 sidecar 取，注入行和交接笔记都不进日志', () => {
    const injectedLine = '[你自己此刻的状态]\n精力 50';
    const handoff = '# 交接笔记 · 最近的一段\n旧内容';
    const said = '#1 [群「g」 09:06] 甲(3001): 咕咕嘎';
    const text = [injectedLine, handoff, said].join('\n');
    const handoffStart = injectedLine.length + 1;
    const saidStart = handoffStart + handoff.length + 1;
    const rec = message('user', text, {
      internals: [{ cursor: 3, ts: T, source: 'persona', type: 'state', start: 0, chars: injectedLine.length }],
      frame: {
        events: [
          { cursor: 1, ts: T, type: 'handoff-note', source: 'persona', start: handoffStart, chars: handoff.length },
          { cursor: 2, ts: T, type: 'qq.message', source: 'qq', start: saidStart, chars: said.length },
        ],
      },
    });
    expect(episodeLines([rec])).toEqual([said]);
  });

  it('普通外部消息提到「交接笔记」不会被整帧吞掉', () => {
    const said = '#1 [群「g」 09:06] 甲(3001): 交接笔记我也看过';
    const lines = episodeLines([
      functionCall('c8', 'external_event_frame', '{}'),
      frameResult('c8', [{ text: said, type: 'qq.message' }]),
    ]);
    expect(lines).toEqual([said]);
  });

  it('长帧按事件裁剪：第一条再长也不挤掉末条的取消', () => {
    const long = `#1 [群「g」 09:00] 甲(3001): 刚翻到一段旧文${'废'.repeat(1200)}`;
    const cancel = '#2 [群「g」 09:01] 甲(3001): 取消刚才的约定';
    const lines = episodeLines([
      functionCall('c9', 'external_event_frame', '{}'),
      frameResult('c9', [{ text: long, type: 'qq.message' }, { text: cancel, type: 'qq.message' }]),
    ]);
    const joined = lines.join('\n');
    expect(joined).toContain('取消刚才的约定');
    expect(joined).toContain('未展开');
    expect(joined).not.toContain('废'.repeat(700));
  });

  it('单条事件被截断时写明少了多少字', () => {
    const long = '长'.repeat(900);
    const lines = episodeLines([
      functionCall('c10', 'external_event_frame', '{}'),
      frameResult('c10', [{ text: long, type: 'qq.message' }]),
    ]);
    expect(lines.join('\n')).toContain('300 字未展开');
  });

  it('合成开头项（语气卡的问答对）不进日志：它们不是发生过的事', () => {
    // 这些是 context.head 的 few-shot 对，在快照里但不在历史里。
    // 当成"她说过的话"送进去，她会以为旧素材被成对重放——连读六次都这么记。
    const lines = episodeLines([
      message('user', '大小姐，你今天怎么这么安静', { head: true }),
      message('assistant', '说服我？你们先把自己那段逻辑复盘一遍', { head: true }),
    ]);
    expect(lines).toHaveLength(0);
  });

  it('没有发送回执的正文保留第一人称，并标明未确认发送', () => {
    const lines = episodeLines([message('assistant', '（停下笔）上午在理随笔。')]);
    expect(lines).toEqual(['[我的正文，未确认对外发送] （停下笔）上午在理随笔。']);
  });

  it('思考与 end_turn 不进日志', () => {
    const lines = episodeLines([
      record({ type: 'reasoning', id: 'r1', status: 'completed', content: [{ type: 'reasoning_text', text: '我想了很多' }] } as never),
      functionCall('c5', 'end_turn', '{}'),
    ]);
    expect(lines).toHaveLength(0);
  });
});

describe('梦的增量事件 · 预算', () => {
  it('超预算从最早的一行开始丢，留下最近的', () => {
    const entries = Array.from({ length: 20 }, (_, i) => message('user', `第${i}件事`));
    const digest = episodeDigest(entries, 20);
    expect(digest.dropped).toBeGreaterThan(0);
    expect(digest.text).toContain('第19件事');
    expect(digest.text).not.toContain('第0件事');
  });

  it('预算足够时一行不丢，按原顺序连起来', () => {
    const digest = episodeDigest([message('user', '甲'), message('user', '乙')], 1000);
    expect(digest.text).toBe('甲\n乙');
    expect(digest.dropped).toBe(0);
  });

  it('单条超长的会被截断，不会顶掉整段预算', () => {
    const digest = episodeDigest([message('user', '长'.repeat(5000))], 2000);
    expect(digest.text.length).toBeLessThan(700);
  });
});
