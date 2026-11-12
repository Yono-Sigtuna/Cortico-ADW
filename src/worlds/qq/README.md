<!-- Owner: src/worlds/qq/definition.ts, src/worlds/qq/driver.ts, src/worlds/qq/normalize.ts, src/worlds/qq/world.ts -->

# worlds/qq

QQ 群聊与私聊接入。World 作为客户端连接一个 OneBot v11 协议端的正向 WebSocket,只处理
`worlds.qq.groups` / `worlds.qq.privates` 里启用的会话;发言走 `qq_draft`,和最近说过的话重复、
一条里堆了动作、又在宣布不接时扣下来复核一次。

## 协议端

任何 OneBot v11 实现都可以接,推荐 [SnowLuma](https://github.com/SnowLuma/SnowLuma),
[NapCat](https://github.com/NapNeko/NapCatQQ) 同样可用。换协议端只改 WebUI「接入门」里的
WS 地址与 token,保存后进程重启。

SnowLuma:

- 注入本机已安装并在运行的 QQNT 客户端,在 QQ 窗口里扫码登录;账号登录后它才开始监听
  OneBot 端口,这之前 World 按退避重连。
- 正向 WS 默认 `ws://127.0.0.1:3001`,与 `worlds.qq.wsUrl` 的默认值相同。token 在首次运行时
  按账号随机生成,写在 SnowLuma 目录的 `config/onebot_<QQ号>.json`。
- 它的状态命令默认开启:群里有人发 `#sl`,账号会自动回一条状态消息,这条消息不经过 `qq_draft`。
  接入前在 SnowLuma 配置里关掉 `statusCommand`。

## 依赖的动作与事件

OneBot v11 标准动作:`get_login_info`、`get_group_info`、`get_group_member_info`、`get_msg`、
`get_forward_msg`、`send_group_msg`、`send_private_msg`。

标准之外的字段,协议端不给时按下列方式降级:

| 字段 | 缺失时 |
|---|---|
| 通知 `group_msg_emoji_like` | 不产生表情回应事件 |
| `notify/poke` 的 `raw_info` | 动作文案退回「戳了戳」 |

## 分享卡片

JSON 分享卡片的来源名、内容标题和目标链接写入消息正文。直接消息、引用取回与合并转发使用相同解析规则。

| 卡片字段 | 小程序 `meta.detail_1` | 普通分享 `meta.news` |
|---|---|---|
| 来源名 | `title` | `tag` |
| 内容标题 | `desc` | `title` |
| 目标链接 | `qqdocurl` | `jumpUrl` |

缺失字段不补全；内容标题缺失时保留 `prompt`。只有 `prompt` 的卡片沿用 `[分享:<prompt>]`，
分享字段与 `prompt` 均缺失时显示 `[json]`。目标链接只收单个 http(s) 网址，其余当作缺失。
来源名与内容标题照卡片 JSON 原文写入，World 不核实。封面按图片配置与辅助视觉配置处理。

## 短时行动接续

每次调用 `qq_draft` 必须显式填写 `follow_up`：无需稍后接续填 `null`；让对方等待后续时填行动对象。漏填不发送、不保存草稿，回执要求补齐后重新调用。是否需要接续由模型判断，不扫描正文关键词。

`qq_draft.follow_up` 的行动对象包含 `action`、等待者 `person`、`kind`（`scene` / `task`）和 `after_minutes`（大于 0、至多 30）。限一拍文字，平台确认发送后才开始计时；扣下或明确发送失败不激活。状态原子保存在 `data/qq-continuations.json`，重启恢复；发送结果未知不自动重试。

到期通过 `qq.continuation` 延迟事件按 `flush` 投递，受 Core 暂停控制；投递时重新检查黑名单、监听会话与过期状态。预计到期后超过 30 分钟不再补演。事件附原发言、行动、等待者和最近同场消息，不消耗 Persona 主动聊天额度。`scene` 可以推进共同虚构场景；`task` 只提醒核对真实结果，时间经过不代表完成。

模型用 `qq_continue` 查看、取消或延后行动；用 `qq_draft.continuation_id` 发一拍接续，平台确认后才结账。未发出、取消草稿不结账；结果未知需先核对群史，不能另调一次自动重发。已通知但未决的行动保留在 `qq_continue list`，不周期性重复唤醒。普通状态描述不登记；模型应在让对方等待时主动填入 `follow_up`，没有关键词自动识别。

## 群聊形状

每个群一份滚动窗口(`worlds.qq.room`),只记样本不记正文,出一组可数的数字:条数、几个人在说、
最大占比、引用接话的比例、问到她头上的条数、静默分钟、热度档。引用关系取自消息里的 `reply` 段,
解析结果写在 `qq.message` 的 `meta.room`(取整、不含名字);另外在投递时补一条 `qq.room` 事件,
正文形如 `[群里此刻] 近 30 分钟 23 条，4 人在说（阿明 9 条）；7 条在接别人的话。`。

这一层不判断气氛:是不是在玩梗、是不是有人在较真,由模型读完上下文自己判断。数字没变就不重复发,
所以它在同一段安静里只出现一次。`qq_mark_room` 让模型自己写一句判断进 `data/qq-room-notes.json`,
带过期时间,跟着那一行回来,不参与任何机械判定。

## 回复对象与线索热度

回复对象在草稿首次发送前固定，两拍和重试共用。私聊归属目标账号；群聊优先使用同会话引用消息的发送者，无引用时使用该会话最后已投递的发言人。未知、跨会话引用或引用自身消息不为其他人建立回复归属。只有平台确认发送成功，才开启并刷新该对象的线索热度、清除其沉默状态；等待回执或两拍间隔中的新消息不改变本次归属。

## 沉默后的短陈述

沉默状态按会话和发送者隔离。只有 `onEventsSettled(..., 'delivered')` 确认写入会话的 `qq.message` 才计入本轮；入站排队、只归档、丢弃和内部轮不创建或延长沉默。实际发送成功才计为回应；明确引用优先确定对象，无引用的群发言按该会话最后已投递的发言人归属，私聊按目标账号归属。

未回应对象紧接着的短陈述暂只归档，点名、@ 和问句仍按原规则处理。另一会话或另一对象的发言不清除这条状态；停止 World 或重启后不恢复临时沉默。

## 语音转写

监听会话里收到的语音,正文占位为 `[语音,正在转写中...]`,World 随后用原 `message_id` 调协议端的
转写扩展动作,不阻塞后续消息。占位这条不单独唤醒;结果另发一条 `qq.transcript` 事件,行首是原消息号,
带原会话、发言人和 `[QQ语音转写]` 标记,照常合批唤醒。没转写成的说明同样唤醒。占位随下一次唤醒投递:
转写完成前有别的消息唤醒时随那一批,否则与转写结果同批。

| 协议端 | 动作 |
|---|---|
| SnowLuma、NapCat | `fetch_ptt_text({ message_id })` → `{ text }` |
| LLOneBot | `voice_msg_to_text({ message_id })` → `{ text }` |

先试 `fetch_ptt_text`,协议端回 retcode 1404(动作不存在)才换 `voice_msg_to_text`;探明可用的
动作在本次连接内沿用,重连后重新探明。两个都回 1404 时发一条不可用说明,此后本次连接里的语音
占位为 `[语音,协议端不提供转写]`,不再请求。

超时、撤回、识别失败或转写为空不换动作名,各发一条 `[系统] #<message_id> 的语音没能转写:<原因>`。
调用时限 40s:协议端等转写结果最长 30s,再加一次普通动作调用的时限 10s。

语音以 `base64://` 的 `record` 段发出,转成 QQ 语音格式由协议端负责。
