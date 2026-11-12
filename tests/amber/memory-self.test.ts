/** 自我叙事：memo/self.md 与前缀里的「我自己」，note/opinions/ 只列名进前缀。 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { MemoTiers } from '../../bots/amber/persona/memoTiers.ts';
import { memoryVars } from '../../bots/amber/persona/memory.ts';
import { makeTmpDir } from '../core/helpers.ts';

const CTX = { now: new Date('2026-10-27T00:00:00Z'), timezone: 'Asia/Shanghai' };

describe('自我叙事', () => {
  const tmp = makeTmpDir();
  let seq = 0;
  let ws: GitWorkspaceMemory;
  let memo: MemoTiers;

  afterAll(() => tmp.cleanup());

  // 每个用例一个干净的工作区，免得常驻清单互相污染。
  beforeEach(() => {
    seq += 1;
    ws = new GitWorkspaceMemory({ memoryDir: join(tmp.dir, `persona-${seq}`), warn: () => {} });
    ws.ensureDirs(['memo', 'memo/active', 'memo/archived', 'note', 'note/opinions', 'people']);
    memo = new MemoTiers(ws, { residentCap: 5, activeCap: 2 });
  });

  const vars = () => memoryVars(ws, memo, CTX, []);

  it('self.md 单独成段，不再混进常驻 memo 全文', () => {
    ws.writeFileAtomic('memo/self.md', '我最近在核对记忆召回的问题。\n还没想明白的是要不要把语音接回来。');
    ws.writeFileAtomic('memo/今天.md', '下午去看了机房。');
    const v = vars();
    expect(v['memory.self']).toContain('我最近在核对记忆召回的问题。');
    expect(v['memory.self']).toContain('还没想明白');
    expect(v['memory.memoResident']).toContain('memo/今天.md');
    expect(v['memory.memoResident']).not.toContain('memo/self.md');
  });

  it('超过 200 字：取开头，落在行边界上并以省略号收尾', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行：${'在意的事情'.repeat(4)}`);
    ws.writeFileAtomic('memo/self.md', lines.join('\n'));
    const self = vars()['memory.self'];
    expect(self.length).toBeLessThanOrEqual(201);
    expect(self.endsWith('…')).toBe(true);
    expect(self).toContain('第 1 行');
    expect(self).not.toContain('第 12 行');
  });

  it('没有 self.md：这一段为空，模板负责给空态', () => {
    expect(vars()['memory.self']).toBe('');
  });

  it('note/opinions/ 只把文件名放进前缀', () => {
    ws.writeFileAtomic('note/opinions/群主.md', '2026-10-26 他改框架时比嘴上更耐心。');
    ws.writeFileAtomic('note/opinions/显卡话题.md', '2026-10-25 我对换显卡没兴趣。');
    const opinions = vars()['memory.opinions'];
    expect(opinions).toContain('群主.md');
    expect(opinions).toContain('显卡话题.md');
    // 正文不进前缀：按需 read_file。
    expect(opinions).not.toContain('他改框架时');
  });

  it('MEMORY 模板留了这两个位置', () => {
    const tpl = readFileSync(join(import.meta.dirname, '../../bots/amber/persona/MEMORY.md'), 'utf8');
    expect(tpl).toContain('{{memory.self');
    expect(tpl).toContain('{{memory.opinions');
  });

  it('常驻 memo 的窗口够放进「怎么说话」那一段，不是只留标题', () => {
    // 梦写的顶层 memo 就是这个形状：先是位置和最要紧的几条，`## 开口原则` 落在七八百字处。
    const filled = '这一条判断很长，占掉前面几百个字。'.repeat(28); // ≈ 500 字
    ws.writeFileAtomic(
      'memo/session.md',
      `# 当前状态\n\n## 位置\n- 群里。\n\n## 最要紧的几条\n- ${filled}\n\n## 开口原则\n3. 被点名或被直接问才答；答完就停，一到三句。`,
    );
    const resident = vars()['memory.memoResident'];
    expect(resident).toContain('答完就停，一到三句');
  });

  it('常驻 memo 超长时截在整行上，不留半句', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：${'照着做的一条'.repeat(8)}`);
    ws.writeFileAtomic('memo/长.md', lines.join('\n'));
    const resident = vars()['memory.memoResident'];
    expect(resident).toContain('第 1 行');
    expect(resident).not.toContain('第 40 行');
    expect(resident).toContain('全文用 read_file 读 memo/长.md');
    // 截断处落在行尾再补省略号，不会是「第 22 行：照着做的一条照着…」
    const body = resident.slice(resident.indexOf('── memo/长.md ──') + '── memo/长.md ──'.length).split('（前')[0]!;
    const lastLine = body.trimEnd().split('\n').at(-1)!;
    expect(lastLine.endsWith('照着做的一条…')).toBe(true);
  });
});
