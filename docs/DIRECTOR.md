# Qwen3.8 director workflow

## 接口配置

主路径是 Qwen3.8-27B，OpenAI-compatible `/v1/chat/completions`。变量 `QWEN_COPYRIGHT_FALLBACK_*` 是历史命名，如今也配置主路径；不是要求 Qwen 仅用于回退。模型名称当前被配置 schema 固定为 `qwen3.8-27b-huihui-abliterated-nvfp4`，自托管端点应使用该 served-model-name。

必须支持文本/图像 messages、`response_format` JSON Schema、`chat_template_kwargs.enable_thinking=false`、usage 和 `choices[0].message.content`。客户端使用 `x-qwen-user: crowdmovie:<job key>` 隔离任务，最多三个并发请求，300 秒默认超时；若已有四槽网关，可为其他使用者保留一槽。该客户端没有读取 API key 的配置；需认证的端点应通过私有受控代理接入，不能把 token 塞到仓库 URL。

可用已有 vLLM 服务提供兼容接口。部署自己的推理服务时，选择支持该 NVFP4 模型和所用 GPU 的运行时，配置模型别名与 JSON Schema；先用下述 canary 验证实际协议。此仓库包含客户端及可复用导演流程，不包含 Qwen 权重或另一套推理网关源代码。

## 当前导演流水线

1. 后端读取已接受的投稿、当前剧集、人物/场景设定、已发布结构化状态和上一段尾帧信息。
2. `ai/codex.ts` 的 `directScene()` 内联 `workstation/movie/director-brief-v3.md`，请求 scene-director-v2 / film-plan-v1 结构方案。旧 v5 工作流仍使用归档 v2 brief。
3. Qwen 生成具体的 5–15 秒因果动作镜头。方案记录人物状态、动作、镜头、进出场与后果；后端编译 Shot/Picture 标记、切镜时间、对话块和节点图。
4. 保留 Qwen 模型方案复审。确定性代码仅校验结构、身份、时长、工作流、文件和发布完整性；不恢复已移除的剧情重复、伤势继承、镜头风格等硬编码创作审查。
5. 导演 Qwen 最多尝试两次。两次失败后启动独立 `gpt-6-astra` / `low` Codex thread，以同一映射和验证管线接手。Astra 的内部尝试上限为 `CODEX_OUTPUT_RETRIES + 1`，默认三次。全部失败后交回持久作业重试策略，不无限来回切换。
6. OpenAI 出站 schema 通过 `openAiOutputSchema()` 适配，移除不兼容的 object-valued const；本地保留原始 schema 校验。审计记录实际提供方及 effort。
7. H3 网关 validation 成功后才提交生成；随后视频检查、实测音频字幕、发布与下一轮由后端完成。

当前主风格与人物指导在 `workstation/movie/style-bible.md`、导演技能和 v3 brief。修改导演行为时同时核对这些文件及 `ai/film-plan.ts`、`ai/validate.ts`、`ai/wire-schemas.ts`。代码里 v6 能力是当前主路径，旧版 JSON 保留用于兼容。

## 无 GPU 协议验证

从仓库根目录构建后，设置 Qwen/H3 地址及 CODEX_WORKSTATION_DIR，再运行 `node app/server/dist/ops/codex-director-canary.js` 或 `node app/server/dist/ops/qwen-fallback-canary.js`。它们会实际调用模型并消耗额度，网关只做 validation；检查输出中的 `generationSubmitted=false`、`databaseWrites=false`、`gpuRequested=false`。具体 canary 若有旧版 schema 夹具，仅证明其声明的路径；当前 v6 由 `film-director-engine.test.ts` 等覆盖。
