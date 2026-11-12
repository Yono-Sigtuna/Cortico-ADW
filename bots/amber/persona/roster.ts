/**
 * 从 people/*.md 生成名册。
 *
 * 身份约定：QQ 上的人，文件名是 `qq-<QQ号>.md`——QQ 号不变，昵称会变。
 * 首行是「当前昵称(QQ号) — 一句概括」，昵称变了只改首行，不改文件名。
 * 不在 QQ 上的虚构人物用固定名字作文件名（他们的名字就是身份）。
 *
 * 解析与一致性检查都在 PersonRegistry 里：名册、记忆渲染、替换共用同一份解析结果，
 * 免得"名册看到的"和"记忆里换掉的"不是一回事。
 */
import { PersonRegistry } from './people.ts';

export function buildRoster(memoryDir: string, registry?: PersonRegistry | null): string {
  const people = registry ?? new PersonRegistry(memoryDir);
  const records = people.all();
  if (records.length === 0) return '';

  const lines = records.map((record) => {
    const key = record.file.replace(/^people\//, '').replace(/\.md$/i, '');
    // 曾用名跟着名字一起进前缀：模型看到旧名时能自己对上是谁。它必须整段保留——
    // 前缀的长度限制只压摘要那一句，不能把「这人以前叫什么」截掉。
    const former = record.aliases.length ? `（曾用名：${record.aliases.join('、')}）` : '';
    const summary = record.firstLine || '(档案第一行为空)';
    const brief = summary.length <= 30 ? summary : `${summary.slice(0, 30)}…`;
    return `- ${key} — ${brief}${former}`;
  });

  const warnings = people.warnings();
  return [...lines, ...(warnings.length > 0 ? ['', ...warnings] : [])].join('\n');
}
