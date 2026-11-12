/**
 * 梦用来维护自己状态的那只手。
 *
 * 只在梦（整理线程）里出现：主意识正在说话，不该同时改自己的数值；
 * 梦有整段经历和证据，改动才有依据。
 */
import type { ToolDef } from 'cortico/core/types.ts';
import type { RoleStateStore } from './roleState.ts';

const S = (props: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  required,
});

export const MAINTAIN_STATE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'maintain_state',
  description:
    '更新你自己此刻的状态：精力、心情五轴、睡眠、忙碌、健康、公开状态、在线态、临时状况。'
    + '这是你自己的模拟感受，不是对别人的观察，也不是诊断。'
    + '只在有依据时改（这段时间发生了什么、你睡了或没睡、被谁说过什么）；没有变化就少改或只改一句 basis。'
    + '状态只影响语气浓度，不决定是否回应，也永远不要把数值念给谁听。',
  tags: ['write'],
  parameters: S({
    energy: { type: 'integer', minimum: 0, maximum: 100, description: '主观精力 0–100。' },
    mood: S({
      baseline: { type: 'integer', minimum: 1, maximum: 10, description: '你的静息水平，通常不动。' },
      joy: { type: 'integer', minimum: 1, maximum: 10 },
      anger: { type: 'integer', minimum: 1, maximum: 10 },
      sorrow: { type: 'integer', minimum: 1, maximum: 10 },
      fear: { type: 'integer', minimum: 1, maximum: 10 },
      intensity: { type: 'string', enum: ['mild', 'moderate', 'strong'], description: '情绪浓度；平稳时省略。' },
      description: { type: 'string', description: '带生活肌理的第一人称心境，一句话。' },
    }, []),
    sleep: { type: 'string', description: '睡眠相关的当前感受，例如「刚睡醒，还有点懵」。没有就省略。' },
    busy: { type: 'string', description: '注意力在做什么，例如「在读一本讲地形的书」。' },
    health: { type: 'string', description: '身体状况的主观感受；不要写成诊断。' },
    presence: { type: 'string', description: '公开 QQ 短状态，最多 8 个字，例如「阅读中」。' },
    onlineMode: { type: 'string', enum: ['online', 'away', 'busy', 'invisible'] },
    conditions: {
      type: 'array',
      maxItems: 16,
      description: '临时状况；到期是你下次复核的时点，不是康复时刻。',
      items: S({
        kind: { type: 'string', enum: ['hunger', 'health', 'sleep', 'busy', 'mood', 'other'] },
        text: { type: 'string' },
        expiresAt: { type: 'string', description: 'ISO 时间；没有明确到期就省略。' },
      }, ['kind', 'text']),
    },
    basis: { type: 'string', description: '为什么变成这样：一句话依据。' },
  }, []),
};

export function maintainStateTool(deps: { store: RoleStateStore }): ToolDef {
  return {
    ...MAINTAIN_STATE_DECL,
    handler: async (args) => {
      const result = deps.store.patch(args as Record<string, unknown>);
      if (!result.ok) {
        return `[state unchanged] ${result.rejected.length ? result.rejected.join('；') : '没有可用的字段'}`;
      }
      const rejected = result.rejected.length ? `；忽略 ${result.rejected.join('、')}` : '';
      return `[state updated] ${result.applied.join('、')}${rejected}`;
    },
  };
}
