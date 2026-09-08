# CrowdMovie v1

[English](#english) | [中文](#中文)

## English

CrowdMovie is a website where audiences submit ideas, vote, and shape an ongoing AI film. Vue 3, a Fastify API, a PostgreSQL job ledger, a Qwen3.8 director, Codex content processing, and local MiniMax H3 video and audio generation form the complete pipeline.

### How it works

1. The audience submits ideas and votes on what happens next.
2. Qwen3.8 turns the selected direction into structured scene and shot plans. After two failed director attempts, Codex takes over with `gpt-6-astra` at low reasoning effort.
3. The application validates the plan and dispatches video and audio generation to the local MiniMax H3 gateway.
4. Published scenes become the starting point for the next round of audience participation.

### Get started

Start with [INSTALL.md](INSTALL.md) for prerequisites, builds, database setup, model services, and deployment. For another Codex agent taking over the project, read [AGENTS.md](AGENTS.md) first.

```bash
git clone https://github.com/linkprint-inc/crowdmovie.git
cd crowdmovie
```

This is an independent initial snapshot. It does not import the previous repository's Git history, production databases, uploads, generated videos, login state, secrets, or deployment addresses. Private network examples use `192.168.10.*`; deployment addresses belong in local configuration. The repository contains no public IP literals.

### Documentation

| Topic | Entry point |
| --- | --- |
| Installation and deployment | [INSTALL.md](INSTALL.md) |
| Architecture, state, and job pipeline | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Qwen3.8 director and Astra fallback | [docs/DIRECTOR.md](docs/DIRECTOR.md) |
| Server Codex installation, identity isolation, and workflow | [docs/CODEX.md](docs/CODEX.md) |
| H3 models, ComfyUI, gateway, and workflow | [docs/H3.md](docs/H3.md) |
| Environment configuration | [.env.example](.env.example), [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Current director guidance | [workstation/movie/director-brief-v3.md](workstation/movie/director-brief-v3.md) |
| Director skills, world, and character definitions | [workstation/AGENTS.md](workstation/AGENTS.md), [workstation/movie/](workstation/movie/), [workstation/skills/](workstation/skills/) |
| Security boundaries | [SECURITY.md](SECURITY.md) |

### Scope

This version uses the local H3 gateway and Qwen as the primary director. Cloud video provider switching and a Codex-only mode are not implemented. Obtain model weights separately; available Codex models depend on your account access. Older schemas and briefs retained in the source are runtime compatibility files, not imported Git history. New installations include no generated footage and require configured model services to produce it.

## 中文

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

### 工作流程

1. 观众投稿并投票，决定下一幕的方向。
2. Qwen3.8 生成结构化场景与镜头计划；导演尝试失败两次后，由 Codex 使用 `gpt-6-astra`、low 推理强度接手。
3. 应用校验计划并将音视频生成任务交给本地 MiniMax H3 网关。
4. 发布的场景成为下一轮观众参与和续写的起点。

### 获取代码

```bash
git clone https://github.com/linkprint-inc/crowdmovie.git
cd crowdmovie
```

按 [INSTALL.md](INSTALL.md) 完成依赖安装、构建、数据库、模型服务和部署配置。新安装不包含生成影片，需要先配置模型服务才能制作内容。
