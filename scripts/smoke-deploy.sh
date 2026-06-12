#!/usr/bin/env bash
# Smoke deploy (verification stack step 8; ADR 0012): build the production
# image, boot the compose stack against a throwaway data dir + port, prove
# the artifact end-to-end, tear everything down. Run manually or from
# `pnpm smoke:deploy` — the image build is minutes-heavy, so this is not
# wired into the pre-push hook; run it when the deploy surface changes
# (Dockerfile, compose, attachSpa, boot/config seams).
#
# What it proves, in order:
#   1. /infra/health answers (container HEALTHCHECK path).
#   2. The SPA shell serves at a client route (deep link through attachSpa).
#   3. Hashed assets carry the immutable cache policy.
#   4. Genesis sign-up works (ADR 0041 audited bootstrap; first-user gate).
#   5. An authed capability round-trip: doc.create → doc.list shows it.
#   6. Reserved prefixes stay API-shaped (no HTML under /docs).
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=editorzero-smoke
PORT="${SMOKE_PORT:-3100}"
BASE="http://localhost:${PORT}"
DATA_DIR="$(mktemp -d)"
COOKIES="$(mktemp)"

export EDITORZERO_PORT="${PORT}"
export EDITORZERO_DATA_DIR="${DATA_DIR}"
export EDITORZERO_PUBLIC_ORIGIN="${BASE}"
export BETTER_AUTH_SECRET="smoke-only-$(openssl rand -hex 16)"

cleanup() {
  docker compose -p "${PROJECT}" down --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${DATA_DIR}" "${COOKIES}"
}
trap cleanup EXIT

echo "── build + up (project=${PROJECT}, port=${PORT}, data=${DATA_DIR})"
docker compose -p "${PROJECT}" up --build -d

echo "── waiting for /infra/health"
for i in $(seq 1 60); do
  if curl -fsS "${BASE}/infra/health" >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 60 ]; then
    echo "health never came up; container logs:" >&2
    docker compose -p "${PROJECT}" logs --no-color | tail -50 >&2
    exit 1
  fi
  sleep 2
done
curl -fsS "${BASE}/infra/health" | grep -q '"status":"ok"'
echo "   health ok"

echo "── SPA shell at a client route"
curl -fsS "${BASE}/login" | grep -qi "<!doctype html>"
echo "   shell ok"

echo "── hashed asset is immutable"
ASSET="$(curl -fsS "${BASE}/" | grep -o 'assets/[^"]*\.js' | head -1)"
curl -fsSI "${BASE}/${ASSET}" | grep -qi "cache-control: public, max-age=31536000, immutable"
echo "   asset cache ok (${ASSET})"

echo "── genesis sign-up (first-user gate)"
curl -fsS -c "${COOKIES}" -H "content-type: application/json" \
  -d '{"email":"smoke@editorzero.test","password":"smoke-password-123","name":"Smoke Operator"}' \
  "${BASE}/auth/sign-up/email" >/dev/null
echo "   sign-up ok"

echo "── doc.create → doc.list round-trip"
curl -fsS -b "${COOKIES}" -H "content-type: application/json" \
  -d '{"title":"Smoke deploy doc"}' "${BASE}/docs/create" >/dev/null
curl -fsS -b "${COOKIES}" "${BASE}/docs/list" | grep -q "smoke-deploy-doc"
echo "   capability round-trip ok"

echo "── reserved prefix stays API-shaped"
CT="$(curl -sS -o /dev/null -w '%{content_type}' "${BASE}/docs/no/such/route")"
case "${CT}" in
  *text/html*) echo "reserved prefix served HTML (${CT})" >&2; exit 1 ;;
esac
echo "   reserved-prefix honesty ok (${CT})"

echo "✔ smoke deploy passed"
