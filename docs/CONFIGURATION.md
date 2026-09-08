# Configuration

All validated app keys are listed below; exact types, bounds and defaults are in `app/server/src/config.ts`. Values are read from the process environment at startup. `.env.example` provides the main setup.

- `SERVICE_ROLE`
- `DATABASE_URL`
- `SESSION_SECRET`
- `PORT`
- `HOST`
- `LOG_LEVEL`
- `MEDIA_DIR`
- `OUTBOX_PATH`
- `JOB_LEASE_MS`
- `JOB_POLL_INTERVAL_MS`
- `JOB_BACKOFF_BASE_MS`
- `JOB_MAX_ATTEMPTS`
- `ROUND_LENGTH_MS`
- `FINAL_TOP_K`
- `VOTE_ADOPT_THRESHOLD`
- `CODEX_SCORE_MODEL`
- `CODEX_MODEL`
- `CODEX_WORKSTATION_DIR`
- `CODEX_SCORE_REASONING_EFFORT`
- `CODEX_FINAL_REASONING_EFFORT`
- `CODEX_DIRECTOR_REASONING_EFFORT`
- `CODEX_OUTPUT_RETRIES`
- `CODEX_TURN_TIMEOUT_SECONDS`
- `QWEN_COPYRIGHT_FALLBACK_BASE_URL`
- `QWEN_COPYRIGHT_FALLBACK_MODEL`
- `QWEN_COPYRIGHT_FALLBACK_TIMEOUT_MS`
- `QWEN_MAX_CONCURRENCY`

Additional directly read variables: `CROWDMOVIE_TRUSTED_PROXIES` (comma-separated ingress addresses/CIDRs; loopback default), `PUBLIC_ORIGIN` (share metadata; set to your HTTPS origin), `CODEX_HOME`, `CODEX_EXECUTABLE_PATH`, `CROWDMOVIE_ASR_PYTHON`, `CROWDMOVIE_ASR_SCRIPT`. Caddy uses `CROWDMOVIE_DOMAIN`; it must be set in the Caddy service environment, separately from the app environment. Gateway variables are documented in docs/H3.md and ops/fasth3/fasth3_gateway.py.

Generate SESSION_SECRET with openssl rand -hex 32. Give each runtime role its own DATABASE_URL, and use one common session secret. Percent-encode special characters in database URL passwords. Never commit the resulting files.
