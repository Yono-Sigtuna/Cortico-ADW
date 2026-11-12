/**
 * 从她自己的术语表里读出「我自己的称呼」。
 *
 * 唤醒名不该只有一份写在配置里的静态列表：群里怎么叫她，是她自己在术语表里维护的。
 * 这里只做解析，同步与去重由 Persona 和 QQ World 负责。
 */
export function parseSelfNames(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,4}\s*我自己的称呼/.test(line.trim()));
  if (start < 0) return [];
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,4}\s/.test(line)) break;
    if (line) body.push(line);
  }
  // 「昵称（群昵称）」「小克（群主专用）」：括号里是说明，不是名字的一部分。
  const names = body.join(' ')
    .split(/[、，,。；;\s]+/)
    .map((name) => name.replace(/[（(][^）)]*[）)]/g, '').trim())
    .filter((name) => name.length >= 2 && name.length <= 12);
  return [...new Set(names)];
}
