# Server Codex installation and workflow

应用依赖 `@openai/codex-sdk`，生产基线另行固定 CLI **0.153.4**。SDK 锁文件和独立 CLI 是两项配置，不要假设 SDK 自带的二进制支持 Astra。

```bash
sudo install -d -m 0755 /opt/crowdmovie/tools/codex-0.153.4
sudo npm install --prefix /opt/crowdmovie/tools/codex-0.153.4 @openai/codex@0.153.4
/opt/crowdmovie/tools/codex-0.153.4/node_modules/.bin/codex --version
sudo install -d -m 0700 -o crowdmovie -g crowdmovie /var/lib/crowdmovie/codex
sudo -u crowdmovie env CODEX_HOME=/var/lib/crowdmovie/codex \
  /opt/crowdmovie/tools/codex-0.153.4/node_modules/.bin/codex login --device-auth
sudo -u crowdmovie env CODEX_HOME=/var/lib/crowdmovie/codex \
  /opt/crowdmovie/tools/codex-0.153.4/node_modules/.bin/codex login status
```

由服务器运营者使用自己的账号完成登录，不复制其他机器的 auth.json。设备登录需账号允许该方式；可用方式见 [OpenAI authentication](https://learn.chatgpt.com/docs/auth)。npm 安装方式见 [OpenAI Codex CLI](https://learn.chatgpt.com/docs/codex/cli)。这些文档说明安装/认证，具体模型权限以自己的账号和 canary 为准。

在 `/etc/crowdmovie/codex.env` 设置：

```ini
CODEX_HOME=/var/lib/crowdmovie/codex
CODEX_EXECUTABLE_PATH=/opt/crowdmovie/tools/codex-0.153.4/node_modules/.bin/codex
CODEX_WORKSTATION_DIR=/opt/crowdmovie/workstation
```

常驻的是 systemd 内容 worker；每个任务从 PostgreSQL 取事实，并非一个无限增长的交互会话。Qwen 处理主评分、导演和字幕等任务；Sol 用于剧集规划、故事设定审核等 Codex 路径；导演故障时由 Astra low 接手。完整路由以 `app/server/src/ai/codex.ts` 和 `ai/codex-story-review.ts` 为准。

`codexClientOptions()` 只传 CODEX_HOME 和可选 locale 给子进程，拒绝继承数据库口令及会话密钥。使用只读 permissions、关闭 shell/web/MCP 等工具能力，拒绝非内容输出；systemd 隔离 `/etc/crowdmovie`。运行时目录与文件权限必须与服务账号一致。不要把开发 Codex 的全权限设置复制给内容 worker。

构建后可运行 `node app/server/dist/ops/codex-canary.js` 和 `node app/server/dist/ops/codex-story-review-canary.js`，使用上述服务账号和环境。二者实际使用账号额度，不写数据库、不生成视频。Astra 的完整导演 schema 兼容性还需导演路径验证，不能以普通评分 canary 代替。

排错顺序：CLI 版本 → 同账号 login status → 环境文件/路径 → 模型权限 → schema 错误 → ai_runs/provider/effort → workflow_jobs 重试。不要输出 auth.json、完整环境或带身份的日志到 PR。
