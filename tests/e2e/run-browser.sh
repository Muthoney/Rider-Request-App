#!/usr/bin/env bash
# Browser smoke test: fresh sample database, server on :3111, headless Chrome at phone and desktop widths.
#   tests/e2e/run-browser.sh            (needs Google Chrome at /usr/bin/google-chrome)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${WORK:-$(mktemp -d)}"; D="$WORK/data"; mkdir -p "$D"
[ -d "$WORK/node_modules/puppeteer-core" ] || (cd "$WORK" && npm i --silent --no-audit --no-fund puppeteer-core@24.29.1)
cp "$HERE"/*.mjs "$WORK/"
cd "$ROOT"
DATA_DIR="$D" node --no-warnings=ExperimentalWarning scripts/local.mjs provision --sample >/dev/null
node --no-warnings=ExperimentalWarning "$WORK/setup.mjs" "$ROOT" "$D" >/dev/null
DATA_DIR="$D" PORT=3111 APP_ORIGIN=http://127.0.0.1:3111 node --no-warnings=ExperimentalWarning scripts/local.mjs dev > "$WORK/server.log" 2>&1 &
SERVER=$!; trap 'kill $SERVER 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -sf http://127.0.0.1:3111/healthz >/dev/null && break; sleep 0.3; done
cd "$WORK" && node smoke.mjs http://127.0.0.1:3111 "$WORK/shots"
echo "Screenshots: $WORK/shots"
