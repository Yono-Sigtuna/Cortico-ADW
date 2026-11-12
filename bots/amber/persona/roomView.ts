/**
 * 群里此刻的形状：World 数好、随事件 meta 送来的那几个数。
 *
 * 判定只读这里，不重算——两边各数一遍，迟早会在同一个问题上给出两个答案。
 * 这里也不解释：`heat` 是每分钟几条，`monologue` 是一个人占了多少，都不是"在吵架"。
 */
export type RoomHeat = 'silent' | 'quiet' | 'normal' | 'busy' | 'flood';

export interface RoomView {
  messages: number;
  speakers: number;
  heat: RoomHeat | string;
  monologue: boolean;
  replyShare: number;
  toSelf: number;
  lullMinutes: number | null;
}

/** 事件 meta 是 unknown；这里只认得出形状的那一份，认不出就当没有。 */
export function asRoomView(raw: unknown): RoomView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.messages !== 'number' || typeof r.speakers !== 'number') return null;
  return {
    messages: r.messages,
    speakers: r.speakers,
    heat: typeof r.heat === 'string' ? r.heat : 'normal',
    monologue: r.monologue === true,
    replyShare: typeof r.replyShare === 'number' ? r.replyShare : 0,
    toSelf: typeof r.toSelf === 'number' ? r.toSelf : 0,
    lullMinutes: typeof r.lullMinutes === 'number' ? r.lullMinutes : null,
  };
}

/** 各说各的、消息还在涌：这时候插话只是噪音。 */
export function roomCrowded(room: RoomView | null | undefined): boolean {
  if (!room) return false;
  return room.heat === 'busy' || room.heat === 'flood';
}

/** 一个人连着说，别人只偶尔应一句：没有对话可接。 */
export function roomMonologue(room: RoomView | null | undefined): boolean {
  return room?.monologue === true;
}

/** 只有你们俩在说话：动作描写可以松一点，因为不用抢话。 */
export function roomIntimate(room: RoomView | null | undefined): boolean {
  if (!room) return false;
  return room.speakers <= 2 && (room.heat === 'quiet' || room.heat === 'normal' || room.heat === 'silent');
}
