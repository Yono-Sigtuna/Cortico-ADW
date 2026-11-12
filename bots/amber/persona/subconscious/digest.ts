/**
 * 把交接前的快照压成「这一段时间发生了什么」。
 *
 * 梦不是第二个主意识，它只改文件。可它原先继承的是整个会话尾巴，实测其中
 * 用户消息**全部**是每轮重复注入的状态块、记忆召回、日程与动作许可，真正的
 * 事件走的是 `external_event_frame` 的工具回执。于是一次梦要为重读自己的注入
 * 付 211 万输入 token。
 *
 * 这里只留事实：来过什么、她说了什么、她动过哪些工具。文件回执一律不留——
 * 工作区就在她的盘上，需要细节时她自己读。
 */
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { itemText } from 'cortico/protocol/open-responses/context.ts';

/** 事件通过它的回执到达；这个名字的调用要留回执、不留调用本身。 */
const FRAME_TOOL = 'external_event_frame';
/** 结束一轮不产生事件摘要。 */
const SILENT_TOOLS = new Set(['end_turn']);
/** 单条事件最多留多少字；群里一屏图片链接能顶掉半篇日记。 */
const LINE_MAX = 600;
/** 交接笔记本身不是事件：它在盘上，也已经作为 deferredNotes 递给梦了。 */
const HANDOFF_NOTE = '交接笔记';
/** sidecar 里交接笔记的类型；按类型排除，一句别的消息提到它也不会被连带吞掉。 */
const HANDOFF_TYPE = 'handoff-note';

function clip(text: string, max: number): string {
  const flat = text.trim().replace(/https?:\/\/\S+/g, '[链接]').replace(/\s+/g, ' ');
  if (flat.length <= max) return flat;
  // 截断要能被读到：梦得知道自己少了多少，而不是以为这就是全部。
  return `${flat.slice(0, max)}…[后面 ${flat.length - max} 字未展开]`;
}

function argValue(args: unknown, key: string): string | null {
  if (typeof args !== 'string') return null;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function toolLine(name: string, args: unknown, receipt: string): string | null {
  if (name === 'qq_draft') {
    const text = argValue(args, 'text');
    const more = argValue(args, 'more');
    const image = argValue(args, 'image');
    const voice = argValue(args, 'voice');
    const said = [text, more].filter((t): t is string => !!t).join(' / ');
    const media = [image ? '图' : '', voice ? '语音' : ''].filter(Boolean).join('');
    if (!said && !media) return null;
    const body = `${clip(said, LINE_MAX)}${media ? `（${media}）` : ''}`;
    const receiptCount = (receipt.match(/\[sent(?: #\d+)?\s/g) ?? []).length;
    if (receiptCount) {
      const confirmed = receiptCount > 1 ? said : (text ?? '');
      return `[我说] ${clip(confirmed, LINE_MAX)}${media ? `（${media}）` : ''}`;
    }
    if (/failed|\[bad input\]/.test(receipt)) return null;
    return `[我起草，可能没发出] ${body}`;
  }
  const note = argValue(args, 'note') ?? argValue(args, 'text') ?? argValue(args, 'path') ?? '';
  return `[工具] ${name}${note ? ` ${clip(note, 120)}` : ''}`;
}

/** 去掉注入块，只留这一轮真正的输入。注入位置由 `context.internals` 记着。 */
function withoutInternals(record: ContextRecord, text: string): string {
  const spans = record.context.internals;
  if (!spans || spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  // 位置对不上就整段保留：宁可多读，也不要切出半句话。
  if (sorted.some((s) => s.start < 0 || s.start + s.chars > text.length)) return text;
  let cursor = 0;
  let out = '';
  for (const span of sorted) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start);
    cursor = span.start + span.chars;
  }
  return out + text.slice(cursor);
}

/** 按时间顺序把快照折成一行行事实。 */
export function episodeLines(records: readonly ContextRecord[]): string[] {
  const out: string[] = [];
  const frameCalls = new Set<string>();
  let pendingDraft: { args: unknown; lineIndex: number } | null = null;
  // 工具回执先收一遍：判断"她到底发出去没有"要用到它。
  const receipts = new Map<string, string>();
  for (const entry of records) {
    if (entry.item.type === 'function_call_output') receipts.set(entry.item.call_id, itemText(entry.item));
  }
  for (const entry of records) {
    // 合成开头项（语气卡的 few-shot 问答对）不是发生过的事。它们在快照里，
    // 之前被当成"她说过的话"成对送进日志——她连读六次都以为"旧素材又回来了"。
    if (entry.context.head) continue;
    const item = entry.item;
    if (item.type === 'function_call') {
      if (item.name === FRAME_TOOL) {
        frameCalls.add(item.call_id);
        continue;
      }
      if (SILENT_TOOLS.has(item.name)) continue;
      const receipt = receipts.get(item.call_id) ?? '';
      if (item.name === 'qq_confirm') {
        if (argValue(item.arguments, 'decision') === 'cancel') {
          pendingDraft = null;
        } else if (pendingDraft && /\[sent(?: #\d+)?\s/.test(receipt)) {
          const line = toolLine('qq_draft', pendingDraft.args, receipt);
          if (line) {
            if (pendingDraft.lineIndex < 0) {
              out.push(line);
              pendingDraft.lineIndex = out.length - 1;
            } else {
              out[pendingDraft.lineIndex] = line;
            }
          }
          if (!receipt.includes('[send failed]')) pendingDraft = null;
        }
        continue;
      }
      const line = toolLine(item.name, item.arguments, receipt);
      if (line) out.push(line);
      if (item.name === 'qq_draft') {
        // 回执里只要还带着没走完的标记，World 那边就仍留着 pendingDraft：
        // 扣下待确认、首发失败、第二拍失败或结果未知，都是还能再确认一次的。
        pendingDraft = /\[draft held|\[send failed|\[send uncertain/.test(receipt)
          ? { args: item.arguments, lineIndex: line ? out.length - 1 : -1 } : null;
      }
      continue;
    }
    if (item.type === 'function_call_output') {
      if (!frameCalls.has(item.call_id)) continue;
      const text = itemText(item);
      const refs = entry.context.frame?.events;
      // 新记录带逐事件 sidecar：按位置切开、按类型排除交接笔记，再一条一条裁剪。
      // 这样第一条再长也不会把末条的取消/纠正挤出 LINE_MAX。
      if (refs?.length && refs.every((r) => r.start >= 0 && r.start + r.chars <= text.length)) {
        for (const ref of refs) {
          if (ref.type === HANDOFF_TYPE) continue;
          const body = text.slice(ref.start, ref.start + ref.chars).trim();
          if (body) out.push(clip(body, LINE_MAX));
        }
        continue;
      }
      // 旧记录没有 sidecar：切不开，含交接笔记时仍整帧丢弃。
      const legacy = text.trim();
      if (!legacy || legacy.includes(HANDOFF_NOTE)) continue;
      out.push(clip(legacy, LINE_MAX));
      continue;
    }
    if (item.type === 'reasoning') continue;
    if (item.type === 'message') {
      const raw = itemText(item);
      // user 投递模式下事件拼在注入行后面，sidecar 用的是同一套位置：
      // 只取事件段，注入行和交接笔记都不进日志。
      const frameRefs = item.role === 'user' ? entry.context.frame?.events : undefined;
      if (frameRefs?.length && frameRefs.every((r) => r.start >= 0 && r.start + r.chars <= raw.length)) {
        for (const ref of frameRefs) {
          if (ref.type === HANDOFF_TYPE) continue;
          const body = raw.slice(ref.start, ref.start + ref.chars).trim();
          if (body) out.push(clip(body, LINE_MAX));
        }
        continue;
      }
      const body = item.role === 'user' ? withoutInternals(entry, raw) : raw;
      if (!body.trim()) continue;
      // 普通正文不代表已经通过 World 发出。
      out.push(item.role === 'assistant' ? `[我的正文，未确认对外发送] ${clip(body, LINE_MAX)}` : clip(body, LINE_MAX));
    }
  }
  return out;
}

export interface EpisodeDigest {
  text: string;
  lines: number;
  dropped: number;
}

/**
 * 折成一段可以直接给梦读的文字。
 *
 * 超预算时**从最早的一行开始丢**——梦整理的是最近这一段，队首那几条它已经
 * 在上一轮消化过，或者交接笔记里有。
 */
export function episodeDigest(records: readonly ContextRecord[], maxChars: number): EpisodeDigest {
  const lines = episodeLines(records);
  const kept: string[] = [];
  let used = 0;
  let index = lines.length - 1;
  for (; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.length + 1;
    if (used + cost > maxChars && kept.length > 0) break;
    kept.push(line);
    used += cost;
  }
  kept.reverse();
  return { text: kept.join('\n'), lines: kept.length, dropped: index + 1 };
}
