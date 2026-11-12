/**
 * 面板 `cards` —— 语气卡分两层：
 *   core    = 部署 prompts/style/core/，常驻 sessionHead，每轮都在（有预算）。
 *   library = 工作区 note/style/，她自己按需 read_file，不进每轮前缀。
 * 保存写文件；Persona 下一次 sessionHead / read_file 即生效。
 */

import type { WebUiPanelContext, WebUiPanel } from 'cortico/web/shared/client-panel.ts';
import { autoload, errText, setMsg } from '../../cormini/webui/shared.ts';

type Tier = 'core' | 'library';

interface ToneCard {
  name: string;
  question: string;
  answer: string;
  /** 文件名里的情景类别：哪类话会把它递出来。 */
  scene?: string;
  /** 姿态标签（关系/心情/身体），斜杠分隔；空 = 通用卡。 */
  stance?: string;
}

/** 质量门记的账：递了几次、她开口几次、照念几次。 */
interface CardStat {
  card: string;
  shots: number;
  sent: number;
  silent: number;
  recited: number;
  avgEcho: number;
  lastAt: string;
}

interface CardsView {
  core: ToneCard[];
  library: ToneCard[];
  stats?: CardStat[];
}

interface SaveResult {
  ok: boolean;
  result: string;
  warnings?: string[];
  state: CardsView;
}

export const cardsPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    autoload<CardsView>(ctx, {
      loading: '读取语气卡…',
      failed: '语气卡不可用',
      load: () => ctx.invoke<CardsView>('list'),
      render: (view, reload) => {
        const stats = new Map((view.stats ?? []).map((stat) => [stat.card, stat]));
        return [
          createCard(ctx, reload),
          ...view.core.map((card) => cardSheet(ctx, card, 'core', reload, stats.get(card.name))),
          ...view.library.map((card) => cardSheet(ctx, card, 'library', reload, stats.get(card.name))),
        ];
      },
    });
  },
};

function cardSheet(
  ctx: WebUiPanelContext, card: ToneCard, tier: Tier, reload: () => void, stat?: CardStat,
): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: card.name,
    en: tier === 'core' ? '常驻核心卡' : '资料库',
    desc: tier === 'core' ? '每轮请求都会带上这张卡。' : '放在工作区 note/style/，需要时她自己读。',
  });
  const question = ui.textarea({ value: card.question, rows: 2, placeholder: '群友说…' });
  const answer = ui.textarea({ value: card.answer, rows: 3, placeholder: '她会怎么回…' });
  const msg = ui.msgline('');
  // 这张卡在哪种情形下会被递、属于哪一档；没记过账就直说没递过。
  const scene = card.scene ? `情景 ${card.scene}` : '';
  const tierLabel = card.stance ? `姿态 ${card.stance}` : '';
  const gate = stat
    ? `递 ${stat.shots} 次 · 开口 ${stat.sent} 次 · 照念 ${stat.recited} 次 · 平均重合 ${stat.avgEcho}`
    : '还没递出去过';
  const metering = [scene, tierLabel, gate].filter(Boolean).join(' · ');
  const gateBad = stat !== undefined && stat.shots >= 3 && stat.recited >= 2;

  const bar = ui.rowbar();
  bar.append(
    ui.button('保存', {
      size: 'sm',
      variant: 'primary',
      onClick: () => { void saveCard(ctx, tier, card.name, question, answer, msg, reload); },
    }),
    ui.button(tier === 'core' ? '移入资料库' : '设为常驻', {
      size: 'sm',
      variant: 'plain',
      onClick: () => { void moveCard(ctx, tier, card.name, msg, reload); },
    }),
    ui.button('删除', {
      size: 'sm',
      variant: 'plain',
      onClick: () => { void removeCard(ctx, tier, card.name, msg, reload); },
    }),
  );
  sheet.body.append(
    ui.field('群友', question),
    ui.field('她', answer),
    ui.h('p', gateBad ? 'muted bad' : 'muted', metering),
    bar,
    msg,
  );
  return sheet.el;
}

function createCard(ctx: WebUiPanelContext, reload: () => void): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '新建语气卡',
    en: 'new card',
    desc: '常驻核心卡最多 6 张、总字数 2400；其余放资料库。卡片名只用字母、数字、_ 和 -。',
  });
  const name = ui.input({ placeholder: '例如 11-comfort', cls: 'mono' });
  const tier = ui.select({
    value: 'core',
    options: [
      { value: 'core', label: '常驻核心卡' },
      { value: 'library', label: '资料库' },
    ],
  });
  const question = ui.textarea({ rows: 2, placeholder: '群友说…' });
  const answer = ui.textarea({ rows: 3, placeholder: '她会怎么回…' });
  const msg = ui.msgline('');
  const bar = ui.rowbar();
  bar.appendChild(ui.button('创建', {
    size: 'sm',
    variant: 'primary',
    onClick: () => {
      void saveCard(ctx, tier.value as Tier, name.value.trim(), question, answer, msg, reload);
    },
  }));
  sheet.body.append(
    ui.field('名字', name),
    ui.field('层级', tier),
    ui.field('群友', question),
    ui.field('她', answer),
    bar,
    msg,
  );
  return sheet.el;
}

async function saveCard(
  ctx: WebUiPanelContext,
  tier: Tier,
  name: string,
  question: HTMLTextAreaElement,
  answer: HTMLTextAreaElement,
  msg: HTMLElement,
  reload: () => void,
): Promise<void> {
  try {
    const out = await ctx.invoke<SaveResult>('save', [tier, name, question.value, answer.value]);
    setMsg(msg, out.warnings?.length ? `${out.result} · 提醒：${out.warnings.join('；')}` : out.result);
    reload();
  } catch (err) {
    setMsg(msg, `保存失败: ${errText(err)}`, true);
  }
}

async function moveCard(
  ctx: WebUiPanelContext,
  tier: Tier,
  name: string,
  msg: HTMLElement,
  reload: () => void,
): Promise<void> {
  const to: Tier = tier === 'core' ? 'library' : 'core';
  try {
    const out = await ctx.invoke<SaveResult>('move', [tier, to, name]);
    setMsg(msg, out.result);
    reload();
  } catch (err) {
    setMsg(msg, `移动失败: ${errText(err)}`, true);
  }
}

async function removeCard(
  ctx: WebUiPanelContext,
  tier: Tier,
  name: string,
  msg: HTMLElement,
  reload: () => void,
): Promise<void> {
  const ok = await ctx.ui.confirm({
    title: `删除语气卡「${name}」?`,
    body: '会删除这一组 user/reply 两个文件；删掉后下一次请求 / 读取就不再带上它。',
  });
  if (!ok) return;
  try {
    const out = await ctx.invoke<SaveResult>('delete', [tier, name]);
    setMsg(msg, out.result);
    reload();
  } catch (err) {
    setMsg(msg, `删除失败: ${errText(err)}`, true);
  }
}
