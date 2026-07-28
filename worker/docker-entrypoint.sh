#!/bin/sh
set -eu

prisma=/app/database/node_modules/.bin/prisma
schema=/app/database/prisma/schema.prisma
retry_window=${MIGRATION_RETRY_WINDOW_SECONDS:-1800}
retry_base=${MIGRATION_RETRY_BASE_SECONDS:-2}
retry_max=${MIGRATION_RETRY_MAX_SECONDS:-30}
readiness_path=${WORKER_READINESS_PATH:-/tmp/systemvitals-worker-ready}
migration_pid=
backoff_pid=
received_signal=
signal_status=

require_positive_integer() {
  name=$1
  value=$2
  case "$value" in
    ''|*[!0-9]*)
      echo "$name must be a positive integer" >&2
      exit 64
      ;;
  esac
  if [ "$value" -eq 0 ]; then
    echo "$name must be a positive integer" >&2
    exit 64
  fi
}

forward_signal() {
  received_signal=$1
  signal_status=$2
  if [ -n "$migration_pid" ]; then
    kill -s "$received_signal" "$migration_pid" 2>/dev/null || true
  fi
  if [ -n "$backoff_pid" ]; then
    kill -s "$received_signal" "$backoff_pid" 2>/dev/null || true
  fi
}

exit_if_signaled() {
  if [ -z "$received_signal" ]; then
    return
  fi
  if [ -n "$migration_pid" ]; then
    wait "$migration_pid" 2>/dev/null || true
  fi
  if [ -n "$backoff_pid" ]; then
    wait "$backoff_pid" 2>/dev/null || true
  fi
  exit "$signal_status"
}

require_positive_integer MIGRATION_RETRY_WINDOW_SECONDS "$retry_window"
require_positive_integer MIGRATION_RETRY_BASE_SECONDS "$retry_base"
require_positive_integer MIGRATION_RETRY_MAX_SECONDS "$retry_max"

trap 'forward_signal TERM 143' TERM
trap 'forward_signal INT 130' INT
trap 'forward_signal HUP 129' HUP

rm -f "$readiness_path"
migration_output=$(mktemp "${TMPDIR:-/tmp}/systemvitals-migrate.XXXXXX")
cleanup() {
  rm -f "$migration_output"
}
trap cleanup 0

started_at=$(date +%s)
attempt=1
retry_delay=$retry_base
if [ "$retry_delay" -gt "$retry_max" ]; then
  retry_delay=$retry_max
fi

while :; do
  if [ "$attempt" -gt 1 ]; then
    now=$(date +%s)
    elapsed=$((now - started_at))
    if [ "$elapsed" -ge "$retry_window" ]; then
      echo "Migration advisory lock retry window exhausted after ${elapsed}s." >&2
      exit "$migration_status"
    fi
  fi

  : >"$migration_output"
  "$prisma" migrate deploy --schema="$schema" >"$migration_output" 2>&1 &
  migration_pid=$!
  if wait "$migration_pid"; then
    migration_status=0
  else
    migration_status=$?
  fi
  exit_if_signaled
  migration_pid=

  if [ "$migration_status" -eq 0 ]; then
    break
  fi

  if ! grep -Eq '(^|[^[:alnum:]])P1002([^[:alnum:]]|$)' "$migration_output" ||
    ! grep -Fq 'Timed out trying to acquire a postgres advisory lock' "$migration_output"; then
    echo "Database migration failed with status $migration_status; not retrying." >&2
    exit "$migration_status"
  fi

  now=$(date +%s)
  elapsed=$((now - started_at))
  if [ "$elapsed" -ge "$retry_window" ]; then
    echo "Migration advisory lock retry window exhausted after ${elapsed}s." >&2
    exit "$migration_status"
  fi

  half_delay=$((retry_delay / 2))
  jitter_span=$((retry_delay - half_delay + 1))
  sleep_for=$((half_delay + (now + attempt + $$) % jitter_span))
  if [ "$sleep_for" -lt 1 ]; then
    sleep_for=1
  fi
  remaining=$((retry_window - elapsed))
  if [ "$sleep_for" -gt "$remaining" ]; then
    sleep_for=$remaining
  fi

  echo "Migration advisory lock is busy; retrying in ${sleep_for}s." >&2
  sleep "$sleep_for" &
  backoff_pid=$!
  wait "$backoff_pid" 2>/dev/null || true
  exit_if_signaled
  backoff_pid=

  if [ "$retry_delay" -lt "$retry_max" ]; then
    retry_delay=$((retry_delay * 2))
    if [ "$retry_delay" -gt "$retry_max" ]; then
      retry_delay=$retry_max
    fi
  fi
  attempt=$((attempt + 1))
done

exit_if_signaled
cleanup
trap - 0
exec "$@"
