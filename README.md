# CrowdMovie v1

观众投稿、投票并推动 AI 连续短片的网站。Vue 3 前端、Fastify API、PostgreSQL 作业账本、Qwen3.8 导演、Codex 内容处理和 MiniMax H3 本地音视频生成组成完整链路。

这是当前代码的独立初始快照，没有导入原仓库 Git 历史、生产数据库、用户上传、生成视频、登录状态、密钥或部署地址。所有内网地址仅为 `192.168.10.*` 示例。公网地址均通过本地环境配置；仓库不包含公网 IP 字面量。

从 [INSTALL.md](INSTALL.md) 开始；交给另一个 Codex 时，先读 [AGENTS.md](AGENTS.md)。

| 内容 | 入口 |
| --- | --- |
| 架构、状态与作业链 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Qwen3.8 导演流程与 Astra 接手 | [docs/DIRECTOR.md](docs/DIRECTOR.md) |
| 服务器 Codex 安装、身份隔离与工作流 | [docs/CODEX.md](docs/CODEX.md) |
| H3 模型、ComfyUI、网关与工作流 | [docs/H3.md](docs/H3.md) |
| 环境变量 | [.env.example](.env.example)、[docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| 当前导演指导 | [workstation/movie/director-brief-v3.md](workstation/movie/director-brief-v3.md) |
| 导演技能、世界与人物设定 | [workstation/AGENTS.md](workstation/AGENTS.md)、`workstation/movie/`、`workstation/skills/` |
| 安全边界 | [SECURITY.md](SECURITY.md) |

本版本使用本地 H3 网关和 Qwen 主路径；没有声称实现云视频供应商切换或纯 Codex 模式。模型权重需自行获取；可访问的 Codex 模型取决于自己的账号权限。随代码保留的旧版 schema/brief 是运行时兼容文件，不是旧 Git 历史。
