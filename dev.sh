#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-up}" == "down" ]]; then
  tmux kill-session -t systemvitals 2>/dev/null || true
  docker compose -f "$ROOT/docker-compose.yml" down
  exit 0
fi

# Bring up infra unless host already serves 5432 + 6379
if ! (echo > /dev/tcp/127.0.0.1/5432) 2>/dev/null || ! (echo > /dev/tcp/127.0.0.1/6379) 2>/dev/null; then
  docker compose -f "$ROOT/docker-compose.yml" up -d
fi

tmux new-session -d -s systemvitals -c "$ROOT/api" 'npm run start:dev'
tmux split-window -t systemvitals -h -c "$ROOT/frontend" 'npm run dev'
tmux attach -t systemvitals
