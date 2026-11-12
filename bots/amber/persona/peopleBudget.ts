/**
 * people/ 的体量预算。
 *
 * 一个人一个文件，写的是"这个人是谁、怎么跟他说话、我怎么看他"。可它现在长成了
 * 编年史：205 行按日期铺开，只增不减，一天没几句话也能长三 KB。后果不只是文件难看——
 * 每一次梦都要整篇读进上下文，然后在二十多轮里反复重发。
 *
 * 所以给它一个硬预算，并且在写入路径上设闸：**超预算之后只准越写越小**。
 * 提示词里也会写这条，但提示词不是闸门。
 */

/** 单个 people 文件的字（不是字节）上限。 */
export const PEOPLE_CHAR_BUDGET = 9_000;

export type PeopleWriteOp = 'write' | 'append' | 'edit';

export interface PeopleBudgetVerdict {
  /** 拒绝时返回一句话，作为工具回执交给她。 */
  denied: string | null;
}

/**
 * 判断这次写入要不要拦。
 *
 * 规则只有一条：**已经超预算的文件，只接受能把它写小的改动**。这样消化永远能做，
 * 追加永远做不了——增长停下来，而整理不会被挡住。
 */
export function peopleBudgetVerdict(input: {
  currentChars: number;
  projectedChars: number;
  path: string;
  op: PeopleWriteOp;
}): PeopleBudgetVerdict {
  const { currentChars, projectedChars, path } = input;
  if (currentChars <= PEOPLE_CHAR_BUDGET) return { denied: null };
  if (projectedChars < currentChars) return { denied: null };
  return {
    denied: `[over budget] ${path} 现在 ${currentChars} 字，预算 ${PEOPLE_CHAR_BUDGET}。`
      + '超了预算的文件只接受能把它写小的改动：把更早的日期段并成一行、删掉已经不作数的观察、'
      + '把重复的挪进 note/，然后再写。这一次没有落盘。',
  };
}
