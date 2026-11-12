/**
 * 记忆再固化：这一轮用过的旧事，结局如何。
 *
 * 这里的增量必须小到"长期才看得出"：一条被反复证明有用的记忆慢慢变重，
 * 一条每次被想起都冷场的记忆慢慢沉底。它不是投票，也不该被一轮情绪带跑。
 */
export type WakeOutcome = 'sent' | 'acted' | 'unsent-text' | 'silent';
/**
 * 结局 → importance 增量。
 *
 * - `sent`：她把这些旧事用上了，对方也接住了 → +0.02
 * - `acted`：她做了事但没说话（比如翻记录、起草）→ +0.01
 * - `silent`：有人说话，她什么都没做 → −0.01
 * - `unsent-text`：写了没发，结局不明 → 0
 * - 没有外部输入的一轮（心跳、内部提醒）不评价记忆 → 0
 */
export function recallDelta(outcome: WakeOutcome, hadExternal: boolean): number {
  if (!hadExternal) return 0;
  switch (outcome) {
    case 'sent': return 0.02;
    case 'acted': return 0.01;
    case 'silent': return -0.01;
    default: return 0;
  }
}
