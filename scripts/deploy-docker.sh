#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/vibe-tanks}"

cd "$DEPLOY_DIR"

if [ ! -f .env ]; then
  echo "==> missing $DEPLOY_DIR/.env"
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
