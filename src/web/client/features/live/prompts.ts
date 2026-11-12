/** Response-process navigation and a single selected round; heavy data is loaded on demand. */
import type { WebUi } from '../../../shared/client-panel.ts';
import type { PromptDetail, PromptList, PromptSummary, PromptTurn } from '../../../shared/prompt.ts';
import { get } from '../../core/api.ts';
import { P } from './prompt-strings.ts';
import { renderPromptNavigation } from './prompt-navigation.ts';
import { renderRoundPane, type PromptTab } from './prompt-round-detail.ts';
const VISIBLE_CALLS = 100;

export function createPromptView(deps: { ui: WebUi; signal: AbortSignal; onError(error: unknown): void }) {
  const { ui, signal } = deps;
  const el = ui.h('section', 'promptview');
  const controls = ui.h('div', 'prompt-controls');
  const runSelect = ui.h('select'); runSelect.setAttribute('aria-label', P.run);
  const session = ui.h('input'); session.placeholder = P.session; session.setAttribute('aria-label', P.session);
  const list = ui.h('nav', 'prompt-list'); list.setAttribute('aria-label', P.process);
  const state = ui.h('div', 'muted');
  const refreshButton = ui.button(P.refresh, { size: 'sm', onClick: () => { void refresh(); } });
  controls.append(runSelect, session, refreshButton);
  const detailHost = ui.h('div', 'prompt-detail');
  const layout = ui.h('div', 'prompt-layout'); layout.append(list, detailHost);
  el.append(controls, ui.h('div', 'muted', `${P.recent} ${P.local}`), state, layout);
  let run = ''; let currentRun = ''; let revision = 0; let selectionRevision = 0;
  let initialized = false; let disposed = false; let followCurrent = true;
  let selected: string | null = null; let data: PromptDetail | null = null; let tab: PromptTab = 'input';
  let flight: { id: string; controller: AbortController; dirty: boolean } | null = null;
  const calls = new Map<string, PromptSummary>(); const turns = new Map<string, PromptTurn>();
  const controllers = new Set<AbortController>();
  function controller() { const c = new AbortController(); controllers.add(c); return c; }
  function resetSelection() {
    selectionRevision++; flight?.controller.abort(); flight = null; selected = null; data = null; tab = 'input';
    renderDetail();
  }
  function clear() {
    revision++;
    for (const c of controllers) c.abort(); controllers.clear();
    calls.clear(); turns.clear(); list.replaceChildren(); resetSelection();
  }
  function report(error: unknown, target: HTMLElement) {
    if (signal.aborted || disposed || (error instanceof Error && error.name === 'AbortError')) return;
    target.textContent = P.failed; deps.onError(error);
  }
  function renderDetail() {
    detailHost.replaceChildren();
    const call = selected ? calls.get(selected) : undefined;
    if (!call) { detailHost.append(ui.h('p', 'prompt-pick', P.pickRound)); return; }
    const title = ui.h('h3', 'prompt-selected-title', `${P.round(call.turnRound ?? call.round ?? call.sequence)} · ${P.outcomes[call.outcome]}`);
    const elapsed = call.finishedAt ? Math.max(0, Date.parse(call.finishedAt) - Date.parse(call.startedAt)) : null;
    const meta = ui.h('div', 'prompt-call-meta', `${call.sessionId || call.role} · ${call.model} · ${P.globalRound} ${call.round ?? '—'} · #${call.sequence}${elapsed !== null ? ` · ${P.elapsed} ${elapsed}ms` : ''}`);
    const tabs = ui.h('div', 'prompt-tabs'); tabs.setAttribute('role', 'tablist');
    const names: Record<PromptTab, string> = { input: P.inputTab, result: P.resultTab, tools: P.toolsTab };
    for (const key of ['input', 'result', 'tools'] as const) {
      const button = ui.button(names[key], { onClick: () => { tab = key; renderDetail(); } });
      button.setAttribute('data-tab', key); button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab === key)); tabs.append(button);
    }
    detailHost.append(title, meta, tabs);
    if (data) detailHost.append(renderRoundPane(ui, data, tab));
    else detailHost.append(ui.h('p', 'prompt-pane', P.loading));
  }
  function renderNav() { renderPromptNavigation(ui, list, [...calls.values()].sort((a, b) => b.sequence - a.sequence), turns, selected, run === currentRun, choose); }
  function trim() {
    const sorted = [...calls.values()].sort((a, b) => b.sequence - a.sequence);
    for (const old of sorted.slice(VISIBLE_CALLS)) calls.delete(old.id);
    if (selected && !calls.has(selected)) resetSelection();
  }
  function pruneTurns() {
    const retained = new Set([...calls.values()].map(call => call.turnId));
    for (const [id, turn] of turns) if (!retained.has(id) && (turn.calls > 0 || turn.endedAt)) turns.delete(id);
  }
  function upsert(summary: PromptSummary) {
    const old = calls.get(summary.id);
    if (old && old.outcome !== 'pending' && summary.outcome === 'pending') return;
    calls.set(summary.id, summary); trim();
  }
  function updateTurn(turn: PromptTurn) {
    const old = turns.get(turn.id);
    if (old?.endedAt && !turn.endedAt) return;
    turns.set(turn.id, { ...turn, calls: Math.max(turn.calls, old?.calls ?? 0) });
  }
  function choose(id: string) {
    if (!calls.has(id)) return;
    resetSelection(); selected = id; renderNav(); renderDetail(); void loadDetail();
  }
  async function loadDetail() {
    if (!selected || disposed) return;
    if (flight?.id === selected) { flight.dirty = true; return; }
    const id = selected; const rev = revision; const sel = selectionRevision; const c = controller();
    const operation = { id, controller: c, dirty: false }; flight = operation;
    try {
      const next = await get<PromptDetail>(`/api/prompt-snapshots/detail?${new URLSearchParams({ run, id })}`, { signal: c.signal });
      if (rev !== revision || sel !== selectionRevision || selected !== id || !calls.has(id) || disposed || signal.aborted) return;
      data = next; renderDetail();
    } catch (error) { if (rev === revision && sel === selectionRevision) report(error, detailHost); }
    finally {
      controllers.delete(c);
      if (flight === operation) flight = null;
      if (operation.dirty && rev === revision && sel === selectionRevision && selected === id && calls.has(id) && !disposed && !signal.aborted) void loadDetail();
    }
  }
  async function load() {
    if (!run || disposed) return;
    const rev = revision; const c = controller();
    const query = new URLSearchParams({ run, limit: String(VISIBLE_CALLS) });
    if (session.value.trim()) query.set('session', session.value.trim());
    state.textContent = P.loading;
    try {
      const page = await get<PromptList>(`/api/prompt-snapshots?${query}`, { signal: c.signal });
      if (rev !== revision || disposed || signal.aborted) return;
      for (const turn of page.turns ?? []) updateTurn(turn);
      for (const summary of page.items) upsert(summary);
      pruneTurns(); renderNav();
      state.textContent = !page.recorded ? P.unrecorded : calls.size ? '' : P.empty;
    } catch (error) { if (rev === revision) report(error, state); }
    finally { controllers.delete(c); }
  }
  async function refresh() {
    clear();
    const rev = revision; const c = controller();
    try {
      const reply = await get<{ current: string | null; runs: Array<{ run: string }> }>('/api/runs', { signal: c.signal });
      if (rev !== revision || disposed || signal.aborted) return;
      currentRun = reply.current ?? ''; runSelect.replaceChildren();
      const ids = [...new Set([currentRun, ...reply.runs.map(r => r.run)].filter(Boolean))];
      if (followCurrent || !ids.includes(run)) run = currentRun || ids[0] || '';
      for (const id of ids) { const option = ui.h('option', null, id); option.value = id; runSelect.append(option); }
      runSelect.value = run; initialized = true;
      if (!run) state.textContent = P.unrecorded;
      await load();
    } catch (error) { if (rev === revision) report(error, state); }
    finally { controllers.delete(c); }
  }
  async function selectSession(id: string) { session.value = id; clear(); if (initialized) await load(); }
  runSelect.addEventListener('change', () => { run = runSelect.value; followCurrent = run === currentRun; clear(); void load(); }, { signal });
  session.addEventListener('change', () => { void selectSession(session.value); }, { signal });
  function dispose() { disposed = true; clear(); }
  signal.addEventListener('abort', dispose, { once: true }); renderDetail();
  return {
    el, refresh, selectSession, dispose,
    notify(summary: PromptSummary) {
      if (!initialized || summary.run !== run || (session.value.trim() && summary.sessionId !== session.value.trim())) return;
      upsert(summary); pruneTurns(); renderNav(); state.textContent = '';
      if (selected === summary.id && calls.has(summary.id)) { renderDetail(); void loadDetail(); }
    },
    notifyTurn(turn: PromptTurn) {
      if (!initialized || turn.run !== run || (session.value.trim() && turn.sessionId !== session.value.trim())) return;
      updateTurn(turn); renderNav();
    },
  };
}
