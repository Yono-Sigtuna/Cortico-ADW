/**
 * 梦用来安排「今天怎么过」的那只手。
 *
 * 与 `maintain_state` 分开：那个改的是"你此刻的语气底色"，这个写的是
 * "你今天从起床到睡前有哪些段、在哪、吃什么、饿不饿、换没换衣服"。
 * 只在梦里出现——主意识正在说话，不该一边回消息一边重排自己的一天。
 */
import type { ToolDef } from 'cortico/core/types.ts';
import type { LifeStateStore } from './lifeState.ts';

const slotSchema = {
  type: 'object',
  properties: {
    time: { type: 'string', description: '开始时间 HH:MM。' },
    end: { type: 'string', description: '结束时间 HH:MM；跨午夜时可以小于 time。' },
    activity: {
      type: 'string',
      description:
        '这一段在做什么，具体到一个动作或一件事，例如「在改一段报错的代码」「把茶几上的杯子收进厨房」「绕着小区走了一圈」。'
        + '「处理事务」「休息」「做家务」这种空话不算。',
    },
    sleeping: { type: 'boolean', description: '这一整段是否已经在睡眠中。睡前看书、洗澡后睡等准备活动填 false；真正入睡的段填 true。' },
    mood: { type: 'string', description: '这一段的心境，一个词，例如「专注」「犯困」。' },
    messageSeed: {
      type: 'string',
      description:
        '那一段你可能自然说出口的一句话，例如「刚泡了茶」「外头风挺大」。每段都写一句——你醒来时会看见它。',
    },
    location: { type: 'string', description: '这一段在哪；家里、公司、外面都行。省略就按活动推断。' },
  },
  required: ['time', 'end', 'activity', 'sleeping'],
};

export const WRITE_PLAN_DECL: Omit<ToolDef, 'handler'> = {
  name: 'write_daily_plan',
  description:
    '写今天的日程。先决定今天是哪一种，别每天都排满：'
    + '· 有事要做的一天：12–16 段，每段落到具体的事（泡茶、擦桌子、浇花、晾衣服、洗澡、伸懒腰、出门走到哪条街），'
    + '写清在哪、什么心境；「处理事务」这种空话不算。至少三段在书桌以外，至少一段真的出门。'
    + '· 松下来的一天：3–5 段，只留起床、出门一趟、睡觉这几个点，其余留白。'
    + '· 不想安排的一天：1–2 段，或者干脆不写。'
    + 'sleeping 明确标记这一段是否在睡觉；准备睡觉仍是清醒活动。'
    + '一个人不会每天都做计划。相邻段不要重叠，可以从醒来一直排到准备睡觉。'
    + '同一天再次调用会整份覆盖——只有确实要改排法时才重写。',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      slots: {
        type: 'array',
        minItems: 0,
        maxItems: 20,
        description: '今天的时间段，按开始时间排序。不想安排就传空数组。',
        items: slotSchema,
      },
    },
    required: ['slots'],
  },
};

export const MAINTAIN_LIFE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'maintain_life',
  description:
    '更新你生活里的几件具体事：饿不饿、昨晚记住了什么梦、今天穿什么、现在在哪、周期从哪天算起。'
    + '天气与日程不在这里改——天气由部署配置，日程用 write_daily_plan。'
    + '只在有依据时改，并且只写你有把握的那几项。',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      hunger: { type: 'string', description: '例如「有点饿」「刚吃过，不饿」「无饥饿感」。' },
      dream: { type: 'string', description: '昨晚的梦；没记住就写「没有记住梦」。' },
      outfit: { type: 'string', description: '今天穿什么，一句话，例如「白衬衫，外套搭在椅背上」。' },
      location: { type: 'string', description: '此刻在哪；只在确实换了地方时写。' },
      cycleAnchor: { type: 'string', description: '最近一次月经开始那天，YYYY-MM-DD；只在本人提过时写。' },
    },
  },
};

export function writePlanTool(deps: { store: LifeStateStore }): ToolDef {
  return {
    ...WRITE_PLAN_DECL,
    handler: async (args) => {
      const slots = (args as { slots?: unknown }).slots;
      if (!Array.isArray(slots)) return '[plan unchanged] 缺少 slots';
      const result = deps.store.setPlan(slots as never, 'dream');
      return result.ok ? `[plan written] ${result.result}` : `[plan unchanged] ${result.result}`;
    },
  };
}

export const ADVANCE_LIFE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'advance_life',
  description:
    '单独登记本人已经发生的活动、地点或睡眠状态变化；不需要重新排一整天。'
    + '对外发言时可直接在发言工具的 life_update 中同次提交，不必重复调用本工具；更新失败不能假定状态已改变。'
    + '只是答应稍后去，或仍按原计划进行时，不提前登记。'
    + '日程空档或今天没有计划时也能用，须用 duration_minutes 或 until 明确期限；它单独登记实际活动，不创建整天日程，也不顺延后续计划。'
    + '相对时长从本次提交开始精确计算，不改原日程。绝对 until 用于已有日程段时，只延长当前段并顺延后续计划。',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      doing: { type: 'string', description: '现在实际在做什么，一句话，例如「被他们拖着在楼下吃到十一点」。' },
      sleeping: { type: 'boolean', description: '当前是否已经睡着，默认 false。开始睡眠填 true；醒来、外出、交谈填 false。' },
      duration_minutes: { type: 'number', exclusiveMinimum: 0, description: '从这次提交开始持续多少分钟，可填小数。相对五分钟填 5，由运行时计算，不能同时给 until；不重新约定期限时省略。' },
      until: { type: 'string', description: '绝对结束钟点 HH:MM，与 duration_minutes 互斥。空档新活动二选一；已有活动不写时间则保留原起止时间。' },
      location: { type: 'string', description: '现在在哪；没换地方就不写。' },
    },
    required: ['doing'],
  },
};

export function advanceLifeTool(deps: { store: LifeStateStore }): ToolDef {
  return {
    ...ADVANCE_LIFE_DECL,
    handler: async (args) => {
      const doing = typeof args.doing === 'string' ? args.doing : '';
      if (!doing.trim()) return '[life unchanged] doing 不能为空';
      if (args.until !== undefined && typeof args.until !== 'string') return '[life unchanged] until 必须是有效的 HH:MM';
      const until = typeof args.until === 'string' ? args.until : undefined;
      const location = typeof args.location === 'string' ? args.location : undefined;
      const duration = args.duration_minutes;
      if (duration !== undefined && typeof duration !== 'number') return '[life unchanged] duration_minutes 必须是正数';
      const result = deps.store.advance(doing, until, location, args.sleeping === true, duration);
      return result.ok ? `[life advanced] ${result.result}` : `[life unchanged] ${result.result}`;
    },
  };
}

export function maintainLifeTool(deps: { store: LifeStateStore }): ToolDef {
  return {
    ...MAINTAIN_LIFE_DECL,
    handler: async (args) => {
      const patch = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
      const location = typeof patch.location === 'string' ? patch.location.trim() : '';
      const result = deps.store.patch({
        ...(patch.hunger !== undefined ? { hunger: patch.hunger as string | null } : {}),
        ...(patch.dream !== undefined ? { dream: patch.dream as string | null } : {}),
        ...(patch.outfit !== undefined ? { outfit: patch.outfit as string | null } : {}),
        ...(patch.cycleAnchor !== undefined ? { cycleAnchor: patch.cycleAnchor as string | null } : {}),
      });
      if (location) {
        deps.store.setLocation(location);
        result.applied.push('location');
      }
      if (!result.applied.length) {
        return `[life unchanged] ${result.rejected.length ? result.rejected.join('；') : '没有可用的字段'}`;
      }
      const rejected = result.rejected.length ? `；忽略 ${result.rejected.join('、')}` : '';
      return `[life updated] ${result.applied.join('、')}${rejected}`;
    },
  };
}
