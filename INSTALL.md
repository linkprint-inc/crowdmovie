# Installation from a clean checkout

## 1. Prerequisites and build

Use Linux for production, Node.js 24+, npm, Python 3.10+, PostgreSQL 17, FFmpeg/ffprobe, Caddy 2 and rsync/ACL utilities. The GPU side needs a CUDA-compatible NVIDIA system with enough VRAM for the selected H3 full INT8 models; the reference configuration was checked on a 96 GB GPU, not qualified on smaller GPUs. Qwen may run on a separate private host.

```bash
git clone https://github.com/linkprint-inc/crowdmovie.git
cd crowdmovie
# While PR #1 is open, the complete code is on this branch:
git switch codex/initial-v1
cd app
npm ci
npm -w server run build
npm -w web run build
cd ..
```

## 2. Disposable local validation

Start an isolated PostgreSQL container. The trust authentication below is only for a disposable loopback test database; never use it for production.

```bash
docker run -d --name crowdmovie-test-db \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:55437:5432 postgres:17
# Wait until docker exec crowdmovie-test-db pg_isready -U postgres succeeds.
cd app
PGHOST=127.0.0.1 PGPORT=55437 PGUSER=postgres npm -w server test
npm -w web test
npm -w server run lint
npm -w server run typecheck
npm -w web run typecheck
npm -w server run build
npm -w web run build
cd ..
python3 -m unittest discover -s ops/fasth3 -p 'test_*.py'
python3 scripts/check-public-source.py
gitleaks git . --redact
```

Test suites automatically create a checkout-specific database. They drop/truncate test data. `TEST_DATABASE_URL` alone does not configure the admin connection; set PGHOST/PGPORT/PGUSER/PGPASSWORD too. Stop/remove the disposable container after testing.

For a local browser smoke test, create a separate application database (not the test database), run migrations and start the web API with `node --env-file=<your env path> app/server/dist/index.js`. Run `npm -w web run dev` from app/; Vite proxies the API to loopback port 3100. Workers and model services are required for actual generation.

## 3. Linux directories and service account

Install Node 24+ using your OS-approved source; verify `node --version` and update unit ExecStart if it is not `/usr/bin/node`. Install `postgresql`, `ffmpeg`, `python3-venv`, `acl`, `rsync` and Caddy with your distribution's packages.

```bash
sudo useradd --system --home /var/lib/crowdmovie --create-home --shell /usr/sbin/nologin crowdmovie
sudo install -d -m 0755 /opt/crowdmovie /etc/crowdmovie
sudo install -d -m 0750 -o crowdmovie -g crowdmovie /var/lib/crowdmovie/media
sudo rsync -a app/ /opt/crowdmovie/app/ --exclude node_modules --exclude .env
sudo rsync -a workstation/ /opt/crowdmovie/workstation/
sudo rsync -a ops/ /opt/crowdmovie/ops/
cd /opt/crowdmovie/app
sudo npm ci --omit=dev
```

Source and workstation are root-owned/read-only to the service account; state/media belong to crowdmovie. Build before copying, or install development dependencies and build on the server before pruning them.

## 4. Database roles and migrations

Create a new database and roles before running migrations, so conditional runtime grants are applied. On a new native PostgreSQL installation:

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE crowdmovie_migrate LOGIN;
CREATE ROLE crowdmovie_web LOGIN;
CREATE ROLE crowdmovie_worker LOGIN;
CREATE DATABASE crowdmovie OWNER crowdmovie_migrate;
SQL
sudo -u postgres psql
```

In the interactive psql session run `\password crowdmovie_migrate`, `\password crowdmovie_web`, `\password crowdmovie_worker`, and `\q`. Use distinct generated passwords. Keep migration connection in a root-only `/etc/crowdmovie/migrate.env` with `DATABASE_URL=postgresql://crowdmovie_migrate:<encoded password>@127.0.0.1:5432/crowdmovie`. Do not run migrations as the web/worker role.

```bash
sudo chmod 600 /etc/crowdmovie/migrate.env
sudo /usr/bin/node --env-file=/etc/crowdmovie/migrate.env \
  /opt/crowdmovie/app/server/dist/db/migrate.js
```

The codex worker uses the `crowdmovie_worker` database role. Migrations include schema and catalog seed changes; run them only against the intended application database. On upgrades take a database backup and coordinate worker downtime/compatible schema rollout before restarting new code.

## 5. Runtime environment

Use `.env.example` to create `/etc/crowdmovie/web.env`, `worker.env` and `codex.env`. Remove SERVICE_ROLE from the files; units supply it. Give web the web database role and both workers the worker database role. Use one newly generated session secret (`openssl rand -hex 32`). Set PUBLIC_ORIGIN to your HTTPS origin. Replace all example addresses, paths and passwords. Do not reuse deployment credentials from another installation.

```bash
sudo chown root:crowdmovie /etc/crowdmovie/web.env /etc/crowdmovie/worker.env /etc/crowdmovie/codex.env
sudo chmod 640 /etc/crowdmovie/web.env /etc/crowdmovie/worker.env /etc/crowdmovie/codex.env
```

Install/login the pinned CLI using [docs/CODEX.md](docs/CODEX.md), configure Qwen using [docs/DIRECTOR.md](docs/DIRECTOR.md), and start H3 using [docs/H3.md](docs/H3.md) before enabling content workers.

For real audio transcription:

```bash
sudo python3 -m venv /opt/crowdmovie-film-audio
sudo /opt/crowdmovie-film-audio/bin/pip install faster-whisper==1.2.1
sudo /opt/crowdmovie-film-audio/bin/python - <<'PYCODE'
from huggingface_hub import snapshot_download
snapshot_download('Systran/faster-whisper-small.en', local_dir='/opt/crowdmovie-film-audio/models/small.en')
PYCODE
```

The ASR script defaults to that model directory. Keep the model readable by crowdmovie and test FFmpeg/ffprobe availability; packages are not bundled in Git.

## 6. Caddy and services

The included Caddy template is a **single-host** layout: static files from `/opt/crowdmovie/app/web/dist`, media from `/var/lib/crowdmovie/media`, API/share/health to loopback 3100. Set `CROWDMOVIE_DOMAIN` in the Caddy service environment or replace its example hostname locally. Configure DNS/TLS on your own infrastructure; no public address is provided by this repository.

Only merge the site block into your existing Caddyfile; do not overwrite unrelated sites. Back it up, validate with `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, then reload. For a direct single-host connection, loopback proxy trust is sufficient. For a CDN/private proxy chain, put its verified addresses/CIDRs in the app environment variable `CROWDMOVIE_TRUSTED_PROXIES` (comma-separated, including the local Caddy hop), and configure Caddy trusted_proxies consistently in a local config. Obtain current CDN ranges from its official source; do not embed deployment addresses in Git. Never enable blanket trust.

For native Caddy, grant read/traverse ACLs without making media world-readable:

```bash
sudo setfacl -m u:caddy:--x /var/lib/crowdmovie
sudo setfacl -m u:caddy:r-x,d:u:caddy:r-x /var/lib/crowdmovie/media
sudo cp /opt/crowdmovie/ops/systemd/crowdmovie-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crowdmovie-web
curl -fsS http://127.0.0.1:3100/healthz
# After dependency/configuration validation:
sudo systemctl enable --now crowdmovie-worker crowdmovie-codex-worker
systemctl show crowdmovie-web crowdmovie-worker crowdmovie-codex-worker -p ActiveState -p NRestarts
```

If PostgreSQL is containerized, adjust unit dependencies; the included templates assume native postgresql.service. Do not enable workers on an unconfigured DB: they can create scheduled work as soon as they start.

## 7. Acceptance and operations

Read-only public checks: HTTPS root/health, a published share page and OG origin, API catalog, media Range=206, and media traversal rejection. `ACCEPTANCE_BASE_URL=https://movie.example.com npm run acceptance` (from app/) runs the scripted checks against your deployment.

A model canary proves its own content contract, not a successful H3 render. An authorized end-to-end run must additionally prove durable job transitions, output hash/duration, measured audio/subtitles and actual published playback. New installations contain no generated movie footage; empty playback until an authorized generation is expected.

For future releases preserve database/media and Codex state, drain workers, back up changed config, migrate intentionally, build both workspaces and deploy narrowly. Do not run historical reset scripts or copy private operations data into Git.
