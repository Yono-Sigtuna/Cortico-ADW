/** Readable request text; unknown structures remain available in the raw snapshot. */
import type { WebUi } from '../../../shared/client-panel.ts';
import { renderMarkdown } from '../extensions/markdown.ts';
import { P } from './prompt-strings.ts';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null;

export function renderPromptPreview(ui: WebUi, value: unknown, source: 'request' | 'context' = 'request'): HTMLElement {
  const root = ui.h('div', 'prompt-readable');
  const doc = root.ownerDocument;
  function md(target: HTMLElement, text: string) {
    const block = ui.h('div', 'prompt-markdown');
    block.append(renderMarkdown(doc, text, { headingOffset: 1 })); target.append(block);
  }
  function structure(target: HTMLElement, label: string, data: unknown) {
    const fold = ui.h('details', 'prompt-structure');
    fold.append(ui.h('summary', null, label), ui.h('pre', 'prompt-json', JSON.stringify(data, null, 2)));
    target.append(fold);
  }
  function content(target: HTMLElement, data: unknown) {
    if (typeof data === 'string') { md(target, data); return; }
    if (Array.isArray(data)) {
      for (const part of data) {
        const p = object(part);
        if (typeof p?.text === 'string') md(target, p.text);
        else if (typeof p?.refusal === 'string') md(target, p.refusal);
        else {
          target.append(ui.h('div', 'prompt-part-type', `[${typeof p?.type === 'string' ? p.type : 'part'}]`));
          structure(target, P.structure, part);
        }
      }
    } else if (data !== undefined && data !== null) structure(target, P.structure, data);
  }
  function card(entry: unknown) {
    const wrapped = object(entry);
    const item = source === 'context' && wrapped?.item ? object(wrapped.item) : wrapped;
    const row = ui.h('article', 'prompt-message');
    if (!item) { content(row, entry); root.append(row); return; }
    const role = typeof item.role === 'string' ? item.role : typeof item.type === 'string' ? item.type : 'input';
    const head = ui.h('div', 'prompt-message-head');
    head.append(ui.h('span', 'prompt-role', role));
    for (const key of ['name', 'call_id', 'tool_call_id']) if (typeof item[key] === 'string') head.append(ui.h('code', null, item[key] as string));
    row.append(head);
    if (source === 'context' && wrapped?.context) structure(row, P.provenance, wrapped.context);
    if (item.type === 'function_call') {
      if (typeof item.arguments === 'string') {
        let args: unknown = item.arguments;
        try { args = JSON.parse(item.arguments); } catch { /* Invalid JSON is displayed verbatim. */ }
        row.append(ui.h('pre', 'prompt-json', typeof args === 'string' ? args : JSON.stringify(args, null, 2)));
      }
    } else {
      content(row, item.content ?? item.output ?? item.text ?? item.summary);
      if (typeof item.reasoning_content === 'string') content(row, item.reasoning_content);
      if (item.tool_calls) structure(row, P.toolCalls, item.tool_calls);
      if (item.encrypted_content) row.append(ui.h('div', 'prompt-part-type', P.encrypted));
      const shown = ['content', 'output', 'text', 'summary', 'reasoning_content', 'tool_calls'];
      if (!shown.some(key => item[key] !== undefined)) structure(row, P.structure, item);
    }
    root.append(row);
  }
  if (source === 'context') {
    if (Array.isArray(value)) for (const entry of value) card(entry);
    else content(root, value);
    return root;
  }
  const request = object(value);
  if (!request) { content(root, value); return root; }
  for (const key of ['instructions', 'system']) if (request[key] !== undefined) {
    const row = ui.h('article', 'prompt-message'); row.append(ui.h('div', 'prompt-message-head', key));
    content(row, request[key]); root.append(row);
  }
  const input = request.input ?? request.messages;
  if (Array.isArray(input)) for (const entry of input) card(entry);
  else if (input !== undefined) card(input);
  if (Array.isArray(request.tools) && request.tools.length) {
    const fold = ui.h('details', 'prompt-tools'); fold.append(ui.h('summary', null, `${P.tools} (${request.tools.length})`));
    for (const entry of request.tools) {
      const outer = object(entry); const tool = object(outer?.function) ?? outer;
      const row = ui.h('article', 'prompt-tool');
      row.append(ui.h('code', null, typeof tool?.name === 'string' ? tool.name : 'tool'));
      if (typeof tool?.description === 'string') md(row, tool.description);
      structure(row, P.structure, entry); fold.append(row);
    }
    root.append(fold);
  }
  const params = Object.fromEntries(Object.entries(request).filter(([key]) => !['instructions', 'system', 'input', 'messages', 'tools'].includes(key)));
  if (Object.keys(params).length) structure(root, P.parameters, params);
  return root;
}
