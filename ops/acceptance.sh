#!/usr/bin/env bash
# Mechanical acceptance checks that are safe to run before a write/GPU canary.
# The public portion is strictly read-only and runs only when the caller names
# the target explicitly with ACCEPTANCE_BASE_URL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${REPO_DIR}/app"

cd "${APP_DIR}"
npm -w server run typecheck
npm -w server run lint
npm -w server test
npm -w web test
npm -w server run build
npm -w web run build

if [[ -z "${ACCEPTANCE_BASE_URL:-}" ]]; then
  echo "Local acceptance passed; public checks skipped (set ACCEPTANCE_BASE_URL)."
  exit 0
fi

BASE_URL="${ACCEPTANCE_BASE_URL%/}"

assert_status() {
  local expected_status="$1"
  local request_url="$2"
  local actual_status
  actual_status="$(curl --path-as-is --silent --show-error --output /dev/null \
    --write-out '%{http_code}' "${request_url}")"
  if [[ "${actual_status}" != "${expected_status}" ]]; then
    echo "Expected HTTP ${expected_status}, got ${actual_status}: ${request_url}" >&2
    exit 1
  fi
}

assert_header() {
  local headers="$1"
  local header_name="$2"
  local expected_value="$3"
  if ! grep -Eiq "^${header_name}:[[:space:]]*${expected_value}([[:space:]]|$)" \
    <<<"${headers}"; then
    echo "Missing or wrong ${header_name} header" >&2
    exit 1
  fi
}

health_body="$(curl --silent --show-error --fail "${BASE_URL}/healthz")"
if ! grep -Fq '"db":true' <<<"${health_body}"; then
  echo "Public health response does not report db=true" >&2
  exit 1
fi
for queue_state in pending running retrying dead; do
  if ! grep -Eq "\"${queue_state}\":[0-9]+" <<<"${health_body}"; then
    echo "Public health response is missing queue.${queue_state}" >&2
    exit 1
  fi
done

home_headers="$(curl --silent --show-error --dump-header - --output /dev/null \
  "${BASE_URL}/")"
assert_header "${home_headers}" strict-transport-security 'max-age=31536000'
assert_header "${home_headers}" x-content-type-options 'nosniff'
assert_header "${home_headers}" x-frame-options 'DENY'
assert_header "${home_headers}" referrer-policy 'strict-origin-when-cross-origin'
assert_header "${home_headers}" content-security-policy \
  "default-src 'self'; img-src 'self' data:; media-src 'self' blob: https://interactive-examples.mdn.mozilla.net; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
if ! grep -Eiq '^cache-control:.*(^|[[:space:],])no-transform([[:space:],]|$)' \
  <<<"${home_headers}"; then
  echo "HTML response is missing Cache-Control: no-transform" >&2
  exit 1
fi

for spa_route in \
  '/' \
  '/episodes' \
  '/episodes/1' \
  '/characters' \
  '/my-scripts' \
  '/hall-of-fame' \
  '/how-it-works' \
  '/contact'; do
  spa_body="$(curl --silent --show-error --fail "${BASE_URL}${spa_route}")"
  if ! grep -Fq '<div id="app"></div>' <<<"${spa_body}"; then
    echo "Public SPA shell is missing on ${spa_route}" >&2
    exit 1
  fi
done

if [[ -n "${ACCEPTANCE_SHARE_PATH:-}" ]]; then
  share_body="$(curl --silent --show-error --fail \
    "${BASE_URL}${ACCEPTANCE_SHARE_PATH}")"
  if ! grep -Fq 'property="og:video"' <<<"${share_body}" || \
     ! grep -Fq '<video controls' <<<"${share_body}"; then
    echo "Share page is missing OG video metadata or its player" >&2
    exit 1
  fi
fi

assert_status 404 "${BASE_URL}/media/"
for traversal_path in \
  '/media/../etc/passwd' \
  '/media/%2e%2e/etc/passwd' \
  '/media/.%2e/etc/passwd' \
  '/media/%2e./etc/passwd' \
  '/media/foo/../../etc/passwd'; do
  assert_status 404 "${BASE_URL}${traversal_path}"
done

media_path="${ACCEPTANCE_MEDIA_PATH:-}"
if [[ -z "${media_path}" ]]; then
  playlist_body="$(curl --silent --show-error --fail "${BASE_URL}/api/movie/playlist")"
  media_path="$(grep -Eo '"videoUrl":"/media/[^"]+\.mp4(\?v=[a-f0-9]{64})?"' <<<"${playlist_body}" \
    | head -n 1 | cut -d '"' -f 4 || true)"
fi
if [[ -n "${media_path}" ]]; then
  media_status="$(curl --silent --show-error --header 'Range: bytes=0-0' \
    --output /dev/null --write-out '%{http_code}' \
    "${BASE_URL}${media_path}")"
  if [[ "${media_status}" != "206" && "${media_status}" != "200" ]]; then
    echo "Known media did not return 200/206: ${media_path}" >&2
    exit 1
  fi
fi

echo "Local and read-only public acceptance passed for ${BASE_URL}."
