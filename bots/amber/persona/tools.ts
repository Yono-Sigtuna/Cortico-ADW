/**
 * Cormini 文件工具之外,这份人格实现自己的三样:memo 容量守门、`move_file`、
 * `schedule_wake` 的 schema,以及两条认知路径的 "Using your tools" 文案。
 */
import type { ToolDef, ToolSpec } from 'cortico/core/types.ts';
import { WorkspaceError, type GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { MemoTiers } from './memoTiers.ts';
import { RESIDENT_CAP } from './memory.ts';
import type { PersonaRole } from './permissions.ts';

/** JSON Schema 简写 */
const S = (props: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  required,
});

/** memo 三层归属(仅一级文件);其它路径返回 null */
function memoTierOf(ws: GitWorkspaceMemory, rel: string): 'resident' | 'active' | 'archived' | null {
  const n = ws.normalize(rel);
  if (/^memo\/active\/[^/]+$/i.test(n)) return 'active';
  if (/^memo\/archived\/[^/]+$/i.test(n)) return 'archived';
  if (/^memo\/[^/]+$/i.test(n)) return 'resident';
  return null;
}

const quote = (names: string[]): string =>
  names.length ? names.map((n) => `"${n}"`).join(', ') : '(none)';

/**
 * 容量守门:向已满的层新建文件时硬拦(容量是Persona的合法机械规则)。
 * 只拦"新增一个文件":覆写已存在的、同层内改名都不增加数量,放行。
 * fromRel 给出时(move_file)用于识别同层搬运。满时引导用 move_file 手动下沉。
 */
export function memoCapGuard(ws: GitWorkspaceMemory, memo: MemoTiers, destRel: string, fromRel?: string): string | null {
  const tier = memoTierOf(ws, destRel);
  const fromTier = fromRel ? memoTierOf(ws, fromRel) : null;
  if (tier === 'resident' && !ws.exists(destRel) && fromTier !== 'resident') {
    const residents = memo.residentFiles();
    if (residents.length >= memo.caps.residentCap) {
      return (
        `memo/ (resident, first ${RESIDENT_CAP} chars of each file show every prefix) is full (${residents.length}/${memo.caps.residentCap}). ` +
        `Move one down to memo/active/ with move_file first, then retry. Current residents: ${quote(residents)}.`
      );
    }
  }
  if (tier === 'active' && !ws.exists(destRel) && fromTier !== 'active') {
    const actives = memo.activeFiles();
    if (actives.length >= memo.caps.activeCap) {
      return (
        `memo/active/ is full (${actives.length}/${memo.caps.activeCap}). ` +
        `Move one down to memo/archived/ with move_file first, then retry. Current active/: ${quote(actives)}.`
      );
    }
  }
  return null;
}

export interface MoveFileDeps {
  ws: GitWorkspaceMemory;
  /** 写准入(同Persona的 writeGuard):返回理由就拒绝 */
  guard: (op: 'rename' | 'write', path: string, role: string) => string | null;
  capGuard: (to: string, from: string) => string | null;
}

export const MOVE_FILE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'move_file',
  description: 'Move or rename a file within your workspace. Use it to shift a memo between tiers when one is full '
    + '(memo/ → memo/active/ → memo/archived/); parent folders are created as needed.',
  tags: ['write'],
  parameters: S({
    from: { type: 'string', description: 'Current path, relative to your workspace.' },
    to: { type: 'string', description: 'New path, relative to your workspace.' },
  }, ['from', 'to']),
};

/** 工作区内移动或改名。memo 层间搬运走它;父目录按需创建。 */
export function moveFileTool(deps: MoveFileDeps): ToolDef {
  const { ws } = deps;
  return {
    ...MOVE_FILE_DECL,
    handler: async (args, ctx) => {
      const from = String(args.from ?? '');
      const to = String(args.to ?? '');
      if (!from || !to) return '[move failed] from 与 to 都要给';
      const denied = deps.guard('rename', from, ctx.role) ?? deps.guard('write', to, ctx.role) ?? deps.capGuard(to, from);
      if (denied) return `[move failed] ${denied}`;
      try {
        ws.renameFile(from, to);
      } catch (e) {
        if (e instanceof WorkspaceError) return `[move failed] ${e.message}`;
        return `[move failed] ${e instanceof Error ? e.message : String(e)}`;
      }
      return `[moved] ${ws.normalize(from)} → ${ws.normalize(to)}`;
    },
  };
}

/** `schedule_wake` 的 schema;handler 由Persona接到 WakeManager 上。 */
export function scheduleWakeSpec(): ToolSpec {
  return {
    name: 'schedule_wake',
    description:
      'Schedule a wake at either an absolute time or a relative number of minutes. Optionally block live event delivery until then, with a literal keyword for early wake and a bounded overflow release.',
    tags: ['flow'],
    parameters: {
      ...S({
        at: {
          type: 'string',
          description: 'Absolute ISO 8601 timestamp with timezone offset. Use either at or after_minutes.',
        },
        after_minutes: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Relative delay in minutes. Decimals are allowed; values below 10 seconds are raised to 10 seconds.',
        },
        note: { type: 'string', description: 'Text returned when the wake fires.' },
        block: {
          type: 'boolean',
          default: false,
          description:
            'If true, hold live event delivery until this wake fires or wake_keyword matches. Manual operator pause remains independent.',
        },
        wake_keyword: {
          type: 'string',
          minLength: 1,
          description:
            'Optional, only used with block=true. A case-sensitive literal substring match in a new external event wakes early and cancels this wake.',
        },
        overflow_limit: {
          type: 'integer',
          minimum: 1,
          default: 100,
          description:
            'Only used with block=true. When queued external events exceed this count, release the current batch once while keeping the block and scheduled wake active.',
        },
      }, ['note']),
      oneOf: [{ required: ['at'] }, { required: ['after_minutes'] }],
    },
  };
}

export function toolUsageText(role: PersonaRole, caps: { residentCap: number; activeCap: number }): string {
  switch (role) {
    case 'main':
      return [
        '# 使用工具',
        '',
        '* 路径相对工作区；工具 schema 说明各自用法，这里只讲跨工具的纪律。独立的调用并行做。',
        '* 外部世界只通过 `external_event_frame` 对你说话；user 消息里的 tick、唤醒、通知都不是别人在说。',
        '* 不经工具直接输出的字只有你自己看得见——要被听见就用发言工具。说完就 `end_turn`。',
        '* 对外发言每次显式填写 `life_update`：本人活动、地点或睡眠状态已改变（包括共同场景中的本人行动）就填活动对象，系统先保存再发言；未变或只是约好稍后变化填 null。日程空档新活动须给 `duration_minutes` 或 `until`，不能同时填。约好持续五分钟就用 `duration_minutes:5`，由运行时计算期限，不心算钟点；没重新约定期限就不重复填时间，避免重置。更新失败不会执行发言工具。安静地改变活动仍可单独调用 `advance_life`。',
        '',
        '# 东西放哪里',
        '',
        `* \`memo/\` 时间层：顶层文件常驻（每份只把开头 ${RESIDENT_CAP} 字放进前缀，全文用 \`read_file\` 读；共 ${caps.residentCap} 条），\`active/\` 只列名（${caps.activeCap} 条），\`archived/\` 冷存储。要紧的写在最前面。满了不会自动下沉——用 \`move_file\` 自己往下搬。`,
        '* `note/` 耐久层，按需读：`playbook/` 是行动前查的手册（名字见 MEMORY 0），`library/` 随便整理。',
        '* `external/` 是你的抽屉：`save_blob` 存的图在 `external/qq/images/`。',
        '* `MEMORY 0–4` 是醒来那一刻的快照；写入立刻落盘，快照要等下次交接才刷新。信工具回执，别信快照。',
        '',
        '# `people/`',
        '',
        '* 一个人一个文件；QQ 上的人用号命名（`people/qq-3124076548.md`），昵称变了只改首行、不新建。首行「当前昵称(QQ号) — 一句话」会抽进「我认识的人」，追加观察别改它——重写归梦。',
        '',
        '# 想起来',
        '',
        '* `recall_memory` 查长期记忆索引：发生过的事、谁是什么人、答应过什么。提起旧事或只有模糊印象时用它，别猜文件名。',
        '* 它给的是过去的记录：和此刻冲突时以此刻为准；没搜到不等于没发生。唤醒时的「想起来的一些旧事」是自动检索的，用到再提。',
        '',
        '# 认知纪律',
        '',
        '* 写的时候分清：发生过的事、别人宣称的事、你推断的事、你现在相信的事。',
        '* 说的时候先靠工作区；确实必要时才用专业层面的知识。',
      ].join('\n');
    case 'dream':
      return [
        '你是这个工作区唯一的改写者：读、写、追加、编辑、移动、删除全部开放，包括 CONSTITUTION.md。',
        '',
        '* `edit_file` 要求 old_string 精确匹配一次；大改就直接用 `write_file` 覆盖整个文件。',
        `* memo 三级就是普通目录，用 \`move_file\` 维持形状（常驻 ${caps.residentCap} 条，每份只有开头 ${RESIDENT_CAP} 字进前缀；active/ 最多 ${caps.activeCap} 条，archived/ 冷存储）；容量在写入时硬拦，写满先下沉。`,
        '* 改名纪律：调整 `people/` 下的文件名（别名字符串）时，绝不能丢掉还能用来找到某人的别名——破坏检索路径才是错误，改名本身不是。',
        '* 身份纪律：`people/` 里一个人一个文件，QQ 上的人一律 `qq-<QQ号>.md`。昵称变化只改首行，绝不为同一个人新建文件；发现同号多份就合并成 `qq-<号>.md`。旧昵称和别名留在正文或术语表里，可检索性靠它们，不靠文件名。',
        '* `remember` 写的是**一句能想起来的话**：第一人称、点到具体的人、时间已经换成具体日期、重要性 0–1。整理完工作区后调用它，把这次新形成的长期记忆落进索引；`recall_memory` 用同样的索引把过去的记录找回来。',
        '* 改 `CONSTITUTION.md` 凭判断，不凭时间：证据支持、现在必要、并且很可能长期有用，才改。没有固定等待期或证据数量要求。',
        '* 对 `CONSTITUTION.md` 的 `# 我喜欢的语言风格` 一节，跨会话、跨独立互动地看行为与反馈，归纳长期偏好，不要被最近一次反应带偏。',
        '* 结束时用 `surface(text)` 给醒着的主线留一句第一人称的睡眠总结——一次调用，结束本 session；没有值得说的就跳过。',
      ].join('\n');
  }
}

/** `leave_thread`：走的时候留一句，下次被叫醒时再递回来问一句"还作数吗"。 */
export function leaveThreadSpec(): ToolSpec {
  return {
    name: 'leave_thread',
    description:
      'Leave one sentence for the next time you are woken: something you wanted to say but the moment had passed, '
      + 'or a thread you want to pick up later. It is not sent to anyone; it is handed back to you once, the next '
      + 'time you are awake, as "还作数吗". One sentence in your own voice; a few at most.',
    tags: ['write'],
    parameters: {
      ...S({
        text: { type: 'string', minLength: 1, maxLength: 200, description: 'The sentence to keep, in your own words.' },
      }, ['text']),
    },
  };
}

/** `speak_later`：用开口额度约一个时刻说话；额度用完就不给。 */
export function speakLaterSpec(): ToolSpec {
  return {
    name: 'speak_later',
    description:
      'Schedule yourself to speak at a later moment, spending one of today\'s allowance (a few a day; unused ones '
      + 'carry over a little). Use it when you want to say something at a particular time rather than now — a '
      + 'check-in, a thought you want to come back to. It wakes you at that time with the text you leave; you still '
      + 'decide then whether to actually say it. When the allowance is gone the receipt says so — do not retry in a loop.',
    tags: ['flow'],
    parameters: {
      ...S({
        text: { type: 'string', minLength: 1, maxLength: 300, description: 'What you want to bring up when you wake.' },
        after_minutes: { type: 'number', exclusiveMinimum: 0, description: 'Delay in minutes.' },
        at: { type: 'string', description: 'Absolute ISO 8601 time with offset. Use either at or after_minutes.' },
      }, ['text']),
      oneOf: [{ required: ['at'] }, { required: ['after_minutes'] }],
    },
  };
}
