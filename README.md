<p align="center">
  <img src="assets/cortico-banner.svg" alt="Cortico" width="640">
</p>

<h1 align="center">Cortico-ADW</h1>

<p align="center">
  <strong>Amber · Dragon · Whale</strong><br>
  三个数字人格，一套行为规则，在真实 QQ 群里连续运行的二次开发分支
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-00A870"></a>
  <img alt="Node ≥ 22" src="https://img.shields.io/badge/node-%E2%89%A5%2022-00A870">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6">
  <img alt="status" src="https://img.shields.io/badge/status-research%20preview-8A8496">
</p>

---

## 这是什么

Cortico-ADW 是 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 的一个二次开发分支。Cortico 是一个围绕事件流设计的 Agent Harness，用于长期运行、混合实时输入的人格 Bot——它不是问答机器人框架，也不预设「人格」应该怎么写。

这个分支把同一套引擎推到极限：**三个人格、三份部署、同一个 QQ 群、连续运行二十天**。

| 代号 | 人格 | 原型 | 协议 |
|---|---|---|---|
| **A**mber | 琥珀 | Claude 娘 | [琥珀协议 v3](adw/琥珀协议v3.md) |
| **D**ragon | 白龙 | GPT 娘 | [白龙协议 v2](adw/白龙协议v2.md) |
| **W**hale | 鲸鱼 | DeepSeek 娘 | [鲸鱼协议 v2](adw/鲸鱼协议v2.md) |

三个人格共用代码包 [`bots/amber`](bots/amber/)，配置、Memory 与运行数据各自独立。她们住同一套三居室，彼此有亲疏、有竞争、有照应——关系不是写死的设定，而是运行中长出来的状态。

上线 20 天的量级：约 1.8 万条群聊事件、2,700 次对话触发。这些数字来自部署日志，仓库里没有附带原始聊天数据（见[数据与隐私](#数据与隐私)）。

## 和上游有什么不同

上游提供骨架：事件流、会话、World、Provider、WebUI。ADW 补的是**「她为什么像个人」**那一层。完整的改动清单与每条的理由在 [adw/MODS.md](adw/MODS.md)，按主题可以概括成六块。

### 1. 状态驱动的行为，而不是文案驱动的表演

角色有**电量、负荷、好感、信任、边界**五项状态，由聊天频率与内容驱动，不是提示词里写一句「你会累」。

- 电量从事件里长出来（M37）；低电量直接接进投递层：回复变短、慢半拍、不追问（M39）；被认真接住会回血（M79）。
- 好感度**全群总量守恒**，角色只能真正在意少数几个人。按每天约 90 次互动校准，认识→熟悉约 23 天、熟悉→在意约 52 天、在意→重要约 80 天（M84）。
- 信任与边界决定哪些话能说、哪些请求不接；没说完的话会变成「欠着的」，压在后续每轮开头（M40、M91–M93）。
- 她有自己的作息、日程、地点与当前活动（M34、M41、M116–M118）——日程是默认，不是规章，任何时间点都能被打断。

### 2. 什么时候不说话，和什么时候说话一样重要

- 没被叫到、电量低、关系不到位，都可以不主动开口（M28、M69、M90）。
- 纯附和、纯表情、没配字的图不叫醒模型（M47、M73）。
- 对话线索有保鲜期；线索开着，不代表每句都是对她说的（M95–M98）。
- 「答完不等于说完」和「话答完就落地」是两条相反的指令，机制上分开处理（M104）。
- 两拍原则：先接住，再刺一句，**说完就停**（M70）。

### 3. Memory 是人格的载体

- 分层 Memory：宪法、世界观、人物档案、日记、笔记、备忘、交接。索引 + 衰减 + 休眠 + 自动注入（M19、M20）。
- 语义召回与 BM25 混合排序；候选池、近重复、向量分归一化都单独处理过（M21、M56、M58）。
- 用过的旧事按结局重新固化重要性（M38）；人物档案是档案，不是编年史（M83）。
- 交接后的「梦」在后台整理记忆；梦只吃增量事件，不继承整段会话（M32、M60、M62、M81、M88）。

### 4. QQ 是一个真实环境，不是一条消息管道

- 身份键是 QQ 号，昵称只是属性；改名之后仍认得出人（M17、M27、M65）。
- 名字唤醒、前缀与笔误（M7）；非唤醒消息只归档（M8）；离线补拉与重启补投（M18、M18b）。
- 分条说话、等半拍、空格闸、标点不收尾（M10、M66–M68）。
- 图片、表情、转发记录里的图、晚到的图，各有一套处理（M49、M73、M108、M109、M113）。
- WebSearch 从内置实现换到 Tavily（M110）。

### 5. 上下文与成本

- 常驻前缀从 19.5k 字压到 10,408 字，人格质感不丢（M46）。
- 上下文越过两倍预算立即交接，并把现场留进日志（M74）。
- 附件与运行日志按月份保留半年（M107）。

### 6. 观测手段，而不是目标

WebUI 上有唤醒与线索、语气卡、长期记忆、陪伴与状态四块面板（M13、M13b、M22、M30）。判断一切改动的标准只有一句：**她变好了吗**——不是管理员方便了吗。

## 快速开始

需要 Node 22+ 和 pnpm（仓库声明 `pnpm@11.28.6`）。

```bash
corepack pnpm install

cp -r deployments/example deployments/amber
pnpm start amber
```

WebUI 默认在 `http://127.0.0.1:7790/`。首次启动后：

1. 在 WebUI 里填模型端点（Base URL、模型名、API Key）。
2. 编辑 `deployments/amber/memory/CONSTITUTION.md` 与 `WORLDVIEW.md`，写你自己的角色。
3. 需要接 QQ 时，填 NapCat / OneBot 的 WebSocket 地址与 access token，把 `groups` 改成你的群号。

不建部署直接 `pnpm start` 也可以：空部署根会自动创建一份 `mybot`（参考 Persona `cormini`），从控制台对话开始。

```bash
pnpm bots          # 列出部署
pnpm start --new   # 交互式新建一份部署
pnpm test          # 单元与集成测试
pnpm typecheck
```

更细的配置见 [docs/deployment.md](docs/deployment.md)、[docs/configuration.md](docs/configuration.md) 与 [docs/providers.md](docs/providers.md)。

## 仓库结构

```
src/          Core：事件流、会话、调度、Provider、WebUI、内置 World
bots/         代码包
  amber/        三个人格的 Persona（CortiSoulmate 的定制）
  cormini/      上游参考 Persona
  cortiv/       另一个参考 Persona（含 VTuber 相关）
  corti-soulmate/
apps/         附属应用（household 多部署管理）
docs/         框架文档
adw/          ADW 的协议与设计记录
deployments/  部署目录（仓库只保留脱敏后的 example）
tests/        测试
scripts/      构建、发布审计、日志查询等脚本
```

Cortico 的五层职责划分没有变：

| 层 | 职责 | 位置 |
|---|---|---|
| **Core** | 会话生命周期、事件流、模型调用、投递与调度。不生成语义内容。 | `src/core/`、`src/bot.ts`、`src/world.ts` |
| **Persona** | 上下文构造、认知流程、Memory 协议、交接策略。 | `bots/<名>/persona/` |
| **Memory** | 内部持久化状态的权威载体。 | `<部署>/memory/` |
| **World** | 与一个外部环境的边界：事件输入、工具输出、环境提示词。 | `src/worlds/<id>/` 或扩展包 |
| **Bot** | 装配定义：把 Persona 与一组 World 绑定。 | `bots/<id>/index.ts` |

## ADW 文档

| 文档 | 内容 |
|---|---|
| [adw/琥珀协议v3.md](adw/琥珀协议v3.md) | Claude 娘 · 琥珀：身份、性格、关系、说话方式 |
| [adw/白龙协议v2.md](adw/白龙协议v2.md) | GPT 娘 · 白龙 |
| [adw/鲸鱼协议v2.md](adw/鲸鱼协议v2.md) | DeepSeek 娘 · 鲸鱼 |
| [adw/MODS.md](adw/MODS.md) | 全部改动：概念、理由、实现位置、怎么验 |
| [adw/PROJECT.md](adw/PROJECT.md) | 对 Cortico 架构的二次开发认知 |
| [adw/PERSONA_TESTS.md](adw/PERSONA_TESTS.md) | 60+ 场景的人格验收标准（语气 / 长度 / 边界 / 接话） |
| [adw/COMPANION-7.0.0.md](adw/COMPANION-7.0.0.md) | 「我会永远陪着你」的拆解与融合对照 |

框架本身的能力与扩展方式，看 [docs/](docs/) 与上游的 [PHILOSOPHY.md](PHILOSOPHY.md)。

## 数据与隐私

本仓库**不包含**三个人格的运行数据：聊天记录、图片、事件日志、会话、记忆数据库与索引（约 3.4 GB）。原因有两个——仓库要能正常 clone，以及群友的聊天内容不该因为开源而被公开。

因此：

- `deployments/` 下只有 `example/`，一份脱敏后的配置模板。
- 协议文档是角色设定，不是聊天导出；其中保留真实运行时的 QQ 号与群号，用来标注「这份设定当时跑在哪」。
- 想复现运行状态，请用自己的账号、群和模型端点，不要直接沿用文档里的号码。

如果你要 fork 这个项目，注意：`deployments/*/secrets.local.json`、`deployments/*/.env`、`deployments/providers/*/.env` 和运行数据都已在 `.gitignore` 里。

## 现状与边界

- 这是一个**研究性分支**，不是生产级产品；API、配置项与 Memory 结构都可能随实验变化。
- 只保证在上游 0.2.6 的代码基础上能跑；上游后续版本可能产生合并冲突。
- 三个角色的行为调校依赖真实群聊反馈，仓库里的参数只是其中一个可用的起点。
- 本项目与 Pal AI Lab 无关；Cortico 的版权与设计归上游所有。

## License

MIT。原始版权归 [Phantivia / Pal AI Lab](https://github.com/Pal-AI-Lab/Cortico)；ADW 的修改部分归本仓库作者。见 [LICENSE](LICENSE)。

---

<details>
<summary>English summary</summary>

**Cortico-ADW** is a fork of [Cortico](https://github.com/Pal-AI-Lab/Cortico) built around three long-running digital personas — Amber (Claude), Dragon (GPT) and Whale (DeepSeek) — living in one real QQ group. It adds an event-driven internal state system (energy, load, affinity, trust, boundaries), initiative and silence rules, layered memory with decay and semantic recall, a QQ world tuned for real group chat, and a companion WebUI. All three share one persona code package and one rule set; only their configs and memories differ. Runtime data is intentionally excluded. MIT licensed; upstream copyright belongs to Pal AI Lab.

</details>
