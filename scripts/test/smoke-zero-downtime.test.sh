#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
smoke="$repo_root/scripts/smoke-zero-downtime.sh"
test_root=$(mktemp -d)

cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  grep -Fq -- "$2" "$1" || fail "$1 did not contain: $2"
}

assert_not_contains() {
  if grep -Fiq -- "$2" "$1"; then
    fail "$1 leaked: $2"
  fi
}

run_smoke() {
  local scenario=$1
  local output=$2
  shift 2
  PATH="$mock_bin:$PATH" MOCK_SCENARIO="$scenario" MOCK_REQUEST_LOG="$request_log" \
    bash "$smoke" --duration 1 --interval 1 --output "$output" "$@"
}

mock_bin="$test_root/bin"
mkdir -p "$mock_bin"
request_log="$test_root/requests.log"

cat >"$mock_bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

output=
write_out=
method=GET
data=
url=
while (($#)); do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --write-out) write_out=$2; shift 2 ;;
    --request) method=$2; shift 2 ;;
    --data|--data-raw|--data-binary) data=$2; shift 2 ;;
    --header) shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    --silent|--show-error|--location) shift ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done

label=unknown
body=
status=200
case "$url" in
  https://systemvitals.link/api/health)
    label=frontend_health
    body='{"status":"ok","service":"frontend"}'
    ;;
  https://systemvitals.link/)
    label=frontend_root
    body='<!doctype html><html><body>SystemVitals</body></html>'
    ;;
  https://api.systemvitals.link/health/ready)
    label=api_ready
    body='{"status":"ready"}'
    ;;
  https://api.systemvitals.link/graphql)
    label=graphql_health
    [[ $method == POST ]] || exit 90
    [[ $data == '{"query":"{health}"}' ]] || exit 91
    body='{"data":{"health":"ok"}}'
    ;;
  *) exit 92 ;;
esac

printf '%s\n' "$label" >>"$MOCK_REQUEST_LOG"

case "$MOCK_SCENARIO:$label" in
  transport:api_ready)
    exit 7
    ;;
  502:frontend_root)
    status=502
    body='bad gateway'
    ;;
  503:api_ready)
    status=503
    body='unavailable'
    ;;
  bad_graphql:graphql_health)
    body='{"data":{"health":"degraded"}}'
    ;;
  bad_api_ready:api_ready)
    body='{"status":"ok"}'
    ;;
esac

printf '%s' "$body" >"$output"
printf '%s\t%s' "$status" "0.025"
MOCK
chmod +x "$mock_bin/curl"

[[ -x $smoke ]] || fail "$smoke is missing or not executable"

output="$test_root/success.jsonl"
: >"$request_log"
run_smoke success "$output" >"$test_root/success.stdout" 2>"$test_root/success.stderr"
[[ $(wc -l <"$request_log") -eq 4 ]] || fail "one interval did not probe all four targets"
for target in frontend_health frontend_root api_ready graphql_health; do
  [[ $(grep -Fc "$target" "$request_log") -eq 1 ]] ||
    fail "$target was not probed exactly once"
done
[[ $(wc -l <"$output") -eq 4 ]] || fail "success run did not write four JSONL records"
jq -e -s '
  length == 4 and
  all(
    has("timestamp") and
    (.target | type == "string") and
    (.http_status | type == "number") and
    (.latency_ms | type == "number") and
    (.contract_ok | type == "boolean") and
    (.contract_ok == true) and
    ((keys | sort) == ["contract_ok","http_status","latency_ms","target","timestamp"])
  )
' "$output" >/dev/null || fail "JSONL fields or success contracts were incorrect"
assert_contains "$test_root/success.stdout" '"total_probes":4'
assert_contains "$test_root/success.stdout" '"failures":0'

output="$test_root/multiple-intervals.jsonl"
: >"$request_log"
PATH="$mock_bin:$PATH" MOCK_SCENARIO=success MOCK_REQUEST_LOG="$request_log" \
  bash "$smoke" --duration 0.25 --interval 0.05 --output "$output" \
  >"$test_root/multiple-intervals.stdout" 2>"$test_root/multiple-intervals.stderr"
interval_probe_count=$(wc -l <"$request_log")
((interval_probe_count >= 8)) ||
  fail "multi-interval run made fewer than two complete probe cycles"
((interval_probe_count % 4 == 0)) ||
  fail "multi-interval run did not finish a complete four-target cycle"
expected_target_count=$((interval_probe_count / 4))
for target in frontend_health frontend_root api_ready graphql_health; do
  [[ $(grep -Fc "$target" "$request_log") -eq $expected_target_count ]] ||
    fail "$target was not probed once in every interval"
done
[[ $(wc -l <"$output") -eq $interval_probe_count ]] ||
  fail "multi-interval run did not record every probe"

for scenario in transport 502 503 bad_graphql bad_api_ready; do
  output="$test_root/$scenario.jsonl"
  : >"$request_log"
  if run_smoke "$scenario" "$output" >"$test_root/$scenario.stdout" 2>"$test_root/$scenario.stderr"; then
    fail "$scenario unexpectedly succeeded"
  fi
  [[ $(wc -l <"$request_log") -eq 4 ]] ||
    fail "$scenario stopped before probing all four targets"
  assert_contains "$test_root/$scenario.stdout" '"failures":1'
done

secret='SMOKE_SUPER_SECRET'
output="$test_root/secrets.jsonl"
: >"$request_log"
AUTHORIZATION="Bearer $secret" SMOKE_TOKEN="$secret" \
  run_smoke success "$output" >"$test_root/secrets.stdout" 2>"$test_root/secrets.stderr"
assert_not_contains "$output" "$secret"
assert_not_contains "$test_root/secrets.stdout" "$secret"
assert_not_contains "$test_root/secrets.stderr" "$secret"
assert_not_contains "$output" authorization

for args in \
  '--duration 0 --interval 1' \
  '--duration -1 --interval 1' \
  '--duration nope --interval 1' \
  '--duration 1 --interval 0' \
  '--duration 1 --interval -2' \
  '--duration 1 --interval nope' \
  '--duration 1 --interval 1 --output ""'; do
  if eval "PATH=\"$mock_bin:\$PATH\" bash \"$smoke\" $args" \
    >"$test_root/invalid.stdout" 2>"$test_root/invalid.stderr"; then
    fail "invalid arguments unexpectedly succeeded: $args"
  fi
done

output="$test_root/interrupted.jsonl"
: >"$request_log"
if PATH="$mock_bin:$PATH" MOCK_SCENARIO=503 MOCK_REQUEST_LOG="$request_log" \
  timeout --preserve-status --signal=INT 0.5 \
  bash "$smoke" --duration 30 --interval 5 --output "$output" \
  >"$test_root/interrupted.stdout" 2>"$test_root/interrupted.stderr"; then
  fail "interrupted failing run exited zero"
fi
assert_contains "$test_root/interrupted.stdout" '"interrupted":true'
assert_contains "$test_root/interrupted.stdout" '"total_probes":4'
assert_contains "$test_root/interrupted.stdout" '"failures":1'

output="$test_root/interrupted-success.jsonl"
: >"$request_log"
if ! PATH="$mock_bin:$PATH" MOCK_SCENARIO=success MOCK_REQUEST_LOG="$request_log" \
  timeout --preserve-status --signal=INT 0.5 \
  bash "$smoke" --duration 30 --interval 5 --output "$output" \
  >"$test_root/interrupted-success.stdout" \
  2>"$test_root/interrupted-success.stderr"; then
  fail "interrupted successful run exited nonzero"
fi
assert_contains "$test_root/interrupted-success.stdout" '"interrupted":true'
assert_contains "$test_root/interrupted-success.stdout" '"total_probes":4'
assert_contains "$test_root/interrupted-success.stdout" '"failures":0'

echo "smoke-zero-downtime tests passed"
