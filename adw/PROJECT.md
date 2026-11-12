# PROJECT.md — Cortico 魔改项目认知

> 这份文档记录我们对 Cortico 的真实理解，用来指导二次开发。写进来的结论都经过源码核对或在运行实例上验证过；`path:line` 指向 `C:\Cortico\Cortico-main` 下的文件。
>
> 进度见 [PROGRESS.md](PROGRESS.md)，跨会话记忆见 [MEMORIES.md](MEMORIES.md)。

---

## 0. 项目目标

把一个 AstrBot 时代的文字人格（Claude娘 · 琥珀协议 v2）迁移到 Cortico，并做深度魔改：人格、世界观、关系、记忆长期一致，而不是"一群规则加一段提示词"。

当前是第 1 阶段：跑通部署与 QQ 接入，识别出人格遵循度的真实问题，完成架构调研。

---

## 0.1 三小只：三份部署，一起维护

2026-11-07 起，这个项目同时跑三个人格，不是只有琥珀。三份用同一个代码包 `amber`，配置文件与 Memory 工作区各自独立。

| 部署 | 人格 | WebUI | OneBot | QQ | NapCat 容器 |
|---|---|---|---|---|---|
| `amber` | Claude娘 · 琥珀协议 | 7790 | 3001 | 3929446263 | `napcat-cortico` |
| `bailong` | GPT娘 · 白龙协议 | 7791 | 3002 | 3199133998 | `napcat-bailong` |
| `jingyu` | DeepSeek娘 · 鲸鱼协议 | 7792 | 3003 | 3823943205 | `napcat-jingyu` |

**维护规则：跨人格的改动三份一起做。** 配置以 `amber` 为基线，允许的差异只有 `displayName`、`web.port`、`worlds.qq.wsUrl`/`token`，以及 `creative.enabled`（白龙与鲸鱼关闭）。新增配置项、升级代码包、改提示词机制、做备份，都要覆盖三份并分别给出证据——只修琥珀会让三份越走越远。

人格内容各写各的：`deployments/<名>/memory/` 下的 `CONSTITUTION.md`（宪法）与 `WORLDVIEW.md`（世界观）。启动用 `C:\Cortico\start_project.bat`，经 `start_all.mjs` 在一个窗口拉起三份，日志按 `[琥珀]`/`[白龙]`/`[鲸鱼]` 前缀区分。

---

## 1. Cortico 是什么

**基于事件流的 Agent Harness。** 不是问答式聊天 Bot 框架，不是预设的人格/记忆方案，也不是编码 Agent（`PHILOSOPHY.md:3-10`）。

适用于人格 Bot、AI 主播、角色扮演、聊天陪伴。核心特征：自主响应、持续运行、混合实时输入。

### 1.1 四层

| 层 | 职责 | 位置 |
|---|---|---|
| **Core** | session、事件流、模型调用生命周期、投递、调度、交接、工具派发、容量、错误隔离、Provider。**不生成任何语义内容。** | `src/core/`、`src/bot.ts`、`src/world.ts` |
| **Persona** | 上下文构造、session 声明、认知流程、内部提示、交接策略、Memory 的解释与操作协议、Memory 工具 | `bots/<名>/persona/` |
| **Memory** | Bot 内部持久化状态的唯一权威载体；形式自由（文件、数据库、对象存储） | `<部署>/workspace/` 等 |
| **World** | 与一个外部环境的唯一边界：事件输入 + 工具输出 + 环境提示词 | `src/worlds/<id>/` 或扩展包 |
| **Bot** | 装配定义：选 Persona、声明 World、给默认配置 | `bots/<名>/index.ts` |

### 1.2 设计原则（`PHILOSOPHY.md:37-48`）

1. **面向未来设计**：不为当前模型的能力缺陷固化系统；妥协机制只能是 fallback。
2. **最小先验干预**：机制层尽量不干涉模型的行为，例外要显式声明。
3. **诚实的认知论**：基础设施只陈述可确认的事实，事件与回执可还原为可验证事实。

人格 Bot 的两条审美：

1. **Memory 即人格**：主体性与连续性由 Memory 数据完全定义；换模型、交接、重启都不改变个体身份。
2. **主动性与自由优先**：默认不行为；约束优先用上下文语义，而不是机械阻拦（硬安全边界、权限、不可逆副作用除外）。

### 1.3 对我们的含义

- 人格不是一段系统提示词。**人格 = Persona 的运转方式 + Memory 的内容 + World 的交互契约。**
- 把 41k 字的 AstrBot 提示词原样塞回前缀，等于放弃 Cortico 的全部价值。
- 正确的魔改是把角色的自我认知放进 Memory，把语境组织交给 Persona，把平台行为交给 World。

---

## 2. 运行时全景

### 2.1 启动链路

```
bin/cortico.mjs
  → 检查 Node 22+/pnpm；缺依赖则 install；WebUI 产物落后则 build
  → src/launcher.ts：读 deployment.json → 加载 BotDefinition + World + 扩展
  → loadDeployment()：四层配置合并
  → createBot()：WorldAssembly → build() → Core → WebApp
  → 若 startsPaused()：先停总线
  → bot.start()：实例锁 → WebUI → provider → onStart → core.start()
```

- `pnpm start` 默认 `CORTICO_START_PAUSED=1`，首批事件只落库排队（`bin/cortico.mjs:244`、`src/launcher.ts:224`）。
- 崩溃不会自动重启；只有显式重启请求（IPC 或 `data/.restart-request`）才重新拉起（`bin/cortico.mjs:267`）。

### 2.2 事件流

1. World 通过 `WorldHost.pushEvent` / `pushDeferred` / `pushCandidate` 报事件。
2. `pushEvent` 立即落事件库（`data/runs/<run>/events.jsonl`），分配全局单调 `cursor`；二进制进 `data/media/`，正文附 `[blob ...]` 行。
3. 可见 World 的事件进 `WakeBus`；隐藏 World 的事件以 `archive-only` 落库、推进水位、不投递。
4. 总线按 debounce 合批：`at = min(firstAt + maxBatchAge, max(firstAt + minBatchAge, lastAt + quietGap))`。
5. 一批被取走后渲染进 `session-main.jsonl`，然后进入模型循环。
6. 水位只推进**连续前缀**（`src/core/loop.ts:867`）；重启时水位之后的未投递事件会被补投（上限 200 条，`loop.ts:908`）。

### 2.3 暂停、闸门与触发

- **操作者暂停**优先级最高：事件照常落库入队，不投递；恢复时积压一次性投递。
- **Persona DeliveryGate**：按 id 安装，只约束安装后到达的项；有关键词放行、溢出放行、`bypassGateOnce`（只对当前批有效）。
- 触发模式：`preempt`（取消未外化的轮）、`interrupt`（保留已外化输出）、`flush`、`debounce`、`piggyback`。

### 2.4 模型循环与工具

- 每轮：`outboundMessages()` = system 前缀 + `sessionHead()` + 持久历史 → `responseRequest()` → `llm.respond()`。
- 工具表由 `SessionDecl.tools()` 决定，**Persona 自己合并** Persona 工具与 World 工具；Core 只做过名字过滤、隐藏 World 过滤、去重。
- `ToolDef.tags`（`read/write/speak/act/flow/snapshot`）不发给模型，只用于交接笔记与 fork。
- `barrierAfter`：同一条 assistant 输出里排在后面的调用不执行，拿到 `[not executed ...]` 回执。
- `endsTurn`：真正执行后结束本次唤醒。
- 工具回执与 assistant 文本都写入 session，下一轮原样回放。

### 2.5 assistant 文本的地位（关键）

**Core 从不投递 assistant 文本。** 它只写入 session 与 transcript。

对外发言只有两条路：

1. 带 `speak` 标签的 World 工具（QQ：`qq_draft → qq_confirm`；控制台：`console_send`）。
2. `outputTap`：World 旁路流式增量做字幕/演出；**QQ 没有实现**。

这就是"后台有输出、群里看不到"的全部原因。

### 2.6 上下文与交接

三层阈值，不要混：

| 层 | 归属 | 行为 |
|---|---|---|
| 轮数 `soft/hard` | Persona `rounds()` | soft 追加提示；hard 结束本轮 |
| 阶段预算 `maxTokens × softRatio` | Persona `ContextStagePolicy` | 超软阈值先提醒一轮，下一批仍超才请求交接 |
| 物理上限 `hardTokens` | Core | 窗口 − 最大输出；越线强制交接、机械裁剪 |

交接（`performHandoff`，`src/core/loop.ts:1670`）：

1. 取快照（含 system 与 sessionHead）。
2. `persona.onHandoff(snapshot, {hardTokens})` 返回 `{tail, trim?}`。
3. 重建 system；`clampTail` 修复工具配对并按预算裁剪。
4. `session.reset([system, ...tail])`；通知 World `onHandoffEnded()`。

`schema-head`：`sessionHead()` 每次请求现取，插在 system 之后、历史之前，**不落盘、不进入交接 tail**，但计入 `hardTokens`。

### 2.7 持久化

| 文件 | 作用 |
|---|---|
| `data/session-main.jsonl` | 主 session 上下文，追加式；reset 原子重写 |
| `data/runs/<run>/events.jsonl` | 事件库；cursor 全局单调 |
| `data/runs/<run>/transcript.jsonl` | session 的只追加副本 + 边界记录 |
| `data/runs/<run>/toolcalls.jsonl` | 每次工具调用 |
| `data/runs/<run>/log.jsonl` | 运行日志 |
| `data/usage.jsonl` | 模型用量 |
| `data/core-state.json` | 水位、上次交接、Persona 状态、World 可见性 |
| `data/timers.json` | 持久定时器 |
| `data/instance.lock` | 单实例锁 |
| `data/media/` | `log:` 附件 |

**唤醒日志（amber 实现）**：`data/wakes.jsonl`，一次唤醒一条，记录 `reason`（mention/name/thread/ambient/internal）、进入上下文的事件、前缀字符数与 hash、实际带上的语气卡、工具调用与发送结果、`outcome` 与耗时。写入在 `bots/amber/persona/index.ts` 的 `onDelivery` / `onTurnEnded`；唤醒原因由 QQ World 写在事件 `meta.wake`。查看：`pnpm wakeq --bot <部署> [--last N] [--reason name] [--json]`。WebUI 的 `persona:amber` 页有「唤醒与线索」与「语气卡」两个管理面板。

### 2.8 配置分层与热更新

合并顺序：Core 默认 → bot 默认 → 包内 `worlds/<id>/config.json` → 共享 `providers/<名>/config.json` → 部署 `config.json`。

热生效：`batching`、`logging`、`activeProvider` / `providers.*.spec`、`keepPastThinking`、Persona 的 `rounds/tools/context`、World 的 `ctx.cfg`。

需要重启：`web.host/port`、`paths`、`language`、`timezone`、World 构造期缓存的连接/进程。

---

## 3. Persona 层

### 3.1 契约

必填：`systemSegments`、`memoryDir`、`blobs`、`attach`、`declareSessions`（**恰好一个**同时 `receivesEvents` 和 `persistent`）。

可选钩子：

| 钩子 | 时机 | 用途 |
|---|---|---|
| `onOpening({reason})` | new / restarted / cleared | 开场注入 |
| `onDelivery({events})` | 一批已渲染、未进上下文 | 可异步；期间的 `injectInternal` 进入本批 |
| `onBatchEnd()` | 一批结束 | 容量判断、请求交接 |
| `onTurnEnded()` | 一轮结束 | 清理暂态 |
| `onIdle()` | 空闲 | 提交、整理 |
| `onStallsRecovered()` | 连续失败恢复 | 回一句话或 null |
| `onWorldLifecycle()` | World 变化 | 注入通知 |
| `sessionHead()` | 每次请求 | 风格锚（不落盘） |
| `onHandoff(snapshot,{hardTokens})` | 交接 | 返回 tail |
| `cognition` | World 请求 | 后台构思 |
| `webUi()` | WebUI | 面板与可编辑提示词 |

### 3.2 前缀组装

`PREFIX.md` 占位符顺序即排版顺序。Cormini：

```
{{persona.orientation}}   ← ORIENTATION.md（部署可覆盖 prompts/ORIENTATION.md）
{{persona.constitution}}  ← workspace/CONSTITUTION.md（Bot 可改）
{{persona.partner}}       ← 基类空；CortiV 用 PHANT.md
{{worlds.envPrompts}}     ← 每个 World 一段，按 id 排序
{{persona.memoryNote}}    ← 基类空
{{persona.workspace}}     ← 工作区文件清单
```

模板语法只有两种：`{{name}}` 与 `{{name | fallback}}`；未声明的占位符原样保留。

WebUI 提示词页支持：`GET /api/prompts`、`GET /api/prompts/prefix`、`POST /api/prompts`（带 revision 冲突检测）、`POST /api/prompts/reset`、`POST /api/session/reload-prefix`。

### 3.3 三个参考 Bot

| | cormini | corti-soulmate | cortiv |
|---|---|---|---|
| 定位 | 最小完整实现 | 长期陪伴 QQ 角色 | AI VTuber |
| Memory | 工作区文件 | MEMORY 0–4 分层 | 工作区 + 观众档案 |
| session | 1 | 主 + dream | 主 + dream + cognition |
| 宪法 | 自己可改 | **只有梦可改** | 不可改 |
| 默认 World | console | qq / console / websearch | console / vtuber / bilibili / … |

官方口径：行为变体继承 Cormini；**改记忆结构或 session 形态就复制整个目录**（`docs/personas.md:88-92`）。

---

## 4. Memory 层

### 4.1 Cormini 的工作区记忆

- 根 = `memoryDir`；首次 seed `CONSTITUTION.md`。
- 文件工具：`read_file` / `write_file` / `edit_file` / `append_file` / `delete_file` / `list_files` / `glob_files` / `grep_files`。
- 前缀只列文件清单；每目录超过 10 项折叠；`handoffs/`、`blobs/` 永远折叠。
- 交接时把最近一段写成 `handoffs/<时间戳>.md`，新 session 只带前缀 + 醒来句 + 交接笔记。

### 4.2 Soulmate 的分层记忆

| 层 | 内容 | 写入方 |
|---|---|---|
| MEMORY 0 地图 | 目录树 + playbook 名 + 最近图片 | 文件系统 |
| MEMORY 1 认知 | `WORLDVIEW.md` + `people/` 花名册 | 梦写 WORLDVIEW；人写 people |
| MEMORY 2 备忘 | `memo/` 常驻全文 + `active/` 文件名 + `archived/` 计数 | 主意识，容量硬拦 |
| MEMORY 3 反射 | 最近 3 缕梦的浮现 | 梦 `surface()` |
| MEMORY 4 当下 | 时间/时区 | 现算 |

写权限矩阵（`permissions.ts`）：

| 区域 | 主意识 | 梦 |
|---|---|---|
| `note/` `memo/` 自建目录 | 读写改名，不能删 | 全权 |
| `people/` | 读 + 追加 | 读写改名 |
| `WORLDVIEW.md` | 只读 | 读写 |
| `CONSTITUTION.md` | 只读 | 改内容 |

交接后「梦」fork 一个自己：整理笔记、维护 WORLDVIEW 与 people、审视并修订宪法，必要时 `surface()` 回主线。

### 4.3 对我们的含义

- **世界观**（AI 娘元宇宙、角色关系、群内梗）→ `WORLDVIEW.md` / `people/` / `note/playbook/`。
- **外号映射** → 不是硬编码列表，而是 `people/` 档案 + playbook 的"未知称呼怎么处理"流程 + 梦的归纳。
- **语气样本** → `sessionHead`（常驻、不落盘）比塞进宪法更合适。

---

## 5. World 层

### 5.1 契约

`WorldDefinition`（`src/world.ts:50`）：`id`、`label`、`defaults()`、`create(ctx)`，可选 `preflight` / `configOptions` / `describe`。

`World` 实例（`src/core/types.ts:903`）：

| 成员 | 必需 | 含义 |
|---|---|---|
| `id` | 是 | 同时用于 `worlds.<id>` 与 WebUI 页 `world:<id>` |
| `envPromptVars()` | 是 | 环境模板变量；返回 `null` 省略整段；每次前缀重建都调用 |
| `tools()` | 是 | 暴露给模型的工具 |
| `start(host)` / `stop()` | 是 | 挂载与卸载 |
| `webUi(language)` | 否 | 面板、lamps、badges、promptDocs |
| `outputTap()` | 否 | 主 session 输出流（字幕/演出）；**QQ 未实现** |
| `onHandoffEnded` / `onTurnEnded` / `onEventsSettled` / `onRunPhase` | 否 | 生命周期通知 |
| `shutdownVerification` | 否 | 关机前外部状态核对 |

环境提示词三层覆盖（后层整份替换，替换后仍渲染变量）：

```
src/worlds/<id>/ENV_PROMPT.md
  → <bot 包>/worlds/<id>/ENV_PROMPT.md
  → <部署>/worlds/<id>/ENV_PROMPT.md
```

World 影响前缀的路径只有一条：`ENV_PROMPT.md` + `envPromptVars()` → Persona 模板占位符 → system 前缀。

**不要**在 `envPromptVars()` 里放每轮变化的值（时间、随机数、在线人数），会让前缀缓存整段失效。QQ 特意缓存群名快照就是为了这个。

### 5.2 激活与可见性

- **激活**：`worlds.<id>.enabled`，决定是否挂载；热生效并写回 `config.json`。
- **可见性**：`core.state.worldVisibility[id]`。隐藏后 World 继续运行，但事件只落库（`archive-only`）、工具从前缀与工具表移除，重新显示**不补投**。

### 5.3 QQ World 深挖

| 文件 | 职责 |
|---|---|
| `definition.ts` | 定义、vision/gate 装配、自描述 |
| `world.ts` | 事件、工具、草稿门、面板、图片/语音 |
| `driver.ts` | OneBot v11 正向 WS，重连、echo 关联、扩展动作隔离 |
| `config.ts` | `worlds.qq` 默认值与配置组 |
| `normalize.ts` | 入站渲染 / 出站编译 |
| `history-tools.ts` | `qq_read_history` / `qq_grep_history` |
| `vision.ts` / `vlm.ts` | 辅助视觉 |
| `image-download.ts` | 图片下载与限制 |

**连接**：Core 作为客户端连协议端正向 WS，token 走 `Authorization: Bearer`。失败后指数退避重连（1s → 30s），不 reject 启动。连上后取 `get_login_info`、各群 `get_group_info`、自己在该群的 `card`。

**roster**：`{id, enabled}[]`；关闭项仍持久化但不监听。热更新对进出的每个 id 推 `qq.watch`。

**发言门**（`src/worlds/qq/world.ts:1558` / `:1644`）：

1. `qq_draft`：单槽暂存，`barrierAfter`，不发送。起草期间到达的 QQ 事件会被 drain 出来，在本轮回执后送到模型面前。
2. `qq_confirm`：`send` 才真正调用 `send_group_msg` / `send_private_msg`；失败保留草稿可重试；`cancel` 清空。
3. 回合结束未确认 → 草稿作废。
4. 自己发出的消息回录为 `qq.self`（`deliver:false`），不唤醒自己。

**事件**：`qq.message`（群里 @ 时 `flush`，否则 `debounce`）、`qq.image`、`qq.vision`、`qq.transcript`、`qq.reply.uncaptured`、`qq.forward`、`qq.recall`、`qq.member`、`qq.emoji`、`qq.poke`、`qq.watch`、`qq.self`。

**图片/语音**：有辅助视觉时走 `IMG-N` 占位 + 被动识图；无视觉时按主模型是否接受图片决定保留 URL 还是只显示 `[图片]`。语音按协议端能力尝试 `fetch_ptt_text` / `voice_msg_to_text`。

**降级**：断线重连、身份失败回退、扩展动作 1404 换路、图片下载超时补事件、引用查询失败仍发事件。

**为什么 assistant 正文不投递**：`WorldHost` 没有接收 assistant 文本的方法；QQ 没实现 `outputTap`；唯一出口是 `qq_confirm → sendToTarget()`。这是有意设计——发言必须是一次显式、可复核的工具动作。

**提高"说话自然度"的改动点**（风险从低到高）：

1. 部署 `worlds/qq/ENV_PROMPT.md`——零代码、升级安全。
2. Persona 的 `prompts/` 覆盖（ORIENTATION、CORE）。
3. `qq_draft` 工具描述（代码级，对模型行为约束最直接）。
4. 消息形态与节奏（拆气泡、打字延迟）——改 `confirmTool` / `sendToTarget` / `buildOutgoing`，草稿要从单槽改成队列。
5. 模型参数（temperature / thinking / effort）。
6. 入站渲染格式——不会重写历史，会造成新旧格式混杂。

**不要**用 `outputTap` 把 assistant 正文自动发到 QQ：绕过起草门，可能把内部思考发出去。

### 5.4 其他 World

- `console`：最小 World；`console_send` 发言；PIN 规则；环境段可整份覆盖。
- `websearch`：纯工具 World，无事件。
- `bilibili`：直播事件、归并、Overlay。
- `minecraft`：主进程代理 + 子进程引擎。

---

## 6. Provider / 扩展 / 部署

### 6.1 Provider

- `ProviderModule`：`id`、`title`、`reasoningTiers`、`serviceTiers`、`create()`；可选 `config` / `webUi` / `prices` / `contextOverflow` 等。
- `ProviderInstance`：`client`（实现 `respond`）、`listModels?`、`contextWindow?`。
- 内生实现：`openai-responses-compat`（Responses）、`llamacpp`（Chat Completions）。
- 端点目录：`<部署根>/providers/<端点名>/{config.json,.env}`。密钥优先级：进程环境 > 端点 `.env`。
- 实例缓存键 = 端点条目（去 pricing/spec）+ `.env` 指纹；改密钥后下一次解析重建。

**reasoningReplay**（`src/providers/transport/responses-input.ts`）：

- `encrypted`（默认）：只回传带签名块的 reasoning，且要求来源匹配。
- `plaintext`：把推理文字以 `reasoning_text` 回传；适合要求每个工具轮都带思维链的服务端（DeepSeek thinking 就是）。
- 配错形态会被上游 400。本项目已改成 `plaintext`。

### 6.2 扩展

三种 kind，契约版本：world 6 / provider 6 / bot 7。

```jsonc
{
  "name": "cortico-bot-amber",
  "type": "module",
  "main": "./index.ts",
  "keywords": ["cortico-bot"],
  "cortico": { "kind": "bot", "api": 7, "displayName": "...", "describe": "describe.json" }
}
```

- 扩展目录默认 `<仓库>/extensions/`；`cortico/*` 导入由宿主解析到运行中的框架。
- ESM 不会热替换：安装/卸载后必须重启进程。
- 内建 World/Provider 的 id 被保留；扩展撞名会被拒绝。
- 仓内 `bots/<名>/` 优先于扩展 bot。

`templates/extension/bot/` 是完整骨架：Persona + `PREFIX.md` + `MEMORY.seed.md` + blobs + 测试。

### 6.3 部署与启动器

```
deployments/<name>/
  deployment.json   { "bot": "<包名>" }
  config.json       部署配置
  .env              本部署 World 密钥
  workspace/        Memory（目录名由 Persona 的 paths.memory 决定）
  data/             事件、session、用量、进程状态
  prompts/          Persona 文本覆盖
  worlds/<id>/ENV_PROMPT.md
```

- 部署根：`CORTICO_HOME` > 仓库 `.env` > `<仓库>/deployments/`。
- 启动器负责安装依赖、构建 WebUI、建默认部署、菜单、重启监管。
- `pnpm start` 默认暂停启动；`CORTICO_START_PAUSED=0` 可解除。
- 整进程重启：`POST /api/run/restart`；QQ 接入门保存走的是 **World 级重启**（`ctx.restart`），不是进程重启。

---

## 7. 魔改的三条路

| 路径 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 部署覆盖** | 只改部署里的提示词与配置 | 快、可逆、不碰代码 | 改不了记忆结构与行为 |
| **B. 复制参考 bot** | `bots/corti-soulmate` → 新目录 | 拿到分层记忆、梦、权限矩阵 | 与上游分叉，升级要手工合并 |
| **C. bot 扩展包** | 基于 `templates/extension/bot/` | 与主仓库解耦，可复用、可发布 | 需要自己实现需要的机制 |

**建议：B 起步、C 定型。** 先在 soulmate 骨架上把内容与配置跑通（梦、记忆分区、QQ），验证有效后再把稳定的部分抽成独立扩展包。

---

## 8. 人格遵循度问题的架构解释

1. **压缩**：原人格 41508 字符，常驻约 6000 字；场景与关系不在上下文。
2. **按需文件不读**：EXAMPLES / RELATIONS 不读就等于不存在。
3. **发言是工具参数**：`qq_draft.text` 的语体更功能化。
4. **机制文本稀释**：ORIENTATION、PIN、工作区清单、英文工具 schema。
5. **没有常驻语气锚**：`firstTurn` 默认关闭。
6. **元叙述**：模型会写"我已经把这两条问题都回复了"——Cortico 的机制框架诱导它汇报过程。

对应的原生解法：

- 语气锚 → `sessionHead` + 多张卡。
- 世界观与关系 → `WORLDVIEW.md` / `people/` / playbook。
- 未知称呼 → 通用流程 + 自增长术语表。
- 元叙述 → 明确"群里只有经 speak 工具发出的内容"，并考虑在 ORIENTATION 里禁止状态汇报。
- 机制噪音 → 精简 ORIENTATION，不用 console 就关掉。

---

## 9. 建议架构：Cortico 原生的琥珀协议

### 9.1 目标

人格一致、世界观可生长、外号可自学习、语气稳定，并且不靠堆提示词。

### 9.2 结构

**基座**：复制 `bots/corti-soulmate/` 成新 bot 包（拿到分层记忆、梦、权限矩阵、QQ 声明）。

**Memory 分区**：

| 区域 | 内容 | 写入方 |
|---|---|---|
| `CONSTITUTION.md` | 不可动摇的自我：身份、原则、语言气质 | 梦可修订 |
| `WORLDVIEW.md` | 世界观：AI 娘元宇宙、群文化、长期认知 | 梦维护 |
| `people/` | 群友与 AI 娘档案，含外号与关系 | 主意识追加，梦整理 |
| `note/playbook/` | 术语表、梗、称呼解析流程 | 主意识维护 |
| `note/style/` | 多张语气卡：场景、关系、情绪 | 主意识与操作者维护 |
| `memo/` | 当下：日程、正在关注的事 | 主意识，容量硬拦 |

**前缀**：

- `PREFIX.md`：ORIENTATION + 宪法 + World 环境段 + MEMORY 0–4。
- `sessionHead`：常驻 2–3 张语气卡。注意 `sessionHead` 每次请求现取，内容必须稳定，否则打穿前缀缓存；不要按每轮上下文动态选择。

**World**：`qq` 必开；`console` 视需要，不用就关，省掉 PIN 段与前缀噪音。

**梦提示词**：维护 `WORLDVIEW.md`、`people/`、宪法；只做语义归纳，不写 KV 列表。

### 9.3 未知称呼的通用流程

这是"龙娘"类问题的正解，写进 playbook 而不是我枚举：

1. 看 `people/` 与 `note/playbook/` 有没有这个称呼。
2. `qq_grep_history` 查群史。
3. 结合当前语境推断它指谁。
4. 仍不确定，用角色语气问一句（"你说的是 DeepSeek 那位？"），不要用客服腔说"没听说过"。
5. 学到之后写进 `people/` 或 playbook；梦在交接后整理。

### 9.4 分阶段

| 阶段 | 内容 | 能否单独验收 |
|---|---|---|
| 1 | 复制 soulmate，改 id/端口/World 声明，内容层换成琥珀协议 | 能：QQ 能跑通 |
| 2 | 配置记忆分区与容量，跑一轮交接 + 梦 | 能：梦产出 WORLDVIEW 条目 |
| 3 | 语气卡进 `sessionHead`，对比遵循度 | 能：回复风格稳定 |
| 4 | 调整梦提示词与权限矩阵 | 能：宪法/世界观按规则修订 |
| 5 | 代码级增强：多气泡、术语表工具、发送节奏 | 能：群内观感明显变化 |

### 9.5 为什么这能"一劳永逸"

- 新外号由 `people/` 与 playbook 吸收，不依赖我预先枚举。
- 世界观由梦归纳，不依赖一次性写完。
- 语气由常驻卡片锚定，不依赖每轮长提示。
- 人格由 Memory 承载，换模型、交接、重启都不改变个体身份。

---

## 10. 风险清单

1. 不要改 `MainLoop` 的轮次/工具配对/水位顺序——会破坏"重启不重放、不丢事件"。
2. 不要动 `external_event_frame` 保留帧。
3. system 前缀与工具表必须同步重建。
4. `sessionHead` 内容要稳定，否则打穿前缀缓存。
5. 工具名全局唯一；隐藏 World 的工具按名字过滤。
6. 交接 tail 必须保持工具调用/回执配对。
7. `paused` 必须优先于 DeliveryGate。
8. `session-main.jsonl` / `core-state.json` / `timers.json` / `usage.jsonl` 是跨重启契约，改字段要迁移。
9. 关机顺序：pause → core.stop → World.stop → flush → WebUI。
10. 热改依赖共享 config 对象；整体替换会让持有旧引用的模块失联。

---

## 11. 关键索引

- 设计哲学：`PHILOSOPHY.md`；仓库规则：`AGENTS.md`
- Persona 契约：`src/core/types.ts:994`
- 前缀组装：`src/core/prefix.ts:90-121`、`src/core/loop.ts:511-553`
- 主循环：`src/core/loop.ts:1011`；交接：`loop.ts:1670`
- 事件总线：`src/core/bus.ts:33`
- 工具：`src/core/types.ts:261`；执行：`src/core/loop.ts:1371`
- Cormini：`bots/cormini/persona/persona.ts`
- Soulmate：`bots/corti-soulmate/persona/`（`permissions.ts`、`MEMORY.md`、`subconscious/`）
- QQ：`src/worlds/qq/world.ts:1558`（draft）、`:1644`（confirm）
- bot 扩展模板：`templates/extension/bot/`
- 文档：`docs/personas.md`、`docs/sessions.md`、`docs/worlds.md`、`docs/deployment.md`
