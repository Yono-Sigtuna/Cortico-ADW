/**
 * 面板 `wake` —— 开着的对话线索、最近的唤醒记录、背景摘要与效果统计。
 * 数据由 bot 装配层提供：线索问 QQ World，唤醒日志读部署 data/wakes.jsonl，
 * 人工评分读 data/wake-ratings.jsonl。
 */

import type { WebUiPanelContext, WebUiPanel } from 'cortico/web/shared/client-panel.ts';
import { autoload, errText, setMsg } from '../../cormini/webui/shared.ts';

interface WakeThread {
  conv: string;
  person: string;
  personName?: string;
  openedAt: number;
  lastMessageAt: number;
}

interface WakeSummary {
  id?: string;
  ts?: string;
  reason?: string;
  matchedName?: string;
  outcome?: string;
  durationMs?: number;
  estTokens?: number | null;
  cards?: string[];
  calls?: string[];
  sent?: string | null;
  rating?: { score?: number; note?: string };
}

interface WakeView {
  threads: WakeThread[];
  wakes: WakeSummary[];
  ambient: { enabled: boolean; intervalMinutes: number; buffered: number };
  stats: { libraryReads: number; rated: number; average: number | null };
}

function timeText(value: number | string | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export const wakePanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    autoload<WakeView>(ctx, {
      loading: '加载唤醒与线索…',
      failed: '唤醒记录不可用',
      load: () => ctx.invoke<WakeView>('list'),
      render: (view, reload) => [sheet(ctx, view, reload)],
    });
  },
};

function sheet(ctx: WebUiPanelContext, view: WakeView, reload: () => void): HTMLElement {
  const { ui } = ctx;
  const average = view.stats.average === null ? '—' : `${view.stats.average.toFixed(1)}/5`;
  const card = ui.sheet({
    title: '唤醒与线索',
    en: 'wakes & threads',
    desc: `背景摘要 ${view.ambient.enabled ? '开' : '关'} · 每 ${view.ambient.intervalMinutes} 分钟 · 缓冲 ${view.ambient.buffered} 条`
      + ` · 资料库读取 ${view.stats.libraryReads} 次 · 已评分 ${view.stats.rated} 条 · 平均 ${average}`,
  });
  const msg = ui.msgline('');

  const bar = ui.rowbar();
  bar.append(ui.h('span', 'grow'), ui.button('刷新', { size: 'sm', onClick: () => reload() }));
  card.body.appendChild(bar);

  const threads = ui.table({ head: ['会话', '对方', '打开时间', '最后消息', '操作'] });
  if (!view.threads.length) threads.clear('现在没有开着的对话线索。');
  for (const thread of view.threads) {
    const close = ui.button('关闭', {
      size: 'sm',
      variant: 'plain',
      onClick: () => { void closeThread(ctx, thread, msg, reload); },
    });
    threads.addRow([
      { text: thread.conv, cls: 'mono' },
      { text: thread.personName ? `${thread.personName}(${thread.person})` : thread.person, cls: 'mono' },
      { text: timeText(thread.openedAt) },
      { text: timeText(thread.lastMessageAt) },
      { el: close },
    ]);
  }
  card.body.appendChild(threads.el);

  const wakes = ui.table({
    head: ['时间', '原因', '结果', '耗时', '动作 / 发送', '评分'],
    maxHeight: 'calc(100vh - 460px)',
  });
  if (!view.wakes.length) wakes.clear('还没有唤醒记录。');
  for (const wake of view.wakes) {
    const reason = `${wake.reason ?? '?'}${wake.matchedName ? ` (${wake.matchedName})` : ''}`;
    const detail = [wake.calls?.length ? wake.calls.join(' → ') : '', wake.sent ?? ''].filter(Boolean).join('  ');
    wakes.addRow([
      { text: timeText(wake.ts) },
      { el: ui.pill(reason, 'plain') },
      { el: ui.pill(wake.outcome ?? '?', 'plain') },
      { text: `${wake.durationMs ?? 0}ms · ${wake.estTokens ?? '?'} tok`, cls: 'mono' },
      { text: detail || '—', cls: 'txt' },
      { el: ratingCell(ctx, wake, msg, reload) },
    ]);
  }
  card.body.appendChild(wakes.el);
  card.body.appendChild(msg);
  return card.el;
}

function ratingCell(
  ctx: WebUiPanelContext,
  wake: WakeSummary,
  msg: HTMLElement,
  reload: () => void,
): HTMLElement {
  const { ui } = ctx;
  if (wake.rating?.score) return ui.pill(`★ ${wake.rating.score}`, 'on');
  if (!wake.id) return ui.pill('—', 'plain');
  return ui.select({
    value: '',
    options: [
      { value: '', label: '评分' },
      ...[1, 2, 3, 4, 5].map((score) => ({ value: String(score), label: `${score} 分` })),
    ],
    onInput: (value) => {
      if (!value) return;
      void rate(ctx, wake.id!, Number(value), msg, reload);
    },
  });
}

async function rate(
  ctx: WebUiPanelContext,
  id: string,
  score: number,
  msg: HTMLElement,
  reload: () => void,
): Promise<void> {
  try {
    const out = await ctx.invoke<string>('rate', [id, score]);
    setMsg(msg, out);
    reload();
  } catch (err) {
    setMsg(msg, `评分失败: ${errText(err)}`, true);
  }
}

async function closeThread(
  ctx: WebUiPanelContext,
  thread: WakeThread,
  msg: HTMLElement,
  reload: () => void,
): Promise<void> {
  const ok = await ctx.ui.confirm({
    title: `关闭 ${thread.conv} / ${thread.person} 的线索?`,
    body: '关闭后这个人的消息不再单独唤醒她，仍会出现在背景摘要里。再叫一次名字会重新开线。',
  });
  if (!ok) return;
  try {
    const out = await ctx.invoke<string>('closeThread', [thread.conv, thread.person]);
    setMsg(msg, out);
    reload();
  } catch (err) {
    setMsg(msg, `关闭失败: ${errText(err)}`, true);
  }
}
