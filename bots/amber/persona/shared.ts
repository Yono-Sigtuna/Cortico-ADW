/**
 * 同一屋檐下的「在场表」。
 *
 * 三份部署是三个独立进程，彼此看不见对方的日程，却都在同一个群里说话。这里给它们一块
 * 落在部署根下的共享区：`presence/` 记各自此刻在不在，`claims/` 记哪条消息已被谁认领。
 * 认领用排他创建，先写下的那个说话，后来的人看到回执就收工，不再组织语言。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';

/** 一条人话的说话权按住这么久。期间别人想接同一拍，会看到已被认领。 */
const CLAIM_TTL_MS = 90_000;
/** 在场记录超过这么久没更新，按「不确定」显示，不当成还在。 */
const PRESENCE_STALE_MS = 12 * 60 * 60 * 1000;

export interface SharedHomeDeps {
  /** 本部署的 memory 目录；共享区是它的上一级的 `shared/`。 */
  memoryDir: string;
  /** 本部署目录名，如 amber。 */
  selfId: string;
  /** 本部署展示名，如 琥珀协议。 */
  selfLabel: string;
  /** 本部署的 QQ 号；用来把同住的三个账号自己说的话排除在「新一拍」之外。 */
  selfQq?: number | null;
  /** 叫醒本部署的名字（`worlds.qq.wakeNames`）。被点名的这一拍归被点名的人，不看谁先抢。 */
  selfNames?: readonly string[];
  /** 某个会话最近的消息，升序；用来定位「现在这一条」。 */
  recentMessages?: (conv: string, limit: number) => Array<{ at: number; from: string; text: string }>;
}

interface Presence {
  id: string;
  label: string;
  qq?: string;
  doing?: string;
  location?: string;
  sleeping?: boolean;
  away?: boolean;
  /** 叫醒她的名字；用来判断这一条点的是不是她。 */
  names?: string[];
  until?: string;
  updatedAt: number;
}

function homeDir(deps: SharedHomeDeps): string {
  return join(dirname(deps.memoryDir), '..', 'shared');
}

function ensure(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 这条消息里是不是叫到了这些名字。太短的名字不认，免得「小g」这种误伤。 */
function mentions(text: string, names: readonly string[]): boolean {
  const lower = (text ?? '').toLowerCase();
  if (!lower) return false;
  return names.some((raw) => {
    const name = raw.trim().toLowerCase();
    return name.length >= 2 && lower.includes(name);
  });
}

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function presenceDir(deps: SharedHomeDeps): string {
  return join(homeDir(deps), 'presence');
}

function readPresence(deps: SharedHomeDeps): Presence[] {
  const dir = presenceDir(deps);
  if (!existsSync(dir)) return [];
  const rows: Presence[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const row = readJson<Presence>(join(dir, name));
    if (row && typeof row.id === 'string') rows.push(row);
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** 还在不在：声明了回来的钟点且已经过了，就按回来算。 */
function awayNow(row: Presence, now: number): boolean {
  if (!row.away) return false;
  if (row.until) {
    const at = Date.parse(row.until);
    if (Number.isFinite(at) && now >= at) return false;
  }
  return true;
}

function describe(row: Presence, now: number): string {
  const age = now - row.updatedAt;
  const bits: string[] = [];
  if (awayNow(row, now)) {
    const where = row.location ? `在${row.location}` : '不在';
    const when = row.until && Number.isFinite(Date.parse(row.until))
      ? `，约 ${new Date(Date.parse(row.until)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 回来`
      : '';
    bits.push(`**不在**（${where}${row.doing ? `：${row.doing}` : ''}${when}）`);
  } else if (row.sleeping) {
    bits.push('睡着');
  } else if (row.doing || row.location) {
    bits.push(`${row.location ?? ''}${row.doing ? `·${row.doing}` : ''}`.replace(/^·/, ''));
  } else {
    bits.push('在');
  }
  bits.push(age > PRESENCE_STALE_MS ? `${Math.round(age / 3600_000)} 小时没更新` : `${Math.max(1, Math.round(age / 60_000))} 分钟前`);
  return `${row.label}：${bits.join(' · ')}`;
}

function table(deps: SharedHomeDeps, now: number): string {
  const rows = readPresence(deps).filter((row) => row.id !== deps.selfId);
  if (!rows.length) return '同住的另两位今天还没报过自己的位置。';
  return rows.map((row) => `- ${describe(row, now)}`).join('\n');
}

function writePresence(deps: SharedHomeDeps, patch: Partial<Presence>): Presence {
  const dir = ensure(presenceDir(deps));
  const file = join(dir, `${safeKey(deps.selfId)}.json`);
  const previous = readJson<Presence>(file);
  const next: Presence = {
    id: deps.selfId,
    label: deps.selfLabel,
    qq: deps.selfQq ? String(deps.selfQq) : previous?.qq,
    ...previous,
    ...patch,
    updatedAt: Date.now(),
  };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, file);
  return next;
}

function sweepClaims(dir: string, now: number): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > CLAIM_TTL_MS * 4) unlinkSync(file);
    } catch {
      /* 扫不掉就算了，认领会因为排他失败而让给对方，不影响正确性 */
    }
  }
}

/** 同住的三个账号，自己说的话不算「新一拍」。 */
function personaQqIds(deps: SharedHomeDeps): Set<string> {
  const ids = new Set<string>();
  if (deps.selfQq) ids.add(String(deps.selfQq));
  for (const row of readPresence(deps)) if (row.qq) ids.add(String(row.qq));
  return ids;
}

const STATE_DECL = {
  name: 'home_state',
  description:
    '报一句你此刻在干什么、在不在家。同住的另外两个人在同一份表里写着她们的，调用后回执会带给你。'
    + '去洗澡、出门、睡下时把 away 置真，回来时再置假——她们靠这个判断这会儿该不该替你应声。',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      doing: { type: 'string', maxLength: 80, description: '此刻在做的事，如「洗澡」「煮面」「翻书」。' },
      location: { type: 'string', maxLength: 40, description: '此刻在哪个房间或哪里，如「浴室」「厨房」「客厅」。' },
      sleeping: { type: 'boolean', description: '是否已经睡着。' },
      away: { type: 'boolean', description: '是否暂时不在：洗澡、出门、忙别的事、睡着都算。' },
      until: {
        type: 'string',
        description: '预计什么时候回来，ISO 时间或 HH:MM。填了的话，过了这个点会自动按「回来了」算。',
      },
    },
    additionalProperties: false,
  },
} satisfies Omit<ToolDef, 'handler'>;

const CLAIM_DECL = {
  name: 'home_claim',
  description:
    '要在这个群开口之前先认领现在这一拍。认领成功才写回复；返回「已被认领」就说明同住的人已经应了，'
    + '直接收工，不要另起一版、也不要换个说法重说一遍。只有有人点名找她、而她没应，才替她应一声，把 covering 填上她的名字；没人问就别提别人在哪。',
  tags: ['flow'],
  parameters: {
    type: 'object',
    properties: {
      conversation: { type: 'string', description: '会话地址，如 group:730756767。' },
      covering: {
        type: 'string',
        description: '如果这条本来该另一个人应、而她现在不在，填她的名字；否则不填。',
      },
    },
    required: ['conversation'],
    additionalProperties: false,
  },
} satisfies Omit<ToolDef, 'handler'>;

export function homeStateTool(deps: SharedHomeDeps): ToolDef {
  return {
    ...STATE_DECL,
    handler: async (args) => {
      const patch: Partial<Presence> = {};
      if (typeof args.doing === 'string') patch.doing = args.doing;
      if (typeof args.location === 'string') patch.location = args.location;
      if (typeof args.sleeping === 'boolean') patch.sleeping = args.sleeping;
      if (typeof args.away === 'boolean') patch.away = args.away;
      if (typeof args.until === 'string') patch.until = args.until;
      const row = writePresence(deps, patch);
      const now = Date.now();
      return `[home] 已记下：${describe(row, now)}\n\n同住的人：\n${table(deps, now)}`;
    },
  };
}

export function homeClaimTool(deps: SharedHomeDeps): ToolDef {
  return {
    ...CLAIM_DECL,
    handler: async (args) => {
      const conv = String(args.conversation ?? '').trim();
      if (!conv) return '[claim failed] 需要 conversation，如 group:730756767';
      const now = Date.now();
      const recent = deps.recentMessages?.(conv, 40) ?? [];
      const bots = personaQqIds(deps);
      // 三小只自己说的话不算新的一拍：别人应完，这一拍就结束了。
      const beat = [...recent].reverse().find((m) => !bots.has(String(m.from)));
      if (!beat) return '[claim failed] 这个会话里还没有人开口，先用 qq_read_history 看一眼再决定';
      const dir = ensure(join(homeDir(deps), 'claims'));
      sweepClaims(dir, now);
      const file = join(dir, `${safeKey(`${conv}@${beat.at}`)}.json`);
      const covering = typeof args.covering === 'string' ? args.covering : undefined;
      // 点名优先于先到：这条消息里叫的是我，那这一拍就是我的，不管谁先认领。
      const namedMe = mentions(beat.text, deps.selfNames ?? []);
      // 这条叫的是别人：让开，别抢。否则"叫 claude"会被先到的白龙答掉。
      const namedOther = readPresence(deps)
        .filter((row) => row.id !== deps.selfId && row.names?.length)
        .find((row) => mentions(beat.text, row.names!));
      if (namedOther && !namedMe) {
        return `[claim taken] 这条点名的是 ${namedOther.label}，让她答。`
          + `别再发，也不要换个说法重说一遍。\n\n同住的人：\n${table(deps, now)}`;
      }
      const record = { by: deps.selfId, label: deps.selfLabel, at: now, covering, beat: beat.at };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
          const note = covering ? `你替 ${covering} 应这一声。` : '';
          return `[claim ok] 这一拍由你答。${note}\n\n同住的人：\n${table(deps, now)}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const owner = readJson<typeof record>(file);
          const holding = owner && owner.by !== deps.selfId && now - owner.at < CLAIM_TTL_MS;
          if (holding) {
            if (namedMe) {
              // 这条点名的是我：把位置拿回来。同住的人先抢了也不算数。
              try {
                unlinkSync(file);
              } catch {
                /* 别人先删了也一样 */
              }
              continue;
            }
            const who = owner.label ?? '另一个人';
            const from = Math.max(1, Math.round((now - owner.at) / 1000));
            return `[claim taken] 这一拍已经由 ${who} 接了（${from} 秒前）。别再发，也不要换个说法重说一遍。\n\n同住的人：\n${table(deps, now)}`;
          }
          // 自己上一拍的认领，或者已经过期：让开位置重来一次。
          try {
            unlinkSync(file);
          } catch {
            /* 别人先删了也一样 */
          }
        }
      }
      return `[claim taken] 这一拍没抢到，先别发。\n\n同住的人：\n${table(deps, now)}`;
    },
  };
}

/**
 * 只补自己的 QQ 号，不动别的字段。
 *
 * 认领时要把「三小只自己说的话」排除在「新一拍」之外，靠的就是这张表里各自的 QQ 号；
 * 没报过在场的那位，她的发言会被当成别人的新话题。所以每次装配工具时顺手补一次，
 * 已经有号就不动，也不刷新 updatedAt——那会让一条过期的「不在」看起来像刚说过。
 */
export function publishIdentity(deps: SharedHomeDeps): void {
  const dir = ensure(presenceDir(deps));
  const file = join(dir, `${safeKey(deps.selfId)}.json`);
  const previous = readJson<Presence>(file);
  const qq = deps.selfQq ? String(deps.selfQq) : previous?.qq;
  if (!qq) return;
  const names = deps.selfNames?.length ? [...deps.selfNames] : previous?.names;
  const unchanged = previous?.qq === qq
    && JSON.stringify(previous?.names ?? null) === JSON.stringify(names ?? null);
  if (unchanged) return;
  const next: Presence = {
    id: deps.selfId,
    label: deps.selfLabel,
    ...previous,
    qq,
    ...(names ? { names } : {}),
    updatedAt: previous?.updatedAt ?? Date.now(),
  };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function sharedHomeTools(deps: SharedHomeDeps): ToolDef[] {
  publishIdentity(deps);
  return [homeStateTool(deps), homeClaimTool(deps)];
}
