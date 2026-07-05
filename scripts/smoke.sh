#!/usr/bin/env sh
# Smoke test: boots the backend on bun:sqlite, then drives the plugin from a
# clean headless nvim. No Cloudflare, no network beyond localhost.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-8787}

PORT=$PORT bun run "$ROOT/backend/serve.ts" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 0.5

SANDBOX=$(mktemp -d)
XDG_DATA_HOME="$SANDBOX/data" XDG_STATE_HOME="$SANDBOX/state" \
  FRIENDS_URL="http://127.0.0.1:$PORT/api" \
  FRIENDS_HEARTBEAT_INTERVAL=1 \
  nvim --clean --headless \
  --cmd "set rtp+=$ROOT" \
  --cmd "let g:friends_autostart = v:false" \
  -l "$ROOT/scripts/smoke.lua"
