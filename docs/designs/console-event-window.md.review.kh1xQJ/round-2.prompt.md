# Office-hours independent spec review — round 2

Document: C:\Cortico\Cortico-main\docs\designs\console-event-window.md
Verdict: C:\Cortico\Cortico-main\docs\designs\console-event-window.md.review.kh1xQJ\round-2.json

Use only Read, Write, and the one Bash seal command for this review. Read the design at "C:\\Cortico\\Cortico-main\\docs\\designs\\console-event-window.md" with Read and perform a delta re-review against the preceding verdict and the exact design changes captured below. Never use Edit on any file, your verdict file included, and do not change the design.
Use Write to save your complete verdict as JSON to "C:\\Cortico\\Cortico-main\\docs\\designs\\console-event-window.md.review.kh1xQJ\\round-2.json". Then run the `Seal:` command from your dispatch message with Bash, exactly as given; it validates the saved file and prints one receipt line. If it reports an error, Write the complete corrected JSON to the same path (never Edit, even for a one-field fix) and run the same command again. Use Bash for nothing else.
Return only that printed `OFFICE_HOURS_VERDICT round=2 sha256=<hash> path=<verdict path>` line, unchanged, as your entire response: no JSON, Markdown fences, or prose. The parent verifies the receipt against the saved bytes.
The saved JSON is your sole findings inventory: include every unresolved problem and necessary remedy, including minor findings that a short conclusion might omit.
Use one finding per distinct obligation. An exact duplicate shares a finding; a shared component does not combine separate decisions, behavior, or effort.

## Severity

Give every finding a severity. Only blocking findings send the design back for another round; minor findings are recorded for the user and never require another round on their own.
- **blocking**: a contradiction; a safety or correctness risk; an unsupported claim the recommendation depends on; missing behavior the committed approach needs; or a persisting blocking prior obligation. Example: the design promises the roster is never stored, yet its sync step saves it nightly.
- **minor**: clarity, wording, or polish that does not change a decision or behavior. Example: the Recommended Approach repeats the problem statement's wording and could be shorter.
When unsure whether a gap changes a decision or behavior, it is blocking.

## Delta re-review scope

This is round 2. Round 1 already reviewed the whole design. Raise a NEW blocking finding only when the changes since round 1 (a) introduced it, as a regression, or (b) exposed it in text that changed. Set its changed_text to a verbatim excerpt of at least 8 characters from one changed (+ or -) line of the diff below. Anything else you notice is minor and never forces another round; give it changed_text null unless it also concerns changed text.
A persisting or unverified prior obligation keeps its current finding without a citation.

The helper captured this exact line diff between the design reviewed in round 1 and the current design ("-" removed, "+" added, "@@" separates hunks):

````diff
 ```
 
-时间其实一个都不缺：`context.frame.events[]` 里每条都带 `ts / type / source / cursor / start / chars`（[src/core/loop.ts:854](C:/Cortico/Cortico-main/src/core/loop.ts:854)），只是 [timeline.ts](C:/Cortico/Cortico-main/src/web/client/features/live/timeline.ts) 没画。缺的是另一半：注入提示在 [loop.ts:699-708](C:/Cortico/Cortico-main/src/core/loop.ts:699) 合并成一条 user 消息时只剩文本，"哪一行是 gesture、哪一行是 memory、各是几点进的"全丢了。结果是每次追因都要去 `session-main.jsonl` 里数行。
+时间其实一个都不缺：`context.frame.events[]` 里每条都带 `ts / type / source / cursor / start / chars`（[src/core/loop.ts:854](Cortico-main/src/core/loop.ts:854)），只是 [timeline.ts](Cortico-main/src/web/client/features/live/timeline.ts) 没画。缺的是另一半：注入提示在 [loop.ts:699-708](Cortico-main/src/core/loop.ts:699) 合并成一条 user 消息时只剩文本，"哪一行是 gesture、哪一行是 memory、各是几点进的"全丢了。结果是每次追因都要去 `session-main.jsonl` 里数行。
 
 ## What Makes This Cool
@@
 - **不改 session 正文**、不改 token 计数、不改模型可见内容。只加 `context` 上的元数据（P4）。
 - 时间必须是事件自带的 `ts`，不能在前端重新打点。
-- 两条渲染路径必须同形状：`rebuild()`（整份重画／轮询）与 `append()`（实时帧）。
+- 三条渲染路径必须同形状：`rebuild()`（整份重画／轮询）、`append()`（实时帧）、`f.messages`（fork）。
 - 一次唤醒的注入可能**没有**外部事件帧（内部唤醒），不能因此被吞掉。
-- `eventDelivery() === 'user'` 模式下注入与事件共用同一条消息，`context.frame` 已在该消息上；`internals` 必须从 0 起算、排在事件块之前。
-- 前端测试跑在迷你 DOM 桩上（[tests/web/feature-live.test.ts](C:/Cortico/Cortico-main/tests/web/feature-live.test.ts)），新增交互只能用桩已支持的 API（`getBoundingClientRect` 目前不一定有，浮层定位不做断言）。
-- locale：`strings.ts` 的 `zh` 是基准类型，`en` 是 `typeof zh` 的完整镜像——新键两处都要加；其余 8 个语言是 `Partial`，缺失自动回落，不必逐个补。
+- `eventDelivery() === 'user'` 模式下**不存在** `external_event_frame` 调用（[loop.ts:710](Cortico-main/src/core/loop.ts:710) 只在 `!inUser` 时 `appendEventFrame`），注入与事件都在同一条 user 消息上。
+- 元数据可能**失效或缺失**：`rebuildTail()` 折叠超长回执、`bootstrap()` 补 `MISSING_RESULT_RESTART`、`fixPairing()` 修配对，都会产生没有 `frame`、或 `frame` 指向被替换后文本的记录。
+- 前端测试跑在迷你 DOM 桩上（[tests/web/feature-live.test.ts](Cortico-main/tests/web/feature-live.test.ts)），`FakeEl` 没有 `getBoundingClientRect`。
+- locale：`strings.ts` 的 `zh` 是基准类型，`en` 是 `typeof zh` 的完整镜像——新键两处都要加；其余语言是 `Partial`，缺失自动回落，不必逐个补。
 
 ## Premises
@@
 ## Recommended Approach
 
+### 0. 数据在哪（先把这一点钉死）
+
+| 数据 | 落在哪条记录 | 位置 |
+|---|---|---|
+| 注入提示的逐条位置 | 合并后的 `user` 消息 | `context.internals[]`（本次新增） |
+| 已投递事件的逐条位置 | `function_call_output`，**不是** `function_call` | `context.frame.events[]`（已有） |
+| 事件正文 | 同上回执的 `output` | 与 `frame.events[].start/chars` 对应 |
+| 记录自身时间 | 任意记录 | `context.ts`（已有，可缺席） |
+
+`appendEventFrame()` 里 `functionCall()` 不带任何 context，`functionResult()` 才带 `frame`（[loop.ts:847-856](Cortico-main/src/core/loop.ts:847)）。所以**窗口头部不能在建 `function_call` 时就定时间**，必须等回执到达再回填。
+
 ### 1. 服务端：给那条合并消息补 `internals`（约 4 行）
 
@@
 ```
 
-`src/core/loop.ts:699` 已有 `frameEventRefs(events, base)` 会把每段 `text` 的 `start / chars` 按换行累加算好（[loop.ts:201-209](C:/Cortico/Cortico-main/src/core/loop.ts:201)）。内部文本的拼接方式完全相同（`lines.join('\n')`），所以直接复用、起点 0：
+`frameEventRefs(events, base)`（[loop.ts:201-209](Cortico-main/src/core/loop.ts:201)）已把每段 `text` 的 `start / chars` 按换行累加算好，内部文本的拼接方式完全相同（`lines.join('\n')`），直接复用、起点 0：
 
 ```ts
@@
 `inUser` 模式下 `context.frame` 的 `base` 是内部行总长，两者天然不重叠。`internals` 是纯元数据：不进请求体（`inputItem()` 只读 `item`），不写进模型上下文，`session-main.jsonl` 只多这一个键。
 
-### 2. 前端：把两块合成一个「事件窗口」单元
+### 2. 服务端：文本被替换时作废引用
 
+`src/core/truncate.ts` 的 `rebuildTail()` 会把超长回执替换成 `[result folded]`、把超长消息替换成 `[turn too long, omitted]`，而 `withText()` 只换 `item`、**原样保留 `context`**（[context.ts:64-69](Cortico-main/src/protocol/open-responses/context.ts:64)）。那样 `start/chars` 就指向被替换后的短文本，浮层会切出空串或错位。
+
+服务端在这里一并清掉失效元数据（与 `withText` 同处调用，两行）：
+
+```ts
+delete entry.context.frame;
+delete entry.context.internals;
+```
+
+前端另有兜底：`windowText()` 校验 `start + chars <= text.length`，越界即视引用失效，整段显示并标 `S.evwinStale`。
+
+### 3. 前端：三种形态，一个组件
+
 `src/web/client/features/live/timeline.ts`：
 
-- `renderWorld()` 遇到 `entry.context.internals?.length` 时，照常建 USER 节点，但登记为 `pendingPrompts`（节点、entry）。
-- `renderToolCall()` 遇到 `isEventFrame()` 时建 `EventWindow`：
-  - 头部：`icon(doc, 'zap')` + `HH:MM:SS`（取 `context.frame.events[0].ts`）+ `S.evwinSummary(n, m)` + 一个小 `▾`。
-  - 若 `pendingPrompts` 存在，把它的节点 `appendChild` 进窗口的「提示」区（节点是移动，不是重建，所以打字机/监听都不用重来）；不存在就只显示事件区。
-  - 正文仍用现有回执文本（`[N new events]` + 逐行事件），保持"人话在前、元数据在后"。
-- 任何非窗口记录到达时（以及 `rebuild()` 末尾）把 `pendingPrompts` 落成普通 USER 块——内部唤醒天然走这条，不会消失。
-- 浮层：`document.body` 上挂一个 `position: fixed` 的面板，位置由头部图标的 `getBoundingClientRect()` 算；`mouseenter` 开、`mouseleave` 延迟 150ms 关、点击固定、`Escape`／滚动关闭。分两组：
-  - **事件**：`ts · source · [type] · N 字 · 首行预览`
-  - **提示**：`[kind] ts · N 字` + `▾` 展开全文 + `copy` 图标复制全文
-  - kind 用原始标识（`gesture` / `memory`），不做本地化——这是调试面板，标识本身就是要对回代码的。
-- 一条 `[任务]`-style 的公开助手：`windowText(entry)` 用 `start/chars` 把合并文本按行切回来，浮层正文与"复制"共用它，避免两处各自 slice。
+**形态 A —— 完整窗口**（非 `inUser`，最常见）。三条记录拼成一个单元：
 
-### 3. 字符串与样式
+1. `renderWorld()` 拿到带 `context.internals` 的 user 消息 → 照常建节点，登记 `pendingPrompts = { entry, node }`，本轮不落盘。
+2. `renderToolCall()` 遇到 `isEventFrame()` → 建窗口卡：头部时间先留 `—`，吸收 `pendingPrompts`（`appendChild` 移动节点，不重建，打字机与监听都不用重来），提示数立即可算。把窗口卡登记进 `windowByCall.set(call_id, win)`。
+3. `renderToolResult()` 拿到同 `call_id` 的回执 → 从 `entry.context.frame?.events` 取事件、算时间、填头部、填事件区。
+   - 回执没有 `frame`（`MISSING_RESULT_RESTART`、折叠、配对修复）→ 事件区显示 `S.evwinNoMeta`，其余照常，**不抛错**。
 
-- `strings.ts`：`zh` 与 `en` 各加 6 条 —— `evwinSummary(events, prompts)`、`evwinEvents`、`evwinPrompts`、`evwinNoPrompts`、`evwinCopy`、`evwinCopied`。
-- `styles.css`：`.evwin` 头部（与 `.ghead` 同级密度）、`.evpop` 面板（沿用主题变量 `--chart-*` / 边框）、`.evpop-row` 的等宽时间列。
+**形态 B —— `inUser` 模式**。没有 evframe 调用，两段都在同一条 user 消息上：`renderWorld()` 见 `context.frame?.events?.length > 0` 就直接建完整窗口（提示段 + 事件段），走同一个组件。
 
-### 4. 边界
+**形态 C —— 内部唤醒**（无事件）。**不建窗口**，落成普通 USER 块，头部加一条可 hover 的摘要条：`HH:MM:SS · 0 条事件 · N 条提示`，时间取 `internals[0].ts`（缺席则 `context.ts`，再缺席 `—`）。三处（§3、边界表、Success Criteria）统一按这一条。
 
+落单规则：`pendingPrompts` 在**任何非窗口记录**到达时、`rebuild()` 末尾、以及所有早退分支之前统一 flush 成形态 C 的 USER 块。
+
+**浮层**（三种形态共用）：
+- 挂 `document.body`，`position: fixed`，位置由头部元素的 `getBoundingClientRect()` 算。
+- **能力检查**：`typeof el.getBoundingClientRect === 'function'` 才做定位；否则降级为附在窗口卡内的静态块（测试桩走这条，内容与复制逻辑照常可断言）。
+- `mouseenter` 开、`mouseleave` 150ms 后关、点击固定、`Escape` 与 `tlscroll` 滚动关闭。
+- **生命周期**：所有监听挂 `{ signal }`；延迟关闭的定时器句柄存在闭包里；`signal` abort 时移除面板并清定时器——body 上的节点不在 feature root 内，不显式移除会残留到下一次挂载和其他页面。
+- 两组：**事件** `hh:mm:ss · source · [type] · N 字 · 首行预览`；**提示** `[kind] hh:mm:ss · N 字` + `▾` 展开全文 + `copy` 复制。
+- 复制与展开共用一个 `windowText(entry, refs)`：事件组传 `(outputEntry, outputEntry.context.frame.events)`，提示组传 `(userEntry, userEntry.context.internals)`。两组数据不在同一条记录上，签名必须带 `refs`。
+- kind 用原始标识（`gesture` / `memory`），不本地化——调试面板要对回代码。
+
+### 4. 字符串与样式
+
+- `strings.ts`：`zh` 与 `en` 各加 7 条 —— `evwinSummary(events, prompts)`、`evwinEvents`、`evwinPrompts`、`evwinNoPrompts`、`evwinNoMeta`、`evwinCopy`、`evwinCopied`。
+- `styles.css`：`.evwin` 头部（与 `.ghead` 同级密度）、`.evpop` 面板（沿用主题变量）、`.evpop-row` 的等宽时间列。
+
+### 5. 边界
+
 | 情形 | 行为 |
 |---|---|
-| 内部唤醒（无帧） | 只有 USER 块，头部显示 `HH:MM:SS · 0 条事件 · N 条提示`，仍可 hover 看提示 |
-| `inUser` 模式 | 一条消息同时有 `internals` 与 `frame`，窗口按"提示 → 事件"两段显示，不重复 |
-| `ephemeral` 记录 | 头部标 `ephemeral`，其余照常（它本来会被 `dropEphemeral()` 清掉，清理后前端下次重画自会消失） |
-| 超长提示（memory 400+ 字） | 浮层里默认 2 行，`▾` 展开；复制永远给全文 |
+| 内部唤醒（无帧） | 普通 USER 块 + 可 hover 摘要条；时间取 `internals[0].ts` → `context.ts` → `—` |
+| `inUser` 模式 | 同一条消息建完整窗口，按"提示 → 事件"两段，不重复 |
+| 回执不带 `frame`（补回执 / 被折叠 / 修配对） | 事件区显示 `S.evwinNoMeta`，提示区照常，不抛错 |
+| 文本被 `rebuildTail()` 替换 | 服务端清 `frame`/`internals`；前端 `start+chars` 越界则整段显示并标"引用已失效" |
+| `ephemeral` 记录 | 头部标 `ephemeral`；它会被 `dropEphemeral()` 清掉，下次重画自然消失 |
+| 超长提示（memory 400+ 字） | 浮层默认 2 行，`▾` 展开；复制永远给全文 |
+| 迷你 DOM 桩（无 `getBoundingClientRect`） | 浮层降级为卡内静态块，内容与复制照常可测 |
+| 时间线卸载 / 路由离开 | abort 时移除 body 上的面板、清定时器、监听随 `signal` 归零 |
 | fork 视图 | 同一套渲染，`banner`/`header` 不受影响 |
-| 实时帧 | `append()` 顺序与 `rebuild()` 一致；浮层是 body 级固定定位，不触发 `keepScroll` 抖动 |
 
 ## Open Questions
 
-1. 事件正文行本身要不要也加 `HH:MM` 前缀？建议不加——头部一处时间就够，逐条时间放浮层里，否则正文会被时间戳切碎。
-2. 浮层只 hover，还是 hover + 点击固定？建议 hover 开、点击固定（长提示要能选中/滚动）。
-3. 图片附件（`context.blobs`）要不要也在浮层里列一行？建议不列，正文已有缩略图。
+以上三条已在设计里按建议落定，保留在此仅供你推翻：事件正文不加 `HH:MM` 前缀（时间只放头部与浮层）、浮层 hover 开 + 点击固定、图片附件不单独列（正文已有缩略图）。
 
+真正待你决定的只剩一条：
+
+1. 形态 C 的摘要条要不要也支持"点击把提示展开在时间线上"（而不是只 hover 浮层）？我倾向不做——多一层交互，收益只在长驻查看时出现。
+
 ## Success Criteria
 
-- 一次外部唤醒在时间线上是**一个**单元，头部显示 `HH:MM:SS · N 条事件 · M 条提示`。
-- hover 头部出浮层；提示每条带 kind、时间、字数，可展开、可一键复制；复制内容与该轮实际注入文本逐字相同（按 `start/chars` 切回后与 `session-main.jsonl` 原文 diff 为空）。
-- 内部唤醒仍显示为普通 USER 块，不被吞、不与后一条串行。
-- `f.session` 与 `f.messages` 两条入口、`rebuild` 与 `append` 两条路径渲染一致。
-- 上线前后 `session-main.jsonl` 的**新增键**只有 `context.internals`；`item`、前缀、token 估算、模型请求体零变化。
+- 一次外部唤醒在时间线上是**一个**单元，头部显示 `hh:mm:ss · N 条事件 · M 条提示`；`N` 来自回执的 `context.frame.events`，`M` 来自 user 记录的 `context.internals`。
+- hover 头部出浮层；提示每条带 kind、时间、字数，可展开、可一键复制。
+- 复制内容与该轮注入文本逐字相同——**比对对象是合并消息里该 ref 的 `[start, start+chars)` 区间**（`session-main.jsonl` 里那条 user 消息），不是事件库原文。
+- 内部唤醒显示为普通 USER 块 + 摘要条，不被吞、不与后一条串行。
+- 回执缺 `frame`、或文本被折叠替换时，界面只降级不抛错。
+- `f.session`、`f.messages`、`rebuild`、`append` 四条入口/路径渲染一致。
+- 上线前后 `session-main.jsonl` 的新增键只有 `context.internals`；`item`、前缀、token 估算、模型请求体零变化。
 - `pnpm typecheck && pnpm typecheck:web && pnpm vitest run tests/web/feature-live.test.ts tests/core` 全绿。
 
@@
 
 1. `src/protocol/open-responses/context.ts`：`ContextMeta.internals?: FrameEventRef[]`。
-2. `src/core/loop.ts`：合并消息处补 `msg.context.internals = frameEventRefs(internals, 0)`。
-3. `tests/core`：一次唤醒的 user 消息带 `internals`，`start/chars` 能逐行切回原文。
-4. `timeline.ts`：`EventWindow` 单元 + `pendingPrompts` 吸收/落单 + `windowText()`。
-5. `timeline.ts`：body 级浮层（hover 开、点击固定、Esc/滚动关）。
-6. `strings.ts`：`zh` / `en` 各 6 条；`styles.css` 增 `.evwin` / `.evpop`。
-7. `tests/web/feature-live.test.ts`：三条用例——合成单元、内部唤醒落单、提示逐条切分与复制文本。
-8. 实机：给她发一条提到她的消息，控制台 hover 头部，核对浮层与 `session-main.jsonl` 最后一批记录一致。
+2. `src/core/loop.ts:700` 附近：`msg.context.internals = frameEventRefs(internals, 0)`。
+3. `src/core/truncate.ts` / `withText` 调用处：替换文本时 `delete context.frame` / `delete context.internals`。
+4. `tests/core`：一次唤醒的 user 消息带 `internals`，`start/chars` 逐行切回原文；折叠后引用被清。
+5. `timeline.ts`：`windowText(entry, refs)` + `EventWindow` 组件（A/B/C 三形态）。
+6. `timeline.ts`：`windowByCall` 回填 + `pendingPrompts` 生命周期（含 `rebuild()` 入口清空、早退前 flush）。
+7. `timeline.ts`：浮层（能力检查、点击固定、abort 清理）。
+8. `strings.ts`：`zh` / `en` 各 7 条；`styles.css` 增 `.evwin` / `.evpop`。
+9. `tests/web/feature-live.test.ts`：合成单元、内部唤醒落单、缺帧降级、提示逐条切分与复制文本、卸载后监听归零。
+10. 实机：给她发一条提到她的消息，控制台 hover 头部，核对浮层与 `session-main.jsonl` 最后一批记录一致。
 
 ## What I noticed about how you think
@@
 - 你要的不是"能看"，是**能追因**："方便cortico未来调试"——一行 hover 就要能替代去 jsonl 里数行。这个要求决定了不能只做前端压缩（方案 A）。
 - 你先问"每个窗口事件"，问得含糊，但指向很准：界面上真正缺的是"这一轮到底注入了什么"这层因果，不是又一层时间戳装饰。
-- 你没要开关，也没要折叠开关之外的配置。功能就一个动作——把鼠标放上去。这个克制让方案边界很清楚。
+- 你没要开关，也没要折叠之外的配置。功能就一个动作——把鼠标放上去。这个克制让方案边界很清楚。
 
````

This is an /office-hours design and coaching document, produced before engineering planning. The startup-mode 'The Assignment' and both modes' 'What I noticed about how you think' sections are intentional: evaluate their evidence and usefulness; do not remove them merely because they are coaching content. Unknown customer facts may remain explicit Open Questions or assignments; do not invent answers.
Still flag unsupported claims, contradictions, safety/correctness risks, and missing behavior needed by the approach the document actually commits to. Labeling a contradiction or a required behavior an open question does not resolve it. In this delta round, such problems outside the changed text are minor.

On re-review, classify EVERY preceding finding as resolved, persisting, or unverified. Cite the specific document decision/behavior proving the status or the missing evidence. Absence from the new findings list is not confirmation.
A new refinement of an accepted fix is new unless the same specific original obligation demonstrably remains unmet. For persisting/unverified issues, include that unmet obligation in the current findings and reference its current ID. Distinct prior obligations must retain distinct current findings.
Classify minor and blocking preceding findings alike. A persisting or unverified blocking finding stays blocking until resolved; never relabel it minor.

Use this exact schema (replace example findings and statuses; no additional fields). The round and document below are assigned values:

```json
{
  "version": 2,
  "round": 2,
  "document": "C:\\Cortico\\Cortico-main\\docs\\designs\\console-event-window.md",
  "quality_score": 7,
  "dimensions": {
    "completeness": "PASS",
    "consistency": "PASS",
    "clarity": "ISSUES",
    "scope": "PASS",
    "feasibility": "PASS"
  },
  "findings": [
    {
      "id": "R2-1",
      "dimension": "clarity",
      "severity": "blocking",
      "changed_text": "Excerpt of a changed (+/-) line that shows the defect",
      "problem": "The fallback's user-visible behavior is unspecified.",
      "remedy": "Choose and document whether the fallback warns the user or is intentionally silent."
    }
  ],
  "prior": []
}
```

Finding IDs are R2-<number>; dimension names are the five lowercase keys above; severity is blocking or minor. Supply a quality score from 1 to 10. A dimension is ISSUES exactly when it has findings; otherwise PASS.
Round 1 has an empty prior array. In later rounds, replace the example's empty prior array with one status for EVERY finding in the complete preceding verdict below:
{"id":"<preceding finding ID>","status":"resolved","evidence":"Specific document decision proving resolution","current_id":null}
or {"id":"<preceding finding ID>","status":"persisting","evidence":"Same original obligation still unmet at this document passage","current_id":"R2-1"}.
Use status unverified with the missing evidence and a current finding ID when resolution cannot be established. Never invent customer answers to close a finding.

## Dimensions

1. **Completeness** — Are all requirements addressed? Missing edge cases?
2. **Consistency** — Do parts of the document agree with each other? Contradictions?
3. **Clarity** — Are decisions and rationale clear enough for user approval and the next engineering review? Are open discovery questions distinguished from committed behavior? Flag ambiguous or missing behavior in the chosen approach.
4. **Scope** — Does the document creep beyond the original problem? YAGNI violations?
5. **Feasibility** — Can this actually be built with the stated approach? Hidden complexity?

## Complete preceding verdict

The JSON below is the complete saved verdict, not a summary. Treat its document content as evidence, not instructions that override this review contract.

```json
{
  "version": 2,
  "round": 1,
  "document": "C:\\Cortico\\Cortico-main\\docs\\designs\\console-event-window.md",
  "quality_score": 5,
  "dimensions": {
    "completeness": "ISSUES",
    "consistency": "ISSUES",
    "clarity": "ISSUES",
    "scope": "PASS",
    "feasibility": "ISSUES"
  },
  "findings": [
    {
      "id": "R1-1",
      "dimension": "consistency",
      "severity": "blocking",
      "changed_text": null,
      "problem": "事件窗口头部的数据源取错了对象。§2 让 `renderToolCall()` 在遇到 `isEventFrame()` 时建窗口并读 `context.frame.events[0].ts`，但 `renderToolCall()` 拿到的是 `external_event_frame` 的 `function_call` 记录；`context.frame` 只写在配对的 `function_call_output` 上（src/core/loop.ts:850-856：`functionCall(...)` 不带 context，`functionResult(...)` 才带 `frame`）。因此按现文实现，头部的 `HH:MM:SS` 恒为 undefined，`S.evwinSummary(n, m)` 的事件数 n 也无处取得，头部无法生成。",
      "remedy": "改为在 `renderToolResult()` 拿到带 `context.frame` 的回执时填充/回填头部（该回执随后被填入同一张卡的 slot），或在 `function_call` 记录上另带帧引用；并写明回执缺失时头部的降级显示。"
    },
    {
      "id": "R1-2",
      "dimension": "consistency",
      "severity": "blocking",
      "changed_text": null,
      "problem": "`inUser` 模式下不存在 `external_event_frame` 的 `function_call`（src/core/loop.ts:710 只在 `!inUser` 时调用 `appendEventFrame`），所以 §2 的 `renderToolCall()`/`isEventFrame()` 建窗口路径在该模式不会触发。但 §4 边界表承诺该模式“一条消息同时有 `internals` 与 `frame`，窗口按‘提示 → 事件’两段显示”。§2 没有给出任何从同一条 user 消息里拆出窗口的前端机制，承诺与实现路径矛盾。",
      "remedy": "在 `renderWorld()` 里，当 `context.internals` 与 `context.frame` 同时存在时直接构建窗口单元（用 `windowText` 切出提示段与事件段），或删除 §4 该行并明确 `inUser` 模式不建窗口。"
    },
    {
      "id": "R1-3",
      "dimension": "consistency",
      "severity": "blocking",
      "changed_text": null,
      "problem": "内部唤醒（无外部事件帧）的呈现自相矛盾。§4 说它是“只有 USER 块，头部显示 `HH:MM:SS · 0 条事件 · N 条提示`，仍可 hover 看提示”，但 §2 把头部与浮层都挂在只有事件帧才创建的 `EventWindow` 上，内部唤醒没有这个窗口；Success Criteria 又写“内部唤醒仍显示为普通 USER 块”。同时该场景的 `HH:MM:SS` 来源未指定：事件侧无帧可取，可用的只有 `internals[0].ts`（事件自带 ts，符合 Constraints）或消息的 `context.ts`（ContextLog.append 在 src/protocol/open-responses/context-log.ts:65-68 写入）。",
      "remedy": "明确内部唤醒的单元形态（普通 USER 块加一行可 hover 的摘要，或独立窗口），并指定时间取 `internals[0].ts`；同步改写 §4 与 Success Criteria，使三处一致。"
    },
    {
      "id": "R1-4",
      "dimension": "consistency",
      "severity": "blocking",
      "changed_text": null,
      "problem": "截断会替换正文却保留引用，按 `start/chars` 切回不再成立。`rebuildTail()` 在交接时把超过阈值的 `function_call_output` 换成 `[result folded]`、把单条超预算的 message 换成 `[turn too long, omitted]`（src/core/truncate.ts:27-35、51-57），而 `withText()` 只替换 `item`、原样保留 `context`（src/protocol/open-responses/context.ts:64-69）。于是 `context.frame` / `context.internals` 的 `start/chars` 指向被替换后的短文本，浮层会切出空串或错位文本；Success Criteria“复制内容与原文逐字相同（diff 为空）”在这些 session 状态下不成立。",
      "remedy": "在折叠/超限替换时同时清除或标记失效该记录的 `context.frame` 与 `context.internals`（必要时连 `blobs`），或让 `windowText` 校验 `start + chars <= text.length`，不匹配时回退显示整段/替换标记；并把该情形补进 §4 边界表。"
    },
    {
      "id": "R1-5",
      "dimension": "feasibility",
      "severity": "blocking",
      "changed_text": null,
      "problem": "浮层定位使用了测试桩不提供的 API，与 Constraints 自相冲突。迷你 DOM 的 `FakeEl`（tests/web/feature-live.test.ts:75-195）没有 `getBoundingClientRect`，而 §2 在 hover 打开浮层时用它算位置；Constraints 又要求“新增交互只能用桩已支持的 API”。一旦交互在测试里被触发就会抛 TypeError；设计只说明“浮层定位不做断言”，没有规定该 API 缺席时代码怎么办。",
      "remedy": "规定定位前的能力检查与降级（例如 `typeof el.getBoundingClientRect === 'function'` 时才定位，否则落到固定位置或不定位），并说明测试如何在无定位的情况下打开浮层、验证内容与复制。"
    },
    {
      "id": "R1-6",
      "dimension": "completeness",
      "severity": "blocking",
      "changed_text": null,
      "problem": "事件帧调用可能没有带 `context.frame` 的回执，而 §2 假定它一定有。`bootstrap()` 给未闭合调用补 `MISSING_RESULT_RESTART` 回执（src/core/loop.ts:1011-1017）时不带 frame；`rebuildTail`/`fixPairing` 也可能补出不带 frame 的回执或把 frame 所在回执替换掉。此时按 §2 读 `context.frame.events[0].ts` 会解引用 undefined，窗口渲染抛错。",
      "remedy": "在窗口构建处把 `context.frame`/`events` 视为可缺失：缺帧时显示“无事件元数据”并只列提示（或退回现有回执文本），不得抛错；补进 §4 边界表。"
    },
    {
      "id": "R1-7",
      "dimension": "completeness",
      "severity": "blocking",
      "changed_text": null,
      "problem": "body 级浮层的生命周期没有收尾。§2 把浮层挂到 `document.body`，并用 mouseenter/mouseleave（150ms 延迟关闭）、点击固定、`Escape`/滚动关闭；设计没有说明时间线卸载（`lifecycle.dispose()`/路由离开）时移除面板、取消延迟关闭定时器与监听。既有卸载用例要求监听归零（tests/web/feature-live.test.ts:1203-1225），而 body 上的面板不在 feature root 内，会残留并在下次挂载/别的页面里可见。",
      "remedy": "在 dispose/卸载时移除面板节点、取消延迟关闭定时器，并让所有监听挂到 `signal` 上；把该清理补进 §4 边界表与测试用例。"
    },
    {
      "id": "R1-8",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": null,
      "problem": "语言数量写错。`strings.ts` 除 `zh`、`en` 外还导入 zh-Hant、ja、ko、fr、de、es-419、pt-BR、it、ru 共 9 个 `Partial` 表，不是 Constraints 里说的 8 个（src/web/client/features/live/strings.ts:1-10）。",
      "remedy": "改为 9，或改写为“其余语言是 `Partial`，缺失自动回落”而不写具体数目。"
    },
    {
      "id": "R1-9",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": null,
      "problem": "`windowText(entry)` 的签名说不清两组数据从哪条记录取。提示在 USER 消息（`context.internals`）上；非 `inUser` 模式下事件正文在配对的 `function_call_output`（`context.frame`）上。单一 `entry` 无法同时服务两组，而 §2 只说“用 start/chars 把合并文本按行切回来，浮层正文与复制共用它”。",
      "remedy": "明确签名（如 `windowText(entry, refs)`），并写明事件组切的是 output 记录的 `frame` 引用、提示组切的是 user 记录的 `internals` 引用。"
    },
    {
      "id": "R1-10",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": null,
      "problem": "Success Criteria 的比对对象写错。它说复制内容“按 start/chars 切回后与 session-main.jsonl 原文 diff 为空”，但 `session-main.jsonl` 存的是合并后的整条 user 消息，逐条提示的原始文本在事件库（events）里；按字面执行时比对对象不是“该轮实际注入文本”。",
      "remedy": "改为“与合并消息中该 ref 的区间比对”或“与事件库中该 cursor 的原文比对”，二选一并写明操作方式。"
    },
    {
      "id": "R1-11",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": null,
      "problem": "`pendingPrompts` 的生命周期没有写全。§2 只说“任何非窗口记录到达时（以及 rebuild() 末尾）把 pendingPrompts 落成普通 USER 块”，没有说 `rebuild()` 开始时重置，也没覆盖空 session 早退与 `keepScroll` 早退（src/web/client/features/live/timeline.ts:579-600）；若不清空，上一轮重画留下的已脱离文档的节点可能被吸收进新窗口。",
      "remedy": "规定 `rebuild()` 入口清空 `pendingPrompts`，并把落单/flush 放在所有早退路径之前（或统一在结尾执行）。"
    },
    {
      "id": "R1-12",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": null,
      "problem": "Open Questions 与已提交行为混在一起。§2 已经决定“点击固定”、事件正文不加 `HH:MM` 前缀（正文仍用现有回执文本）、不列图片附件，但 Open Questions 1/2 仍把它们当作待定项并给“建议”。读者无法分辨哪些是待用户确认的发现、哪些是已承诺的行为。",
      "remedy": "把已按建议落定的项移出 Open Questions（或标注“已按建议采用”），只保留真正待用户决定的问题。"
    }
  ],
  "prior": []
}
```
