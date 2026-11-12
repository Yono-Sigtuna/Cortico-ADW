/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
const ENTRY = '../../src/web/client/features/live/prompts.ts';
const UI = '../../src/web/client/ui/index.ts';
const { createPromptView } = await import(ENTRY);
const { createWebUi } = await import(UI);
const doc = (globalThis as any).document;
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });
const summary = (n: number, turn = 'turn-a', round = n) => ({ id: String(n), run: 'r-test', sequence: n, round: n, turnId: turn, turnRound: round, startedAt: '2026-11-07T00:00:00Z', sessionId: 'main', role: 'main', model: 'fixture', outcome: 'completed', attempts: 1, storageError: false });
const turn = (id: string, calls: number) => ({ id, run: 'r-test', sessionId: 'main', startedAt: '2026-11-07T00:00:00Z', endedAt: '2026-11-07T00:01:00Z', calls });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const flush = () => new Promise(r => setTimeout(r, 10));
function detail(n: number) {
  return { summary: summary(n), request: { input: `framework-input-${n}` }, context: null,
    attempts: [{ ordinal: 0, diagnostic: false, startedAt: '', body: JSON.stringify({ messages: [{ role: 'user', content: `native-input-${n}` }] }) }],
    result: { partial: false, response: { output: [{ type: 'message', role: 'assistant', content: `output-${n}` }] } },
    toolResults: [{ item: { type: 'function_call_output', call_id: `call-${n}`, output: `receipt-${n}` }, context: {} }] };
}
function setup(fetcher: any) {
  vi.stubGlobal('fetch', fetcher); const controller = new AbortController();
  const ui = createWebUi({ memo: { get: () => undefined, set: () => {} }, overlayHost: doc.body, signal: controller.signal, doc });
  const view = createPromptView({ ui, signal: controller.signal, onError: (e: unknown) => { throw e; } });
  doc.body.append(view.el); return { view, controller };
}
function click(el: any, selector: string) { const node = el.querySelector(selector); expect(node).toBeTruthy(); node.click(); }
it('groups two response processes and displays only the selected round input, output or receipts', async () => {
  let reads = 0;
  const { view, controller } = setup(async (url: string) => {
    if (url.startsWith('/api/runs')) return json({ current: 'r-test', runs: [{ run: 'r-test' }] });
    if (url.includes('/detail')) { reads++; return json(detail(Number(new URL(url, 'http://test').searchParams.get('id')))); }
    return json({ recorded: true, items: [summary(6, 'turn-b', 3), summary(5, 'turn-b', 2), summary(4, 'turn-b', 1), summary(3), summary(2), summary(1)], turns: [turn('turn-a', 3), turn('turn-b', 3)] });
  });
  await view.refresh(); expect(view.el.querySelectorAll('.prompt-turn')).toHaveLength(2);
  expect(view.el.querySelectorAll('.prompt-call')).toHaveLength(6); expect(reads).toBe(0);
  expect([...view.el.querySelectorAll('.prompt-turn > summary')].every((x: any) => x.textContent.includes('3'))).toBe(true);
  expect([...view.el.querySelectorAll('.prompt-turn > summary')].every((x: any) => x.textContent.includes('已结束'))).toBe(true);
  click(view.el, '[data-call="2"]'); await flush();
  const pane = () => view.el.querySelector('.prompt-pane');
  expect(pane().textContent).toContain('native-input-2'); expect(pane().textContent).not.toContain('output-2');
  expect(pane().querySelector('.prompt-readable').textContent).not.toContain('framework-input-2');
  expect(pane().querySelector('.prompt-aux').open).toBe(false); expect(pane().textContent).not.toContain('native-input-1');
  click(view.el, '[data-tab="result"]'); expect(pane().textContent).toContain('output-2'); expect(pane().textContent).not.toContain('output-1');
  click(view.el, '[data-tab="tools"]'); expect(pane().textContent).toContain('receipt-2');
  click(view.el, '[data-call="5"]'); await flush(); click(view.el, '[data-tab="result"]');
  expect(pane().textContent).toContain('output-5'); expect(pane().textContent).not.toContain('output-2');
  controller.abort();
});
it('downloads complete input, result, tools and auxiliary JSON without clipboard access or HTML execution', async () => {
  const files: any[] = []; const names: string[] = []; const revoked: string[] = [];
  const clipboard = vi.fn();
  Object.defineProperty(doc.defaultView.navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  const BaseURL = URL;
  vi.stubGlobal('URL', class extends BaseURL {
    static createObjectURL(blob: any) { files.push(blob); return `blob:download-${files.length}`; }
    static revokeObjectURL(url: string) { revoked.push(url); }
  });
  const anchorClick = vi.spyOn(doc.defaultView.HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: any) { names.push(this.download); });
  const read = (blob: any): Promise<string> => new Promise(resolve => { const reader = new doc.defaultView.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
  const long = '<img src=x onerror=alert(1)>' + '全文'.repeat(3000);
  const d = detail(1); d.attempts[0].body = JSON.stringify({ input: long });
  const { view, controller } = setup(async (url: string) => json(url.startsWith('/api/runs') ? { current: 'r-test', runs: [] } : url.includes('/detail') ? d : { recorded: true, items: [summary(1)] }));
  try {
    await view.refresh(); click(view.el, '[data-call="1"]'); await flush();
    expect(view.el.querySelector('.prompt-pane img')).toBeNull();
    click(view.el, '.prompt-pane [data-download="input"]'); await flush(); expect(await read(files[0])).toBe(d.attempts[0].body);
    click(view.el, '.prompt-pane [data-download="aux"]'); await flush(); expect(JSON.parse(await read(files[1])).attempts[0].body).toBe(d.attempts[0].body);
    click(view.el, '[data-tab="result"]'); click(view.el, '.prompt-pane [data-download="result"]'); await flush();
    expect(JSON.parse(await read(files[2])).output[0].content).toBe('output-1');
    click(view.el, '[data-tab="tools"]'); click(view.el, '.prompt-pane [data-download="tools"]'); await flush();
    expect(JSON.parse(await read(files[3]))[0].item.output).toBe('receipt-1');
    expect(files.every(blob => blob.type === 'application/json')).toBe(true);
    expect(names.every(name => name.includes('r-test') && name.includes('round-1') && name.endsWith('.json'))).toBe(true);
    expect(names.map(name => name.split('-').at(-1))).toEqual(['input.json', 'aux.json', 'result.json', 'tools.json']);
    expect(revoked).toHaveLength(4); expect(clipboard).not.toHaveBeenCalled();
    expect(view.el.querySelector('[data-copy]')).toBeNull();
  } finally { anchorClick.mockRestore(); controller.abort(); }
});
it('caps matching rounds at 100, shows truncated process counts, and ignores old updates', async () => {
  let missing = false; const requested: string[] = [];
  const { view, controller } = setup(async (url: string) => {
    requested.push(url);
    if (url.startsWith('/api/runs')) return json({ current: 'r-test', runs: [] });
    if (missing) return json({ recorded: false, items: [] });
    return json({ recorded: true, items: Array.from({ length: 101 }, (_, i) => summary(101 - i)), turns: [turn('turn-a', 101)] });
  });
  await view.refresh(); expect(requested.some(x => x.includes('limit=100'))).toBe(true);
  expect(view.el.querySelectorAll('.prompt-call')).toHaveLength(100); expect(view.el.textContent).toContain('部分');
  expect(view.el.querySelector('[data-call="1"]')).toBeNull();
  view.notify(summary(102)); view.notify(summary(1));
  expect(view.el.querySelectorAll('.prompt-call')).toHaveLength(100); expect(view.el.querySelector('[data-call="2"]')).toBeNull();
  expect(view.el.querySelector('[data-call="102"]')).toBeTruthy();
  missing = true; await view.selectSession('absent'); expect(view.el.textContent).toContain('未记录'); controller.abort();
});
it('does not render a late detail after changing round or evicting the selected call', async () => {
  let resolveOld: (r: Response) => void = () => {};
  const { view, controller } = setup(async (url: string) => {
    if (url.startsWith('/api/runs')) return json({ current: 'r-test', runs: [] });
    if (url.includes('/detail')) return url.includes('id=1&') || url.endsWith('id=1') ? new Promise(r => { resolveOld = r; }) : json(detail(100));
    return json({ recorded: true, items: Array.from({ length: 100 }, (_, i) => summary(100 - i)) });
  });
  await view.refresh(); click(view.el, '[data-call="1"]'); await flush(); view.notify(summary(101));
  click(view.el, '[data-call="100"]'); await flush(); resolveOld(json(detail(1))); await flush();
  expect(view.el.querySelector('.prompt-pane')?.textContent).toContain('native-input-100');
  expect(view.el.querySelector('.prompt-pane')?.textContent).not.toContain('native-input-1"'); controller.abort();
});
it('queues selected detail refresh when model completion arrives during loading', async () => {
  let reads = 0; let resolveFirst: (r: Response) => void = () => {};
  const { view, controller } = setup(async (url: string) => {
    if (url.startsWith('/api/runs')) return json({ current: 'r-test', runs: [] });
    if (url.includes('/detail')) { reads++; return reads === 1 ? new Promise(r => { resolveFirst = r; }) : json(detail(1)); }
    return json({ recorded: true, items: [{ ...summary(1), outcome: 'pending', attempts: 0 }] });
  });
  await view.refresh(); click(view.el, '[data-call="1"]'); await flush(); view.notify(summary(1));
  resolveFirst(json({ ...detail(1), attempts: [], result: undefined })); await flush(); await flush();
  expect(reads).toBe(2); expect(view.el.querySelector('.prompt-pane')?.textContent).toContain('native-input-1'); controller.abort();
});
it('follows the current run on refresh, preserves historical selection and ignores a late session response', async () => {
  let current = 'r-first'; let resolveOld: (r: Response) => void = () => {};
  const { view, controller } = setup(async (url: string) => {
    if (url.startsWith('/api/runs')) return json({ current, runs: [{ run: 'r-first' }, { run: 'r-second' }] });
    if (url.includes('session=old')) return new Promise(r => { resolveOld = r; });
    return json({ recorded: true, items: [{ ...summary(1), sessionId: url.includes('r-second') ? 'second' : 'first' }] });
  });
  await view.refresh(); current = 'r-second'; await view.refresh(); expect(view.el.querySelector('.prompt-call')?.textContent).toContain('second');
  const select = view.el.querySelector('select'); select.value = 'r-first'; select.dispatchEvent(new Event('change')); await flush();
  await view.refresh(); expect(select.value).toBe('r-first');
  const old = view.selectSession('old'); await flush(); await view.selectSession('new'); resolveOld(json({ recorded: true, items: [summary(2)] })); await old;
  expect(view.el.querySelectorAll('.prompt-call')).toHaveLength(1); controller.abort();
});
it('does not invent legacy group boundaries or missing results', async () => {
  const legacy = { ...summary(1), turnId: undefined, turnRound: undefined };
  const { view, controller } = setup(async (url: string) => json(url.startsWith('/api/runs') ? { current: 'r-test', runs: [] } : url.includes('/detail') ? { ...detail(1), summary: legacy, result: undefined, toolResults: [] } : { recorded: true, items: [legacy] }));
  await view.refresh(); expect(view.el.textContent).toContain('边界未记录');
  click(view.el, '[data-call="1"]'); await flush(); click(view.el, '[data-tab="result"]');
  expect(view.el.querySelector('.prompt-pane')?.textContent).toContain('结果未记录'); controller.abort();
});
