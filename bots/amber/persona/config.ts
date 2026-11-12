/**
 * Persona发布的层 2 建议配置；层 3 的 `config.json` 部署值优先。
 * 内容是Persona参数与 session 阶段容量。用哪个模型、模型物理上下文上限
 * 都是 Provider 事实,不在这里。
 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';

/** Persona建议的配置片段(会被 config.json 覆盖) */
export interface PersonaConfig {
  context: {
    /** 用于计算预警阈值和交接笔记预算。 */
    maxTokens: number;
    /** 交接笔记预算占阶段预算的比例。 */
    keepRatio: number;
    /** 超过阶段预算的此比例时先提示；下一批结束时仍超出则交接。 */
    softRatio: number;
    /** 是否把部署 prompts/ 里的首轮对话作为合成开头送进请求。 */
    firstTurn: boolean;
  };
  loop: { softCap: number; hardCap: number };
  memo: { residentCap: number; activeCap: number };
  tick: {
    dayIntervalMinutes: [number, number];
    nightIntervalMinutes: number | null;
    nightStartHour: number;
    nightEndHour: number;
  };
  dream: { maxRounds: number; cooldownMinutes: number; inheritTokens: number; contextTokens: number };
  /** 长期记忆的生命周期与自动注入。 */
  memory: {
    /** 每日衰减率：越低忘得越慢。 */
    decayRate: number;
    /** 多少天没被想起就转入休眠（不删除，仍可主动召回）。 */
    dormantDays: number;
    /** 每次唤醒自动注入几条；0 = 关闭自动注入。 */
    injectTopK: number;
    /** 向量模型名；空 = 只用关键词检索。 */
    embeddingModel: string;
    /** OpenAI 兼容的 embeddings 端点根地址。key 走环境变量 CORTICO_EMBEDDING_KEY。 */
    embeddingBaseUrl: string;
  };
  /** 陪伴层：她自己的时间，和"要不要主动开口"。 */
  companion: {
    enabled: boolean;
    allowPrivate: boolean;
    allowGroups: boolean;
    /** 允许接群里正在聊的话题。 */
    participateGroups: boolean;
    /** 最近多少分钟内的发言才算"正在聊"。 */
    topicWindowMinutes: number;
    /** 每天最多接几次群话题。 */
    topicDailyCap: number;
    /** 低水位兜底：距上次梦超过这么多小时就强制入一次；0 = 只在上下文满时入梦。 */
    dreamEveryHours: number;
    dailyCap: number;
    followupMinutes: number;
    followupCooldownMinutes: number;
    quietStartHour: number;
    quietEndHour: number;
    sleepStartHour: number;
    sleepEndHour: number;
    /** 生活状态：她今天在过什么日子。 */
    life: {
      /** 天气用的城市名；空 = 不查天气。 */
      city: string;
      weatherEnabled: boolean;
      weatherRefreshMinutes: number;
      /** 推断地点时的"家"叫什么。 */
      homeName: string;
      /** 一天排几段日程。 */
      planItemCount: number;
      cycleEnabled: boolean;
      /** 最近一次月经开始日 YYYY-MM-DD；空 = 没校准。 */
      cycleAnchor: string;
    };
    /** 内感受：从事件流推出来的社交电量与负荷，作为主动开口的门。 */
    intero: {
      enabled: boolean;
      /** 电量低于它就不主动。 */
      lowBattery: number;
      /** 负荷高于它就不主动。 */
      highLoad: number;
      /** 电量低于它：回短句、不追问，并且慢半拍再投递。 */
      replyBattery: number;
      /** 电量跌到 0 时最多慢多少秒（按比例缩放）。 */
      hesitationSeconds: number;
    };
    /** 话头与开口预算：她自己决定"待会儿要说"的那条路。 */
    speak: {
      enabled: boolean;
      /** 每天无理由开口几次；用不完的带一点到第二天，封顶 1.5 倍。 */
      dailyCap: number;
    };
  };
  /** 动作描写：每轮注入一句许可或禁令；关掉就回到纯文字，下一轮生效。 */
  gesture: { enabled: boolean };
  /** 她自己的创作：没人叫她的时候，她自己写点东西。 */
  creative: {
    enabled: boolean;
    /** 每次写多少字。 */
    chunkChars: number;
    /** 同时进行中的作品数上限。 */
    maxActiveWorks: number;
    /** 两次续写之间隔多久（分钟，区间内按作品稳定取值）。 */
    advanceMinutes: [number, number];
    /** 一天最多写几段。 */
    maxChunksPerDay: number;
    /** 允许她把自己写的片段拿出来说一句。 */
    shareEnabled: boolean;
    /** 一天最多分享几次。 */
    shareDailyCap: number;
    /** 创作方向；空 = 跟着当下在过的日子走。 */
    direction: string;
    /** 长篇：目标字数放宽到几万到几十万，按章推进、按卷压缩。 */
    longForm?: boolean;
    /** 长篇每章多少字：到量就收一章、写摘要（800–12000）。 */
    chapterChars?: number;
    /** 长篇每卷几章（2–20）。 */
    chaptersPerVolume?: number;
    /** 长篇目标字数的上限（20000–1000000）。 */
    maxTargetChars?: number;
  };
}

/**
 * 这份Persona声明的可调项。WebUI 只按 JSON Schema 渲染,不解释
 * "memo 三级缓存""梦"等人格概念。
 *
 * 模型不归Persona:用哪个模型、怎么想整组归 Provider,它拿不到也不问。
 */
export const PERSONA_CONFIG_GROUP: ConfigGroup = {
  // id 是配置组的实例身份;同一进程中的多个 bot 必须可区分。
  id: 'amber',
  // owner 是**角色**,词表由框架定(core / persona / module:*)。它回答的是
  // "这组参数归四分法里的哪一块",不包含具体实现名称。
  owner: 'persona',
  schema: {
    type: 'object',
    title: '认知节奏',
    description: '一个 session 阶段有多长、一次唤醒能行动几轮、备忘分层容量、作息与梦的成本边界。',
    properties: {
      'context.maxTokens': {
        type: 'integer',
        title: '上下文阶段预算',
        minimum: 8000,
        maximum: 2_000_000,
        multipleOf: 1000,
        'x-suffix': 'tok',
        'x-hot': true,
        description:
          '上下文超过阶段预算 × 软阈值比例时先提示；下一批结束时仍超出则交接，并启动后台整理。'
          + '模型窗口与单次输出上限在「语言模型」页配置；达到模型硬限制时由 Core 强制交接。',
      },
      'context.keepRatio': {
        type: 'number',
        title: '交接保留比例',
        minimum: 0.05,
        maximum: 0.9,
        multipleOf: 0.01,
        'x-suffix': '×',
        'x-hot': true,
        description: '交接笔记的 token 预算 = 阶段预算 × 此比例。笔记保留最近内容。',
      },
      'context.softRatio': {
        type: 'number',
        title: '软阈值比例',
        minimum: 0.1,
        maximum: 1,
        multipleOf: 0.01,
        'x-suffix': '×',
        'x-hot': true,
        description: '上下文预警阈值 = 阶段预算 × 此比例。',
      },
      'context.firstTurn': {
        type: 'boolean',
        title: '合成首轮对话',
        'x-hot': true,
        description: '把部署 prompts/ 里的首轮对话(FIRST_TURN_USER / THINKING / REPLY)作为合成开头送进每次请求,不写入 session;内容为空时不送。',
      },
      'loop.softCap': {
        type: 'integer',
        title: '工具循环软上限',
        minimum: 1,
        maximum: 100,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '单次唤醒行动到这一轮,追加一条疲劳提示。',
      },
      'loop.hardCap': {
        type: 'integer',
        title: '工具循环硬上限',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '到这一轮直接结束本次唤醒。应 ≥ 软上限。',
      },
      'memo.residentCap': {
        type: 'integer',
        title: 'memo 常驻条数',
        minimum: 1,
        maximum: 50,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: 'MEMORY 2 常驻区容量；前缀包含这一层的全文。',
      },
      'memo.activeCap': {
        type: 'integer',
        title: 'memo active 条数',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: 'memo/active/ 区容量(前缀只列文件名那层)。',
      },
      'tick.dayIntervalMinutes': {
        type: 'array',
        title: '白天 tick 间隔 [最小,最大]',
        items: { type: 'integer', minimum: 1, maximum: 1440 },
        minItems: 2,
        maxItems: 2,
        'x-suffix': 'min',
        'x-hot': true,
        description: '白天两次主动 tick 的间隔在此区间内取随机。',
      },
      'tick.nightIntervalMinutes': {
        type: 'integer',
        title: '深夜 tick 间隔',
        minimum: 0,
        maximum: 1440,
        multipleOf: 1,
        nullable: true,
        'x-suffix': 'min',
        'x-hot': true,
        description: '深夜 tick 间隔分钟;留空(null)＝深夜完全不 tick。',
      },
      'tick.nightStartHour': {
        type: 'integer',
        title: '深夜起始',
        minimum: 0,
        maximum: 23,
        multipleOf: 1,
        'x-suffix': '点',
        'x-hot': true,
        description: '深夜起始整点(含)。',
      },
      'tick.nightEndHour': {
        type: 'integer',
        title: '深夜结束',
        minimum: 0,
        maximum: 23,
        multipleOf: 1,
        'x-suffix': '点',
        'x-hot': true,
        description: '深夜结束整点。',
      },
      'dream.maxRounds': {
        type: 'integer',
        title: '梦 fork 轮数上限',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '一场梦的工具循环上限(成本边界)。',
      },
      'dream.cooldownMinutes': {
        type: 'integer',
        title: '两次梦之间最短间隔',
        minimum: 0,
        maximum: 720,
        multipleOf: 1,
        'x-suffix': '分钟',
        'x-hot': true,
        description:
          '交接由上下文填满决定，热闹时十几分钟一次；梦跟着交接走就会把同一段群聊整理好几遍。'
          + '间隔内的交接只写交接笔记，下一次梦一起看。填 0 恢复成每次交接都入梦。',
      },
      'dream.inheritTokens': {
        type: 'integer',
        title: '梦继承的原文预算',
        minimum: 2000,
        maximum: 128000,
        multipleOf: 1000,
        'x-suffix': 'token',
        'x-hot': true,
        description:
          '梦从交接前的会话里继承多少原文（只算消息，不含前缀与工具）。更早的部分由交接笔记覆盖，'
          + '梦需要细节时自己读。调大等于让梦看得更细、也更贵。',
      },
      'dream.contextTokens': {
        type: 'integer',
        title: '梦单次上下文上限',
        minimum: 4000,
        maximum: 128000,
        multipleOf: 1000,
        'x-suffix': 'token',
        'x-hot': true,
        description:
          '梦自己的工具回执会一路堆高上下文，这里给它一个安全网。只算消息；越过时再跑两轮收尾。'
          + '一次正常的整理要 23 轮、长到 8 万多，所以设低了会把它截短——它是防失控的，不是省钱的。',
      },
      'memory.decayRate': {
        type: 'number',
        title: '记忆每日衰减率',
        minimum: 0,
        maximum: 0.2,
        'x-hot': false,
        description: '重要性的每日衰减率。0.02 约等于一个月淡到六成；被召回会放慢衰减，但只在 30 天窗口内有效。',
      },
      'memory.dormantDays': {
        type: 'integer',
        title: '多久没想起就休眠',
        minimum: 7,
        maximum: 730,
        'x-suffix': '天',
        'x-hot': false,
        description: '超过这个天数没被召回、且重要性已明显衰减，条目转入休眠：不再自动注入，但仍可被主动召回，不删除。',
      },
      'memory.injectTopK': {
        type: 'integer',
        title: '唤醒时自动注入条数',
        minimum: 0,
        maximum: 8,
        'x-suffix': '条',
        'x-hot': true,
        description: '每次唤醒前按当批消息检索长期记忆并注入几个相关条目；0 关闭。只注入关键词真正命中的，不做兜底。',
      },
      'memory.embeddingModel': {
        type: 'string',
        title: '向量模型（可空）',
        'x-hot': false,
        description: '留空 = 只用关键词检索。填 OpenAI 兼容的 embedding 模型名即可开启语义召回，key 从环境变量 CORTICO_EMBEDDING_KEY 读；调用失败自动退回关键词。',
      },
      'memory.embeddingBaseUrl': {
        type: 'string',
        title: '向量服务地址',
        'x-hot': false,
        description: 'OpenAI 兼容的 embeddings 端点根地址，例如 https://integrate.api.nvidia.com/v1。',
      },
      'companion.enabled': {
        type: 'boolean',
        title: '允许她主动开口',
        'x-hot': true,
        description:
          '打开后，群里安静下来（四十五分钟没人说话、也没人在一来一回地聊）时，她可以自己起一句——问一件她真想知道的事。'
          + '她自己上一句还没人接的时候不提，群里正聊着的时候也不提。她仍然可以什么都不做；说话仍然只走 qq_draft。关掉则完全不变。',
      },
      'companion.allowPrivate': {
        type: 'boolean',
        title: '私聊里可以主动',
        description: '私聊是陪伴的主场：允许她在私聊里主动开口。',
      },
      'companion.allowGroups': {
        type: 'boolean',
        title: '群里可以主动',
        description: '开启后她可能在群里对着某一个人接话。群里主动只针对具体的人，不做广播；建议保持关闭，除非群氛围适合。',
      },
      'companion.participateGroups': {
        type: 'boolean',
        title: '接群里正在聊的话题',
        description:
          '开启后，群里几个人真的在聊、而她记得相关的事时，她可以接一句自己的看法。'
          + '四条判据都要成立：正在聊（几条、几个人）、她懂（检索得到）、轮不到她（刚被叫到/刚说过）、今天没接过。'
          + '只是附和或重复不会开口——由头里写清楚了。',
      },
      'companion.topicWindowMinutes': {
        type: 'integer',
        title: '多久之内算「正在聊」',
        minimum: 5,
        maximum: 180,
        'x-suffix': '分钟',
        description: '只有这段时间内的发言才用来判断热度；窗口太短会错过慢热的话题，太长会把旧话题当新的。',
      },
      'companion.topicDailyCap': {
        type: 'integer',
        title: '每天最多接几次话题',
        minimum: 0,
        maximum: 6,
        'x-suffix': '次',
        description: '和「接自己的话头」分开计。0 等于不插话，只回应被叫到和被接上的话头。',
      },
      'companion.dreamEveryHours': {
        type: 'integer',
        title: '多久不整理就入一次梦',
        minimum: 0,
        maximum: 72,
        'x-suffix': '小时',
        description:
          '低水位兜底：平时梦只在上下文快满时触发，安静的日子可能整天不更新状态和日记。'
          + '超过这么多小时、且期间有人说过话或今天还没日记，就主动入一次梦。0 = 只在上下文满时入梦。'
          + '一次梦约 50 次模型调用，按这个估成本。',
      },
      'companion.dailyCap': {
        type: 'integer',
        title: '每天最多主动几次',
        minimum: 0,
        maximum: 12,
        'x-suffix': '次',
        description: '全局上限，不是要完成的目标。0 等于关闭主动。',
      },
      'companion.followupMinutes': {
        type: 'integer',
        title: '多久之后可以接一句',
        minimum: 5,
        maximum: 1440,
        'x-suffix': '分钟',
        description: '她问过一句、对方没答，或者她主动说过一句没有回音，隔多久之后才算"可以自然接住"。太短会变成催。',
      },
      'companion.followupCooldownMinutes': {
        type: 'integer',
        title: '同一会话的间隔',
        minimum: 30,
        maximum: 2880,
        'x-suffix': '分钟',
        description: '同一个会话两次尝试之间至少隔多久。她选择不说的那些也算一次尝试。',
      },
      'companion.quietStartHour': {
        type: 'integer',
        title: '不打扰·开始（时）',
        minimum: 0,
        maximum: 23,
        'x-suffix': '点',
        description: '对方侧的安静时段：这段时间里她不会主动开口。可以跨午夜（如 23 到 8）。',
      },
      'companion.quietEndHour': {
        type: 'integer',
        title: '不打扰·结束（时）',
        minimum: 0,
        maximum: 23,
        'x-suffix': '点',
        description: '安静时段结束的小时（不含）。',
      },
      'companion.sleepStartHour': {
        type: 'integer',
        title: '她自己睡觉·开始（时）',
        minimum: 0,
        maximum: 23,
        'x-suffix': '点',
        description: '她自己的作息：睡着时不主动开口，精力在这段时间里恢复。',
      },
      'companion.sleepEndHour': {
        type: 'integer',
        title: '她自己睡觉·结束（时）',
        minimum: 0,
        maximum: 23,
        'x-suffix': '点',
        description: '她醒来的小时（不含）。',
      },
      'companion.life.city': {
        type: 'string',
        title: '天气城市',
        'x-hot': true,
        description: '填城市名（如「上海」或「Shanghai」）。交给 Open-Meteo 免 key 地理编码；留空即不查天气，面板显示「暂无天气信息」。',
      },
      'companion.life.weatherEnabled': {
        type: 'boolean',
        title: '查天气',
        'x-hot': true,
        description: '开启后按下面的间隔拉当前天气与当日高低温，写进「今日」卡，也进她每轮的状态注入。请求失败保留上一次读数。',
      },
      'companion.life.weatherRefreshMinutes': {
        type: 'integer',
        title: '天气刷新间隔（分钟）',
        minimum: 15,
        maximum: 720,
        'x-suffix': '分钟',
        description: '越短越实时，也越费网络。90 分钟够用。',
      },
      'companion.life.homeName': {
        type: 'string',
        title: '「家」怎么写',
        description: '日程里没写地点、活动也看不出来时，面板与注入会把她放在这里。默认「家里」。',
      },
      'companion.life.planItemCount': {
        type: 'integer',
        title: '一天排几段日程',
        minimum: 4,
        maximum: 16,
        'x-suffix': '段',
        description: '梦没写今天之前，按作息切出的临时排程段数；梦写过之后以梦的为准。',
      },
      'companion.life.cycleEnabled': {
        type: 'boolean',
        title: '模拟生理周期',
        'x-hot': true,
        description: '开启后按 28 天六阶段推算，并给「身体」一格与精力一个偏移。默认关闭——没有校准日期时它只会瞎猜。',
      },
      'companion.life.cycleAnchor': {
        type: 'string',
        title: '周期起始日',
        description: '最近一次月经开始那天，格式 YYYY-MM-DD。只有这一项填了，开启周期才有意义。',
      },
      'companion.intero.enabled': {
        type: 'boolean',
        title: '内感受（事件驱动）',
        'x-hot': true,
        description: '从消息流推算社交电量与负荷：有人来找会掉电、复读掉得更多，安静下来慢慢回满；反过来她主动开口会看这两项。关掉就只看精力与时段。',
      },
      'companion.intero.lowBattery': {
        type: 'number',
        title: '电量低到多少就不主动',
        minimum: 0.05,
        maximum: 0.9,
        'x-hot': false,
        description: '0–1。默认 0.3：低于三成电时，她不主动开口找话。',
      },
      'companion.intero.highLoad': {
        type: 'number',
        title: '负荷高到多少就不主动',
        minimum: 0.3,
        maximum: 0.99,
        'x-hot': false,
        description: '0–1。默认 0.85：短时间堆进来的消息太多、还没回落时，先不开口。',
      },
      'companion.intero.replyBattery': {
        type: 'number',
        title: '电量低到多少就短回',
        minimum: 0.1,
        maximum: 0.9,
        'x-hot': true,
        description: '0–1。默认 0.35：低于这条线时，她回短句、不追问、也慢半拍再处理新消息。',
      },
      'companion.intero.hesitationSeconds': {
        type: 'integer',
        title: '最慢半拍多少秒',
        minimum: 0,
        maximum: 30,
        'x-suffix': '秒',
        'x-hot': true,
        description: '电量跌到 0 时最多延迟多久；按电量比例缩放，电量高时不延迟。0 = 不延迟。',
      },
      'companion.speak.enabled': {
        type: 'boolean',
        title: '允许她自己定时间开口',
        'x-hot': true,
        description: '开启后她可以用 speak_later 约一个时刻说话、用 leave_thread 留一句给下次被叫醒的自己。关掉就只剩被动回话。',
      },
      'companion.speak.dailyCap': {
        type: 'integer',
        title: '每天无理由开口几次',
        minimum: 0,
        maximum: 12,
        'x-suffix': '次',
        description: '用不完的额度会带一点到第二天，总量封顶 1.5 倍。0 = 不许自己约时间开口。',
      },
      'gesture.enabled': {
        type: 'boolean',
        title: '允许动作描写',
        'x-hot': true,
        description: '开着时每轮注入一句许可：一条最多一处括号、十二字以内，只在睡前/刚醒/被打断/害羞这类身体在场的时刻用；睡着时还有单独的"回或不回"规则。关掉后下一轮就回到纯文字，同时注入一句"不写括号"，不必改文件。',
      },
      'creative.enabled': {
        type: 'boolean',
        title: '让她自己写东西',
        'x-hot': true,
        description: '没人在跟她说话的时候，她自己开一部作品、隔一阵续写一段。正文写在工作的 `创作/` 里，她能读到、能接着写；关掉后书柜保留，不再推进。',
      },
      'creative.chunkChars': {
        type: 'integer',
        title: '每次写多少字',
        minimum: 60,
        maximum: 800,
        multipleOf: 10,
        'x-suffix': '字',
        'x-hot': true,
        description: '一次续写的目标长度；精力低时按比例缩减。',
      },
      'creative.maxActiveWorks': {
        type: 'integer',
        title: '同时写几部',
        minimum: 1,
        maximum: 4,
        'x-suffix': '部',
        description: '同时进行中的作品数上限。',
      },
      'creative.advanceMinutes': {
        type: 'array',
        title: '两次续写间隔 [最小,最大]',
        items: { type: 'integer', minimum: 5, maximum: 1440 },
        minItems: 2,
        maxItems: 2,
        'x-suffix': 'min',
        'x-hot': true,
        description: '写下一段之前至少隔这么久；同一部作品每次落在同一个点上，不掷骰子。',
      },
      'creative.maxChunksPerDay': {
        type: 'integer',
        title: '每天最多写几段',
        minimum: 0,
        maximum: 24,
        'x-suffix': '段',
        'x-hot': true,
        description: '每天模型调用的硬上限：一段大约四次调用。0 = 不写。',
      },
      'creative.shareEnabled': {
        type: 'boolean',
        title: '允许她提起自己写的东西',
        'x-hot': true,
        description: '写完一个节点后，主动层多一个话头：把刚写的一段递给她，说不说由她。关掉后只写不说。',
      },
      'creative.shareDailyCap': {
        type: 'integer',
        title: '每天最多提几次',
        minimum: 0,
        maximum: 6,
        'x-suffix': '次',
        description: '同一天最多给几次分享机会；同一部作品的同一节点只给一次。',
      },
      'creative.direction': {
        type: 'string',
        title: '创作方向',
        description: '她自己想写什么；留空则跟着当天在过的日子（日程、梦境、天气）走。',
      },
    },
  },
};

export const PERSONA_DEFAULTS: PersonaConfig = {
  context: { maxTokens: 128000, keepRatio: 0.3333, softRatio: 0.85, firstTurn: false },
  loop: { softCap: 8, hardCap: 16 },
  // MEMORY 2 的三层容量(7±2 的 7)
  memo: { residentCap: 7, activeCap: 21 },
  // 作息:白天随机间隔 tick,深夜放缓
  tick: { dayIntervalMinutes: [30, 60], nightIntervalMinutes: 120, nightStartHour: 0, nightEndHour: 8 },
  dream: { maxRounds: 40, cooldownMinutes: 60, inheritTokens: 30000, contextTokens: 90000 },
  // 衰减很慢：一个陪伴型人格不该忘掉三个月前的人，只让"从没被想起"的东西淡下去。
  memory: { decayRate: 0.02, dormantDays: 90, injectTopK: 5, embeddingModel: '', embeddingBaseUrl: 'https://integrate.api.nvidia.com/v1' },
  // 陪伴层默认关闭：主动开口是最容易变成骚扰的一层，要由部署明确打开。
  companion: {
    enabled: false,
    allowPrivate: true,
    allowGroups: false,
    participateGroups: true,
    topicWindowMinutes: 30,
    topicDailyCap: 1,
    dreamEveryHours: 6,
    dailyCap: 2,
    followupMinutes: 45,
    followupCooldownMinutes: 240,
    quietStartHour: 23,
    quietEndHour: 8,
    sleepStartHour: 2,
    sleepEndHour: 9,
    life: {
      city: '',
      weatherEnabled: false,
      weatherRefreshMinutes: 90,
      homeName: '家里',
      planItemCount: 10,
      cycleEnabled: false,
      cycleAnchor: '',
    },
    intero: {
      enabled: true,
      lowBattery: 0.3,
      highLoad: 0.85,
      replyBattery: 0.25,
      hesitationSeconds: 6,
    },
    speak: {
      enabled: true,
      dailyCap: 2,
    },
  },
  gesture: { enabled: true },
  // 创作默认关着：它是持续的模型调用，要不要付这笔钱由部署决定。
  creative: {
    enabled: false,
    chunkChars: 220,
    maxActiveWorks: 1,
    advanceMinutes: [95, 320],
    maxChunksPerDay: 6,
    shareEnabled: true,
    shareDailyCap: 1,
    direction: '',
    // 长篇这一档开不开放：开了她可以在短/中/长里自己挑，不开就只能写短。
    longForm: false,
    chapterChars: 3000,
    chaptersPerVolume: 8,
    maxTargetChars: 300000,
  },
};
