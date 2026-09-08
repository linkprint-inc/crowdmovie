# Codex takeover

Read README.md, INSTALL.md, docs/ARCHITECTURE.md, docs/DIRECTOR.md, docs/CODEX.md and docs/H3.md before changing runtime behavior. This is an independent initial snapshot; there is no previous deployment context to recover.

- Work from this checkout. Do not search for or reuse another operator's credentials, IP addresses, auth.json, databases or generated media.
- Install Node.js 24+, Python 3.10+, FFmpeg/ffprobe and PostgreSQL. Run npm ci in app/. All npm workspace commands run from app/.
- Copy .env.example to an ignored .env and replace every deployment-specific placeholder. The Node application does not implicitly load dotenv; use node --env-file or systemd EnvironmentFile.
- Unit/integration tests create and truncate a disposable database. Use a dedicated test PostgreSQL service and PGHOST/PGPORT/PGUSER/PGPASSWORD. Never point tests at production.
- Verify server/web tests, server lint, both typechecks/builds, Python gateway tests and scripts/check-public-source.py. CI contains the executable sequence.
- Preserve Qwen director maximum two attempts, then gpt-6-astra low. Preserve JSON, identity, workflow, duration, path and publication checks. Creative guidance belongs in prompts; do not restore removed deterministic story judges.
- Runtime content agents are pure content functions; the application owns DB transitions, H3 dispatch and publication. Do not give runtime Codex CLI the worker's full environment.
- H3 settings are full INT8, PDD Acc 8 steps, Euler, CFG 1, 1344x768, 24 fps, 5-15 seconds, no external LoRA or Motion Context. Read current gateway capabilities before compatibility work.
- Real model canaries use account quota; generation and release operations mutate durable state. Run those only within the user's authorization and on explicitly selected environments.
- Keep all auth, environment files, model binaries, logs and media outside Git. Use example domains and example LAN addresses in documentation.
- Review the narrow diff and protect unrelated changes. Report actual checks and gaps; health checks alone do not prove video generation.
