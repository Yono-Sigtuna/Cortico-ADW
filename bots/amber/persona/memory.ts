/**
 * MEMORY 0–4 模板变量：工作区目录、WORLDVIEW 与人物索引、memo 内容与清单、近期梦摘要、时间。
 * 引导语和空态由 MEMORY.md 模板提供。
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryAssemblyContext, PromptVarDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { MemoTiers } from './memoTiers.ts';
import { buildRoster } from './roster.ts';
import type { PersonRegistry } from './people.ts';

/** WebUI 展示的模板变量说明。 */
export const MEMORY_VAR_DECLS: readonly PromptVarDecl[] = [
  { name: 'memory.tree', description: 'persona/ 最外层目录清单(只一层,目录带 /)。', multiline: true },
  { name: 'memory.playbooks', description: 'note/playbook/ 下的手册名,每行一条。', multiline: true },
  { name: 'memory.images', description: '表情包库里最近改动的 5 个文件名。', multiline: true },
  { name: 'memory.worldview', description: 'WORLDVIEW.md 全文(她的梦写的那份)。', multiline: true },
  { name: 'memory.self', description: 'memo/self.md 的开头 200 字:她此刻在意什么、还没想明白什么。', multiline: true },
  { name: 'memory.opinions', description: 'note/opinions/ 下的文件名:对人对事的当前看法,每份一个。', multiline: true },
  { name: 'memory.roster', description: '人物花名册:每行「档案名 — 首行」，有曾用名时附在后面。', multiline: true },
  { name: 'memory.memoResident', description: '常驻 memo 的全文,含 ── memo/x ── 分隔行(self.md 单独走 memory.self)。', multiline: true },
  { name: 'memory.memoActive', description: 'active/ 里的文件名(只列名不列正文)。' },
  { name: 'memory.memoArchivedCount', description: 'memo/archived/ 里的归档条数。' },
  { name: 'memory.emergences', description: '近期梦的浮现,每行一条。', multiline: true },
  { name: 'memory.now', description: '前缀组装那一刻的时间。**在两次前缀重建之间是冻结的**。' },
  { name: 'memory.timezone', description: '时区名。' },
];

/** 自我叙事文件与进前缀的字数上限：全文留给她自己 read_file，前缀只放开头这一段。 */
const SELF_FILE = 'self.md';
const SELF_CAP = 200;
/**
 * 常驻 memo 单条在前缀里的上限；全文仍在工作区，用 read_file 读。
 * 窗口别调小：梦写的顶层 memo 三千字上下，窗口只剩开头时，`## 开口原则` 那类
 * 「该怎么说话」的整段会落在窗外——她每轮只看见判断，看不见怎么说话。
 */
export const RESIDENT_CAP = 1200;
/** 浮现每轮只放最近几条、每条多少字——它是提示，不是正文。 */
const EMERGENCE_LINES = 2;
const EMERGENCE_CAP = 60;

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/**
 * 按行边界截断：取 max 字以内最后一整行。memo 是给人照着做的清单，
 * 截在半句上会读成一条被剪掉尾巴的指令。
 */
function clipLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = head.lastIndexOf('\n');
  // 太短的行边界不如直接硬截：至少让第一行完整。
  return `${(cut > max / 2 ? head.slice(0, cut) : head).trimEnd()}…`;
}

/**
 * 前缀里的「我自己」：取开头 SELF_CAP 字，尽量落在行边界上。
 * 这份文件是当前状态而不是日志——最新的一行要在最前面，梦负责让它保持短。
 */
function selfSummary(ws: GitWorkspaceMemory, max = SELF_CAP): string {
  let body = '';
  try {
    body = (ws.readFile(`memo/${SELF_FILE}`) ?? '').trim();
  } catch {
    return '';
  }
  return clipLines(body, max);
}

/** external/qq/images/ 里最近的文件名,按mtime倒序取前n个(表情包库最近摘要用) */
function recentImageNames(memoryDir: string, n = 5): string[] {
  const dir = join(memoryDir, 'external', 'qq', 'images');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.includes('.tmp-'))
    .map((e) => ({ name: e.name, mtime: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n)
    .map((e) => e.name);
}

export function memoryVars(
  ws: GitWorkspaceMemory,
  memo: MemoTiers,
  ctx: MemoryAssemblyContext,
  /** Persona所有的近期梦浮现(MEMORY 3)。 */
  emergences: string[],
  /** 人名的唯一解析入口；不给时名册现场建一份，只影响名册本身。 */
  registry?: PersonRegistry | null,
): Record<string, string> {
  // 空值返回空串，由模板提供空态。
  let playbook: string[] = [];
  try {
    playbook = ws.listDir('note/playbook');
  } catch {
    playbook = [];
  }

  let worldview = '';
  try {
    worldview = (ws.readFile('WORLDVIEW.md') ?? '').trim();
  } catch {
    worldview = '';
  }

  let opinions: string[] = [];
  try {
    opinions = ws.listDir('note/opinions');
  } catch {
    opinions = [];
  }

  const residents = memo.residentFiles()
    // self.md 单独一段(限长)；混在常驻全文里会把整份自我叙事顶进每一轮。
    .filter((name) => name !== SELF_FILE)
    .map((name) => {
      let body = '';
      try {
        body = ws.readFile(`memo/${name}`);
      } catch {
        body = '(读取失败)';
      }
      const trimmed = body.trimEnd();
      const text = clipLines(trimmed, RESIDENT_CAP);
      const shown = text === trimmed ? text : `${text}（前 ${RESIDENT_CAP} 字；全文用 read_file 读 memo/${name}）`;
      return `── memo/${name} ──\n${shown}`;
    });

  const actives = memo.activeFiles();

  return {
    'memory.tree': ws.treeShallow(),
    'memory.playbooks': playbook.map((n) => `- ${n}`).join('\n'),
    'memory.images': recentImageNames(ws.memoryDir, 5).map((n) => `- ${n}`).join('\n'),
    'memory.worldview': worldview,
    'memory.self': selfSummary(ws),
    'memory.opinions': opinions.map((n) => `- ${n}`).join('\n'),
    'memory.roster': buildRoster(ws.memoryDir, registry),
    'memory.memoResident': residents.join('\n'),
    'memory.memoActive': actives.map((n) => `「${n}」`).join('、'),
    'memory.memoArchivedCount': String(memo.archivedCount()),
    'memory.emergences': emergences
      .slice(-EMERGENCE_LINES)
      .map((e) => `- ${clipText(e, EMERGENCE_CAP)}`)
      .join('\n'),
    'memory.now': nowIso(ctx.timezone, ctx.now),
    'memory.timezone': ctx.timezone,
  };
}
