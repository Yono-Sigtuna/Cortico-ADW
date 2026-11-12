/** 名字层：号是身份，昵称是会变的外壳；记忆里只存指向。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PersonRegistry } from '../../bots/amber/persona/people.ts';
import { MemoryIndex } from '../../bots/amber/persona/memoryIndex.ts';
import { makeTmpDir } from '../core/helpers.ts';

describe('名字解析', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let peopleDir: string;

  const write = (name: string, body: string): void => {
    writeFileSync(join(peopleDir, name), body, 'utf8');
  };
  const glossary = (names: string): void => {
    const dir = join(tmp.dir, 'note', 'playbook');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '称呼与术语.md'), `# 术语表\n\n## 我自己的称呼\n\n${names}\n`, 'utf8');
  };

  beforeEach(() => {
    tmp = makeTmpDir();
    peopleDir = join(tmp.dir, 'people');
    mkdirSync(peopleDir, { recursive: true });
  });

  afterEach(() => tmp.cleanup());

  it('从首行读出当前称呼与号', () => {
    write('qq-3124076548.md', '橘子精(3124076548) — 群主，改我的人。\n');
    const registry = new PersonRegistry(tmp.dir);
    expect(registry.displayOf('3124076548')).toBe('橘子精');
    expect(registry.byQqNumber('3124076548')?.summary).toBe('群主，改我的人。');
  });

  it('写进记忆时换成指向，读出来是当前称呼', () => {
    write('qq-3124076548.md', '橘子精(3124076548) — 群主。\n');
    const registry = new PersonRegistry(tmp.dir);
    const stored = registry.canonicalize('橘子精说他改完架构了。');
    expect(stored).toBe('@3124076548说他改完架构了。');
    expect(registry.render(stored)).toBe('橘子精说他改完架构了。');
  });

  it('改名后旧名渲染成新名，正文里已有的旧名也自愈', () => {
    write('qq-3124076548.md', '橘子精(3124076548) — 群主。\n\n## 曾用名\n- 小橘\n- 疯狂性寝祀\n');
    const registry = new PersonRegistry(tmp.dir);
    expect(registry.render('小橘说过他要重写一遍。')).toBe('橘子精说过他要重写一遍。');
    expect(registry.render('疯狂性寝祀当时在群里。')).toBe('橘子精当时在群里。');
  });

  it('长名优先：小橘不会吃掉小橘子', () => {
    write('qq-10000001.md', '小橘(10000001) — 一个。\n');
    write('qq-10000002.md', '小橘子(10000002) — 另一个。\n');
    const registry = new PersonRegistry(tmp.dir);
    expect(registry.canonicalize('小橘子来了')).toBe('@10000002来了');
    expect(registry.canonicalize('小橘来了')).toBe('@10000001来了');
  });

  it('同一个名字归属两个人时不替换，免得张冠李戴', () => {
    write('qq-20000001.md', '甲(20000001) — 一个。\n\n## 曾用名\n- 小白\n');
    write('qq-20000002.md', '乙(20000002) — 另一个。\n\n## 曾用名\n- 小白\n');
    const registry = new PersonRegistry(tmp.dir);
    expect(registry.canonicalize('小白说的')).toBe('小白说的');
  });

  it('她自己的称呼不参与替换', () => {
    write('qq-30000001.md', '小橙(30000001) — 恰好同名。\n');
    glossary('Claude、小橙、小克');
    const registry = new PersonRegistry(tmp.dir);
    expect(registry.canonicalize('小橙今天在群里说了句话。')).toBe('小橙今天在群里说了句话。');
  });

  it('框架记的改名流水会补进曾用名', () => {
    write('qq-40000001.md', '新名字(40000001) — 一个人。\n');
    const namesFile = join(tmp.dir, 'qq-names.json');
    writeFileSync(namesFile, JSON.stringify({
      '40000001': { name: '新名字', history: [{ name: '旧名字', from: '2026-09-01', to: '2026-10-20' }] },
    }), 'utf8');
    const registry = new PersonRegistry(tmp.dir, { namesFile });
    expect(registry.render('旧名字提过这事。')).toBe('新名字提过这事。');
  });

  it('从档案里读出她自己的看法，而不是这个人的资料', () => {
    write(
      'qq-3124076548.md',
      '橘子精(3124076548) — 群主。\n\n## 我的看法\n- 2026-10-20 他要的不是顺从，是被认真对待\n- 2026-10-25 他嘴硬，但会改\n',
    );
    const registry = new PersonRegistry(tmp.dir);
    expect(registry.byQqNumber('3124076548')?.views).toEqual([
      '2026-10-20 他要的不是顺从，是被认真对待',
      '2026-10-25 他嘴硬，但会改',
    ]);
  });

  it('档案改了之后不用重建实例，下一次解析就生效', () => {
    const file = join(peopleDir, 'qq-50000001.md');
    writeFileSync(file, '旧称呼(50000001) — 一个人。\n', 'utf8');
    const registry = new PersonRegistry(tmp.dir);
    expect(registry.displayOf('50000001')).toBe('旧称呼');
    writeFileSync(file, '新称呼(50000001) — 一个人。\n\n## 曾用名\n- 旧称呼\n', 'utf8');
    // Windows 的 mtime 精度到毫秒，测试跑得快时可能落在同一格。
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(registry.displayOf('50000001')).toBe('新称呼');
  });
});

describe('记忆索引的名字钩子', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let index: MemoryIndex;
  let registry: PersonRegistry;

  beforeEach(() => {
    tmp = makeTmpDir();
    const peopleDir = join(tmp.dir, 'people');
    mkdirSync(peopleDir, { recursive: true });
    writeFileSync(join(peopleDir, 'qq-3124076548.md'), '橘子精(3124076548) — 群主。\n', 'utf8');
    registry = new PersonRegistry(tmp.dir);
    index = new MemoryIndex(':memory:', undefined, {
      canonicalize: (text) => registry.canonicalize(text),
      render: (text) => registry.render(text),
      expand: (text) => registry.expand(text),
    });
  });

  afterEach(() => {
    index.close();
    tmp.cleanup();
  });

  it('入库的是指向，出库的是当前称呼', () => {
    const id = index.put({ text: '橘子精说他改完架构了。', kind: 'relational', importance: 0.7, people: ['3124076548'] });
    expect(index.get(id)?.text).toBe('橘子精说他改完架构了。');
    expect(index.recall('架构', { k: 3 })[0].text).toBe('橘子精说他改完架构了。');
  });

  it('旧名字仍然搜得到，读到的是新名字', () => {
    const file = join(tmp.dir, 'people', 'qq-3124076548.md');
    writeFileSync(file, '橘子精(3124076548) — 群主。\n\n## 曾用名\n- 小橘\n', 'utf8');
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    index.put({ text: '橘子精说过他要重写一遍。', kind: 'episodic', importance: 0.6, people: ['3124076548'] });

    const hits = index.recall('小橘', { k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    // matched > 0 说明是真的命中，不是"没命中时按重要性兜底"。
    expect(hits[0].breakdown.matched).toBeGreaterThan(0);
    expect(hits[0].text).toContain('橘子精');
    expect(hits[0].text).not.toContain('小橘');
  });

  it('同一个人改名前后写的同一句话不会变成两条', () => {
    index.put({ text: '橘子精说他改完架构了。', kind: 'relational', importance: 0.7 });
    const file = join(tmp.dir, 'people', 'qq-3124076548.md');
    writeFileSync(file, '橘子精(3124076548) — 群主。\n\n## 曾用名\n- 小橘\n', 'utf8');
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    index.put({ text: '小橘说他改完架构了。', kind: 'relational', importance: 0.7 });
    expect(index.count()).toBe(1);
  });
});

describe('按人召回：改名之后她还认得出', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let index: MemoryIndex;
  let registry: PersonRegistry;
  let file: string;

  const rename = (): void => {
    writeFileSync(file, '橘子精(3124076548) — 群主。\n\n## 曾用名\n- 小橘\n', 'utf8');
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  };

  beforeEach(() => {
    tmp = makeTmpDir();
    const peopleDir = join(tmp.dir, 'people');
    mkdirSync(peopleDir, { recursive: true });
    file = join(peopleDir, 'qq-3124076548.md');
    // 写入这条记忆的时候，他还叫「小橘」。
    writeFileSync(file, '小橘(3124076548) — 群主。\n', 'utf8');
    registry = new PersonRegistry(tmp.dir);
    index = new MemoryIndex(':memory:', undefined, {
      canonicalize: (text) => registry.canonicalize(text),
      render: (text) => registry.render(text),
      expand: (text) => registry.expand(text),
    });
    index.put({
      text: '小橘说他女儿今年上小学了。',
      kind: 'episodic',
      importance: 0.7,
      eventTime: '2026-08-01',
      people: ['3124076548'],
    });
  });

  afterEach(() => {
    index.close();
    tmp.cleanup();
  });

  it('按 QQ 号召回，不依赖名字出现在正文里', () => {
    rename();
    const hits = index.recallForPeople(['3124076548'], { k: 3 });
    expect(hits.length).toBe(1);
    // 库里存的是指向，念出来是改名后的称呼。
    expect(hits[0].text).toContain('橘子精');
    expect(hits[0].text).not.toContain('小橘');
  });

  it('用新名字发起的检索能接回旧记忆', () => {
    rename();
    const query = registry.queryTerms('橘子精最近怎么样');
    expect(query).toContain('小橘');
    const hits = index.recall(query, { k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    // matched > 0：是真的命中，不是"没命中时按重要性兜底"。
    expect(hits[0].breakdown.matched).toBeGreaterThan(0);
  });

  it('数得清这个人被记得几件事', () => {
    expect(index.countForPerson('3124076548')).toBe(1);
    expect(index.countForPerson('9999999')).toBe(0);
  });
});

describe('台账里没有档案的人', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let peopleDir: string;
  let namesFile: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    peopleDir = join(tmp.dir, 'people');
    mkdirSync(peopleDir, { recursive: true });
    namesFile = join(tmp.dir, 'qq-names.json');
  });

  afterEach(() => tmp.cleanup());

  const ledger = (data: Record<string, unknown>): void => {
    writeFileSync(namesFile, JSON.stringify(data), 'utf8');
  };

  it('没建档案，写进记忆也换成指向，读出来是当前称呼', () => {
    ledger({ '70000001': { name: '清鱼' } });
    const registry = new PersonRegistry(tmp.dir, { namesFile });

    const stored = registry.canonicalize('清鱼说她换工作了。');
    expect(stored).toBe('@70000001说她换工作了。');
    expect(registry.render(stored)).toBe('清鱼说她换工作了。');
  });

  it('没建档案的人改了名：旧名读出来是新名，也不会留下裸号', () => {
    ledger({
      '70000002': { name: '阿摆', history: [{ name: '摆摆' }, { name: '阿摆摆' }] },
    });
    const registry = new PersonRegistry(tmp.dir, { namesFile });

    expect(registry.render('摆摆那天说过这事。')).toBe('阿摆那天说过这事。');
    expect(registry.render('@70000002那天说过这事。')).toBe('阿摆那天说过这事。');
  });

  it('两个号同名：不替换，宁可留着让人看懂', () => {
    ledger({ '70000003': { name: '同名仔' }, '70000004': { name: '同名仔' } });
    const registry = new PersonRegistry(tmp.dir, { namesFile });

    expect(registry.canonicalize('同名仔来了。')).toBe('同名仔来了。');
  });

  it('名字太短不换：一个字的名字误伤面太大', () => {
    ledger({ '70000005': { name: '辰' } });
    const registry = new PersonRegistry(tmp.dir, { namesFile });

    expect(registry.canonicalize('辰来了。')).toBe('辰来了。');
  });

  it('有档案的以档案为准，台账只补旧名', () => {
    writeFileSync(join(peopleDir, 'qq-70000006.md'), '现在叫这个(70000006) — 一个人。\n', 'utf8');
    ledger({ '70000006': { name: '台账上的名', history: [{ name: '更早的名' }] } });
    const registry = new PersonRegistry(tmp.dir, { namesFile });

    expect(registry.displayOf('70000006')).toBe('现在叫这个');
    expect(registry.render('更早的名说过一句。')).toBe('现在叫这个说过一句。');
  });
});
