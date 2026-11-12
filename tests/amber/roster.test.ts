/** people/ 名册：身份是 QQ 号（文件名），昵称只是首行里的可变标签。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRoster } from '../../bots/amber/persona/roster.ts';
import { makeTmpDir } from '../core/helpers.ts';

describe('人物名册', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let people: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    people = join(tmp.dir, 'people');
    mkdirSync(people, { recursive: true });
  });

  afterEach(() => tmp.cleanup());

  it('QQ 用户的档案以 QQ 号命名，首行的昵称作为描述', () => {
    writeFileSync(join(people, 'qq-3124076548.md'), '疯狂性寝祀(3124076548) — 群主。\n', 'utf8');
    const roster = buildRoster(tmp.dir);
    expect(roster).toContain('qq-3124076548 — 疯狂性寝祀(3124076548) — 群主。');
    expect(roster).not.toContain('⚠');
  });

  it('同一个 QQ 号多份档案会报警，直到合并', () => {
    writeFileSync(join(people, 'qq-3124076548.md'), '疯狂性寝祀(3124076548) — 群主。\n', 'utf8');
    writeFileSync(join(people, '改名前的旧档.md'), '旧昵称(3124076548) — 同一个人。\n', 'utf8');
    const roster = buildRoster(tmp.dir);
    expect(roster).toContain('⚠ QQ 3124076548 有多份档案');
    expect(roster).toContain('qq-3124076548.md');
    expect(roster).toContain('改名前的旧档.md');
  });

  it('文件名与首行的号不一致会报警', () => {
    writeFileSync(join(people, 'qq-111111.md'), '某人(222222) — 号写错了。\n', 'utf8');
    const roster = buildRoster(tmp.dir);
    expect(roster).toContain('⚠ qq-111111.md 的首行写的是 QQ 222222，文件名是 111111');
  });

  it('不在 QQ 上的人物用固定名字，不触发任何警告', () => {
    writeFileSync(join(people, 'deepseek.md'), 'DeepSeek娘：蓝发蓝瞳的 AI 娘。\n', 'utf8');
    const roster = buildRoster(tmp.dir);
    expect(roster).toBe('- deepseek — DeepSeek娘：蓝发蓝瞳的 AI 娘。');
  });

  it('中文全角括号里的号也认', () => {
    writeFileSync(join(people, 'qq-3344672864.md'), '清鱼（3344672864）— 说话简短。\n', 'utf8');
    expect(buildRoster(tmp.dir)).not.toContain('⚠');
  });

  it('曾用名跟着名字一起进名册', () => {
    writeFileSync(join(people, 'qq-3124076548.md'), '橘子精(3124076548) — 群主。\n\n## 曾用名\n- 小橘\n- 疯狂性寝祀\n', 'utf8');
    const roster = buildRoster(tmp.dir);
    expect(roster).toContain('曾用名：');
    expect(roster).toContain('小橘');
    expect(roster).toContain('疯狂性寝祀');
  });
});
