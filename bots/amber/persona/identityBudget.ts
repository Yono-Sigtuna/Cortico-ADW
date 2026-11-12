/**
 * 身份文件的写入冷却。
 *
 * 宪法与世界观的改动不该跟着对话的节奏走：交接在热闹时会十几分钟一次，
 * 每次梦都能改的话，一天能重写八遍，她就长成"最近一小时发生在身上的事"。
 * 这里只回答一个问题：距离上一次修改，够久了吗。
 */

/** 同一份身份文件两次修改之间至少隔多少小时。 */
export const IDENTITY_COOLDOWN_HOURS = 6;

/** 受冷却保护的文件（小写、工作区相对路径）。 */
export const IDENTITY_FILES = new Set(['constitution.md', 'worldview.md']);

/**
 * 返回拒绝理由；可以写就返回 null。
 *
 * `last` 是上一次修改的时刻（毫秒，0 表示从没改过）。
 */
export function identityWriteVerdict(
  rel: string,
  last: number,
  now: number,
  cooldownHours: number = IDENTITY_COOLDOWN_HOURS,
): string | null {
  if (!last || !Number.isFinite(last)) return null;
  const wait = cooldownHours * 3_600_000;
  if (now - last >= wait) return null;
  const elapsed = Math.max(1, Math.round((now - last) / 3_600_000));
  const left = Math.max(1, Math.ceil((wait - (now - last)) / 3_600_000));
  return `[冷却中] ${rel} 上一次修改在 ${elapsed} 小时前；身份文件两次修改之间至少隔 ${cooldownHours} 小时，还要等约 ${left} 小时。这段时间形成的判断先写进 note/ 或 people/，到时候再决定要不要改它。`;
}
