#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/vibe-tanks}"

cd "$DEPLOY_DIR"

if [ ! -f .env ]; then
  echo "==> missing $DEPLOY_DIR/.env"
  exit 1
fi

# Bail early when .env doesn't carry every image var the compose file
# references; otherwise compose silently expands them to "" and the
# pull step ends up trying to fetch a nameless image.
missing=()
for v in SERVER_IMAGE ADMIN_IMAGE WEB_IMAGE; do
  grep -Eq "^${v}=.+" .env || missing+=("$v")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "==> $DEPLOY_DIR/.env missing required vars: ${missing[*]}"
  exit 1
fi

echo "==> validating compose config"
docker compose config >/dev/null

echo "==> pulling images"
docker compose pull

echo "==> restarting containers"
docker compose up -d --wait

echo "==> live containers"
docker compose ps

echo "==> deploy done"
