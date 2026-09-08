# Architecture

Browsers access Vue static pages, the Fastify API/SSE endpoints, and published media through Caddy. PostgreSQL is the source of truth for users, submissions, votes, rounds, AI runs, and job state. The same `app/server/dist/index.js` entry point runs as three separate processes, selected by `SERVICE_ROLE`.

| Role | Responsibilities |
| --- | --- |
| web | Login/sessions, submissions/voting, movie catalog, SSE, share-page OG metadata, and media status |
| worker | Round timing, maintenance, job ledger management, and recovery scheduling |
| codex | Content tasks, directing, H3 dispatch, media checks, and the publication pipeline |

The typical flow is: human next-shot submission → scoring/translation/voting → round adopts a submission → director → video → subtitle → publish. Automatic next-scene generation runs only when the database flags and scheduling conditions allow it. Dependencies are defined by `jobs/scheduler.ts` and `jobs/handlers/`; an agent's conversation memory must not override them.

`workflow_jobs` persists deduplication, state, retries, leases, and dependencies; long-running tasks renew their leases. `ai_runs` records the actual provider/model/effort, output, and usage. `scenes` stores published content, summaries, and media metadata. Start recovery from these records and the H3 job state; do not resubmit video generation merely because the UI timed out.

The server compiles the director's structured plan into an H3 prompt and a controlled workflow. The gateway validates nodes, models, sampling parameters, paths, and input-image digests before submitting to ComfyUI. Downloaded videos undergo digest and ffprobe verification. Measured audio and ASR results establish the subtitle timeline; publication validates integrity and publishes atomically. Never present planned dialogue as actual transcription.

`workstation/` is a read-only content library. Content agents do not operate PostgreSQL, ComfyUI, or publication paths. `ops/runbook.sql` provides explicit operational actions; select the intended action and target separately before using it.
