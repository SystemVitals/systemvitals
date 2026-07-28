#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_root=$(mktemp -d)
test_containers=()
test_networks=()

cleanup_test() {
  local container
  local network
  for container in "${test_containers[@]}"; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  for network in "${test_networks[@]}"; do
    docker network rm "$network" >/dev/null 2>&1 || true
  done
  rm -rf "$test_root"
}
trap cleanup_test EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -Fq -- "$expected" "$file" ||
    fail "$file does not contain: $expected"
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  if grep -Fq -- "$unexpected" "$file"; then
    fail "$file unexpectedly contains: $unexpected"
  fi
}

assert_entrypoint_behavior() {
  local service=$1
  local source="$repo_root/$service/docker-entrypoint.sh"
  local sandbox="$test_root/$service"
  local app_root="$sandbox/app"
  local prisma="$app_root/database/node_modules/.bin/prisma"
  local command="$sandbox/fake-command"
  local runnable="$sandbox/docker-entrypoint.sh"
  local secret="postgresql://secret-user:secret-password@database/systemvitals"
  local attempts_file="$sandbox/prisma-attempts"

  [[ -f "$source" ]] || fail "$source is missing"
  [[ -x "$source" ]] || fail "$source is not executable"
  assert_contains "$source" "#!/bin/sh"
  assert_contains "$source" "set -eu"
  assert_contains "$source" "prisma=/app/database/node_modules/.bin/prisma"
  assert_contains "$source" "schema=/app/database/prisma/schema.prisma"
  assert_contains "$source" "\"\$prisma\" migrate deploy --schema=\"\$schema\""
  assert_contains "$source" 'exec "$@"'
  assert_not_contains "$source" "set -x"

  mkdir -p "$(dirname "$prisma")"
  sed "s#/app#$app_root#g" "$source" >"$runnable"
  chmod 755 "$runnable"

  cat >"$prisma" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >"$PRISMA_ARGS_FILE"
attempt=1
if [ -f "$PRISMA_ATTEMPTS_FILE" ]; then
  attempt=$(( $(cat "$PRISMA_ATTEMPTS_FILE") + 1 ))
fi
printf '%s\n' "$attempt" >"$PRISMA_ATTEMPTS_FILE"

if [ -n "${ASSERT_PATH_ABSENT:-}" ] && [ -e "$ASSERT_PATH_ABSENT" ]; then
  echo "stale readiness marker was present" >&2
  exit 24
fi

case "${PRISMA_MODE:-success}" in
  success)
    exit 0
    ;;
  fail)
    echo "migration failed for $DATABASE_URL" >&2
    exit 23
    ;;
  lock-then-success)
    if [ "$attempt" -lt 3 ]; then
      echo "Error: P1002" >&2
      echo "Context: Timed out trying to acquire a postgres advisory lock for $DATABASE_URL" >&2
      exit 1
    fi
    exit 0
    ;;
  lock-always)
    echo "Error: P1002" >&2
    echo "Context: Timed out trying to acquire a postgres advisory lock for $DATABASE_URL" >&2
    exit 1
    ;;
  generic-p1002)
    echo "Error: P1002" >&2
    echo "The database server at $DATABASE_URL was reached but timed out." >&2
    exit 1
    ;;
  block)
    printf '%s\n' "$$" >"$PRISMA_PID_FILE"
    trap 'printf "TERM\n" >"$PRISMA_SIGNAL_FILE"; exit 42' TERM
    trap 'printf "INT\n" >"$PRISMA_SIGNAL_FILE"; exit 43' INT
    trap 'printf "HUP\n" >"$PRISMA_SIGNAL_FILE"; exit 44' HUP
    while :; do
      sleep 1 &
      wait "$!" || true
    done
    ;;
  concurrent)
    if mkdir "$PRISMA_LOCK_DIR" 2>/dev/null; then
      trap 'rmdir "$PRISMA_LOCK_DIR" 2>/dev/null || true; exit 42' TERM INT HUP
      printf '%s\n' "$$" >"$PRISMA_HOLDER_READY_FILE"
      while [ -e "$PRISMA_HOLD_FILE" ]; do
        sleep 0.05
      done
      rmdir "$PRISMA_LOCK_DIR"
      exit 0
    fi
    echo "Error: P1002" >&2
    echo "Context: Timed out trying to acquire a postgres advisory lock" >&2
    exit 1
    ;;
  *)
    echo "unknown fake Prisma mode" >&2
    exit 99
    ;;
esac
EOF
  chmod 755 "$prisma"

  cat >"$command" <<'EOF'
#!/bin/sh
printf '%s\n' "$$" >"$APP_PID_FILE"
printf '<%s>\n' "$@" >"$APP_ARGS_FILE"
trap 'printf "TERM\n" >"$APP_SIGNAL_FILE"; exit 42' TERM
if [ "${APP_BLOCK:-0}" = "1" ]; then
  while :; do
    sleep 1 &
    wait "$!" || true
  done
fi
EOF
  chmod 755 "$command"

  local failure_output="$sandbox/failure-output"
  set +e
  DATABASE_URL="$secret" \
    PRISMA_MODE=fail \
    PRISMA_ATTEMPTS_FILE="$attempts_file" \
    PRISMA_ARGS_FILE="$sandbox/prisma-failure-args" \
    APP_PID_FILE="$sandbox/app-failure-pid" \
    APP_ARGS_FILE="$sandbox/app-failure-args" \
    APP_SIGNAL_FILE="$sandbox/app-failure-signal" \
    "$runnable" "$command" should-not-run >"$failure_output" 2>&1
  local failure_status=$?
  set -e

  [[ "$failure_status" -eq 23 ]] ||
    fail "$service entrypoint returned $failure_status after migration failure"
  [[ ! -e "$sandbox/app-failure-pid" ]] ||
    fail "$service started the application after migration failure"
  [[ "$(cat "$attempts_file")" -eq 1 ]] ||
    fail "$service retried a non-lock migration failure"
  assert_not_contains "$failure_output" "$secret"
  diff -u <(printf '%s\n' migrate deploy "--schema=$app_root/database/prisma/schema.prisma") \
    "$sandbox/prisma-failure-args"

  local success_output="$sandbox/success-output"
  DATABASE_URL="$secret" \
    PRISMA_ATTEMPTS_FILE="$sandbox/prisma-success-attempts" \
    PRISMA_ARGS_FILE="$sandbox/prisma-success-args" \
    APP_PID_FILE="$sandbox/app-success-pid" \
    APP_ARGS_FILE="$sandbox/app-success-args" \
    APP_SIGNAL_FILE="$sandbox/app-success-signal" \
    "$runnable" "$command" "argument with spaces" "--literal=*" \
    >"$success_output" 2>&1

  diff -u <(printf '%s\n' '<argument with spaces>' '<--literal=*>') \
    "$sandbox/app-success-args"
  assert_not_contains "$success_output" "$secret"

  local generic_output="$sandbox/generic-p1002-output"
  set +e
  DATABASE_URL="$secret" \
    PRISMA_MODE=generic-p1002 \
    PRISMA_ATTEMPTS_FILE="$sandbox/prisma-generic-attempts" \
    PRISMA_ARGS_FILE="$sandbox/prisma-generic-args" \
    APP_PID_FILE="$sandbox/app-generic-pid" \
    APP_ARGS_FILE="$sandbox/app-generic-args" \
    APP_SIGNAL_FILE="$sandbox/app-generic-signal" \
    "$runnable" "$command" should-not-run >"$generic_output" 2>&1
  local generic_status=$?
  set -e

  [[ "$generic_status" -eq 1 ]] ||
    fail "$service changed the generic P1002 exit status"
  [[ "$(cat "$sandbox/prisma-generic-attempts")" -eq 1 ]] ||
    fail "$service retried generic P1002 without advisory-lock context"
  [[ ! -e "$sandbox/app-generic-pid" ]] ||
    fail "$service started after generic P1002"
  assert_not_contains "$generic_output" "$secret"

  local retry_output="$sandbox/retry-output"
  DATABASE_URL="$secret" \
    MIGRATION_RETRY_BASE_SECONDS=1 \
    MIGRATION_RETRY_MAX_SECONDS=1 \
    MIGRATION_RETRY_WINDOW_SECONDS=30 \
    PRISMA_MODE=lock-then-success \
    PRISMA_ATTEMPTS_FILE="$sandbox/prisma-retry-attempts" \
    PRISMA_ARGS_FILE="$sandbox/prisma-retry-args" \
    APP_PID_FILE="$sandbox/app-retry-pid" \
    APP_ARGS_FILE="$sandbox/app-retry-args" \
    APP_SIGNAL_FILE="$sandbox/app-retry-signal" \
    "$runnable" "$command" retry-succeeded >"$retry_output" 2>&1

  [[ "$(cat "$sandbox/prisma-retry-attempts")" -eq 3 ]] ||
    fail "$service did not retry recognized advisory-lock timeouts"
  assert_contains "$sandbox/app-retry-args" "<retry-succeeded>"
  assert_contains "$retry_output" "Migration advisory lock is busy"
  assert_not_contains "$retry_output" "$secret"

  local migration_signal_output="$sandbox/migration-signal-output"
  DATABASE_URL="$secret" \
    PRISMA_MODE=block \
    PRISMA_ATTEMPTS_FILE="$sandbox/prisma-block-attempts" \
    PRISMA_ARGS_FILE="$sandbox/prisma-block-args" \
    PRISMA_PID_FILE="$sandbox/prisma-block-pid" \
    PRISMA_SIGNAL_FILE="$sandbox/prisma-block-signal" \
    APP_PID_FILE="$sandbox/app-block-pid" \
    APP_ARGS_FILE="$sandbox/app-block-args" \
    APP_SIGNAL_FILE="$sandbox/app-block-signal" \
    "$runnable" "$command" should-not-run >"$migration_signal_output" 2>&1 &
  local migration_entrypoint_pid=$!

  for _ in {1..100}; do
    [[ -s "$sandbox/prisma-block-pid" ]] && break
    sleep 0.02
  done
  [[ -s "$sandbox/prisma-block-pid" ]] ||
    fail "$service migration did not block for the signal test"
  kill -TERM "$migration_entrypoint_pid"
  set +e
  wait "$migration_entrypoint_pid"
  local migration_signal_status=$?
  set -e

  [[ "$migration_signal_status" -eq 143 ]] ||
    fail "$service entrypoint returned $migration_signal_status after migration SIGTERM"
  assert_contains "$sandbox/prisma-block-signal" "TERM"
  [[ ! -e "$sandbox/app-block-pid" ]] ||
    fail "$service started the application after migration SIGTERM"
  assert_not_contains "$migration_signal_output" "$secret"

  local signal_output="$sandbox/signal-output"
  DATABASE_URL="$secret" \
    APP_BLOCK=1 \
    PRISMA_ATTEMPTS_FILE="$sandbox/prisma-signal-attempts" \
    PRISMA_ARGS_FILE="$sandbox/prisma-signal-args" \
    APP_PID_FILE="$sandbox/app-signal-pid" \
    APP_ARGS_FILE="$sandbox/app-signal-args" \
    APP_SIGNAL_FILE="$sandbox/app-signal" \
    "$runnable" "$command" wait-for-signal >"$signal_output" 2>&1 &
  local entrypoint_pid=$!

  for _ in {1..100}; do
    [[ -s "$sandbox/app-signal-pid" ]] && break
    sleep 0.02
  done
  [[ -s "$sandbox/app-signal-pid" ]] ||
    fail "$service application did not start for the signal test"
  [[ "$(cat "$sandbox/app-signal-pid")" = "$entrypoint_pid" ]] ||
    fail "$service entrypoint did not exec the application as PID $entrypoint_pid"

  kill -TERM "$entrypoint_pid"
  set +e
  wait "$entrypoint_pid"
  local signal_status=$?
  set -e

  [[ "$signal_status" -eq 42 ]] ||
    fail "$service application did not handle SIGTERM (status $signal_status)"
  assert_contains "$sandbox/app-signal" "TERM"
  assert_not_contains "$signal_output" "$secret"

  if [[ "$service" == "worker" ]]; then
    local stale_marker="$sandbox/stale-worker-ready"
    printf 'stale\n' >"$stale_marker"
    DATABASE_URL="$secret" \
      WORKER_READINESS_PATH="$stale_marker" \
      ASSERT_PATH_ABSENT="$stale_marker" \
      PRISMA_ATTEMPTS_FILE="$sandbox/prisma-marker-attempts" \
      PRISMA_ARGS_FILE="$sandbox/prisma-marker-args" \
      APP_PID_FILE="$sandbox/app-marker-pid" \
      APP_ARGS_FILE="$sandbox/app-marker-args" \
      APP_SIGNAL_FILE="$sandbox/app-marker-signal" \
      "$runnable" "$command" marker-cleared >/dev/null 2>&1
    [[ ! -e "$stale_marker" ]] ||
      fail "worker entrypoint did not clear readiness before migration"
  fi
}

assert_entrypoint_behavior api
assert_entrypoint_behavior worker

bounded_root="$test_root/bounded"
mkdir -p "$bounded_root/app/database/node_modules/.bin"
sed "s#/app#$bounded_root/app#g" "$repo_root/api/docker-entrypoint.sh" \
  >"$bounded_root/docker-entrypoint.sh"
cp "$test_root/api/app/database/node_modules/.bin/prisma" \
  "$bounded_root/app/database/node_modules/.bin/prisma"
cp "$test_root/api/fake-command" "$bounded_root/fake-command"
chmod 755 "$bounded_root/docker-entrypoint.sh" \
  "$bounded_root/app/database/node_modules/.bin/prisma" \
  "$bounded_root/fake-command"

set +e
timeout 4 env \
  DATABASE_URL="postgresql://bounded-secret@database/systemvitals" \
  MIGRATION_RETRY_BASE_SECONDS=1 \
  MIGRATION_RETRY_MAX_SECONDS=1 \
  MIGRATION_RETRY_WINDOW_SECONDS=1 \
  PRISMA_MODE=lock-always \
  PRISMA_ATTEMPTS_FILE="$bounded_root/attempts" \
  PRISMA_ARGS_FILE="$bounded_root/prisma-args" \
  APP_PID_FILE="$bounded_root/app-pid" \
  APP_ARGS_FILE="$bounded_root/app-args" \
  APP_SIGNAL_FILE="$bounded_root/app-signal" \
  "$bounded_root/docker-entrypoint.sh" "$bounded_root/fake-command" \
  >"$bounded_root/output" 2>&1
bounded_status=$?
set -e

[[ "$bounded_status" -eq 1 ]] ||
  fail "migration retry window was not bounded (status $bounded_status)"
[[ ! -e "$bounded_root/app-pid" ]] ||
  fail "application started after migration retry window exhaustion"
[[ "$(cat "$bounded_root/attempts")" -eq 1 ]] ||
  fail "migration started again after the retry window was exhausted"
assert_contains "$bounded_root/output" "retry window exhausted"
assert_not_contains "$bounded_root/output" "bounded-secret"

concurrent_root="$test_root/concurrent"
mkdir -p "$concurrent_root/app/database/node_modules/.bin"
sed "s#/app#$concurrent_root/app#g" "$repo_root/api/docker-entrypoint.sh" \
  >"$concurrent_root/docker-entrypoint.sh"
cp "$test_root/api/app/database/node_modules/.bin/prisma" \
  "$concurrent_root/app/database/node_modules/.bin/prisma"
cp "$test_root/api/fake-command" "$concurrent_root/fake-command"
chmod 755 "$concurrent_root/docker-entrypoint.sh" \
  "$concurrent_root/app/database/node_modules/.bin/prisma" \
  "$concurrent_root/fake-command"
touch "$concurrent_root/hold"

DATABASE_URL="postgresql://concurrent-secret@database/systemvitals" \
  PRISMA_MODE=concurrent \
  PRISMA_ATTEMPTS_FILE="$concurrent_root/holder-attempts" \
  PRISMA_ARGS_FILE="$concurrent_root/holder-prisma-args" \
  PRISMA_LOCK_DIR="$concurrent_root/lock" \
  PRISMA_HOLD_FILE="$concurrent_root/hold" \
  PRISMA_HOLDER_READY_FILE="$concurrent_root/holder-ready" \
  APP_PID_FILE="$concurrent_root/holder-app-pid" \
  APP_ARGS_FILE="$concurrent_root/holder-app-args" \
  APP_SIGNAL_FILE="$concurrent_root/holder-app-signal" \
  "$concurrent_root/docker-entrypoint.sh" "$concurrent_root/fake-command" holder \
  >"$concurrent_root/holder-output" 2>&1 &
holder_pid=$!

for _ in {1..100}; do
  [[ -s "$concurrent_root/holder-ready" ]] && break
  sleep 0.02
done
[[ -s "$concurrent_root/holder-ready" ]] ||
  fail "concurrent migration holder did not acquire the fake lock"

DATABASE_URL="postgresql://concurrent-secret@database/systemvitals" \
  MIGRATION_RETRY_BASE_SECONDS=1 \
  MIGRATION_RETRY_MAX_SECONDS=1 \
  MIGRATION_RETRY_WINDOW_SECONDS=30 \
  PRISMA_MODE=concurrent \
  PRISMA_ATTEMPTS_FILE="$concurrent_root/contender-attempts" \
  PRISMA_ARGS_FILE="$concurrent_root/contender-prisma-args" \
  PRISMA_LOCK_DIR="$concurrent_root/lock" \
  PRISMA_HOLD_FILE="$concurrent_root/no-hold" \
  PRISMA_HOLDER_READY_FILE="$concurrent_root/contender-ready" \
  APP_PID_FILE="$concurrent_root/contender-app-pid" \
  APP_ARGS_FILE="$concurrent_root/contender-app-args" \
  APP_SIGNAL_FILE="$concurrent_root/contender-app-signal" \
  "$concurrent_root/docker-entrypoint.sh" "$concurrent_root/fake-command" contender \
  >"$concurrent_root/contender-output" 2>&1 &
contender_pid=$!

for _ in {1..100}; do
  if [[ -s "$concurrent_root/contender-attempts" ]] &&
    [[ "$(cat "$concurrent_root/contender-attempts")" -ge 1 ]]; then
    break
  fi
  sleep 0.02
done
rm "$concurrent_root/hold"
wait "$holder_pid"
wait "$contender_pid"

[[ "$(cat "$concurrent_root/contender-attempts")" -ge 2 ]] ||
  fail "concurrent migration contender did not retry the held advisory lock"
assert_contains "$concurrent_root/contender-app-args" "<contender>"
assert_not_contains "$concurrent_root/holder-output" "concurrent-secret"
assert_not_contains "$concurrent_root/contender-output" "concurrent-secret"

api_dockerfile="$repo_root/api/Dockerfile"
worker_dockerfile="$repo_root/worker/Dockerfile"
frontend_dockerfile="$repo_root/frontend/Dockerfile"
prod_compose="$repo_root/docker-compose.prod.yml"
obsolete_dokploy_compose="$repo_root/docker-compose.dokploy.yml"
api_entrypoint="$repo_root/api/docker-entrypoint.sh"
worker_entrypoint="$repo_root/worker/docker-entrypoint.sh"
ci_workflow="$repo_root/.github/workflows/ci.yml"

assert_contains "$api_dockerfile" "COPY --chmod=555 api/docker-entrypoint.sh /app/api/docker-entrypoint.sh"
assert_contains "$api_dockerfile" 'ENTRYPOINT ["/app/api/docker-entrypoint.sh"]'
assert_contains "$api_dockerfile" 'CMD ["node", "api/dist/main.js"]'
assert_contains "$api_dockerfile" "HEALTHCHECK --interval=10s --timeout=5s --start-period=31m --retries=3"
assert_contains "$api_dockerfile" "process.env.PORT"
assert_contains "$api_dockerfile" "/health/ready"
assert_contains "$api_dockerfile" "MIGRATION_RETRY_WINDOW_SECONDS=1800"
assert_contains "$api_dockerfile" "npm --prefix api prune --omit=dev"
assert_contains "$api_dockerfile" "USER appuser"
assert_not_contains "$api_dockerfile" "chown -R"
assert_not_contains "$api_dockerfile" "COPY --chown=appuser"

assert_contains "$worker_dockerfile" "COPY --chmod=555 worker/docker-entrypoint.sh /app/worker/docker-entrypoint.sh"
assert_contains "$worker_dockerfile" 'ENTRYPOINT ["/app/worker/docker-entrypoint.sh"]'
assert_contains "$worker_dockerfile" 'CMD ["node", "/app/worker/dist/cli/worker.js"]'
assert_contains "$worker_dockerfile" "WORKER_READINESS_PATH=/tmp/systemvitals-worker-ready"
assert_contains "$worker_dockerfile" "MIGRATION_RETRY_WINDOW_SECONDS=1800"
assert_contains "$worker_dockerfile" "WORKER_READINESS_HEARTBEAT_INTERVAL_MS=5000"
assert_contains "$worker_dockerfile" "WORKER_READINESS_MAX_AGE_SECONDS=30"
assert_contains "$worker_dockerfile" "HEALTHCHECK --interval=10s --timeout=5s --start-period=31m --retries=3"
assert_contains "$worker_dockerfile" "process.env"
assert_contains "$worker_dockerfile" "e.WORKER_READINESS_PATH"
assert_contains "$worker_dockerfile" "mtimeMs"
assert_contains "$worker_dockerfile" "npm --prefix worker prune --omit=dev"
assert_contains "$worker_dockerfile" "npm --prefix worker exec tsc -- --project worker/tsconfig.build.json"
assert_contains "$worker_dockerfile" "USER appuser"
assert_not_contains "$worker_dockerfile" "chown -R"
assert_not_contains "$worker_dockerfile" "COPY --chown=appuser"
assert_contains "$repo_root/worker/src/readiness.ts" 'process.env.WORKER_READINESS_PATH ||'

assert_contains "$frontend_dockerfile" 'CMD ["node", "server.js"]'
assert_contains "$frontend_dockerfile" "HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3"
assert_contains "$frontend_dockerfile" "process.env.PORT"
assert_contains "$frontend_dockerfile" "/api/health"
assert_contains "$frontend_dockerfile" "USER appuser"
assert_contains "$frontend_dockerfile" "install -d -o appuser -g appgroup -m 700 /app/.next/cache"
assert_not_contains "$frontend_dockerfile" "chown -R"
assert_not_contains "$frontend_dockerfile" "COPY --chown=appuser"

assert_not_contains "$prod_compose" "localhost:8888/graphql"
assert_not_contains "$prod_compose" "localhost:9999/"
[[ ! -e "$obsolete_dokploy_compose" ]] ||
  fail "obsolete docker-compose.dokploy.yml must remain absent"
# shellcheck disable=SC2016 # Assert literal fallback syntax in the API entrypoint.
assert_contains "$api_entrypoint" 'retry_window=${MIGRATION_RETRY_WINDOW_SECONDS:-1800}'
# shellcheck disable=SC2016 # Assert literal fallback syntax in the worker entrypoint.
assert_contains "$worker_entrypoint" 'retry_window=${MIGRATION_RETRY_WINDOW_SECONDS:-1800}'

assert_contains "$ci_workflow" "shellcheck api/docker-entrypoint.sh worker/docker-entrypoint.sh scripts/test/docker-entrypoints.test.sh"
assert_contains "$ci_workflow" "bash scripts/test/docker-entrypoints.test.sh"
assert_contains "$ci_workflow" "docker build -f api/Dockerfile -t systemvitals-api:ci ."
assert_contains "$ci_workflow" "docker build -f worker/Dockerfile -t systemvitals-worker:ci ."
assert_contains "$ci_workflow" "docker build -f frontend/Dockerfile -t systemvitals-frontend:ci"
assert_contains "$ci_workflow" 'TEST_BUILT_IMAGES: "1"'
assert_contains "$ci_workflow" "timeout 300 bash scripts/test/docker-entrypoints.test.sh"

if [[ "${TEST_BUILT_IMAGES:-0}" == "1" ]]; then
  api_image=${API_IMAGE:-systemvitals-api:zd}
  worker_image=${WORKER_IMAGE:-systemvitals-worker:zd}
  frontend_image=${FRONTEND_IMAGE:-systemvitals-frontend:zd}

  [[ "$(docker image inspect "$api_image" --format '{{json .Config.Entrypoint}}')" == \
    '["/app/api/docker-entrypoint.sh"]' ]] ||
    fail "api image entrypoint metadata is incorrect"
  [[ "$(docker image inspect "$api_image" --format '{{json .Config.Cmd}} {{.Config.User}}')" == \
    '["node","api/dist/main.js"] appuser' ]] ||
    fail "api image command/user metadata is incorrect"
  [[ "$(docker image inspect "$worker_image" --format '{{json .Config.Entrypoint}}')" == \
    '["/app/worker/docker-entrypoint.sh"]' ]] ||
    fail "worker image entrypoint metadata is incorrect"
  [[ "$(docker image inspect "$worker_image" --format '{{json .Config.Cmd}} {{.Config.User}}')" == \
    '["node","/app/worker/dist/cli/worker.js"] appuser' ]] ||
    fail "worker image command/user metadata is incorrect"
  [[ "$(docker image inspect "$frontend_image" --format '{{json .Config.Cmd}} {{.Config.User}}')" == \
    '["node","server.js"] appuser' ]] ||
    fail "frontend image command/user metadata is incorrect"

  api_health=$(docker image inspect "$api_image" \
    --format '{{json .Config.Healthcheck}}')
  worker_health=$(docker image inspect "$worker_image" \
    --format '{{json .Config.Healthcheck}}')
  frontend_health=$(docker image inspect "$frontend_image" \
    --format '{{json .Config.Healthcheck}}')
  [[ "$api_health" == *"process.env.PORT"* &&
    "$api_health" == *"/health/ready"* ]] ||
    fail "api image health metadata is incorrect"
  [[ "$worker_health" == *"mtimeMs"* &&
    "$worker_health" == *"WORKER_READINESS_MAX_AGE_SECONDS"* ]] ||
    fail "worker image health metadata does not bound marker age"
  [[ "$frontend_health" == *"process.env.PORT"* &&
    "$frontend_health" == *"/api/health"* ]] ||
    fail "frontend image health metadata is incorrect"

  docker run --rm --entrypoint /bin/sh "$api_image" -c '
    set -eu
    test "$(stat -c "%a %u:%g" /app/api/docker-entrypoint.sh)" = "555 0:0"
    test ! -w /app/api/docker-entrypoint.sh
    test "$(stat -c "%u:%g" /app/api/dist/main.js)" = "0:0"
    test ! -w /app/api/dist/main.js
    test -x /app/database/node_modules/.bin/prisma
  '
  docker run --rm --entrypoint /bin/sh "$worker_image" -c '
    set -eu
    test "$(stat -c "%a %u:%g" /app/worker/docker-entrypoint.sh)" = "555 0:0"
    test ! -w /app/worker/docker-entrypoint.sh
    test "$(stat -c "%u:%g" /app/worker/dist/cli/worker.js)" = "0:0"
    test ! -w /app/worker/dist/cli/worker.js
    test ! -e /app/worker/node_modules/.bin/tsx
    test -x /app/database/node_modules/.bin/prisma
  '
  docker run --rm --entrypoint /bin/sh "$frontend_image" -c '
    set -eu
    test "$(stat -c "%u:%g" /app/server.js)" = "0:0"
    test ! -w /app/server.js
    test "$(stat -c "%a %u:%g" /app/.next/cache)" = "700 1001:1001"
    test -w /app/.next/cache
    touch /app/.next/cache/write-test
    rm /app/.next/cache/write-test
    if find /app -xdev \( -type f -o -type d \) \
      ! -path /app/.next/cache ! -path "/app/.next/cache/*" \
      -writable -print -quit | grep -q .; then
      exit 1
    fi
  '

  fake_image_prisma="$test_root/image-prisma"
  cat >"$fake_image_prisma" <<'EOF'
#!/bin/sh
case "${IMAGE_PRISMA_MODE:-success}" in
  success)
    exit 0
    ;;
  block)
    printf 'started\n' >"$IMAGE_SIGNAL_DIR/started"
    trap 'printf "TERM\n" >"$IMAGE_SIGNAL_DIR/signal"; exit 42' TERM
    while :; do
      sleep 1 &
      wait "$!" || true
    done
    ;;
esac
EOF
  chmod 755 "$fake_image_prisma"

  image_signal_dir="$test_root/image-signal"
  mkdir "$image_signal_dir"
  chmod 777 "$image_signal_dir"
  blocking_container=$(docker run -d \
    -e IMAGE_PRISMA_MODE=block \
    -e IMAGE_SIGNAL_DIR=/tmp/image-signal \
    --mount "type=bind,src=$fake_image_prisma,dst=/app/database/node_modules/.bin/prisma,readonly" \
    --mount "type=bind,src=$image_signal_dir,dst=/tmp/image-signal" \
    "$api_image" node -e "console.log('application-should-not-start')")
  test_containers+=("$blocking_container")
  for _ in {1..100}; do
    [[ -s "$image_signal_dir/started" ]] && break
    sleep 0.05
  done
  if [[ ! -s "$image_signal_dir/started" ]]; then
    docker logs "$blocking_container" >&2 2>&1 || true
    docker inspect "$blocking_container" --format '{{json .State}}' >&2 ||
      true
    fail "built-image migration did not block"
  fi
  docker kill --signal TERM "$blocking_container" >/dev/null
  blocking_status=$(docker wait "$blocking_container")
  blocking_logs=$(docker logs "$blocking_container" 2>&1)
  [[ "$blocking_status" -eq 143 ]] ||
    fail "built-image migration TERM returned $blocking_status"
  assert_contains "$image_signal_dir/signal" "TERM"
  [[ "$blocking_logs" != *"TERM"* ]] ||
    fail "built-image entrypoint replayed migration child output"
  [[ "$blocking_logs" != *"application-should-not-start"* ]] ||
    fail "built-image application started during blocking migration"
  docker rm "$blocking_container" >/dev/null
  test_containers=("${test_containers[@]:0:${#test_containers[@]}-1}")

  worker_health_command=$(docker image inspect "$worker_image" \
    --format '{{index .Config.Healthcheck.Test 1}}')
  docker run --rm --entrypoint /bin/sh "$worker_image" -c \
    "touch \"\$WORKER_READINESS_PATH\"; $worker_health_command"
  set +e
  docker run --rm --entrypoint /bin/sh "$worker_image" -c \
    "touch -d '1970-01-01 UTC' \"\$WORKER_READINESS_PATH\"; $worker_health_command"
  stale_health_status=$?
  set -e
  [[ "$stale_health_status" -ne 0 ]] ||
    fail "worker image health accepted a stale readiness marker"

  smoke_suffix="systemvitals-image-smoke-$$-$RANDOM"
  smoke_network="$smoke_suffix"
  postgres_name="$smoke_suffix-postgres"
  redis_name="$smoke_suffix-redis"
  api_name="$smoke_suffix-api"
  worker_name="$smoke_suffix-worker"
  frontend_name="$smoke_suffix-frontend"
  docker network create "$smoke_network" >/dev/null
  test_networks+=("$smoke_network")

  postgres_container=$(docker run -d \
    --network "$smoke_network" \
    --name "$postgres_name" \
    -e POSTGRES_USER=systemvitals \
    -e POSTGRES_PASSWORD=systemvitals \
    -e POSTGRES_DB=systemvitals \
    postgres:18)
  test_containers+=("$postgres_container")
  redis_container=$(docker run -d \
    --network "$smoke_network" \
    --name "$redis_name" \
    redis:7)
  test_containers+=("$redis_container")

  for _ in {1..300}; do
    if docker logs "$postgres_container" 2>&1 |
      grep -Fq "PostgreSQL init process complete; ready for start up." &&
      docker exec "$postgres_container" psql \
        -U systemvitals -d systemvitals -Atqc "SELECT 1" \
        2>/dev/null | grep -Fxq 1; then
      break
    fi
    sleep 0.1
  done
  if ! docker exec "$postgres_container" psql \
    -U systemvitals -d systemvitals -Atqc "SELECT 1" \
    2>/dev/null | grep -Fxq 1; then
    docker logs "$postgres_container" >&2 2>&1 || true
    fail "disposable Postgres did not become ready"
  fi
  for _ in {1..300}; do
    if docker exec "$redis_container" redis-cli ping 2>/dev/null |
      grep -Fq PONG; then
      break
    fi
    sleep 0.1
  done
  docker exec "$redis_container" redis-cli ping |
    grep -Fq PONG ||
    fail "disposable Redis did not become ready"

  smoke_database_url="postgresql://systemvitals:systemvitals@$postgres_name:5432/systemvitals?schema=public"
  smoke_redis_url="redis://$redis_name:6379"
  # Production startup must receive HTTPS; an HTTP regression fails readiness here.
  smoke_app_url="https://systemvitals.test"

  api_container=$(docker run -d \
    --network "$smoke_network" \
    --name "$api_name" \
    -p 127.0.0.1::8888 \
    -e DATABASE_URL="$smoke_database_url" \
    -e REDIS_URL="$smoke_redis_url" \
    -e JWT_SECRET=image-smoke-secret-at-least-16-chars \
    -e APP_URL="$smoke_app_url" \
    -e HTTP_DRAIN_DELAY_MS=0 \
    "$api_image")
  test_containers+=("$api_container")
  worker_container=$(docker run -d \
    --network "$smoke_network" \
    --name "$worker_name" \
    -e DATABASE_URL="$smoke_database_url" \
    -e REDIS_URL="$smoke_redis_url" \
    -e WORKER_READINESS_HEARTBEAT_INTERVAL_MS=500 \
    -e WORKER_READINESS_MAX_AGE_SECONDS=2 \
    -e WORKER_SHUTDOWN_TIMEOUT_MS=5000 \
    "$worker_image")
  test_containers+=("$worker_container")

  api_port=$(docker port "$api_container" 8888/tcp |
    awk -F: 'NR == 1 { print $NF }')
  for _ in {1..900}; do
    if curl -fsS "http://127.0.0.1:$api_port/health/ready" \
      >/dev/null 2>&1; then
      break
    fi
    if [[ "$(docker inspect "$api_container" \
      --format '{{.State.Running}}')" != "true" ]]; then
      break
    fi
    sleep 0.1
  done
  if ! curl -fsS "http://127.0.0.1:$api_port/health/ready" \
    >/dev/null; then
    docker logs "$api_container" >&2 2>&1 || true
    fail "default API image command did not become ready"
  fi
  api_health_command=$(docker image inspect "$api_image" \
    --format '{{index .Config.Healthcheck.Test 1}}')
  docker exec "$api_container" /bin/sh -c "$api_health_command" ||
    fail "default API image health command failed"
  if docker logs "$api_container" 2>&1 | grep -Fq EACCES; then
    docker logs "$api_container" >&2 2>&1 || true
    fail "default API image wrote into a root-owned code path"
  fi

  for _ in {1..900}; do
    if docker exec "$worker_container" \
      test -f /tmp/systemvitals-worker-ready 2>/dev/null; then
      break
    fi
    if [[ "$(docker inspect "$worker_container" \
      --format '{{.State.Running}}')" != "true" ]]; then
      break
    fi
    sleep 0.1
  done
  if ! docker exec "$worker_container" \
    test -f /tmp/systemvitals-worker-ready; then
    docker logs "$worker_container" >&2 2>&1 || true
    fail "default worker image command did not publish readiness"
  fi
  docker exec "$worker_container" /bin/sh -c "$worker_health_command" ||
    fail "default worker image health command failed"

  frontend_container=$(docker run -d \
    --network "$smoke_network" \
    --name "$frontend_name" \
    -e PORT=10099 \
    -e NEXT_PUBLIC_API_URL="http://$api_name:8888" \
    -p 127.0.0.1::10099 \
    "$frontend_image")
  test_containers+=("$frontend_container")
  frontend_port=$(docker port "$frontend_container" 10099/tcp |
    awk -F: 'NR == 1 { print $NF }')
  for _ in {1..200}; do
    if curl -fsS "http://127.0.0.1:$frontend_port/api/health" \
      >/dev/null 2>&1; then
      break
    fi
    sleep 0.05
  done
  curl -fsS "http://127.0.0.1:$frontend_port/api/health" >/dev/null ||
    fail "frontend image did not serve health on configured PORT"
  frontend_health_command=$(docker image inspect "$frontend_image" \
    --format '{{index .Config.Healthcheck.Test 1}}')
  docker exec "$frontend_container" /bin/sh -c "$frontend_health_command"
  curl -fsS "http://127.0.0.1:$frontend_port/status/image-smoke-missing" \
    >/dev/null ||
    fail "frontend image did not serve a real status-page request"
  if docker logs "$frontend_container" 2>&1 | grep -Fq EACCES; then
    docker logs "$frontend_container" >&2 2>&1 || true
    fail "frontend status-page request hit a read-only cache path"
  fi

  docker stop --time 1 "$redis_container" >/dev/null
  sleep 3
  if docker exec "$worker_container" \
    test -e /tmp/systemvitals-worker-ready; then
    docker logs "$worker_container" >&2 2>&1 || true
    fail "worker retained readiness after Redis became unavailable"
  fi
  set +e
  docker exec "$worker_container" /bin/sh -c "$worker_health_command" \
    >/dev/null 2>&1
  lost_redis_health_status=$?
  set -e
  [[ "$lost_redis_health_status" -ne 0 ]] ||
    fail "worker health stayed ready after Redis became unavailable"

  docker start "$redis_container" >/dev/null
  for _ in {1..300}; do
    if docker exec "$redis_container" redis-cli ping 2>/dev/null |
      grep -Fq PONG; then
      break
    fi
    sleep 0.1
  done
  docker exec "$redis_container" redis-cli ping |
    grep -Fq PONG ||
    fail "disposable Redis did not recover"
  for _ in {1..300}; do
    if docker exec "$worker_container" \
      test -f /tmp/systemvitals-worker-ready 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  docker exec "$worker_container" \
    test -f /tmp/systemvitals-worker-ready ||
    fail "worker did not recover readiness after Redis restarted"
  docker exec "$worker_container" /bin/sh -c "$worker_health_command" ||
    fail "worker health did not recover after Redis restarted"
fi

echo "docker entrypoint tests passed"
