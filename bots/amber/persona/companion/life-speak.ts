import type { ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import type { LifeStateStore } from './lifeState.ts';

const decision = {
  type: ['object', 'null'],
  description: '必填：本次本人活动、地点或睡眠没有变化，或只是约好稍后变化，填 null；已经变化填对象。同一共同场景中已经到窗边、开始听曲等本人行动也要登记，不需要另外再调 advance_life。',
  properties: {
    doing: { type: 'string', minLength: 1, maxLength: 120, description: '当前已经在做的活动。' },
    sleeping: { type: 'boolean', description: '现在是否已经睡着，不能根据准备睡觉判断为 true。' },
    location: { type: 'string', maxLength: 40, description: '当前地点，位置变化时明确填写。' },
    duration_minutes: { type: 'number', exclusiveMinimum: 0, description: '从本次提交开始持续多少分钟，可填小数。说“五分钟”就填 5，由运行时计算，不要心算 until；与 until 互斥。更新已有活动而没重新约定期限时省略，避免重置计时。' },
    until: { type: 'string', description: '明确约定的绝对结束钟点 HH:MM；与 duration_minutes 互斥。空档新活动二选一，相对时长优先用 duration_minutes。' },
  },
  required: ['doing', 'sleeping'],
  additionalProperties: false,
};

function failed(reason: string): ToolOutcome {
  return { text: `[life failed] ${reason}；发言工具未执行。补齐 life_update 后重新调用。`, failed: true };
}

export function withLifeUpdate(tool: ToolDef, store: LifeStateStore): ToolDef {
  const properties = tool.parameters.properties as Record<string, unknown> | undefined;
  const required = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
  return {
    ...tool,
    description: `${tool.description} 每次必须填写 life_update：未变填 null，已改变填活动对象；系统先保存活动再执行本工具，保存失败不发言。`,
    parameters: {
      ...tool.parameters,
      properties: { ...properties, life_update: decision },
      required: [...new Set([...required, 'life_update'])],
    },
    handler: async (args, ctx) => {
      if (!Object.hasOwn(args, 'life_update')) return failed('缺少必填 life_update 决策');
      const { life_update: update, ...worldArgs } = args;
      let receipt = '';
      if (update !== null) {
        if (!update || typeof update !== 'object' || Array.isArray(update)) return failed('life_update 必须是活动对象或 null');
        const value = update as Record<string, unknown>;
        if (typeof value.doing !== 'string' || !value.doing.trim() || value.doing.trim().length > 120
          || typeof value.sleeping !== 'boolean'
          || (value.duration_minutes !== undefined && typeof value.duration_minutes !== 'number')
          || (value.until !== undefined && typeof value.until !== 'string')
          || (value.location !== undefined && typeof value.location !== 'string')
          || Object.keys(value).some((key) => !['doing', 'sleeping', 'until', 'duration_minutes', 'location'].includes(key))) {
          return failed('活动对象需要 doing 和 sleeping，时间选 duration_minutes 或 until，location 可选');
        }
        try {
          const result = store.advance(value.doing, value.until as string | undefined, value.location as string | undefined, value.sleeping, value.duration_minutes as number | undefined);
          if (!result.ok) return failed(result.result);
          receipt = `[life advanced] ${result.result}`;
        } catch (error) {
          return failed(`活动未保存：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // 活动已经发生；发言扣下或失败不撤销本人状态。
      const out = await tool.handler(worldArgs, ctx);
      if (!receipt) return out;
      return typeof out === 'string' ? `${receipt}\n${out}` : { ...out, text: `${receipt}\n${out.text}` };
    },
  };
}
