/**
 * 什么时候允许她主动，以及这一轮选哪一个机会。
 *
 * 门槛全在机会之外：她自己睡了、对方在安静时段、今天已经主动过了、
 * 刚开口没多久——任何一条成立就什么都不做。顺序是先看能不能，再看说什么。
 */
import { selectThought, type ThoughtSelection } from './models.ts';
import { creativeShareCandidate, curiosityCandidate, greetingCandidate, threadCandidate, topicCandidate, type SourceInput } from './sources.ts';
import type { ShareOffer } from '../creative/models.ts';
import type { RoomView } from '../roomView.ts';
import { inHourWindow, localHour, type CompanionSettings, type CompanionState } from './state.ts';

/** 全局最小间隔：主动完一句，至少半小时内不再找第二次。 */
const GLOBAL_COOLDOWN_MS = 30 * 60_000;
/** 精力低于这个值就不主动——累的时候人不会找话说。 */
const MIN_ENERGY = 0.3;

export interface ScheduleInput {
  now: number;
  timezone: string;
  settings: CompanionSettings;
  state: CompanionState;
  /** 当前精力 0–1（由 CompanionStore 推进）。 */
  energy: number;
  /** 记忆检索：话题机会用它判断"她懂不懂"。不给就不产生话题机会。 */
  recall?: (query: string, k: number) => Array<{ text: string; eventTime: string; kind: string }>;
  /** 她对这个人的看法。 */
  viewsOf?: (qq: string) => string[];
  /** QQ 号 → 当前称呼。 */
  nameOf?: (qq: string) => string;
  /** 某个会话最近的消息；不给就用本地缓存的那一小段。 */
  recentOf?: (conv: string) => Array<{ at: number; from: string; text: string }>;
  /** 内感受：社交电量与负荷（0–1）。由事件流算出来，不是梦写的。 */
  socialBattery?: number;
  load?: number;
  /** 关系约束：这个人在这个名单里时，不先去找他。 */
  relationBlock?: (qq: string) => string | null;
  /** 某个会话此刻的形状（World 数好的那几个数）；不给就按旧判据走。 */
  roomOf?: (conv: string) => RoomView | null;
  /** 她手上待分享的作品片段；没有就 null。 */
  creativeOffer?: () => ShareOffer | null;
  /** 她走的时候留的那句话；半小时到一天半之内、还没提过的才算数。 */
  threadNote?: () => { id: string; text: string; at: number } | null;
}

export interface Planned {
  selection: ThoughtSelection;
  conv: string;
  /** 这一次是把自己写的东西拿出来时，那一段是什么。 */
  creative?: ShareOffer;
  /** 这一次是拿话头当由头时，那条话头的 id（给出去就标记，不重复提）。 */
  threadId?: string;
}

/** 机会的来源。面板按它分「空下来时的自问 / 群话题 / 时段问候 / 自己的作品」。 */
export type CandidateKind = 'quiet' | 'topic' | 'greeting' | 'creative' | 'thread';

/** 此刻手上所有说得出口的话头，已按优先级排好。 */
export interface Pooled {
  conv: string;
  subject: string;
  kind: CandidateKind;
  candidate: NonNullable<ReturnType<typeof curiosityCandidate>>;
  priority: number;
  /** 这一条是由某句话头带出来的；给出去了就标记，不重复提。 */
  threadId?: string;
}

/** 会话是否在允许主动的名单里。群里只对具体的人说，不做广播。 */
export function scopeAllowed(settings: CompanionSettings, conv: string): boolean {
  return conv.startsWith('private:') ? settings.allowPrivate : settings.allowGroups;
}

/**
 * 现在为什么不能主动。
 *
 * 返回第一道没过的门，给面板看；`null` 表示门都过了，还要看有没有话头。
 * 顺序即优先级：先看能不能，再看说什么。
 */
export function gateReason(input: ScheduleInput): string | null {
  const { settings, state, now } = input;
  if (!settings.enabled) return '主动层未开启';
  if (!settings.allowPrivate && !settings.allowGroups) return '私聊与群聊的主动都关着';

  const hour = localHour(now, input.timezone);
  if (inHourWindow(hour, settings.quietStartHour, settings.quietEndHour)) {
    return `安静时段（${settings.quietStartHour}–${settings.quietEndHour} 点），不打扰`;
  }
  if (inHourWindow(hour, settings.sleepStartHour, settings.sleepEndHour)) {
    return `她自己的睡眠时段（${settings.sleepStartHour}–${settings.sleepEndHour} 点）`;
  }
  if (input.energy < MIN_ENERGY) return `精力 ${Math.round(input.energy * 100)}/100，低于 ${Math.round(MIN_ENERGY * 100)}`;
  // 内感受比精力更贴近"今天被说了多少"：电量低或负荷满，都不主动开口。
  if (settings.intero?.enabled !== false) {
    const low = settings.intero?.lowBattery ?? 0.3;
    const high = settings.intero?.highLoad ?? 0.85;
    if (input.socialBattery !== undefined && input.socialBattery < low) {
      return `社交电量 ${Math.round(input.socialBattery * 100)}%，这会儿不想主动找话说`;
    }
    if (input.load !== undefined && input.load > high) {
      return `手头负荷 ${Math.round(input.load * 100)}%，先不开口`;
    }
  }
  if (state.proactiveToday >= settings.dailyCap) return `今天已主动 ${state.proactiveToday}/${settings.dailyCap} 次`;
  if (state.lastProactiveAt !== null && now - state.lastProactiveAt < GLOBAL_COOLDOWN_MS) {
    return `刚主动过 ${Math.round((now - state.lastProactiveAt) / 60_000)} 分钟，半小时内不再找`;
  }
  return null;
}

/**
 * 此刻所有够格的话头。
 *
 * 只看"有没有、是什么"，不掷骰子——掷骰子那一步在 `planOnce` 里。
 * 面板要用它回答"现在有哪些候选"，不能靠猜。
 */
export function poolCandidates(input: ScheduleInput): Pooled[] {
  const { settings, state, now } = input;
  if (gateReason(input)) return [];
  const hour = localHour(now, input.timezone);

  const convs = Object.keys(state.convs).filter((key) => scopeAllowed(settings, key)).sort();
  const pooled: Pooled[] = [];
  for (const conv of convs) {
    const stored = state.convs[conv];
    const subject = stored.lastUserKey ?? conv.split(':')[1] ?? '';
    // 关系约束：刚越界或还信不过的人，不先去找他。
    if (subject && input.relationBlock?.(subject)) continue;
    // 群里没叫到她的消息不进投递批次，本地缓存看不到；以 World 的最近消息为准。
    const recent = input.recentOf?.(conv);
    const convState = recent && recent.length ? { ...stored, recent } : stored;
    const source: SourceInput = { conv, subject, now, hour, convState, settings };
    // 安静下来才轮到她开口；上一句还没人接就什么都不提。
    const quiet = curiosityCandidate({
      ...source,
      room: input.roomOf?.(conv) ?? null,
      waitingForAnswer: !!stored.openLoop,
    });
    if (quiet) pooled.push({ conv, subject, kind: 'quiet', candidate: quiet, priority: 0 });
    // 群话题：先看热闹、再看她懂不懂、最后看她是不是刚说过。没有检索能力就不产生这类机会。
    if (input.recall) {
      const topic = topicCandidate({
        ...source,
        topicToday: state.topicToday,
        recall: input.recall,
        viewsOf: input.viewsOf ?? (() => []),
        nameOf: input.nameOf ?? ((qq) => qq),
        room: input.roomOf?.(conv) ?? null,
      });
      if (topic) pooled.push({ conv, subject, kind: 'topic', candidate: topic, priority: 1 });
    }
    const greeting = greetingCandidate(source);
    if (greeting) pooled.push({ conv, subject, kind: 'greeting', candidate: greeting, priority: 2 });
  }

  // 话头：她走的时候留了句话。排在"这边安静够久"前面——那一种只是没人在说话，
  // 这一种是她手上真有一件没说完的事。同样只说给最近还在跟她说话的那个人。
  const note = input.threadNote?.() ?? null;
  if (note) {
    const target = convs
      .filter((key) => state.convs[key]?.lastUserAt != null)
      .sort((a, b) => (state.convs[b].lastUserAt ?? 0) - (state.convs[a].lastUserAt ?? 0))[0];
    const stored = target ? state.convs[target] : null;
    const subject = stored?.lastUserKey ?? target?.split(':')[1] ?? '';
    if (target && stored && !input.relationBlock?.(subject)) {
      const said = threadCandidate({
        conv: target,
        subject,
        now,
        hour,
        convState: stored,
        settings,
        room: input.roomOf?.(target) ?? null,
        waitingForAnswer: !!stored.openLoop,
        note,
      });
      if (said) pooled.push({ conv: target, subject, kind: 'thread', candidate: said, priority: -0.5, threadId: note.id });
    }
  }

  // 自己写的东西只说给最近还在跟她说话的那个人：没人接的群里掏出一段小说，是广播。
  const offer = input.creativeOffer?.() ?? null;
  if (offer) {
    const target = convs
      .filter((key) => state.convs[key]?.lastUserAt !== null)
      .sort((a, b) => (state.convs[b].lastUserAt ?? 0) - (state.convs[a].lastUserAt ?? 0))[0];
    const stored = target ? state.convs[target] : null;
    if (target && stored) {
      const subject = stored.lastUserKey ?? target.split(':')[1] ?? '';
      const creative = creativeShareCandidate({
        conv: target,
        subject,
        now,
        hour,
        convState: stored,
        settings,
        room: input.roomOf?.(target) ?? null,
        waitingForAnswer: !!stored.openLoop,
        offer,
      });
      if (creative) pooled.push({ conv: target, subject, kind: 'creative', candidate: creative, priority: -1 });
    }
  }

  // 未完话头优先于时段问候；同类按会话键排，保证同一时刻的选择可复现。
  pooled.sort((a, b) => a.priority - b.priority || a.conv.localeCompare(b.conv));
  return pooled;
}

export function planOnce(input: ScheduleInput): Planned | null {
  const { now } = input;
  for (const item of poolCandidates(input)) {
    const seed = `companion:${item.conv}`;
    const selection = selectThought(item.candidate.opportunity, item.candidate.thoughts, { now, seed });
    if (selection) {
      const offer = item.kind === 'creative' ? input.creativeOffer?.() ?? null : null;
      return {
        selection,
        conv: item.conv,
        ...(offer ? { creative: offer } : {}),
        ...(item.threadId ? { threadId: item.threadId } : {}),
      };
    }
  }
  return null;
}

/**
 * 面板用：现在为什么不说，或者说的是什么。
 *
 * 只读，不改任何状态——运维看一眼不该消耗她的机会。
 */
export function explain(input: ScheduleInput): { ok: boolean; reason: string } {
  const gate = gateReason(input);
  if (gate) return { ok: false, reason: gate };
  const planned = planOnce(input);
  if (!planned) return { ok: false, reason: '门都过了，这会儿没有该她开口的理由：群里在聊、或者她上一句还没人接、或者刚试过一次' };
  return { ok: true, reason: `有机会：${planned.selection.selected.summary.slice(0, 60)}` };
}

/** 面板用：此刻有哪些候选、各自从哪来。门没过时给出门的原因，候选为空。 */
export function inspect(
  input: ScheduleInput,
): { gate: string | null; candidates: Array<{ conv: string; kind: CandidateKind; summary: string }> } {
  const gate = gateReason(input);
  if (gate) return { gate, candidates: [] };
  return {
    gate: null,
    candidates: poolCandidates(input).map((item) => ({
      conv: item.conv,
      kind: item.kind,
      summary: item.candidate.thoughts[0]?.summary ?? '',
    })),
  };
}
