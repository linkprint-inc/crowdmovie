# Architecture

浏览器通过 Caddy 访问 Vue 静态页面、Fastify API/SSE 与发布媒体。PostgreSQL 是用户、投稿、投票、轮次、AI 运行和作业状态的事实来源。同一 `app/server/dist/index.js` 以 `SERVICE_ROLE` 启动三个独立进程。

| 角色 | 职责 |
| --- | --- |
| web | 登录/session、投稿/投票、片单、SSE、分享 OG 页面、媒体状态 |
| worker | 轮次时钟、维护、账本与恢复调度 |
| codex | 内容任务、导演、H3 调度、媒体检查与发布链 |

典型流程：人类下一镜头投稿 → 评分/翻译/投票 → 轮次采用投稿 → director → video → subtitle → publish。自动下一幕仅按数据库里的开关和调度条件运行。具体依赖由 `jobs/scheduler.ts` 与 `jobs/handlers/` 定义，不能靠 agent 的对话记忆修改。

`workflow_jobs` 持久化去重、状态、重试、lease 与依赖；长任务续租。`ai_runs` 保存实际 provider/model/effort、输出及 usage。`scenes` 保存已发布内容、摘要和媒体元数据。恢复应从这些表和 H3 job 状态开始，不要仅因 UI 超时重提视频。

导演结构方案经服务端编译为 H3 prompt 和受控工作流。网关校验节点、模型、采样参数、路径及输入图摘要，再向 ComfyUI 投递。视频下载经过摘要与 ffprobe 验证；真实音频测量/ASR 形成字幕时间轴，publish 验证完整性并原子发布。不要用计划台词冒充实际识别结果。

`workstation/` 是只读素材库；内容代理不操作 PostgreSQL、ComfyUI 或发布路径。`ops/runbook.sql` 是显式运营操作入口，需要单独选定动作和目标。
