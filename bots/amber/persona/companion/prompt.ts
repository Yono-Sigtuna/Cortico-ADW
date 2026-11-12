/**
 * 主动时刻的提示文本。
 *
 * 它要同时做三件事：说清"这是你自己想开口，不是有人找你"；给出一个具体的由头；
 * 明确允许她什么都不做。缺了第三件，任何"主动"都会退化成凑存在感。
 */
import type { ThoughtSelection } from './models.ts';

export interface OpportunityPrompt {
  now: number;
  timezone: string;
  selection: ThoughtSelection;
  conv: string;
  /** 称呼：`名字(QQ号)`；没有档案时只有号。 */
  subjectName: string;
  /** 距上一次和这个人说话多少分钟；不知道就不写。 */
  gapMinutes: number | null;
  energy: number;
  /** 群里第几次主动；用来提醒"别把一天写成同一个句式"。 */
  proactiveToday: number;
}

export function buildOpportunityText(input: OpportunityPrompt): string {
  const { selection } = input;
  const when = clock(input.now, input.timezone);
  const period = periodOf(input.now, input.timezone);
  const where = input.conv.startsWith('group:') ? '群里' : '私聊里';
  const lines: string[] = [
    `[主动时刻] 现在是 ${when}（${period}）。这不是有人给你发消息，是你自己在${where}想开口。`,
    `由头：${selection.selected.summary}`,
  ];

  if (input.gapMinutes !== null && input.gapMinutes > 0) {
    lines.push(`时间感：距上一次和 ${input.subjectName} 说话，${humanGap(input.gapMinutes)}。按这个间隔说话，不要把它说成很久不见。`);
  } else {
    lines.push(`时间感：${input.subjectName} 刚说过话不久，你还在这段对话里。`);
  }
  if (input.energy < 0.5) lines.push('你现在的精力不高，语气会平一点、短一点，这是正常的。');
  if (input.proactiveToday >= 2) lines.push('今天你已经主动过几次了。这一次如果要开口，换个切口，不要重复上几次的句式。');

  lines.push(
    '',
    '怎么说：',
    `- 称呼用当前的叫法（${input.subjectName}），不要用旧昵称。`,
    '- 先说你想说的那件具体的事，不要以"在吗""最近怎么样"开场。',
    '- 一句话到两句话，说到了就停，不要追问，也不要为了把话说完再补一条。',
    '- 不催对方回复，不解释沉默，不说"想聊就找我""不回也没关系"。',
    '',
    '不想说就什么都不做，直接结束这一轮——这个回合本来就可以什么都不做。',
    '如果要说，用 qq_draft 发出去。',
  );
  return lines.join('\n');
}

function clock(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(now));
}

function periodOf(now: number, timezone: string): string {
  const hour = Number(clock(now, timezone).slice(0, 2));
  if (hour < 5) return '凌晨';
  if (hour < 9) return '早上';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 23) return '晚上';
  return '深夜';
}

function humanGap(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} 分钟前`;
  const hours = minutes / 60;
  if (hours < 24) return `约 ${Math.round(hours)} 小时前`;
  return `约 ${Math.round(hours / 24)} 天前`;
}
