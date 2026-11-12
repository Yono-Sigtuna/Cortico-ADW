import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole } from 'cortico/protocol/open-responses/context-helpers.ts';
/** 交接快照进入串行后台整理队列；surface 结果通过 onEmergence 写入 MEMORY 3 并投递事件。 */
import type { ForkOptions, CoreApi, Logger, ToolDef } from 'cortico/core/types.ts';
import type { BotConfig } from '../../index.ts';
import { estimateMessagesTokens, nowIso } from 'cortico/core/util.ts';
import { GenerationError } from 'cortico/core/generation.ts';
import { closeDanglingCalls } from 'cortico/core/truncate.ts';
import { dreamDeferredNotes, dreamEpisode, dreamOrientation, dreamTask } from './prompts.ts';
import { episodeDigest } from './digest.ts';

const errorLogData = (error: unknown): { err: string; body?: string } => ({
  err: String(error),
  ...(error instanceof GenerationError ? { body: error.body.slice(0, 500) } : {}),
});

export const DREAM = 'dream';

/** 固定预留给任务说明、工具结果和输出的 token */
const DREAM_RESERVE_TOKENS = 8_000;

export interface DreamDeps {
  cfg: BotConfig;
  core: CoreApi;
  /** 梦的工具面(文件工具 + 只读 World 工具);surface 由本类每次现造 */
  dreamTools: () => ToolDef[];
  /** 梦那一面的 "Using your tools" 说明(引导里要带) */
  toolUsageText: () => string;
  log: Logger;
  onEmergence: (text: string) => void;
  /**
   * 今天是否还只有临时排程。为 true 时，第一次 `surface` 会被拦下，
   * 让梦先把日程写完——提示词已经要求过，但提示词不是闸门。
   */
  needsDailyPlan?: () => boolean;
}

export interface DreamStatus {
  dreaming: boolean;
}

export interface DreamScheduleOptions {
  /** 冷却期内被跳过的交接笔记：工作区相对路径，不在快照里，梦需要时自己读。 */
  deferredNotes?: string[];
}

export const SURFACE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'surface',
  description:
    'Hand a short sleep summary back to the waking thread. One call only; if nothing is worth returning, do not call this.',
  tags: ['flow'],
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The summary: a few sentences, first person, conclusion only.' },
    },
    required: ['text'],
  },
};

export class Dream {
  private readonly d: DreamDeps;
  private dreaming = false;
  /** 串行梦任务队列；每一项报告这场梦是否完整跑完。 */
  private chain: Promise<boolean> = Promise.resolve(true);

  constructor(deps: DreamDeps) {
    this.d = deps;
  }

  getStatus(): DreamStatus {
    return { dreaming: this.dreaming };
  }

  /** WebUI 工具编辑器用的梦侧工具 schema。 */
  getBaseToolSchemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    const defs = [...this.d.dreamTools(), makeSurfaceTool({ surfaced: { text: null } })];
    const seen = new Set<string>();
    return defs
      .filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)))
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** 强制入梦仍通过上下文交接事务,不创建独立生命周期。 */
  forceDreamAndTruncate(): boolean {
    if (this.dreaming) return false;
    return this.d.core.requestContextHandoff();
  }

  /** 将不可变快照排入队列，串行执行以避免并发写工作区。成功跑完报告 true。 */
  schedule(snapshot: ContextRecord[], options: DreamScheduleOptions = {}): Promise<boolean> {
    const run = (): Promise<boolean> => this.run(snapshot, options);
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  private async run(snapshot: ContextRecord[], options: DreamScheduleOptions = {}): Promise<boolean> {
    const { cfg, log } = this.d;
    this.dreaming = true;
    const started = Date.now();
    log.info('梦开始', { sessionMessages: snapshot.length, deferredNotes: options.deferredNotes?.length ?? 0 });
    try {
      // 引导追加在原快照后,以复用主 session 的 system 前缀缓存。
      const guide: ContextRecord = message('user', [
        dreamOrientation(),
        '━━━ Using your tools ━━━',
        this.d.toolUsageText(),
        dreamTask({ nowText: nowIso(cfg.timezone) }),
        ...(options.deferredNotes && options.deferredNotes.length > 0
          ? [dreamDeferredNotes(options.deferredNotes)]
          : []),
      ].join('\n\n'));

      const closed = closeDanglingCalls([...snapshot]);
      let head = 0;
      while (head < closed.length && hasRole(closed[head], 'system')) head++;
      const systemMsgs = closed.slice(0, head);
      const dynamic = closed.slice(head);
      const fixedTokens = estimateMessagesTokens([...systemMsgs, guide]);
      const budget = Math.min(
        cfg.dream.inheritTokens,
        Math.max(0, cfg.context.maxTokens - fixedTokens - DREAM_RESERVE_TOKENS),
      );
      // 不继承整段会话：那段里九成以上是每轮重复注入的状态、记忆与日程块。
      // 只给"这一段时间发生过什么"，需要细节时它自己读工作区。
      let capChars = Math.max(2_000, Math.floor(budget * 1.2));
      let digest = episodeDigest(dynamic, capChars);
      while (capChars > 2_000 && estimateMessagesTokens([message('user', digest.text)]) > budget) {
        capChars = Math.floor(capChars * 0.7);
        digest = episodeDigest(dynamic, capChars);
      }
      const episode = [message('user', dreamEpisode(
        digest.text ? digest : { text: '(no events in this stretch)', lines: 0, dropped: 0 },
      ))];

      const surfaced = { text: null as string | null };
      const summary = await this.spawn({
        id: DREAM,
        messages: [...systemMsgs, ...episode, guide],
        tools: [...this.d.dreamTools(), makeSurfaceTool({
          surfaced,
          nudged: { value: false },
          ...(this.d.needsDailyPlan ? { needsDailyPlan: this.d.needsDailyPlan } : {}),
          onBlocked: () => log.info('梦拦下 surface：今天的日程还是临时排程，先写日程'),
        })],
        stopWhen: () => surfaced.text !== null,
        maxTokens: cfg.dream.contextTokens,
        wrapUpHint: 'Wrap up: call surface now with a short sleep summary if worth it, otherwise end quietly.',
        nudge: {
          when: (lastContent) => surfaced.text === null && lastContent.trim().length > 0,
          message:
            '[system] Your text has not been captured for the waking thread. Call surface once with a short sleep summary, otherwise end quietly.',
        },
      });
      log.info('梦结束', {
        ms: Date.now() - started,
        episodeLines: digest.lines,
        episodeChars: digest.text.length,
        droppedLines: digest.dropped,
        surfaced: surfaced.text !== null,
        summary: (summary ?? '').slice(0, 300),
      });
      if (surfaced.text !== null) this.d.onEmergence(surfaced.text);
      return true;
    } catch (e) {
      log.error('梦失败', errorLogData(e));
      return false;
    } finally {
      this.dreaming = false;
    }
  }

  private spawn(opts: ForkOptions): Promise<string> {
    return this.d.core.spawnFork(opts);
  }
}

export interface SurfaceGate {
  surfaced: { text: string | null };
  /** 今天还没有她自己的日程时，第一次 surface 被拦下。 */
  needsDailyPlan?: () => boolean;
  /** 只拦一次：模型第二次坚持结束就放行，避免死循环。 */
  nudged?: { value: boolean };
  onBlocked?: () => void;
}

/**
 * 梦的出口。
 *
 * 出口比入口更能决定行为：`surface` 一旦成功，fork 就结束。所以"日程还没写"
 * 这件事拦在这里，而不是只写在提示词里——13:41 那次梦写完日记就直接 surface，
 * 提示词里明明要求过日程。
 */
export function makeSurfaceTool(gate: SurfaceGate): ToolDef {
  return {
    ...SURFACE_DECL,
    handler: async (args) => {
      const text = String(args.text ?? '').trim();
      if (!text) return '[bad input] text is empty';
      if (gate.surfaced.text !== null) return '[already surfaced once; ending]';
      if (!gate.nudged?.value && gate.needsDailyPlan?.() === true) {
        if (gate.nudged) gate.nudged.value = true;
        gate.onBlocked?.();
        return '[surface blocked] Today still has only the temporary schedule. '
          + 'Call write_daily_plan now with 8–10 real segments for today (times, what you were doing, where, the mood), '
          + 'then call surface again.';
      }
      gate.surfaced.text = text;
      return '[sleep summary captured; it reaches the waking thread when this fork ends]';
    },
  };
}
