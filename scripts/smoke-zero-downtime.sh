#!/usr/bin/env bash
set -euo pipefail

duration=
interval=
output=
total_probes=0
failures=0
interrupted=false
summary_written=false
body_dir=

usage() {
  cat >&2 <<'EOF'
Usage: smoke-zero-downtime.sh --duration SECONDS --interval SECONDS --output FILE
EOF
}

die() {
  echo "smoke-zero-downtime: $*" >&2
  exit 2
}

is_positive_number() {
  awk -v value="$1" 'BEGIN {
    exit !(value ~ /^([0-9]+([.][0-9]+)?|[.][0-9]+)$/ && value + 0 > 0)
  }'
}

write_summary() {
  if [[ $summary_written == true ]]; then
    return
  fi
  summary_written=true
  jq -cn \
    --argjson total_probes "$total_probes" \
    --argjson failures "$failures" \
    --argjson interrupted "$interrupted" \
    '{summary:true,total_probes:$total_probes,failures:$failures,interrupted:$interrupted}'
}

cleanup() {
  if [[ -n ${body_dir:-} && -d $body_dir ]]; then
    rm -rf -- "$body_dir"
  fi
}

handle_interrupt() {
  interrupted=true
  write_summary
  cleanup
  if ((failures > 0)); then
    exit 1
  fi
  exit 0
}

trap cleanup EXIT
trap handle_interrupt INT TERM

while (($#)); do
  case "$1" in
    --duration)
      (($# >= 2)) || die "--duration requires a value"
      duration=$2
      shift 2
      ;;
    --interval)
      (($# >= 2)) || die "--interval requires a value"
      interval=$2
      shift 2
      ;;
    --output)
      (($# >= 2)) || die "--output requires a value"
      output=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n $duration ]] || die "--duration is required"
[[ -n $interval ]] || die "--interval is required"
[[ -n $output ]] || die "--output must be a non-empty path"
is_positive_number "$duration" || die "--duration must be a positive number"
is_positive_number "$interval" || die "--interval must be a positive number"

output_parent=$(dirname -- "$output")
[[ -d $output_parent ]] || die "--output parent directory does not exist"
: >"$output" || die "--output is not writable"

body_dir=$(mktemp -d)
started_ms=$(date +%s%3N)

probe() {
  local target=$1
  local method=$2
  local url=$3
  local expected=$4
  local body="$body_dir/$target.body"
  local curl_result=
  local curl_status=0
  local http_status=0
  local latency_seconds=0
  local latency_ms=0
  local contract_ok=false

  set +e
  if [[ $method == POST ]]; then
    curl_result=$(curl \
      --silent --show-error --location \
      --connect-timeout 5 --max-time 10 \
      --request POST \
      --header 'Content-Type: application/json' \
      --data '{"query":"{health}"}' \
      --output "$body" \
      --write-out $'%{http_code}\t%{time_total}' \
      "$url" 2>/dev/null)
    curl_status=$?
  else
    curl_result=$(curl \
      --silent --show-error --location \
      --connect-timeout 5 --max-time 10 \
      --output "$body" \
      --write-out $'%{http_code}\t%{time_total}' \
      "$url" 2>/dev/null)
    curl_status=$?
  fi
  set -e

  if ((curl_status == 0)); then
    IFS=$'\t' read -r http_status latency_seconds <<<"$curl_result"
    [[ $http_status =~ ^[0-9]{3}$ ]] || http_status=0
    if [[ $latency_seconds =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      latency_ms=$(awk -v seconds="$latency_seconds" \
        'BEGIN { printf "%.3f", seconds * 1000 }')
    fi
  fi

  if ((curl_status == 0 && http_status >= 200 && http_status < 300)); then
    case "$expected" in
      frontend_health)
        jq -e '. == {"status":"ok","service":"frontend"}' "$body" >/dev/null 2>&1 &&
          contract_ok=true
        ;;
      frontend_root)
        [[ -s $body ]] && contract_ok=true
        ;;
      api_ready)
        jq -e '. == {"status":"ready"}' "$body" >/dev/null 2>&1 &&
          contract_ok=true
        ;;
      graphql_health)
        jq -e '. == {"data":{"health":"ok"}}' "$body" >/dev/null 2>&1 &&
          contract_ok=true
        ;;
    esac
  fi

  total_probes=$((total_probes + 1))
  if [[ $contract_ok != true ]]; then
    failures=$((failures + 1))
  fi

  jq -cn \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
    --arg target "$target" \
    --argjson http_status "$http_status" \
    --argjson latency_ms "$latency_ms" \
    --argjson contract_ok "$contract_ok" \
    '{
      timestamp:$timestamp,
      target:$target,
      http_status:$http_status,
      latency_ms:$latency_ms,
      contract_ok:$contract_ok
    }' >>"$output"
}

while :; do
  probe frontend_health GET \
    https://systemvitals.link/api/health frontend_health
  probe frontend_root GET \
    https://systemvitals.link/ frontend_root
  probe api_ready GET \
    https://api.systemvitals.link/health/ready api_ready
  probe graphql_health POST \
    https://api.systemvitals.link/graphql graphql_health

  now_ms=$(date +%s%3N)
  elapsed_ms=$((now_ms - started_ms))
  if awk -v elapsed="$elapsed_ms" -v duration="$duration" \
    'BEGIN { exit !(elapsed >= duration * 1000) }'; then
    break
  fi
  if awk -v elapsed="$elapsed_ms" -v interval="$interval" -v duration="$duration" \
    'BEGIN { exit !(elapsed + interval * 1000 >= duration * 1000) }'; then
    break
  fi
  sleep "$interval" &
  wait $!
done

write_summary
if ((failures > 0)); then
  exit 1
fi
