#!/usr/bin/env bash
# Deploy Vibe Tanks on the Raspberry Pi.
#   - Pulls main, reinstalls deps only if lockfiles changed,
#     always rebuilds the client and restarts the server.
#   - Safe to rerun.
set -euo pipefail

REPO="/home/blin2h/deploy/Vibe-Tanks"
BRANCH="main"
SERVICE="vibe-tanks.service"

cd "$REPO"

echo "==> fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "==> updating $LOCAL -> $REMOTE"
  CHANGED="$(git diff --name-only "$LOCAL" "$REMOTE")"
  LOCKS_CHANGED="$(echo "$CHANGED" | grep -E '(^|/)package(-lock)?\.json$' || true)"
  git merge --ff-only "origin/$BRANCH"

  if [ -n "$LOCKS_CHANGED" ]; then
    echo "==> lockfiles changed, reinstalling deps"
    npm ci
  fi
else
  echo "==> already at $LOCAL, no pull needed"
fi

echo "==> rebuilding client"
npm run build:client

echo "==> restarting $SERVICE"
sudo systemctl restart "$SERVICE"
sudo systemctl is-active "$SERVICE"

echo "==> deploy done"
