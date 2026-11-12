/**
 * 机会的来源：此刻有什么事，值得她主动开口。
 *
 * 主动开口由**群的状态**决定，不按次数算：
 * - 一来一回正聊着 → 不开口，插进去就是打断；
 * - 空下来了 → 可以自己起一句，问一件她真想知道的事；
 * - 她上一句还没人接 → 什么都不提，追一句比不说更像催。
 *
 * 没有"随机冒泡"。随机不是生命感，是噪音。
 */
import type { CompanionSettings, ConvState } from './state.ts';
import type { RoomView } from '../roomView.ts';
import type { ShareOffer } from '../creative/models.ts';
import { opportunity, thought, type Candidate } from './models.ts';

/** 安静多久才算"空下来了"。 */
const QUIET_MINUTES = 45;
/** 同一段安静里只问一次：试过之后至少隔这么久，别把一次沉默反复打扰。 */
export const QUIET_RETRY_MINUTES = 180;

export interface SourceInput {
  conv: string;
  /** 对着谁说。 */
  subject: string;
  now: number;
  /** 本地小时，问候窗口用。 */
  hour: number;
  convState: ConvState;
  settings: CompanionSettings;
}

export interface QuietInput extends SourceInput {
  /** 群此刻的形状（World 数出来的）；私聊没有，退回"多久没说话"。 */
  room?: Pick<RoomView, 'heat' | 'lullMinutes'> | null;
  /** 她上一句还没人接：这时候不再提任何话。 */
  waitingForAnswer: boolean;
}

/**
 * 空下来之后的自问。
 *
 * 判据全在群的状态上：有人在一来一回地聊就不开口；安静够久才轮到她；
 * 上一句还没人接就彻底不提。剩下的由她自己决定说什么——想不出来就不说。
 */
export function curiosityCandidate(input: QuietInput): Candidate | null {
  if (input.waitingForAnswer) return null;

  const room = input.room;
  // 正聊着、或者消息还在涌：她自己的问题插进去只会变成打断。
  if (room && (room.heat === 'normal' || room.heat === 'busy' || room.heat === 'flood')) return null;

  const lastTalk = Math.max(input.convState.lastUserAt ?? 0, input.convState.lastBotAt ?? 0);
  const quietMinutes = room?.lullMinutes ?? (lastTalk > 0 ? (input.now - lastTalk) / 60_000 : Infinity);
  if (quietMinutes < QUIET_MINUTES) return null;

  const retry = Math.min(input.settings.followupCooldownMinutes, QUIET_RETRY_MINUTES) * 60_000;
  const lastAttempt = input.convState.lastAttemptAt;
  if (lastAttempt !== null && input.now - lastAttempt < retry) return null;

  const quiet = Number.isFinite(quietMinutes) ? `${Math.round(quietMinutes)} 分钟` : '有一阵子';
  const op = opportunity(input.conv, 'quiet', input.now, input.now + 30 * 60_000, input.subject);
  return {
    opportunity: op,
    thoughts: [
      thought(
        op,
        `这边已经 ${quiet}没人说话了，没人等你回。你可以自己起一句——问一件你确实想知道、而且他答得出来的事：`
        + '他上次提的那件事后来怎么样了、你今天看到或想到的东西、有件事你到现在还没弄明白。'
        + '不要问「在吗」「在干嘛」「吃了吗」这种谁都能接的空话。想不出来就不说，不说也算回答。',
        1,
      ),
      thought(
        op,
        `这边已经 ${quiet}没人说话了。换个切口：不一定要问他什么，可以说你此刻自己在想什么——`
        + '今天读到的、手上没做完的、忽然想到的一件事。真有事就说，没有就不发，别为了填空找个问题。',
        0.4,
      ),
    ],
  };
}

/**
 * 话头：她走的时候留了句"想回头再提"的话。
 *
 * 和"这边安静够久了"是两种由头——那一种只是没有别人在说话，这一种是她手上
 * 真有一件没说完的事。所以它排在前面，也不看安静了多久（但不能插进正在进行的对话）。
 */
export function threadCandidate(input: QuietInput & { note: { text: string; at: number } }): Candidate | null {
  if (input.waitingForAnswer) return null;
  const room = input.room;
  if (room && (room.heat === 'busy' || room.heat === 'flood')) return null;
  const op = opportunity(input.conv, 'thread', input.now, input.now + 30 * 60_000, input.subject);
  return {
    opportunity: op,
    thoughts: [
      thought(
        op,
        `你上次走的时候留了句话：「${input.note.text}」。要是还作数，就直接接着讲那件事——`
        + '不要提"我上次说过"，也不要解释自己为什么现在才说。不作数就算了，这一次可以什么都不发。',
        1,
      ),
    ],
  };
}

/** 时段问候：只对私聊。群里突然说"早安"是广播，不是陪伴。 */export function greetingCandidate(input: SourceInput): Candidate | null {
  if (!input.conv.startsWith('private:')) return null;
  const hour = input.hour;
  const slot = hour >= 7 && hour < 10 ? 'morning' : hour >= 18 && hour < 22 ? 'evening' : null;
  if (!slot) return null;
  // 六个小时内说过话，就不算"很久没见"，别硬塞问候。
  const last = Math.max(input.convState.lastUserAt ?? 0, input.convState.lastBotAt ?? 0);
  if (last && input.now - last < 6 * 3_600_000) return null;
  if (input.convState.lastAttemptAt !== null && input.now - input.convState.lastAttemptAt < input.settings.followupCooldownMinutes * 60_000) {
    return null;
  }
  const op = opportunity(input.conv, `greeting-${slot}`, input.now, input.now + 60 * 60_000, input.subject);
  const when = slot === 'morning' ? '早上' : '晚上';
  return {
    opportunity: op,
    thoughts: [
      thought(op, `现在是${when}，你们已经很久没说话了。可以只留一句带着你此刻生活的问候，说到位就停，不要追问对方在不在、也不要解释为什么联系。`, 1),
    ],
  };
}

export interface TopicInput extends SourceInput {
  /** 今天已经接过几次群话题。 */
  topicToday: number;
  /** 记忆检索；由 Persona 的索引提供。 */
  recall(query: string, k: number): Array<{ text: string; eventTime: string; kind: string }>;
  /** 她对这个人的看法（`people/` 里的「我的看法」）。 */
  viewsOf(qq: string): string[];
  /** QQ 号 → 当前称呼。 */
  nameOf(qq: string): string;
  /** 群里此刻的形状；一个人自言自语、或者消息还在涌的时候都轮不到她。 */
  room?: RoomView | null;
}

/** 一个人在群里连发不算"在聊"：至少要几个人来回。 */
const TOPIC_MIN_MESSAGES = 6;
const TOPIC_MIN_SPEAKERS = 2;
/** 刚被叫到之后的十分钟里，那属于正常回复，不是插话。 */
const ADDRESSED_GRACE_MS = 10 * 60_000;

/**
 * 群里正聊着的事，她有没有一句别人没说的。
 *
 * 四道判据缺一不可：**正在聊**（几条、几个人）、**她懂**（检索得到）、
 * **轮不到她**（刚被叫到、刚说过、刚试过）、**今天没接过**。
 * 过了这四道，模型还有一次说"不"的机会——由头里写清楚了：只是附和就别开口。
 */
export function topicCandidate(input: TopicInput): Candidate | null {
  if (!input.settings.participateGroups) return null;
  if (!input.conv.startsWith('group:')) return null;
  if (input.topicToday >= input.settings.topicDailyCap) return null;

  const windowMs = input.settings.topicWindowMinutes * 60_000;
  const recent = input.convState.recent.filter((m) => input.now - m.at <= windowMs);
  if (recent.length < TOPIC_MIN_MESSAGES) return null;
  const speakers = [...new Set(recent.map((m) => m.from).filter(Boolean))];
  if (speakers.length < TOPIC_MIN_SPEAKERS) return null;

  // 条数够不等于"现在正在聊"：窗口里有六条、之后静了二十分钟，那是聊完了。
  // 也不能是消息还在涌的那种快——那时候一句插话只是噪音。
  const room = input.room;
  if (room?.lullMinutes !== null && room?.lullMinutes !== undefined && room.lullMinutes > 10) return null;
  // 群里真在一来一回地聊时，她不插话——包括她自己想说的那种话。
  if (room?.heat === 'normal' || room?.heat === 'busy' || room?.heat === 'flood') return null;

  const c = input.convState;
  if (c.lastAddressedAt !== null && input.now - c.lastAddressedAt < ADDRESSED_GRACE_MS) return null;
  const cooldown = input.settings.followupCooldownMinutes * 60_000;
  if (c.lastBotAt !== null && input.now - c.lastBotAt < cooldown) return null;
  if (c.lastAttemptAt !== null && input.now - c.lastAttemptAt < cooldown) return null;

  // 她懂不懂：拿最近这几句去检索。检索不到，就没有可说的，别硬接。
  const query = recent.slice(-6).map((m) => m.text).join(' ').slice(0, 300);
  let hits: Array<{ text: string; eventTime: string; kind: string }> = [];
  try {
    hits = input.recall(query, 3);
  } catch {
    return null;
  }
  if (hits.length === 0) return null;

  const lastSpeaker = recent[recent.length - 1]?.from ?? '';
  const views = lastSpeaker ? input.viewsOf(lastSpeaker).slice(-1) : [];
  const who = lastSpeaker ? input.nameOf(lastSpeaker) : '有人';

  const digest = recent.slice(-5)
    .map((m) => `${clip(input.nameOf(m.from).split('(')[0] ?? m.from, 12)}：${clip(m.text, 40)}`)
    .join(' / ');
  const remembered = hits.slice(0, 2).map((h) => clip(h.text, 50)).join('；');
  const summary = [
    `群里正在聊：${clip(digest, 200)}`,
    `你记得相关的事：${clip(remembered, 140)}`,
    ...(views.length ? [`你对${who}的看法：${clip(views[0], 80)}`] : []),
    '只在你确实有别人没说的角度时开口——一个判断、一个反例、一段具体经验；'
      + '只是附和、重复、或者"你们说得对"，就什么都别说。',
  ].join('\n');

  const op = opportunity(input.conv, 'topic', input.now, input.now + windowMs, lastSpeaker);
  return {
    opportunity: op,
    thoughts: [
      thought(op, summary, 1),
      thought(op, `${summary}\n\n也可以不评价，只问一个具体的、你真的想知道答案的问题。`, 0.4),
    ],
  };
}

export interface CreativeInput extends QuietInput {
  /** 她手上刚写完的那一段。 */
  offer: ShareOffer;
}

/**
 * 把自己写的东西拿出来。
 *
 * 门槛和"空下来时自己起一句"一样：正聊着、或者上一句还没人接，都不提。
 * 这一条只把片段递到她眼前，说不说由她——没人接得住的东西，不做成广播。
 */
export function creativeShareCandidate(input: CreativeInput): Candidate | null {
  if (input.waitingForAnswer) return null;
  const room = input.room;
  if (room && (room.heat === 'normal' || room.heat === 'busy' || room.heat === 'flood')) return null;
  const cooldown = input.settings.followupCooldownMinutes * 60_000;
  if (input.convState.lastAttemptAt !== null && input.now - input.convState.lastAttemptAt < cooldown) return null;

  const { offer } = input;
  const stage = offer.milestone === 'finished' ? '写完了' : offer.milestone === 'midpoint' ? '写过大半了' : '刚开了个头';
  const op = opportunity(input.conv, 'creative', input.now, input.now + 6 * 60 * 60_000, input.subject);
  return {
    opportunity: op,
    thoughts: [
      thought(
        op,
        `你手上那篇《${clip(offer.title, 30)}》${stage}（${offer.currentChars}/${offer.targetChars} 字，${offer.chunkCount} 段）。`
        + `刚写下的一段：「${clip(offer.snippet, 200)}」\n`
        + '想给谁看一眼就说。他们没读过你写的东西——要说就先把「我在写什么、卡在哪」用大白话交代清楚，'
        + '别拿只有读过的人才懂的词去问他。'
        + '不想让人看就不说——写到这里本身就是它了，不欠谁一个交代。',
        1,
      ),
    ],
  };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
