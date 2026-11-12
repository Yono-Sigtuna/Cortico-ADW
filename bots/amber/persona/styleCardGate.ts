/**
 * 语气卡的质量门：记下每一次「递了哪张卡、她怎么回的」，再据此决定还递不递。
 *
 * 观察的是三件事：
 *   - 递出去之后她有没有开口（sent）；
 *   - 她的回话和卡上那句重合多少（echo）——重合太高就是在照台词念，那样这张卡是负资产；
 *   - 连着照念的卡会被停用，不再往她眼前递。
 *
 * 只记字面，不评判语义：判断"像不像她"要模型，判断"是不是照着念"只要 bigram。
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RECITE_ECHO, cardEcho } from './styleCards.ts';

/** 流水文件放在部署 data/ 下，跟唤醒日志同一个位置。 */
const FILE = 'style-cards.jsonl';
const ROTATE_BYTES = 2 * 1024 * 1024;
/** 递了这么多次、其中这么多次是照念，就停用这张卡。 */
const DEMOTE_SHOTS = 3;
const DEMOTE_RECITED = 2;

export interface CardShot {
  kind: 'shot';
  id: string;
  ts: string;
  conv: string;
  sender: string;
  card: string;
  scene: string;
  /** 递卡那一刻的姿态：`关系/心情/身体`。 */
  stance: string;
  affinity: number;
  question: string;
  answer: string;
}

export interface CardResult {
  kind: 'result';
  id: string;
  ts: string;
  sent: boolean;
  reply: string;
  echo: number;
  recited: boolean;
}

export interface CardStat {
  card: string;
  shots: number;
  sent: number;
  silent: number;
  recited: number;
  avgEcho: number;
  lastAt: string;
}

export interface ShotInput {
  conv: string;
  sender: string;
  card: string;
  scene: string;
  /** 递卡那一刻的姿态：`关系/心情/身体`。 */
  stance: string;
  affinity: number;
  question: string;
  answer: string;
}

export class StyleCardGate {
  private seq = 0;
  private readonly dir: string | null;
  private readonly now: () => number;

  constructor(dir: string | null, now: () => number = () => Date.now()) {
    this.dir = dir;
    this.now = now;
  }

  /** 记一次递卡，返回这一笔的 id；回合结束时拿它去补结果。没有目录就什么都不做。 */
  recordShot(input: ShotInput): string | null {
    if (!this.dir) return null;
    const id = `${this.now()}-${++this.seq}`;
    this.append({
      kind: 'shot',
      id,
      ts: new Date(this.now()).toISOString(),
      conv: input.conv,
      sender: input.sender,
      card: input.card,
      scene: input.scene,
      stance: input.stance,
      affinity: Number(input.affinity.toFixed(3)),
      question: clip(input.question, 200),
      answer: clip(input.answer, 200),
    });
    return id;
  }

  /** 这一轮她怎么回的。没开口也算一条——「递了卡她还是没话」同样是信号。 */
  recordResult(id: string, sent: boolean, reply: string, answer: string): void {
    if (!this.dir || !id) return;
    const echo = Number(cardEcho(answer, reply).toFixed(3));
    this.append({
      kind: 'result',
      id,
      ts: new Date(this.now()).toISOString(),
      sent,
      reply: clip(reply, 400),
      echo,
      recited: sent && echo >= RECITE_ECHO,
    });
  }

  /** 所有卡的账。文件不大，每次现算。 */
  stats(): CardStat[] {
    const shots = new Map<string, CardShot>();
    const byCard = new Map<string, CardStat>();
    for (const line of this.lines()) {
      let row: CardShot | CardResult;
      try {
        row = JSON.parse(line) as CardShot | CardResult;
      } catch {
        continue;
      }
      if (row.kind === 'shot') {
        shots.set(row.id, row);
        const stat = byCard.get(row.card) ?? {
          card: row.card, shots: 0, sent: 0, silent: 0, recited: 0, avgEcho: 0, lastAt: row.ts,
        };
        stat.shots += 1;
        stat.lastAt = row.ts;
        byCard.set(row.card, stat);
        continue;
      }
      const shot = shots.get(row.id);
      if (!shot) continue;
      const stat = byCard.get(shot.card);
      if (!stat) continue;
      if (row.sent) stat.sent += 1;
      else stat.silent += 1;
      if (row.recited) stat.recited += 1;
      stat.avgEcho += row.echo;
    }
    for (const stat of byCard.values()) {
      const answered = stat.sent + stat.silent;
      stat.avgEcho = answered ? Number((stat.avgEcho / answered).toFixed(2)) : 0;
    }
    return [...byCard.values()].sort((a, b) => b.shots - a.shots);
  }

  /** 这张卡是不是已经证明会被照念——是就别再递了。 */
  shouldSkip(card: string, stats: readonly CardStat[] = this.stats()): boolean {
    const stat = stats.find((item) => item.card === card);
    return stat !== undefined && stat.shots >= DEMOTE_SHOTS && stat.recited >= DEMOTE_RECITED;
  }

  private append(row: CardShot | CardResult): void {
    if (!this.dir) return;
    const file = join(this.dir, FILE);
    try {
      if (existsSync(file) && statSync(file).size > ROTATE_BYTES) renameSync(file, join(this.dir, `${FILE}.1`));
      appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    } catch {
      /* 记账失败不影响说话 */
    }
  }

  private lines(): string[] {
    if (!this.dir) return [];
    try {
      return readFileSync(join(this.dir, FILE), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

function clip(text: string, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
