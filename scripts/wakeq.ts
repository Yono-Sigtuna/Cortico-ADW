/**
 * wakeq:按可读格式列出部署的 `data/wakes.jsonl`（一次唤醒一条）。
 * 只读，不改记录。写入侧见 bots/amber/persona/index.ts 的 onDelivery/onTurnEnded。
 *
 * 用法:
 *   pnpm wakeq [--bot <name>] [--data <dir>] [--last N] [--reason <子串>] [--json]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentRoot } from '../src/paths.ts';

interface WakeLine {
  id?: string;
  ts?: string;
  durationMs?: number;
  reason?: string;
  matchedName?: string;
  senders?: string[];
  events?: Array<{ cursor?: number; type?: string; source?: string; wake?: string; sender?: string; first?: string }>;
  context?: {
    estTokens?: number | null;
    prefixChars?: number;
    prefixHash?: string;
    cards?: string[];
    recordsBefore?: number;
    recordsAfter?: number;
  };
  actions?: {
    calls?: Array<{ name?: string; args?: string }>;
    outputs?: string[];
    assistant?: string[];
    sent?: string | null;
  };
  outcome?: string;
}

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

function resolveDataDir(): string {
  const direct = flag('--data');
  if (direct) return direct;
  const root = deploymentRoot();
  const bot = flag('--bot');
  if (bot) return join(root, bot, 'data');
  const candidates = readdirSync(root)
    .map((name) => join(root, name, 'data'))
    .filter((dir) => existsSync(join(dir, 'wakes.jsonl')));
  if (candidates.length === 1) return candidates[0];
  throw new Error(
    candidates.length === 0
      ? `没有找到 wakes.jsonl；用 --bot <部署名> 或 --data <目录> 指定（部署根: ${root}）`
      : `多个部署有 wakes.jsonl，用 --bot 指定其一: ${candidates.join(', ')}`,
  );
}

function readTail(file: string, limit: number): WakeLine[] {
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line) as WakeLine;
    } catch {
      return { id: '(无法解析)', events: [] };
    }
  });
}

function block(wake: WakeLine): string {
  const head = [
    `#${wake.id ?? '?'}`,
    wake.ts ?? '',
    `reason=${wake.reason ?? '?'}${wake.matchedName ? `(${wake.matchedName})` : ''}`,
    `outcome=${wake.outcome ?? '?'}`,
    `${wake.durationMs ?? 0}ms`,
    `est=${wake.context?.estTokens ?? '?'} tokens`,
  ].join('  ');
  const out: string[] = [head];
  for (const event of wake.events ?? []) {
    out.push(`  event   #${event.cursor ?? '?'} ${event.type ?? '?'} [${event.wake ?? event.source ?? '?'}] ${event.sender ?? ''} ${event.first ?? ''}`);
  }
  const context = wake.context;
  if (context) {
    out.push(`  context prefix ${context.prefixChars ?? '?'} chars hash=${context.prefixHash ?? '?'} cards=${(context.cards ?? []).join(',') || '(none)'}`);
  }
  for (const call of wake.actions?.calls ?? []) {
    out.push(`  call    ${call.name ?? '?'} ${call.args ?? ''}`);
  }
  if (wake.actions?.sent) out.push(`  sent    ${wake.actions.sent}`);
  for (const text of wake.actions?.assistant ?? []) {
    if (text.trim()) out.push(`  said    ${text}`);
  }
  return out.join('\n');
}

try {
  const dataDir = resolveDataDir();
  const last = Number(flag('--last') ?? 10);
  const reason = flag('--reason');
  const wakes = readTail(join(dataDir, 'wakes.jsonl'), Number.isFinite(last) && last > 0 ? last : 10)
    .filter((wake) => !reason || String(wake.reason ?? '').includes(reason));
  if (args.includes('--json')) {
    for (const wake of wakes) console.log(JSON.stringify(wake));
  } else {
    console.log(wakes.length ? wakes.map(block).join('\n\n') : `(${dataDir}/wakes.jsonl 里没有匹配的记录)`);
  }
} catch (err) {
  console.error(`wakeq: ${String(err instanceof Error ? err.message : err)}`);
  process.exit(1);
}
