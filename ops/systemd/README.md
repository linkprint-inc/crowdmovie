# Linux services

Use the complete bootstrap sequence in [INSTALL.md](../../INSTALL.md), then [Codex setup](../../docs/CODEX.md) and [H3 setup](../../docs/H3.md). These templates assume Node at /usr/bin/node; change ExecStart if Node is installed elsewhere.

All three units use /opt/crowdmovie/app/server/dist/index.js. Put their separate DB credentials and a common session secret in /etc/crowdmovie/web.env, worker.env and codex.env (root:crowdmovie, mode 0640). Do not put SERVICE_ROLE in those files: each unit sets its own role, and EnvironmentFile values take precedence if duplicated. Keep migration credentials in a separate root-only migrate.env; never use runtime roles for schema changes.

Copy units, run systemctl daemon-reload, then start web. Enable workers only after migrations, Qwen/Codex and H3 are ready. Check systemctl show with ActiveState/NRestarts, /healthz, job state and ai_runs. A service being active alone does not prove generation.

For upgrades, build both workspaces, drain/stop workers, take a backup, apply compatible migrations, deploy and resume. ops/deploy.sh is a transport/restart helper; it does not create users, install dependencies such as FFmpeg/ASR, provision a database or migrate it. Coordinate migrations before restarting code that requires them.
