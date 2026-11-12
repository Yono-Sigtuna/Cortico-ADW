/** One selected round: request, returned output and actual tool receipts are distinct views. */
import type { WebUi } from '../../../shared/client-panel.ts';
import type { PromptDetail } from '../../../shared/prompt.ts';
import { renderPromptPreview } from './prompt-preview.ts';
import { P } from './prompt-strings.ts';
import { downloadJsonText } from './diagnostics.ts';
export type PromptTab = 'input' | 'result' | 'tools';

export function renderRoundPane(ui: WebUi, data: PromptDetail, tab: PromptTab): HTMLElement {
  const pane = ui.h('div', 'prompt-pane'); pane.setAttribute('data-pane', tab);
  function downloadButton(json: string, kind: string): HTMLButtonElement {
    const safe = (text: string) => text.replace(/[^a-z0-9_.-]/gi, '_');
    const name = `cortico-${safe(data.summary.run)}-round-${data.summary.turnRound ?? data.summary.round ?? data.summary.sequence}-${safe(data.summary.id)}-${kind}.json`;
    const button = ui.button(P.download, { onClick: () => downloadJsonText(pane.ownerDocument, name, json) });
    button.setAttribute('data-download', kind); return button;
  }
  function section(title: string, preview: unknown, raw: unknown, kind: string, source: 'request' | 'context' = 'request', exact?: string) {
    const box = ui.h('section', 'prompt-section');
    const head = ui.h('div', 'prompt-section-head');
    const json = exact ?? JSON.stringify(raw, null, 2);
    head.append(ui.h('b', null, title), downloadButton(json, kind));
    const original = ui.h('details', 'prompt-raw'); original.append(ui.h('summary', null, P.raw), ui.h('pre', 'prompt-json', json));
    box.append(head, renderPromptPreview(ui, preview, source), original); return box;
  }
  if (data.summary.storageError) pane.append(ui.h('p', 'bad', P.storageError));
  if (tab === 'input') {
    const sent = data.attempts.filter(attempt => !attempt.diagnostic).at(-1);
    if (sent) {
      let parsed: unknown = sent.body; try { parsed = JSON.parse(sent.body); } catch { /* Keep the exact non-JSON body. */ }
      pane.append(section(P.native, parsed, parsed, 'input', 'request', sent.body));
    } else {
      pane.append(ui.h('p', 'prompt-result-note', P.fallback), section(P.framework, data.request, data.request, 'input'));
    }
    const aux = ui.h('details', 'prompt-aux'); aux.append(ui.h('summary', null, P.auxiliaries));
    const raw = ui.h('pre', 'prompt-json', JSON.stringify({ request: data.request, context: data.context, attempts: data.attempts }, null, 2));
    aux.append(downloadButton(raw.textContent ?? '', 'aux'), raw); pane.append(aux);
  } else if (tab === 'result') {
    const result = data.result;
    if (!result) { pane.append(ui.h('p', 'muted', data.summary.outcome === 'pending' ? P.waitingOutput : P.legacyResult)); return pane; }
    pane.append(ui.h('p', 'prompt-result-note', P.modelOnly));
    if (result.partial) pane.append(ui.h('p', 'prompt-result-note', P.partialOutput));
    if (result.error) pane.append(ui.h('pre', 'prompt-error', `${result.error.name}${result.error.status !== undefined ? ` (${result.error.status})` : ''}: ${result.error.message}`));
    const output = result.response?.output ?? [];
    if (output.length) pane.append(section(P.resultTab, { input: output }, result.response, 'result'));
    else pane.append(ui.h('p', 'muted', P.noOutput));
    const thinking = output.some(item => item.type === 'reasoning' && ((item.content?.length ?? 0) > 0 || (item.summary?.length ?? 0) > 0));
    if (!thinking) pane.append(ui.h('p', 'muted', P.noThinking));
  } else {
    const receipts = data.toolResults ?? [];
    if (receipts.length) pane.append(section(P.toolsTab, receipts, receipts, 'tools', 'context'));
    else {
      const calls = data.result?.response?.output.some(item => item.type === 'function_call');
      pane.append(ui.h('p', 'muted', data.result?.response && !calls ? P.noToolCalls : P.noReceipts));
    }
  }
  return pane;
}
