/**
 * 名字与号的双向解析。
 *
 * 身份是 QQ 号，昵称只是会变的外壳。记忆里不该冻结"当时她叫什么"：
 * 写入时把人名换成 `@<QQ号>`，读出来时再按档案里的当前称呼渲染回去。
 * 这样一条半年前写的记忆，今天念出来用的是今天的名字。
 *
 * 名字有两个来源，档案优先：`people/*.md` 的首行是当前称呼、`## 曾用名` 是历史；
 * 没有档案的人由 `data/qq-names.json` 顶上——框架层先看见改名，它的当前名与 history
 * 一样参与替换。有档案时台账只补历史，不覆盖档案。
 * 不认识的人一个都不编：映射里没有的名字原样留着。
 *
 * 虚构人物（deepseek / gpt）名字是固定的，不参与替换。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSelfNames } from './wakeNames.ts';

/** 首行里的 QQ 号：`昵称(123456)` 或 `昵称（123456）`。 */
const UID_IN_LINE = /[（(]\s*(\d{5,12})\s*[)）]/;
/** `qq-<号>` 形式的文件名里的号。 */
const UID_IN_NAME = /^qq-(\d{5,12})$/i;
/** 正文里的占位符：`@3124076548`。 */
const PLACEHOLDER = /@(\d{5,12})/g;
/** 替换过程中的临时标记；正文里不会有 NUL。 */
const MARK = '\u0000';
const MARKED = /\u0000(\d{5,12})\u0000/g;
/** 正文里的 `别名：a、b、c` 行（虚构人物常用）。 */
const ALIAS_LINE = /^\s*别名[：:]\s*(.+)$/;
/** `## 曾用名` / `## 旧名` 小节。 */
const FORMER_HEADING = /^#{1,4}\s*(曾用名|旧名|以前的称呼)/;
/** `## 我的看法` 小节：她对这个人自己的判断，不是这个人的资料。 */
const VIEW_HEADING = /^#{1,4}\s*(我的看法|对他的看法|对她的看法|看法)/;
/** 名字至少两个字：单字太容易误伤普通词。 */
const MIN_ALIAS = 2;

export interface PersonRecord {
  /** QQ 号；虚构人物为空串。 */
  qq: string;
  /** 当前称呼（首行）；虚构人物取首行 `名字：` 之前的部分。 */
  name: string;
  /** 首行 `—` 之后的一句概括。 */
  summary: string;
  /** 首行原文，名册直接用它，不改写人格自己写的话。 */
  firstLine: string;
  /** 曾用名与别名，不含 name 本身。 */
  aliases: string[];
  /** `## 我的看法`：她对这个人自己的判断，最多取最近几条。 */
  views: string[];
  /** 相对 memoryDir 的档案路径。 */
  file: string;
  /** 首行里的号 / 文件名里的号：名册的一致性检查用。 */
  uidInLine: string | null;
  uidInFile: string | null;
}

/** `data/qq-names.json` 的形状：框架层记下的改名流水。 */
interface NamesLedger {
  [qq: string]: {
    name?: string;
    history?: Array<{ name?: string }>;
  };
}

export interface PersonRegistryOptions {
  /** 框架写的改名流水；没有就不读。 */
  namesFile?: string;
  /** 她自己的术语表，用来把自己的一切称呼排除在替换之外。 */
  selfNamesFile?: string;
  warn?: (msg: string, data?: unknown) => void;
}

/** 名字 → 号 的唯一映射；有歧义的名字不进表。 */
interface AliasEntry {
  name: string;
  qq: string;
}

export class PersonRegistry {
  private readonly memoryDir: string;
  private readonly namesFile: string | null;
  private readonly selfFile: string;
  private readonly warn: ((msg: string, data?: unknown) => void) | null;

  private stamp = '';
  private records: PersonRecord[] = [];
  private byQq = new Map<string, PersonRecord>();
  private byAlias = new Map<string, string[]>();
  /** 台账里有、档案里还没有的人：名字同样要能换成 `@号`、也要能换回来。 */
  private ledgerNames = new Map<string, string>();
  private ledgerHistory = new Map<string, string[]>();
  private selfNames = new Set<string>();
  private warnedAmbiguous = new Set<string>();

  constructor(memoryDir: string, opts: PersonRegistryOptions = {}) {
    this.memoryDir = memoryDir;
    this.namesFile = opts.namesFile ?? null;
    this.selfFile = opts.selfNamesFile ?? join(memoryDir, 'note', 'playbook', '称呼与术语.md');
    this.warn = opts.warn ?? null;
  }

  /** 档案有变动才重建；每次唤醒都会调，所以失效判断必须是廉价的。 */
  private ensure(): void {
    const stamp = this.currentStamp();
    if (stamp === this.stamp && this.records.length) return;
    this.stamp = stamp;
    this.rebuild();
  }

  private currentStamp(): string {
    const parts: string[] = [];
    const dir = join(this.memoryDir, 'people');
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        if (entry.name.startsWith('.') || entry.name.includes('.tmp-')) continue;
        try {
          parts.push(`${entry.name}:${statSync(join(dir, entry.name)).mtimeMs}`);
        } catch {
          parts.push(`${entry.name}:?`);
        }
      }
    } catch {
      // 没有 people/ 就是空名册，不是错误。
    }
    for (const file of [this.namesFile, this.selfFile]) {
      if (!file) continue;
      try {
        parts.push(`meta:${statSync(file).mtimeMs}`);
      } catch {
        // 文件不存在：下次出现时 mtime 变了会触发重建。
      }
    }
    return parts.sort().join('|');
  }

  private rebuild(): void {
    const dir = join(this.memoryDir, 'people');
    const ledger = this.readLedger();
    const selfNames = this.readSelfNames();

    const records: PersonRecord[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')
          && !e.name.startsWith('.') && !e.name.includes('.tmp-'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      files = [];
    }
    for (const file of files) records.push(this.parseFile(dir, file, ledger));

    // 号 → 档案；同号多档时以 `qq-<号>.md` 优先，其余的仍然参与名册（名册会报警）。
    const byQq = new Map<string, PersonRecord>();
    for (const record of records) {
      if (!record.qq) continue;
      const current = byQq.get(record.qq);
      if (!current || (!current.uidInFile && record.uidInFile)) byQq.set(record.qq, record);
    }

    const byAlias = new Map<string, string[]>();
    const add = (name: string, qq: string): void => {
      const list = byAlias.get(name) ?? [];
      if (!list.includes(qq)) list.push(qq);
      byAlias.set(name, list);
    };
    for (const record of records) {
      if (!record.qq) continue;
      add(record.name, record.qq);
      for (const alias of record.aliases) add(alias, record.qq);
    }

    // 台账里有、档案还没建的人。没这一步，名字只有「有档案的那几个」能被换掉，
    // 其余人写进记忆的就是裸昵称，改名之后再也接不回这个人。
    const ledgerNames = new Map<string, string>();
    const ledgerHistory = new Map<string, string[]>();
    for (const [qq, rec] of Object.entries(ledger)) {
      if (!qq || byQq.has(qq)) continue;
      const current = clean(rec?.name ?? '');
      if (!current) continue;
      ledgerNames.set(qq, current);
      add(current, qq);
      const history: string[] = [];
      for (const item of rec?.history ?? []) {
        const old = clean(item?.name ?? '');
        if (!old || old === current || history.includes(old)) continue;
        history.push(old);
        add(old, qq);
      }
      if (history.length) ledgerHistory.set(qq, history);
    }

    this.records = records;
    this.byQq = byQq;
    this.byAlias = byAlias;
    this.ledgerNames = ledgerNames;
    this.ledgerHistory = ledgerHistory;
    this.selfNames = new Set(selfNames);
    this.warnedAmbiguous.clear();
  }

  /** 一个号的全部称呼；档案优先，没有档案就用台账。 */
  private namesOf(qq: string): { current: string; aliases: string[] } | null {
    const record = this.byQq.get(qq);
    if (record) return { current: record.name, aliases: record.aliases };
    const current = this.ledgerNames.get(qq);
    if (!current) return null;
    return { current, aliases: this.ledgerHistory.get(qq) ?? [] };
  }

  private readLedger(): NamesLedger {
    if (!this.namesFile || !existsSync(this.namesFile)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.namesFile, 'utf8')) as unknown;
      return raw && typeof raw === 'object' ? (raw as NamesLedger) : {};
    } catch {
      return {};
    }
  }

  private readSelfNames(): string[] {
    try {
      return parseSelfNames(readFileSync(this.selfFile, 'utf8'));
    } catch {
      return [];
    }
  }

  private parseFile(dir: string, file: string, ledger: NamesLedger): PersonRecord {
    const key = file.replace(/\.md$/i, '');
    let body = '';
    try {
      body = readFileSync(join(dir, file), 'utf8');
    } catch {
      body = '';
    }
    const lines = body.split(/\r?\n/);
    const firstLine = (lines[0] ?? '').trim();
    const uidInFile = UID_IN_NAME.exec(key)?.[1] ?? null;
    const uidInLine = UID_IN_LINE.exec(firstLine)?.[1] ?? null;
    const qq = uidInLine ?? uidInFile ?? '';

    let name = '';
    let summary = '';
    if (uidInLine) {
      const at = firstLine.search(UID_IN_LINE);
      name = clean(firstLine.slice(0, at));
      // 概括是她自己写的句子，原样留着——别把句号也洗掉。
      summary = firstLine.slice(at).replace(UID_IN_LINE, '').trim().replace(/^[—–-]{1,2}\s*/, '');
    } else {
      // 虚构人物：`名字：概括`
      const head = /^([^：:]{1,20})[：:]\s*(.*)$/.exec(firstLine);
      name = head ? clean(head[1]) : clean(firstLine) || key;
      summary = head ? head[2].trim() : '';
    }
    if (!name) name = key;

    const aliases: string[] = [];
    const views: string[] = [];
    let inFormer = false;
    let inView = false;
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (/^#{1,6}\s/.test(line)) {
        inFormer = FORMER_HEADING.test(line);
        inView = VIEW_HEADING.test(line);
        continue;
      }
      if (inView) {
        const bullet = /^[-*·]\s*(.+)$/.exec(line);
        if (bullet) views.push(bullet[1].trim().slice(0, 200));
        continue;
      }
      const aliasLine = ALIAS_LINE.exec(line);
      if (aliasLine) {
        aliases.push(...splitNames(aliasLine[1]));
        continue;
      }
      if (inFormer) {
        const bullet = /^[-*·]\s*(.+)$/.exec(line);
        if (bullet) aliases.push(...splitNames(bullet[1]));
      }
    }

    // 框架先看见的改名：档案还没整理时，别名也不会丢。
    const rec = qq ? ledger[qq] : undefined;
    if (rec?.name) aliases.push(rec.name);
    for (const item of rec?.history ?? []) {
      if (item?.name) aliases.push(item.name);
    }

    return {
      qq,
      name,
      summary,
      firstLine,
      aliases: [...new Set(aliases.map(clean).filter((a) => a && a !== name && a.length >= MIN_ALIAS))],
      // 看法只取最近三条：多了会变成流水账，也会把当前判断淹没。
      views: views.slice(-3),
      file: `people/${file}`,
      uidInLine,
      uidInFile,
    };
  }

  all(): PersonRecord[] {
    this.ensure();
    return this.records;
  }

  byQqNumber(qq: string): PersonRecord | null {
    this.ensure();
    return this.byQq.get(qq) ?? null;
  }

  /** 当前称呼；档案里没有就返回空串——不编名字。 */
  displayOf(qq: string): string {
    this.ensure();
    return this.namesOf(qq)?.current ?? '';
  }

  /** 写入记忆前调用：把人名换成 `@<QQ号>`。 */
  canonicalize(text: string): string {
    if (!text) return text;
    this.ensure();
    const candidates = this.canonicalCandidates();
    if (candidates.length === 0) return text;
    let out = text;
    for (const item of candidates) {
      if (!out.includes(item.name)) continue;
      out = replaceToken(out, item.name, `${MARK}${item.qq}${MARK}`);
    }
    // `@小橘` 这种带 @ 的旧写法会留下一个孤零零的 @。
    out = out.replace(new RegExp(`@${MARK}`, 'g'), MARK);
    return out.replace(MARKED, (_m, qq: string) => `@${qq}`);
  }

  /** 读出来给模型看之前调用：`@<号>` 与旧名都换成当前称呼。 */
  render(text: string): string {
    if (!text) return text;
    this.ensure();
    let out = text.replace(PLACEHOLDER, (m, qq: string) => this.namesOf(qq)?.current || m);
    for (const item of this.legacyCandidates()) {
      if (out.includes(item.name)) out = replaceToken(out, item.name, item.current);
    }
    return out;
  }

  /** 供 FTS：被引用的人的全部称呼，改名之后旧查询词仍然命中。 */
  expand(text: string): string {
    if (!text.includes('@')) return '';
    this.ensure();
    const extra: string[] = [];
    for (const match of text.matchAll(PLACEHOLDER)) {
      const who = this.namesOf(match[1]);
      if (!who) continue;
      extra.push(who.current, ...who.aliases);
    }
    return extra.length ? [...new Set(extra)].join(' ') : '';
  }

  /**
   * 查询期的人名扩展。
   *
   * 索引里的词元是**写入那一刻**的别名集合：一条写着「小橘」的记忆，词元里不会
   * 有「橘子精」。人改名之后，用新名字去搜就断了。这里在检索前把正文里出现的
   * 任何称呼补成这个人的全部称呼，把新名字接回旧记忆。
   */
  queryTerms(text: string): string {
    if (!text) return text;
    this.ensure();
    const extra: string[] = [];
    for (const [name, owners] of this.byAlias) {
      if (owners.length !== 1 || name.length < MIN_ALIAS) continue;
      if (!text.includes(name)) continue;
      const who = this.namesOf(owners[0]);
      if (!who) continue;
      extra.push(who.current, ...who.aliases);
    }
    return extra.length ? `${text} ${[...new Set(extra)].join(' ')}` : text;
  }

  /** 名册末尾的 ⚠ 行：同一号多档、文件名与首行的号不一致。 */
  warnings(): string[] {
    this.ensure();
    const out: string[] = [];
    const byUid = new Map<string, string[]>();
    for (const record of this.records) {
      if (!record.uidInLine) continue;
      const owners = byUid.get(record.uidInLine) ?? [];
      owners.push(record.file.split('/').pop() ?? record.file);
      byUid.set(record.uidInLine, owners);
    }
    for (const [uid, owners] of byUid) {
      if (owners.length > 1) {
        out.push(`⚠ QQ ${uid} 有多份档案，必须合并成 qq-${uid}.md：${owners.join('、')}`);
      }
    }
    for (const record of this.records) {
      if (record.uidInFile && record.uidInLine && record.uidInFile !== record.uidInLine) {
        out.push(`⚠ ${record.file.split('/').pop()} 的首行写的是 QQ ${record.uidInLine}，文件名是 ${record.uidInFile}；以首行为准，改文件名`);
      }
    }
    return out;
  }

  /** 可替换的人名：唯一归属、不自指、不是她自己的称呼。长的先换。 */
  private canonicalCandidates(): AliasEntry[] {
    const out: AliasEntry[] = [];
    for (const [name, owners] of this.byAlias) {
      if (owners.length !== 1) {
        // 重名不替换：宁可留旧名让人看懂，也不能张冠李戴。
        if (owners.length > 1 && !this.warnedAmbiguous.has(name)) {
          this.warnedAmbiguous.add(name);
          this.warn?.('称呼有歧义，记忆里不替换', { name, owners });
        }
        continue;
      }
      if (name.length < MIN_ALIAS || this.selfNames.has(name)) continue;
      out.push({ name, qq: owners[0] });
    }
    return out.sort((a, b) => b.name.length - a.name.length);
  }

  /**
   * 存量自愈用的旧名 → 当前名。
   * 只换唯一归属、且不与任何人的当前称呼冲突的名字；
   * 否则「小橘」改「橘子精」之后，另一位的现用名「小橘子」会被咬掉一截。
   */
  private legacyCandidates(): Array<{ name: string; current: string }> {
    // 档案与台账合成一份：没有档案的人，旧名同样要能接回他们的当前称呼。
    const all: Array<{ current: string; aliases: string[] }> = [
      ...[...this.byQq.values()].map((r) => ({ current: r.name, aliases: r.aliases })),
      ...[...this.ledgerNames].map(([qq, current]) => ({ current, aliases: this.ledgerHistory.get(qq) ?? [] })),
    ];
    const currentNames = all.map((r) => r.current);
    const out: Array<{ name: string; current: string }> = [];
    for (const record of all) {
      for (const alias of record.aliases) {
        if (alias.length < MIN_ALIAS) continue;
        if ((this.byAlias.get(alias)?.length ?? 0) !== 1) continue;
        if (this.selfNames.has(alias)) continue;
        if (currentNames.some((name) => name !== record.current && name.includes(alias))) continue;
        out.push({ name: alias, current: record.current });
      }
    }
    return out.sort((a, b) => b.name.length - a.name.length);
  }
}

/** 替换一个名字：拉丁名要词边界，中文名直接换。 */
function replaceToken(text: string, needle: string, token: string): string {
  if (/^[A-Za-z0-9]+$/.test(needle)) {
    return text.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(needle)}(?![A-Za-z0-9])`, 'gi'), token);
  }
  return text.split(needle).join(token);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去掉装饰符号与首尾空白；全角括号里的说明保留在别名里没意义，一并去掉。 */
function clean(text: string): string {
  return text
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/^[\s\-*#·]+/, '')
    .replace(/[。；;，,、\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitNames(text: string): string[] {
  return text
    .split(/[、，,／/|]+/)
    .map(clean)
    .filter((name) => name.length >= MIN_ALIAS);
}
