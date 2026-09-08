# Qwen3.8 director workflow

## API configuration

The primary path uses Qwen3.8-27B through an OpenAI-compatible `/v1/chat/completions` endpoint. The `QWEN_COPYRIGHT_FALLBACK_*` variables retain their historical names but now configure the primary path as well; Qwen is not restricted to fallback use. The configuration schema currently fixes the model name to `qwen3.8-27b-huihui-abliterated-nvfp4`. A self-hosted endpoint must expose that served-model-name.

The endpoint must support text/image messages, `response_format` JSON Schema, `chat_template_kwargs.enable_thinking=false`, usage reporting, and `choices[0].message.content`. The client identifies tasks with `x-qwen-user: crowdmovie:<job key>`, allows at most three concurrent requests, and defaults to a 300-second timeout. If an existing gateway has four slots, one can remain available to other users. This client has no API-key configuration; access authenticated endpoints through a private, controlled proxy rather than embedding a token in a repository URL.

An existing vLLM service can provide the compatible API. When deploying your own inference service, choose a runtime that supports this NVFP4 model and your GPU, configure the model alias and JSON Schema support, and verify the actual protocol with the canaries below. This repository includes the client and reusable director workflow, but not Qwen weights or the source of a separate inference gateway.

## Current director pipeline

1. The backend reads the accepted submission, current episode, character/location definitions, published structured state, and the previous segment's tail-frame information.
2. `directScene()` in `ai/codex.ts` inlines `workstation/movie/director-brief-v3.md` and requests a scene-director-v2 / film-plan-v1 structured plan. The legacy v5 workflow still uses the archived v2 brief.
3. Qwen generates concrete, causally connected action shots lasting 5–15 seconds. The plan records character state, actions, shots, entrances/exits, and consequences. The backend compiles Shot/Picture markers, cut times, dialogue blocks, and the node graph.
4. Qwen's model-based plan review remains enabled. Deterministic code checks structure, identity, duration, workflow, files, and publication integrity only. Do not restore removed hard-coded creative checks for plot repetition, injury continuity, shot style, or similar judgments.
5. Qwen gets at most two director attempts. After both fail, an independent Codex thread using `gpt-6-astra` / `low` takes over through the same mapping and validation pipeline. Astra's internal attempt limit is `CODEX_OUTPUT_RETRIES + 1`, which defaults to three attempts. If all attempts fail, control returns to the persistent job retry policy; the providers do not alternate indefinitely.
6. `openAiOutputSchema()` adapts the outbound OpenAI schema by removing incompatible object-valued const constraints. Local validation retains the original schema. Audit records capture the actual provider and effort.
7. Generation is submitted only after H3 gateway validation succeeds. The backend then handles video checks, subtitles based on measured audio, publication, and the next round.

The current primary style and character guidance live in `workstation/movie/style-bible.md`, the director skill, and the v3 brief. When changing director behavior, review these together with `ai/film-plan.ts`, `ai/validate.ts`, and `ai/wire-schemas.ts`. The v6 capabilities in the code define the current primary path; older JSON files remain for compatibility.

## Protocol validation without GPU generation

After building from the repository root, configure the Qwen/H3 addresses and `CODEX_WORKSTATION_DIR`, then run `node app/server/dist/ops/codex-director-canary.js` or `node app/server/dist/ops/qwen-fallback-canary.js`. These canaries make real model calls and consume quota, while the gateway performs validation only. Check that the output reports `generationSubmitted=false`, `databaseWrites=false`, and `gpuRequested=false`. A canary using a legacy schema fixture proves only its declared path; the current v6 path is covered by tests including `film-director-engine.test.ts`.
