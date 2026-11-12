/**
 * 话头与开口预算。
 *
 * 话头 = 她走的时候留一句，下次被叫醒时递回来问一句"还作数吗"。
 * 开口预算 = `speak_later` 每天有额度；用不完的可以带一点到第二天，总共封顶 1.5 倍。
 *
 * 两者都是状态而不是计时器：落盘 `data/threads.json`，重启接着算。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dayKey } from './companion/state.ts';

export interface ThreadNote {
  id: string;
  text: string;
  at: number;
  /** 提过就没有第二次：话头是一次性的，反复念会变成噪音。 */
  surfacedAt?: number;
}

interface SpeakState {
  day: string;
  used: number;
  /** 昨天没花完带过来的次数。 */
  carry: number;
}

interface FileShape {
  version: 1;
  threads: ThreadNote[];
  speak: SpeakState;
}

/** 最多留几条；再多就不是"走神时想起的事"，是待办清单。 */
const MAX_THREADS = 5;
/** 话头至少放这么久才算"回头再提"；太新鲜的还在刚才那段对话里。 */
const THREAD_OFFER_MIN_MS = 30 * 60_000;
/** 超过一天半还惦记着，多半自己也不打算说了。 */
const THREAD_OFFER_MAX_MS = 36 * 60 * 60_000;

export class ThreadStore {
  constructor(
    private readonly file: string,
    private readonly timezone: () => string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private load(): FileShape {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileShape>;
      return {
        version: 1,
        threads: Array.isArray(raw.threads) ? raw.threads.filter((t): t is ThreadNote => !!t && typeof t.text === 'string') : [],
        speak: raw.speak && typeof raw.speak.used === 'number'
          ? { day: String(raw.speak.day ?? ''), used: raw.speak.used, carry: Number(raw.speak.carry ?? 0) || 0 }
          : { day: '', used: 0, carry: 0 },
      };
    } catch {
      return { version: 1, threads: [], speak: { day: '', used: 0, carry: 0 } };
    }
  }

  private save(state: FileShape): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    renameSync(tmp, this.file);
  }

  /** 留一句话。超过上限时先丢已经提过的，再丢最旧的。 */
  leave(text: string): ThreadNote {
    const body = text.trim();
    const note: ThreadNote = { id: `${this.now()}-${Math.random().toString(36).slice(2, 6)}`, text: body, at: this.now() };
    if (!body) return note;
    const state = this.load();
    state.threads.push(note);
    while (state.threads.length > MAX_THREADS) {
      const surfaced = state.threads.findIndex((t) => t.surfacedAt !== undefined);
      state.threads.splice(surfaced >= 0 ? surfaced : 0, 1);
    }
    this.save(state);
    return note;
  }

  /** 还没提过的那条（最旧的）。 */
  pending(): ThreadNote | null {
    return this.load().threads.find((t) => t.surfacedAt === undefined) ?? null;
  }

  /**
   * 可以拿来做主动由头的话头。
   *
   * 半小时以内的属于刚才那段对话，不是"走神时想起的事"；一天半还惦记着的，
   * 多半自己也不打算说了。只取还没提过的最新一条。
   */
  offerable(now = this.now()): ThreadNote | null {
    const hit = this.load().threads
      .filter((t) => t.surfacedAt === undefined)
      .filter((t) => now - t.at >= THREAD_OFFER_MIN_MS && now - t.at <= THREAD_OFFER_MAX_MS)
      .sort((a, b) => b.at - a.at)[0];
    return hit ?? null;
  }

  /** 记下"已经递给她看过一次"。 */
  markSurfaced(id: string): void {
    const state = this.load();
    const hit = state.threads.find((t) => t.id === id);
    if (!hit || hit.surfacedAt !== undefined) return;
    hit.surfacedAt = this.now();
    this.save(state);
  }

  all(): ThreadNote[] {
    return this.load().threads;
  }

  /**
   * 今天的开口额度：`cap` + 结转，封顶 1.5 倍。
   * 换天时把昨天没花完的带过来（最多半个 cap），再清零。
   */
  speakAllowance(cap: number): { used: number; allowed: number; remaining: number } {
    const state = this.load();
    const speak = this.rollDay(state, cap);
    const allowed = this.allowedOf(cap, speak.carry);
    return { used: speak.used, allowed, remaining: Math.max(0, allowed - speak.used) };
  }

  /** 花掉一次开口额度；没额度就不给，并返回 false。 */
  spendSpeak(cap: number): boolean {
    const state = this.load();
    const speak = this.rollDay(state, cap);
    const allowed = this.allowedOf(cap, speak.carry);
    if (speak.used >= allowed) {
      this.save(state);
      return false;
    }
    speak.used += 1;
    this.save(state);
    return true;
  }

  private allowedOf(cap: number, carry: number): number {
    return Math.min(cap + carry, Math.ceil(cap * 1.5));
  }

  /** 换天就结算结转；同一天原样返回（可能已就地修改）。 */
  private rollDay(state: FileShape, cap: number): SpeakState {
    const today = dayKey(this.now(), this.timezone());
    if (state.speak.day === today) return state.speak;
    // 第一次运行没有"昨天"，不该凭空多给额度。
    const prevAllowed = state.speak.day ? this.allowedOf(cap, state.speak.carry) : 0;
    const leftover = Math.max(0, prevAllowed - state.speak.used);
    state.speak = {
      day: today,
      used: 0,
      carry: Math.min(leftover, Math.floor(cap * 0.5)),
    };
    this.save(state);
    return state.speak;
  }
}

/** 每次唤醒最多递回一条话头。 */
export function threadLine(note: ThreadNote): string {
  return `[你走的时候留了句话]「${note.text}」——还作数吗？作数就顺着它往下说；不作数就算了，不用解释。`;
}
