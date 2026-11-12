/** Group only by recorded boundaries; legacy calls remain independent. */
import type { WebUi } from '../../../shared/client-panel.ts';
import type { PromptSummary, PromptTurn } from '../../../shared/prompt.ts';
import { P } from './prompt-strings.ts';

export function renderPromptNavigation(ui: WebUi, target: HTMLElement, calls: readonly PromptSummary[], turns: ReadonlyMap<string, PromptTurn>, selected: string | null, current: boolean, choose: (id: string) => void): void {
  const open = new Set([...target.querySelectorAll<HTMLDetailsElement>('details[open]')].map(el => el.dataset.turn));
  const hadGroups = target.children.length > 0;
  const scrollTop = target.scrollTop;
  const groups = new Map<string, PromptSummary[]>();
  for (const call of calls) {
    const key = JSON.stringify([call.sessionId, call.turnId ?? `legacy:${call.id}`]);
    const group = groups.get(key) ?? []; group.push(call); groups.set(key, group);
  }
  target.replaceChildren();
  let index = 0;
  for (const [key, group] of groups) {
    group.sort((a, b) => (a.turnRound ?? a.sequence) - (b.turnRound ?? b.sequence));
    const first = group[0]; const meta = first.turnId ? turns.get(first.turnId) : undefined;
    const total = Math.max(meta?.calls ?? 0, ...group.map(c => c.turnRound ?? 1));
    const box = ui.h('details', 'prompt-turn'); box.dataset.turn = key;
    box.open = open.has(key) || group.some(c => c.id === selected) || (!hadGroups && index === 0);
    index++;
    const state = !first.turnId ? P.legacyTurn : meta?.endedAt ? P.turnClosed : meta ? current ? P.turnOpen : P.turnUnsettled : P.turnUnsettled;
    const at = meta?.startedAt ?? first.startedAt;
    const heading = ui.h('summary', null, `${P.process} · ${first.sessionId || first.role || '—'} · ${new Date(at).toLocaleTimeString()} · ${P.rounds(total)} · ${state}`);
    box.append(heading);
    if (group.length < total) box.append(ui.h('div', 'prompt-window-note', P.partialWindow(group.length, total)));
    const rounds = ui.h('div', 'prompt-rounds');
    for (const call of group) {
      const output = call.toolCallCount ? P.toolCallSummary(call.toolCallCount) : call.outputCount !== undefined ? P.returnedItems(call.outputCount) : '';
      const label = `${P.round(call.turnRound ?? call.round ?? call.sequence)} · ${call.sessionId || call.role} · ${P.outcomes[call.outcome]}${output ? ` · ${output}` : ''}`;
      const button = ui.button(label, { onClick: () => choose(call.id) });
      button.className = `prompt-call${call.id === selected ? ' selected' : ''}`;
      button.setAttribute('data-call', call.id); button.setAttribute('aria-current', String(call.id === selected));
      rounds.append(button);
    }
    box.append(rounds); target.append(box);
  }
  target.scrollTop = scrollTop;
}
