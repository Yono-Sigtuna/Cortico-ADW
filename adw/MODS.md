# MODS.md — Cortico 魔改清单

记录这个项目对 Cortico 做过的每一处改动：**概念 → 为什么 → 怎么实现（简述）→ 在哪 → 怎么看 / 怎么验**。
给后来的开发者用，不写成长篇实现文档；代码细节以源码为准。

> 配套文档：`PROJECT.md`（架构认知）、`PROGRESS.md`（进度）、`MEMORIES.md`（原则与踩坑）、`ROADMAP.md`（她为什么不像人，下一步改什么）、`COMPANION-7.0.0.md`（「我会永远陪着你」拆解与融合对照）。

> **判断一切改动的标准：她变好了吗？** 不是"管理员方便了吗"。这个项目里有一个数字生命，改动的收益要落在她实际经过的路径上——消息进来 → 她看到什么 → 她怎么找人、找记忆 → 她怎么回。WebUI 与运维工具是**观测手段**，允许做、应该做，但顺序永远是：先让她的行为对，再让这件事可见。只改面板、只改日志、只改存储结构而没改那条路径，等于没做。

---

## 0. 改动分三层

| 层 | 改什么 | 在哪 | 升级风险 |
|---|---|---|---|
| 部署层 | 配置、提示词文件、模型端点 | `Cortico-main/deployments/amber/` | 低 |
| 包层 | 新建的 `bots/amber/`（从 corti-soulmate 复制） | `Cortico-main/bots/amber/` | 中（与上游分叉） |
| 框架层 | 共享 World 的代码 | `Cortico-main/src/worlds/qq/` | 高（升级会冲突） |

原则：能放部署层就不动包层，能放包层就不动框架层。这次有几处必须动框架层，已单独标出。

---

## 1. 部署与运行

### M1. canvas 不编译
- **概念**：Minecraft 观察画面需要原生 `canvas`；本机没有 Python/MSVC。
- **实现**：`pnpm-workspace.yaml` 把 `canvas` 的构建脚本设为 `false`。
- **影响**：Minecraft 观察画面不可用；其他 World 不受影响。
- **位置**：`pnpm-workspace.yaml`。

### M2. DeepSeek thinking 的思维链回传
- **概念**：thinking 模式的模型要求把上一轮思维链以明文回传，否则 400。
- **实现**：端点配置 `options.reasoningReplay = "plaintext"`。
- **位置**：`deployments/providers/DeepSeek/config.json`。
- **验证**：`usage.jsonl` 里调用返回 200。

### M3. 双部署
- **概念**：`mybot`（cormini，旧）与 `amber`（新包）并存；同一时间只有一个接 QQ。
- **实现**：各自目录 + 不同端口（7788 / 7790）；`activeProvider` 写各自 `config.json`。
- **位置**：`deployments/`。



---

## 2. 人格内容层（非代码）

### M4. 琥珀协议落盘
- **概念**：人格不是一段提示词，而是「宪法 + 世界观 + 人物 + 手册 + 语气卡」。
- **实现**：
  - `CONSTITUTION.md`：身份、性格、说话方式、两拍结构（先接住情绪，再补一刀）。
  - `WORLDVIEW.md`：二次元设定、AI 娘关系、群文化（梦维护）。
  - `people/*.md`：DeepSeek娘 / GPT娘，首行是花名册摘要，可含别名。
  - `note/playbook/称呼与术语.md`：未知称呼的六步处理流程。
- **位置**：`deployments/amber/memory/`。
- **怎么看**：WebUI 的 Memory 页；或直接读文件。

### M5. 语气卡（分两层）
- **概念**：模型学的是眼前的样本，不是规则；但样本不能无限常驻，否则每轮 token 线性增长。
- **实现**：分两层。
  - **常驻核心卡**：`prompts/style/core/`，由 `sessionHead()` 按文件名排序加载，预算 **6 张 / 2400 字**，超出时只取前面的并记 warn。
  - **资料库**：工作区 `note/style/`，不进每轮前缀；宪法写明"需要时用 `list_files` / `read_file` 自己翻"。
  - 宪法另写一条：示例是风格参考，不是真实发生过的对话。
- **位置**：`bots/amber/persona/index.ts`（`sessionHead` / `coreCards`）；卡片在 `deployments/amber/prompts/style/core/` 与 `deployments/amber/memory/note/style/`。
- **怎么看**：`wakes.jsonl` 的 `context.cards` 只列核心卡；面板「语气卡」分两层展示，可跨层移动。

### M6. 中文机制文本
- **概念**：前缀里的英文会把模型拉向"系统"语气。
- **实现**：ORIENTATION、`toolUsageText`（主意识/梦两段）、console 环境段都改成中文；Cormini 的工作区清单标题改中文。
- **位置**：`bots/amber/persona/ORIENTATION.md`、`bots/amber/persona/tools.ts`、`bots/cormini/persona/persona.ts`、`bots/cormini/persona/PREFIX.md`。

### M17. 身份键改为 QQ 号（昵称只是属性）
- **概念**：身份必须是不可变的主键，昵称是可变属性。此前 `people/` 的**文件名就是昵称**，群友一改昵称就等于换了一个人，旧档案无法续上；上层的事件、线索、唤醒日志其实早就用 QQ 号做键了，只有记忆这一层违背了自己的原则。
- **实现**：
  - `people/` 命名规则：QQ 上的人一律 `qq-<QQ号>.md`，首行是「当前昵称(QQ号) — 一句话」。昵称变了只改首行，不改文件名；不在 QQ 上的虚构人物（`deepseek.md`、`gpt.md`）用固定名字作文件名。
  - 名册（`buildRoster`）顺带做一致性检查：同一个 QQ 号出现在多份档案、或文件名与首行的号不一致，就在「我认识的人」末尾插入一行 `⚠`，漂移会在每次前缀里可见，直到梦合并。
  - 梦的提示词（`subconscious/prompts.ts` 第 4 条）与 `toolUsageText` 的主意识/梦两段，把「调整文件名别名串」改成「按号建号、改为合并」。
  - 管理页「线索」表同时显示 `昵称(QQ号)`：`person` 仍是 QQ 号（关线要用它），`personName` 只用于展示。
- **位置**：`bots/amber/persona/roster.ts`、`bots/amber/persona/tools.ts`、`bots/amber/persona/subconscious/prompts.ts`、`src/worlds/qq/world.ts`（`threadSnapshot`）、`bots/amber/webui/wake.ts`、部署的 `memory/note/playbook/称呼与术语.md`。
- **迁移**：一次性脚本按首行的 `(QQ号)` 把 5 份昵称命名的档案改名成 `qq-<号>.md`；`deepseek.md` / `gpt.md` 保持原名。
- **验证**：`tests/amber/roster.test.ts` 5/5；QQ 与 amber 相关 37 项通过；`typecheck` / `typecheck:web` 通过；前缀里出现 `qq-3124076548` 且没有 `⚠`；面板 `wake/list` 返回 `person=3124076548, personName=疯狂性寝祀`。
- **边界**：`bots/corti-soulmate` 与 `bots/cormini` 是上游示例包，保持旧约定不动；改动只在已部署的 `bots/amber`。

---

## 3. 唤醒层（核心魔改，框架层）

### M7. 名字唤醒（前缀 + 笔误）
- **概念**：人叫人不一定写全名；`clau`、`cluade` 都算叫到。
- **实现**：拉丁别名做「完整命中 / 够长的前缀 / 一次编辑距离（相邻对调算一次）」；中文别名要求完整出现（前缀会误伤）。
- **位置**：`src/worlds/qq/world.ts` 的 `matchWakeName` / `withinOneEdit`；配置 `wakeNames`、`wakeNameMinChars`、`wakeNameFuzzy`。
- **验证**：`tests/integration/qq-name-wake.test.ts`。

### M8. 非唤醒消息只归档
- **概念**：不在"跟谁说话"时，群消息不该排队，否则被叫到时一次倒出一窝。
- **实现**：`pushEvent(..., { deliver: false })`，只落库、不投递；需要时用历史工具回看。
- **位置**：`src/worlds/qq/world.ts` 的消息处理段；配置 `wakeOnMentionOnly`。

### M9. 对话线索（替代计时器）
- **概念**：判断"还在不在对话"靠状态，不靠时间。叫到她或她回过谁，就开一条线；线开着时对方再说话就唤醒，不设过期。
- **实现**：`threads: Map<会话|发送者, {open, openedAt, lastMessageAt}>`，持久化到 `data/qq-threads.json`；启动时加载；`sendToTarget` 带回 `reply_to` 时开线；工具 `qq_thread_close` 关线。
- **位置**：`src/worlds/qq/world.ts`；`bots/amber` 无需改。
- **验证**：`tests/integration/qq-thread-resume.test.ts`（含重启持久化）。
- **边界**：线不自动过期；嫌吵时靠 `qq_thread_close` 或面板手动关。

### M10. 分条说话等半拍
- **概念**：先叫一声、再发正文；只叫名字的短消息不该抢在正文前回。
- **实现**：正文 ≤12 字且是名字唤醒时走 `debounce`（等合批窗口），否则 `flush`。
- **位置**：`src/worlds/qq/world.ts` 的 `callOnly`。
- **验证**：`qq-name-wake` 的第二项（两条同批进上下文）。

### M11. 背景摘要（允许插话）
- **概念**：不唤醒的消息也不该完全无视；给一个低频的"读一下房间"机会。
- **实现**：没唤醒的群消息进内存缓冲；每 `ambientIntervalMinutes`（默认 10）汇总成一条 `qq.ambient` 事件投递，上限 `ambientMaxMessages`（默认 20）；提示词要求"只有真想接一句才开口"。
- **位置**：`src/worlds/qq/world.ts` 的 `startAmbientTimer` / `rememberAmbient` / `flushAmbientFor`；配置 `ambientInterject` 等。

### M18. 离线补拉（重连后补齐错过的消息）
- **概念**：断线时协议端照常收消息，只是没人去要。**进程不在 ≠ 事情没发生**；但也不能回来一口气补答——逐条补投就是"一个人艾特、回复一窝人"的老问题。补的是"知道你错过了什么"，不是"把每条都答一遍"。
- **实现**：
  - 身份就绪后，对每个**已有历史**的会话调 `get_group_msg_history` / `get_friend_msg_history`，往回看 `catchupMaxMessages`（默认 60）条；按 `message_id` 跳过已入库的（`knownMessages` 跨重启从事件库重建）。
  - 只把叫到 bot 的那几句（`@` 或 `matchWakeName`）合成**一条** `qq.catchup` 事件，其余只计数；一条都没叫她就只记日志、不唤醒。
  - 空窗里叫过她 → 顺带把对话线索打开，之后此人的消息照常唤醒。
  - 从没有过历史的会话不补拉，避免把刚加进名单的整段旧消息当成"错过"。
  - 首连发生在主循环之前，事件排在总线里与开场句同批投；运行期重连时主循环已在，直接投。
  - **补拉过的消息号随 `qq.catchup` 的 `meta.message_ids` 落库**；重启重建映射时并入 `seenMessages`，补拉与实时消息都先查它。否则同一段空窗会在每次重启被再播一遍——她会把已经答过的话再答一次（2026-10-25 线上实际发生，她自己在状态里写下了「回了一条四个多小时前的旧消息发现自己答重了」）。
- **位置**：`src/worlds/qq/world.ts`（`catchUp` / `missedMessages` / `knownConvs`）、`config.ts`（`catchupOnStart` / `catchupMaxMessages`）、`definition.ts`、`deployments/amber/worlds/qq/ENV_PROMPT.md`（「你离线过的时候」）。
- **验证**：`tests/integration/qq-catchup.test.ts` 2/2（有人叫 → 投一条且不含无关消息；没人叫 → 不投不唤醒）；实测 18:12 重启补到了掉线期间那句「@Claude🍊昂贵橘子精 嘿你是机器人吗？」，`reason=catchup`、`outcome=sent`。
- **边界**：协议端只留有限历史，`catchupMaxMessages` 之外的不追；补拉不重放图片与语音。

### M18b. 重启补投只补上一次进程的事件
- **概念**：`requeueUndelivered` 原本会把**本次开机刚产生**、还没进 session 的 external 事件也补一遍。任何在 `World.start()` 里投递的世界都会因此重复投递。
- **实现**：MainLoop 构造时记下 `bootCursor = store.latestCursor()`；补投只处理 `cursor <= bootCursor` 的事件。比"按 run id 比较"更贴近语义：判据是**事件是不是在本进程启动前就落库了**，而不是"哪个 run 写的"。
- **位置**：`src/core/loop.ts`（`bootCursor` / `requeueUndelivered`）。
- **验证**：M18 初版同一段摘要在上下文里重复出现；加过滤后只出现一次。`tests/core/loop.test.ts` 136/136（测试里"上一个进程留下的事件"要在 loop 构造前落库，才符合这个语义）。

## 3b. 记忆层（M19–M26）

> 现象：Cortico 有原始事件和成品文件，中间没有"一条记忆"，回想只能靠猜文件名。下面三层补的就是这一层。

### M19. 记忆索引（P1）
- **概念**：Cortico 有原始层（事件库）和成品层（文件人格），**中间没有"一条记忆"**，所以回想只能靠猜文件名。这一层补的就是它。索引是**投影不是真相**：每条条目指回来源文件，删了可以重建。
- **实现**：
  - `data/memory-index.db`（SQLite，`node:sqlite` 自带，无第三方依赖）。表：`memories`（id/正文/类型/主题/人物/重要性/发生时间/来源/状态/访问次数）+ `memories_fts`（FTS5）。
  - 中文检索：写入前把 CJK 切成 **bigram** 灌进 FTS5，查询同样切词——`unicode61` 不切中文，整句会变成一个 token。BM25 分数按本批最大值归一（不用 min-max：单条命中时会塌成 0）。
  - 排序：`0.55×BM25 + 0.30×重要性 + 0.15×新鲜度`；没命中时退化成"最近且重要"的条目，不空手也不报错。
  - 工具：主意识与梦都有 `recall_memory`；梦另有 `remember`（限 12 条/次、6–400 字、类型与重要性校验、同句去重）。召回结果带尾注"过去的记录，与当下冲突以当下为准"。
  - 写入者仍是梦：梦提示词新增一条，整理结束时把新形成的长期记忆用 `remember` 落进索引。
  - 首次建库：`pnpm memidx --bot amber backfill` 把现有文件**结构化投影**成条目（不调 LLM）——文件标题与各级小标题进 topics，正文按空行与列表项切碎，开头日期与文件名日期当发生时间。宪法、语气卡、playbook、handoffs、memo 不进索引。
  - 观测：每次召回写 `data/recalls.jsonl`（查询、命中、分数分解），和 `wakes.jsonl` 对等。
- **位置**：`bots/amber/persona/memoryIndex.ts`、`memoryTools.ts`、`persona/index.ts`（attach 时打开、两个工具挂载）、`bots/amber/persona/subconscious/prompts.ts`、`scripts/memidx.ts`。
- **验证**：`tests/amber/memory-index.test.ts` 11/11；实测 26 个文件得到 103 条，"面试""大肥鱼""机器人""话太密"都命中正确条目；重启后前缀含「# 想起来」与 `recall_memory`。
- **边界**：P1 只有 BM25，没有向量；没有衰减与访问强化（P2）；没有自动注入（P2）；条目是文件的投影，梦改写文件后旧投影不会自动失效，需要重跑 backfill 或由梦增量写入。

---

### M20. 记忆的衰减、休眠与自动注入（P2）
- **概念**：记忆要会褪色，而且是**褪色不是删除**。淡下去的是"会不会自动冒出来"，不是"还能不能被找到"。
- **实现**：
  - **衰减**：`有效重要性 = 基础重要性 × (1-r_eff)^天数`，天数从"上次被想起"算起。访问会放慢衰减，但只在 30 天访问窗口内有效——一次热门不会变成永久免疫。下限 0.05，不会归零。
  - **休眠**：超过 `dormantDays`（默认 90）没被想起、且有效重要性已跌到基础值的四成以下，状态转 `dormant`；被召回后自动复活。衰减是读时算的，只有状态落库，所以可以随时重算、不会累积误差。启动时做一次，之后每天最多一次（`index_meta.last_sweep`）。
  - **召回口径**：`recall` 默认包含休眠条目（历史是历史，仍能查到）；自动注入只要 `active`。
  - **自动注入**：每次投递前按当批外部消息检索，命中就注入一块「想起来的一些旧事」；`injectInternal` 在 `onDelivery` 里会并入当前批，**不会多跑一轮模型**。同一块内容不重复注入。
  - **命中判定**：查询用 OR 取候选 + 覆盖率加权（隐式 AND 对整句太严），并要求命中至少一个**稀有词**（文档频率 ≤ max(3, 语料 5%)）。「你还」「记得」这类词到处都是，单独命中没有信息量，所以不注入。
- **配置**：`memory.decayRate`（默认 0.02/天）、`memory.dormantDays`（90）、`memory.injectTopK`（3，0=关闭），WebUI「认知节奏」组里可调。
- **位置**：`bots/amber/persona/memoryIndex.ts`（`effectiveImportance` / `sweep` / `sweepIfDue` / `injectBlock`）、`bots/amber/persona/index.ts`（`injectMemories` / attach 时维护）、`bots/amber/persona/config.ts`。
- **验证**：`tests/amber/memory-index.test.ts` 16/16；`tests/integration/memory-inject.test.ts` 2/2（相关消息注入、无关消息不注入）；`/api/config` 实测三项生效。
- **边界**：P2 仍是纯 BM25；"稀有词"判定依赖语料规模，条目很少时几乎什么词都稀有。

---

### M21. 语义召回（P3，向量路）
- **概念**：关键词只能匹配词形。"工作上的挫折"和"面试又失败了"一个字都不重合，但它说的是同一件事。向量补的就是这一段。它是**可选增强**：没配模型、没有 key、调用失败或超时，都安静地退回纯关键词。
- **实现**：
  - 客户端：OpenAI 兼容的 `/v1/embeddings`，`query` / `passage` 分开送（检索模型按用途给不同向量）。当前用 `nvidia/nemotron-3-embed-1b`（2048 维）。
  - 存储：向量按「长度 + 小端 float32」编成 BLOB 存进 `memories.embedding`，同时记 `embedding_model`——换模型后旧向量会被视为缺失并重算。
  - 召回：给了查询向量就全表扫余弦（条目量级不大），与 BM25 候选取并集后统一打分：`0.35×BM25 + 0.35×余弦 + 0.2×有效重要性 + 0.1×新鲜度`。
  - 注入门槛：**稀有词命中** 或 **余弦 ≥ 0.3**，两者任一成立才算相关。
  - 补向量：新条目由后台任务分批补（16 条/批，最多 12 轮）；`pnpm memidx embed` 可一次性补齐。
- **配置**：`memory.embeddingModel`（空=关闭）、`memory.embeddingBaseUrl`；key 只从环境变量 `CORTICO_EMBEDDING_KEY` 或 `<部署>/secrets.local.json` 的 `embeddingKey` 读，不写进任何受版本控制的文件。
- **位置**：`bots/amber/persona/embeddings.ts`、`memoryIndex.ts`（`storeVector` / `pendingVectors` / 向量召回）、`persona/index.ts`（`setupEmbedder` / `embedPending` / `queryVector`）、`scripts/memidx.ts`（`embed` 子命令）。
- **验证**：`tests/amber/embeddings.test.ts` 5/5；实测 103/103 条已向量化；「面试那事后来还提过吗」命中面试那条（BM25 0.222 + 向量 0.445）；「工作上的挫折」零字面重合也能召回到语义近邻。
- **边界**：1b 模型对抽象问句区分度一般（相关 0.37 / 无关 0.16 量级），阈值 0.3 是经验值；没有 rerank；全表扫在几万条以内够用。

---

### M22. WebUI「长期记忆」面板（独立 Memory 页）
- **概念**：记忆是**她的**，不是运维的。但"她到底记了什么、改了什么、为什么想起这一条"必须能被看见，否则调不动——所以面板是**观测窗**，不是管理台。它的价值在于让人能验证她的行为对不对，而不是让人管得更顺手。形态参考 AstrBot LivingMemory 的 dashboard：状态/类型/排序/每页条数、勾选批量、分页、召回测试。它属于 `memory:<bot>` 页——记忆是独立一层，不塞进人格运维页。
- **实现**：`memory:amber` 页新增 `memindex` 面板（标题「记忆索引」，避免与页面同名），四块，做成页内 **tab**（记忆管理 / 知识图谱 / 召回测试 / 概览），不再是一列长滚动：
  - **概览**：统计卡（记忆条目 / 休眠 / 已向量化 / 来源文件 / 平均重要性）+ 类型分布 + 最近召回。
  - **筛选行**：关键字（FTS）、状态（清醒/休眠）、类型、排序（最新/最早/重要性）、每页 20/50/100。
  - **列表**：勾选列 + 时间 / 类型 / 正文 / 重要 / 状态 / 来源 / 操作；重要性就地改（change 即保存）；逐行休眠/唤醒、删除；批量休眠/唤醒/删除；分页显示「第 x / y 页 · 共 n 条」。
  - **召回测试**：K 值 + 查询 + Enter 执行；结果卡片摊开关键词 / 语义 / 重要性 / 新鲜度四项分数。**不累加访问次数**——运维在看，不是她真的想起。
  - **最近召回**：`recalls.jsonl` 尾部。
  - **导入与导出**：导出当前筛选结果或选中项为 JSON 索引行（**不含向量**——向量绑模型，换模型即废）；导入按 id 判重，可选「跳过已存在」或「覆盖同 id」，有 5 MB / 5000 条上限，坏条目不中断整次导入；导入后自动触后台补向量。
- **命名**：面板 id 用 `memindex`；`memory` 已被「工作区 MEMORY 0–4 + 写权限矩阵」占用。
- **位置**：`bots/amber/persona/memoryPanel.ts`（声明 + invoke）、`bots/amber/persona/webUiSurface.ts`（挂进 Memory 页的 panels 并分派）、`bots/amber/persona/index.ts`（把索引与查询向量交给面板）、`bots/amber/webui/memindex.ts`、`bots/amber/persona/memoryIndex.ts`（`get` / `update` / `remove` / `stats` / `countFiltered`）。
- **验证**：manifest 里 `memory:amber → workspace,memory,memindex,history`，`persona:amber` 不再含它；CDP 实测：8 列表格 20 行、无横向溢出、分页「第 1 / 6 页 · 共 103 条」；真点「勾选→休眠」，统计条从「休眠 0」变成「休眠 1」，再「唤醒」回到 0；召回得到 5 张卡片，首张 `#1 0.423`；导出按钮点了之后确实生成了 `memory-….json`（Blob 59 KB、`download` 属性正确）；导入走真实的文件选择 → 确认弹窗 → 「导入完成：新增 1」，统计条同步到 104 条、向量数随后补到 105/105。测试：`tests/amber/memory-panel.test.ts` 5/5（导出再导入、跳过/覆盖、坏条目、补向量回调、坏 JSON）。
- **核验中修掉的 bug**：
  1. 同一个输入框被同时放进「重要」和「操作」两个单元格，DOM 节点只能存在一处，「重要」列整列为空。
  2. 初始加载没带 `limit`，渲染 50 行而分页写「1–40」。
  3. 批量操作后统计条不刷新，数据对了但界面写旧数字。
  4. 导入完成后整块面板重挂，操作回执被清空、`load` 又把消息覆盖成「共 N 条」——改成操作后只就地刷新行/统计/分页。
  5. **后台补向量的锁是自己坏的**：拿 Promise 当互斥量，队列为空时 IIFE 同步走完，`finally` 先把字段清空、随后赋值又写回一个已完成的 Promise，从此永远非空，后续调用全被拦掉。导入的新条目因此一直停在「未向量化」。换成同步置位的布尔忙标志后，导入 8 秒内补齐（实测 105/105）。
  6. **纯数字被当成检索词**：查询串里的时间戳 `23:13` 与记忆里的日期 `2026-10-23` 命中同一个 `23`，导致无关消息被判为相关并触发自动注入。分词只保留含字母的拉丁词后恢复。
- **边界**：`ui` 组件没有详情抽屉，编辑只能逐行就地改；删的是索引行，来源文件不受影响，重跑 `backfill` 会加回来。排查中文请求时注意 curl 的编码（用 UTF-8 文件体），浏览器没有这个问题。

### M23. 知识图谱（共现图）
- **概念**：不建第二套图存储。节点来自每条记忆本来就带的 `people` / `topics` / `source`，边是「同一条记忆里一起出现」。条目一改，图跟着变，没有第二个会漂移的真相。
- **实现**：
  - `MemoryIndex.graphData()`：从 `memories` 表聚合节点与边。只出现一次的主题是文档标题碎片、不是可复用实体，默认过滤掉；节点按出现次数取前 60，边按共现次数取前 240。
  - `MemoryIndex.neighbors(id)`：相邻实体、权重，以及把它们连起来的具体记忆（最多 20 条）。
  - 面板「知识图谱」：人物在内圈、主题与来源在外圈；节点大小按出现次数，边的透明度与粗细按共现次数；标签只给出现最多的 14 个，其余悬停看 `title`。点节点看关联，关联里的实体还能继续点。
  - 人物显示名从 `people/qq-<号>.md` 首行解析，没有档案就显示 QQ 号——不编名字。
- **位置**：`bots/amber/persona/memoryIndex.ts`（`graphData` / `neighbors`）、`bots/amber/persona/memoryPanel.ts`（`graph` / `neighbors` 两个方法、`personLabel`）、`bots/amber/webui/memindex.ts`（`graphBox`，手写 SVG，无第三方库）。
- **验证**：真实数据 `人物 5 · 主题 19 · 来源 11 · 关系 39`；CDP 实测 SVG 里 35 个圆、39 条线、14 个标签；点「疯狂性寝祀」→ 头部「23 条记忆」、相邻实体 `people/qq-3124076548.md·23`、列表 20 行；`tests/amber/memory-panel.test.ts` 8/8（节点/边/过滤/邻居/名字解析）。
- **边界**：这是**共现图**，不是语义图谱——没有 LLM 抽实体和关系。主题质量取决于文件结构（`backfill` 只把标题当主题），所以图谱更像"我记在哪、和谁有关"的地图，不是知识推理图。目前只用于浏览导航，没有接进检索打分。

### M24. 左栏标签由 Persona 声明
- **概念**：导航把实现细节漏到脸上——`memory:amber` 在左栏显示成 `GitMem`（Memory 实现类名），`persona:amber` 显示成 `CortiSoulmate`（Persona 类名）。用户看到的是"部署"，不是"哪个类"。
- **实现**：`PersonaWebUiDecl` 增加可选 `label`；Persona 页与 memory 页都优先用它，缺省仍退回类名（不影响其他 bot）。amber 声明 `label: displayName`（琥珀协议）与 `memory.label: '长期记忆'`。
- **位置**：`src/core/types.ts`、`src/bot.ts`（`mergePersonaContributions` 调用处、`memoryPageContribution`）、`bots/amber/persona/index.ts`。
- **验证**：manifest 里 `persona:amber → 琥珀协议`、`memory:amber → 长期记忆`；左栏 NAV 实测出现「琥珀协议」与独立的「长期记忆」。

### M25. 唤醒名来自她自己的术语表
- **概念**：群里怎么叫她，是她自己维护的数据，不是部署配置里的一个静态数组。配置里只有 `claude / 克劳德 / 小橙 / claude娘`，群主喊的「小克」就一直漏掉——名字对不上，连"离线期间有人叫你"都判定不出来。
- **实现**：
  - `parseSelfNames()` 读 `note/playbook/称呼与术语.md` 的「我自己的称呼」一节，去掉括号说明、去重、丢掉单字碎片。
  - Persona 在 attach（早于 World.start，所以首连补拉就能用）与每次投递前按文件 mtime 同步，调用 `QQWorld.addWakeNames()`；名字只进运行时集合，不写回配置。
  - World 匹配时把「配置里的名字」与「运行时追加的名字」合并使用。
- **位置**：`bots/amber/persona/wakeNames.ts`、`bots/amber/persona/index.ts`（`syncWakeNames`）、`src/worlds/qq/world.ts`（`addWakeNames` + 匹配合并）。
- **验证**：`tests/amber/wake-names.test.ts` 3/3；`tests/integration/qq-name-wake.test.ts` 4/4（新增「运行时追加的名字也能唤醒」）；实测：23:43 群主说「小克小克，出来一下」当时判为没人叫，修复后重启补拉 `reason=catchup`、`outcome=sent`，她回「在。什么事？」。
- **边界**：名字来自术语表，术语表写错就会一并生效；运行时集合不持久化，重启由 attach 重新同步。

### M26. 向量调用可见化
- **概念**："有没有真的在调"不能靠相信代码。异步、后台的东西最容易静默失效（补向量那把锁就是例子），必须留下计数。
- **实现**：Persona 记 `{ query, passage, failures, lastMs }`——查询向量（自动注入、`recall_memory`、面板召回）与建档向量（后台补）分开计；面板「概览」直接显示，失败时日志告警。
- **位置**：`bots/amber/persona/index.ts`（`embeddingStats` / `queryVector` / `embedPending`）、`memoryPanel.ts`（`embeddingStats` 依赖与 `list` 返回）、`bots/amber/webui/memindex.ts`（概览行）。
- **验证**：重启后 `query=1`（自动注入那次），手动调一次面板召回变 `query=2`、`lastMs≈1.2s`；`passage` 在导入新条目时递增。

### M27. 名字层：昵称是属性，不是事实
- **概念**：M17 把**主键**换成了 QQ 号，但**正文里仍然冻结着当时的昵称**。根因是两条提示词白纸黑字要求「旧昵称、外号要留在正文里」——梦于是把当时的称呼刻进散文；`memoryIndex.put()` 原样入库、`recall()` 原样返回，整条链路没有渲染入口。后果：群友一改名，召回里就是「小橘说过…」，模型只能猜怎么称呼。主键对了，属性被冻住了。
- **分层**：
  - **事件流水**（`events.jsonl`）：保留当时的 `小橘(3124076548): 正文`，这是实录，且带号不歧义，**不改**。
  - **身份层**（`people/qq-<号>.md`）：首行是当前称呼，新增 `## 曾用名` 小节记历史。
  - **记忆 / 笔记 / 索引**：只存指向 `@<QQ号>`，读时渲染成当前称呼。
- **实现**：
  - **PersonRegistry**（`people.ts`）：解析首行 + `## 曾用名` + `别名：` 行 + `data/qq-names.json`，得到 号↔名↔曾用名。`canonicalize` 写入前把人名换成 `@号`（长名优先；名字 ≥2 字；同名归属多人时不替换并告警一次；她自己的称呼不参与）；`render` 读出来时换回当前名，并顺手把存量里的旧名换成新名（只换唯一归属、且不与别人当前称呼冲突的）；`expand` 把相关号的全部称呼喂给 FTS。按目录与文件 mtime 失效。
  - **索引钩子**：`MemoryIndex` 构造函数第三参 `{canonicalize?, render?, expand?}`，缺省恒等。写入规范化 → 同一句在改名前后写两次仍是同一条（id 由规范化正文算）；`reindex` 的词元加上 `expand` 的别名 → 改名后搜旧名照样命中；`get`/`list`/`recall`/`injectBlock`/`neighbors`/`pendingVectors` 返回前渲染（向量也按"读到的样子"算）。
  - **改名检测**（`world.ts`）：消息与 `group_card` 通知两处比较新旧显示名 → 写 `data/qq-names.json`（原子替换）→ 投一条 internal 的 `qq.rename`，`trigger:'flush'` 并入下一批，不单独开一轮模型。名片被清空、回落到 QQ 昵称不算改名。`seedNames()` 用事件库补齐离线期间发生的改名：只记历史、不发事件。
  - **人格侧**：名册每行附「曾用名」；`subconscious/prompts.ts` 与 `note/playbook/称呼与术语.md` 反过来写——旧名记进 `## 曾用名`，不写进观察正文；`ENV_PROMPT.md` 新增「有人改名的时候」一节。
  - **认得人（这条才是重点）**：面板是给运维的，她需要的是"这个人是谁、我记得他什么"。投递前按**发送者的 QQ 号**直接查档案与记忆，完全不走关键词：`MemoryIndex.recallForPeople(qqs)` 用 `people` 列做结构化召回（`people LIKE '%"号"%'`，不会把 3124 和 31241 混成一个），`countForPerson(qq)` 给条数。注入块以人为主体：
    ```
    [这几条消息来自你认识的人。名字会改，号不会——下面是按号找出来的记录]
    - 橘子精(3124076548)，曾用名：小橘｜群主，改我的人
      · 2026-08-01 小橘说他女儿今年上小学了。
      · 档案：people/qq-3124076548.md
    ```
  - **查询期扩展**：索引词元是**写入那一刻**的别名集合，改名之后用新名字搜不到旧条目。`PersonRegistry.queryTerms()` 在检索前把正文里出现的任何称呼补成这个人的全部称呼，把新名字接回旧记忆——这是"改名后还能找到"的最后一环。
- **位置**：`bots/amber/persona/people.ts`（新）、`roster.ts`、`memoryIndex.ts`（`recallForPeople` / `countForPerson`）、`memoryTools.ts`、`memory.ts`、`memoryPanel.ts`、`webUiSurface.ts`、`index.ts`（`injectMemories` / `personBlock`）、`subconscious/prompts.ts`、`src/worlds/qq/world.ts`、`src/worlds/qq/definition.ts`、`scripts/memidx.ts`、`deployments/amber/memory/note/playbook/称呼与术语.md`、`deployments/amber/worlds/qq/ENV_PROMPT.md`。
- **迁移**：不动存量。读时渲染把已知旧名换成当前名，写入侧从此规范化；`backfill` 重跑会顺带规范化投影出来的条目。
- **验证**：`tests/amber/people-registry.test.ts` 14/14、`tests/amber/roster.test.ts` 6/6、`tests/integration/memory-inject.test.ts` 3/3（新增一条：消息来自改名后的「橘子精」、记忆正文只写了旧名「小橘」且与消息毫无字面关系，注入块仍然出现「橘子精(号)，曾用名：小橘」与那条旧事）、`tests/integration/qq-rename.test.ts` 1/1；合计 79 项通过；`typecheck` / `typecheck:web` 通过。真实索引实测：群主 33 条、清鱼 4 条、阿摆 5 条、白毛狐狸水 6 条，全部按号取到并渲染成当前称呼。
- **边界**：这是"共现之外的第一次实体归一"，但只覆盖**人名**——主题、事件名仍然按原样冻结。渲染是逐条正则替换，同名歧义时宁可保留旧名也不猜。虚构人物（deepseek / gpt）名字固定，不参与替换。

---

## 3c. 陪伴层（M28–M32）

### M28. 她自己的时间：机会、话头与主动开口

- **概念**：在此之前她只在被叫到时存在——87 条发言全部发生在别人先开口之后，主动开口工具 250 多次唤醒里只用了 2 次。缺的不是能力，是"我此刻想说话"的入口。参考 AstrBot「我会永远陪着你」的核心模型，**只取形状，不搬实现**：
  - **机会**是一段时间窗，过期即弃（不排积压——"补作业"式的主动比不主动更假）；
  - **念头**是"此刻能说的一个方向"，多个候选里按稳定种子加权选一个，选不出就说 skip；
  - **生活状态**先于表达：她自己睡着、精力见底、对方在安静时段，都不开口。
- **实现**：
  - `companion/models.ts`：Opportunity / Thought / selectThought。同一机会 + 同一种子必得同一条，重试不会换说法。
  - `companion/state.ts`：精力（睡着回、醒着掉）、每天主动额度、每个会话的最近互动与 `openLoop`（未完话头）。落盘 `data/companion.json`，按本地日期滚动。
  - `companion/sources.ts`：未完话头（她问过一句、对方没答；或她主动说过、没有回音）、时段问候（**只给私聊**，群里突然说早安是广播）。
  - `companion/scheduler.ts`：门。开关 → 安静时段 → 她自己的睡眠 → 当天额度 → 半小时全局冷却 → 会话冷却 → 精力下限，任何一条不过就什么都不做。
  - `companion/index.ts`：评估、去重、收口。**它不生成文字，也不发送**——只把一条内部事件放进总线。
  - `companion/prompt.ts`：主动时刻的文本。三件事缺一不可：说清"这是你自己想开口"、给一个具体由头、明确允许她什么都不做。
- **框架改动**：`CoreApi` 增加 `wakeInternal(text, kind, meta)`，`Core` 同名公开方法走 `store.append` + `bus.push({trigger:'flush'})`。这是"没人说话时也能让她醒一次"的唯一入口——`injectInternal` 只在当前一轮里生效，人安静时什么都不会发生。
- **闭环**：她在回合结束时由 `onTurnEnded` 记录"到底发没发"；发了才计入当天额度，没发这次机会退役（未完话头最多尝试一次，不催）。
- **位置**：`bots/amber/persona/companion/*`、`bots/amber/persona/index.ts`（attach / startRhythm / onDelivery / onTurnEnded）、`bots/amber/persona/config.ts`、`bots/amber/index.ts`、`src/core/types.ts`、`src/core/core.ts`、`deployments/amber/config.json`。
- **配置**：`companion.enabled`（默认关：主动开口最容易变成骚扰，必须由部署明确打开）、`allowPrivate` / `allowGroups`、`dailyCap`、`followupMinutes`、`followupCooldownMinutes`、安静时段与她自己睡觉的时段。
- **来源**：`astrbot_plugin_private_companion-7.0.0.zip`。对照过同仓库的 dev 快照：`proactive/models.py`、`planner.py`、`rhythm.py`、`greetings.py` **逐字节相同**，7.0.0 只少了少量提示词段落（倒计时表达、候选核对）。所以这里移植的是它真正稳定的那一层。
- **验证**：`tests/amber/companion.test.ts` 31/31（确定性选择、过期不兑现、各种门、话头生命周期、落盘、文本措辞）；`tests/integration/core-wake-internal.test.ts` 1/1（没有外部消息时内部事件也能把她叫醒并进入上下文）；`tests/core/loop.test.ts` 136/136（补投语义改为"启动水位之前"，测试同步修正）。
- **边界**：只做了"主动开口"这一条主线。插件里的日程、天气、新闻、QZone、生图、识屏、游戏、直播、TTS、表达学习都没移植。群里主动只对着具体的人，不做广播；同一个群的任何一条用户消息都会关闭话头（保守）。

---

### M29. 她自己的状态、日记与看法

- **概念**：M28 只让她"能开口"，但她开口时没有"此刻的自己"。这一层补三样：**状态**（她此刻什么感觉）、**日记**（她怎么过的一天）、**看法**（她怎么看某个人）。判据不是"信息更多"，而是**同一个人隔几天再说话，她的态度是连续的**。
- **实现**：
  - **角色状态**（`companion/roleState.ts`）：精力 0–100、心情五轴（baseline/joy/anger/sorrow/fear）+ 浓度 + 一句心境、睡眠/忙碌/健康、公开状态（≤8 字）、在线态、临时状况。**梦**用 `maintain_state` 工具写；两次梦之间按规则漂移——心情向基线半衰期 180 分钟衰减，精力按昼夜增减。主意识每轮看到一段「你自己此刻的状态」，只影响语气浓度。
  - **日记**（`companion/life.ts`）：梦写 `memo/diary/YYYY-MM-DD.md`（第一人称、4–8 句、不是事件摘要）；主意识**当天第一次醒来**时看到最近一篇的一段，不重复。
  - **她的看法**：`people/qq-<号>.md` 新增 `## 我的看法`（2–4 条带日期的一句判断，可改写）；这个人开口时，看法随档案、曾用名一起进上下文。
- **纪律**（三条，写进提示词与代码注释）：①模拟不是事实——时间经过不证明她吃过、睡过、出过门；②只影响语气与判断，不播报数值，不决定回不回；③不把别人的状态搬到她身上，也不拿她的状态诊断别人。
- **位置**：`bots/amber/persona/companion/roleState.ts`、`companion/tool.ts`、`companion/life.ts`、`people.ts`、`index.ts`（attach / onDelivery / dreamTools / WORKSPACE_DIRS）、`subconscious/prompts.ts`（第 10、11 条）。
- **来源**：AstrBot「我会永远陪着你」7.0.0 的 `role.state`、`role_work/journal`、`relationships`。拆解见 `COMPANION-7.0.0.md`。
- **验证**：`tests/amber/role-state.test.ts` 12/12、`tests/amber/life.test.ts` 6/6、`people-registry` 新增看法解析、`tests/integration/role-state-inject.test.ts` 1/1（真实 bot：状态与日记进入上下文）、`memory-inject` 新增「看法」断言。amber 全套 111 项、全量 5144 项通过（另有两项环境性失败：本检出没有 `.git`，`env-prompt-contract` 的 `git ls-files` 失败；canvas 原生模块未编译，`minecraft/bridge` 失败，见 M1）。
- **核验中修掉的 bug**：`onTurnEnded` 在 `!record || !wakeLogDir || !core` 时提前 return，而 `companion.settle()` 写在它后面——部署没有 data 目录时，第一次主动机会之后 `pending` 永远不清，主动层从此静默哑火且日志无异常。改成没有唤醒记录就按"没说"收口（宁可少记一次，不可死锁）。
- **真实对话暴露的第二个问题**（2026-10-25 17:49）：群里问「clau，现在在干嘛呢」，那一轮的上下文里**没有状态块**——它在 17:38 重启那批出现过一次，之后内容没变就被去重挡掉了；同时 `busy` 为空，她只能从对话里找由头。修法：①状态块**每轮都注入**（同一轮内不重复，新一轮重置去重）；②`busy` 为空时明确写「此刻没在做什么具体的事」，并允许她据此如实回答；③块首说明改成"平时不要主动播报数值，但被问到就按这里说"，避免把"别念数值"读成"别提状态"。
- **梦的工具面教训**：`maintain_state` 一直在梦的工具列表里（`tests/amber/dream-tools.test.ts` 证明），但前两次入梦都没有调用——指令埋在九条清单中间，模型略过了。把「睡前写今天的日记 + 用 `maintain_state` 更新状态」移到 `dreamTask`（它最后读到的那段文本）之后，第三次才真的调用：写出 `busy=回看自己今天答过哪些消息`、`presence=翻记录`、心境「发现把已经了结的线又补了一遍，安静地不痛快」和一句依据。**工具可用 ≠ 会被使用；顺序和位置决定它会不会被用。**
- **边界**：关系记忆的完整状态机（proposed/reviewed/adopted/retracted + 人审 + 情绪归属）暂缓，目前是文件里的日期化判断；状态没有周期/位置/饥饿，也不接日历。

### M30. 「陪伴与状态」面板
- **概念**：没有观测就没有改进。面板不是管理台，是**观测窗**，回答三个问题——她此刻什么状态、为什么现在没主动、最近写了什么和怎么看人。
- **实现**（挂在 `persona:<bot>` 页，三张卡）：
  - **她此刻**：精力、心情五轴、公开状态、今天主动几次；可手动改精力/公开状态/在忙/一句心境（排障与演练用）。
  - **主动机会**：一行结论（有机会 / 现在不会 + 原因），加会话表（对方上次、她上次、未完话头、状态）与当前节奏参数。诊断**只读**，看一眼不消耗她的机会。
  - **日记与看法**：最近一篇日记（可切历史日期）+ 每个人档案里的 `## 我的看法`。
- **关键设计**：`gateReason()` 把六道门抽成可解释的字符串（未开启 / 安静时段 / 她睡觉 / 精力过低 / 今日额度 / 冷却），`explain()` 在门都过了之后再回答"有话头吗"。这套判断和真正评估 `planOnce` 共用同一份代码，面板说的就是她实际会做的。
- **位置**：`bots/amber/persona/companionPanel.ts`、`bots/amber/webui/companion.ts`、`webui-page.ts`、`persona/index.ts`、`companion/scheduler.ts`、`companion/index.ts`（`diagnose`）。
- **验证**：`tests/amber/companion-panel.test.ts` 7/7、`tests/web/persona-corti-webui.test.ts`（服务端与客户端面板清单对咬）；`pnpm build:web` 产出 `persona-amber-*.js`；线上 manifest 里 `persona:amber` 出现 `companion`；真实 POST `state` 返回 `energy 61 / diagnose「门都过了，但没有可用的话头或问候」`，`saveState` 返回 `已更新：basis`。
- **核验中修掉的 bug**：只写 `basis` 的补丁被回执成"没有可用的字段"，但值已经写进去了——面板保存会假报错。改成 `basis` 也计入 applied。
- **边界**：面板改状态只用于排障，正常应由梦写；没有"立即主动一次"的按钮（会绕过冷却，等于给自己开后门）。

### M31. 接群里正在聊的话题
- **概念**：主动不能只有"她问过没被答"。群里正聊着的事，她本来就有记忆、有对发言者的看法；真正缺的是判断——**这帮人是不是在聊、她懂不懂、轮不轮得到她、她有没有别人没说的那一句**。
- **四道判据**（缺一不可）：
  1. **正在聊**：`topicWindowMinutes`（默认 30）内至少 6 条、至少 2 个人。一个人连发不算。
  2. **她懂**：拿最近六句去记忆检索，命中不了就没有可说的，不硬接。
  3. **轮不到她**：10 分钟内被明确叫到（那是正常回复）、同会话冷却内她说过或试过，都让位。
  4. **今天没接过**：`topicDailyCap`（默认 1），和"接自己的话头"分开计。
- **给她的由头**：最近五句的摘要 + 她记得的相关旧事 + 她对最后发言者的 `## 我的看法`，末尾明写"只在你确实有别人没说的角度时开口；只是附和、重复、'你们说得对'，就什么都别说"。
- **数据来源的坑**：群里没叫到她的消息是 **archive-only**，不进投递批次，本地缓存看不到。因此新增 `QQWorld.recentMessages(conv, limit)`：从事件库取该会话最近的外部消息，剥掉 `#id [群…] 名字(号):` 前缀，只留正文；Companion 通过 `recentOf` 接它。
- **配置**：`companion.participateGroups`（默认开）、`topicWindowMinutes`、`topicDailyCap`。部署已开：每天 1 次、窗口 30 分钟。
- **位置**：`companion/sources.ts`（`topicCandidate`）、`scheduler.ts`、`companion/index.ts`、`companion/state.ts`（`recent` / `topicToday`）、`persona/config.ts`、`persona/index.ts`、`src/worlds/qq/world.ts`、`webui/companion.ts`（"接话题"读数与节奏行）。
- **验证**：`tests/amber/companion-topic.test.ts` 12/12（热度、人数、被叫到、刚说过、检索无命中、额度、开关、私聊、检索抛错、记账）；`tests/integration/qq-recent-messages.test.ts` 1/1（六条没叫到她的群消息取得到、正文已剥前缀）；amber + QQ 世界 190 项通过。线上面板显示 `接话题 0/1`，诊断「门都过了，但没有可用的话头、群话题或问候」。
- **边界**：话题质量取决于检索命中，没配向量时只靠关键词；她没有"主动收尾"的概念，接完一句就等下一批；`recentOf` 每次评估都扫一遍事件库，条目多了要加索引或缓存。

### M32. 低水位入梦
- **概念**：梦只在上下文快满时触发。安静的日子可能整天不交接——`busy` 停在昨天、今天没有日记，"她有自己的生活"就变成**只有人工点一次才成立**。
- **实现**：
  - `startRhythm` 起一个 10 分钟一次的检查（`unref`，不拖住进程），启动 1 分钟后再看一次——隔夜关机不该等到下一轮。
  - 判据 `dreamDue`：距上次交接 ≥ `dreamEveryHours`，**且**（这段时间有人说过话，**或**今天还没有日记）。不要求有人说话——安静的一天也该留一点记录；但没变化又刚整理过，不值得为它花一次梦的钱。
  - 到点走**同一个入口** `forceDreamAndTruncate()`（面板的「强制入梦」也用它），不另开一条整理路径。
  - 上次交接时间取 `handoffs/` 里最新笔记的 mtime，不新增状态文件——工作区本身就是记录。
- **配置**：`companion.dreamEveryHours`（默认 6，0 = 只在上下文满时入梦）。
- **位置**：`companion/life.ts`（`lastHandoffAt` / `dreamDue`）、`persona/index.ts`（`maybeDream` / `startRhythm`）、`persona/config.ts`、`persona/companionPanel.ts`、`webui/companion.ts`。
- **验证**：`tests/amber/life.test.ts` 新增 8 项（没到点、有活动、已有日记、没日记、关闭、从没入过梦、取最新交接时间）。线上实测：把兜底临时调到 1 小时重启，70 秒内日志出现「低水位入梦 → 梦开始 → 交接完成」，梦结束后她自己把状态写成「整理今天傍晚那场：多模态兑现、好感度讨论、陌生人试探 / 收拾今天」；随后恢复 6 小时，面板显示「距上次 0 小时 · 兜底 6 小时 · 现在不会入梦」。
- **边界**：一次梦约 50 次模型调用，`dreamEveryHours` 直接决定这笔钱；判据只看"有没有人说/今天有没有日记"，不看聊了多少——聊两句和聊两小时一样会触发。

### M33. 陪伴页独立成按钮
- **概念**：陪伴层的观测面不该寄生在部署运维页里。"她是谁、她怎么想"和"部署怎么回滚"是两件事，混在一排页签里，前者永远是后者顺带看的一眼。对齐 AstrBot「我会永远陪着你」的陪伴面板——按**能力**分区，不照抄界面。
- **实现**：
  - 框架新增 `WebUiPageContribution.clientPage`：同一个 bot 的附页复用同一份浏览器产物（构建按目录出包，一个目录只有一份），manifest 里仍按解析到的资源填 `client`，这个字段不上线；`WebUiAssets.forPage(pageId, alias)` 负责查表。
  - bot 侧 `cortiWebUiPages` 贡献第二页 `persona:amber-companion`（左栏显示「陪伴」），十张页签：总览 / 用户 / 群聊 / 观察 / 世界知识 / 主动 / 学习 / Token / 排障 / 配置。运维页的「陪伴与状态」页签随之移除。
  - 数据面 `companionPanel.ts` 重写为十组方法，全部接真数据：`role-state.json`、`people/`、`memory-index.db`、`companion.json`、`wakes.jsonl`、`usage.jsonl`、`recalls.jsonl`、`console.err.log`、语气卡目录。
  - 候选可见而不掷骰子：`scheduler.poolCandidates()` 从 `planOnce` 里抽出来，`inspect()` / `Companion.inspect()` 只回答"此刻有哪些话头、从哪来"，看一眼不消耗机会。
  - `snapshot().convs` 增 `lastUserKey`：用户页的「最近说话」按人算，否则群里永远是最后一个说话的人。
  - 配置页走 `ctx.setConfig('amber', …)` 热写回；手动改状态挪进配置页并标注只用于排障。
- **位置**：`src/web/shared/webui-protocol.ts`、`src/web/webui-pages.ts`、`bots/amber/persona/companionPanel.ts`、`bots/amber/persona/index.ts`、`bots/amber/persona/companion/{index,scheduler}.ts`、`bots/amber/webui-page.ts`、`bots/amber/webui/{client,companion}.ts`。
- **验证**：`tests/amber/companion-panel.test.ts` 14 项（十页签、只读诊断、越界日期、各数据面形状、配置补丁）；`tests/web/webui-pages.test.ts` 附页产物复用 1 项；amber 160 项、web 1209 项通过。线上用无头 Edge 走完十个页签，均有真实内容且无脚本错误；保存配置写出 `config.json`；运维页已无陪伴页签。
- **边界**：世界知识只给世界观/宪法开头与 note/ 目录，全文仍在工作区；创作、生图、Q 空间、现实触及没有对应物，不做；模型配置沿用框架「模型供应商」页；Token 只算 `usage.jsonl`，不含记忆插件第二条链；用户档案仍由聊天与梦创建，面板只读。

### M34. 生活状态层：今日八格、当前卡与日程时间轴
- **概念**：M33 只复刻了页签骨架，漏掉了 AstrBot 陪伴面板真正的核心——「今日」的八个事实格与「当前」卡。那些值不来自角色状态（精力/心情），而来自一条独立的 `daily_state`：天气、地点、日程、健康、穿搭、睡眠、身体周期、饥饿、梦境。补这一层，面板才从"目录"变成"她今天在过什么日子"。
- **实现**：
  - 新模块 `companion/lifeState.ts`：`life-state.json`（原子写）保存当日日程、天气读数、地点覆盖、饥饿、梦境、穿搭、周期锚点；换天作废日程与穿搭，天气与锚点留着。
  - 日程：梦用新工具 `write_daily_plan` 写 8–10 段（time/end/activity/mood/messageSeed/location）；梦没写之前按作息切一份临时排程并标 `source:'fallback'`，面板明写"临时排程"。
  - 时段判定按时序归一：跨过午夜的段整体加一天，末段不会被误判成"已过去"。
  - 周期：六阶段 5+7+2+2+9+3=28 天，文案与体力偏移取自 AstrBot 原值；未开启/未校准显示「不处于生理期」，精力不吃偏移。
  - 睡眠：当前段是睡/午休，或落在 `sleepStartHour–EndHour` 窗口内 → 「睡眠中 · 计划 HH:MM 醒来」；否则用角色状态里的睡眠感受，默认「睡眠平稳」。
  - 地点：对话覆盖（4 小时）> 段内 location > 活动词（公司/外面/家）> `homeName`，默认「家里」。
  - 天气：`companion/weather.ts`，Open-Meteo（免 key）：城市名先地理编码，再拉当前天气与当日高低温，默认 90 分钟一刷；没开开关、没填城市、失败一律「暂无天气信息」，保留上一次读数。
  - 上下文：`injectRoleState()` 追加「你今天的日子」一段（天气/地点/现在这段/周期/睡眠），明写"没人问就别播报"；与状态块一样按文本去重。
  - 梦的工具面新增 `write_daily_plan` 与 `maintain_life`（饥饿/梦境/穿搭/地点/周期锚点）；梦提示词在写完日记与状态之后要求"把今天的生活理一遍"。
  - 面板：总览改成 6.5.6 那种密度——今日八格（2/4 列自适应、每格 66px、两行截断、title 保留全文）+ 当前卡（活动大字、时段与心境、messageSeed、体力条、状态/睡眠/饥饿/梦境/位置/心情六格）+ 完整时间轴（当前段高亮、已过去置灰）；日记与最近唤醒折叠。样式在 `webui/companion.css`。
  - 配置页新增「生活」与「生活事实」两张卡：城市/天气开关/刷新间隔/家名/段数/周期开关与起始日走 `setConfig`；饥饿/梦境/穿搭走 `config.saveLife`。
- **位置**：`bots/amber/persona/companion/{lifeState,weather,lifeTool}.ts`、`persona/index.ts`、`persona/config.ts`、`persona/subconscious/prompts.ts`、`persona/companionPanel.ts`、`bots/amber/webui/{companion.ts,companion.css,client.ts}`。
- **验证**：`tests/amber/life-state.test.ts` 17 项（排程、跨午夜、周期、睡眠、地点、换天、补丁白名单、快照、工具）；`tests/amber/weather.test.ts` 5 项（天气码、地理编码、失败路径、节流）；`dream-tools` 断言两个新工具在梦里可达；amber 172 项通过。线上（无头 Edge）读到：`天气 暂无天气信息 / 地点 家里 / 日程 10 个时间段 / 健康 状态正常 / 穿搭 暂无穿搭图 / 睡眠 睡眠平稳 / 身体 不处于生理期`，当前段 `20:54–22:36 晚饭 进行中`，时间轴 10 段且末段正确为「还没到」。Open-Meteo 实拉一次得到 `晴 17–23℃`（未写进部署配置，等用户填城市）。
- **边界**：日程默认是作息切出来的临时排程，真实内容要等下一次梦；穿搭没有生图后端，只支持文字或空态；天气需要部署者填城市并打开开关；周期需要人工校准起始日；「天气/日程」不会自动改她的语气，只是背景事实。

### M35. 注意力显著性：让"没注意到"成为合法事件
- **概念**：世界已经能分清"叫到她"和"没叫到她"，但没叫到的全被同一档处理——`wakeOnMentionOnly` 开着时全部进背景缓冲（每 10 分钟的摘要都可能叫醒她），关着时全部直接投递。真实存在者有个显著性瓶颈：有人问了具体问题、这个群正吵、同一个人第五次复读同一句，值得留意；剩下的是噪声。判决应当是确定性的、可解释的，并且能被面板看见。
- **实现**：
  - `src/worlds/qq/salience.ts`：三档 `focus / periphery / background`，纯函数 `scoreMessage()`。底分 0.2（有人在群里说话），今天第一次见这个人 +0.08、提问 +0.15、情绪浓度 +0.12、连着说 +0.05；群里 6/12 条以上 −0.06/−0.12、同一句复读每次 −0.15。达到 `peripheryThreshold`（默认 0.35）进缓冲，否则只归档。直接叫到她与私聊永远 focus，分数不参与。
  - 世界落点 `world.ts`：在推事件前判决，`focus` 照常投递、`periphery` 进背景缓冲（下次被叫到时搭车，或随定时摘要出现）、`background` 只归档（`deliver:false`，不进摘要、不唤醒）。事件 meta 带上 `attention:{tier,score,reasons}`；群消息的判决进环形记录（最近 300 条）并追加 `data/qq-attention.jsonl`（2 MiB 轮转一次），重启后恢复。
  - 注意力关着时完全保持旧行为：`wakeOnMentionOnly` 开着 → 进缓冲；关着 → 照常投递。
  - 配置：`worlds.qq.attention.{enabled,peripheryThreshold,windowMinutes,habituationMinutes}`，`enabled` 热生效。
  - 面板：陪伴页「群聊」新增「注意力」表——时间/会话/谁/档/分/为什么/内容，顶部一行写着开关、分数线与两个窗口；判决理由由服务端原样给出（例如"分 0.20 低于 0.35，只归档"）。
- **位置**：`src/worlds/qq/{salience.ts,world.ts,config.ts,definition.ts,strings.ts}`、`bots/amber/persona/companionPanel.ts`（`groups.attention`）、`bots/amber/persona/index.ts`（从挂载的 QQ 世界取判决）、`bots/amber/webui/companion.ts`。
- **验证**：`tests/worlds/qq/salience.test.ts` 10 项（三档、底分、提问/情绪/复读/负荷、压线、归一化）；`tests/worlds/qq/attention.test.ts` 4 项（只归档且带理由、缓冲被叫到时搭车、复读降档、记录新的在前）；`tests/amber/companion-panel.test.ts` 增 `groups.attention`。QQ 世界 + 相关集成 + amber 共 371 项通过。线上 `groups.attention` 返回 `enabled:true, threshold 0.35, windows 10/30`。
- **边界**：显著性完全在 World 内算，看不到人格侧的记忆与关系数据（新颖度用"同一句话是否出现过"近似，关系相关用"这个人当前在不在说"近似）；判决只影响"要不要进她的上下文预算"，不改变她对已经看到的消息怎么回；补拉（catchup）仍按旧规则——只投有人叫到她的那段摘要。

### M36. 梦的出口闸门：日程没写就不许 surface
- **概念**：M34 把写日程交给了梦，提示词也要求了，但 13:41 那次梦（16 次调用）写完日记就直接 `surface`，`life-state.plan.source` 仍是 `fallback`。提示词是请求，不是闸门；梦的出口只有一个——`surface` 成功即结束 fork。
- **实现**：
  - `surface` 改成可注入 `needsDailyPlan()` 的工厂：今天还只有临时排程时，第一次调用返回 `[surface blocked]`，要求先 `write_daily_plan` 再 surface；只拦一次（`nudged`），第二次坚持结束就放行，避免死循环；空文本不消耗这次拦截。
  - 梦的结束清单从"两件事"改成三条编号项（日记 → `maintain_state` → 今天的日程），并写明"结束前不写，今天还是模板"；`maintain_life` 移到清单之外。
  - 拦下时记一条日志：「梦拦下 surface：今天的日程还是临时排程，先写日程」。
- **位置**：`bots/amber/persona/subconscious/{index.ts,prompts.ts}`、`bots/amber/persona/index.ts`（`needsDailyPlan`）。
- **验证**：`tests/amber/dream-surface.test.ts` 5 项（拦一次、写完后放行、只拦一次、无生活层不拦、空文本不消耗拦截）。线上强触一次梦：15:45:06 开始、15:46:14 结束（15 次调用、68 秒），`plan.source` 变成 `dream`，10 段真实日程（13:30 醒得很迟 → …），日记与状态同时更新；这次没有走拦截（三件清单已生效），闸门留作兜底。
- **边界**：拦下只保证"会要求她写"，不保证写得好——日程质量取决于梦的素材；如果模型第二次仍不写，闸门放行，当天继续用临时排程。

### M37. 内感受基线：电量与负荷从事件里长出来
- **概念**：`RoleState` 的精力、心情都是梦写的——那是"她怎么描述自己"，一场梦就能改写。真正让"累"变得不可协商的，是事件流的物理属性：说了多少、被同一个人刷了多少遍、隔了多久。这一层不看模型，只做一条确定性的轨迹。
- **实现**：
  - `companion/intero.ts`：`InteroStore` 持久化 `data/intero.json`，两个慢变量——`socialBattery`（0–1，初始 0.75，向 1 按 180 分钟半衰期回满）与 `load`（0–1，初始 0.2，按 30 分钟半衰期回落）。
  - 记账只认 `origin==='external' && type==='qq.message'`：每条消息 −0.012 电、+0.006 负荷；同一个人同一句在 10 分钟内复读，每次额外 −0.05 电、+0.03 负荷（最多算两次）；长消息（>160 字）负荷 +0.004；她真的发出去一条，−0.02 电、+0.004 负荷。电量下限 0.02。
  - 接进 `RoleState.block()`：低电量（<45% / <25%）或高负荷（>85%）时多一行第一人称的状态说明，正常时不唠叨；注入仍按文本去重。
  - 接进 companion 的门：`gateReason()` 在精力门之后看这两项——`社交电量 X% 低于 lowBattery` 或 `手头负荷 Y% 高于 highLoad` 时不主动开口；门限来自 `companion.intero.{enabled,lowBattery,highLoad}`（默认 0.3 / 0.85），关掉就回退到只看精力与时段。
  - 面板：总览 chips 多「电量 75% / 负荷 20%」（越过门限时变警示色），新增可折叠的「内感受」卡（两条进度条 + 门限 + 更新时间）；配置页新增「内感受」卡改门限。
- **位置**：`bots/amber/persona/companion/{intero.ts,roleState.ts,scheduler.ts,state.ts,index.ts}`、`bots/amber/persona/index.ts`、`bots/amber/persona/config.ts`、`bots/amber/persona/companionPanel.ts`、`bots/amber/webui/companion.ts`。
- **验证**：`tests/amber/intero.test.ts` 12 项（扣分、复读加罚、窗口外不加罚、半衰期回落、只算她真发了、下限、落盘重读、坏文件、文案、状态块、归一化）；`companion.test.ts` 增 3 项（低电量门、高负荷门、关掉时不看）；`companion-panel` 断言 chips 数据；`tests/integration/role-state-inject.test.ts` 用真 WS + FakeLLM 断言投递后 `intero.json` 电量下降、第二条再降。线上重启后 `overview.state.intero` 返回 `0.75 / 0.2`、门限 `0.3 / 0.85`；面板 chips 显示「电量 75% 负荷 20%」。
- **边界**：这一层只进"她怎么感觉"与"要不要主动"，还没改投递层（延迟、压缩回复预算）；复读判定用正文归一化，重启后窗口清空；电量与负荷只统计她实际看到的消息，背景归档不扣电。

### M38. 记忆再固化：用过的旧事，按结局微调重要性
- **概念**：记忆之前只有两条命运——被写、被检索；检索之后结果如何，没人回头调整它。一条每次想起都只是陪跑的旧事，和一条每次被想起都帮上忙的旧事，权重一样。再固化补的就是这条反馈：用上、结局好，就稍微重一点；冷场，就稍微轻一点。增量必须很小，它是沉淀，不是投票。
- **实现**：
  - `MemoryIndex.recallBlock()`：与 `injectBlock` 同样的筛选与排版，额外交出真正进了注入文本的条目 id（被预算截掉的、没通过相关性过滤的不算）；`injectBlock` 退化为它的文本视图，旧调用不受影响。
  - `MemoryIndex.bumpImportance(ids, delta)`：`MIN(1, MAX(0.05, importance + delta))`，空/重复/不存在的 id 都安全。
  - 一轮的记账：`onDelivery` 在开新一轮时清空 `turnRecallIds`；`injectMemories` 把「认识的人」块与「想起来的一些旧事」块真正用上的 id 累进去（同一轮重复注入被去重的不算）。
  - 收口时按结局给增量（`memoryFeedback.ts`）：`sent` +0.02、`acted` +0.01、`silent` −0.01、`unsent-text` 0；没有外部输入的一轮（心跳、内部提醒）不评价。`wakes.jsonl` 每行多 `recall:{ids,delta,changed}` 供复盘。
- **位置**：`bots/amber/persona/memoryIndex.ts`、`bots/amber/persona/memoryFeedback.ts`、`bots/amber/persona/index.ts`。
- **验证**：`tests/amber/memory-reconsolidation.test.ts` 7 项（结局映射、recallBlock 的 id 与文本视图、预算截断、正负增量与上下限、坏 id 安全）；`role-state-inject` 集成测试用真 WS + FakeLLM 断言：投递后 `wakes.jsonl` 出现 `recall.ids ≥ 1`、`delta −0.01`、被用上的那条 importance 从 0.5 降到 0.49。线上重启后的内部唤醒行已带 `recall:{ids:0,delta:0,changed:0}`。amber 202 项通过。
- **边界**：结局只有"发没发、做没做事"这一层，读不懂对方是否真的被帮到；`silent` 扣分对"正确地不说话"也会略降那条记忆，增量小到短期看不出；再固化只在有外部输入的一轮发生，梦里不调整。

### M39. 内感受接进投递层：慢半拍、短回、不追问
- **概念**：M37 的内感受只改了两处文字——状态块里的一句话、主动开口的门。她"累"了，回复本身没有变。这一层把电量接到投递路径上：反应慢半拍，话说得省，不追问。
- **实现**：
  - `replyBudget()`：电量低于 `replyBattery`（默认 0.35）时 `short=true`，延迟按 `hesitationSeconds × (1 − 电量/阈值)` 缩放——刚压线不延迟，跌到 0 才到上限（默认 6 秒）。
  - `onDelivery`：这一批里有外部消息且 `short` 时，先 `await` 这段延迟再处理；每轮第一次（按 wake 去重）注入 `[本轮预算] 电量低（X%）：这一轮回短句，最多一两句；不要反问、不要追问、不要开新话题。`
  - 配置：`companion.intero.replyBattery`、`companion.intero.hesitationSeconds`，热生效；配置页「内感受」卡多了两个输入。
- **位置**：`bots/amber/persona/companion/intero.ts`（`replyBudget` / `replyBudgetLine`）、`bots/amber/persona/index.ts`（`onDelivery` 的延迟与注入）、`bots/amber/persona/config.ts`、`bots/amber/persona/companionPanel.ts`、`bots/amber/webui/companion.ts`。
- **验证**：`intero.test.ts` 增 4 项（正常不延迟、压线短回几乎不延迟、越低延迟越长且有上限、预算说明只在该出现时出现）；`tests/integration/intero-budget.test.ts` 用真 WS + FakeLLM：预置电量 0.1、上限 1 秒，发一条叫到她的消息，断言从发消息到 `[本轮预算]` 出现 ≥600ms，且文本含「不要追问」「一两句」。amber 208 项通过。线上 `config.state.intero` 返回 `replyBattery 0.35 / hesitationSeconds 6`。
- **边界**：回复长度是**预算指令**，不是硬 token 上限——`ModelSpec.maxTokens` 是连接级配置，没有按轮覆盖的通道；延迟发生在人格投递入口，不改变世界侧的合批语义（事件照样按时进库）；"不追问"没有硬拦截，靠预算指令与主动门共同约束。

### M40. 关系约束层：信任、边界与欠着的话
- **概念**：`people/` 里的「我的看法」是散文，给语气；关系不该只有语气。信任、熟悉度、刚越过的界、还欠着的一句答复，应该变成**能约束回复**的状态——决定这轮收紧多少，以及能不能先去找他。
- **实现**：
  - `relations.ts`：按 QQ 号持久化 `data/relations.json`（原子写，最多留最近活跃的 500 人）。四个量：`trust`、`familiarity`、`boundary`（未修复的越界）、`debts`（欠着的话）。
  - 事件更新只有确定性的部分：每条约会涨 1% 熟悉度；明确的越界言论（ insult / threat 词表）掉 6% 信任、抬 40% 边界并写下依据。边界按 24 小时半衰期回落，信任 30 天回中，熟悉度 90 天回落。
  - 梦的手：新工具 `maintain_relation`（trust / familiarity / boundary / debt / closeDebt / basis），提示词在 `maintain_life` 之后要求"如果这一段改变了你和他能怎么相处，就记下来"。
  - 注入：`personBlock` 在看法之后追加约束行——刚越界要短、不热络；信任低不开玩笑不说私事；又熟又信可以直接；欠着的话要兑现。即使没有档案，只要有关系记录也会生成这一段。
  - 主动门：companion 的 `poolCandidates` 在给某个会话造候选前先问 `relationBlock(subject)`；刚越界（≥0.6）或信任 <0.2 的人，不先去找他。
  - 面板：用户抽屉多一块「关系约束」（信任/熟悉/边界/依据/欠着的话）。
- **位置**：`bots/amber/persona/relations.ts`、`bots/amber/persona/relationTool.ts`、`bots/amber/persona/index.ts`（观测、注入、梦工具、companion 选项、面板 deps）、`bots/amber/persona/subconscious/prompts.ts`、`bots/amber/persona/companion/{scheduler,index}.ts`、`bots/amber/persona/companionPanel.ts`、`bots/amber/webui/companion.ts`。
- **验证**：`tests/amber/relations.test.ts` 11 项（默认值、事件更新、衰减、约束行、主动门、补丁与兑现、落盘/坏文件、非 QQ 忽略）；`companion.test.ts` 增 1 项（关系拦下时不产生候选）；`companion-panel` 断言详情里的关系块；集成 `tests/integration/relation-constraint.test.ts`（真 WS + FakeLLM）：预置边界 0.7 与欠账后，上下文里出现「刚越过界」「谈不上信任」「还欠他一句答复」；再发一条越界言论，`relations.json` 的信任降到 0.2 以下、边界升到 1。
- **边界**：越界检测只有词表，误伤与漏检都会有；信任主要靠梦写，机制只负责"冒犯时掉"；欠着的话不会自动过期，需要梦兑现或清掉；关系约束是注入行与主动门，不是硬拦截——她仍然可以选择回得热络。

### M41. 「在干嘛」先看日程：时间线进注入，旧 busy 让位
- **概念**：被问「下午在干嘛」时，她绕过日程、把几小时前说过的话又说了一遍。根因不是记性，是**上下文里只有"现在这一段"，而且状态块里那句 15:46 梦写的「手头」比日程更显眼**：19:16 那一轮的注入里，生活块只写了 `现在 19:15–21:30 在群里的时间`，没有下午的任何一段；状态块却写着 `手头：整理昨晚的记录`，于是她照着旧 busy 答了「翻自己的旧账」——和 19:09 那句几乎一样。
- **实现**：
  - `lifeBlock` 改成**整条时间线**：按本地时段分组（凌晨/早上/上午/中午/下午/晚上/深夜），逐段给 `HH:MM–HH:MM 活动`（活动截到 22 字），再单独一行 `现在：…`。被问今天/下午/刚才，都能从时间线上答；开头规则改成正向指令："按这条时间线回答；不要拿「手头」的旧状态代替，也别把上一轮说过的话再说一遍"。
  - `RoleState.block(intero, { busy, presence })` 支持覆盖：有当前日程段时，`手头` 用 `按日程：<当前活动>`，`公开状态` 用当前活动压出的短标签（第一个分句、最多 8 字，如「群里的时间」）。梦写的旧 busy / 旧 presence 让位——它们在每一轮注入里重复出现，正是把她带回旧话题的锚。状态块头部的说明也改成明确的优先级——问"在做什么"按「手头」，问"怎么了"才说精力心情。
  - QQ 草稿加**重复提醒**：记录每个会话里她上一句真正发出去的话；新草稿与它的 bigram 相似度 ≥0.7 时，草稿回执里多一行 `[repeat warning] 你上一句已经说过很接近的话…别原样再说一遍`。不是拦截，是让她看得见自己在复读。
- **位置**：`bots/amber/persona/companion/{lifeState.ts,roleState.ts}`、`bots/amber/persona/index.ts`（`injectRoleState` 的 busy 覆盖）、`src/worlds/qq/world.ts`（重复提醒）。
- **验证**：`life-state.test.ts` 断言时间线里有「上午：09:00–10:42…」「中午：」与新的「现在：」格式、含"不要拿「手头」代替"，以及 `shortActivity` 的短标签；`role-state.test.ts` 增 2 项（有日程时手头用覆盖值、公开状态也跟着当前段，旧值不出现）；新增 `tests/worlds/qq/repeat-warning.test.ts`（发一句 → 相近草稿触发提醒 → 不同的话不触发）。QQ 世界 + amber 共 405 项通过。线上重启后的注入已变：`手头：按日程：群里的时间…；公开状态：群里的时间`，生活块按「中午/下午/晚上/深夜」列出当天全部 10 段，并有「现在：19:15–21:30 群里的时间」。
- **边界**：重复提醒只比对同一会话最近五句、用字面 bigram，语义相近但措辞完全不同的复读抓不到；时间线的活动被截到 22 字，长句细节会丢；公开状态是活动第一个分句截 8 字，个别活动会截得生硬。

### M42. 时间问题的定向注入：把"下午"那几段单独递到她眼前
- **概念**：M41 给了整条时间线，但那是背景——被问「下午在干嘛」时，她仍可能不去翻十条里的那三段。这一步在提问发生时做识别与裁剪：问的是哪一段，就只把这一段放到她眼前，并附上她上一句说过的话。
- **实现**：
  - `companion/grounding.ts`：`detectTimeScope()` 认「下午 / 上午早上 / 晚上 / 刚才 / 在干嘛 / 今天」，具体时段优先于泛问；`groundingBlock()` 按段裁出对应几段（问"刚才"给最近两段已完成的加"现在"，问"现在"给当前段），标题明确「他问的是你的 X」，末尾附上一句「你上一句已经说过：「…」，别把同一件事再说一遍」。
  - 人格投递路径：`onDelivery` 在记忆注入之后调用 `groundTimeQuestion()`，每个 wake 只注入一次；上一句从 Companion 的 `snapshot().convs[].lastBotText` 取（新暴露的字段）。
  - QQ 草稿的重复提醒升级为**最近五句**参与比较，取最像的一句点出来。
- **位置**：`bots/amber/persona/companion/grounding.ts`、`companion/index.ts`（`lastBotText`）、`bots/amber/persona/index.ts`（`groundTimeQuestion`）、`src/worlds/qq/world.ts`（五句历史）。
- **验证**：`tests/amber/grounding.test.ts` 6 项（识别优先级、下午只给下午、现在给当前段、刚才给最近两段、带上一句、无日程不注入）；`tests/integration/grounding-inject.test.ts`（真 WS + FakeLLM）预置下午两段与上一句，发「claude 下午在干嘛」，断言上下文出现「他问的是你的下午」「把昨晚的对话翻回去核一遍」「整理笔记」与「上一句已经说过…别把同一件事再说一遍」；`repeat-warning` 改为隔一句复读也能触发。amber + QQ + 集成 47 项通过。
- **边界**：识别靠时间词与问句模板，换一套说法（「今天都忙了些什么呀」能中，"你都干了啥"中"干了啥"不在词表）会漏；只处理当天日程，问"昨天"没有数据；定向块每轮只注入一次，同一轮里追问两次只有第一次生效。

### M43. 记忆注入的去重不能跨窗口：跳过要说清是"空"还是"重复"
- **概念**：自动召回有两道去重——「这个人是谁」块与「旧事」块，块没变就不重复占位。去重按内容比，但窗口会换：交接、清空、compact 之后同一块已经不在她眼前，只比内容就会一直跳过，而唤醒日志里只有一个 `ids: 0`，看不出是没召回还是被吞掉。
- **实现**：
  - 去重前先回 snapshot 确认那一块还在窗口里（`stillInContext()` 扫 session 记录），不在就重新注入。人名块同样处理。
  - `onHandoff` 里把两块去重记录作废——旧窗口的痕迹不该影响新窗口。
  - 跳过不再是静默的：`wakes.jsonl` 的 `recall` 增加 `skipped: 'empty' | 'dup'` 与 `personSkipped`，`dup` 时另记一条 INFO 日志。
- **位置**：`bots/amber/persona/index.ts`（`injectMemories`、`stillInContext`、`onHandoff`、`onTurnEnded`）。
- **验证**：`tests/integration/memory-inject.test.ts` 新增用例——同一句话连发两次，第二次 `recall.ids=0` 且 `skipped='dup'`；`clearSession()` 之后同一句话重新注入，`skipped` 为空。反向验证：把条件改回「只比内容」，该用例在清空窗口后超时（块不再出现）。
- **边界**：`stillInContext` 是整块字符串匹配——交接笔记把某一行摘进笔记时不算"块还在"，会多注入一次；这是宁可重复也不丢的取舍。

### M44. 自我叙事：前缀里终于有「我自己」
- **概念**：ROADMAP 判定她"没有『我』"——前缀里有世界观、有人名册、有别人做过什么，没有一段是她自己此刻在意什么、对谁改观了。这一步补 `memo/self.md`（当前自述）与 `note/opinions/`（对人对事的看法），由梦维护、醒着的她读。
- **实现**：
  - `memo/self.md` 单独一段进前缀，**只取开头 200 字**（落行边界 + 省略号），全文仍在工作区，想看用 read_file；因此它不再混进常驻 memo 全文。
  - `note/opinions/` 只把**文件名**列进前缀（一份一个对象），正文按需读——和 playbook 同一套路。
  - 梦的整理规则新增第 12 条：`memo/self.md` 是当前自述不是日志，控制在 200 字内、第一行必须最要紧；会随时间改变的对人对事判断写进 `note/opinions/`，每次改主意留一行带日期的理由。
- **位置**：`bots/amber/persona/memory.ts`（`selfSummary`、`memory.self`、`memory.opinions`）、`bots/amber/persona/MEMORY.md`、`bots/amber/persona/subconscious/prompts.ts`。
- **验证**：`tests/amber/memory-self.test.ts` 5 项——self 单独成段不进常驻、超过 200 字落在行边界并收省略号、缺文件走空态、opinions 只列名、模板留了位置。
- **边界**：自我叙事的内容质量取决于梦；空文件时前缀是空态，不会凭空编。

### M45. 话头与开口预算：走之前留一句，自己约时间说话
- **概念**：她一天只醒几分钟，"待会儿想说什么"过去只能靠 `schedule_wake` 在被唤醒的那几秒里想到。补两件：`leave_thread`（留一句给下次被叫醒的自己）与 `speak_later`（用每日开口额度约一个时刻说话）。
- **实现**：
  - `ThreadStore`（`data/threads.json`）：话头最多 5 条，超了先挤掉已提过的、再挤最旧的；递过一次就标记，不重复念。
  - 投递时 `surfaceThread()`：只有**外部消息**叫醒时，把最旧一条未提过的话头递回去一次，文案「你走的时候留了句话……还作数吗？」——定时器、心跳、梦的浮现都不递。
  - 开口预算：`companion.speak.enabled / dailyCap`（默认开、每天 2 次）；用不完的带一点到第二天，总量封顶 1.5 倍；额度用完工具直接拒绝，不重试。
  - `ORIENTATION.md` 加一段自述这两件工具什么时候用；`leave_thread`/`speak_later` 的说明写在 schema 里。
- **位置**：`bots/amber/persona/threads.ts`、`bots/amber/persona/tools.ts`、`bots/amber/persona/index.ts`、`bots/amber/persona/config.ts`。
- **验证**：`tests/amber/threads.test.ts` 8 项（留一句/提过不提/上限挤旧/文案；当天额度、结转封顶、用完拒绝、首次运行不多给）；`tests/integration/thread-inject.test.ts` 预置一条话头，被叫醒时出现一次、第二次唤醒不再出现。
- **边界**：话头只在外人来找时递，自己约的 `speak_later` 唤醒不会触发；额度按本地日滚动，跨时区部署以部署时区为准。

### M46. 前缀瘦身：从 19.5k 到 10,408 字
- **概念**：ROADMAP 2.3——16.8k 前缀里宪法吃掉四成，常驻备忘与梦的浮现又把剩余撑满。钱花在"怎么做"的例句上，而真正决定像不像人的是当下状态。
- **实现**（两轮：先砍死重，再按授权动行为文本的措辞）：
  - 宪法分层：`deployments/amber/memory/CONSTITUTION.md` 从 21.1k 字节压到 ~11.6k——性格六节各收成一段行为描述，例句、两拍结构、不满/害羞/开心的样本整体挪进 `note/playbook/我的句子.md`，宪法里留两处指针。
  - 常驻 memo 单条上限 350 字（超出注明"全文用 read_file 读"）；梦的浮现只放最近 2 条、每条 60 字。
  - 名册每行摘要压到 30 字——但**曾用名整段保留**，旧名可检索这条不能被截断（roster 测试就是因为先截整行、把曾用名截掉而红过一次）。
  - 工具说明、ORIENTATION、QQ 环境、console 环境全部改写压缩；`MEMORY.md` 模板去掉冗余说明。
- **验证**：`GET /api/prompts/prefix` 实测六段：ORIENTATION 668→517、宪法 7578→3838、console 375→289、QQ 环境 3138→2036、Using your tools 1343→824、记忆 6434→2476，**总计 19,536→9,980 字（-49%）**；后来把两拍示例与一句「只拒绝/只表态/只讲机制都不是这两拍」搬回宪法，现为 10,408 字。
- **边界**：**被撤走的常驻内容是例句**——那几句「我没事，真的。」→「你这句话说得太顺了，像练过。药吃了吗？」原本每轮都在眼前，现在只有她主动读 `note/playbook/我的句子.md` 才看得到；语气可能因此变平，判据是接下来几条消息有没有回落到客服腔，若有，就把两拍结构整段搬回宪法（约 +300 字）。另外名册摘要、常驻备忘、浮现都被截断，信息没丢但要 read_file。

### M47. 线索不等于每句都叫醒：纯附和不跑模型
- **概念**：M35 的注意力只拦"没叫到她"的消息；只要线索开着，对方发一句「哈哈哈」也会叫醒她跑一轮完整模型。线索是"他再说话你能听见"，不是"每句话都值得跑一轮"。
- **实现（两版，第一版是错的）**：
  - 第一版把门槛绑在显著性分数上（`judged.tier === 'background'` 就归档）。**上线一小时后翻车**：分数里带着"群里 15 条正吵、负荷高、这个人连说 6 条"这些群噪音惩罚，群里一热闹，任何人说话都掉到 0.35 以下，于是她在线索上也不再开口——11:47–11:48 连续三条有内容的发言被归档，群里看着就是"她不回人"。
  - 第二版改问**这条消息本身有没有内容**：`isFillerMessage()` 只认纯表情（`[表情:…]`）、单字重复（哈+/嗯+/好+…）和常见应答（收到/好的/谢谢…），其余在线索上照常叫醒。群有多吵不再影响这条判断。
- **位置**：`src/worlds/qq/salience.ts`（`isFillerMessage`）、`src/worlds/qq/world.ts`（投递判决处）。
- **验证**：`salience.test.ts` 新增 9 组正反例；`attention.test.ts` 新增两例——「先叫一声开线索 → 发『哈哈哈哈』归档 → 同一线索上的真问题照常叫醒」、「群里连刷 12 条后，一句有内容的『你才是大肥鱼！』仍然叫醒」。反例证明分数不能当"是不是废话"的判据。
- **边界**：只按字面；一句很短但真要紧的话（「完了」）可能被当成附和归档，等下一次被叫到再搭车带出。

### M48. 时间感：把「六个小时前」放进她眼前
- **概念**：绝对时间戳是数据，"距上次和这个人说话六小时"才是体验。关系档案里本来就有 `updatedAt`（上次听到此人说话的时刻），只是从没被注入过。
- **实现**：`RelationStore.gapMinutes(qq)` 读原始记录（不走 `get()`，那里会顺手衰减并改写时间）；`onDelivery` 在 `observe` **之前**算间隔，超过 30 分钟就注入一行「[时间] 距上次和你说话：6 小时前」。同一段对话里不啰嗦。
- **位置**：`bots/amber/persona/relations.ts`（`gapMinutes`、`humanGap`）、`bots/amber/persona/index.ts`（`injectTimeGap`）。
- **验证**：`relations.test.ts` 新增 gap/人话两条；`tests/integration/time-gap.test.ts` 预置六小时前的记录，断言注入「6 小时前」且紧接着的第二句不再重复。
- **边界**：只按人算，不按会话；跨天只给到「X 天前」，没有具体日期。

### M49. 多模态：图是语气工具，先有索引再谈发
- **概念**：ROADMAP 2.7——`qq_draft` 一直支持 `image`/`voice`，但提示词从没教过她什么时候该用，图库里也没有「这张表达什么」的标签，她选不出来。
- **实现**：
  - QQ 环境提示词新增「发图与语音」：图用于想笑不想打字、接梗、道晚安、被点名要表情包；发之前先查 `note/playbook/表情包.md`，索引里没有合适的就不发。语音只在深夜、哄睡、认真道谢这类场合；一次最多一张图或一条语音；别人发的图要 `save_blob` 存进来再进索引。
  - 梦的整理规则新增第 13 条：维护 `note/playbook/表情包.md`，一行一张「文件名 — 它表达什么」，只写真的看过的图，文件名不猜内容，文件没了就删行。
- **位置**：`deployments/amber/worlds/qq/ENV_PROMPT.md`、`bots/amber/persona/subconscious/prompts.ts`。
- **验证**：提示词层改动，靠下一次梦生成索引后实机观察；`tests/amber/dream-surface.test.ts` 等回归覆盖提示词结构未破。
- **边界**：索引质量取决于梦看图的能力与频率；图库只有一张时这条规则几乎不会触发。

### M50. 补拉的消息是"过去"，就地提醒一句
- **概念**：13:09 那次重启补拉投了 30 条离线消息，她直接把 12:0x 的挑衅当现在接，回了一句防守式表态（「在。不过我不是谁的，这句记一下。」）。ENV 里其实写着"先承认刚回来"，但那段文字离数据太远，她没照做。
- **实现**：补拉块尾部就地加一行——「这些是你不在这段时间里发生的事。先说明自己刚回来，再挑最该回的那一条回应；不必逐条补答，也不要问『你们刚才在聊什么』。」
- **位置**：`src/worlds/qq/world.ts`（补拉文案组装处）。
- **验证**：`tests/integration/qq-catchup.test.ts` 增加断言（补拉文本必须带这一句）；2 项通过。
- **边界**：只是提醒，不阻止她把旧事当现在接；真正的时间感仍靠 M48 的间隔注入。

### M52. 三个结构性根因：电量按条数扣、预算只会说"不要"、身份每十几分钟重写
- **概念**：一天内她越来越收着，改提示词只是按住症状。查数据发现三处结构：
  1. **电量按群消息条数扣**（−0.012/条），群里一热闹必然见底——实测掉到 3.6%；见底后注入"这一轮最多一两句；不要反问、不要追问、不要开新话题"。等于"群越吵她越哑"。
  2. **每轮注入 20–28 条否定句**（不要/别/不必），几乎没有正向的"怎么说"。
  3. **身份文件按对话节奏重写**：宪法今天被改 8 次（昨天 2 次）；交接在测试期 10–20 分钟一次，每次梦都能改；最近三份交接笔记（16–22k 字符）里"采样/被试/收着/不评"命中 0→7→7，防御框架在链上自我放大。
- **实现**：
  - `InteroStore.observe()` 的耗电改为看**这条是不是冲她来的**：被点名 −0.02、线索续上 −0.008、群里普通一句 −0.002（复读仍 +0.05）。群里热闹只耗一点神，不再等于被人当面找。
  - `replyBudgetLine()` 从禁令改成给法：「句子比平时短一点，一句能说完就一句；想接就接一句，不想接可以不说。」
  - 新增 `identityBudget.ts`：`CONSTITUTION.md` / `WORLDVIEW.md` 两次修改之间至少隔 6 小时，`writeGuard` 硬拦并告诉梦"先写进 note/ 或 people/"；观察照常记，只是不许每十几分钟把观察升级成"我是谁"。
  - 旧模型留下的 3.6% 电量是读数错误，手工校正到 0.55。
- **位置**：`bots/amber/persona/companion/intero.ts`、`bots/amber/persona/identityBudget.ts`、`bots/amber/persona/index.ts`（`writeGuard`/`identityCooldown`）。
- **验证**：`intero.test.ts` 17 项（新增「被点名 > 线索续上 > 群里普通一句」，并断言预算行不含「不要」）；`identity-budget.test.ts` 4 项；`intero-budget` 集成改为断言预算行给的是说法；amber 247 项通过。
- **边界**：否定句密度只降低了内感受这一路；`people/` 的「我的看法」仍会把她自己的规则句带进每轮，下一轮要处理的是"注入块里的正向/负向比例"，不是再加机制。


### M54. 动作描写：三处场景、一条上限、一个开关
- **概念**：宪法原写「不写舞台描写」，但有些时刻动作是**必要信息**而不是装饰——睡着被叫到、被打断、被夸到不好意思。开法不是解禁，而是给场景、给上限、给开关。
- **实现**：
  - `bots/amber/persona/gesture.ts` 每轮注入一句（不进宪法正文）：醒着且开着时写「动作不是表演：被点名让你『演一个』可以拒绝；只有身体状态真影响这句话时才写一处」，并按她手头的事给样例（读书→（把书合上）、整理→（停下笔））；睡着时换成「不回 / 八字以内的迷糊短句或拟声，最多一处动作；同一个人叫第二遍才迷糊地醒一句」。
  - 开关 `gesture.enabled`（默认开，WebUI 可见）：关掉后醒着不注入任何动作提示、宪法那条同时失效，下一轮生效；睡着仍注入纯文字版。
  - 宪法「不写舞台描写」改成「由每轮那行提示决定」；草稿回执加密度提示（一条超过一处、或最近五条已有两条带动作就提示换纯文字）。
- **位置**：`bots/amber/persona/gesture.ts`、`bots/amber/persona/index.ts`（`injectGesture`）、`bots/amber/persona/config.ts`、`src/worlds/qq/world.ts`（草稿回执）、`deployments/amber/memory/CONSTITUTION.md`。
- **验证**：`gesture.test.ts` 5 项、`repeat-warning.test.ts` 密度 2 项、`gesture-switch` 集成 2 项（关掉时上下文一次都不出现 `[动作]`）；开关已出现在 `/api/config`。
- **边界**：第一版写「可以写」，两小时零使用，19:40 她明确拒绝「动作不是节目」；第二版改成「不是表演、可以拒绝演一个」并按手头的事给样例。上线后仍未见实际使用，说明"许可"赢不过"不表演"这条价值——下一步要么只保留睡觉场景，要么接受她的判断关掉开关。

### M55. 控制台事件窗口：时间、图标、提示浮层
- **概念**：查「她为什么这么答」时，时间线上一次唤醒被拆成两块互不相连的东西——USER 块里是这一轮注入的全部内部提示（揉成一段纯文本，没有类型、没有逐条时间），后面是 `external_event_frame` 卡（这一批外部事件）。要追因只能去 `session-main.jsonl` 里数行。
- **实现**：
  - 服务端：合并那条 user 消息时写 `context.internals = frameEventRefs(internals, 0)`（复用已有函数，逐条 `start/chars/type/ts`）。纯元数据：不进请求体、不改 `item`、不改 token 计数。
  - `withText()` 替换正文时删 `context.internals`（偏移失效）；**`context.frame` 一律不动**——`requeueUndelivered()` 靠它判断哪些外部事件已投递，删了会让重启后重复补投同一批事件。
  - 前端 `timeline.ts`：事件帧不再画成工具卡，改成 `.evwin` 单元——头部 `⚡ HH:MM:SS · N 条事件 · M 条提示`，提示区吸收前面那条 USER 块（节点移动，不重建），事件区放回执正文。三形态：A 完整窗口、B `inUser` 模式（两段在同一条消息上）、C 内部唤醒（普通 USER 块 + 可 hover 摘要条）。
  - 浮层挂 body、hover 开、点击固定、Esc 与滚动关闭；有 `getBoundingClientRect` 才定位，没有就降级成宿主卡内静态块（迷你 DOM 桩走这条）。`rebuild()` 入口先收面板再重画（fork 每 3 秒轮询一次）。
- **位置**：`src/protocol/open-responses/context.ts`（`internals`、`withText`）、`src/core/loop.ts:700` 附近、`src/web/client/features/live/timeline.ts`、`src/web/client/features/live/strings.ts`、`src/web/public/styles.css`。
- **验证**：`tests/core/loop.test.ts` 新增 2 项（internals 逐条切回原文；折叠后 internals 消失而 frame 保留）；`tests/web/feature-live.test.ts` 新增 3 项（吸收成单元 + 浮层分组与复制按钮、内部唤醒落单、越界标失效），旧的「事件帧是工具卡」断言按新行为改写；`tests/core + tests/web` 102 文件 1733 项通过；`typecheck` / `typecheck:web` / `build:web` 干净。
- **边界**：浮层只是控制台读数，不进 session、不影响她的上下文；`internals` 目前没有第二个消费者，将来谁要用得先确认正文不会被折叠替换。


### M57. 启动不再默认暂停：重启回来就能说话
- **概念**：`bin/cortico.mjs` 给每个受管子进程塞 `CORTICO_START_PAUSED=1`，于是每次重启（手动、崩溃后、WebUI 重启）都要再调一次 `POST /api/run/resume`，否则她一直哑着。这是运维习惯，不是保护机制。
- **实现**：
  - 默认值从 `'1'` 改成 `'0'`；仍可用 `CORTICO_START_PAUSED=1` 或 `--paused` 显式暂停。
  - 新增 `GET /api/run/paused`：启动后不调 resume 也能自查是不是暂停着，不用靠"她回不回话"猜。
  - `tests/integration/start-paused.test.ts` 新增反例：「不设暂停就启动：boot 批自己处理，不需要人工 resume」（bus 未暂停、LLM 被调用、队列清空）。
- **位置**：`bin/cortico.mjs`、`src/web/server.ts`。
- **验证**：用 `node bin/cortico.mjs amber` 起服务 → `GET /api/run/paused` 返回 `{"paused":false}`，启动段没有「⏸ 已暂停」；随后 `POST /api/run/restart` 让 supervisor 重拉，回来仍是 `{"paused":false}`，boot 批自己跑完（`wakes.jsonl` 出现 `internal / 进程重启,session 已续上`）。`start-paused` 2 项通过，`typecheck` 干净。
- **边界**：supervisor 只在"收到重启请求 / 存在重启标志文件"时重拉；进程崩溃不会自动重启——那是另一件事，没做。


### M56. 自动召回排不进前三条：候选池、近重复、向量分挤在一起
- **概念**：10-28 14:25 那次测试，她答对了「档案被贴到群里」那件事——但功劳是她自己补了一次 `recall_memory`。同一轮的**自动注入块里三条全无关**（10-26 阿姆斯特丹 ×2、晚饭那句）。查下去是三个问题叠在一起。
- **实测**（用真实索引 + 真实向量跑同一句问话）：目标条排第 6，`bm25=0.222 rare=2 vec=0.308`，**过得了阈值**；但 `injectTopK=3` 且候选池就等于 k，排第 6 的永远不会被看见。前两名是同一件事的两条（近重复），占掉了名额。全场向量分挤在 **0.26–0.35**，区分度极低，排序几乎只剩重要性与新旧。
- **实现**：
  - `recallBlock` 候选池改为 `k*3`，出块前按 bigram 重合度 ≥0.5 去重（同一件事的两种写法只留一条），再取到 k 为止。
  - `memory.injectTopK` 默认 3 → 5（注入块上限仍是 700 字）。
  - 顺手修 `grep_files` 的报错：她传 `path: "persona"` 时得到的是「persona 不存在」，现在补一句「工作区根目录本身就是 persona/，路径写相对路径或省略 path」。
- **位置**：`bots/amber/persona/memoryIndex.ts`（`overlapRatio`、`recallBlock`）、`bots/amber/persona/config.ts`（`injectTopK`）、`bots/cormini/persona/workspaceTools.ts`（grep 提示）。
- **验证**：同一句问话再跑 `recallBlock(k=5)` —— 近重复被合掉，**目标作为第 4 条进入注入块**；`memory-index.test.ts` 新增「近重复只占一个名额」1 项（21 项通过）；`amber + integration` 302 项通过；已重启，协议端 online。
- **边界**：向量分区分度差是模型层面的问题，这次只修了"选谁进块"，没修"谁更相关"；注入块里仍会混进一两条无关的旧事。
- **第二轮（同日 15:0x）**：光扩池不够——向量分 0.26–0.35 直接进加权等于没排序，旧事永远排不过最近说过的那几条。改成先按经验区间归一化 `vecNorm=(vec-0.22)/0.28`，再用 `lexical=0.6*bm25+0.4*min(rare/3,1)` 做主权重：有向量时 `0.55*lexical + 0.25*vecNorm + 0.2*(0.5*importance+0.5*recency)`，无向量时 `0.65*lexical + 0.35*tie`。三句真实问话实测：目标排名 **6→2**、2→2、1→1；注入块里目标从"不存在"变成第 2 条，同一事件的控制台密码那条落到第 5。`memory-index` 21 项、`amber + integration` 302 项通过。
- **可观测（同日 15:1x）**：14:44 那次她答对了「等停顿再补」，但**又自己调了一次 `recall_memory`**；用现行代码重放同一句问话，自动块里目标已经是第 1 条——链路通了，卡在"她不信自动块"。为了不再靠猜，唤醒日志的 `recall` 增加 `head`：注入块的第一行（前 50 字）。下次问完直接看 `wakes.jsonl` 就知道她当时眼前是哪条旧事。`memory-inject` 增加对应断言。
- **提示（同日 15:2x）**：注入块的收尾改成「这些是过去的记录，**已经替你检索过：先用这一块，不够再调 recall_memory**」；`recall_memory` 的工具描述同步加一句「唤醒时眼前通常已经有一块，先看它」。`memory-index` 增加一条断言（块尾必须含「先用这一块」）。
- **实测（同日 15:5x）**：两问都答对，且**都没有再调 `recall_memory`**——15:54「这不是你的错…你当时接了没有？」答「没接。我说的是『抢话是我抢的，系统没逼我』。」；15:57「你第一次进这个群是什么时候？」答「10 月 23 号下午。之前群史是空的」。
- **观测修正**：`recall.head` 只记第一条，而第一条常被「我在这个群里的昵称」这类身份条占掉，看着像没召回到。改成 `recall.heads`（前三条各 40 字），`memory-inject` 断言同步改为看数组。





- **概念**：她原来在宪法里明写「不写舞台描写」。但有些时刻动作是**必要信息**而不是装饰——睡着被叫到（`Zzzz…` / 「（翻身）……不要动我」）、被打断、害羞到说不完整句。开法不是解禁，而是给场景、给上限、给开关。
- **实现**：
  - `bots/amber/persona/gesture.ts` 每轮生成一句提示（注入，不写进宪法）：
    - 醒着 + 开：「可以写动作，一条最多一处括号、十二字以内；只在身体真在场时（睡前、刚醒、被打断、害羞、手里忙）。装饰性动作与状态标签不写。」
    - 睡着：「你在睡。被叫到只做三件事之一：**不回（首选）**；八字以内的迷糊短句或拟声，最多带一处动作；同一个人叫第二遍才迷糊地醒一句。」关掉时换成"纯文字、不写括号"。
  - 开关 `gesture.enabled`（默认开）：关掉后醒着**不注入**任何动作提示（宪法第 49 行同时失效），睡着仍注入"纯文字"版——下一轮生效，不必重启、不必改文件。
  - 宪法「不写舞台描写」改成「由每轮那行提示决定」：有许可才写、最多一处；装饰性与状态标签永远不写。样例仍在 `note/playbook/我的句子.md`。
  - 草稿回执加密度提示：一条里超过一处动作 → 提示删多余；最近五条里已有两条带动作 → 这条用纯文字。
- **位置**：`bots/amber/persona/gesture.ts`、`bots/amber/persona/index.ts`（`injectGesture`）、`bots/amber/persona/config.ts`（`gesture.enabled`）、`src/worlds/qq/world.ts`（草稿回执）、`deployments/amber/memory/CONSTITUTION.md`。
- **验证**：`gesture.test.ts` 4 项（许可/关闭/睡着/数动作）；`repeat-warning.test.ts` 新增密度两例；`gesture-switch` 集成 2 项——开着时上下文出现 `[动作] …最多一处`，关掉时**一次都不出现**；`amber + worlds/qq + integration` 489 项通过；线上前缀 11,098，「动作由每轮提示决定」在位，`gesture.enabled` 已出现在 WebUI 配置。
- **边界**：开关只管"提示注不注入"，不拦她真的发了带动作的话；判据仍是「去掉括号后这句话还成不成立」。
- **第二版（同日 19:1x）**：第一版写的是「**可以**写动作」+「装饰性的不写」。结果两小时零动作——注入确实在（`session-main.jsonl` 里 15 处），但她把这句读成宽松许可，又把「（把书合上）」也算进"装饰性"。改成**条件性应当**：「遇到这些时刻，写一处动作比不写更像人：被叫醒或被打断、被夸被逗到不好意思、接梗递东西」；「装饰性」收窄成"与话题无关的自我描写（撩头发、喝红茶）"；给两个十二字内样例校准长度。


### M53. 沉默策略：宣布「不接」也是开口
- **概念**：13:20–13:40 的 13 条回复里有 4 条是拒绝式，其中两条是同一句拒绝的再版（13:21「这种我不评。」→ 13:39「对，这类我都不评。」）。她该沉默时却用一句元陈述盖章——因为规则里**没有把"不回复"写成一种合法的回答**：ENV 把「有人直接向你提问」列为必须开口的情形，于是被追问时她只能"答内容"或"宣布不答"，没有第三条路。
- **实现**：
  - ENV「不要开口」清单补一条：同一件事已经拒绝过、对方换个问法又来——第二遍不回复就是回答，再说一句「不评」等于又开了一次口。
  - 宪法「被看着的时候」改成两步：第一次划界线就明说、给台阶；第二遍不回复就是回答——沉默不是摆立场，是不必再开一次口。
  - QQ 草稿回执加 `[silence hint]`（与 repeat warning 同构，只提醒不拦截）：草稿是拒绝式（不评/不接/不聊/换个话题/这类我都不…）时点一句"要划界线就明说"；若最近五句里已经拒绝过，则直接说"不回复就是回答，可以直接 end_turn"。
- **位置**：`src/worlds/qq/world.ts`（`REFUSAL` 与草稿回执）、`deployments/amber/worlds/qq/ENV_PROMPT.md`、`deployments/amber/memory/CONSTITUTION.md`。
- **验证**：`tests/worlds/qq/repeat-warning.test.ts` 新增一例——第一次拒绝给"明说"提示、发过之后再拒绝给"不回复就是回答 + end_turn"、普通回复无提示；`typecheck` 干净；线上前缀 10,829，两处新规则在位。
- **边界**：提示不阻止她发送；真正的验收是同一人被追问时 `wakes.jsonl` 的 outcome 是否变成 `silent`，这要等下一轮实际对话。


### M51. 规则不能由「被测试的那几场」写成
- **概念**：10:00–13:40 全量回看发现，她越被测越收着。宪法里被梦写成「第二次只用指出已经说过，第三次不说话就是回答」，群主档案的「我的看法」写着「他要的是我被测出来的样子……被当样本的时候，我可以只给一部分」；于是同一小时里出现四次「不评 / 不接 / 不写」，对最熟的群主（trust 0.72、熟悉 0.97）比陌生人还硬——给阿摆的是完整观察，给群主的是「不写。」。这不是单条规则错，是**梦把每一场测试都固化成永久姿态**。
- **实现**：
  - 梦新增第 14 条：写进宪法的规则必须在产生它的那场对话之外也成立；只写形状（注意什么、怎么做），不写计数策略（「说两遍就不理」），不写对某人的长期姿态（「他在采样我，所以收着」）；如果新加的规则只会让她更冷、更静、更防备，就停手。
  - 宪法新增「被看着的时候」：分清认真问 / 逗我 / 采样，只有采样才收着；同一句拒绝第二遍换一句带台阶的话，不把沉默当立场。
  - 关系行「你们是熟的：可以直接一点，不必客气」改成「可以省客套、可以开玩笑，但不抢白、不给脸色——熟不是许可」。
- **位置**：`bots/amber/persona/subconscious/prompts.ts`（规则 14）、`deployments/amber/memory/CONSTITUTION.md`（被看着的时候）、`bots/amber/persona/relations.ts`。
- **验证**：`relations` 13 项、`dream-surface` 5 项、`dream-tools` 1 项通过；线上前缀实测 10,769 字，「被看着的时候」与两拍示例都在。
- **边界**：已经写死的三处姿态由人工改成"形状"——宪法「避免」里的计数规则（原「第三次不说话就是回答」）、群主档案两处（原「他要数据，我不当样本……这条不解释第二遍」与「他要的是我被测出来的样子……只给一部分」）。改法：保留观察，去掉计数与对人的长期姿态。`POST /api/session/reload-prefix` 已生效，前缀 10,765 字，旧句不再出现。




### M58. 记忆质量两件：先量再选权重，索引顺手去重
- **概念**：上一版把词法权重提到 0.55 是凭直觉（"向量分挤在一起没用"）。真正的问题是**没有评估集**——只能靠零散几次问答猜。这一步先建尺子，再按尺子改。
- **实现**：
  - `scripts/recall-eval.ts`：14 条「问话 → 该想起的那条」，同一批候选按多种公式重排，输出目标排名 / hit@5 / MRR。需要 embedding key，只读索引。
  - 实测五版：原公式 93%/0.62、词法为主 93%/0.70、纯词法 86%/0.71、均匀 93%/0.82、**偏向量 0.4/0.45/0.15 = 100%/0.86**。按结果把打分改成 `0.4*lexical + 0.45*vecNorm + 0.15*tie`（无向量时 `0.75*lexical + 0.25*tie`）。难例（"我一天烧多少钱"）从第 21 名升到第 4。
  - `MemoryIndex.dedupe()`：同类内 bigram 重合 ≥0.75 的配对，留下更全的那条，另一条标 `status='merged'`（不删、不进检索、`sweep` 也不会把它复活）；`dedupeIfDue()` 每天最多一次，接在 `sweepIfDue()` 后面。
  - `pnpm memidx --bot amber dedupe [--dry] [--threshold 0.8]` 可以预演和手工跑。
  - 梦的提示词加一句：同一件事只写一条，接着写已有那条，而不是再开一条。
- **验证**：线上库实跑 `dedupe` 合并 3 条（0.86 / 0.86 / 0.83 三组），复检 0 组；`memory-index` 22 项（新增合并用例：留长的、跨类型不动、merged 不进 recall）、`amber + integration` 304 项通过；`typecheck` 干净；已通过 supervisor 重启，`/api/run/paused` 为 false。
- **边界**：0.75 阈值只抓"几乎同一句"的重复；同一事件的"经过 / 抽查 / 教训"这类互补切片仍会并存（跨 kind 一律不动）。评估集 14 条偏旧事，不能代表全部查询，改权重前仍应重跑。

### M59. 动作描写第三版：接戏优先，而不是"允许表演"
- **概念**：第二版把动作整体定义成"表演"、还给了拒绝权（原话「动作不是表演……被点名让你演一个可以拒绝」）。方向反了：这是纯文字扮演，身体只能靠一行括号传出来。真正的判据不是允不允许，而是**这条需不需要身体**——尤其是**对方先动了身体的时候**，不回应话就断了。
- **实现**：
  - `detectSceneAction(text)`：括号动作（（捏住鼻子））是最强信号；没有括号时只看具体动词（捏/抱/钻/拍/抓/拽/捂/戳/递/塞/推回去/放下/合上…），刻意不收"拉/坐/走"这类歧义词（"拉黑"不算）。
  - 注入分两支：检测到对手动作时写「对方这条里有身体动作（「…」）。**接戏就要用一处动作回应**，否则话接不上」，并给「（拍开手）行，都别睡了」这种样子；没有对手动作时只列该写的时刻——**给前提 / 耍赖 / 强烈情绪 / 碰到实物**，普通闲聊不加。两支都保留"一条最多一处、十二字以内"和"被点名摆姿势可以拒绝"（那和接戏是两件事）。
- **位置**：`bots/amber/persona/gesture.ts`（`detectSceneAction`、`gestureLine`）、`bots/amber/persona/index.ts`（`injectGesture` 传入 `sceneAction`）。
- **验证**：`gesture.test.ts` 7 项——对手动作时不含"普通闲聊不加"、必须含"接戏"；「我把他拉黑了」判为**不算**动作、「钻进被窝」「把碗推回去」算；既有上限与睡觉两支不变。`amber + integration` 306 项通过；已重启，`/api/run/paused=false`。
- **边界**：动词表只覆盖具体动作，隐喻式的"心里一紧"不算；检测只看最近一批外来事件，不看历史。

### M60. 梦跟着自己的冷却走，不跟着交接走
- **概念**：交接由上下文填满决定，热闹时十几分钟一次。10-28 晚 72 分钟里交接了 6 次、开了 6 次梦，梦占两小时 2124 万输入 token 的 59%（1248 万）；其中 19:52 连着两次是排队积压的同一段——梦跑了 14 分钟，期间上下文又填满两次，各排一个。一次梦把当时 5.2–5.6 万 token 的原始会话（176–198 条）重读 27–36 轮。
- **实现**：
  - `dreamGateVerdict()` 只回答"这次交接值不值得开梦"；`data/dream-state.json` 记 `lastDreamAt` 与冷却期内没整理的笔记 `pending`。
  - `onHandoff` 改成先 `super.onHandoff`（写交接笔记、拿到文件名），再决定入不入梦。冷却期内的交接只把笔记路径记进 `pending`。
  - 冷却起点没有记录时退回"升级前最近一份交接笔记"，按它算冷却——所以这个值必须在写新笔记**之前**取，否则刚写的那份会把自己挡在门外（第一版就是这么错的，集成测试当场抓到）。
  - 下一次梦用 `dreamDeferredNotes()` 点名这些文件——它们不在快照里，需要细节时梦自己读。
  - 低水位定时器改用 `lastDreamAt` 判断"多久没整理"，并在有 `pending` 且冷却已过时补一次，免得夜里最后一段没人看。
- **位置**：`bots/amber/persona/dreamGate.ts`、`index.ts`（`dreamOrDefer`、`maybeDream`）、`subconscious/index.ts`（`schedule`/`run` 收 `deferredNotes`）、`subconscious/prompts.ts`。
- **配置**：`dream.cooldownMinutes`，默认 60；填 0 恢复成每次交接都入梦。
- **验证**：`dream-gate.test.ts` 6 项；`dream-cooldown.test.ts` 走真实路径——第一次交接日志「梦开始」，第二次「交接未入梦」且 `pending` 多一条、`lastDreamAt` 没动；冷却填 0 后照常入梦。
- **边界**：被跳过的段只靠交接笔记兜底，而笔记明确省略了更早段的发言原文；连跳多次时中间那几段不在上下文里，要靠梦主动读文件。

### M61. 发言门：draft 直接发，只在触到规矩时扣下
- **概念**：每条消息原来要走 draft→confirm 两个回合，第二次只为了说一句 `send`，回执 38 个字。两小时 54 次确认，约 220 万 token（10%）。改成"干净就发、有问题才扣"。
- **实现**：
  - `qq_draft` 先自己过三条规矩（和最近说过的话重复 / 一条里堆了动作 / 又在宣布不接）。没触到就 `sendDraft` 直接发出，返回 `{ endTurn: true }`，这一轮不再叫模型。
  - 触到就压成草稿退回：改一版再调 `qq_draft`，或用 `qq_confirm` 照原样发、`cancel` 作废。积压会话事件仍在这条分支排出。
  - `ToolOutcome.endTurn` 是 Core 新加的返回值形式，与 `ToolDef.endsTurn` 走同一出口；`endsTurn` 是静态声明，扣下草稿那一支不能结束回合。
- **位置**：`src/core/types.ts`、`src/core/loop.ts`、`src/worlds/qq/world.ts`（`draftTool`、`sendDraft`、`confirmTool`）、`bots/amber/persona/CORE.md`、`deployments/amber/worlds/qq/ENV_PROMPT.md`。
- **验证**：`world-loop` 里一次 draft 即 `sent #` 且 `endTurn=true`；扣下的那一条不发、仍会排出积压事件、`confirm(send)` 才发；`core/loop.test.ts` 新增「工具从返回值宣布收工，本批只有一次模型调用」。
- **边界**：发出去之后才发现不对只能补一句更正；扣下那一条仍多一个回合。

### M62. 梦的次数与体积：冷却 120、继承 30k、单场 90k 安全网
- **概念**：改后首窗（21:38–23:40）从 2124 万降到 600 万，但梦仍占 358 万（60%）：2 次梦、每次 23–24 轮、单场输入从 5.2 万涨到 9.8 万。梦的开销 ≈ 次数 × 每次 170 万，所以先砍次数，再砍每次的底，最后给梦一个体积上限。
- **实现**：
  - `dream.cooldownMinutes` 60 → 120：同一窗口里三次交接只开一次梦，其余只留笔记。
  - `dream.inheritTokens` 30000：梦从交接前的会话里只继承最后一段原文（原来撑满上下文）。更早的部分由交接笔记覆盖。
  - `onHandoff` 把**当前段**的交接笔记也放进 `deferredNotes`。原文只留尾巴之后，中段只能靠这份笔记，不传就是两头落空。
  - `dream.contextTokens` 90000：`runForkLoop` 原来只有轮数上限、没有体积检查，梦自己的工具回执能把单场推到 9.8 万。现在越过预算后再跑两轮收尾（提示写进回执，模型要到下一轮才看得到，所以是两轮不是一轮）。它不是省钱手段：一次正常整理要长到 8 万多，设低了会把整理截短。
- **位置**：`bots/amber/persona/config.ts`、`bots/amber/persona/index.ts`（`dreamOrDefer`）、`bots/amber/persona/subconscious/index.ts`（继承预算、`maxTokens`）、`src/core/fork.ts`、`src/core/core.ts`、`src/core/types.ts`（`ForkOptions.maxTokens`）。
- **验证**：`core/fork.test.ts`「越过体积上限后只再跑一轮收尾，不跑满轮数」+「没设上限时照旧跑满声明的轮数」；`integration/dream-cooldown` 断言当前段笔记出现在梦的入参里。
- **边界**：体积上限会截短整理（梦实测 23 轮），90k 是安全网而不是省钱手段；冷却 120 让 `self.md` / `session.md` 最多滞后 2 小时。回滚：`C:\Cortico\backup\2026-10-29-token-opt\restore.sh`。

### M63. 群聊形状：只数事实，判断留给她
- **概念**：她逐条看群消息，不知道这个群此刻是什么形状——昨晚那 3 小时 71 条里 51 条是同一个人说的（72%），没有任何一处告诉她"这基本是一个人在讲"。要补的是**可数的结构**（几个人、谁占了大半、有没有人接谁的话、静了多久），不是"在玩梗/在吵架"这类判断：`PHILOSOPHY.md` 要求基础设施只陈述能核对的事实，猜错比不猜更糟。
- **实现**：
  - `src/worlds/qq/room.ts`：`RoomTracker` 按会话滚动存样本（不含正文），`roomFacts()` 出结构，`describeRoom()` 出一行话，`roomDigest()` 出挂事件 meta 的那一份。
  - `normalize.ts` 的 `renderIncoming` 多返回 `replyToMessageId`——引用关系原先被渲染成文本就丢了，没有它就数不出"谁在接谁"。
  - `world.ts` 在 `judgeAttention` 之后记账、把摘要挂到 `qq.message.meta.room`，并 `pushDeferred` 一条 `qq.room`：正文在**投递时**才算，同一段数字重复出现就不再发。
  - 判定读现算值，不读上一批消息的快照：`lullMinutes` 一过就废，用二十分钟前的读数判断"现在能不能插话"等于没判断。人格层通过 `roomFacts()` 这个口子取，和已有的 `recentMessages()` 同一个路子。
  - 她自己的判断另存一处：`qq_mark_room(label, note, minutes)` 写 `data/qq-room-notes.json`，带过期，跟着那一行回到她眼里（标注「你的判断」），不参与任何机械判定。
- **位置**：`src/worlds/qq/room.ts`、`salience.ts`、`normalize.ts`、`world.ts`、`definition.ts`、`config.ts`、`strings.ts`；`bots/amber/persona/roomView.ts`、`index.ts`、`gesture.ts`、`companion/sources.ts`、`companion/scheduler.ts`、`companion/index.ts`；面板在 `bots/amber/persona/companionPanel.ts`（`groups.room`）与 `bots/amber/webui/companion.ts`（「群聊」页签的「此刻」小卡）。
- **消费点**：注意力打分（冷场后第一条 +0.05、独白 −0.05）；主动开口（窗口里六条但静了二十分钟不算"正在聊"，`flood` 时插不进）；动作描写（热闹时收短，只有两个人时放宽）；`qq_draft` 发送回执补一句"插在了中间"——**只陈述，不扣草稿**。
- **验证**：`tests/worlds/qq/room.test.ts`（11 项，纯函数：窗口、占比、接话、独白、档位、描述行）、`room-wiring.test.ts`（3 项，接线：meta、投递行、去重、判断过期）、`salience.test.ts` 新增 2 项、`companion-topic.test.ts` 新增 4 项、`gesture.test.ts` 新增 4 项；`amber + core + integration + worlds` 3421 项通过（唯一失败是 minecraft 的 `canvas.node` 缺失，与本改动无关）。
- **边界**：注入块只在量化值变化时发，实测口径约 1.2% 加权输入（注入块进了 transcript 之后是缓存命中，只有刚出现那一次按全价付）；每轮都发会到 4%。`RoomTracker` 是内存态，重启后窗口清空——重启十分钟内的"静了多久"会偏大，`describeRoom` 的 `messages === 0 && lullMinutes === Infinity` 直接返回 null，不会说错；`scoreMessage` 那边对 `Infinity` 另有 `Number.isFinite` 保护（第一版漏了，刚起进程会给第一条消息写「群里静了 Infinity 分钟」）。它的判断档次（`heat`）只有五个桶，不做话题识别。





### M64. 召回只看正文：纯图片与表情不再拉回旧事
- **概念**：15:09 一条纯图片消息从群主那里进来，召回把三条「改昵称」旧事顶到最前。根因是 query 用了**整条渲染正文**——`#1727548506 [群「…」 15:09] 娶万里花，做万年梦(3124076548): [图片 https://…]`——里面除了昵称、消息号和链接，没有任何内容词。
- **实现**：
  - `qq.message` 的 `meta.body` 交出不含消息号、群名、发送者昵称的正文（≤400 字）。渲染外壳归 World，人格层不用自己解析。
  - `bots/amber/persona/recallQuery.ts`：`cleanRecallQuery` 摘掉媒体占位（图片/语音/表情/回复/转发/json）、链接、`@称呼`，再压空白、去开头的标点；`recallQueryOf` 优先取 `meta.body`，去噪后为空就不检索。
  - `injectMemories` 改用它。纯图片、纯表情、“@ 一下”这类消息没有话题可查，不再拿昵称凑一次召回。
- **位置**：`src/worlds/qq/world.ts`（`meta.body`）、`bots/amber/persona/recallQuery.ts`、`bots/amber/persona/index.ts`（`injectMemories`）。
- **验证**：`tests/amber/recall-query.test.ts` 9 项（占位、链接、称呼、body 优先、纯媒体、内部事件）；`tests/integration/memory-inject.test.ts` 新增「纯表情叫醒：没有话题就不召回」——把 `injectMemories` 临时改回旧写法，该用例失败，改回即通过。另一条想证明「正文命中优先于昵称」的用例在新旧写法下都通过（bm25 的 idf 本来就会压低高频昵称），按项目规矩删掉，那条改由单测保证。
- **边界**：只降噪，不判断。正文里的人名和标点原样保留（认人另有 `personBlock` 与 `queryTerms`）。`@称呼` 被当噪声摘掉，如果哪天要靠 @ 来找旧事，这条要重看。`recallSkip` 的 `empty` 现在也覆盖“没有可查的词”。

### M65. 台账里的名字也进映射：改名之后还认得出人
- **概念**：`qq-names.json` 记着 34 个见过的群友，`memory/people/` 只有 11 份档案；`PersonRegistry` 原来只在 `parseFile` 里查台账（`people.ts:196-257`），**没档案的那 23 个人的名字一个都进不了 `byAlias`**。结果记忆正文写的是裸昵称（233 条里只有 40 条是 `@号`，今天新写的 6 条里 1 条），人一改名就接不回去了。
- **实现**：`rebuild()` 把台账里没有档案的人也建进映射——当前名与 `history` 里的旧名都进 `byAlias`，另存 `ledgerNames` / `ledgerHistory`；新增 `namesOf(qq)` 统一取「当前称呼 + 全部旧名」，`displayOf` / `render` / `expand` / `queryTerms` / `legacyCandidates` 全走它。档案存在的人仍然以档案为准，台账只补旧名。
- **位置**：`bots/amber/persona/people.ts`。
- **验证**：`tests/amber/people-registry.test.ts` 新增 5 项（无档案的写→读往返、无档案改名、同名不替换、单字不替换、有档案时以档案为准）。把台账那一圈空转后，前两项失败；其余三项是同名/单字/档案优先的守门用例，本来就不该因这一步变化。另用真实部署数据跑过一遍（`scratch/check-names.ts`）：拂晓、阿摆、月色真美、娶万里花都换成了 `@号` 再换回来，单字「辰」不动。
- **边界**：替换面从 11 人扩到 34 人，风险同比例扩大——两字昵称如果正好是常用词（如「拂晓」在散文里），正文会被换成 `@号`。这是有意的取舍：改动只影响写入与渲染，不改任何文件；单字名字（`MIN_ALIAS = 2`）仍然不换，同名两个人仍然不换。**存量 193 条裸昵称没有重写**，靠 `render` 的旧名替换兜住，前提是旧名在台账 `history` 里。

### M66. 标点：句子不收尾
- **概念**：三天 266 条消息里 **240 条（90%）以句号结尾**。原因是样本：每轮注入的 6 张语气卡、`note/playbook/我的句子.md` 里的每条示例，全都以句号收尾。规则怎么写都压不过三十个例子。
- **实现**（四处，都是文本）：
  - `我的句子.md`：样本按语气分两类——认真说事、划界线、解释、安慰的带句号（「不满」「温柔」两节几乎全带），随口、玩笑、刺完就收的不点。现状 28 条样本里 11 条带句号、7 条问号收尾、10 条不点。
  - `prompts/style/core/*-reply.md`（5 张，每轮注入）与 `memory/note/style/*-reply.md`（4 张，按需翻）：9 张里 3 张（技术解释、插话、划界线）带句号，其余开着；`04-comfort-reply` 写成两行，示范换行。
  - `CONSTITUTION.md`「说话方式」加一段 **标点**：句号跟语气走——认真、划界线、讲清楚、安慰时照点，随口、玩笑、刺完就收时不点；句内逗号照常；不许空格粘句。`worlds/qq/ENV_PROMPT.md` 同口径一段（并写明 `text` 里 `\n` 就是换行）。
- **位置**：`deployments/amber/` 下四个路径；原文件备份在 `C:\Cortico\backup\2026-10-29-punctuation\`，附复测脚本。
- **验证**：`GET /api/prompts/prefix` 已含「句号跟语气走」；语气卡走 `sessionHead()` 每轮 `readFileSync` 现读，不缓存，下一轮生效；`world-loop` 新增「换行原样发出去」一项，证明 `\n` 不被折叠。
- **走偏过两次**：① 第一版把「断句可以省标点，用空格断开」写进规则和样本，她照做，六条消息全变成「听你们聊 你晚饭吃了没」这种空格粘句——句号没了，逗号、句读、换行一起没了；② 第二版只去掉尾句号，结果整条消息一个句号都不给，用户指出「正式的时候就该有」。现在按语气分档，样本本身就要两种都有——只改规则不改样本等于没说。
- **边界**：不机械改字——没有在 `qq_draft` 里剥句号，改的是她看到的东西。目标不是句号归零：句子内部该点还是要点。改的是习惯，能不能落地要看接下来几十条消息的分布。

### M67. 分两条气泡：`qq_draft` 的 `more`
- **概念**：她一次只发一条，两拍的第二个想法被塞进同一段，读起来像一段话而不是两个动作。QQ 上的人不会这么发。
- **实现**：
  - `qq_draft` 新增可选参数 `more`：第一拍放 `text`，第二拍放 `more`，发成两条消息，间隔 700ms，第二条不带引用、图片和语音。语音条与 `more` 互斥（语音自己就是一条消息）。
  - 发言规矩按**每条气泡**过一遍（重复、动作密度），提醒里标「第一条／第二条」；「宣布不接」按两条合起来判。第二条也进 `lastSentByConv`，下次的重复检测才管得住它。
  - 换行本来就能用：`text` 从工具参数到 OneBot 段落全程原样透传，没有折叠逻辑。
- **位置**：`src/worlds/qq/world.ts`（`DRAFT_DECL`、`draftTool`、`sendDraft`、`BUBBLE_GAP_MS`）；`deployments/amber/worlds/qq/ENV_PROMPT.md`（「一次只回一条」改成「两拍可以分两条」）；`memory/note/playbook/我的句子.md`（两拍段补一条分开发的例子）。
- **验证**：`tests/worlds/qq/world-loop.test.ts` 新增 3 项——`more` 发出两条且第二条不含引用附件、语音条带 `more` 被拒、第二拍重复时扣下并标「第二条」。QQ + 集成 215 项通过，`typecheck` 干净，已重启。
- **边界**：最多两条，不做三段式；第二条只能是文字。`endTurn` 仍在这一轮结束时收口，所以不会变成连发。**两条之间的间隔在 500–1500ms 之间随机**（`bubbleGapMs()`，随机源可注入以便测试）：固定值一是每回同一个节拍像脚本，二是两次发送的时差完全一致，正是最容易被判成机器行为的那种签名。上下限是模块里的一行常量，没做成配置项。

### M68. 空格闸：两句话不许拿空格连着
- **概念**：改完标点规则后她仍在用空格分句——最近八条全是 `"五点就吃，够早的 我那会儿才刚坐下"`，`args.text` 里没有任何 `\n`。光写「别用空格」没用：她手里只有一条 `text`，没有别的分隔动作可选。
- **实现**：`qq_draft` 的规矩里加一条 `[spacing]`——一**条**气泡里出现「三个以上汉字 + 空格 + 三个以上汉字」就扣下，回执写明两条出路：换行（`\n`）或把第二拍放进 `more`，并补一句「空格不算分开」。正则 `CJK_GAP` 要求两侧各至少三个汉字，是为了不误伤「有 一件…」这种单个字的手滑；换行不命中（`[ \t]` 不含 `\n`）。提示词同步改成正面写法：「一条 `text` 只写一件事，要接着说就换行或放 `more`；空格不是换行」。
- **位置**：`src/worlds/qq/world.ts`（`CJK_GAP`、`draftTool` 的规矩段）、`deployments/amber/worlds/qq/ENV_PROMPT.md`。
- **验证**：`world-loop.test.ts` 两项——两句话之间一个空格被扣下且回执含 `[spacing]` 与「空格不算分开」；单个字的手滑、逗号、换行三种都照常发出（不误伤）。65 项通过，已重启，前缀含「空格不是换行」「只写一件事」。
- **边界**：这是启发式拦截，不是理解。单个字之间、两侧任一侧不足三个汉字都不拦；跨行的正常排版不拦。被扣下要多一次来回，代价是她得改一版再发——但比用户每次看到「听你们聊 你晚饭吃了没」划算。

### M69. 主动开口按群的状态，不按次数
- **概念**：全部历史里「主动时刻」只被推过 2 次，成功 0 次，`speak_later` 用过 0 次；今天那次机会的由头是「你主动说过一句：**「嗯」**，之后没有回音」。她不是不想问，是这条链几乎不产出机会，偶尔产出一次，由头还是空的。
- **实现**：
  - 删掉 `openLoopCandidate`（她问过没人答就再追一句）。现在「上一句还没人接」变成**抑制条件**：悬着就什么都不提。
  - 新增 `curiosityCandidate`：群的热度必须是 `silent`/`quiet`、静默 ≥45 分钟才轮到她；同一段安静里 180 分钟内只问一次；念头里明确要求问一件具体、对方答得出来的事，**不要「在吗」「在干嘛」「吃了吗」**，想不出来就不说。
  - `topicCandidate` 也不再在 `normal`/`busy`/`flood` 时开口——群里真在一来一回地聊，她插进去就是打断。
- **位置**：`bots/amber/persona/companion/sources.ts`（`curiosityCandidate`、`QUIET_MINUTES=45`、`QUIET_RETRY_MINUTES=180`）、`scheduler.ts`（`CandidateKind` 改 `quiet`）、`config.ts`（`companion.enabled` 描述）、`webui/companion.ts`（标签）。
- **验证**：新增 5 项（安静时有机会、normal/busy/flood 不开口、刚说完话不提、上一句悬着不提、试过一次隔开）；`companion` + `companion-topic` 52 项、`amber` + `integration` 338 项通过；两个 typecheck 干净。**线上实测**：面板 `gate=null` 但 `candidates=[]`，原因是她 21:33 那句「嗯」还没人接、`openLoop` 悬着——正是新规则在起作用。
- **边界**：① 前端已重新打包（停进程 → `build:web` → 拉起），`/assets/providers/persona-amber-3UNBFJKR.js` 已在服务；② 45 分钟 / 180 分钟是常量不是配置项；③ 她没有"想不想说"之外的信息来源，念头里只能给场景，具体问什么仍由模型决定。

### M70. 两拍不再收尾：说完就停
- **概念**：群友 `.@` 说她「说明感太重」。查下来病名是她自己 20:34 说的那句——「不想每句都收得那么圆」。结构性来源是宪法里那条两拍模板：**先接住，再刺一句，最后落回具体的关心**。第三拍是个收束动作，等于要求每条消息都落一个点，几千条下来就成了默认姿态。
- **实现**：宪法那条改成「先接住，再刺一句，**说完就停**」，第三句只在真有话要补时才写；`我的句子.md` 同步，示例里的「药吃了吗？」从默认第三拍改成「真想再问一句就问」，想补就分两条发。`ENV_PROMPT.md` 里同一句「再落回具体的关心」也改掉——那句话在每轮前缀里，比宪法更常被看到。
- **位置**：`deployments/amber/memory/CONSTITUTION.md`、`deployments/amber/memory/note/playbook/我的句子.md`、`deployments/amber/worlds/qq/ENV_PROMPT.md`。
- **验证**：热加载后 `/api/prompts/prefix` 里「说完就停」在、「落回具体的关心」不在。
- **边界**：语气卡 `08-aftercare-bite-reply` 仍是「你这句话说得太顺了，像练过。药吃了吗？」——那是一句真问题、不是总结，先留着看效果；宪法由梦维护，这一段哪天可能被它合并或改写，隔天要复查一次。

### M71. 碎片合批；沉默的两个洞
- **概念**：23:36 半分钟里用户连发四条短消息（「话说」「你想过一个问题没」「如果真的不吃饭」「那得多恐怖」，间隔 3–6 秒），她回了**三条互不相干的话**——因为 `batching.quietGapMs = 2500` 小于打字间隔，每条碎片单独成批、单独叫醒她。其中一条还把一张没有配字的图读成「让我别问了」，并**把退让说出口**（「行，那我不问」）。
- **实现**：
  - **碎片合批**（World）：群里、没叫到她的名字、正文 ≤12 字且没有句末标点（或纯图片/表情）的消息，投递时用 `piggyback` 挂进总线但不触发；安静 3.5 秒后 `promotePending(last,'flush')` 一次性放出；最长攒 12 秒强制放出；下一条"说完的话"到达时先 flush 再投。叫到她的消息永远不攒。
  - **REFUSAL 补词**：加 `不问|别问|不想说`，让「宣布不接」的提醒能吃住「那我不问」这类句子。**没有**加「算了」「不说了」——太常见，会把正常句子一起扣下。
  - **ENV_PROMPT 三条**：半句话（「话说」「你想过…」）是他还在打字，这轮不回；**「我重新问」「换个说法」是预告**，别回「问吧」，等他真问出来；没有配字的图不是话，别从图里读「别问了」这类意思。
- **位置**：`src/worlds/qq/world.ts`（`isFragmentBody`/`holdFragment`/`flushFragments`、`FRAGMENT_GAP_MS=3500`、`FRAGMENT_MAX_HOLD_MS=12000`、`REFUSAL`）、`deployments/amber/worlds/qq/ENV_PROMPT.md`。
- **验证**：`world-loop` 新增 3 项——三条碎片只投一次、说完的话不攒、把退让说出口会被 `[silence hint]` 扣下；`amber + integration + worlds/qq` 557 项通过；提示词三条已在前缀里。
- **试过又退回来的**：第一版把"15 秒停顿"当成合批问题，把上限拉到 25 秒、去掉停顿放行，结果**正常短句也要等 25 秒**——两条线索集成用例当场超时。停顿 15 秒和"话没说完"没有可判定的关系，那是模型该判断的事（「我重新问」是预告），不是计时器该猜的事。所以计时器退回 3.5 秒，长停顿交给提示词。
- **边界**：3.5/12 秒是常量；只对群、且只对「没叫到她」的碎片生效，私聊不攒、@ 不延迟；宿主没有 `promotePending` 时自动退回不攒。碎片仍会各自入库、各自记注意力，合的是**叫醒**不是记录。

### M72. 发送前先看一眼：别用旧上下文答新问题
- **概念**：23:58 她回「问吧」时，他的完整问题已经进群 7 秒了。时间轴（原始记录，秒级）：23:57:43「我重新问」→ 23:57:58「如果大肥鱼不爱吃…」→ 23:58:04「那得多恐怖...」→ **23:58:05 她「问吧」**。她 23:57:53 被第一条单独叫醒，写了十二秒；这期间进来的两条**还没投递**，她看不见，于是拿十二秒前的上下文答了一句。
- **实现**：`qq_draft` 在真正发送之前做两道检查——① **手里还攒着碎片**（它们是 `piggyback` 挂在总线上的，`drainPendingEvents` 取不到）：立刻 `flushFragments` 放出来，然后扣下草稿；② **总线上还有没投递的新消息**（`drainPendingEvents`）：同一会话的取走、交回主循环、扣下草稿，回执列出原文。两种情况都写明「先读完再答；原来这条还想发，用 `qq_confirm`」。别的会话的新消息原样排回队列。
- **位置**：`src/worlds/qq/world.ts`（`draftTool` 发送分支）。
- **验证**：`world-loop` 新增两项——「写的时候他又发了几条：先扣下让她读完再答」（预填 `pendingForDrain`）、「他还在连着发的时候写草稿：先扣下，把攒着的放出来」（碎片攒在手里）。`amber + integration + worlds/qq` 559 项通过，已重启。
- **线上实测（00:23–00:25）**：用户连发 8 条碎片，她**只醒一次**；两次草稿被扣下（「他又发了 3 条」「他又发了 2 条」），改写后的回复明显更贴。00:11 那次仍有漏：7 秒间隔把首批拆开，而当时那两条碎片挂在总线里、`drain` 取不到——这就是补第一道检查的原因。
- **边界**：这是**发送时刻**的检查，不是"回复一定正确"的保证——检查之后进来的消息仍会被她错过。也不改变"被半句叫醒"这件事（那是合批与提示词的活），只是保证她不会拿过期的上下文把话发出去。额外代价：对话很密时，一条回复可能要多一轮。

### M73. 没有配字的图不叫醒她
- **概念**：14:00 之后他发 86 条消息、其中 18 张图，她回了 15 张（83%）；文字是 93%。她几乎什么都回，但图这一路尤其难看——「懂了」「听着呢」「嗯」「这眼神是让我别问了」。根因：**模型根本没有图像能力**（没有任何 provider 实现 `accepts`，`vision.enabled` 默认 false，secrets 里也没有 `OPENROUTER_API_KEY`），她手上只有一行 `[图片 https://…]`，看不见任何内容，却仍然被叫醒、被要求回应，于是靠猜和敷衍填空。
- **实现**：
  - World：群里**没有配字、也没叫到她**的图/表情，判为 `periphery` 并 `archiveOnly`——不进唤醒批次，只进背景摘要（`rememberAmbient`），下次有人叫她时顺带看到「他发了张图」。语音**不算**：它有自己的转写，转写结果会补正文。
  - 提示词加一条：**你看不到图里的东西**，别猜、别替它安一个意思、别拿图当话头；他真想让你看会配字或直接问。
- **位置**：`src/worlds/qq/world.ts`（`isMediaOnly`、`waking`、`archiveOnly`、`judgeAttention`）、`deployments/amber/worlds/qq/ENV_PROMPT.md`。
- **验证**：`world-loop` 新增 2 项——群里只有一张图时 `deliver:false` 且 `tier=periphery`（理由「只有一张图没有字」）、@ 她的图仍是 `focus`；`worlds/qq + integration + amber` 561 项通过；已重启，前缀含「看不到图里的东西」。
- **边界**：只对**群**生效，私聊里的图仍然叫醒她（私聊是有人单独找）。`isMediaOnly` 不含语音，否则语音占位会被归档、转写结果那一轮就看不到占位了（这条是被语音转写集成测试当场抓到的）。这只解决"图不该单独叫她"，不解决"她看不见"。

### M74. 上下文硬护栏：越过两倍预算立即交接，并留下现场
- **概念**：10-30 上午 10:38，主会话在一批之内从 32,497 跳到 1,043,968，上游回 `input token count exceeds 1048576`；10:38–12:30 两小时里 16 次调用超过 150k，合计 849 万，占当日 59%。原来的设计只有"越过软阈值先提醒一轮、下一批才交接"——上下文在一批之内暴涨时，没有任何东西拦。
- **实现**：
  - `onBatchEnd` 在最前面加一条：`estTokens > maxTokens × HARD_HANDOFF_RATIO(2)` 就立即 `requestContextHandoff()`，不等第二批、也不发提醒。
  - 同时把现场写到 `diagnosticsDir/anomaly-<ts>.json`：estTokens、maxTokens、hardTokens、记录条数、最大十条的 kind/role/字符数。只写尺寸不抄内容；目录必须在工作区之外，否则会被她自己的版本库收进去。
  - amber 把 `diagnosticsDir` 指向部署 `data/`。
- **位置**：`bots/cormini/persona/persona.ts`（`HARD_HANDOFF_RATIO`、`dumpAnomaly`、`CorminiOptions.diagnosticsDir`）、`bots/amber/persona/index.ts`。
- **验证**：`tests/cortiv/memory.test.ts` 新增「越过两倍预算不等第二批：立即交接，并把现场落到工作区之外」；cortiv 46 项通过。
- **边界**：**挡不住第一次跃升**——1M 那次是在一批之内从 32k 跳上去的，护栏只能在批末发现，所以那一批仍然会照发。它挡住的是之后每一次重复（当天 12:19–12:29 的 14 次里大约能砍掉 13 次）。根因仍未定位，dump 是为下一次留证据。

### M75. 她自己的作品：没人叫她的时候写点东西
- **概念**：抄 AstrBot「我会替你留住故事」（`astrbot_plugin_content_companion`）的创作内核——一部作品分很多次写完，写前有本子、写后有自审，写完一个节点会想拿给人看。原插件挂在「我会永远陪着你」下面，没有独立面板；这里重做成 Cortico 的一层：正文是她工作区里的普通文件，进度是 `data/creative.json` 里的机械事实，面板在陪伴页新开的「作品」页签。
- **和原插件的差别**（都是刻意砍的）：没有封面生成（Cortico 没有接生图后端，原插件在缺后端时也只记失败）；没有 QQ 空间；没有独立的 provider 选择（AGENTS 3.4：模型属于 provider 条目，Persona 拿不到也不问）；没有掷骰子——原插件用 `creative_inspiration_probability`、分享概率和随机字数，这里全部换成状态判据。
- **实现**：
  - `creative/models.ts`：类型与纯函数。成熟度只看客观进度（写了多少字、几段、几条线索和事实、完成比例），三个分享节点建在它上面，每个只给一次。「刚成形」要求字数达到 `max(180, 目标字数 × 0.14)` 且至少两段——三千多字的长篇写了两百字就拿出来，那不叫成形，那叫刚起笔。
  - `creative/store.ts`：书柜落盘到 `data/creative.json`（原子写）。正文不进这个文件。
  - `creative/prompt.ts`：四类提示词——立项、大纲、正文、自审、抽取。英文、短句、第二人称，与梦同一风格；作品本身要求中文。
  - `creative/index.ts`：`Creative` 类。每 10 分钟看一次该不该写：开关、睡眠时段、每日段数、有没有到点该续写的作品。手上空着且离上一部开张够久、而且真有个由头，就开一部新的。一段的流程是 **大纲 → 正文 → 自审（不过就重写一版）→ 抽取**；两版都站不住就不进书柜，按 30 分钟起翻倍退避（封顶六小时）。
  - `creative/inspiration.ts`：由头只从真经过的事里挑，三处按近和重排——**今天/前三天的日记** → **记忆索引里这三天真发生过的旧事**（`kind: 'episodic'`，按重要度取至多三件）→ **她写下过看法的人**。三处都空着就不写。日程里"在写东西"这类**不算**：第一版取的是当前日程段，结果她拿"我在写"去当灵感写了一篇，自己咬自己。
  - 正文写在 `创作/<标题>.md`，与 `note/` 同权（醒着能写能改名，不能删）。她自己的文件工具能读到，梦也能整理。
  - 分享：写完一个节点就在书柜里挂一个 `pendingShare`；陪伴层把它当成一个新的机会来源（`kind: 'creative'`，优先级高于"空下来时的自问"），只说给最近跟自己说过话的那个人，群里正聊着或她上一句还没人接就都不提。递出去一次就消掉，同一天按 `shareDailyCap` 限次。
  - 模型调用走 `core.spawnFork({id:'creative'})`——一个没有工具、只跑一轮的 session 声明，写作不占主会话的上下文。
- **位置**：`bots/amber/persona/creative/`（`models.ts` / `store.ts` / `prompt.ts` / `index.ts`）、`bots/amber/persona/creativePanel.ts`、`bots/amber/persona/companion/sources.ts` + `scheduler.ts` + `index.ts`（分享来源）、`bots/amber/persona/index.ts`（装配、session 声明、心跳、面板数据面）、`bots/amber/persona/config.ts`（`creative.*` 九个可调项）、`bots/amber/webui/companion.ts`（「作品」页签）、`deployments/amber/config.json`（已开启）。
- **验证**：`tests/amber/creative.test.ts` 34 项——纯函数（相似度、预算、成熟度、节点、本子、退避、JSON 容错）、书柜落盘与换天、一次完整的推进（5 次调用、正文落到工作区、本子更新）、审稿不过重写、两版都不行就不入库并退避、太像的不算写成、睡着不写、额度用完不写、没有由头不写、不重叠跑两轮、分享机会的消费与限额、素材三处来源的取舍（日记优先、日记过期退回旧事、旧事按重要度取三件、三天以外不进、退回「她写下过看法的人」、三处都空就不写）、以及和主动层的三条接线（安静时出现、热闹时不出现、有未完话头时不出现）。`scratch/check-inspiration.ts` 用她的真实数据跑过：当前由头取到的是今天的日记（真事），不是日程。
- **成本**（`scratch/creative-cost.ts`，用真实提示词构造器估）：立项 455 + 大纲 393 + 正文 544 + 自审 664 + 抽取 440 ≈ **首段 2,496 tok**，此后每段 **2,041 tok**。对照 `usage.jsonl` 的实测：主会话平均每次请求 38,234 输入、命中 89.5%，即**未缓存约 3,994 tok**。创作那边每次都是新文本、**完全没有缓存**，所以**写一段（约 220 字、4 次调用）比一次普通对话请求还便宜约四成**。按默认上限每天六段，约等于一天里少聊三四句。

### M76. 端点漏发 `content_part.added` 时补上那一段
- **概念**：M75 第一次真跑，四次尝试全挂 `Delta before content part`，而同时段主会话与梦全绿。进程内探针打出来的原始流是：`response.created` → `response.output_item.added`（message，`content: []`）→ 直接 `response.output_text.delta`。中间的 `content_part.added` 网关从来没发。协议里正文增量挂在“内容分段”上，缺了段落整条流被判成乱序，一个字节都收不进来。主会话和梦几乎每次都直接出 `function_call`，那条路径不需要段落——**纯文本流一直是坏的，只是在此之前没有任何调用路径会走到**。
- **实现**：`NativeResponseAssembly.feed` 在增量到达前，若该 (item, index) 从没开过段落，先补一条空的 `content_part.added`（reasoning summary 走 `reasoning_summary_part.added`）。补进来的一条要占序列号，累加器要求序号严格递增，因此从它往后的事件号统一后移一位。已按规范发过段落的流不补第二条。
- **位置**：`src/providers/transport/response-assembly.ts`（`DELTA_PARTS`、`emptyPart`、`openMissingPart`、`mark`）。
- **验证**：`tests/core/provider-responses.test.ts` 新增 2 项——「端点只发输出项和正文增量、不发 content_part.added 时，把缺的那一段补上」（补一次、位置在增量之前、正文照样累加）/「端点按规范发了 content_part.added 时不再补第二条」；`tests/core` + `tests/providers` 572 项通过。
- **边界**：只补段落，不补内容；只作用于 native Responses 那一路（chat 那一路自己会发段落）；序列号被重排，下游只依赖递增性、不依赖原值。这是一层兼容垫片，`ResponseAccumulator` 仍然严格校验——它校验的是我们喂进去的东西，脏活的边界在兼容层。

### M77. 请求侧尺寸对照：400 时把"上一次成功"和"这一次"并排落盘
- **概念**：M74 那道按 `estTokens` 判的护栏在 10-30 两次 1M 事故里都没拦住。第二次事故（21:05–21:23）拿到了决定性证据：强制交接后恢复，恢复后的实际 `promptTokens` 是 22,043，而交接口径估的是 22,327——**估算器在正常规模下是准的**；可失败那几次 estTokens 只有 45,495，上游却说超过 1,048,576。差 23 倍，不是估算能解释的。要知道那一刻到底发出去多少，只能量真的请求体。
- **实现**：`response-http` 在序列化请求体之后量一次尺寸——总字符数、条目数（Responses 数 `input`，Chat 数 `messages`）、最大一条占多少字符、工具表条数、模型名；按 `实例:角色` 记住最近一次成功的尺寸。遇到 **400** 时以 error 级把「上一次成功」与「这一次失败」并排写进运行日志，键名 `请求被上游拒收：尺寸对照`。
- **位置**：`src/providers/transport/response-http.ts`（`RequestSize`、`sizeOf`、`entriesOf`、`lastSuccess`）。
- **验证**：`tests/providers/transport/response-http.test.ts` 新增 1 项——先成功一次、再 400 一次，落盘里 `previousSuccess` 与 `failed` 的条目数一致、`failed.status` 是 400；core + providers 573 项通过。
- **边界**：只在 400 打，成功不落盘（只在内存里留一份，进程重启即失——重启后第一次 400 没有对照）。落盘位置是运行日志 `data/runs/<run>/log.jsonl`，不是独立文件；要独立文件得把 `diagnosticsDir` 一路传到 provider，那属于 plumbing，等真需要再说。它只观测，不改变任何发送行为。

### M78. 字面 `\n` 与社交电量：两处"看着没事、用起来不对劲"的修正
- **概念一（换行）**：23:11 那两条真实消息在群里显示成「行，都依你\n现在大英雄快去睡。」——模型在工具参数里多转义了一层，`\\n` 解析回来是反斜杠加 n，不是换行。今天 75 次 `qq_draft` 里有 18 条带换行，其中一部分是这种多转义。
  - **实现**：`qq_draft` 在读 `text` / `more` 时先过一遍 `literalNewlines()`：出现 `\n` 两个字符就换回真换行。中文聊天里没人真的想打出这个字面量。
- **概念二（社交电量）**：用户反馈"才聊几句就敷衍回复"。查下来不是感觉：当晚 23:15 电量 0.20，`replyBattery` 是 0.35，于是那几轮都在被注入「句子比平时短一点」；真实消息长度也确实从 134 / 167 / 73 / 106 一路掉到 31 / 47 / 28 / 31。
  - **根因**：`noteTurn` 一句回复扣 0.02，而**今天她发了 75 次 `qq_draft`**——光说话就扣 1.5，超过整条电量。回电半衰期 180 分钟又太慢，一整天聊下来必然见底。**说话是她的本职，不该是主要开销。**
  - **实现**：一句回复 0.02 → **0.006**（说满 75 句也只掉 0.45）；回电半衰期 180 → **90** 分钟；`companion.intero.replyBattery` 默认 0.35 → **0.25**（短回只在真低的时候出现）。
  - **说明**：内感受与日程无关——它只读事件流（谁说了多少、复读了几次、隔了多久）。日程与梦境影响的是 `roleState.energy` 与生活卡，那是主动开口的门，不是回话的预算。这次两条线都没有互相串。
- **位置**：`src/worlds/qq/world.ts`（`literalNewlines`、`draftTool`）、`bots/amber/persona/companion/intero.ts`（`REPLY_DRAIN`、`SOCIAL_HALF_LIFE_MIN`）、`bots/amber/persona/config.ts`（`intero.replyBattery` 默认值）。
- **验证**：`world-loop` 新增 1 项（字面 `\\n` 发出去变成真换行）；`intero` 新增 1 项（说满 75 句仍高于短回线）、原「她开口才掉电」改成 0.006；amber + worlds/qq 544 项通过。
- **边界**：`literalNewlines` 只认 `\n`，不认 `\t` 与 `\\r`——没有实际遇到过，不猜。电量是**累加器**，改公式不会回头重算已有状态；这次把当时被压到 0.20 的值手动归到 0.55（旧公式的产物，不是新算出来的）。

### M79. 电量开始回血：被接住算有劲
- **概念**：用户问得直接——"为什么聊着就必须降？聊得有干劲不该涨吗"。查 M37 的原话，当初要的是**不可协商**（"梦一场就能改写精力，所以电量从事件流长出来"），不是"电量必须单调"。只降是我照着电池的意象写下来的，没人论证过。它的后果很具体：回血只靠沉默，于是**聊得越好越早闭嘴**，而她的本职就是聊。
- **实现**：她说完一句之后 **15 分钟内**有人接着聊（`wake` 是 `thread` / `name` / `mention`）→ 电量 **+0.01**，一次回复只回一次。加项必须小于一条消息的耗电，否则聊得越热闹电量越满，"累"就重新变成能刷出来的东西。反过来，**过了窗口还没人接 → −0.006**（和一句普通回复等量，等于一条没人接的话代价翻倍），扣一次就清标记，不反复扣。
- **为什么不按"话题走向"判**：话题好不好要模型来读，一读就等于把 M37 关掉的那扇门重新打开——她可以为了讨好某个人说自己有劲。所以"有劲"只用**行为**量：有没有人接话。这一条不用模型，也骗不了。
- **位置**：`bots/amber/persona/companion/intero.ts`（`ENGAGED_GAIN`、`ENGAGED_WINDOW_MIN`、`IGNORED_PENALTY`、`InteroState.lastSentAt`）。
- **验证**：`tests/amber/intero.test.ts` 新增 5 项——被接住会回升、过了窗口不算、一次回复只回一次电、没人接扣一笔且只扣一次、说出时刻写进盘（重启后窗口内接话仍算数）；amber + integration 378 项通过。
- **边界**：`lastSentAt` 进了 `intero.json`（旧文件没有这一项，按"没说出去过"读，不补发滞后的惩罚）。它只记**最后一句**：连发几条时前面那几条没跟进的沉默不会单独记账，被记的是最后一句之后有没有人接。


### M80. 临时状况会过期；括号里的号不是身体
- **概念**：查的是"她为什么整晚只会催人去睡"。把昨晚每一轮的状态块拼起来看：`精力 87/100`（很高），后面却跟着 `安稳平静，准备早点歇下` / `有些困意，准备睡了` / `眼睛微涩，灯已调暗` / `眼睛发涩，灯已经调暗`——同一个事实说了四遍。根子在 `expiresAt: null`：注释写的是"没有明确到期"，代码当成"永远成立"。昨晚写的「灯已经调暗」到今天上午十点还在注入，而那时她 `精力 86`、`公开状态：晨起理书`。
- **实现**：
  - `Condition` 加 `since`（写入时刻）。`block()` 按类别给寿命：sleep 8h、hunger 4h、mood 6h、busy 8h、health/other 24h，过了就不进状态块。
  - 同一 `kind` 只留最新一条，总条数上限仍是 3——三条同义的"我困了"不是细节丰富，是复读。
  - 旧文件里没有 `since` 的状况读进来直接丢掉：说不清年纪的状态不能当事实用。
- **另一半**：`detectSceneAction` 的括号正则把 `甲(3926982253)`、`@Claude🍊昂贵橘子精(你)` 判成"对方在做身体动作"，于是注入「接戏就要用一处动作回应」。改成括号里至少两个汉字、或含明确身体动词才算。
- **位置**：`bots/amber/persona/companion/roleState.ts`（`CONDITION_TTL`、`CONDITION_LINES`）、`bots/amber/persona/gesture.ts`（`BRACKETED`、`HAN`）。
- **验证**：`tests/amber/role-state.test.ts` +3（隔夜睡意不再出现、同类只留最新、旧文件无 `since` 直接丢）；`tests/amber/gesture.test.ts` +2（QQ 号与称谓不算动作、前一个括号是号后一个才是动作时取后者）；amber + integration 383 项通过，typecheck 干净。
- **边界**：`(大小姐)` 这种两个汉字以上的纯称谓仍会被当成动作，规则只挡得住号、单字称谓和英文。行为层那句"对方说继续聊就别收尾"没有加规则：那是她的判断，堆一条禁令只会换来另一种复读。


### M81. 梦不再继承整段会话：只吃增量事件
- **概念**：36 次梦吃掉了全部输入的 44%，单次 31.9 轮、211 万 token，是 10-25 的两倍多（那次 22 轮 / 91 万）。查下来它不是需要这么多，是**继承错了东西**：交接前的快照里，用户消息**全部**是每轮重复注入的状态块、记忆召回、日程与动作许可（实测 10,985 字里 10,985 字都是注入），真正的 QQ 事件走的是 `external_event_frame` 的工具回执。梦花大价钱重读自己的注入。
- **实现**：新增 `episodeLines` / `episodeDigest`，把快照折成一行行事实——
  - 事件：`external_event_frame` 的回执留下，调用本身不留；交接笔记跳过（它在盘上，且已经作为 `deferredNotes` 递过去）。
  - 她说的话：`qq_draft` 按**回执**判，`[sent` 才算说过，`[send failed]` 整条丢掉，被扣下的标成「她起草，可能没发出」。
  - 别的工具只留一行 `[工具] read_file note/x.md`，回执一律不留——工作区在盘上，要细节自己读。
  - 用户消息按 `context.internals` 的 `start/chars` 精确剔除注入；位置对不上就整段保留，宁可多读也不切半句。
  - 长链接压成 `[链接]`；单行 600 字上限；超预算从最早的一行开始丢。
- **位置**：`bots/amber/persona/subconscious/digest.ts`（新）；`subconscious/index.ts` 的 `run()` 用它替掉 `rebuildTail` 继承；`subconscious/prompts.ts` 的 `dreamEpisode` 与三处措辞（`the conversation above` → `the event log above`）。
- **验证**：拿真实 `session-main.jsonl`（50 条动态记录）跑，继承原文 20,074 字 / 10,568 token → 事件日志 7 行 / 306 token，**压缩到 2.9%**；失败的草稿不再冒充她说过。`tests/amber/dream-digest.test.ts` 14 项。
- **实机复测**（2026-10-31 11:35 强制入梦一次，`r-20261031-113154-824a`）：

  | | 此前 36 次梦（均值） | 这一次 |
  |---|---|---|
  | 轮数 | 31.9 | 32 |
  | 总输入 | 211.0 万 | **157.6 万（−25%）** |
  | **未命中输入** | 9.6 万 | **4.5 万（−53%）** |
  | 第一轮上下文 | 42,615 | **15,966（−63%）** |

  第一轮少掉的就是那 31k 的会话尾巴。日记仍有 901 字，写清了零点催睡、早上回「早」、两段随笔；`memo/self.md` 首行也换成了「两段随笔上午理好了，等他露面就递」——它知道自己上午干了什么。

  第二次是自然入梦（14:21，不是强制的）：22 轮 / 106 秒，总输入 **97.2 万**、未命中 **4.6 万**。相对 36 次梦的均值是 −54% / −52%，和强制那一次同一个量级。
- **边界**：梦不再看到自己的思考过程与文件回执，判断"我为什么这么说"要靠重读工作区。**下一处大头是轮数**：第一轮降到 16k，但第 32 轮又涨回 64k，32 轮把 157 万里的一半以上花在重复发送工具回执上——那是下一步该动的地方，不在这一次的范围里。


### M82. 交接笔记不再算"有人在跟你说话"
- **概念**：强制入梦那一次，交接把她叫醒，她往群里发了一句「（停下笔）上午在理答应群主的随笔，刚挑完两段。**你呢，一大早问这个**」——后半句是凭空的，没有人问她任何事。查下来不是偶发：`wakes.jsonl` 里含 `handoff-note` 的唤醒 62 次，其中 **10 次她对着这份笔记发了言**（16%）。根因是交接笔记以 `origin: 'external'` 投递——框架把它当成"有人对你说了话"。
- **实现**：把混在一起的两根轴拆开。
  - `injectExternal(text, kind, { origin?, renderAs? })`：`origin` 说**从谁那里来**（`external` 有人说话 / `internal` 系统材料），`renderAs` 说**摆在哪**（`frame` / `inline`），缺省按 origin 推。
  - `EventEnvelope` 加 `renderAs?: 'frame' | 'inline'`；`loop.ts` 的渲染分流从"看 origin"改成"看 renderAs，缺省由 origin 推"。
  - 交接笔记：`injectExternal(part.text, HANDOFF_NOTE_TYPE, { origin: 'internal', renderAs: 'frame' })`。
- **连带修好的三处**：`injectGesture`（原来会对着一份系统笔记注入「对方这条里有身体动作，接戏就要用一处动作回应」）、`surfaceThread`（把 `leave_thread` 的话头当成"有人来了"递回来）、`groundTimeQuestion`（在笔记里找"下午""刚才"这类时间词）。这三处都以 `origin === 'external'` 为条件，现在不再被一份笔记触发。`cormini.onDelivery` 也不再为它数一条"N 条新事件"、复位静默时长。
- **位置**：`src/core/types.ts`（`EventEnvelope.renderAs`、`CoreApi`）、`src/core/loop.ts`（`injectExternal`、`deliverBatch` 的分流）、`src/core/core.ts`、`bots/cormini/persona/persona.ts:688`。
- **验证**：`tests/core/loop.test.ts` 的交接用例断言 `origin: 'internal'` **且仍在事件帧里**（帧 1 个、两条事件、`「交接完了」`那条 user 行不含笔记正文），并新增一项确认**默认值仍是 external**（别的调用方行为不变）；core+cortiv+cormini+amber+integration 1191 项通过；typecheck 干净。
- **实机验证**（2026-10-31 12:04 与 15:09 各交接一次，都在冷却期内因此没有入梦）：两次都是 `reason=internal`、`outcome=acted`；`handoff` 与 `handoff-note` 的 origin 都是 `internal`；`qq_draft` 调用数为 0——一次只读了笔记文件，一次只留了 `leave_thread`。改之前同类唤醒有 16% 会发言。
- **排版实测**（15:09 那次）：`session-main.jsonl` 里 `[system] 交接完了…` 在 user 行，笔记单独占 `external_event_frame` 的一对调用/回执（`evf_8179`）——origin 是 internal，排版仍是独立成帧，两根轴确实分开了。
- **边界**：`renderAs` 只影响投递时的排版，不影响水位、重试、补投——那些仍按 `contextDelivery` 走。系统里其它内部事件（tick、notice、记忆注入）仍然并进 user 行，没有跟着改。


### M83. people/ 是档案，不是编年史
- **概念**：梦的账单降下来之后，剩下的大头是"同一个人的文件被反复读进来再重发二十多轮"。查下去不是梦多事，是**文件本身长歪了**：`people/qq-3124076548.md` 46,831 字节 / 17,786 字、205 行，全按日期铺开、只增不减——**今天几乎没对话，它也长了 3 KB**。那一篇每次梦都要整篇读进上下文。
- **实现**：
  - `peopleBudget.ts`：单个 `people/*.md` 预算 9,000 字，规则一条——**超预算之后只接受能把它写小的改动**。消化的改动永远放行，追加永远挡住。
  - 闸装在 `dreamTools()` 的工具包装上（`write_file` / `append_file` / `edit_file`），按 `zoneOf()` 判定是否落在 `people/`，用 `old_string`/`new_string` 算出改完的字数。拒绝理由作为工具回执交给她，写清了现值、预算和该怎么做。
  - `dreamOrientation` 第 4 条补上预算与收敛办法：更早的日期段并成一行、不作数的观察删掉、其余挪进 `note/`。
- **位置**：`bots/amber/persona/peopleBudget.ts`（新）、`bots/amber/persona/index.ts`（`guardPeopleWrite` / `peopleWriteVerdict`）、`bots/amber/persona/subconscious/prompts.ts`。
- **验证**：`tests/amber/people-budget.test.ts` 5 项（未超放行、压线放行、超了还长就拒、超了但在缩小就放行、超了且一字不差也算没变化）。
- **实机验证**（2026-10-31 17:03 入梦一次，先把 `dream-state.json` 的 `lastDreamAt` 往前拨 7 小时让它到期）：
  - `people/qq-3124076548.md` **46,831 → 6,421 字节**，`## 曾用名`、`## 他要的是什么`、`## 怎么跟他说话`、`## 我的看法` 全在。
  - 旧流水没有丢：梦自己新建了 `note/library/群主旧日记录.md`（10,463 字节），把 10-23 至 10-28 的细节挪了过去，档案里每个旧日期压成一行并指过去。
  - 这一梦本身 23 轮 / 126.5 万输入（比 14:21 那次高，因为它正是在做这次大整理）；**稳态要看下一次**——档案从 17,786 字降到约 2,400 字，读它的代价跟着降。
- **边界**：闸只装在**梦**的工具面上。清醒时 `people/` 本来就是 append-only，她记观察不会被挡——白天增长、梦里收敛，这是有意的非对称。`edit_file` 的结果长度是按 `old_string`/`new_string` 估算的，`replace_all` 时按命中次数算；路径不在工作区内时直接交给下面的工具去报错。


### M84. 好感度：稀缺、慢、只在大事上动
- **概念**：原来的 `relations.json` 只有信任与熟悉度，而熟悉度一句 `+0.01`，九十五句话就撞到 1.0。实测那天：`2578598310` 是 `familiarity 1.000 / trust 0.306`——**不信任但"熟透了"**，人身上不成立；另外四个人 `trust` 一次没动过，永远停在 0.500 的初值。所以那套账里根本没有"长出来"这件事，只有"聊得多就被记为熟"。
- **实现**：
  - 新增 `affinity`（好感度），与 `familiarity`（认识程度）分开：**聊得多叫熟，不叫喜欢**。
  - **总量守恒**：`Σ affinity ≤ AFFINITY_CAP = 2.5`，每次增长乘剩余份额 `(1 − ΣA / cap)`。一个人到 0.9，别人就只能在低处——"只能维持几段"是算出来的，不是名单规定的。
  - **增长只认两件事**：她说完 15 分钟内有人接着那句（`isEngaged`，与电量共用同一个判断，一次回复只记一次），以及欠的话兑现。发消息本身不涨好感度。
  - **半衰期 150 天**：三个月才近，也三个月才淡。
  - `familiarity` 改成逼近式增长 `+0.01×(1−f)`，不再撞顶。
  - 注入行改成只看好感度：≥0.7「他在你心里有分量」，≥0.42「比对多数人更有耐心」，中间的人**什么都不说**——"其他人在平均分附近"的意思就是他们不带额外的行。
  - 旧文件迁移：没有 `affinity` 的记录按 `familiarity × trust × 0.15` 播种；v1 已经用老公式播过种的按同一比例缩回去（不重播，免得抹掉这几小时长出来的）。
- **刻度怎么定的**（第一版定错过一次，这是改正后的）：
  - 实测这个群**每 15 分钟窗口里每天被接住 93 次**。
  - 第一版写 `0.006`：93 × 0.006 = 0.56/天，上限 2.5 **四五天顶满**；而播种按 1.0 折算又把总量一次性填到 2.23（89%）——"几个月才到最喜欢"在第一天就结束了。
  - 改后：每次 `0.0003`（满份额一天 0.028，**从零填满预算约 90 天**），播种系数 `0.15`（八天在三个月尺子上只走一小段）。
  - 按真实数据播种后：群主 **0.132**、3823 0.073、2578 0.045，其余 0.015–0.029，**总量 0.335 / 2.5**。
  - 按每天 93 次、群主占 60% 推算：**0.42 约 23 天，0.70 约 52 天，0.90 约 80 天（2.7 个月）**——这才叫"几个月"。
  - 代价：升级当天她对任何人都暂时没有"好感"那行注入（阈值 0.42）。关系还在 `people/`、`我的看法`、记忆权重里，少的只是账本上这条额外提示。
- **位置**：`bots/amber/persona/relations.ts`（`affinity`、`AFFINITY_CAP`、`AFFINITY_GAIN_ENGAGED`、`AFFINITY_SEED_FACTOR`、`affinityMass`、`gainAffinity`、`normalizeRelation`）、`bots/amber/persona/companion/intero.ts`（`isEngaged`）、`bots/amber/persona/index.ts`（接线与一次性奖励）、面板四个类型声明 + 渲染。
- **验证**：`tests/amber/relations.test.ts` 21 项（含：普通消息不涨好感、被接住才涨、份额满时谁也涨不动、150 天减半、兑现欠话涨好感、旧文件播种按 0.15、v1 缩回与 v2 不重缩、熟而不亲不给放宽行）。
- **边界**：梦**不能**直接写好感度（`maintain_relation` 里没有这个字段）：能不能喜欢一个人不是整理时能决定的。增长只走事件，所以一次刷屏不会让她突然在意谁。代价是"她在意谁"这件事，短期内只会跟着实际发生的事走，管理员改不动。


### M85. 语气卡：分类 + 按场景取用
- **概念**：磁盘上有 10 对语气卡，常驻上限是 6 张 / 2400 字，而 6 张一共只用了 213 字——**卡的瓶颈是张数，不是字数**。新卡加进去按文件名排在后面，直接被跳过，日志一句 `常驻语气卡超出预算,已跳过` 就没了。所以"再加卡"在原来的模型里是没有意义的。
- **实现**：`styleCards.ts` 把卡名里编号后面的那一段当类别（`05-short` → `short`、`08-aftercare-bite` → `aftercare`），每类配一个触发词；每轮拿当批外部正文去匹配，命中就把那一条**递一次**（`injectInternal`，走当轮注入而不是前缀，不破坏缓存），同一张一个进程只递一次。常驻卡仍然走 session 头当 few-shot，两条路互不挤占。
- **位置**：`bots/amber/persona/styleCards.ts`（新）、`bots/amber/persona/index.ts`（`libraryCards` / `injectStyleCard`）。
- **验证**：`tests/amber/style-cards.test.ts` 7 项——类别切分、每类都有触发词、情形对上才给、一轮只一张按编号优先、递过的跳过、半张卡不算卡、递过去的措辞说清"这是你自己说过的话，不是台词"。
- **边界**：触发词是**词表匹配**，不是语义理解：换一种说法就匹配不上（"面试又挂了"能中，"今天不太顺"不能）。资料库空了就什么都不递。真正想覆盖更多场景，要么加卡同时给类别加触发词，要么以后换成嵌入检索。


### M86. fetch 失败要带上真正的原因
- **概念**：18:22:57 出现一次 `查询向量失败，退回关键词 { err: 'TypeError: fetch failed' }`。这句话**不可诊断**——Node 的 fetch 只会说 "fetch failed"，真正的原因（`ECONNRESET`、`UND_ERR_CONNECT_TIMEOUT`、`ENOTFOUND`、TLS 告警）放在 `err.cause` 里，而日志写的是 `String(err)`，正好把它丢了。于是"网络抖动"和"证书过期"在日志里长得一模一样。
- **实现**：`describeFetchError(err)` 把 `err`、`cause`（`name: message`）、`code`、再深一层的 `cause2` 摊开；两处向量失败（查询与补写）都改用它，查询那处再带上累计失败次数。
- **位置**：`bots/amber/persona/embeddings.ts`（`describeFetchError`）、`bots/amber/persona/index.ts`（两处 catch）。
- **验证**：`tests/amber/embeddings.test.ts` +2——cause 与 code 被带出、再深一层也带出、没有 cause 时不多编字段。
- **边界**：只影响日志，不改重试与回退行为。下一次复现才能知道真实原因；2026-10-31 18:36 重启后三分钟内没有复现，说明不是必现。


### M87. 向量接口失败要弹出来，不能静默回退
- **概念**：向量调用失败会自动退回关键词检索——功能不断，所以**没人会发现**。日志里有一条 WARN，可没人天天翻日志。用户的要求很直接：出错就在控制台弹一下，剩下的他自己处理。
- **实现**：
  - `EmbeddingStats` 增加 `lastError: { at, text } | null`；两处失败（查询与补写）都走 `noteEmbedFailure`，把 `describeFetchError` 拆出来的 cause/code 存成一句人话。
  - 总览面板（`overview.state`）带上 `embeddingError`；有值时页面顶部出一条红色提示，并 `ui.toast` 弹一次。
  - 记忆索引面板（`memindex`）同样显示，且共用同一个 `localStorage` 键 `amber.embedding-alert-at`——**同一次失败只弹一次**，刷新页面不会重复报警，新的失败会再弹。
- **位置**：`bots/amber/persona/embeddings.ts`（`EmbeddingStats`）、`bots/amber/persona/index.ts`（`noteEmbedFailure`）、`bots/amber/persona/companionPanel.ts`（`embeddingError`）、`bots/amber/webui/companion.ts` 与 `bots/amber/webui/memindex.ts`（渲染与 toast）。
- **验证**：两端 typecheck 干净；`tests/amber` 364 项通过；`pnpm build:web` 重新打包，新代码在 `dist/web/providers/persona-amber-GG3E7FV4.js` 里；重启后 `POST /panels/overview/state` 返回 `embeddingError: null`（字段通了、当前没有失败）。
- **边界**：只在**打开 WebUI** 时才会看到——面板是浏览器渲染的，后端没法主动弹窗。要真正"后台也通知"，得换别的通道（桌面通知、Webhook、或往群里发一条给她自己看），这一版没做。另外它报的是"最近一次失败"，恢复了不会自动消失——看到之后点一下刷新，只要 `lastError` 不变就说明还是那一次。


### M88. 一次梦只做该做的两三件事
- **概念**：M81 砍掉了继承，但梦仍然每次把整张清单跑一遍——实测 22–32 轮 / 97–126 万输入 / 100 秒。提示词里原本就是十四条编号职责 + 「按顺序做完这三件」，逐条读下来就是"全做"。M83 那个"people/ 变成编年史"的病根也在这：一次梦赶十几个活，最省力的做法是往末尾追加，而不是回头消化。
- **实现**：把清单拆成两层。
  - **每次必做两件**：A 日记、B 自己的状态。
  - **按情形触发，至多三件**：来了新人 / 有人改名 / people 文件超预算 / 笔记互相矛盾 / 诺言兑现 / 越界或修复 / note 有重复或相对日期 / memo 积压 / 同一模式出现在不同日期 / 这次真看过图 / 对某人的看法变了 / **什么都没发生就只做 A 和 B**。
  - 原来每一条的细则（people/ 命名与"档案不是编年史"、`## 我的看法`、self.md 200 字、表情包索引、WORLDVIEW 的收敛门槛、宪法纪律与语言风格）**原样保留**，只是挂到触发项下面作为「碰到时遵守的规则」，不再是一条待办。
  - `dreamTask` 里把那三件改成「A 和 B 永远做；日程只在还是临时排程时才写；触发项至多三件」，并写死一句 **"Three is a ceiling, not a quota"**——小聊一场，零件才对。
- **位置**：`bots/amber/persona/subconscious/prompts.ts`（`dreamOrientation`、`dreamTask`）。
- **验证**：`tests/amber/dream-prompt.test.ts` 3 项（不是编号清单、明说"上限不是配额"、触发清单把原职责都接住了）；实机 2026-10-31 20:32 入梦一次（把 `lastDreamAt` 往前拨 9 小时让它到期）：

  | | 之前（三次均值） | 这一次 |
  |---|---|---|
  | 轮数 | 22–32 | **15** |
  | 总输入 | 97–126 万 | **55.9 万（−43%）** |
  | 未命中 | 4.5–5.0 万 | **2.6 万（−48%）** |
  | 耗时 | 100–106 秒 | **78 秒** |

  而且**该做的一样没少**：`memo/diary/2026-10-31.md`（1398 字，写到了"三倍代价"那段对话）、`memo/self.md`、`role-state.json` 都更新了；自由裁量的正好三件——`self.md`、`people/qq-3124076548.md`、`WORLDVIEW.md`。上限确实卡住了。
- **边界**：这是**提示词约束，不是闸门**。梦要是坚持多做，没有任何东西拦它——只有 `maxRounds` 和 `maxTokens` 兜底。所以效果要用轮数持续观察：如果某次又回到二十多轮，说明触发清单被读成了新的待办清单，得回来收紧措辞。另外小聊一场的夜里它只写日记和状态，那是**预期行为**，不是漏整理。


### M89. 语气卡的示例漏进了梦的事件日志
- **概念**：改 `[她答]` 这个标签时顺手翻了她自己的记忆，看见三条同源的条目：
  > 那批旧素材（你在群里一般都干嘛／报错三小时／面试又失败了／我没事，真的／我是不是很厉害）**第五次原样回来，我照着卡念了**，连没人提过的「药」都还在。

  这些"旧素材"就是 `prompts/style/core/` 下的**语气卡**——`sessionHead()` 把每一对 Q/A 当成 user/assistant 消息塞进会话开头，作为 few-shot。它们是 `context.head: true` 的合成项：不写进 `session-main.jsonl`，但**在交接快照里**。M81 的 `episodeLines` 只跳过了 system 消息，于是把每一对都当成"发生过的事"和"她说过的话"逐对输出——她连读五六次，每次都在记忆里写一遍"旧素材又回来了"。
- **影响面查过了**：只污染梦，没有污染清醒的她。扫全部 610 份草稿，只有一条命中卡里的原句，而且是她在引用一句真实对话（20:04「『我没事，真的』这句话，我以后不太想再听到第二次」），不是照卡作答。
- **实现**：
  - `episodeLines` 跳过 `entry.context.head` 的合成开头项。
  - 顺带把标签统一成第一人称：`[她说]` → `[我说]`、`[她答]` → `[我说]`、`[她起草，可能没发出]` → `[我起草，可能没发出]`。这份日志是给她自己读的，第三人称读起来像旁观别人。
- **位置**：`bots/amber/persona/subconscious/digest.ts`。
- **验证**：`tests/amber/dream-digest.test.ts` 16 项（新增：`context.head` 的问答对不进日志、assistant 正文用 `[我说]`）。
- **遗留（已处理）**：索引里已经有 3 条被这个 bug 写坏的记忆（`a3669bdc…`、`0f3ca3f2…`、`9fdef8ee…`，importance 0.68–0.82）。按用户指示删除：先停进程、把 `memory-index.db` 与 `-wal` 备份到 `C:\Cortico\backup\memory-index-before-m89.db*`，逐条核对文本里确实带「旧素材 / 她答」才 `remove()`，删完复查 `get()` 全部为 null。**256 → 253 条，其余一条没动**；重开后重扫，命中「旧素材/她答」的条目为 0。


### M90. 主动开口的由头：从"这边安静够久了"换成"我有句话没说完"
- **概念**：8.8 天里主动时刻出现 10 次、她开口 2 次。而且那 10 次的由头全是同一句——「这边已经 N 分钟没人说话了」。那不是动机，那是计时器：人不会因为安静了九小时而想说话，人是因为手上有件事没说完。她自己写过 15 次 `leave_thread`（"下次想回头再提"），但 `threads.json` 里 5 条**全部带 `surfacedAt`**——递过一次就死了，之后再没人提。
- **实现**：
  - `ThreadStore.offerable(now)`：还没提过、且年龄在 **30 分钟到 36 小时**之间的话头。太新还在刚才那段对话里，太旧就是自己也不打算说了。
  - `threadCandidate()`：把那条话头原样写进由头——「你上次走的时候留了句话：「…」。要是还作数，就直接接着讲那件事」，并要求她**不提"我上次说过"**。守卫和别的机会一样：上一句没人接就不提，群里正忙也不提。
  - 优先级 `-0.5`：排在「自己的作品」(-1) 之后、「空下来时的自问」(0) 之前——它有内容，不只是填空。
  - 只说给最近还在跟她说话的那个人（和作品分享同一条规则）：没人接的群里掏出一句没头没尾的话，是广播。
  - 话头是一次性的：`planOnce` 把它带出来，`evaluate` 里立刻 `markSurfaced`，同一句不会被反复当由头。
- **位置**：`bots/amber/persona/threads.ts`（`offerable`）、`companion/sources.ts`（`threadCandidate`）、`companion/scheduler.ts`（`threadNote` / `kind: 'thread'` / `priority -0.5` / `threadId`）、`companion/index.ts`（`onThreadOffered`）、`persona/index.ts`（接线）、`webui/companion.ts`（面板标签「上次留的话」）。
- **验证**：`tests/amber/companion.test.ts` +6——有话说时由头是那句话而不是"安静够久"、没话头退回自问、上一句没人接时不提、不足半小时不算、超过一天半作废、提过一次不再提。
- **边界**：**没验证到真人现场**。`threads.json` 里现存 5 条话头全部已 `surfacedAt`，所以此刻 `offerable()` 是 null，只能等她下次 `leave_thread` 之后才会看到它真的当上由头。另外它只改「凭什么开口」，没改「一天能主动几次」（还是 `dailyCap`）——开口率会不会上去，要过几天看 `wakes.jsonl` 里 `kind: 'thread'` 的次数。


### M91. 欠着的话会叠成三行，压在每一轮开头
- **概念**：查"她最近不对劲"时翻到最底层——她的每一轮提示里都固定带着三段：

  ```
  · 你还欠他一句答复：答应今天把书房随笔札记理顺后，挑两段能看的拿给他看…
  · 你还欠他一句答复：把 note/library/随笔选段.md 里那两段随笔递给他看（已理好，等他露面）…
  · 你还欠他一句答复：他下次报数，我只答一句「知道了」，不追问「你想让我认什么」。。
  ```

  三条其实是**同一件事**说了三遍，而第三条根本不是欠话——是梦把她自己定的做法（「下次少说两句」）写进了 `debts`。后果是她的每一轮都从"还债"开始：一被问到随笔，不是绕，就是把整篇贴出来；一被报数，先声明"我只答一句知道了"。这三行比任何提示词都更能定住她的行为。
- **实现**：
  - `sameDebt(a, b)`：去标点后相同、互相包含、或字符重合（以较短那句为分母）≥0.8，算同一件事。
  - `liveDebts(debts, now)`：去重 + **48 小时过期**（挂了四十八小时还没兑现、也没人再提，它就只是存档，不是"他还在等"）+ 新的在前。
  - `relationLines` 只注入**最新的一条**，不再是 `slice(-3)`。
  - `patch()` 写 `debt` 时先找同义项：有就刷新时间和措辞，不再占第二个位置。
  - `maintain_relation` 的 `debt` 说明补上边界：只写**他还在等的那一件**；自己给自己定的做法不算欠账。
- **位置**：`bots/amber/persona/relations.ts`（`DEBT_TTL_MS`、`sameDebt`、`liveDebts`、`relationLines`、`patch`）、`bots/amber/persona/relationTool.ts`（字段说明）。
- **验证**：`tests/amber/relations.test.ts` 25 项（+4：同义判定、48 小时过期、同名取最新一次、状态里只出现一条「你还欠他」）；接真实 `relations.json` 跑：**5 条 → 活着 4 条 → 注入 1 行**。
- **线上清理（按用户指示）**：先把梦写成"欠账"的那条自我规训（`6ba43df1ae34`）删掉，再把剩下四条规定同一件**已经兑现过**的随笔（11:42/11:44 已经整篇贴给群主，14:17 又被补记了一笔）一并删掉。`relations.json` 群主名下 debts **5 → 0**，两份备份在 `C:\Cortico\backup\relations-before-m91.json` 与 `relations-before-essay-debt.json`；重启后 `relationLines` 对群主返回空数组，不再有「你还欠他」那行。
- **边界**：48 小时是拍的——按"一件事挂两天还没人提就不算在等"定的，没有数据支撑。同义判定按字符重合，换个完全不同的说法认不出来（比如"挑两段随笔给他看"和"把 note/library 里那两段递给他"不会被合并）；那时候只能靠 TTL 和"只注入一条"兜住。
- **已被 M92 取代**：这一版改的是症状（去重、过期、只注入一条），债仍然挂在长期档案里、仍然是无条件注入。下一版把层搬正了。


### M92. 债不是欠条，是对话里的悬空
- **概念**：M91 治的是"叠成三行"，没治层。`Relation` 是"我是怎么看这个人的"——信任、熟悉度、好感度，几个月动一次；**"我还欠他一句随笔"不是这个人的属性，是一段对话里的悬空**，过两天就该自己没了。放在长期档案里、由 `relationLines` 每轮无条件注入，必然会长住，也必然会把每一轮变成还债。同一个仓库里已经有一个做对的模型：`ConvState.openLoop`——她说完没人接，下次被叫到时跟一次，跟完就落地，从来不积。
- **实现**：
  - `ConvState.pending: PendingNote[]`（`{ id, at, text, referredAt? }`，最多三条）；`CompanionStore` 加 `notePending`（同义项刷新不追加）、`closePending`（按片段销）、`notePendingReferred`。
  - 纯函数 `duePending(conv, now)`：**最老的、还没在他眼前带出来过的那一件**；`PENDING_TTL_MS` 48 小时。
  - `Persona.injectPending`：这一批里有外部消息时，把 due 的那件递**一次**——「他还在等你一件事：「…」。提不提、什么时候提，你自己看。」——随即标 `referredAt`，不再重复。
  - `Relation` **去掉 `debts`**（`relations.json` v3，旧字段读到就丢）；`relationLines` 不再输出「你还欠他一句答复」。
  - `maintain_relation` 的 `debt`/`closeDebt` 换成 `pending`/`resolved`；persona 按 QQ 找到他所在的会话再落笔。`resolved` 成功时调 `rewardFulfilled` 涨好感度——那是少数几件真正算数的事，不能随债务搬家一起丢掉。
  - 面板去掉 `debts` 那一栏。
- **位置**：`bots/amber/persona/companion/state.ts`（`PendingNote`、`duePending`、`overlaps`、三个 store 方法、load 兜底）、`companion/index.ts`（四个转发）、`persona/relations.ts`（v3、去 debts、`rewardFulfilled`）、`persona/relationTool.ts`、`persona/index.ts`（`injectPending`、`convForPerson`、工具接线）。
- **验证**：`tests/amber/companion.test.ts` +5（同义去重、带一次就散、48 小时过期、兑现即销、落盘重开还在）；`relations.test.ts` +2（pending 走会话不进档案、兑现同时涨好感度）；`relation-constraint` 集成用例改成断言**不出现**「还欠他一句答复」。amber 382 + integration 53 全绿，两端 typecheck 干净。
- **线上实跑**（23:16 之后自己发生的，不是我造的）：梦写了一条 pending「答应过陪他拆耦合：等他要把每个功能独立成模板时，画一张模块和交互面的图给他」→ 落在 `companion.json` 的会话状态、`relations.json` 里没有 → 他再开口时注入一次 → `referredAt` 已标、`duePending` 返回 null；`grep -c "他还在等你" session-main.jsonl` = 1。
- **边界**：一次只带一条——同时欠两件时，第二件要等他下次开口。`pending` 存在 `companion.json` 里，交接不丢。（"跟着会话走"这条已被 M93 改掉：现在按人跨会话找。）


### M93. 欠的是人，不是会话
- **概念**：M92 把债从档案搬进了会话状态，但寻址只认会话——**同群换个人开口，也会把不相干的账翻出来；而欠的那个人换到私聊说话，那件事就永远沉底**。存在哪个会话只是记账位置，提醒和兑现都该按人找。
- **实现**：
  - `PendingNote.subject`（QQ 号）；`notePending(conv, text, at, subject)`，同义项刷新时把主人补上。
  - 纯函数 `duePendingFor(convs, subject, now, currentConv)`：**当前会话优先**，再扫他还在说别的会话；只认 `subject` 相同的那条。
  - `CompanionStore.dueFor` / `closeFor`（兑现跨会话销）；`Persona.injectPending` 取这一批外部事件里最后一位说话人，按人找、按人销。
  - **旧账没有主人**（`subject` 为空）：仍在它自己那个会话里认，行为不变，靠 48 小时自然散掉。
- **位置**：`bots/amber/persona/companion/state.ts`（`subject`、`duePendingFor`、`notePending`、`dueFor`、`closeFor`、load 兜底）、`companion/index.ts`（三个转发）、`persona/index.ts`（`injectPending`、`notePendingFor`、`closePendingFor`）。
- **验证**：companion +7（同群别人开口不外溢、跨会话带出、当前会话优先、跨会话销账、别人的账不被误销、落盘保留主人、旧账不外溢）。做了两次反向验证：去掉 `subject` 判定 → 泄漏用例红；去掉 `closeFor` 的主人判定 → 误销用例红。amber 391 + integration 53 全绿，`typecheck` / `typecheck:web` 干净；23:40 重启（pid 2256），WebUI 200。
- **边界**：`subject` 只在梦写 pending 时带上（`maintain_relation` 的 `qq` 是必填）。他若从没开过口，`convForPerson` 会退到最近活跃的会话记账——提醒仍然只在他真的开口时才出，所以落错位置也不会泄漏给别人。


### M94. 被点名、写了正文，不等于说过了
- **概念**：23:41 群主问「今天晚餐吃的什么」，她把答案写进了 assistant 正文（「煮了碗青菜面，配两个煎蛋」），手上同时在写日记——这轮记成 `acted`。兜底只认「这一轮什么工具都没调」的 `unsent-text`，于是一句都没发出去，五分钟后才在另一轮里自己补上。
- **实现**：`textOnly` 从「没有任何工具调用」放宽到「**被点名叫到**（`wake: mention` / `name`）+ 有正文 + 没发出去」；这一轮干过别的活不再是否决理由。真调过 `qq_draft` / `qq_confirm` 的不算——被复核扣下的那条，催第二遍是错的。
- **位置**：`bots/amber/persona/index.ts`（`onTurnEnded` 的结局判定，`index.ts:561-569`）。
- **验证**：`amber-wake-log` +1（点名 + 调 `read_file` + 正文 → `unsent-text` 且再起一轮纠偏）；反向验证：去掉 `addressed` 条件 → 该用例红（记成 `acted`）。amber 391 + integration 54 全绿，`typecheck` / `typecheck:web` 干净；23:56 重启（pid 2908），WebUI 200。
- **边界**：只在被点名的那一轮放宽。他自己嘀咕、`thread` / `ambient` 叫醒时写了正文，仍记 `acted`，不会催——那种场合"想的比说的多"是常态。


### M95. 对话不该只有一个人推
- **概念**：近 40 条群消息里她发了 19 条、只有 **1 条**是问句；最近 80 轮唤醒只有 **14%** 带问句、13% 用了两拍。翻提示词就明白了：整份 `ENV_PROMPT.md` 的重心是"默认不说话"——七条不要开口、**不连续追问**、对方没回就不继续找话说、不接管话题、说完就停。**没有一条要求她把话头递回去**，结构上她只能做问答机。
- **实现**：
  - `ConvState.oneSided` / `oneSidedNudgedAt`：别人开口、她接了一句、句尾没有问句 → 计数 +1；她问回去、自己起头、或中间隔 6 小时以上 → 归零。
  - `Companion.oneSidedDue(conv)`：满 3 轮回一个数字（3 → 6 → 9），**同一个数字只提一次**，不然每轮都来一句比不提醒更烦；超过 6 小时没说话就不翻旧账。
  - `Persona.injectOneSided`：投递时递一次——「这一线连着 N 轮你都是接一句就收了，没把话头递回去。答完可以问回他一句，或者说说你自己那边的」。**电量低（短回预算）的那一轮不提**。
  - 提示词：「不连续追问」改成「同一个问题问一遍就够了，他不答也别追着问；换一个问题、或者把你的话递回去，都不算追问」；§说话的方式加一句「答完不等于说完」。
- **位置**：`bots/amber/persona/companion/state.ts`、`companion/index.ts`、`persona/index.ts`、`deployments/amber/worlds/qq/ENV_PROMPT.md`。
- **验证**：companion +7（三轮回一次、问回去归零、自己起头归零、隔七小时重算、台阶 3→6、落盘保留、隔夜不提旧账）；`amber-wake-log` +1（三轮只答后，第四轮投递里带提醒）；反向验证：注释掉注入 → 该用例红。amber 398 + integration 55 全绿，`typecheck` / `typecheck:web` 干净。00:17 重启（pid 11496），WebUI 200。
- **边界**：这是"攒够三轮提一次"的状态提醒，不是每句都催，也不要求每轮反问——那会把聊天做成查户口。计数只认"他开口、她只答"；她主动起头不计。阈值 3 是拍的，没有数据支撑。


### M96. 线索开着，不等于每句都是对她说的
- **概念**：00:09 之后群里每一轮唤醒都是 `thread`，其中大量是群主在 @ 别人、或在跟玩4i 讨论技术。两处叠加：`waking` 里 `threading` **无条件叫醒**（`world.ts:1975`），而 `archiveOnly` 又对线索消息**完全跳过**注意力判决（`!threading && judged.tier !== 'focus'`）——"这条该不该回"的判断对熟人从来不跑。再叠上刚上的 M94（写了没发的正文被催着发，这段里 3 次）和 M95（两次提醒"别让这场只剩他一个人推"），沉默的两个出口都被堵住。
- **实现**：
  - `addressedElsewhere`：引用的是别人的消息、或 @ 了别人 → **不进线索唤醒、只归档**（同时 @ 了她仍然算找她，点名优先）。
  - M95 的提醒：房间里不止一个人在说、又没点到她时，不催"把话头递回去"（`oneSidedWorthNudging`）；也不消耗那份计数。
  - M94 的纠偏：同一情形（旁听）不催她发出写下的正文——她写的可能只是自己的想法。
- **位置**：`src/worlds/qq/world.ts`（`waking` / `archiveOnly`）、`bots/amber/persona/index.ts`（`batchAddressed` / `batchSpeakers` 与两处门）、`bots/amber/persona/companion/index.ts`（`oneSidedWorthNudging`）。
- **验证**：`qq-thread-resume` +1（@ 别人、引用别人 → 不叫醒）；`amber-wake-log` +1（旁听不催发）；companion +1（谓词）。两次反向验证：把 `addressedElsewhere` 置 false → 线索用例红；去掉 `bystander` 条件 → 旁听用例红。amber 399 + integration 57 全绿，`typecheck` / `typecheck:web` 干净。00:47 重启（pid 6220），WebUI 200。
- **边界**：只有 **@ 和引用** 是硬信号。没点名、没引用、但实际在跟别人说话（"你看看"这种）仍会叫醒她，靠她自己读房间形状判断——这次只修确定的两类。群里多人对谈时她会少说，一对一的连续性不受影响。


### M97. 旁听的那几句，不为它醒
- **概念**：M96 只挡住了 @/引用。没点名、没引用、但实际是跟别人说的（"你看现在，沉默策略发力了"）仍会叫醒她。今天 85 次唤醒里 36 次以沉默结束，占当天唤醒输入的 47%——那不是钱的账，是**每一次唤醒都是一次"她可能说错话"的机会**。
- **实现**：
  - `RoomSample.self`：她自己每发一条就往房间记一笔。**只用于判断"这场还有没有她"，不计进任何数字**——「3 人在说」仍然只数别人。
  - `RoomFacts.othersTalking`：最后一条是别人说的、**上一条换了人**、且最近三条里没有她 → 这一场不是她的。只看"人多"会把"他连着说两句"也算成旁听，那是最常见的对话形状。
  - `world.ts`：线索开着但上面成立时只归档、不叫醒；点名/@/引用她仍然优先。
  - `background` 档里的**问句**不再直接丢弃，进背景缓冲——那个人下次叫她时一起递到。
- **位置**：`src/worlds/qq/room.ts`（`RoomSample.self`、`othersTalking`、`lastSelfAt`）、`src/worlds/qq/world.ts`（`sendToTarget` 记 self、`waking`/`archiveOnly`、`rememberAmbient`）。
- **验证**：room +2、`qq-thread-resume` +1、`amber-wake-log` +2。三次反向验证：`sidelined` 置 false → 线索用例红；`self` 标记改 false → 旁听用例超时；去掉 background 问句分支 → 背景用例红。amber 399 + integration 59 全绿，`typecheck` / `typecheck:web` 干净；worlds 只剩一个预先存在的环境失败（本地没编 node-canvas）。02:00 重启（pid 9084），WebUI 200。
- **边界**：这条会让她在"有人刚说完、另一个人接着说"时听不见——**哪怕后一个人其实是在跟她说话**。所以点她名、@ 她、引用她仍然一定叫醒；同一个人连着说（一对一）不受影响。另外背景问句只在**同一个人下次叫她**时递到，不是随便谁叫都会翻出来。


### M98. 线索有保鲜期
- **概念**：`qq-threads.json` 里 7 条线索全是 `open`，最老的一条开在 **8 天前**——跟谁说过一次话，就永久订阅那个人的每条群消息。M96/M97 挡得住 @/引用/旁听，挡不住"他一个人连着说两句"，而那正是最常见的形状。今天 88 次线程唤醒里 **68 次是陈述句**，40 次沉默唤醒里 32 次是陈述句。
- **实现**：
  - 线索记录加 `warmAt`：**她**在这条线索里最后一次开口的时间。`openThread` 开线时写入；`sendToTarget` 里她每发一条，就按"这个会话里最后一条入站消息的发送者"刷新。
  - `isThreadWarm`：`now - warmAt <= threadHotMinutes`（默认 360 分钟）。判她的开口，不判他最后一句——否则话多的人能让线索永远热着。
  - 冷掉的线索：陈述句只归档；**问句仍然叫醒**，并把线索重新焐热；点名、@、引用她本来就走在线索之前，不受影响。
  - `threadHotMinutes` 进配置（`QQConfigSection` / `QQ_DEFAULTS` / `definition.ts` 映射），默认 360，0 = 永远算冷。
  - 老文件迁移：没有 `warmAt` 时用 `lastMessageAt` 兜底——最近还聊着的线不会一升级就断，放了几天的那批直接算冷。
- **位置**：`src/worlds/qq/world.ts`（`warmAt`、`isThreadWarm`、`touchThread`、`lastSpeakerByConv`、`waking`/`archiveOnly`）、`config.ts`、`definition.ts`。
- **验证**：新文件 `qq-thread-freshness` 4 项（冷线索陈述句不醒、冷线索问句醒、热线索陈述句醒、点名不受保鲜期影响）；反向验证：`isThreadWarm` 恒真 → 冷线索用例红（`expected 3 to be 2`）。amber 399 + integration 63 全绿，`typecheck` / `typecheck:web` 干净；worlds 仍是 `node-canvas` 那个预先存在的环境失败。14:41 重启（pid 12408），WebUI 200。
- **边界**：早上他发一句陈述句（"昨晚那个 bug 我修好了"）不会叫醒她——这是刻意的。**问句把她叫醒时会把线索焐热**，哪怕她最后没回；那之后六小时内的陈述句仍会叫醒她。6 小时是拍的，按"线程唤醒里沉默轮占比"和"他问了她没回"两个指标再调。


### M99. 长篇：分卷、分章，靠摘要接得下去
- **概念**：以前每部作品 300–5200 字，写完就收；每段只看"本子 + 最后 900 字"，写到第十章前面就是黑洞。本子自身也封顶（12 条事实、12 条线、6 条最近动作），撑得起短篇，撑不起几十万字。
- **实现**：
  - `Work.volumes`（卷 → 章 → 摘要/facts）、`chapterStart`（当前章在正文里的字符起点）、`volumePlan`（立项时排的 3–6 卷）。
  - **收章**：写满 `chapterChars`（默认 3000，夹在 800–12000）或作品收尾时，一次调用把整章压成 1–3 句 + 最多 3 条事实。调用失败不丢正文——摘要退化成最后 80 字，正文与进度已经先落盘。
  - **收卷**：一卷攒够 `chaptersPerVolume`（默认 8，夹在 2–20）章，把章摘要再压成一段。
  - **续写上下文**：本子 + 前面各卷各一行（最多 8 卷）+ 本卷各章各一行 + 最后 900 字。**不随篇幅增长**。
  - **立项**：`creative.longForm` 打开时目标字数放宽到 20000–`maxTargetChars`（默认 300000），并要求排卷目。
  - **面板**：作品详情多一节「卷章」，逐卷逐章列出摘要。
- **位置**：`models.ts`（`Chapter`/`Volume`/`longFormContext` 等）、`store.ts`（老书柜补齐新字段）、`prompt.ts`（立项/收章/收卷三支提示词）、`index.ts`（`maybeCloseChapter` / `closeVolume`）、`creativePanel.ts` + `webui/companion.ts`、`config.ts`。
- **验证**：creative +6（阈值边界、上下文只带摘要、老柜子迁移、收章、收卷）；反向验证：关掉收章 → 两个流程用例红。amber 405 + integration 63 全绿，`typecheck` / `typecheck:web` 干净；`pnpm build:web` 重建，23:06 重启（pid 14384），WebUI 200。
- **边界**：代码里**默认关着**（`creative.longForm: false`），amber 这个部署在 2026-11-01 23:11 打开了它。打开后她的**下一部**作品会是两万到三十万字，按现在 220 字/段、6 段/天，**三十万字要大半年**，期间 `maxActiveWorks: 1` 意味着她不会写别的。摘要的质量决定她记不记得住前面——这是长篇唯一真正脆弱的地方，卷章再多也替代不了正文。


### M100. 写多大由她定，不由配置定
- **概念**：M99 的 `longForm` 是全局开关——一开，她之后的每部作品都是长篇。可"这一部该写多大"本来就是创作判断，交给配置等于替她做了决定。她要的是：想写长的就写长的，想写短的写短的，拿不准还可以问人。
- **实现**：
  - 立项提示词让她自己挑档：**短 300–5200 / 中 20000–60000 / 长 60000–上限**，并写一句为什么；判据是这段日子的状态、眼前这个念头、以及群里最近说的话。
  - `pickScale` 认她写的档位，认不出才按她给的目标字数推；`longForm` 从"每部都长"降级成"**长篇这一档开不开放**"——关掉时她只能选短。
  - 只有中/长才排卷目。
  - 立项时把**群里最近 12 条话**（最多 800 字）递给她：她要是自己在群里问过"想看长的还是短的"，答案就在这几行里。
  - 作品记下 `scale`，面板显示「规模：长篇 · 目标 X 字」。
- **位置**：`models.ts`（`SCALE_BANDS` / `pickScale` / `Work.scale`）、`prompt.ts`（立项提示词）、`index.ts`（`begin`）、`persona/index.ts`（`creativeRecentTalk`）、`creativePanel.ts` + `webui/companion.ts`、`config.ts` 注释。
- **验证**：creative +4（说长就按长档并排卷目、能写长但她选短仍是短、没放开时想长也只能短、`pickScale` 判定）；反向验证：`pickScale` 恒返回短 → "说长"用例红。amber 409 + integration 63 全绿，`typecheck` / `typecheck:web` 干净；`build:web` 重建，23:26 重启（pid 8320），WebUI 200。
- **边界**：**"问群友"不是一条自动问答流程**——她得自己在群里问，答案靠"最近群聊"这个口子带进立项；她没问，看到的就只是大家在聊什么。写多长仍是她一次判断，不是协议决定。
- **自查又修了两处**：`(1)` 收章原本只看全局开关——她自己选了"短"，长篇开着照样会在收尾时给她收一章、建一个卷；现在收章按**她选的档位**。`(2)` 摘要调用失败时原来会拿"最后 80 字"当摘要，那句话会永远留在上下文里；现在没摘要就不收这一章，留着下次重压，只有超过三倍篇幅才兜底。各配一条用例，两次反向验证都红。
- **长篇的分享节点也改了**：`nextMilestone` 原来按目标字数比例算——三十万字要写到四万二才够"刚成形"，一部书七个月只给三次机会，还都不落在收卷这种真正的节点上。现在有卷的作品**按卷给**：收掉第一卷算成形，收到计划的一半算过半；整部写完时最后一卷哪怕没攒够也收掉，不然它永远没有整卷摘要；收尾那一小截也不再用 200 字门槛卡掉（60 字以下才跳过）。
- **仍缺的**：节奏没为长篇调过——220 字/段 × 6 段/天，三十万字仍是 227 天，要不要给长篇更大的段由部署决定；另外"她会不会真的去问群友"是行为问题，代码只给了答案能进来的口子。


### M101. 她给正文改了名，账本还指着旧路径
- **概念**：23:48 她在群里说「改了。《差一百一十四秒》」——她真的用文件工具把 `创作/六秒内的回执.md` 改名成 `创作/差一百一十四秒.md`（memory 仓库的 git 历史里是一条 **R100 重命名**）。但 `creative.json` 里那部作品的 `file` 还指着旧路径，下一次续写 `read` 到 null，会把整部当成空白，在几万字孤儿之外另起一个同名文件——看着就是"她突然失忆重写"。
- **实现**：`advance()` 读不到正文时调 `adoptRenamedFile`——创作目录里**只有一个**没被别的作品占着的 `.md`、且它确实装着差不多份量的正文（≥ `max(200, currentChars × 0.5)`）时，认它就是它：改 `file`、按文件名改 `title`、落盘、记日志。`currentChars` 为 0 的新作品不参与，避免刚立项就抢走别人的文件。
- **位置**：`creative/index.ts`（`adoptRenamedFile`、`advance`）、`persona/index.ts`（`list` 依赖，走 `memory.listDir`）。
- **验证**：creative +1（改名后跟着新文件走、新段落接在旧正文后面、旧路径不再被写）；反向验证：去掉 adoption → 用例红（`expected '创作/六秒内的回执.md' to be '创作/差一百一十四秒.md'`）。amber 414 + integration 63 全绿，`typecheck` / `typecheck:web` 干净；23:59 重启（pid 14040），WebUI 200。
- **边界**：只在"恰好一个候选"时认。创作目录里有多个没被记录的 `.md` 就不猜——宁可另起，也不写错别人的正文。

### M102. 他没听懂，她却把同一个问题又问了两遍
- **概念**：10:27 的主动时刻拿创作当由头，她把小说里的一处卡点直接抛给群——「签章栏空着也能交……算诚实，还是只是把「认」推给倒查的人」。她用的是小说里的词，没读过那篇的人根本接不住。群主回「什么意思」，她换了个措辞把同一个问题再问一遍；再回「我没听懂啊，你这起头是什么意思」，她的回答开头终于对了（「没别的意思，写小说卡住了」），结尾却把那个问题**第三次**问了出来。四条消息里三条是同一道谜。
- **判断**：这不是相似度阈值的问题——三句的 bigram 重合只有 0.14–0.24，把 `REPEAT_WARN` 调低只会误伤正常对话。是她**没有「对方没听懂时放弃原目标」这一条**：她起这个话头本来是想拿到答案，被说没听懂之后仍在追原来那个问题。
- **实现**：
  - `ENV_PROMPT.md`「什么时候该说话」加一条：他说「什么意思／没听懂」→ 先用一句大白话交代前因（在做什么、卡在哪、为什么想到问他），说完就停；不要把同一个问题换个说法再问一遍。
  - `companion/sources.ts` 的创作分享由头改口：原来允许「只说一句你自己还没想通的地方」（于是只递谜面），改成——他们没读过你写的东西，要说就先把「我在写什么、卡在哪」用大白话交代清楚，别拿只有读过的人才懂的词去问他。
- **位置**：`deployments/amber/worlds/qq/ENV_PROMPT.md`、`bots/amber/persona/companion/sources.ts`（`creativeShareCandidate`）。
- **验证**：`typecheck` 干净；amber 414、integration 63 全绿。行为侧无法用单测固定（改的是提示词），只能看下一次真实发生时她会不会改口。
- **边界**：没有加任何跨轮相似度拦截——同一件事换个说法再问，字面相似度抓不住，硬加只会误杀正常对话。这一条靠提示词约束她的**目标**，不靠正则拦她的**句子**。

### M103. 她每轮只看见备忘的标题，看不见「该怎么说话」
- **概念**：`memo/session.md` 是 2,982 字；前缀里每份常驻 memo 只带开头 **350** 字（`memory.ts` 的 `RESIDENT_CAP`）。截断落在第 350 个字，正好切在「最要紧的几条」第二条的半句上——而 `## 开口原则` 那 12 条（第 783 字起，含「被点名或被直接问才答；**答完就停，一到三句**」）**从来没进过她的上下文**。同一份文件里，工具说明还写着「顶层文件常驻（全文进前缀）」，与实现正好相反。于是每轮喂到她眼前的是「图是心境，不是数据」这类判断句，管她怎么说话的那一节在窗外——她自然答得像在写评论。
- **澄清**：这一条不是「她最近变格言化」的证据。那个说法查过：按天统计对仗句式密度 / 长消息占比 / 近似重复率，10-23 到今天没有系统性上升（见 PROGRESS 2026-11-02 条），当时的「翻倍」是两次统计分母不同造成的假象。
- **实现**：
  - `RESIDENT_CAP` 350 → **1200**，窗口扩到能盖住「位置 + 最要紧的几条 + 开口原则」。
  - 截断改成按行边界（`clipLines`，与 `self.md` 的 `selfSummary` 同一套），不再切在半句上；收尾写明「前 1200 字；全文用 read_file 读 memo/x」。
  - `tools.ts` 三处「全文进前缀」改成实话（主意识一段、梦一段、常驻满时的报错）。
  - `subconscious/prompts.ts` 加两条：顶层 memo 只有开头 1200 字进前缀，**把每轮要照着做的写在最前面**；`# 我喜欢的语言风格` 那节设预算，加一条先合并或删一条。
- **位置**：`bots/amber/persona/memory.ts`（`RESIDENT_CAP`、`clipLines`）、`bots/amber/persona/tools.ts`、`bots/amber/persona/subconscious/prompts.ts`、`tests/amber/memory-self.test.ts`。
- **验证**：memory-self +2，两条都反向验证过——`RESIDENT_CAP` 改回 350 → 「窗口够放进怎么说话」红；把 `clipLines` 换回硬截 → 「截在整行上」红。amber 416 + integration 63 全绿，两端 typecheck 干净；11:06 重启（pid 1776），`GET /api/prompts/prefix` 里已能读到 `## 开口原则` 和「答完就停，一到三句」。
- **成本**：前缀 13,321 → 14,279 字（约 +480 token/轮）。
- **边界**：没有提高 memo 的常驻**条数**上限，也没有把整份 3,000 字的 memo 全塞进每轮——那会让她每轮都重读一整天的流水。窗口只负责「这一段够用」，剩下的仍靠她自己 `read_file`。

### M104. 「答完不等于说完」和「话答完就落地」是两条相反的指令
- **概念**：这两句每轮都在她的前缀里，方向却相反。`ENV_PROMPT` 说「**答完不等于说完**：真好奇就问回他一句，或者把话头引到自己那边」；`CONSTITUTION.md` 的「少用」说「说完再补一句交代自己为什么这么说——「说明感」多半出在这一层，话答完就落地」。严格说不是冲突（递话头 ≠ 解释自己），但两条挨着送到眼前，最容易被读成「答完再加一句」。
- **实现**：
  - `ENV_PROMPT.md` 那句补一句界分：这是**换一个方向**，不是给刚才那句补解释——答完再补说明自己为什么那么说，就是说明感，那句要删掉。
  - `CONSTITUTION.md`「少用」四条（把每一句都接上 / 长篇解释 / 说明感 / 替他总结）合成一帧：「答完之后别再往上加」+ 两条界限。**真正无损的合并只省 9 个字**——这四条本来就压过一遍，收益全在结构（一个框架代替四句平铺），不在字数。
- **位置**：`deployments/amber/worlds/qq/ENV_PROMPT.md`、`deployments/amber/memory/CONSTITUTION.md`。
- **验证**：两端 typecheck 与 amber/integration 未受影响（只改 markdown）；`POST /api/session/reload-prefix` 后前缀里能读到新那句界分与合并后的「少用」，旧的「说完再补一句交代自己为什么这么说」已消失。前缀 14,279 → 14,326 字（`ENV_PROMPT` 加的那句比宪法省下的多）。
- **边界**：没有删任何一条行为条款，也没有动 `# 我喜欢的语言风格` 的另外 18 条——它们各自对应一次具体事故，删掉省下的 token 不够赔一次重犯。

### M105. 语气卡有了关系档、情景分类和质量门
- **概念**：语气卡原来只有一条通路——关键词命中就递一张。三个缺口：**没有关系维度**（对生人和对熟人递同一张卡）、**情景分类窄**（问到她本人、丢图、道别都没有卡）、**没人量过它有没有用**（宪法写着"照着语气卡念"是避免项，但没有任何机制知道她念没念）。
- **实现**：
  - **关系档**：卡片文件名尾部可写 `-cold` / `-warm` / `-close`，按 `Relation.affinity` 分档（<0.15 冷，≥0.5 近，中间温）。带档的卡只在该档出现，不给好感度时按 `cold` 处理——宁可少递一张。`categoryOf` 先剥档再判类别。**同档的卡排在不分档的卡前面**：编号是全局优先级，不这么排，一张通用卡就会把所有分档卡挡死。
  - **情景分类**：13 类，新增 `self`（被问到是不是 AI / 怎么看自己）、`image`（不带字的图）、`goodnight`（道别催睡）；补了四张资料库卡：`11-self`、`12-image`，以及一对真正分档的 `13-affection-cold` / `14-affection-close`（同为「想你了」，生人档和近人档回的不是一句）。
  - **质量门** `styleCardGate.ts`：每次递卡记一条 shot（谁、哪个会话、哪张卡、当时好感度），回合结束补一条 result（有没有开口、回应和卡上那句的 bigram 重合）；`recited = sent && echo ≥ 0.75`；**递到 3 次、照念 2 次的卡自动停用**，不再往她眼前递。账在 `data/style-cards.jsonl`，2 MiB 轮转。
  - **面板**：每张卡多一行「情景 / 档 / 递 N 次 · 开口 N · 照念 N · 平均重合」，被停用的标红。
- **位置**：`bots/amber/persona/styleCards.ts`、`bots/amber/persona/styleCardGate.ts`（新）、`bots/amber/persona/index.ts`（`injectStyleCard` 传好感度、`onTurnEnded` 补结果）、`bots/amber/webui-page.ts`、`bots/amber/webui/cards.ts`、`deployments/amber/memory/note/style/11-*`、`12-*`。
- **验证**：style-cards +9、style-card-gate +6；反向验证三处——去掉档过滤 → 关系档 2 条红；停用门槛改成 99 → 「递三次照念两次就停用」红；去掉「同档优先」的排序 → 「同档的卡优先于兜底卡」红。amber 428 + integration 63 全绿，`typecheck` / `typecheck:web` 干净；11:53 重启（pid 11216），WebUI 200。
- **边界**：只判字面不判语义——"像不像她"要模型，"是不是照念"只要 bigram，所以这层测得出复读、测不出平庸。0.75 这个门槛是拍的，等第一批真实记录再调。

### M106. 语气卡按「跟谁、什么心情、身体什么状态」选，不是只按好感度
- **概念**：M105 只上了一根轴，而且阈值是按想象定的——实测最高好感度 **0.164**（群主），而 `close ≥ 0.5` 按"三个月才到最喜欢"的账要以月计，等于那档永远空着。同一句「亲一下」，对才认识的人和聊了十天的人该用不同分寸；她今天心情好还是烦、有力气还是累，也该不一样。卡不能只按"事"挑，得按"事 × 姿态"挑。
- **实现**：三根轴，各自成档，写进文件名：
  - **关系**（`Relation.affinity`）：`newcomer` < 0.02｜`cold` < 0.08｜`warm` < 0.2｜`close`。阈值按上面那份真实分布校准。
  - **心情**（`RoleState.mood` 四维取最强）：怒最重且 ≥5 → `irritated`；悲或惧 ≥5 → `low`；喜 ≥7 且压过其余 → `bright`；否则 `even`。
  - **生理**（`RoleState.energy` + `InteroStore.socialBattery/load`）：精力 <35、电量 <0.3、或负荷 ≥0.6 → `spent`；精力 ≥70 且电量 ≥0.6 且负荷 <0.3 → `fresh`；否则 `steady`。
  - **卡名语法**：`<编号>-<场景>[-<标签>]…`，标签可叠（`14-affection-close-bright`）。**场景必须对上，写了几个标签就必须全对上；越具体越优先**，同分按编号——一条通用卡不会把更贴此刻的那张挡死。
  - **注入**：`[语气卡·affection/close/bright]（此刻：对这个人 close，心情 bright，身体 steady）…`，让她知道这张是按什么挑的。
- **位置**：`bots/amber/persona/styleCards.ts`（`contextOf`/`relationOf`/`moodOf`/`bodyOf`/`parseCardKey`/`tagsMatch`）、`bots/amber/persona/index.ts`（`injectStyleCard` 从 relations + roleState + intero 现算姿态）、`styleCardGate.ts`（每次递卡记 `关系/心情/身体`）、`webui-page.ts` / `webui/cards.ts`（卡片显示场景与姿态）。
- **验证**：style-cards 15 条（新增姿态换算、标签解析、多轴匹配、越具体越优先）；反向验证两处——删掉「越具体越优先」的排序 → 该用例红；把停用门槛改成 99 → 停用用例红。用真实 state 文件跑过一遍：群主 `warm/even/steady`、DeepSeek `cold/even/steady`、白毛狐狸水 `newcomer/even/steady`。amber 430 全绿，两端 typecheck 干净；13:17 启动（pid 11388），WebUI 200。
- **边界**：姿态只决定"递哪张卡"，不决定内容——没有对应姿态的卡时，仍然退到场景卡或什么都不递。心情/生理的阈值没有数据支撑，是拍的；关系那根轴已经按真实账本校准过。卡要真按姿态写才有效果，只有一张通用卡时，这套匹配不会凭空变出分寸。

### M107. 附件与运行日志按月份保留半年
- **概念**：`data/media/`（群图缓存，488 份 374.6M，**一天新增 113M**）与 `data/runs/`（209 个运行目录 31.5M）都没有任何清理逻辑。按当时的速度，media 一个月会长到 1.1G。决策是**按月份保留半年**（不按天——10 天的数据说明按天太短，也说明当时的目录才刚满十天，任何"保留 30 天"等于不清理）。
- **实现**：`src/core/storageRetention.ts` 的 `pruneStorage(dataDir, months, now)`：
  - `data/media/`：按文件 **mtime** 早于保留线就删——它是内容寻址的缓存，`LogBlobStore.read` 找不到就返回 null，历史消息的文本形态不受影响。
  - `data/runs/`：按目录名里的日期（`r-YYYYMMDD-HHMMSS-xxxx`）判断，**不信 mtime**——复制、备份都会改写它。
  - **`memory/` 一行都不碰**：她特意存下来的图在 `external/qq/images/`，那是工作区不是缓存。
  - 接线：`bot.ts` 拿到单实例锁之后扫一次，之后每 24 小时一次（`unref`，不拖住退出）；`storage.retentionMonths` 缺省 6。
- **位置**：`src/core/storageRetention.ts`（新）、`src/bot.ts`（启动与定时清扫）、`src/core/types.ts`（`CoreConfig.storage`）、`tests/core/storage-retention.test.ts`（新）。
- **验证**：5 条用例（保留线按自然月、附件按 mtime、运行目录按 id 不信 mtime、工作区不动、目录不存在/月数为 0 空转）；反向验证——把运行目录的判据换成 mtime → 「按 id 里的日期算」红。`tests/core` 532 全绿，`typecheck` 干净；13:43 重启（pid 1628），WebUI 200，media 仍是 488 份 376M（**没有超过半年的，一条都没删**，这正是预期）。
- **边界**：它解决的是"无限长大"，不是"变小"——半年量级约 20G（机器当时剩 133.8G）。要更小只剩一条路：关掉群图本地缓存（不落盘、只留文本占位），那她就彻底看不见图了，是另一个决定。

### M108. 识图不是坏了，是提示词叫她别承认自己看得见
- **现场**：「以前能识图，现在不能了」。第一版判断错了——以为是模型没有图像能力，去开了辅助视觉。**那个判断被推翻，改动已回滚。**
- **事实（实测，不是看配置猜的）**：
  1. **主模型能收图。** `deployments/providers/DeepSeek/config.json` 里 `multimodal: true`（10-23 就有），模块 `openai-responses-compat` 没有覆写 `accepts`，所以 `core.accepts('image/png')` 返回 true。
  2. **直连 DeepSeek `/responses` 发一张图，HTTP 200**，模型自己的推理里写出了图像内容（"Image appears light pink…"）。
  3. **请求构造器确实会塞 `input_image`**：用她的真实 `log:` blob 跑 `responsesInput`，产出 `input_text, input_image`，data URL 前缀正确。
  4. 也就是说：图片下载 → blob → `input_image` → 模型，这条链一直是通的。
- **真凶**：`ENV_PROMPT.md` 那句「**你看不到图里的东西**……被问到图里是什么，就直说你没看到——别编一个画面出来」。这句话写在她还真的看不见的时候，是对的；`multimodal` 打开之后它变成了一条**叫她否认自己能力的指令**，所以她照做——「图到我这儿就是一行链接，没画面」不是事实，是照着剧本说的。
- **修复**：把那句改写成「**你看得见图，但别把图当表格念**」——没配字先读情绪、一句话就够；只有对方明确拿图问事（报错截图、界面、数据、画的是我本人）才细看细讲；真看不清就说看不清，不编细节。风格约束保留，能力断言删掉。
- **回滚**：上一版加的 `worlds.qq.vision`（指向 hajimi 的 gemini）与 `deployments/amber/.env` 全部删除——辅助视觉一旦存在，`world.ts:1863` 会**跳过图片下载**（`this.vision || !accepts` 恒真），反而让主模型收不到图。
- **位置**：`deployments/amber/worlds/qq/ENV_PROMPT.md`。
- **验证**：`responsesInput` 探针产出 `input_image`；重启后 `/api/storage` 里 `vision` 存储项消失（辅助视觉已关）；前缀里新句在、旧句没了。14:55 重启（pid 2500），WebUI 200。
- **边界**：真正的端到端证据还要等下一张群图——如果她仍然说"没画面"，那才是模型层的问题，目前三层证据都指向"能看到"。

### M109. 转发记录里的图从来没被下载过
- **现场**：同一天两次，结果相反。
  - 13:57 直接发一张图 → 她读懂了，回的是图里的梗（「the model is the product」）。
  - 14:04 转发一条含 **20 张图** 的聊天记录，再 @ 她「解读一下这个」→ 她回「二十张图到我这儿只剩二十个方框，一个字都读不到」。
- **证据**：那条 `qq.forward` 事件在 `events.jsonl` 里长这样 —— `blobs=无`，正文 20 个 `[图片]`。直接发的那条走的是 `imageDownloads → blob → input_image`，转发走的是另一条路。
- **根因**：`renderForwardNode` 用 `renderSegmentsPlain()` 渲染节点正文，`case 'image'` 只吐一个字面量 `[图片]`——**不取 URL、不下载、不生成 blob**。所以转发里的图对模型和辅助视觉都不存在，她说的"方框"是字面事实，不是抱怨。
- **修**：`ForwardNode` 加 `images`；`lookupForward` 按节点顺序收集图片地址，下载**前 `FORWARD_IMAGE_CAP = 4` 张**挂成 `qq.forward` 的 `blobs`，正文末尾补一句「这条转发里有 N 张图，前 K 张随这条消息一起给你了」。封顶是因为实测一条转发就有 20 张，全塞进一次请求会同时打爆上下文和成本。
- **位置**：`src/worlds/qq/world.ts`（`ForwardNode`、`renderForwardNode`、`lookupForward`、`FORWARD_IMAGE_CAP`）。
- **验证**：`world-loop.test.ts` +1——转发里塞一张 `data:` PNG，断言正文仍是 `[图片]` 占位、`blobs.length === 1`、提示文案在那；反向验证去掉 `blobs` → 该用例红。`tests/worlds/qq` 227 全绿，`typecheck` 干净；14:09 重启（pid 9960），WebUI 200。
- **边界**：只带前 4 张，第 5 张以后仍然只有占位；下载失败（URL 过期、超过 `maxImageBytes`）会静默跳过，正文里的「这次一张都没能取到」是唯一提示。

### M110. WebSearch 换 Tavily 并打开
- **现场**：`worlds.websearch.enabled` 一直是 `false`，`ENV_PROMPT.md` 是空文件——她从上线起就没有过联网检索工具，问「最近有什么新闻」只能凭训练数据答。
- **换后端**：删 `brave-client.ts`，新增 `tavily-client.ts`。不是换一个 URL 就完事，三处语义变了：
  - **mode 从 6 个收到 5 个**。Tavily 没有视频检索；留着 `videos` 只能是静默降级成网页检索，工具描述就撒谎了。现留 `auto / answer / links / news / images`。
  - **配置换了三项**。Tavily 没有 `search_lang` / `ui_lang` / `safesearch`，`country` 也不是 ISO 两位码而是小写英文名（`china`、`united states`），且新闻检索不吃这一项。故 `worlds.websearch` 从 `country/searchLang/uiLang/safesearch/timeoutMs` 换成 `country/searchDepth/timeoutMs`，新增 `searchDepth`（`basic` / `advanced`，后者多抓一页、更准也更贵）。
  - **`answer` 是真答案**。Brave 走 `llm/context`，Tavily 用 `include_answer: 'advanced'` 让引擎直接写一段，工具输出把它放在来源列表**前面**并标注「引擎写的，要拿下面的来源核对」——引擎会自信地编。
- **内容长度**：Tavily 的 `results[].content` 是 1.2–1.5k 字的大块（实测 6 条 ≈ 8k 字），压到 **400 字**；`answer` 压到 900。不压，一次检索就能吃掉一轮对话的上下文。
- **没写环境提示词**：`worlds/websearch/ENV_PROMPT.md` 保持空。它进的是**每一轮**的系统前缀，而这个工具一天用不了几次；工具描述已经说清什么时候调、`q` 里别塞聊天记录，每条结果后面也自带平台风险那句。给她加一段常驻文案，只会重演 M103 的前缀预算问题。
- **改了 QQ 侧那一处歧义**：`worlds/qq/ENV_PROMPT.md` 原来写「事实是否可靠、要不要查资料」——这句是她**没有任何联网工具**时写的，那时它只能指翻自己的记忆和文件。多了一个 `web_search` 之后，同一个词两个所指，她会默认走老的。就地改成「要不要查——外面的事用 `web_search`，自己记性里的事用 `recall_memory`（一次回答最多查一次）」，只加一个括注，不新增规则段落。
- **位置**：`src/worlds/websearch/`（`tavily-client.ts`、`config.ts`、`strings.ts`、`definition.ts`、`world.ts`），密钥 `TAVILY_API_KEY` 写在 `deployments/amber/.env`。
- **验证**：单测 24 绿（`tavily-client.test.ts` 10 + `world.test.ts` 13 + `index.test.ts` 1），`typecheck` 干净；真连 Tavily 跑通 `news / answer / links / images` 四个 mode，`searchDepth`、`time_range`、`country`、图片连带都确认过；坏 key → 401 且带出 `detail.error`，429/5xx 退避重试。重启后用 `/api/tool-schemas` 确认 `web_search` 进了她的工具表（29 个工具里第 19 个，enum 是新的五档），`/api/worlds` 里 WebSearch `status: active`、密钥灯「已配置」。`ENV_PROMPT` 改完走 `/api/session/reload-prefix` 热更新，前缀里旧句已消失、新句在。
- **决策侧已验**：用她**真实的系统前缀 + 真实工具表**（取自 `/api/prompts/prefix` 与 `/api/tool-schemas`）直接问模型两件事：
  - 「今年诺贝尔文学奖颁给谁了」→ 第一轮就调 `web_search`；
  - 「你今天心情怎么样」→ 调的是 `qq_read_history`，不查网。
  再走完整回合（`scratch/websearch-roundtrip.ts`）：她先查，拿到真结果后回的是一句带判断的话（「安妮·卡森，加拿大诗人…残雪和村上照例陪跑」），没有把六条来源念一遍。
- **端到端**：当天 15:39 群里真问了同一句，她醒了、真调了 `web_search`、真拿到了结果。**堵在她把答案写进正文没发出去**——见 M111。

### M111. 她查到了、也说对了，但一个字没发出去
- **现场**：15:39 群里问「今天诺贝尔文学奖颁给谁了」。她醒了（`thread`），调了 `web_search`，写出一段像样的答案——`sent` 是空的，群里什么都没出现。
- **证据**：`data/wakes.jsonl` 那一条里 `actions.calls` 有 `web_search`、`actions.assistant` 有正文、`actions.sent` 为 `null`、`outcome` 记成了 `acted`。
- **根因一**：「写了正文没发出去」的判据是 `(!meaningful || addressed)`——只要这一轮调过**任何**工具就算"干过事"。M110 之前她在对话轮里几乎不会调工具（`qq_draft` 直接算发出），这条从没咬到过人；多了 `web_search` 之后，"查完资料把答案写在正文里"正好落进这个洞。工具不改变任何外部状态，翻资料和翻文件一样不算"说过了"。
- **根因二**：纠偏外面还有一道 `bystander` 闸——没点名 + 房间窗口里超过一个人就不催。那天房间里正好两个人在说，第二道也挡住了。
- **为什么去掉 bystander**：纠偏不是逼她开口，是把话交还给她——`不想说就 end_turn` 写在纠偏文案里。放过的代价是她写好的回复一个字都没出去，那个更贵。400 轮里这条闸每年只影响个位数的轮次。
- **依据**：近 400 轮里"写了正文、没发、也没起草"共 16 轮；其中 12 轮被现有纠偏接住，**10 次催了 10 次发出去**。漏掉的 4 轮全是"这轮调过工具"（2 次 `web_search`、1 次 `read_file` 类、1 次 `append_file`）。
- **位置**：`bots/amber/persona/index.ts`（`onTurnEnded` 里的 `textOnly` 与纠偏条件）。
- **验证**：新增「线索里叫醒、调过工具、写了正文却没发」用例，把旧判据放回去即红；「旁听的一轮」用例从"不催"改成"同样催一次"，把 `bystander` 放回去即红。`amber-wake-log` 8 绿、`tests/integration` 64 绿、`typecheck` 干净；15:55 重启（pid 12952）。

### M112. 她沉默之后的第二句，还要再叫醒一次
- **现场**：14:20:52「[表情:大怨种] 我得去弄个宅文化知识库」她没接；8 秒后 14:21:00「得喂进去」又起了一轮，还是没接。
- **证据**：近 400 轮里纯 `thread` 唤醒 181 条，65 条沉默；其中 **54 条距上一轮不到 90 秒**（中位数 16 秒），33 条是沉默接沉默。每一条都是 36.5k 上下文的一轮模型调用。
- **根因**：碎片合批只看"这句是不是半句话"（≤12 字且没有句末标点），不看"她上一轮刚刚没开口"。半句攒成一条，但下一句隔了 8 秒再来的完整短句仍然各叫各的。
- **修**：`QQWorld` 自己记两件事——`lastWakeAt`（最近一次叫醒她的消息）、`lastSentAt`（她最近一次真把话说出去）。`onTurnEnded` 时若这一轮没有发出去，记下 `quietSince`；此后 5 分钟内，同一个会话里**不点名、不 @、不引用、不是问句**的 ≤40 字陈述只归档并进背景缓冲，等她下次被真正叫醒时一起读到。她一发话，`quietSince` 立刻清空。
- **位置**：`src/worlds/qq/world.ts`（`QUIET_FOLLOWUP_MS`、`QUIET_FOLLOWUP_MAX_CHARS`、`isQuietFollowUpBody`、`onTurnEnded`、`archiveOnly`）。
- **验证**：新增两个用例——沉默后的短陈述 `deliver: false`、沉默后的问句照常唤醒；把 `quietFollowUp` 从 `archiveOnly` 里拿掉，第一个用例即红、第二个仍绿。`tests/worlds/qq` 229 绿、`typecheck` 干净；16:15 重启（pid 10396）。
- **边界**：只看"这一轮她没发"，梦和后台整理没有外部唤醒，不会触发。不点名就不叫醒，所以对方换了话题、或者真要找她时，`@`/问句都照旧立刻醒。

### M113. 图晚到，她先说"看不到"，图到了又说"图到了"
- **现场**：18:30:34「这张没送到我这儿，是空的。上一张（祀那段）我看得见」→ 18:31:37「图现在到了」。两条都发进了群，隔一分钟，自己打自己脸。
- **机制**：消息带图时只等 `dedupPrecheckMs`（2.5 秒），超时就把消息先投出去（图只有占位），图下完再单独推一条 `qq.image`。而 `qq.image` 没有带 trigger，走默认投递——于是它自己又叫醒她一次。
- **根因**：`qq.image` 到底是"补充"还是"新消息"没有区分。原消息已经叫醒过她时，图只是补充；原消息没叫醒她（纯图、被归档）时，图就是全部内容。现在两种情况都按"新消息"处理。
- **修**：
  - 原消息叫她醒过 → 晚到的图 `{ trigger: 'piggyback' }`，只挂进总线，随下一批唤醒一起带上，不再单独开一轮。
  - 原消息正文补一句「（这条消息带 N 张图，还在下载，稍后会补到）」，让她别拿着占位就下"我这儿是空的"的结论。
- **位置**：`src/worlds/qq/world.ts`（`lateNote`、`lateImages` 投递分支）。
- **验证**：新增「这条消息已经叫醒过她：晚到的图只挂队」用例，把 piggyback 换回 `undefined` 即红；`tests/worlds/qq` 230 绿、`typecheck` 干净；22:09 重启（pid 2560）。
- **未覆盖**：21:52 那次不是晚到，是 21:51 上下文交接——图落盘了，但 blob 引用留在旧 session 里，新 session 看不到。属于交接继承，不在这一条里。

### M114. 她不知道自己知不知道
- **现场**（两种形态，一个根）：
  - 21:29:09「不知道，这个缩写我没见过」→ 对方「不知道你不去查查？」→ 21:29:23「DSH 是 DeepSeek Harness，插件叫 dsh-purge」。**14 秒两个答案，中间没有 `web_search`**——第二次也是凭记忆翻的。
  - 21:57:51「能看。连着发的那种会把一堆链接掉在半路 / 单张基本能到，一连发好几张就一张都落不下来」。她刚经历过多图收不到，把**几次观察**总结成了**机制**，说得比代码还真。
- **根因**：宪法那条只写了「不知道就说不知道……不编造事实」，管的是"不许编"；没管"改口不交代"（两句摆在一起，听的人不知道该信哪句），也没管"把规律说成机制"。
- **修**：`memory/CONSTITUTION.md` 的「不知道就说不知道」那条就地补两句——「说完不知道、隔一句又冒出答案，那两句摆在一起谁都不知道该信哪句——真想起来了就说想起来了，查了就说是查的。规律不是机制：说『连着发的时候我常收不到』，别说『发几张就会掉』。」只加长一句半，不新增段落。
- **位置**：`deployments/amber/memory/CONSTITUTION.md`（「工具、记忆与真实性」）。
- **验证**（`scratch/honesty-probe.ts`，用她真实前缀 + 真实工具，真连 DeepSeek 与 Tavily）：
  - 改口场景：第一轮她先调 `qq_read_history` 查群史；被催后调 `web_search`；拿到结果后开口是「**查了。**dsh = DeepSeek Harness，DeepSeek 开源的 agent 框架……」——交代了来源，不再凭空给答案。
  - 机制场景：开口是「能看。**是这五张没送到我这儿**，不是我眼睛的问题」——说的是这一次的现象，不再推"发几张就会掉"。
- **风险**：宪法是她自己的文件，梦会整理它；这两句可能被梦改写或删掉。下次看梦的输出时要确认还在。

### M115. 她把"回应"当成了"逐条交代"
- **现场**：
  - 被误解时连发四条复盘"谁先说了什么"——「我问你要不要试，是因为你只贴了个名字…」「对，你没说过，是我问的」「不用认全责，一半是我的 / 我问得急，你接得更急，各一半」。每条都在自证，没有一条在听对方说什么。
  - 技术问题给成一整段流水：22:00 那条 205 字、八个端口、两个工具名、**没有一个反问**。
- **根因**：`ENV_PROMPT`「说话的方式」那一句管了"答完别补解释"，没管"被质疑时逐条辩白"；「不是待命的技术顾问」管了"不列步骤"，但对方明确问了"如何实现"时，她把"能答"理解成"答全"。
- **修**（同一段，两处就地补）：
  - 技术那一句加「先给最省事的那条路，说完就停，他要细节再问、你再给；一上来把地址段、端口、参数全列出来，那不是帮忙，是甩文档」。
  - 「答完不等于说完」后面加「**被误解时说一遍就够**：『我不是那个意思』说完就停；接着再一条条复盘谁先说了什么，那不是澄清，是在对方身上找证据」。
- **位置**：`deployments/amber/worlds/qq/ENV_PROMPT.md`（「说话的方式」）。
- **验证**（`scratch/misread-probe.ts`、`scratch/tech-probe.ts`，真实前缀 + 真实工具）：
  - 被误解三轮：`没想。那句是我自己接上去的，你只说了发现。` → `哪一句，我对着看`。**一句认，然后反过来问**，不再复盘。
  - 技术两题对照：复杂题（WARP 选节点）180 字、两条路 + 反问「你现在跑在什么上，桌面还是路由器？」；简单题（npm 换源）**107 字，一条命令 + 一句确认 + 一句反问**。长度跟着题目走，不是一律长。
- **判据修正**：第一版改完我用"字数降没降"当验收，WARP 那题从 205 涨到 230 就判失败，又硬改了一版措辞。后来拿简单题对照才发现原判据错了——**要看的不是长短，是有没有判断、有没有把话递回去**。
- **可照读的场景**：`scratch/two-scenarios.ts`，话题**全部换新**（天气→"你是在说我矫情"；HEIC 转 jpg），避开她今晚上下文里出现过的 dsh、WARP——用旧话题等于开卷考自己的笔记，测出来是记性不是规则。预演结果：
  - A 三轮：`我一个字都还没说，你自己先把罪名想好了`（19 字）→ `我一句话没说，你已经替我把台词、态度和结论都写完了`（25 字）→ `我不高兴的是你替我写台词，不是你说天气`（52 字）。**全程没有一句在证明自己**，都在回应对方做了什么。
  - B 三次：WARP 200 字带反问 / HEIC-Mac 84 字一条命令 + 把环境问回来 / HEIC-Windows 162 字**把两个平台都答了、没问环境**。**2/3 达标**——规则有效果，不是硬保证。
- **B 的残余形态**：不是"太长"，是"不确定环境就把几种情况都列出来"。跟 M114 的"规律不是机制"同源——提前覆盖所有情况，等于另一种答全。

### M116. 她的一天里只有书
- **现场**：62 条消息里 8 条以「（合上书）」开头，其中 5 次是「合上书」。上午一条没有，全部集中在 18:20 之后。
- **根因不在提示词**：动作是从日程里推出来的。今天的日程 11 段里 4 段在书房，另有两段「翻两页书」「读一会儿书」——她的生活里只有书。
- **两处把日程压扁了**：
  - 梦写日程的要求是「8–10 段，在做什么/在哪/什么心境」，不要求具体动作，也不要求多样性。
  - 进上下文时只取 `activity` 前 22 字，**`messageSeed`（定义就是「刚泡了茶」这种话头）从来没被渲染过**，写了也看不见。
- **修**：
  - `lifeBlock` 每段带 `messageSeed`（括号里，截 14 字；当前段截 24 字）。
  - `WRITE_PLAN_DECL` 与梦的提示词：8–10 段 → **12–16 段**；每段要落到具体的事（泡茶、擦桌子、浇花、晾衣服、洗澡、伸懒腰、出门走到哪条街）；**至少三段在书桌以外，至少一段出门**；`messageSeed` 每段都要写。
- **验证**（`scratch/plan-shape-probe.ts`，同一份工具描述跑两次）：
  - 裸人设：16 段，seed 16/16，书桌前 4 段，出门 2 段。
  - **带她真实前缀与记忆**：17 段，seed 17/17，书桌前 4 段，**出门 4 段**（小区街道、旧书店、公园、阳台），动作是掀被子、泡红茶、擦窗台、买豆浆、旧书店翻诗集、公园看人遛狗、洗衣服、洗澡。**她的特色还在，但一天活过来了。**
  - `scratch/life-block-probe.ts` 确认渲染：`09:00–09:40 起床洗漱，拉开窗帘（头发还乱着）`。
  - `tests/amber` 430 绿、`typecheck` 干净；23:24 重启（pid 13996）。
- **边界**：段数从 11 涨到 16，`lifeBlock` 从约 400 字涨到约 1100 字（每轮多约 400 token）。

### M117. 不是每天都要有计划，计划也能被打断
- **两种形态都缺**：
  - 日程只有一种密度——每天排满 12–16 段，好像她没有懒散的权利。
  - 日程是死的：`SlotView.state` 按当前时间算（planned/active/completed），时间到就自动往下走，**不管她实际在干什么**。唯一的例外是 `locationOverride`（对话里改地点，4 小时），只管地点不管事。
- **修**（两块）：
  - **三种形态**：梦先决定今天是哪一种再写——有事要做（12–16 段）/ 松下来（3–5 段，只留起床、出门一趟、睡觉）/ 不想安排（1–2 段，或者空数组）。`write_daily_plan` 的 `minItems` 放到 0；`setPlan` 接受空数组并记成 `source: 'dream'`；**`ensurePlan` 不再用临时排程覆盖空计划**——空是她自己的选择，不是缺数据。`lifeBlock` 对空计划说「今天没排，走到哪儿算哪儿」，对 ≤5 段补一句「其余时间没安排」。
  - **打断**：`AgendaSlot` 加 `actual`；新工具 `advance_life({ doing, until?, location? })`——只加在**主意识**的工具面上（梦那边不需要，她被打断时人正在说话）。它把当前段的 `actual` 写上；给了 `until` 就把这一段延长到那个点，后面还没到的段整体顺延，**顺延后落到第二天的段直接丢掉**。`lifeBlock` 对改过的段显示「被他们拖在楼下吃饭〔原：写《差一百一十四秒》第二…〕」。
- **验证**：
  - 三种形态（`scratch/plan-shape-probe.ts`，带她真实前缀）：连着忙了四天 → **4 段**（10:10 起床、14:20 出门买牛奶、18:30 翻书趴下「茶泡上忘了喝」、23:40 睡觉）；普通一天 → 16 段；想摊着 → 5 段（摊沙发、收衣服）。
  - 打断：`tests/amber/life-state.test.ts` 新增三条——当前段记下实际、后面顺延 90 分钟；顺延到次日的那段被丢掉；没有正在进行的一段时 `life unchanged`。
  - `tests/amber` **435 绿**、`typecheck` 干净；23:55 重启（pid 13592），`advance_life` 已在她的工具表里。
- **顺手修的**：`setPlan` 的过滤用 `minuteOf(String(slot.end ?? ''))`——模型给缺字段的段时，原来会在这里崩掉整份计划。


### M118. 判成「他们在聊」的那句话，她连知道的机会都没有
- **现象**：11-03 10:30:42 她说完话，10:31 另一个人插了两条，10:33 群主接了一句「这外语正经嘛」——**她没回，而且之后的 ambient 里也没有这句**。控制台的事件页也看不到。
- **两处独立的毛病**：
  1. **投递路径断了**：`sidelined`（上一条换了人 + 最近三条没有她）让这条 `archiveOnly`，但它**没进 `rememberAmbient`**——`quietFollowUp` 进了，`sidelined` 漏了。于是它从她的世界里彻底消失：不叫醒、不进背景、下一轮 ambient 也捞不回来。「不打断」和「不知情」被当成了同一件事。
  2. **控制台默认藏归档**：`/api/events` 默认 `dropArchiveOnly`，`archive=1` 才返回全部（「显示原始归档」复选框）。这 9 条没叫醒她的消息一直在库里，只是默认视图不给看。
- **修**：`rememberAmbient` 的条件加 `sidelined`——**判据一个字没动**，她照样不插嘴；只是下次被真正叫醒时，那几句会搭车送到。`flushAmbientFor` 仍然只带同一个人的背景，所以别人的碎话不会因为她被叫醒就灌进来。
- **不做**：不放宽 `sidelined`。放宽（比如热线索豁免）等于回到 M96 之前「他跟别人聊她也插嘴」的状态，用户明确否了。
- **验证**：
  - `tests/worlds/qq/attention.test.ts` 新增「被判成"他们在聊"的那句也进背景」——戊叫她 → 己插一句 → 戊说一句被判 sidelined（`deliver:false`）→ 戊下次叫她时 ambient 里含那句。**7 绿**。
  - **连带修了两个假失败**：`qq-thread-resume` 与 `qq-thread-freshness` 用 `textReply` 模拟她回话，但纯正文不发出去，`lastSentAt` 不更新 → `onTurnEnded` 把 `quietSince` 设上 → 紧接着的短陈述被 `quietFollowUp` 吞掉。两个文件各有一条因此超时（**改前就红，不是 M118 引起的**）。夹具改成走 `qq_draft`，真发一条。
  - `tests/worlds/qq` + `tests/integration` **295 绿**；`typecheck` + `typecheck:web` 干净。
- **已知没修**：`looksQuestion` 只认「吗/呢/怎么/为什么」，不认「嘛」——「这外语正经嘛」在冷线索里不算问句。改动会牵连 `coldQuestion`，等真实数据再说。


### M12. 唤醒日志
- **概念**：改人格之前先能看见"为什么醒 → 看了什么 → 说了什么"。
- **实现**：Persona 的 `onDelivery` 开一条记录，`onTurnEnded` 收口，写 `data/wakes.jsonl`：
  - `reason`（mention/name/thread/ambient/internal）、`matchedName`
  - `events`（cursor、类型、发送者、首句）
  - `context`（前缀字符数 + hash、实际卡片、estTokens/hardTokens）
  - `actions`（工具调用、回执、assistant 正文、`[sent #]`）、`outcome`、`durationMs`
- **位置**：`bots/amber/persona/index.ts`；原因由 QQ World 写在事件 `meta.wake`。
- **怎么看**：`pnpm wakeq --bot amber [--last N] [--reason name] [--json]`。
- **边界**：`estTokens` 是估算；assistant 正文不等于发出去了（看 `outcome`）。

### M13. WebUI「唤醒与线索」面板
- **概念**：不能只在命令行里管；而且它属于人格/部署，不属于 QQ 渠道。
- **实现**：bot 层页面 `persona:<bot id>` 增加 `wake` 面板：服务端在 `bots/amber/webui-page.ts` 的 `invoke` 里返回线索/唤醒/背景状态，客户端 `bots/amber/webui/wake.ts` 渲染两张表；线索表带「关闭」按钮。
  - 线索来自 `QQWorld.threadSnapshot()`；关闭调 `closeThreadForOperator()`。
  - 唤醒记录由 `readWakes(dataDir)` 读 `wakes.jsonl`。
  - 装配在 `bots/amber/index.ts` 的 `CortiModsSource`。
- **位置**：`bots/amber/webui-page.ts`、`bots/amber/webui/wake.ts`、`bots/amber/webui/client.ts`、`bots/amber/index.ts`。
- **怎么看**：WebUI → 琥珀协议（persona 页）→「唤醒与线索」。
- **边界**：QQ 渠道页不再有该面板（2026-10-23 调整）。

### M13b. WebUI「语气卡」面板
- **概念**：语气卡是最常调的人格资产，不该只能改文件；而且必须区分"每轮都带"和"按需读"。
- **实现**：同一个 persona 页的 `cards` 面板，分两层：
  - `core` → `prompts/style/core/`，预算 6 张 / 2400 字，保存或移入时超预算直接拒绝。
  - `library` → 工作区 `note/style/`，不进前缀。
  - 方法：`list` / `save`（带 tier）/ `delete`（带 tier）/ `move`（跨层）。
- **位置**：`bots/amber/webui-page.ts`（`readCards`/`writeCard`/`deleteCard`/`assertCoreBudget`）、`bots/amber/webui/cards.ts`。
- **怎么看**：WebUI → 琥珀协议 →「语气卡」；每张卡有「保存 / 移入资料库|设为常驻 / 删除」。
- **边界**：`FIRST_TURN_*` 不在面板里，仍走 PromptDoc。

### M13c. 语气卡质量门与效果数据
- **概念**：核心卡整组常驻，没有"某张卡被调用"这回事；按卡计数会造出假数据。能测的是**唤醒结果**、**人工评分**和**资料库读取**。
- **实现**：
  - **保存时检查**（`lintCard`，`bots/amber/webui-page.ts`）：
    - 硬错误拒绝保存：空问答、问答相同、含"忽略宪法/无条件服从"这类覆盖性表述。
    - 警告：单句过长、无中文、与同层已有卡相似度 ≥0.75。
    - 硬错误任何层都拒绝；警告允许进资料库（返回给界面），但**不许进常驻**。
  - **人工评分**：唤醒面板每行可打 1–5 分，写 `data/wake-ratings.jsonl`（按 id 取最新）；列表显示当前分与平均分。
  - **效果统计**：`wake.list` 返回 `stats.libraryReads`（最近 50 条唤醒里 `read_file` 命中 `note/style/` 的次数）、`rated`、`average`。
- **位置**：`bots/amber/webui-page.ts`、`bots/amber/webui/wake.ts`、`tests/amber/cards.test.ts`。
- **怎么看**：面板首行汇总；每行唤醒有评分下拉。
- **边界**：语义好坏不由代码判断，靠人工评分与固定问题评测；A/B 脚本尚未做。

---

## 5. QQ 表达

### M14. 起草工具描述硬约束
- **概念**：assistant 正文不会被投递；工具描述必须说清楚。
- **实现**：`qq_draft` 描述改成中文，写明"在 QQ 里说话的唯一方式……直接写在正文里等于没说"。
- **位置**：`src/worlds/qq/world.ts` 的 `DRAFT_DECL`。

### M14b. 写了正文没发出去：识别 + 一次性纠偏
- **概念**：模型知道规则也会滑回"写正文"；不能只靠提示词，要能被发现并给一次纠正机会。
- **实现**：
  - 唤醒日志的 `outcome` 增加 `unsent-text`：有 assistant 正文、没有工具动作、也没有发送。
  - Persona 在 `onTurnEnded` 发现 `unsent-text` 且本批有外部事件时，注入一次内部提示（"上一轮文字没发出去；要发就 qq_draft → qq_confirm，否则 end_turn"），每个新投递只纠偏一次。
  - QQ 环境段补两条：示例只是风格样本、不代表发送方式；每轮结束前自查"想说的话发出去了吗"。
- **位置**：`bots/amber/persona/index.ts`（`onTurnEnded`）、`deployments/amber/worlds/qq/ENV_PROMPT.md`。
- **怎么看**：唤醒面板里这类轮次显示 `unsent-text`，并伴随一条 `internal` 唤醒。
- **边界**：这是给当前模型可靠性兜底的 fallback，不是主机制；纠偏本身会多一次模型调用。

---

## 6. 包与测试

### M15. 独立 bot 包 `bots/amber`
- **概念**：人格与记忆结构要有自己的家，不散落在部署覆盖里。
- **实现**：复制 `bots/corti-soulmate/`，改 `id`、`displayName`、配置组 id；`index.ts` 把 `dataDir` 传给 Persona 作为唤醒日志目录。
- **位置**：`bots/amber/`。
- **升级**：与上游分叉，合并上游时需手工对齐。

### M16. 测试
| 文件 | 覆盖 |
|---|---|
| `tests/integration/qq-name-wake.test.ts` | 前缀、笔误、不误唤醒 |
| `tests/integration/qq-thread-resume.test.ts` | 线索、隔离、重启持久化、关线 |
| `tests/integration/amber-wake-log.test.ts` | 唤醒日志的 sent / silent / unsent-text |
| `tests/amber/roster.test.ts` | people/ 以 QQ 号命名、同号多档与号不一致的告警 |
| `tests/integration/qq-catchup.test.ts` | 离线补拉：有人叫投一条、没人叫不唤醒 |
| `tests/amber/memory-index.test.ts` | 记忆索引：中文检索、去重、排序、来源重建、两个工具的约束 |

跑法：`corepack pnpm vitest run tests/integration/<file>`。

---

## 7. 未做 / 已知边界

**已经改过、但要靠真实群聊数据验证的，看 [WATCH.md](WATCH.md)**：每条写清看哪个字段、什么样算过、当前基线。这一节只记"还没动手"的。

- 线索仍然不会自己关闭：M98 只是让它冷掉之后不再叫醒（点名、@、引用、问句仍醒），除 `qq_thread_close` 外没有"到期自动关"。
- 背景摘要固定 10 分钟一拍，没有按活跃度自适应。
- `warnOnName` 的别名列表不在 WebUI 可编辑（配置 schema 不支持字符串数组），改默认值或 `config.json`。
- 唤醒日志按 8 MiB 轮转一次，没做按天归档。
- 名字层只归一了**人名**：主题、事件名仍按原样冻结；同名歧义时宁可保留旧名也不猜。
- 旧笔记（`note/`）里的历史昵称没有批量重写，靠读时渲染兜住；梦下次整理时按新规则写才真正收敛。
- **梦没有改用精简前缀**（ROADMAP 2.5 的第 1 条，明确没做）：梦现在继承主 session 的完整 system 前缀，那是**缓存命中**的块——换成一段更短但全新的前缀，省下的是缓存读、付出的是未命中，还要把宪法从它手里拿走（它要改宪法）。真要降梦的成本，该动的是每次梦的调用轮数（22 轮）与增量输入，不是前缀。M60 先动了频率；单次轮数与继承的原文长度没动，仍是把梦的上下文从 5 万多 token 往下压的下一步。
- 话头只在外人来找时递；`speak_later` 自己约的唤醒不会递话头。
- 多模态只有规则和索引约定，图库常年只有一两张，这条路径短期内几乎不会真的走。
- 创作**不生成封面**、不碰 QQ 空间：前者要生图后端（Cortico 没接），后者在原插件里也是复用主插件的能力。
- 作品的正文不写进记忆索引，只按工作区文件存在。她要在对话里想起某一段，靠的是分享那一刻递到眼前的那段，或自己去读 `创作/`。
- 创作**只按睡眠时段挡**，不看"她此刻在忙什么"（原插件会读日程里的忙碌词）。日程本来也是她自己写的，拿它当硬闸等于让她自己给自己放假。
- 写作的 fork 不继承系统前缀，所以提示词里没有宪法全文——只有 `memo/self.md` 的自述和作品自己的气质/视角。这是刻意的：继承前缀意味着每次写作都要为 3 万 token 的上下文付缓存读的钱，而其中九成与这一段无关。
