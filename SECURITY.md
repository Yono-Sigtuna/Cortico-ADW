# Security Policy

Cortico-ADW 是 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 的二次开发分支，不提供与上游相同的维护承诺。

## 报告

本分支引入的问题，请通过本仓库的 **Security → Report a vulnerability** 私密报告，不要开公开 issue。

问题如果只存在于上游 Core、World、WebUI 或扩展加载器，请同时报告给
[Pal AI Lab / Cortico](https://github.com/Pal-AI-Lab/Cortico/security/advisories/new)。

报告里写明：

- 受影响的 commit 或版本；
- 复现步骤；
- 攻击者能得到什么（读取 Memory、冒用 QQ 身份、拿到密钥、执行任意代码等）。

## 范围

本仓库的全部内容，包括启动器、Core、WebUI、`bots/amber` Persona 与 QQ World。

不在范围内：

- 第三方扩展包；报给它自己的仓库。
- 你自己部署里泄露的 API Key；到对应服务商处吊销。
- 部署目录里的 `data/`、`memory/`、`.env`、`secrets.local.json`；这些文件本就不应提交。

## 密钥

仓库只包含 `deployments/example/` 模板。如果你在提交前改过 `.gitignore`，先跑一遍：

```bash
git grep -nE 'sk-[A-Za-z0-9]{16,}|nvapi-|tvly-|github_pat_|ghp_'
```
