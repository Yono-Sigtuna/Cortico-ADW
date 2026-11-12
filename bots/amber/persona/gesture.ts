/**
 * 动作描写（括号里的身体）。
 *
 * 这是纯文字的扮演，身体只能靠一行括号传出来。要不要写，由每轮注入决定——
 * 开关一关，下一轮就回到纯文字。
 *
 * 判据不是"允不允许"，而是**这条需不需要身体**：
 * - 对方用了动作（（捏住鼻子）、钻进被窝）→ 必须用动作接，否则接不上戏；
 * - 自己要给前提、耍赖、强烈情绪、碰实物 → 写一处；
 * - 普通闲聊 → 不加。
 */

export interface GestureInput {
  /** 部署级开关；关掉就只注入"不写"。 */
  enabled: boolean;
  /** 她在睡：即便开着，也收窄成"不回 / 一句迷糊话"两种形态。 */
  sleeping: boolean;
  /** 她手头正在做的事；用来给出一个和话题有关的例子。 */
  activity?: string | null;
  /** 对方这条消息里检测到的身体动作（原文片段）；有就要求接戏。 */
  sceneAction?: string | null;
  /** 群里此刻的形状：人多热闹时收短，只有两个人时放宽。 */
  room?: { heat: string; speakers: number } | null;
}

/** 从手头的事推一个动作样例：这样写出来是状态，不是装饰。 */
export function activityGesture(activity?: string | null): string | null {
  const a = (activity ?? '').trim();
  if (!a) return null;
  if (/读|书/.test(a)) return '（把书合上）';
  if (/茶|喝/.test(a)) return '（把杯子放下）';
  if (/写|记|整理|核|补/.test(a)) return '（停下笔）';
  if (/吃|饭|餐/.test(a)) return '（放下筷子）';
  if (/睡|躺|醒/.test(a)) return '（翻个身）';
  if (/走|路|出门|散步/.test(a)) return '（停下脚步）';
  return '（停下手里的活）';
}

/** 身体动作的动词表：只收具体、少歧义的那些（"拉黑""插座"这类不算）。 */
const SCENE_VERBS = /(捏|掐|抱住|抱着|搂|抱紧|钻进|缩进|拱进|趴|躺|靠过去|拍开|拍了拍|抓|拽|捂|掀|戳|挠|踹|踩|亲|吻|递|塞过去|推回去|收起来|放下|合上)/;
/** 所有括号片段；逐个看，取第一个像动作的。 */
const BRACKETED = /[（(]([^）)]{1,30})[）)]/g;
const HAN = /\p{Script=Han}/gu;

/**
 * 这条消息里有没有"身体在做的事"。有就返回原文片段（≤20 字），没有返回 null。
 * 括号动作是最强的信号；动词表只兜没有括号的写法。
 *
 * 括号不都是动作：QQ 号和称谓也长这样——`小克(3124076548)`、`橘子精(你)`、
 * `@Claude🍊昂贵橘子精(你)`。把那些当身体，会让她对着一个号码回一句「（叹气）」。
 * 所以括号里至少要两个汉字，或者含一个明确的身体动词。
 */
export function detectSceneAction(text: string): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  for (const match of raw.matchAll(BRACKETED)) {
    const body = match[1] ?? '';
    const han = body.match(HAN)?.length ?? 0;
    if (han < 2 && !SCENE_VERBS.test(body)) continue;
    return match[0].slice(0, 20);
  }
  const verb = SCENE_VERBS.exec(raw);
  if (!verb) return null;
  const at = verb.index;
  return raw.slice(Math.max(0, at - 6), at + 14).replace(/\s+/g, ' ').slice(0, 20);
}

export function gestureLine(input: GestureInput): string | null {
  if (input.sleeping) {
    return input.enabled
      ? '[你在睡] 被叫到只做三件事之一：不回（首选）；回一个八字以内的迷糊短句或拟声，最多带一处动作（如「（翻身）……不要动我」）；同一个人叫第二遍，才迷糊地醒一句。不要解释你在睡。'
      : '[你在睡] 被叫到只做三件事之一：不回（首选）；回一个八字以内的纯文字短句或拟声；同一个人叫第二遍，才迷糊地醒一句。不写括号。';
  }
  if (!input.enabled) return null;
  const hand = (input.activity ?? '').trim();
  const example = activityGesture(hand);

  // 对方先动了身体：这是接戏，不是表演。不回应的话话就断了。
  if (input.sceneAction) {
    return `[动作] 对方这条里有身体动作（「${input.sceneAction}」）。接戏就要用一处动作回应，`
      + '否则话接不上——比如「（拍开手）行，都别睡了」「（往旁边挪）挤什么挤」。'
      + (example && hand ? `你手头是「${hand}」，也可以顺着它来一句「${example}」。` : '')
      + '一条最多一处、十二字以内；不写与话题无关的自我描写，也不写状态标签。'
      + crowdedSuffix(input.room);
  }

  // 群里正忙着：这一条挤在一堆消息里，身体写多了只是占地方。
  if (crowded(input.room)) {
    return '[动作] 群里这会儿一条接一条：最多一处、八个字以内；能不加就不加。'
      + '真要用，就用最短的那个——（点头）（把袖子挽上）（往旁边让了让）。';
  }

  const base = '[动作] 这些时刻写一处动作，别的时刻不加：给对方一个前提（（放下书）没嫌你，今天在读书）；'
    + '耍赖（（死死抱住被子）我就不）；强烈情绪（（叹气）（没眼看）（懒得理你））；碰到实物（把碗推回去、把茶杯收起来）。'
    + (example && hand ? `现在手头是「${hand}」，被打断就是「${example}」这样的一句。` : '')
    + '普通闲聊不加。被点名「摆个姿势演一个」可以拒绝——那和接戏是两件事。'
    + '一条最多一处、十二字以内。';
  // 就你们俩、也没人在抢话：普通闲聊带一处身体，是在场感，不是表演。
  return intimate(input.room)
    ? `${base}这里只有你们俩在说话，不用抢话：普通闲聊也可以带一处你手上正在做的事，`
      + '让对面知道你是在哪儿、在干什么——但一条仍然只有一处。'
    : base;
}

function crowded(room: GestureInput['room']): boolean {
  return room?.heat === 'busy' || room?.heat === 'flood';
}

function intimate(room: GestureInput['room']): boolean {
  if (!room) return false;
  return room.speakers <= 2 && (room.heat === 'quiet' || room.heat === 'normal' || room.heat === 'silent');
}

function crowdedSuffix(room: GestureInput['room']): string {
  return crowded(room) ? '群里这会儿一条接一条，动作能省就省。' : '';
}

/** 一条草稿里数出来的动作处数（括号里 1–30 字）。 */
export function countActions(text: string): number {
  return (text.match(/[（(][^）)]{1,30}[）)]/g) ?? []).length;
}
export function hasAction(text: string): boolean {
  return /[（(][^）)]{1,30}[）)]/.test(text);
}
