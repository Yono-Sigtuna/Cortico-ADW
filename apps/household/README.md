<!-- Owner: apps/household/cli.ts, apps/household/server.ts, apps/household/migration.ts -->
# 三小只管理入口

`http://127.0.0.1:7789/` 是**原生 WebUI**，不是另一个面板。管理程序把整页转发给当前选中的实例，只在页面底部注入一条实例切换条；控制台、运行诊断、供应商、提示词、Memory 与扩展面板都还是原来的页面，不会缺功能。

切换条写入 `household_instance` Cookie，之后所有 HTTP 与 WebSocket 请求转发到该实例；切换即整页重载，三个实例互不共享登录态。

## 公共配置

公共运行配置存在 `deployments/shared/config.json`，`deployment.json.sharedConfig` 显式启用继承，个体配置不能遮蔽公共键。

在原生配置页里改公共键和个体键可以一次保存：管理程序按 policy 拆分，公共键写入公共文件，其余原件转发给实例，回执合并成一句。公共值合并进每个实例的有效配置，所以面板显示的已经是继承后的值。

未经迁移（没有共享目录）时公共保存返回 503，不会偷偷写成个体副本。

人格、Memory、对话、提示词覆盖与生活实际状态不迁移、不合并。白龙、鲸鱼的自主写作仍关闭。

## 首次切换

先检查差异：

```bash
node node_modules/tsx/dist/cli.mjs apps/household/cli.ts migrate --dry-run
```

取得停机授权后，通过各实例公开 shutdown 完成收尾并确认进程退出，再执行：

```bash
node node_modules/tsx/dist/cli.mjs apps/household/cli.ts migrate --execute
```

迁移保存原始文件字节和不存在状态，先暂存验证后提交。中断留下 `.migration-in-progress`，阻止启动与公共保存。用命令输出的迁移 ID 恢复（必须替换成真实 ID）：

```bash
node node_modules/tsx/dist/cli.mjs apps/household/cli.ts migrate --recover=<migration-id>
```

恢复只还原迁移涉及的配置，不恢复私人数据；备份可能含凭据，不要上传 migrations 目录。

## 生效语义

公共文件保存成功不等于运行中的实例已读取新值。原生面板的 `/api/config` 附带的共享状态会按键报告待重启项；本版本未证明热生效的字段统一标为待重启，不自动重启三小只，下次启动读取最新版本。

## 边界

管理程序只监听回环地址，拒绝跨站写请求与非声明目标，转发时把 Origin 改写为实例自身。实例若设了 WebUI 密码，管理程序不代持登录：先在该实例原生入口登录，Cookie 随请求转发。

启动时若 7789 被占用，管理程序报错退出，三份实例不受影响；管理程序退出也不会停止实例。

## 故障

共享文件写锁阻止并发写。异常留下写锁时，先确认持有者进程已停止、核对文件与临时文件，再人工移除，不按超时自动抢占。
