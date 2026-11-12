/** people/ 的体量预算：超了之后只准越写越小。 */
import { describe, it, expect } from 'vitest';
import { PEOPLE_CHAR_BUDGET, peopleBudgetVerdict } from '../../bots/amber/persona/peopleBudget.ts';

const P = 'people/qq-3001.md';

describe('people 预算', () => {
  it('没超预算：追加和重写都放行', () => {
    expect(peopleBudgetVerdict({ currentChars: 1000, projectedChars: 5000, path: P, op: 'append' }).denied).toBeNull();
    expect(peopleBudgetVerdict({ currentChars: 1000, projectedChars: 2000, path: P, op: 'write' }).denied).toBeNull();
  });

  it('刚好压线：仍然放行，预算不是零容差', () => {
    expect(peopleBudgetVerdict({
      currentChars: PEOPLE_CHAR_BUDGET, projectedChars: PEOPLE_CHAR_BUDGET, path: P, op: 'append',
    }).denied).toBeNull();
  });

  it('超了还往大里写：拒绝，并把文件名、现值和预算都写清楚', () => {
    const out = peopleBudgetVerdict({
      currentChars: PEOPLE_CHAR_BUDGET + 500,
      projectedChars: PEOPLE_CHAR_BUDGET + 900,
      path: P,
      op: 'append',
    });
    expect(out.denied).toContain('[over budget]');
    expect(out.denied).toContain(P);
    expect(out.denied).toContain(String(PEOPLE_CHAR_BUDGET + 500));
    expect(out.denied).toContain(String(PEOPLE_CHAR_BUDGET));
  });

  it('超了但这次是消化：写小就放行——整理不能被预算挡住', () => {
    expect(peopleBudgetVerdict({
      currentChars: PEOPLE_CHAR_BUDGET + 500,
      projectedChars: 3000,
      path: P,
      op: 'write',
    }).denied).toBeNull();
  });

  it('超了、改完一字不差：算没变化，拒绝', () => {
    expect(peopleBudgetVerdict({
      currentChars: PEOPLE_CHAR_BUDGET + 500,
      projectedChars: PEOPLE_CHAR_BUDGET + 500,
      path: P,
      op: 'edit',
    }).denied).not.toBeNull();
  });
});
