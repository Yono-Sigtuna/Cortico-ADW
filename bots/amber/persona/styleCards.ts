/**
 * 语气卡的检索：**场景**（什么事）× **姿态**（用什么分寸）。
 *
 * 常驻的那几张（`prompts/style/core/`）放在 session 头部，是 few-shot 示例；
 * 资料库里的（`note/style/`）不进前缀，只在情形对得上时递一张。
 *
 * 文件名就是检索键：`<编号>-<场景>[-<姿态标签>]…`。
 *   场景：见 `CARD_TRIGGERS`，决定"这句话在说什么事"。
 *   姿态：跟谁（关系）、什么心情、身体什么状态，决定"同一件事用什么分寸"。
 *
 * 例：`13-affection-cold` = 有人在撩她，但这个人还只是点头之交。
 *     `14-affection-close-bright` = 很熟、心情也好，同样一句撩拨可以接得更近。
 *
 * 匹配规则：**场景必须对上，写了几个姿态就必须全对上**；对上得越多越具体，
 * 越具体越优先。同分按编号——编号就是兜底优先级。
 */

export interface StyleCard {
  /** 文件名去掉编号与 `-user.md`，例如 `05-short-user.md` → `05-short`。 */
  key: string;
  question: string;
  answer: string;
}

/** 场景词 → 什么话算这个场景。加场景必须同时补卡，不然这一类永远不会被递出去。 */
export const CARD_TRIGGERS: Record<string, RegExp> = {
  tech: /报错|错误|bug|崩了|跑不起来|跑不通|部署|编译|脚本|代码|日志|接口|环境/i,
  comfort: /难受|难过|想哭|哭了|失败|好累|撑不住|崩溃|害怕|不想活|无聊透/,
  tease: /大小姐|哈哈哈|笑死|敢不敢|是不是被|赌一把|来试试/,
  unknown: /是谁|什么梗|没听过|新起的外号|不认识|什么意思/,
  aftercare: /我没事|真的没事|不用担心|我挺好的/,
  pride: /厉不厉害|牛不牛|我是不是很|夸我|厉害吧|佩服不/,
  short: /^(嗯|哦|啊|哈|好|行|是)[。！？!?…]*$/,
  interject: /所以呢|然后呢|怎么说|那你呢|你觉得呢/,
  'no-appease': /对不起|都怪我|我错了|是我不好/,
  affection: /喜欢你|爱你|抱抱|亲一下|当我女朋友|想你/,
  /** 问到她本人是谁、是不是 AI、怎么想自己——这类最容易答成答辩。 */
  self: /你是(不(是)?\s*)?(AI|机器|bot|程序|真人)|你是不是人|你到底是什么|你怎么看你自己|你有意识吗/i,
  /** 不带字的图：只接情绪，不解析。 */
  image: /\[图片[^\]]*\]/,
  /** 道别、催睡。 */
  goodnight: /晚安|睡了|先去睡|该睡了|快睡吧/,
};

// ---------------------------------------------------------------------------
// 姿态：三根轴
// ---------------------------------------------------------------------------

/**
 * 关系档。阈值贴着 `relations.json` 的真实刻度——实测最高 0.164（群主），
 * 其余 0.02–0.07。按"三个月才到最喜欢"的账，`close` 是要以月计的，
 * 不是十天就能到的地方；`newcomer` 留给真的没打过交道的人。
 */
export type RelationStance = 'newcomer' | 'cold' | 'warm' | 'close';

/** 心情档：取当前最强的那一维，和最弱的比。 */
export type MoodStance = 'bright' | 'even' | 'low' | 'irritated';

/** 生理档：精力、社交电量、负荷三样合起来看。 */
export type BodyStance = 'fresh' | 'steady' | 'spent';

export interface CardContext {
  relation: RelationStance;
  mood: MoodStance;
  body: BodyStance;
}

/** 派姿态要的原始读数；缺哪一样就按"不知道"处理，不猜。 */
export interface StanceInput {
  affinity?: number;
  mood?: { baseline: number; joy: number; anger: number; sorrow: number; fear: number } | null;
  /** 0–100 */
  energy?: number | null;
  /** 0–1 */
  socialBattery?: number | null;
  /** 0–1 */
  load?: number | null;
}

export function relationOf(affinity: number | undefined): RelationStance {
  const value = Number.isFinite(affinity) ? (affinity as number) : 0;
  if (value < 0.02) return 'newcomer';
  if (value < 0.08) return 'cold';
  if (value < 0.2) return 'warm';
  return 'close';
}

export function moodOf(mood: StanceInput['mood']): MoodStance {
  if (!mood) return 'even';
  const { baseline, joy, anger, sorrow, fear } = mood;
  if (anger >= 5 && anger >= joy && anger >= sorrow && anger >= fear) return 'irritated';
  if (sorrow >= 5 || fear >= 5) return 'low';
  if (joy >= 7 && joy > sorrow && joy > anger) return 'bright';
  // 基线高但四维都不突出：就是平静，不硬安一个情绪。
  return joy > baseline + 1 ? 'bright' : 'even';
}

export function bodyOf(energy: number | null | undefined, battery: number | null | undefined, load: number | null | undefined): BodyStance {
  const e = typeof energy === 'number' ? energy : 60;
  const b = typeof battery === 'number' ? battery : 0.6;
  const l = typeof load === 'number' ? load : 0;
  if (e < 35 || b < 0.3 || l >= 0.6) return 'spent';
  if (e >= 70 && b >= 0.6 && l < 0.3) return 'fresh';
  return 'steady';
}

export function contextOf(input: StanceInput = {}): CardContext {
  return {
    relation: relationOf(input.affinity),
    mood: moodOf(input.mood),
    body: bodyOf(input.energy, input.socialBattery, input.load),
  };
}

// ---------------------------------------------------------------------------
// 文件名解析
// ---------------------------------------------------------------------------

const RELATION_TAGS: readonly string[] = ['newcomer', 'cold', 'warm', 'close'];
const MOOD_TAGS: readonly string[] = ['bright', 'even', 'low', 'irritated'];
const BODY_TAGS: readonly string[] = ['fresh', 'steady', 'spent'];
/** 卡名尾巴上的变体词，不是姿态：`08-aftercare-bite` 的 `bite`。 */
const VARIANTS = new Set(['bite', 'reply', 'deflect', 'user', 'line']);

export interface CardKeyParts {
  scene: string;
  tags: Partial<CardContext>;
}

/** `13-affection-cold` → `{ scene: 'affection', tags: { relation: 'cold' } }`。 */
export function parseCardKey(key: string): CardKeyParts {
  let body = key.replace(/^\d+-/, '');
  const tags: Partial<CardContext> = {};
  for (;;) {
    const match = /-([a-z]+)$/.exec(body);
    if (!match) break;
    const word = match[1]!;
    if (VARIANTS.has(word)) {
      body = body.slice(0, -word.length - 1);
      continue;
    }
    if (tags.relation === undefined && RELATION_TAGS.includes(word)) {
      tags.relation = word as RelationStance;
      body = body.slice(0, -word.length - 1);
      continue;
    }
    if (tags.mood === undefined && MOOD_TAGS.includes(word)) {
      tags.mood = word as MoodStance;
      body = body.slice(0, -word.length - 1);
      continue;
    }
    if (tags.body === undefined && BODY_TAGS.includes(word)) {
      tags.body = word as BodyStance;
      body = body.slice(0, -word.length - 1);
      continue;
    }
    break;
  }
  return { scene: body, tags };
}

/** `05-short` → `short`；`08-aftercare-bite` → `aftercare`；`13-affection-cold` → `affection`。 */
export function categoryOf(key: string): string {
  return parseCardKey(key).scene;
}

/** 这张卡挂了几个姿态；0 就是通用卡。 */
export function specificityOf(key: string): number {
  const { tags } = parseCardKey(key);
  return [tags.relation, tags.mood, tags.body].filter(Boolean).length;
}

export function tagsMatch(key: string, ctx: CardContext): boolean {
  const { tags } = parseCardKey(key);
  if (tags.relation !== undefined && tags.relation !== ctx.relation) return false;
  if (tags.mood !== undefined && tags.mood !== ctx.mood) return false;
  if (tags.body !== undefined && tags.body !== ctx.body) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

/**
 * 从候选里挑一张最贴这一轮的话。
 *
 * 场景必须对上；写了姿态的卡必须全对；**越具体越优先**，同分按编号。
 * 同一轮只递一张：递两张以上，她会开始照台词念。
 */
export function pickStyleCard(
  text: string,
  cards: readonly StyleCard[],
  skip: ReadonlySet<string> = new Set(),
  stance: StanceInput = {},
): StyleCard | null {
  const flat = (text ?? '').replace(/\s+/g, '');
  if (!flat) return null;
  const ctx = contextOf(stance);
  const eligible = [...cards]
    .sort((a, b) => a.key.localeCompare(b.key))
    .filter((card) => {
      if (skip.has(card.key)) return false;
      if (!card.question.trim() || !card.answer.trim()) return false;
      const { scene } = parseCardKey(card.key);
      const trigger = CARD_TRIGGERS[scene];
      if (!trigger || !trigger.test(flat)) return false;
      return tagsMatch(card.key, ctx);
    });
  // 具体优先：挂了两三个姿态的卡比通用卡更贴此刻，先递它。
  eligible.sort((a, b) => specificityOf(b.key) - specificityOf(a.key));
  return eligible[0] ?? null;
}

// ---------------------------------------------------------------------------
// 照念检测
// ---------------------------------------------------------------------------

/** 她的回话和卡上那句的字面重合度。用来发现"照着卡念"。 */
export function cardEcho(answer: string, reply: string): number {
  const grams = (s: string): Set<string> => {
    const flat = (s ?? '').replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i < flat.length - 1; i += 1) out.add(flat.slice(i, i + 2));
    return out;
  };
  const left = grams(answer);
  const right = grams(reply);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** 重合到这条线以上，就算照念——卡是气质不是台词。 */
export const RECITE_ECHO = 0.75;

// ---------------------------------------------------------------------------
// 递到她眼前的写法
// ---------------------------------------------------------------------------

/** 卡片标签，给面板与注入文案用：`['affection', 'cold']`。 */
export function cardLabel(key: string): string {
  const { scene, tags } = parseCardKey(key);
  const parts: string[] = [scene];
  if (tags.relation) parts.push(tags.relation);
  if (tags.mood) parts.push(tags.mood);
  if (tags.body) parts.push(tags.body);
  return parts.join('/');
}

/** 只取姿态标签，不带场景：`13-affection-cold` → `['cold']`。 */
export function cardTags(key: string): string[] {
  const { tags } = parseCardKey(key);
  const out: string[] = [];
  if (tags.relation) out.push(tags.relation);
  if (tags.mood) out.push(tags.mood);
  if (tags.body) out.push(tags.body);
  return out;
}

/**
 * 递到她眼前的写法：这是她自己说过的话，不是这轮要念的台词。
 * 带姿态的卡会同时报出"此刻是什么姿态"，让她知道这张卡是按什么挑的。
 */
export function styleCardLine(card: StyleCard, source: string, ctx?: CardContext): string {
  const label = cardLabel(card.key);
  const now = ctx && specificityOf(card.key) > 0
    ? `（此刻：对这个人 ${ctx.relation}，心情 ${ctx.mood}，身体 ${ctx.body}）`
    : '';
  return `[语气卡·${label}]${now} 类似的情形你以前这样接过——「${card.question}」→「${card.answer}」`
    + `（出处 ${source}）。这是你自己的说法，像就用，不像就按自己的来。`;
}
