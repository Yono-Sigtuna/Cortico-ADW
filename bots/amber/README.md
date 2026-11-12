<!-- Owner: bots/amber/index.ts, bots/amber/persona/index.ts, bots/amber/persona/companion/life-speak.ts -->

# bots/amber

分层 Memory 的 Persona。`CortiSoulmate` 继承 `Cormini`，增加备忘分层、生活状态、昼夜作息与交接后的后台梦。

## 启动

```bash
pnpm start amber
```

默认 WebUI 地址:`http://127.0.0.1:7777/`。

## World

默认启用 `qq`、`console`、`websearch`。

## 活动与发言

主会话带 `speak` 标签的 World 工具由 Persona 封装，额外要求 `life_update`：本人当前活动、地点或睡眠已改变时填 `{ doing, sleeping, location?, until?, duration_minutes? }`，未变或尚未发生填 `null`。`until` 与 `duration_minutes` 互斥，日程空档新活动至少给一个期限。相对时长填数字分钟，由运行时从提交时刻精确计算；即使当前有日程，也不把临时活动拖到整段计划结束。更新已有活动而不重新给期限时，原起止时间不变。元数据不传给 World；漏填、无效或生活状态保存失败时，不执行原工具。

已声明发生的活动先落盘，随后执行原发言工具；发言扣下、失败或草稿取消不回滚活动。再次确认或改写消息不自动重放活动。不发言的活动变化仍可用 `advance_life`，`end_turn` 保持可用。系统不扫描发言正文推断动作，`null` 是否符合台词仍由模型判断。

## WebUI

Persona 自报工作区、Memory 与版本历史三块;`webui-page.ts` 另外贡献存档点、统一重置与强制入梦三块,与 Persona 那半合成同一页。
