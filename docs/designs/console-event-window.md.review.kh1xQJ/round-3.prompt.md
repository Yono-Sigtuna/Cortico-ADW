# Office-hours independent spec review — round 3

Document: C:\Cortico\Cortico-main\docs\designs\console-event-window.md
Verdict: C:\Cortico\Cortico-main\docs\designs\console-event-window.md.review.kh1xQJ\round-3.json

Use only Read, Write, and the one Bash seal command for this review. Read the design at "C:\\Cortico\\Cortico-main\\docs\\designs\\console-event-window.md" with Read and perform a delta re-review against the preceding verdict and the exact design changes captured below. Never use Edit on any file, your verdict file included, and do not change the design.
Use Write to save your complete verdict as JSON to "C:\\Cortico\\Cortico-main\\docs\\designs\\console-event-window.md.review.kh1xQJ\\round-3.json". Then run the `Seal:` command from your dispatch message with Bash, exactly as given; it validates the saved file and prints one receipt line. If it reports an error, Write the complete corrected JSON to the same path (never Edit, even for a one-field fix) and run the same command again. Use Bash for nothing else.
Return only that printed `OFFICE_HOURS_VERDICT round=3 sha256=<hash> path=<verdict path>` line, unchanged, as your entire response: no JSON, Markdown fences, or prose. The parent verifies the receipt against the saved bytes.
The saved JSON is your sole findings inventory: include every unresolved problem and necessary remedy, including minor findings that a short conclusion might omit.
Use one finding per distinct obligation. An exact duplicate shares a finding; a shared component does not combine separate decisions, behavior, or effort.

## Severity

Give every finding a severity. Only blocking findings send the design back for another round; minor findings are recorded for the user and never require another round on their own.
- **blocking**: a contradiction; a safety or correctness risk; an unsupported claim the recommendation depends on; missing behavior the committed approach needs; or a persisting blocking prior obligation. Example: the design promises the roster is never stored, yet its sync step saves it nightly.
- **minor**: clarity, wording, or polish that does not change a decision or behavior. Example: the Recommended Approach repeats the problem statement's wording and could be shorter.
When unsure whether a gap changes a decision or behavior, it is blocking.

## Delta re-review scope

This is round 3. Round 1 already reviewed the whole design. Raise a NEW blocking finding only when the changes since round 2 (a) introduced it, as a regression, or (b) exposed it in text that changed. Set its changed_text to a verbatim excerpt of at least 8 characters from one changed (+ or -) line of the diff below. Anything else you notice is minor and never forces another round; give it changed_text null unless it also concerns changed text.
A persisting or unverified prior obligation keeps its current finding without a citation.

The helper captured this exact line diff between the design reviewed in round 2 and the current design ("-" removed, "+" added, "@@" separates hunks):

````diff
 `inUser` 模式下 `context.frame` 的 `base` 是内部行总长，两者天然不重叠。`internals` 是纯元数据：不进请求体（`inputItem()` 只读 `item`），不写进模型上下文，`session-main.jsonl` 只多这一个键。
 
-### 2. 服务端：文本被替换时作废引用
+### 2. 服务端：`frame` 不能删，只清 `internals`
 
-`src/core/truncate.ts` 的 `rebuildTail()` 会把超长回执替换成 `[result folded]`、把超长消息替换成 `[turn too long, omitted]`，而 `withText()` 只换 `item`、**原样保留 `context`**（[context.ts:64-69](Cortico-main/src/protocol/open-responses/context.ts:64)）。那样 `start/chars` 就指向被替换后的短文本，浮层会切出空串或错位。
+`src/core/truncate.ts` 的 `rebuildTail()` 会把超长回执替换成 `[result folded]`、把超长消息替换成 `[turn too long, omitted]`，而 `withText()` 只换 `item`、**原样保留 `context`**（[context.ts:64-69](Cortico-main/src/protocol/open-responses/context.ts:64)）。那样 `start/chars` 就指向被替换后的短文本。
 
-服务端在这里一并清掉失效元数据（与 `withText` 同处调用，两行）：
+**但 `context.frame` 不是控制台专用数据**：`requeueUndelivered()` 用 session 记录上的 `context.frame.events[].cursor` 判断哪些外部事件已经投递过、重启后不再补投（[loop.ts:918-923](Cortico-main/src/core/loop.ts:918)）。清掉它会让重启后重复投递同一批事件。所以：
 
+- `context.frame` **一律不动**。它只带游标与时间，正文偏移失效不影响补投逻辑。
+- 只有本次新增、且没有其他消费者的 `context.internals`，在文本被替换时清掉：
+
 ```ts
-delete entry.context.frame;
-delete entry.context.internals;
+// rebuildTail 替换 item 文本处
+if (entry.context.internals) delete entry.context.internals;
 ```
 
-前端另有兜底：`windowText()` 校验 `start + chars <= text.length`，越界即视引用失效，整段显示并标 `S.evwinStale`。
+前端另有兜底：`windowText()` 校验 `start + chars <= text.length`，越界即视引用失效，整段显示并标 `S.evwinStale`。这条兜底同时覆盖"回执被折叠、`frame` 故意保留"的情形。
 
 ### 3. 前端：三种形态，一个组件
@@
 - **能力检查**：`typeof el.getBoundingClientRect === 'function'` 才做定位；否则降级为附在窗口卡内的静态块（测试桩走这条，内容与复制逻辑照常可断言）。
 - `mouseenter` 开、`mouseleave` 150ms 后关、点击固定、`Escape` 与 `tlscroll` 滚动关闭。
-- **生命周期**：所有监听挂 `{ signal }`；延迟关闭的定时器句柄存在闭包里；`signal` abort 时移除面板并清定时器——body 上的节点不在 feature root 内，不显式移除会残留到下一次挂载和其他页面。
+- **生命周期**：所有监听挂 `{ signal }`，延迟关闭的定时器句柄存在闭包里。两处收尾，缺一不可：
+  - `signal` abort（卸载／路由离开）：移除 body 上的面板、清定时器。
+  - `rebuild()` 入口（fork 视图每 3 秒轮询一次，[fork.ts:153](Cortico-main/src/web/client/features/live/fork.ts:153)）：先关面板、清定时器、清 `pendingPrompts`／`windowByCall`，再 `inner.replaceChildren()`。否则面板的锚点节点在新一轮里已被替换，浮层会悬在空处。
 - 两组：**事件** `hh:mm:ss · source · [type] · N 字 · 首行预览`；**提示** `[kind] hh:mm:ss · N 字` + `▾` 展开全文 + `copy` 复制。
 - 复制与展开共用一个 `windowText(entry, refs)`：事件组传 `(outputEntry, outputEntry.context.frame.events)`，提示组传 `(userEntry, userEntry.context.internals)`。两组数据不在同一条记录上，签名必须带 `refs`。
@@
 ### 4. 字符串与样式
 
-- `strings.ts`：`zh` 与 `en` 各加 7 条 —— `evwinSummary(events, prompts)`、`evwinEvents`、`evwinPrompts`、`evwinNoPrompts`、`evwinNoMeta`、`evwinCopy`、`evwinCopied`。
+- `strings.ts`：`zh` 与 `en` 各加 8 条 —— `evwinSummary(events, prompts)`、`evwinEvents`、`evwinPrompts`、`evwinNoPrompts`、`evwinNoMeta`、`evwinStale`、`evwinCopy`、`evwinCopied`。
 - `styles.css`：`.evwin` 头部（与 `.ghead` 同级密度）、`.evpop` 面板（沿用主题变量）、`.evpop-row` 的等宽时间列。
 
@@
 | `inUser` 模式 | 同一条消息建完整窗口，按"提示 → 事件"两段，不重复 |
 | 回执不带 `frame`（补回执 / 被折叠 / 修配对） | 事件区显示 `S.evwinNoMeta`，提示区照常，不抛错 |
-| 文本被 `rebuildTail()` 替换 | 服务端清 `frame`/`internals`；前端 `start+chars` 越界则整段显示并标"引用已失效" |
+| 文本被 `rebuildTail()` 替换 | 只清 `internals`（`frame` 不动，补投逻辑要用）；前端 `start+chars` 越界则整段显示并标"引用已失效" |
 | `ephemeral` 记录 | 头部标 `ephemeral`；它会被 `dropEphemeral()` 清掉，下次重画自然消失 |
 | 超长提示（memory 400+ 字） | 浮层默认 2 行，`▾` 展开；复制永远给全文 |
@@
 1. `src/protocol/open-responses/context.ts`：`ContextMeta.internals?: FrameEventRef[]`。
 2. `src/core/loop.ts:700` 附近：`msg.context.internals = frameEventRefs(internals, 0)`。
-3. `src/core/truncate.ts` / `withText` 调用处：替换文本时 `delete context.frame` / `delete context.internals`。
-4. `tests/core`：一次唤醒的 user 消息带 `internals`，`start/chars` 逐行切回原文；折叠后引用被清。
+3. `src/core/truncate.ts`：`rebuildTail()` 替换 item 文本时 `delete context.internals`（`context.frame` 保留）。
+4. `tests/core`：一次唤醒的 user 消息带 `internals`，`start/chars` 逐行切回原文；折叠后 `internals` 被清、`frame` 仍在。
 5. `timeline.ts`：`windowText(entry, refs)` + `EventWindow` 组件（A/B/C 三形态）。
 6. `timeline.ts`：`windowByCall` 回填 + `pendingPrompts` 生命周期（含 `rebuild()` 入口清空、早退前 flush）。
-7. `timeline.ts`：浮层（能力检查、点击固定、abort 清理）。
-8. `strings.ts`：`zh` / `en` 各 7 条；`styles.css` 增 `.evwin` / `.evpop`。
+7. `timeline.ts`：浮层（能力检查、点击固定、`rebuild()`／abort 双收尾）。
+8. `strings.ts`：`zh` / `en` 各 8 条；`styles.css` 增 `.evwin` / `.evpop`。
 9. `tests/web/feature-live.test.ts`：合成单元、内部唤醒落单、缺帧降级、提示逐条切分与复制文本、卸载后监听归零。
 10. 实机：给她发一条提到她的消息，控制台 hover 头部，核对浮层与 `session-main.jsonl` 最后一批记录一致。
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
  "round": 3,
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
      "id": "R3-1",
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

Finding IDs are R3-<number>; dimension names are the five lowercase keys above; severity is blocking or minor. Supply a quality score from 1 to 10. A dimension is ISSUES exactly when it has findings; otherwise PASS.
Round 1 has an empty prior array. In later rounds, replace the example's empty prior array with one status for EVERY finding in the complete preceding verdict below:
{"id":"<preceding finding ID>","status":"resolved","evidence":"Specific document decision proving resolution","current_id":null}
or {"id":"<preceding finding ID>","status":"persisting","evidence":"Same original obligation still unmet at this document passage","current_id":"R3-1"}.
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
  "round": 2,
  "document": "C:\\Cortico\\Cortico-main\\docs\\designs\\console-event-window.md",
  "quality_score": 7,
  "dimensions": {
    "completeness": "ISSUES",
    "consistency": "ISSUES",
    "clarity": "ISSUES",
    "scope": "PASS",
    "feasibility": "PASS"
  },
  "findings": [
    {
      "id": "R2-1",
      "dimension": "consistency",
      "severity": "blocking",
      "changed_text": "整段显示并标 `S.evwinStale`",
      "problem": "§2 新增的兜底要标 `S.evwinStale`，但 §4 与 Next Steps 8 都只列了 7 条字符串（evwinSummary / evwinEvents / evwinPrompts / evwinNoPrompts / evwinNoMeta / evwinCopy / evwinCopied），没有 evwinStale；边界表又写成硬编码的「标\"引用已失效\"」。`strings.ts` 里 `zh` 是基准类型、`S` 由它导出，照 §4 只加 7 条会让 `S.evwinStale` 过不了 typecheck（Success Criteria 把 `pnpm typecheck:web` 列为验收项），同一状态还在文档里出现了两种呈现方式。",
      "remedy": "把 §4 与 Next Steps 8 的键数改为 8 并补上 `evwinStale`（或 §2 改用已列出的键），同时把边界表那一格改成同一个键，三处一致。"
    },
    {
      "id": "R2-2",
      "dimension": "consistency",
      "severity": "blocking",
      "changed_text": "delete entry.context.frame;",
      "problem": "`context.frame` 不只是给控制台看的元数据：`requeueUndelivered()`（[loop.ts:919-923](C:/Cortico/Cortico-main/src/core/loop.ts:919)）靠 session 记录上的 `context.frame.events[].cursor` 判断「已投递但水位之后的事件已经进了上下文」，以避免重启补投重复。`rebuildTail()` 的折叠结果会经 `clampTail()` → `performHandoff()` 的 `session.reset()` 持久化回 session（[loop.ts:1699-1700](C:/Cortico/Cortico-main/src/core/loop.ts:1699)、[loop.ts:1729](C:/Cortico/Cortico-main/src/core/loop.ts:1729)）。按 §2 在折叠时 `delete context.frame`，一条超长事件帧回执（或 inUser 模式下的 user 消息）的已投递游标就丢了；重启时若水位因更早的未投递事件停在缺口上，这些已投递事件会被重新补投，模型上下文出现重复事件。§2 只考虑了浮层切片，没考虑这个既有消费者。另：`withText()` 返回的新记录与原记录共享 `context` 对象引用，直接 `delete entry.context.frame` 会连带改到快照和其他引用同一 context 的记录。",
      "remedy": "折叠时不要整段删除 frame：保留 `cursor/ts/type/source`（重启去重需要），只让切片失效——例如给 `FrameEventRef` 加 `stale: true`（或去掉 `start/chars`），`windowText()` 判 stale 后整段显示；或者把已投递游标迁到独立字段并同步修改 `requeueUndelivered()`。同时在删除前复制 `context`，避免修改共享对象。"
    },
    {
      "id": "R2-3",
      "dimension": "completeness",
      "severity": "blocking",
      "changed_text": "`signal` abort 时移除面板并清定时器",
      "problem": "浮层的生命周期只覆盖了 `signal` abort（卸载），没有覆盖 `rebuild()`。fork 视图每 3 秒轮询一次 `timeline.rebuild()`（[fork.ts:153](C:/Cortico/Cortico-main/src/web/client/features/live/fork.ts:153)），`session.reset`、重连 hello、切回主 session 也都会整份重画；`rebuild()` 用 `inner.replaceChildren()` 换掉锚点节点（[timeline.ts:576](C:/Cortico/Cortico-main/src/web/client/features/live/timeline.ts:576)），body 上的面板不在被替换的子树里，锚点上的 `mouseleave` 监听随节点失效，面板会停在原地显示旧内容（点击固定后尤其明显），直到用户滚动或按 Escape。设计自己把 `rebuild()` 列为轮询路径，却没有规定重画时关闭浮层。",
      "remedy": "在 `rebuild()` 入口（包括空 session 早退与 keepScroll 早退之前）关闭并移除面板、清掉延迟关闭定时器；补进边界表与测试（例如重画后 `document.body` 上不再有 `.evpop`）。"
    },
    {
      "id": "R2-4",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": "三条渲染路径必须同形状：`rebuild()`（整份重画／轮询）、`append()`（实时帧）、`f.messages`（fork）",
      "problem": "Constraints 写「三条渲染路径必须同形状：rebuild()、append()、f.messages（fork）」，Success Criteria 写「f.session、f.messages、rebuild、append 四条入口/路径渲染一致」：约束里 f.session 消失，f.messages 又被称作路径，两处枚举不一致，实现者无法确定同形状的验收面到底是三条还是四条。",
      "remedy": "统一说法：两条入口（f.session、f.messages）× 两条路径（rebuild、append），或两处都直接列出相同的四处。"
    },
    {
      "id": "R2-5",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": "否则降级为附在窗口卡内的静态块",
      "problem": "浮层降级写「附在窗口卡内的静态块」，但形态 C 明确「不建窗口」，它的摘要条在普通 USER 块上；测试桩（无 `getBoundingClientRect`）下形态 C 的浮层降级到哪里没有定义，而 Next Steps 9 又要测「内部唤醒落单」与内容/复制。",
      "remedy": "改成「附在宿主卡片内（窗口卡或形态 C 的 USER 块）」，并说明形态 C 的静态块挂在哪一层。"
    },
    {
      "id": "R2-6",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": "`Escape` 与 `tlscroll` 滚动关闭",
      "problem": "`tlscroll` 在代码里只是滚动容器的 class（[timeline.ts:117](C:/Cortico/Cortico-main/src/web/client/features/live/timeline.ts:117)），并没有同名事件；「`tlscroll` 滚动关闭」读起来像在监听一个自定义事件，监听目标和事件名不明确。",
      "remedy": "写明监听 `.tlscroll` 容器的 `scroll` 事件（可复用现有 shouldStick 监听或另挂一个），或改成「时间线滚动时关闭」。"
    },
    {
      "id": "R2-7",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": "（[src/core/loop.ts:854](Cortico-main/src/core/loop.ts:854)）",
      "problem": "本轮把 loop.ts:854 的链接从绝对路径改成了相对路径 `Cortico-main/src/core/loop.ts:854`；从 `docs/designs/` 解析会指向不存在的 `docs/designs/Cortico-main/...`，同文其他链接（如 [loop.ts:201]、[loop.ts:847]）仍是 `C:/Cortico/...` 形式。",
      "remedy": "恢复成与其他链接一致的绝对路径，或统一改成正确的相对路径（`../../src/core/loop.ts`）。"
    },
    {
      "id": "R2-8",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": "（与 `withText` 同处调用，两行）",
      "problem": "§2 说「与 `withText` 同处调用」，Next Steps 3 写「`src/core/truncate.ts` / `withText` 调用处」；`withText` 还有一个调用点是 [loop.ts:1439](C:/Cortico/Cortico-main/src/core/loop.ts:1439)（把 soft 轮提示追加到回执末尾），那里原文前缀保留、`start/chars` 仍有效，若按字面在所有 `withText` 调用处清理会误删有效元数据。",
      "remedy": "把范围限定为 `rebuildTail()` 的两处替换（折叠与超限），并说明追加文本不清理；或把失效逻辑放进 `rebuildTail()` 内部而不是泛化到 `withText`。"
    }
  ],
  "prior": [
    {
      "id": "R1-1",
      "status": "resolved",
      "evidence": "§0 数据表与 §3 形态 A 步骤 2/3：窗口在 `renderToolCall()` 建卡时头部先留 `—`，等 `renderToolResult()` 拿到同 call_id 的回执后再从 `context.frame?.events` 填时间与事件数。",
      "current_id": null
    },
    {
      "id": "R1-2",
      "status": "resolved",
      "evidence": "§3 形态 B：`renderWorld()` 见 `context.frame?.events?.length > 0` 就直接建完整窗口（提示段 + 事件段），走同一个组件。",
      "current_id": null
    },
    {
      "id": "R1-3",
      "status": "resolved",
      "evidence": "§3 形态 C、边界表与 Success Criteria 三处统一：内部唤醒是普通 USER 块 + 可 hover 摘要条，时间取 `internals[0].ts` → `context.ts` → `—`。",
      "current_id": null
    },
    {
      "id": "R1-4",
      "status": "resolved",
      "evidence": "§2 新增服务端作废引用（折叠/超限时清 `frame`/`internals`）与前端 `windowText()` 越界校验，边界表新增「文本被 rebuildTail 替换」一行；Success Criteria 也改为只降级不抛错。",
      "current_id": null
    },
    {
      "id": "R1-5",
      "status": "resolved",
      "evidence": "浮层新增能力检查（`typeof el.getBoundingClientRect === 'function'`），缺席时降级为卡内静态块；Constraints 明确 FakeEl 没有该 API，边界表与 Next Steps 同步。",
      "current_id": null
    },
    {
      "id": "R1-6",
      "status": "resolved",
      "evidence": "§3 形态 A 步骤 3 子条明确回执缺 `frame`（MISSING_RESULT_RESTART、折叠、配对修复）时事件区显示 `S.evwinNoMeta`、不抛错；边界表与 Success Criteria 一致。",
      "current_id": null
    },
    {
      "id": "R1-7",
      "status": "resolved",
      "evidence": "浮层新增「生命周期」段：所有监听挂 `{signal}`、延迟关闭定时器句柄在闭包里、abort 时移除面板并清定时器；边界表新增卸载行，Next Steps 9 要求测卸载后监听归零。",
      "current_id": null
    },
    {
      "id": "R1-8",
      "status": "resolved",
      "evidence": "Constraints 不再写具体语言数，改为「其余语言是 `Partial`，缺失自动回落，不必逐个补」。",
      "current_id": null
    },
    {
      "id": "R1-9",
      "status": "resolved",
      "evidence": "浮层条目写明「复制与展开共用一个 `windowText(entry, refs)`」，并指出事件组传 `(outputEntry, outputEntry.context.frame.events)`、提示组传 `(userEntry, userEntry.context.internals)`。",
      "current_id": null
    },
    {
      "id": "R1-10",
      "status": "resolved",
      "evidence": "Success Criteria 改为「比对对象是合并消息里该 ref 的 `[start, start+chars)` 区间（`session-main.jsonl` 里那条 user 消息），不是事件库原文」。",
      "current_id": null
    },
    {
      "id": "R1-11",
      "status": "resolved",
      "evidence": "落单规则写明在任何非窗口记录、`rebuild()` 末尾、所有早退分支之前统一 flush；Next Steps 6 明确含「`rebuild()` 入口清空、早退前 flush」。",
      "current_id": null
    },
    {
      "id": "R1-12",
      "status": "resolved",
      "evidence": "Open Questions 明确三条已按建议落定（事件正文不加时间前缀、hover 开 + 点击固定、不列图片附件），只保留形态 C 是否支持点击展开这一条真正待定问题。",
      "current_id": null
    }
  ]
}
```
