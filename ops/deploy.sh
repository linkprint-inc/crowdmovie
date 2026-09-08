#!/usr/bin/env bash
#
# Deploy CrowdAIMovie to the app host.
#
#   ops/deploy.sh
#   DEPLOY_HOST=192.168.10.20 DEPLOY_USER=deploy ops/deploy.sh
#   MEDIA_READER=caddy ops/deploy.sh      # a host whose Caddy runs natively
#
# Builds server/dist locally, rsyncs the build output and the npm manifests to
# $DEPLOY_PATH, installs production dependencies there, restarts the three
# systemd units and waits for /healthz to answer 200.
#
# Why `npm ci` on the remote instead of rsyncing node_modules: the build host is
# macOS/arm64 while the target is Linux/arm64, so any dependency with
# platform-specific optional packages (argon2 arrives in M2) would be shipped as
# the wrong binary and the service would fail to start. The app host therefore
# needs npm registry access.
#
# Deliberately NOT done here:
#   * migrations -- schema changes are applied on purpose, by hand. The units'
#     own DATABASE_URL cannot do it: drizzle/0001 gives the runtime role no DDL,
#     so migrate.js run with it dies on "permission denied for database
#     crowdmovie" before touching a single table. Use the migrate role
#     (ops/systemd/README.md):
#       ssh root@192.168.10.20 'cd /opt/crowdmovie/app/server \
#         && set -a && . /etc/crowdmovie/migrate.env && set +a \
#         && DATABASE_URL="$MIGRATE_DATABASE_URL" node dist/db/migrate.js'
#     Run it right AFTER this script, not before: the restart ships code that
#     may already write the new shape, and the old schema will reject it -- a
#     few seconds of loud worker errors, which is the cheaper half of the
#     trade. Migrating first would instead break the running old code.
#   * installing or editing the systemd units -- see ops/systemd/README.md.
#
# Requires: $DEPLOY_USER can ssh to $DEPLOY_HOST and run there
# `sudo systemctl restart crowdmovie-*` without a password prompt (this script
# feeds the remote shell over stdin, so sudo cannot ask); node and npm installed
# on both ends.

set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:?Set DEPLOY_HOST to your SSH host}"
# Use an operator SSH account with the required installation privileges.
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/crowdmovie/app}"
# Who reads published media through the ACLs below. On 192.168.10.20 Caddy is
# the Docker container crowdmovie-edge running as uid 65534 with
# /var/lib/crowdmovie/media bind-mounted read-only, so the ACL principal is
# that uid; a host with a native caddy user passes MEDIA_READER=caddy. The
# host needs the acl package (setfacl); 192.168.10.20 got it on 2026-09-02.
MEDIA_READER="${MEDIA_READER:-65534}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
UNITS=(crowdmovie-web crowdmovie-worker crowdmovie-codex-worker)
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n==> %s\n' "$*"; }

cd -- "${REPO_ROOT}/app"

say "Building server/dist"
npm -w server run build
npm -w web run build
if [[ ! -f server/dist/index.js ]]; then
  echo "build produced no server/dist/index.js -- aborting" >&2
  exit 1
fi

say "Syncing to ${REMOTE}:${DEPLOY_PATH}"
ssh "$REMOTE" "mkdir -p '${DEPLOY_PATH}/server' '${DEPLOY_PATH}/web' /opt/crowdmovie/workstation"

# --delete only on directories this script owns end to end, so a stale compiled
# file can never survive a deploy.
rsync -az --delete server/dist/ "${REMOTE}:${DEPLOY_PATH}/server/dist/"
rsync -az --delete server/drizzle/ "${REMOTE}:${DEPLOY_PATH}/server/drizzle/"
rsync -az package.json package-lock.json "${REMOTE}:${DEPLOY_PATH}/"
rsync -az server/package.json "${REMOTE}:${DEPLOY_PATH}/server/"
rsync -az web/package.json "${REMOTE}:${DEPLOY_PATH}/web/"
rsync -az --delete "${REPO_ROOT}/workstation/" "${REMOTE}:/opt/crowdmovie/workstation/"

# The web workspace is built in M6. Until it produces a dist/, leave whatever is
# on the server alone -- that is the M0 placeholder page Caddy serves.
if [[ -d web/dist ]]; then
  rsync -az --delete web/dist/ "${REMOTE}:${DEPLOY_PATH}/web/dist/"
else
  say "No local web/dist -- leaving the server's copy untouched"
fi

say "Installing production dependencies and restarting units"
ssh "$REMOTE" bash -s <<REMOTE_SCRIPT
set -euo pipefail
# Published files are intentionally 0640. Give only Caddy a durable read ACL;
# default ACLs on pending/ and the final directory survive the atomic rename
# used by the publish gate. Re-applying access entries repairs restored media.
install -d -m 0755 -o crowdmovie -g crowdmovie \
  /var/lib/crowdmovie/media /var/lib/crowdmovie/media/pending
setfacl -m u:${MEDIA_READER}:--x /var/lib/crowdmovie
setfacl -m u:${MEDIA_READER}:r-x,d:u:${MEDIA_READER}:r-x \
  /var/lib/crowdmovie/media /var/lib/crowdmovie/media/pending
# Per-movie directories (media/<movie-slug>/) hold the published files.
find /var/lib/crowdmovie/media -mindepth 1 -type d \
  -exec setfacl -m u:${MEDIA_READER}:r-x,d:u:${MEDIA_READER}:r-x {} +
find /var/lib/crowdmovie/media -type f \
  -exec setfacl -m u:${MEDIA_READER}:r-- {} +
cd '${DEPLOY_PATH}'
npm ci --omit=dev
sudo systemctl restart ${UNITS[*]}
REMOTE_SCRIPT

say "Waiting for /healthz"
# curl -f exits non-zero on any non-2xx, so this loop is the 200 gate.
for _ in $(seq 1 20); do
  if ssh "$REMOTE" \
    'curl -fsS --max-time 5 http://127.0.0.1:3100/healthz && echo'; then
    say "Deploy OK"
    exit 0
  fi
  sleep 1
done

echo "healthz never returned 200 -- deploy is NOT healthy" >&2
ssh "$REMOTE" "systemctl --no-pager --lines=30 status ${UNITS[*]}" || true
exit 1
