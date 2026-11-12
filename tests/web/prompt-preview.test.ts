/** @vitest-environment jsdom */
import { expect, it } from 'vitest';
const PREVIEW = '../../src/web/client/features/live/prompt-preview.ts';
const UI = '../../src/web/client/ui/index.ts';
const { renderPromptPreview } = await import(PREVIEW);
const { createWebUi } = await import(UI);
const doc = (globalThis as any).document;
function render(value: unknown, source = 'request') {
  const controller = new AbortController();
  const ui = createWebUi({ memo: { get: () => undefined, set: () => {} }, overlayHost: doc.body, signal: controller.signal, doc });
  return renderPromptPreview(ui, value, source);
}
it('renders headings, real line breaks, lists and fenced code without rewriting literal escape sequences', () => {
  const box = render({ input: [{ role: 'system', content: '# 总标题\n## 子标题\n第一行\n第二行\n\n- 项目一\n- **项目二**\n\n```js\nconst pattern = "\\n";\n```' }] });
  expect(box.querySelector('h2')?.textContent).toBe('总标题');
  expect(box.querySelector('h3')?.textContent).toBe('子标题');
  expect(box.querySelectorAll('br')).toHaveLength(1);
  expect(box.querySelectorAll('li')).toHaveLength(2);
  expect(box.querySelector('strong')?.textContent).toBe('项目二');
  expect(box.querySelector('pre code')?.textContent).toBe('const pattern = "\\n";');
});
it('reads Responses items, Chat messages, tool calls and outputs in input order', () => {
  const box = render({ input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '用户正文\n下一行' }] },
    { type: 'function_call', name: 'read_note', call_id: 'c1', arguments: '{"path":"note.md"}' },
    { type: 'function_call_output', call_id: 'c1', output: '## 工具结果\n蓝色书签' },
  ], tools: [{ type: 'function', name: 'read_note', description: '读取**笔记**', parameters: { type: 'object' } }] });
  const cards = [...box.querySelectorAll('.prompt-message')];
  expect(cards).toHaveLength(3);
  expect(cards[0].textContent).toContain('用户正文'); expect(cards[1].textContent).toContain('read_note');
  expect(cards[1].textContent).toContain('note.md'); expect(cards[2].querySelector('h3')?.textContent).toBe('工具结果');
  expect(box.textContent).toContain('读取笔记');
  const chat = render({ messages: [{ role: 'assistant', content: '### 回答\n你好' }, { role: 'tool', tool_call_id: 'c1', content: '收到' }] });
  expect(chat.querySelector('h4')?.textContent).toBe('回答'); expect(chat.textContent).toContain('c1');
});
it('keeps HTML and unsafe links inert and does not fetch Markdown images', () => {
  const box = render({ input: '<img src=x onerror=alert(1)>\n[坏](javascript:alert(1))\n![远程](https://example.com/pixel.png)' });
  expect(box.querySelector('img')).toBeNull(); expect(box.querySelector('[onerror]')).toBeNull();
  expect(box.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(box.textContent).toContain('<img src=x onerror=alert(1)>');
});
it('retains context metadata and marks non-text parts without inventing text', () => {
  const box = render([{ item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# 正文' }, { type: 'input_image', image_url: 'log:fixture' }] }, context: { head: true } }], 'context');
  expect(box.querySelector('h2')?.textContent).toBe('正文');
  expect(box.textContent).toContain('head'); expect(box.textContent).toContain('input_image');
});
