# 示例部署

一份 Cortico 部署就是一个目录：配置、密钥、Memory 和运行数据都在里面，本身不进版本控制。
这份 `example` 是脱敏后的空白模板，只保留结构和注释；没有任何真实账号、群号或密钥。

## 用法

```bash
cp -r deployments/example deployments/amber
pnpm start amber
```

启动后打开 `http://127.0.0.1:7790/`，在 WebUI 里：

1. **端点**：填模型服务的 Base URL、模型名和 API Key（写入 `deployments/providers/<端点>/`）。
2. **QQ**：填 NapCat / OneBot 的 WebSocket 地址与 access token，再把 `groups` 改成要监听的群号。
3. **人格**：编辑 `memory/CONSTITUTION.md` 与 `WORLDVIEW.md`。这两份文件是角色的长期原则和世界观，
   每次组装系统前缀时读入。
4. **口令**：`wakeNames` 是让她醒来的名字；`wakeOnMentionOnly` 默认只回应被点名的消息。

密钥只放在 `deployments/<名>/.env` 或 WebUI 里，不要写进 `config.json`，更不要提交。

## 目录

| 路径 | 说明 |
|---|---|
| `deployment.json` | 用哪个代码包；`amber` 指仓库里的 `bots/amber/` |
| `config.json` | 这份部署的配置，覆盖包内默认值 |
| `.env` | World 密钥（Tavily 等），由 `.env.example` 复制 |
| `secrets.local.json` | Persona 私有密钥（如 embedding key），WebUI 写入，已 gitignore |
| `prompts/ORIENTATION.md` | 开场引导的部署覆盖 |
| `memory/` | Memory：宪法、世界观、人物档案、日记、笔记 |
| `data/` | 运行数据：事件、会话、用量、日志。首次启动生成，已 gitignore |

更多字段见 [docs/deployment.md](../../docs/deployment.md) 与
[docs/configuration.md](../../docs/configuration.md)。
