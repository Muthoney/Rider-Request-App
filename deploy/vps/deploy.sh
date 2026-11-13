#!/usr/bin/env bash
# Deploy the committed code (HEAD) to the VPS. Run from your computer:
#   deploy/vps/deploy.sh               run tests, back up, build, switch over, health-check, roll back on failure
#   deploy/vps/deploy.sh --skip-tests
# Settings come from deploy/vps/target.env (git-ignored), e.g.
#   DEPLOY_HOST=deploy@203.0.113.10
#   DOMAIN=ride-request.lookmedia.co.ke
#   SSH_KEY=~/.ssh/lookmedia_vps
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE=deploy/vps
[ -f "$HERE/target.env" ] && . "$HERE/target.env"
: "${DEPLOY_HOST:?Set DEPLOY_HOST in deploy/vps/target.env (e.g. deploy@203.0.113.10)}"
DOMAIN=${DOMAIN:-ride-request.lookmedia.co.ke}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/lookmedia_vps}
SSH=(ssh -i "${SSH_KEY/#\~/$HOME}" -o IdentitiesOnly=yes "$DEPLOY_HOST")

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Note: uncommitted changes are NOT deployed; only the last commit is."
fi
SHA=$(git rev-parse --short=12 HEAD)

if [ "${1:-}" != "--skip-tests" ]; then
  echo "==> Tests"
  npm test --silent
fi

echo "==> Uploading $SHA"
git archive --format=tar HEAD | "${SSH[@]}" "rm -rf /opt/rider-requests/src && mkdir -p /opt/rider-requests/src && tar -x -C /opt/rider-requests/src"

echo "==> Building and switching over on the server"
"${SSH[@]}" bash -s -- "$SHA" "$DOMAIN" <<'REMOTE'
set -euo pipefail
SHA=$1 DOMAIN=$2
cd /opt/rider-requests
cp src/deploy/vps/compose.yml src/deploy/vps/Caddyfile .

if [ ! -f app.env ]; then
  sed -E '/^(APP_ORIGIN|COOKIE_SECURE|TRUST_PROXY)=/d' src/.env.example > app.env
  chmod 600 app.env
  echo "   Created app.env from .env.example (add API keys there later; the app runs without them)."
fi

docker build -q -f src/deploy/Dockerfile -t "rider-requests:$SHA" src >/dev/null

PREV=$(sed -n 's/^APP_TAG=//p' .env 2>/dev/null || true)
if docker ps --format '{{.Names}}' | grep -qx rider-requests; then
  echo "   Backing up the database first"
  docker exec rider-requests node --no-warnings=ExperimentalWarning server/backup.mjs
fi

printf 'DOMAIN=%s\nAPP_TAG=%s\n' "$DOMAIN" "$SHA" > .env
docker compose up -d --remove-orphans

echo -n "   Waiting for the app to be healthy"
status=starting
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' rider-requests 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  echo -n .; sleep 3
done
echo " $status"

if [ "$status" != healthy ]; then
  docker logs --tail 40 rider-requests || true
  if [ -n "$PREV" ] && [ "$PREV" != "$SHA" ]; then
    echo "!! New version is not healthy. Rolling back to $PREV"
    printf 'DOMAIN=%s\nAPP_TAG=%s\n' "$DOMAIN" "$PREV" > .env
    docker compose up -d
  fi
  exit 1
fi

# Keep the three newest app images for rollback.
docker images rider-requests --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' | sort -r | tail -n +4 | cut -f2 \
  | xargs -r docker rmi >/dev/null 2>&1 || true
REMOTE

echo "==> Checking https://$DOMAIN/healthz"
if curl -fsS --max-time 15 "https://$DOMAIN/healthz" >/dev/null; then
  echo "Deployed $SHA to https://$DOMAIN"
else
  echo "The app is running on the server, but https://$DOMAIN is not reachable yet."
  echo "Check that the DNS A record points to the server (the HTTPS certificate is issued after that)."
fi
