#!/usr/bin/env bash
# Deploy Vibe Tanks on the Raspberry Pi.
#   - Pulls main, reinstalls deps only if lockfiles changed,
#     always rebuilds the client and restarts the server.
#   - Safe to rerun.
set -euo pipefail

REPO="/home/blin2h/deploy/Vibe-Tanks"
BRANCH="main"
SERVICE="vibe-tanks.service"
ADMIN_SERVICE="vibe-tanks-admin.service"

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

# The admin sidecar runs on its own systemd unit; the file ships with
# the repo (scripts/vibe-tanks-admin.service) but installing it into
# /etc/systemd/system + the secrets drop-in is a one-time manual step
# (see scripts/README or CLAUDE.md). Restart only when present so the
# game deploy keeps working until the operator wires it up.
if systemctl list-unit-files --no-legend "$ADMIN_SERVICE" | grep -q "$ADMIN_SERVICE"; then
  echo "==> restarting $ADMIN_SERVICE"
  sudo systemctl restart "$ADMIN_SERVICE"
  sudo systemctl is-active "$ADMIN_SERVICE"
else
  echo "==> $ADMIN_SERVICE not installed yet; skipping (one-time setup needed)"
fi

echo "==> deploy done"
