# Server Codex installation and workflow

The application depends on `@openai/codex-sdk`, while the production baseline separately pins CLI **0.153.4**. The SDK lockfile and standalone CLI are separate configuration choices; do not assume the binary bundled with the SDK supports Astra.

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

The server operator must sign in with their own account rather than copy auth.json from another machine. Device login requires the account to allow this method; see [OpenAI authentication](https://learn.chatgpt.com/docs/auth) for available methods and [OpenAI Codex CLI](https://learn.chatgpt.com/docs/codex/cli) for npm installation. These references cover installation and authentication; verify model access with your own account and canary runs.

Set the following in `/etc/crowdmovie/codex.env`:

```ini
CODEX_HOME=/var/lib/crowdmovie/codex
CODEX_EXECUTABLE_PATH=/opt/crowdmovie/tools/codex-0.153.4/node_modules/.bin/codex
CODEX_WORKSTATION_DIR=/opt/crowdmovie/workstation
```

The persistent process is a systemd content worker. Each task reads facts from PostgreSQL rather than relying on an indefinitely growing interactive session. Qwen handles primary scoring, directing, subtitles, and related tasks. Sol handles Codex paths such as episode planning and story-setting review; Astra low takes over after director failures. The complete routing is defined in `app/server/src/ai/codex.ts` and `ai/codex-story-review.ts`.

`codexClientOptions()` passes only CODEX_HOME and optional locale settings to the child process, preventing inheritance of database passwords and session secrets. It uses read-only permissions, disables shell/web/MCP and other tool capabilities, and rejects non-content output. systemd isolates `/etc/crowdmovie`. Runtime directory and file permissions must match the service account. Do not copy a development Codex configuration with full permissions into the content worker.

After building, run `node app/server/dist/ops/codex-canary.js` and `node app/server/dist/ops/codex-story-review-canary.js` with the service account and environment above. Both consume real account quota, but neither writes to the database nor generates video. Astra's compatibility with the full director schema requires director-path validation; an ordinary scoring canary is not a substitute.

Troubleshoot in this order: CLI version → login status for the same account → environment files/paths → model access → schema errors → ai_runs/provider/effort → workflow_jobs retries. Do not include auth.json, complete environment dumps, or logs containing authentication information in a PR.
