import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface QQContinuationSpec {
  action: string;
  person: string;
  kind: 'scene' | 'task';
  after_minutes: number;
}
export interface QQContinuation {
  id: string;
  conv: string;
  text: string;
  spec: QQContinuationSpec;
  kind: QQContinuationSpec['kind'];
  createdAt: number;
  dueAt: number;
  expiresAt: number;
  status: 'prepared' | 'waiting' | 'ready' | 'uncertain' | 'completed' | 'cancelled' | 'expired';
}
export const CONTINUATION_GRACE_MS = 30 * 60_000;

export class QQContinuations {
  private tasks: QQContinuation[] = [];
  private readonly file: string | null;

  constructor(private readonly dataDir?: string) {
    this.file = dataDir ? join(dataDir, 'qq-continuations.json') : null;
    if (this.file && existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version: number; tasks: QQContinuation[] };
      if (raw.version !== 1 || !Array.isArray(raw.tasks)) throw new Error('Invalid QQ continuation state');
      this.tasks = raw.tasks;
    }
  }

  get(id: string): QQContinuation | undefined { return this.tasks.find((t) => t.id === id); }
  list(): QQContinuation[] {
    return this.tasks.filter((t) => !['completed', 'cancelled', 'expired'].includes(t.status));
  }
  prepare(conv: string, text: string, spec: QQContinuationSpec, now = Date.now()): QQContinuation {
    const task: QQContinuation = {
      id: randomUUID(), conv, text, spec, kind: spec.kind, createdAt: now,
      dueAt: 0, expiresAt: 0, status: 'prepared',
    };
    this.tasks.push(task);
    try { this.save(); } catch (err) { this.tasks.pop(); throw err; }
    return task;
  }
  activate(id: string, now = Date.now()): void {
    const task = this.get(id)!;
    if (task.status !== 'prepared') return;
    task.status = 'waiting';
    task.dueAt = now + task.spec.after_minutes * 60_000;
    task.expiresAt = task.dueAt + CONTINUATION_GRACE_MS;
    this.save();
  }
  due(now = Date.now()): QQContinuation[] {
    this.expire(now);
    return this.tasks.filter((t) => t.status === 'waiting' && t.dueAt <= now);
  }
  expire(now = Date.now()): void {
    let changed = false;
    for (const task of this.tasks) {
      if (['waiting', 'ready'].includes(task.status) && task.expiresAt < now) {
        task.status = 'expired'; changed = true;
      }
    }
    if (changed) this.save();
  }
  markReady(id: string): void { this.get(id)!.status = 'ready'; this.save(); }
  requeue(id: string): void { this.get(id)!.status = 'waiting'; this.save(); }
  uncertain(id: string): void { this.get(id)!.status = 'uncertain'; this.save(); }
  finish(id: string, status: 'completed' | 'cancelled'): void {
    this.get(id)!.status = status; this.save();
  }
  delay(id: string, minutes: number, now = Date.now()): void {
    const task = this.get(id)!;
    task.status = 'waiting'; task.dueAt = now + minutes * 60_000;
    task.expiresAt = task.dueAt + CONTINUATION_GRACE_MS;
    this.save();
  }
  private save(): void {
    if (!this.file) return;
    mkdirSync(this.dataDir!, { recursive: true });
    const tasks = this.tasks.filter((t) => !['completed', 'cancelled', 'expired'].includes(t.status));
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, tasks }), 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
  }
}
