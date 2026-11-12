/**
 * 被问到时间的那一刻，把她需要的那一段日程放到她眼前。
 *
 * 生活块里已经有整条时间线，但它是一条"背景"：模型在回答具体问题时未必会
 * 去翻。这里多做一步——识别问题问的是哪段时间（现在 / 下午 / 刚才 / 今天），
 * 只挑出对应的几段，单独注入一次，并附上她上一句说过的话，提醒别复述。
 *
 * 只认明确的时间词与问句；识别不到就什么都不做，不猜。
 */
import { periodOf, type LifeSnapshot, type SlotView } from './lifeState.ts';

export type TimeScope = 'afternoon' | 'morning' | 'evening' | 'justnow' | 'now' | 'today';

/** 问题问的是哪段时间。识别不到返回 null。 */
export function detectTimeScope(text: string): TimeScope | null {
  const flat = text.replace(/\s+/g, '');
  if (/下午/.test(flat)) return 'afternoon';
  if (/上午|早上|早晨|一早/.test(flat)) return 'morning';
  if (/晚上|今晚|夜里/.test(flat)) return 'evening';
  if (/刚才|刚刚|刚刚才/.test(flat)) return 'justnow';
  if (/(在干嘛|在干什么|干什么呢|做什么|干啥|忙什么|忙啥|在忙吗)/.test(flat)) return 'now';
  if (/今天|一整天/.test(flat)) return 'today';
  return null;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function lineOf(slot: SlotView, max = 34): string {
  return `${slot.time}–${slot.end} ${slot.actual ? '实际' : '计划'}：${clip(slot.activity, max)}`;
}

function sliceOf(snapshot: LifeSnapshot, scope: TimeScope): { label: string; lines: string[] } | null {
  const { slots, current, next } = snapshot;
  const completed = slots.filter((slot) => slot.state === 'completed');
  switch (scope) {
    case 'afternoon':
      return { label: '下午', lines: slots.filter((slot) => periodOf(slot.startMin) === '下午').map((slot) => lineOf(slot)) };
    case 'morning':
      return { label: '上午', lines: slots.filter((slot) => periodOf(slot.startMin) === '上午' || periodOf(slot.startMin) === '早上').map((slot) => lineOf(slot)) };
    case 'evening':
      return { label: '晚上', lines: slots.filter((slot) => periodOf(slot.startMin) === '晚上').map((slot) => lineOf(slot)) };
    case 'justnow': {
      const last = completed.slice(-2);
      const lines = [...last.map((slot) => lineOf(slot)), ...(current ? [`（现在）${lineOf(current)}`] : [])];
      return { label: '刚才到现在', lines };
    }
    case 'now': {
      const target = current ?? next;
      return {
        label: '现在',
        lines: target ? [lineOf(target, 40)] : [],
      };
    }
    case 'today':
      return { label: '今天', lines: slots.map((slot) => lineOf(slot, 26)) };
    default:
      return null;
  }
}

/**
 * 针对这一问的注入块。没有可用段落时返回 null。
 *
 * `lastSent` 是她在这个会话里上一句真正发出去的话——用来提醒"这句刚说过"。
 */
export function groundingBlock(
  snapshot: LifeSnapshot,
  scope: TimeScope,
  lastSent: string | null = null,
): string | null {
  const slice = sliceOf(snapshot, scope);
  if (!slice) return null;
  if (!slice.lines.length && !lastSent) return null;

  const lines: string[] = [
    `[他问的是你的${scope === 'now' ? '此刻' : scope === 'today' ? '今天' : scope === 'justnow' ? '刚才到现在' : slice.label}]`
    + '（计划不等于已经做过；以已登记的实际活动为准。活动已经变化时通过发言的 life_update 同次提交或单独用 advance_life 登记，不要拿旧日程覆盖刚发生的变化。）',
  ];
  if (slice.lines.length) lines.push(`${slice.label}：`, ...slice.lines.map((line) => `- ${line}`));
  else lines.push(`${slice.label}：这一段没有安排。`);
  if (lastSent) {
    lines.push(`你上一句已经说过：「${clip(lastSent, 50)}」。这次别把同一件事再说一遍；要答就答上面这一段里真实的事。`);
  }
  return lines.join('\n');
}
