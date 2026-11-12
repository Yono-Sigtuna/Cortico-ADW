/**
 * 召回查询只该由「她读到的那几句话」构成。
 *
 * 渲染后的正文带着消息号、群名、发送者昵称和图片链接。把这些一起喂给检索，
 * 长昵称会按稀有词权重把讲改名的旧事顶到最前面——一条纯图片消息也能拉回
 * 三条不相干的记忆。占位符（图片、语音、表情、转发）同样不是话题。
 *
 * 这里只做降噪，不做理解：拿不准的一律保留。
 */

const MEDIA_TOKEN =
  /\[(?:图片[^\]]*|语音[^\]]*|表情[:：][^\]]*|QQ表情|回复#[^\]]*|回复某条[^\]]*|转发的聊天记录[^\]]*|嵌套转发[^\]]*|json)\]/g;
const URL = /https?:\/\/[^\s\]]+/g;
/** 称呼不是话题：认人另有 `personBlock` 那条路，这里只找"在说什么"。 */
const MENTION = /@[^\s，。！？、,.!?]{1,24}/g;

export function cleanRecallQuery(text: string): string {
  return text
    // 先摘占位再删链接：链接里可能带 `]`，先删会把占位的右括号一起吃掉。
    .replace(MEDIA_TOKEN, ' ')
    .replace(URL, ' ')
    .replace(MENTION, ' ')
    .replace(/\s+/g, ' ')
    // 去掉称呼后常留下一个开头的逗号：那不是内容。
    .replace(/^[，。！？、,.!?：:\s]+/, '')
    .trim();
}

/** 一批消息里够格当查询的那部分：先取正文，再降噪。 */
export function recallQueryOf(
  events: ReadonlyArray<{ origin?: string; text?: string; meta?: Record<string, unknown> | undefined }>,
): string {
  return cleanRecallQuery(
    events
      .filter((event) => event.origin === 'external')
      .map((event) => (typeof event.meta?.body === 'string' ? event.meta.body : event.text ?? ''))
      .join('\n'),
  ).slice(0, 600);
}
