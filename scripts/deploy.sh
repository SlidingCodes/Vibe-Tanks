#!/usr/bin/env bash
# Deploy Vibe Tanks on the Raspberry Pi.
#   - Pulls main, reinstalls deps only if lockfiles changed,
#     rebuilds the client, and restarts the server only if
#     server/ or shared/ code changed.
#   - Safe to rerun; no-ops when nothing has changed.
set -euo pipefail

REPO="/home/blin2h/projects/Vibe-Tanks"
BRANCH="main"
SERVICE="vibe-tanks.service"

cd "$REPO"

echo "==> fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "==> already up to date ($LOCAL), nothing to do"
  exit 0
fi

echo "==> updating $LOCAL -> $REMOTE"

# What changed between the two revisions?
CHANGED="$(git diff --name-only "$LOCAL" "$REMOTE")"
LOCKS_CHANGED="$(echo "$CHANGED" | grep -E '(^|/)package(-lock)?\.json$' || true)"
SERVER_CHANGED="$(echo "$CHANGED" | grep -E '^(server/|shared/)' || true)"
CLIENT_CHANGED="$(echo "$CHANGED" | grep -E '^(client/|shared/)' || true)"

git merge --ff-only "origin/$BRANCH"

if [ -n "$LOCKS_CHANGED" ]; then
  echo "==> lockfiles changed, reinstalling deps"
  npm ci
fi

if [ -n "$CLIENT_CHANGED" ]; then
  echo "==> rebuilding client"
  npm run build:client
else
  echo "==> client unchanged, skipping build"
fi

if [ -n "$SERVER_CHANGED" ] || [ -n "$LOCKS_CHANGED" ]; then
  echo "==> restarting $SERVICE"
  sudo systemctl restart "$SERVICE"
  sudo systemctl is-active "$SERVICE"
else
  echo "==> server unchanged, no restart needed"
fi

echo "==> deploy done"
