/**
 * 注意力显著性：不是每条消息都值得她停下来。
 *
 * 世界已经能分清"叫到她"和"没叫到她"，但没叫到的那些全被同一档处理——
 * 要么全部缓冲（每次背景摘要都可能把她叫醒），要么全部归档。真实存在者
 * 有一个显著性瓶颈：有人问了个具体问题、这个群正吵、或者同一个人第五次
 * 复读同一句，值得留意；剩下的是背景噪声。
 *
 * 这一层只做判决，不做生成：`focus` 照常投递，`periphery` 进背景缓冲
 * （下次被叫到时搭车，或随定时摘要出现），`background` 只归档、不缓冲、
 * 不唤醒，但要能被面板看见"为什么没注意"。
 *
 * 判决必须是确定性的：同一串事实永远得到同一档，方便复盘和写测试。
 */

export type AttentionTier = 'focus' | 'periphery' | 'background';

export interface AttentionConfig {
  enabled: boolean;
  /** 进入 periphery 的分数线；低于它只归档。 */
  peripheryThreshold: number;
  /** 负荷与连续发言的统计窗口（分钟）。 */
  windowMinutes: number;
  /** 同一句话在这个时间内重复出现算"已经听过了"（分钟）。 */
  habituationMinutes: number;
}

export const ATTENTION_DEFAULTS: AttentionConfig = {
  enabled: false,
  peripheryThreshold: 0.35,
  windowMinutes: 10,
  habituationMinutes: 30,
};

/** 配置可能只写了一半；缺的用默认值。 */
export function attentionConfig(raw?: Partial<AttentionConfig> | null): AttentionConfig {
  const clamp = (value: unknown, fallback: number, min: number, max: number): number => (
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  );
  return {
    enabled: raw?.enabled ?? ATTENTION_DEFAULTS.enabled,
    peripheryThreshold: clamp(raw?.peripheryThreshold, ATTENTION_DEFAULTS.peripheryThreshold, 0.05, 0.95),
    windowMinutes: clamp(raw?.windowMinutes, ATTENTION_DEFAULTS.windowMinutes, 1, 120),
    habituationMinutes: clamp(raw?.habituationMinutes, ATTENTION_DEFAULTS.habituationMinutes, 1, 480),
  };
}

export interface SalienceFacts {
  /** 直接叫到她（@ / 名字 / 未关的话头）。 */
  addressed: boolean;
  /** 私聊不设门槛：有人单独找她，就该看见。 */
  kind: 'group' | 'private';
  /** 这个群在窗口内的消息条数（含没叫她的）。 */
  windowMessages: number;
  /** 同一个人在窗口内的发言条数（不含本条）。 */
  senderMessages: number;
  /** 同一句话（归一化后）在习惯化窗口内出现过的次数（不含本条）。 */
  repeats: number;
  /** 在问问题。 */
  question: boolean;
  /** 情绪浓度高：夸张标点或情绪词。 */
  emotional: boolean;
  /** 今天第一次见这个人说话。 */
  firstToday: boolean;
  /** 这个会话上一条到现在多少分钟；刚静下来时重新开口的那条更有分量。 */
  lullMinutes?: number;
  /** 基本是一个人连着说，别人只偶尔插嘴。 */
  monologue?: boolean;
}

export interface SalienceResult {
  tier: AttentionTier;
  score: number;
  /** 给面板看的一句话，按贡献从大到小。 */
  reasons: string[];
}

/** 一条判决记录。面板读它回答"为什么没注意"，也用来算负荷与复读。 */
export interface AttentionEntry {
  at: number;
  ts: string;
  /** 本地日期，判断"今天第一次见到这个人"。 */
  day: string;
  conv: string;
  convKey: string;
  senderKey: string;
  senderName: string;
  tier: AttentionTier;
  score: number;
  reasons: string[];
  preview: string;
  /** 归一化正文，判复读用。 */
  hash: string;
}

/** 复读判定用的归一化：去掉空白、标点、链接，统一小写。 */
export function normalizeForRepeat(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\[图片[^\]]*\]/g, '[图片]')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

const QUESTION = /[?？]|吗|呢|怎么|为什么|为啥|如何|有没有|在哪|几点/;
const EMOTIONAL = /[!！]{2,}|哈{3,}|笑死|哭死|救命|离谱|卧槽|我操|操了|啊啊|呜呜|无语|气死|烦死|好家伙/;

export function looksQuestion(text: string): boolean {
  return QUESTION.test(text);
}

export function looksEmotional(text: string): boolean {
  return EMOTIONAL.test(text);
}

/**
 * 判决。
 *
 * 权重是有意的：**任何人类消息都有 0.2 的底分**——群里有人说话这件事本身
 * 就值得被记下来；够不够格进缓冲，靠问题、情绪、新鲜度往上加，靠复读和
 * 负荷往下扣。直接叫到她的永远是 focus，分数不参与。
 */
export function scoreMessage(facts: SalienceFacts, cfg: AttentionConfig): SalienceResult {
  if (facts.addressed) {
    return { tier: 'focus', score: 1, reasons: ['叫到你了'] };
  }
  if (facts.kind === 'private') {
    return { tier: 'focus', score: 1, reasons: ['私聊，单独找你'] };
  }
  if (!cfg.enabled) {
    // 关掉注意力时保持旧行为：没叫到的群消息进背景缓冲。
    return { tier: 'periphery', score: 0.5, reasons: ['注意力未开启，按背景缓冲'] };
  }

  let score = 0.2;
  const reasons: string[] = [];
  const add = (delta: number, reason: string): void => {
    score += delta;
    reasons.push(reason);
  };

  if (facts.firstToday) add(0.08, '今天第一次见这个人开口');
  if (facts.question) add(0.15, '在问具体问题');
  if (facts.emotional) add(0.12, '情绪浓度高');
  if (facts.senderMessages >= 2) add(0.05, `这个人连着说了 ${facts.senderMessages + 1} 条`);

  // 冷场之后重新开口的那条与刷屏里的第 N 条不是一回事：前者是话头，后者是噪音。
  // 刚起的进程窗口是空的，那时没有"上一条"可言，不能算成静了很久。
  if (facts.lullMinutes !== undefined && Number.isFinite(facts.lullMinutes) && facts.lullMinutes >= 5) {
    add(0.05, `群里静了 ${Math.round(facts.lullMinutes)} 分钟，这是重新开口的第一条`);
  }
  if (facts.monologue) add(-0.05, '这个群基本是一个人在连着说，别人只是偶尔插嘴');

  if (facts.windowMessages >= 12) add(-0.12, `群里 ${facts.windowMessages} 条正吵，负荷高`);
  else if (facts.windowMessages >= 6) add(-0.06, `群里已经 ${facts.windowMessages} 条，稍忙`);

  if (facts.repeats > 0) {
    const times = Math.min(facts.repeats, 3);
    add(-0.15 * times, `同一句话已经出现 ${facts.repeats} 次`);
  }

  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  const tier: AttentionTier = score >= cfg.peripheryThreshold ? 'periphery' : 'background';
  if (tier === 'background') {
    reasons.push(`分 ${score.toFixed(2)} 低于 ${cfg.peripheryThreshold.toFixed(2)}，只归档`);
  }
  return { tier, score, reasons };
}

/** 纯附和：一个字的重复、常见应答、单个表情。判的是这条消息有没有内容，与群多吵无关。 */
const FILLER_WORDS = /^(哈+|呵+|嘿+|嘻+|嗯+|哦+|噢+|喔+|啊+|呀+|好+|行+|可+|对+|是+|收到|好[的了]|谢谢|笑死|草+|6+|w+|额+|牛+|棒+|赞+)$/;

export function isFillerMessage(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  // 群名片以外的纯表情消息（贴图另算：别人发的图她可能真要接）。
  if (/^\[表情[:：][^\]]*\]$/.test(raw)) return true;
  const compact = raw.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!compact) return true;
  return FILLER_WORDS.test(compact);
}
