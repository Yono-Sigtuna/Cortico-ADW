/** 身份文件的写入冷却：宪法与世界观的改动不该跟着对话节奏走。 */
import { describe, it, expect } from 'vitest';
import { IDENTITY_FILES, identityWriteVerdict } from '../../bots/amber/persona/identityBudget.ts';

const H = 3_600_000;
const T = Date.parse('2026-10-27T04:00:00Z');

describe('身份文件 · 冷却', () => {
  it('没改过就放行', () => {
    expect(identityWriteVerdict('CONSTITUTION.md', 0, T)).toBeNull();
  });

  it('六小时内再改被拒，理由里写了还要等多久', () => {
    const verdict = identityWriteVerdict('CONSTITUTION.md', T, T + 2 * H);
    expect(verdict).toContain('冷却中');
    expect(verdict).toContain('还要等约 4 小时');
    expect(verdict).toContain('note/');
  });

  it('过了冷却就放行', () => {
    expect(identityWriteVerdict('CONSTITUTION.md', T, T + 7 * H)).toBeNull();
  });

  it('只保护身份文件；其余路径不在这张表里', () => {
    expect(IDENTITY_FILES.has('constitution.md')).toBe(true);
    expect(IDENTITY_FILES.has('worldview.md')).toBe(true);
    expect(IDENTITY_FILES.has('note/cases/x.md')).toBe(false);
    expect(IDENTITY_FILES.has('people/qq-1.md')).toBe(false);
  });
});
