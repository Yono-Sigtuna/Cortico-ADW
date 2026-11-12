/** 梦的工具面：它得拿得到「写记忆」「维护状态」这两只手。 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeDefaults } from '../../bots/amber/assemble.ts';
import { CortiSoulmate } from '../../bots/amber/persona/index.ts';
import { makeFakeHarnessApi, makeTmpDir } from '../core/helpers.ts';

describe('梦的工具面', () => {
  let tmp: ReturnType<typeof makeTmpDir> | null = null;
  afterEach(() => {
    tmp?.cleanup();
    tmp = null;
  });

  it('挂载之后，梦拿得到 remember、maintain_state 与生活工具', () => {
    tmp = makeTmpDir();
    const persona = new CortiSoulmate({
      memoryDir: tmp.dir,
      cfg: composeDefaults(),
      wakeLogDir: tmp.dir,
    });
    persona.attach(makeFakeHarnessApi());
    const names = (persona as unknown as { dreamTools(): Array<{ name: string }> })
      .dreamTools()
      .map((tool) => tool.name);
    expect(names).toContain('remember');
    expect(names).toContain('maintain_state');
    expect(names).toContain('write_daily_plan');
    expect(names).toContain('maintain_life');
    expect(names).toContain('read_file');
  });

  it('梦读过的文件在它思考期间被改过：写回被拒，重读之后才放行', async () => {
    tmp = makeTmpDir();
    const persona = new CortiSoulmate({
      memoryDir: tmp.dir,
      cfg: composeDefaults(),
      wakeLogDir: tmp.dir,
    });
    persona.attach(makeFakeHarnessApi());
    const tools = (persona as unknown as {
      dreamTools(): Array<{ name: string; handler: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }>;
    }).dreamTools();
    const read = tools.find((tool) => tool.name === 'read_file')!;
    const write = tools.find((tool) => tool.name === 'write_file')!;
    const ctx = { role: 'dream', log: { info() {}, warn() {}, error() {}, debug() {} } } as never;
    const path = 'people/f08.md';
    const abs = join(tmp.dir, 'people', 'f08.md');

    writeFileSync(abs, '她写的第一版\n', 'utf8');
    await read.handler({ path }, ctx);
    // 她还在想的时候，主意识把新内容追加进了同一份文件。
    writeFileSync(abs, '她写的第一版\n\n主意识补的一段\n', 'utf8');

    const denied = await write.handler({ path, content: '她按旧稿整篇重写\n' }, ctx);
    expect(String(denied)).toContain('read_file 重读');
    expect(readFileSync(abs, 'utf8')).toContain('主意识补的一段');

    await read.handler({ path }, ctx);
    const written = await write.handler({ path, content: '合进去之后的重写\n' }, ctx);
    expect(String(written)).toContain('[written]');
    expect(readFileSync(abs, 'utf8')).toBe('合进去之后的重写\n');
  });
});
