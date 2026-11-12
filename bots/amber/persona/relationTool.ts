/**
 * 梦用来维护关系约束的那只手。
 *
 * 与 `people/` 里的「我的看法」分开：看法是散文，给语气；这里是少量机器可读的
 * 状态，决定"能怎么对他"——信任低就收紧，刚越界就不主动。
 *
 * 「他还在等的一件事」不在这份档案里：那是**一段对话里的悬空**，跟着对话生灭，
 * 由陪伴层按会话记。写进长期档案，它就会一直挂到天荒地老。
 */
import type { ToolDef } from 'cortico/core/types.ts';
import type { RelationStore } from './relations.ts';

export const MAINTAIN_RELATION_DECL: Omit<ToolDef, 'handler'> = {
  name: 'maintain_relation',
  description:
    '更新你和某个人之间能怎么相处：信任、熟悉度、边界（刚越界、还没修复），以及他还在等你的一件事。'
    + '只写这一段时间确实改变了的东西；这些不是感受，是约束——它会改变你下一轮对他的措辞和要不要主动找他。'
    + '没有变化就不要调用。',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      qq: { type: 'string', description: '对方的 QQ 号（people/ 文件名里那串数字）。' },
      trust: { type: 'number', minimum: 0, maximum: 1, description: '0–1。越界会掉信任；真的被接住、被帮到才慢慢涨。' },
      familiarity: { type: 'number', minimum: 0, maximum: 1, description: '0–1。认识多久、聊得多熟。' },
      boundary: { type: 'number', minimum: 0, maximum: 1, description: '0–1。刚被冒犯、还没修复时就写高；修复后写 0。' },
      pending: { type: 'string', description: '他还在等你的一件事，例如「答应明天告诉他检查结果」。只写他要等的那一件；你自己给自己定的做法（「下次我少说两句」这类）不算，那属于 note/ 或宪法。下一步他再开口时，这一件会递到你眼前一次，然后就不再提。' },
      resolved: { type: 'string', description: '已经兑现的那件：原话片段。兑现了就销掉，别让它继续挂着。销账本身不加好感。' },
      resolved_event: { type: 'string', description: '对方确认兑现的那句原话（从 qq_read_history 抄一小段）。有这条、且和对方在承诺之后发的真实消息对得上，才加一次好感；同一个事件只加一次。' },
      basis: { type: 'string', description: '一句话依据。' },
    },
    required: ['qq'],
  },
};

export function maintainRelationTool(deps: {
  store: RelationStore;
  /** 他还在等的事：按会话记，不写进关系档案。 */
  pending?: {
    note(qq: string, text: string): boolean;
    close(qq: string, fragment: string): boolean;
    /** 销账的会话与最早那条承诺的时间；没有它就拿不到履约证据。 */
    closeDetail?(qq: string, fragment: string): { closed: boolean; conv?: string; at?: number };
  };
  /** 在会话里找一条承诺之后、由本人发来的消息；找到返回唯一奖励键。 */
  evidence?: (qq: string, conv: string, after: number, fragment: string) => string | null;
}): ToolDef {
  return {
    ...MAINTAIN_RELATION_DECL,
    handler: async (args) => {
      const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
      const qq = typeof input.qq === 'string' ? input.qq.trim() : '';
      if (!qq) return '[relation unchanged] 缺少 qq';
      const result = deps.store.patch(qq, {
        ...(input.trust !== undefined ? { trust: input.trust as number } : {}),
        ...(input.familiarity !== undefined ? { familiarity: input.familiarity as number } : {}),
        ...(input.boundary !== undefined ? { boundary: input.boundary as number } : {}),
        ...(input.basis !== undefined ? { basis: String(input.basis) } : {}),
      });
      const applied = [...result.applied];
      const rejected = [...result.rejected];
      let rewarded = false;

      if (typeof input.pending === 'string' && input.pending.trim()) {
        if (deps.pending?.note(qq, input.pending)) applied.push('pending');
        else rejected.push('pending');
      }
      if (typeof input.resolved === 'string' && input.resolved.trim()) {
        const detail = deps.pending?.closeDetail?.(qq, input.resolved)
          ?? (deps.pending?.close(qq, input.resolved) ? { closed: true } : { closed: false });
        if (detail.closed) {
          applied.push('resolved');
          // 销账和奖励分开：只有找得到"这个人之后真的说了兑现"的那条事件，才加一次。
          const evidenceText = typeof input.resolved_event === 'string' ? input.resolved_event.trim() : '';
          if (evidenceText && detail.conv !== undefined && typeof detail.at === 'number') {
            const key = deps.evidence?.(qq, detail.conv, detail.at, evidenceText) ?? null;
            if (key) rewarded = deps.store.rewardFulfilled(qq, key);
          }
        } else {
          rejected.push('resolved');
        }
      }

      if (!applied.length) {
        return `[relation unchanged] ${rejected.length ? rejected.join('；') : '没有可用的字段'}`;
      }
      const ignored = rejected.length ? `；忽略 ${rejected.join('、')}` : '';
      const rewardNote = applied.includes('resolved') && !rewarded
        ? '（只销账：找不到承诺之后对方发来的兑现原话，这次不加好感）'
        : '';
      return `[relation updated] ${applied.join('、')}${ignored}${rewardNote}`;
    },
  };
}
