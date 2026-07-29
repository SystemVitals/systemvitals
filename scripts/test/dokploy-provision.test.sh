#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
helper="$repo_root/scripts/dokploy-api.sh"
provisioner="$repo_root/scripts/provision-dokploy-zero-downtime.sh"
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
  local file=$1
  local expected=$2

  grep -Fq -- "$expected" "$file" ||
    fail "$file did not contain: $expected"
}

assert_not_contains() {
  local file=$1
  local unexpected=$2

  if grep -Fq -- "$unexpected" "$file"; then
    fail "$file leaked: $unexpected"
  fi
}

worker_environment_allowlist_keys() {
  local source_file=$1

  awk '
    /^application_environment_allowlist\(\) \{$/ {
      in_allowlist_function = 1
      next
    }
    in_allowlist_function && /^    worker\)$/ {
      in_worker_branch = 1
      next
    }
    in_worker_branch && /^      ;;$/ {
      found_worker_branch_end = 1
      exit
    }
    in_worker_branch {
      remainder = $0
      while (match(remainder, /"[A-Z][A-Z0-9_]*"/)) {
        print substr(remainder, RSTART + 1, RLENGTH - 2)
        remainder = substr(remainder, RSTART + RLENGTH)
      }
    }
    END {
      if (!in_allowlist_function || !in_worker_branch ||
          !found_worker_branch_end) {
        exit 2
      }
    }
  ' "$source_file"
}

[[ -f "$helper" ]] || fail "$helper is missing"

worker_allowlist_keys=$(worker_environment_allowlist_keys "$provisioner") ||
  fail "could not parse the worker environment allowlist contract"
for required_worker_key in \
  DATABASE_URL \
  REDIS_URL \
  QUEUE_ALERT \
  QUEUE_PROBE \
  QUEUE_INVITE \
  SCHEDULER_LEASE_TTL_MS \
  WORKER_SHUTDOWN_TIMEOUT_MS \
  WORKER_READINESS_PATH; do
  grep -Fxq -- "$required_worker_key" <<<"$worker_allowlist_keys" ||
    fail "worker environment allowlist omitted $required_worker_key"
done
legacy_worker_queue_key=QUEUE_"ESCALATION"
if grep -Fxq -- "$legacy_worker_queue_key" <<<"$worker_allowlist_keys"; then
  fail "worker environment allowlist retained a legacy queue key"
fi

mock_bin="$test_root/bin"
mkdir -p "$mock_bin"
cat >"$mock_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

config_file=
output_file=
write_out=
method=GET
data_file=
url=

while (($# > 0)); do
  case "$1" in
    --config)
      config_file=$2
      shift 2
      ;;
    --output)
      output_file=$2
      shift 2
      ;;
    --write-out)
      write_out=$2
      shift 2
      ;;
    --request)
      method=$2
      shift 2
      ;;
    --data-binary)
      data_file=${2#@}
      shift 2
      ;;
    --header)
      shift 2
      ;;
    --*)
      shift
      ;;
    *)
      url=$1
      shift
      ;;
  esac
done

tr '\0' ' ' <"/proc/$$/cmdline" >>"$MOCK_CURL_ARGV_LOG"
printf '\n' >>"$MOCK_CURL_ARGV_LOG"

[[ -n $config_file && -f $config_file ]] || exit 91
[[ $(stat -c '%a' "$config_file") == 600 ]] || exit 92
[[ $(stat -c '%a' "$(dirname "$config_file")") == 700 ]] || exit 93
grep -Fq 'fail-with-body' "$config_file" || exit 94
grep -Fq 'silent' "$config_file" || exit 95
grep -Fq 'show-error' "$config_file" || exit 96
grep -Fq 'header = "x-api-key: helper-test-api-key"' "$config_file" || exit 97
if grep -Fiq 'authorization' "$config_file"; then
  exit 98
fi

printf '%s %s\n' "$method" "${url#https://dokploy.test}" >>"$MOCK_CURL_REQUEST_LOG"

body='{}'
status=200
case "${url#https://dokploy.test}" in
  /api/trpc/application.one?input=*)
    body='{"result":{"data":{"json":{"applicationId":"app-id","stopGracePeriodSwarm":"60000000000"},"meta":{"values":{"stopGracePeriodSwarm":["bigint"]}}}}}'
    ;;
  /api/trpc/application.update)
    [[ -n $data_file && -f $data_file ]] || exit 99
    jq -e '
      .json.applicationId == "app-id" and
      .json.stopGracePeriodSwarm == "60000000000" and
      .meta.values.stopGracePeriodSwarm == ["bigint"]
    ' "$data_file" >/dev/null || exit 100
    body='{"result":{"data":{"json":true}}}'
    ;;
  /api/trpc/domain.one?input=*)
    body='{"result":{"data":{"json":{"domainId":"domain-id","application":{"stopGracePeriodSwarm":"60000000000"}},"meta":{"values":{"application.stopGracePeriodSwarm":["bigint"]}}}}}'
    ;;
  /api/trpc/domain.byApplicationId?input=*)
    body='{"result":{"data":{"json":[{"domainId":"domain-id","application":{"stopGracePeriodSwarm":"60000000000"}}],"meta":{"values":{"0.application.stopGracePeriodSwarm":["bigint"]}}}}}'
    ;;
  /api/domain.byComposeId?composeId=compose-id)
    body='[]'
    ;;
  /api/trpc/project.all?input=*)
    body='{"result":{"data":{"json":[{"projectId":"project-id","name":"SystemVitals","organizationId":"secret-org","environments":[{"environmentId":"environment-id","name":"production","applications":[{"applicationId":"app-id","name":"SystemVitals API","appName":"systemvitals-api","applicationStatus":"done","env":"NESTED_DISCOVERY_SECRET","stopGracePeriodSwarm":"60000000000"}],"compose":[{"composeId":"compose-id","name":"SystemVitals Stack","appName":"systemvitals-stack","composeStatus":"done","env":"NESTED_COMPOSE_SECRET"}]}]}],"meta":{"values":{"0.environments.0.applications.0.stopGracePeriodSwarm":["bigint"]}}}}}'
    ;;
  /api/trpc/project.one?input=*)
    body='{"result":{"data":{"json":{"projectId":"project-id","name":"SystemVitals","organizationId":"secret-org","environments":[{"environmentId":"environment-id","name":"production","applications":[{"applicationId":"app-id","name":"SystemVitals API","appName":"systemvitals-api","applicationStatus":"done","env":"NESTED_DISCOVERY_SECRET","stopGracePeriodSwarm":"60000000000"}],"compose":[{"composeId":"compose-id","name":"SystemVitals Stack","appName":"systemvitals-stack","composeStatus":"done","env":"NESTED_COMPOSE_SECRET"}]}]},"meta":{"values":{"environments.0.applications.0.stopGracePeriodSwarm":["bigint"]}}}}}'
    ;;
  /api/example.one)
    body='{"items":[{"id":"one"}]}'
    ;;
  /api/example.create)
    [[ -n $data_file && -f $data_file ]] || exit 99
    jq -e '.secret == "PAYLOAD_SECRET"' "$data_file" >/dev/null || exit 100
    body='{"ok":true}'
    ;;
  /api/fail)
    body='{"env":"LEAK_RESPONSE_SECRET","message":"LEAK_RESPONSE_SECRET"}'
    status=500
    printf '%s\n' \
      'curl: x-api-key: helper-test-api-key LEAK_RESPONSE_SECRET' >&2
    ;;
  *)
    exit 101
    ;;
esac

printf '%s' "$body" >"$output_file"
printf '%s' "$status"
if ((status >= 400)); then
  exit 22
fi
EOF
chmod +x "$mock_bin/curl"

curl_argv_log="$test_root/curl-argv.log"
curl_request_log="$test_root/curl-requests.log"
helper_output="$test_root/helper-output"
helper_error="$test_root/helper-error"

if ! PATH="$mock_bin:$PATH" \
  MOCK_CURL_ARGV_LOG="$curl_argv_log" \
  MOCK_CURL_REQUEST_LOG="$curl_request_log" \
  DOKPLOY_URL=https://dokploy.test \
  DOKPLOY_API_KEY=helper-test-api-key \
  bash -c '
    set -euo pipefail
    source "$1"
    dokploy_get "/api/example.one"
    dokploy_post "/api/example.create" "{\"secret\":\"PAYLOAD_SECRET\"}"
    dokploy_trpc_get "application.one" "{\"applicationId\":\"app-id\"}"
    dokploy_trpc_post_bigints "application.update" \
      "{\"applicationId\":\"app-id\",\"stopGracePeriodSwarm\":60000000000}" \
      stopGracePeriodSwarm
    dokploy_trpc_get "domain.one" "{\"domainId\":\"domain-id\"}"
    dokploy_trpc_get \
      "domain.byApplicationId" "{\"applicationId\":\"app-id\"}"
    dokploy_get "/api/domain.one?domainId=domain-id"
    dokploy_get \
      "/api/domain.byApplicationId?applicationId=app-id"
    dokploy_get "/api/domain.byComposeId?composeId=compose-id"
    dokploy_get "/api/project.all"
    dokploy_get "/api/project.one?projectId=project-id"
  ' _ "$helper" >"$helper_output" 2>"$helper_error"; then
  command cat "$helper_error" >&2
  fail "Dokploy helper compatibility requests failed"
fi

assert_contains "$helper_output" '{"items":[{"id":"one"}]}'
assert_contains "$helper_output" '{"ok":true}'
assert_contains "$helper_output" \
  '{"applicationId":"app-id","stopGracePeriodSwarm":60000000000}'
assert_contains "$helper_output" \
  '{"domainId":"domain-id","application":{"stopGracePeriodSwarm":60000000000}}'
assert_contains "$helper_output" \
  '[{"domainId":"domain-id","application":{"stopGracePeriodSwarm":60000000000}}]'
assert_contains "$helper_output" '{"domainId":"domain-id"}'
assert_contains "$helper_output" '[{"domainId":"domain-id"}]'
assert_contains "$helper_output" \
  '[{"projectId":"project-id","name":"SystemVitals","environments":[{"environmentId":"environment-id","name":"production","applications":[{"applicationId":"app-id","name":"SystemVitals API","appName":"systemvitals-api","applicationStatus":"done"}],"compose":[{"composeId":"compose-id","name":"SystemVitals Stack","appName":"systemvitals-stack","composeStatus":"done"}]}]}]'
assert_contains "$curl_request_log" 'GET /api/example.one'
assert_contains "$curl_request_log" 'POST /api/example.create'
assert_contains "$curl_request_log" 'GET /api/trpc/application.one?input='
assert_contains "$curl_request_log" 'POST /api/trpc/application.update'
assert_contains "$curl_request_log" 'GET /api/trpc/domain.one?input='
assert_contains "$curl_request_log" \
  'GET /api/trpc/domain.byApplicationId?input='
assert_contains "$curl_request_log" \
  'GET /api/domain.byComposeId?composeId=compose-id'
assert_not_contains "$curl_request_log" 'GET /api/domain.one?'
assert_not_contains "$curl_request_log" \
  'GET /api/domain.byApplicationId?'
assert_contains "$curl_request_log" 'GET /api/trpc/project.all?input='
assert_contains "$curl_request_log" 'GET /api/trpc/project.one?input='
assert_not_contains "$curl_request_log" 'GET /api/project.all'
assert_not_contains "$curl_request_log" 'GET /api/project.one?'
assert_not_contains "$helper_output" 'NESTED_DISCOVERY_SECRET'
assert_not_contains "$helper_output" 'NESTED_COMPOSE_SECRET'
assert_not_contains "$curl_argv_log" 'NESTED_DISCOVERY_SECRET'
assert_not_contains "$curl_argv_log" 'NESTED_COMPOSE_SECRET'
assert_not_contains "$curl_argv_log" 'helper-test-api-key'
assert_not_contains "$curl_argv_log" 'PAYLOAD_SECRET'
assert_not_contains "$helper_output" 'helper-test-api-key'
assert_not_contains "$helper_error" 'helper-test-api-key'

if PATH="$mock_bin:$PATH" \
  MOCK_CURL_ARGV_LOG="$curl_argv_log" \
  MOCK_CURL_REQUEST_LOG="$curl_request_log" \
  DOKPLOY_URL=https://dokploy.test \
  DOKPLOY_API_KEY=helper-test-api-key \
  bash -c '
    set -euo pipefail
    source "$1"
    dokploy_get "/api/fail"
  ' _ "$helper" >"$helper_output" 2>"$helper_error"; then
  fail "failed Dokploy request unexpectedly succeeded"
fi
assert_not_contains "$helper_output" 'LEAK_RESPONSE_SECRET'
assert_not_contains "$helper_error" 'LEAK_RESPONSE_SECRET'
assert_not_contains "$helper_error" 'helper-test-api-key'
assert_contains "$helper_error" 'Dokploy GET /api/fail failed'

selected=$(DOKPLOY_URL=https://dokploy.test \
  DOKPLOY_API_KEY=helper-test-api-key \
  bash -c '
    set -euo pipefail
    source "$1"
    printf "%s" "{\"items\":[{\"id\":\"one\"}]}" |
      dokploy_expect_one ".items[]" "test item"
  ' _ "$helper")
jq -e '.id == "one"' <<<"$selected" >/dev/null ||
  fail "dokploy_expect_one did not return the unique match"

if DOKPLOY_URL=https://dokploy.test \
  DOKPLOY_API_KEY=helper-test-api-key \
  bash -c '
    set -euo pipefail
    source "$1"
    printf "%s" "{\"items\":[{\"id\":\"one\"},{\"id\":\"two\"}]}" |
      dokploy_expect_one ".items[]" "test item"
  ' _ "$helper" >"$helper_output" 2>"$helper_error"; then
  fail "dokploy_expect_one accepted duplicate matches"
fi
assert_contains "$helper_error" 'expected exactly one test item'

helper_tmp_path=$(PATH="$mock_bin:$PATH" \
  MOCK_CURL_ARGV_LOG="$curl_argv_log" \
  MOCK_CURL_REQUEST_LOG="$curl_request_log" \
  DOKPLOY_URL=https://dokploy.test \
  DOKPLOY_API_KEY=helper-test-api-key \
  bash -c '
    set -euo pipefail
    source "$1"
    dokploy_get "/api/example.one" >/dev/null
    printf "%s" "$DOKPLOY_API_TMPDIR"
  ' _ "$helper")
[[ ! -e $helper_tmp_path ]] ||
  fail "Dokploy helper temporary directory was not removed on exit"

[[ -x $provisioner ]] || fail "$provisioner is missing or not executable"

provision_bin="$test_root/provision-bin"
mkdir -p "$provision_bin"
real_jq=$(command -v jq)
cat >"$provision_bin/jq" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

parent_argv=$(tr '\0' ' ' <"/proc/$PPID/cmdline")
if [[ $parent_argv != *"/provision-bin/curl"* &&
  $parent_argv != *"/provision-bin/docker"* ]]; then
  tr '\0' ' ' <"/proc/$$/cmdline" >>"$MOCK_JQ_ARGV_LOG"
  printf '\n' >>"$MOCK_JQ_ARGV_LOG"
fi
exec "$REAL_JQ" "$@"
EOF
chmod +x "$provision_bin/jq"

cat >"$provision_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

config_file=
output_file=
method=GET
data_file=
url=

while (($# > 0)); do
  case "$1" in
    --config)
      config_file=$2
      shift 2
      ;;
    --output)
      output_file=$2
      shift 2
      ;;
    --write-out)
      shift 2
      ;;
    --request)
      method=$2
      shift 2
      ;;
    --data-binary)
      data_file=${2#@}
      shift 2
      ;;
    --header)
      shift 2
      ;;
    --*)
      shift
      ;;
    *)
      url=$1
      shift
      ;;
  esac
done

tr '\0' ' ' <"/proc/$$/cmdline" >>"$MOCK_CURL_ARGV_LOG"
printf '\n' >>"$MOCK_CURL_ARGV_LOG"

path=${url#https://dokploy.test}

if [[ $url != https://dokploy.test/* ]]; then
  public_check=
  case "$method $url" in
    "GET https://api.systemvitals.link/health/ready" | \
    "GET https://api-staging.systemvitals.link/health/ready")
      public_check=api-readiness
      body='{"status":"ready"}'
      ;;
    "POST https://api.systemvitals.link/graphql" | \
    "POST https://api-staging.systemvitals.link/graphql")
      [[ -n $data_file && -f $data_file ]] || exit 89
      if [[ -n $config_file ]]; then
        public_check=authenticated-read
        [[ -f $config_file && $(stat -c '%a' "$config_file") == 600 ]] ||
          exit 88
        grep -Fq \
          "header = \"Authorization: Bearer $MOCK_EXPECTED_CUTOVER_TOKEN\"" \
          "$config_file" || exit 87
        jq -e '.query == "{me{id}}"' "$data_file" >/dev/null || exit 86
        body='{"data":{"me":{"id":"user-id"}}}'
      else
        public_check=api-graphql
        jq -e '.query == "{health}"' "$data_file" >/dev/null || exit 85
        body='{"data":{"health":"ok"}}'
      fi
      ;;
    "GET https://systemvitals.link/api/health" | \
    "GET https://staging.systemvitals.link/api/health")
      public_check=frontend-health
      body='{"status":"ok"}'
      ;;
    "GET https://systemvitals.link/login" | \
    "GET https://staging.systemvitals.link/login")
      public_check=frontend-login
      body='<!doctype html><title>Log in</title>'
      ;;
    *)
      exit 84
      ;;
  esac
  printf 'PUBLIC %s %s CHECK %s\n' \
    "$method" "$url" "$public_check" >>"$MOCK_CURL_REQUEST_LOG"
  printf 'PUBLIC %s %s CHECK %s\n' \
    "$method" "$url" "$public_check" >>"$MOCK_OPERATION_LOG"
  status=200
  if [[ ${MOCK_PUBLIC_FAIL_CHECK:-} == "$public_check" ]]; then
    status=503
    body='{"status":"unavailable"}'
  fi
  if [[ ${MOCK_PUBLIC_TRANSIENT_FAIL_CHECK:-} == "$public_check" &&
    -n ${MOCK_PUBLIC_FAILURES_REMAINING_FILE:-} ]]; then
    failures_remaining=$(<"$MOCK_PUBLIC_FAILURES_REMAINING_FILE")
    if ((failures_remaining > 0)); then
      printf '%s\n' "$((failures_remaining - 1))" \
        >"$MOCK_PUBLIC_FAILURES_REMAINING_FILE"
      status=503
      body='{"status":"unavailable"}'
    fi
  fi
  if [[ ${MOCK_PUBLIC_FAIL_AFTER_LEGACY_DELETE:-0} == 1 &&
    $(jq '.domains | length' "$MOCK_COMPOSE_STATE") -lt 2 ]]; then
    status=503
    body='{"status":"unavailable"}'
  fi
  [[ -n $output_file ]] && printf '%s' "$body" >"$output_file"
  printf '%s' "$status"
  ((status < 400)) || exit 22
  exit 0
fi

[[ -f $config_file ]] || exit 91
grep -Fq 'header = "x-api-key: provision-test-api-key"' "$config_file" ||
  exit 92
if grep -Fiq 'authorization' "$config_file"; then
  exit 93
fi

printf '%s %s\n' "$method" "$path" >>"$MOCK_CURL_REQUEST_LOG"
printf 'API %s %s\n' "$method" "$path" >>"$MOCK_OPERATION_LOG"

write_json() {
  local value=$1

  printf '%s' "$value" >"$output_file"
  printf '200'
}

read_payload() {
  [[ -n $data_file && -f $data_file ]] || exit 94
  command cat "$data_file"
}

application_file() {
  local application_id=$1

  printf '%s/%s.json' "$MOCK_APPLICATION_DIR" "$application_id"
}

verify_no_pending_mutation() {
  [[ ! -e $MOCK_PENDING_MUTATION ]] || {
    printf '%s\n' "mutation was not read back: $(cat "$MOCK_PENDING_MUTATION")" >&2
    exit 95
  }
}

record_pending_mutation() {
  local kind=$1
  local object_id=$2

  printf '%s %s\n' "$kind" "$object_id" >"$MOCK_PENDING_MUTATION"
}

clear_matching_pending_mutation() {
  local kind=$1
  local object_id=$2

  if [[ -e $MOCK_PENDING_MUTATION ]] &&
    [[ $(cat "$MOCK_PENDING_MUTATION") == "$kind $object_id" ]]; then
    rm -f "$MOCK_PENDING_MUTATION"
  fi
}

case "$method $path" in
  "GET /api/trpc/project.all?input="*)
    encoded_input=${path#*input=}
    input=$(printf '%b' "${encoded_input//%/\\x}")
    jq -e '.json == null' <<<"$input" >/dev/null || exit 103
    if [[ ${MOCK_DUPLICATE_PROJECT:-0} == 1 ]]; then
      projects_json=$(jq '[., .] | flatten' "$MOCK_DOKPLOY_STATE")
    elif [[ ${MOCK_DUPLICATE_ENVIRONMENT:-0} == 1 ]]; then
      projects_json=$(jq \
        '.[0].environments += [.[0].environments[0]]' \
        "$MOCK_DOKPLOY_STATE")
    elif [[ ${MOCK_DUPLICATE_COMPOSE:-0} == 1 ]]; then
      projects_json=$(jq '.[0].environments[0].compose +=
        [.[0].environments[0].compose[0]]' "$MOCK_DOKPLOY_STATE")
    elif [[ ${MOCK_DUPLICATE_APPLICATION:-0} == 1 ]]; then
      projects_json=$(jq '.[0].environments[0].applications = [
        {
          applicationId: "api-one",
          name: "SystemVitals API",
          appName: "systemvitals-api-one",
          applicationStatus: "done"
        },
        {
          applicationId: "api-two",
          name: "SystemVitals API",
          appName: "systemvitals-api-two",
          applicationStatus: "done"
        }
      ]' "$MOCK_DOKPLOY_STATE")
    else
      projects_json=$(command cat "$MOCK_DOKPLOY_STATE")
    fi
    jq -cn --argjson projects "$projects_json" '
      ($projects | map(
        .environments |= map(
          .compose |= map(
            . + {env: "NESTED_COMPOSE_SECRET"}
          ) |
          .applications |= map(
            . + {
              env: "NESTED_DISCOVERY_SECRET",
              stopGracePeriodSwarm: "60000000000"
            }
          )
        )
      )) as $json |
      {
        result: {
          data: {
            json: $json,
            meta: {
              values: (
                reduce range(0; $json | length) as $project_index ({};
                  reduce range(
                    0;
                    $json[$project_index].environments | length
                  ) as $environment_index (.;
                    reduce range(
                      0;
                      $json[$project_index]
                        .environments[$environment_index]
                        .applications | length
                    ) as $application_index (.;
                      .[
                        "\($project_index).environments." +
                        "\($environment_index).applications." +
                        "\($application_index).stopGracePeriodSwarm"
                      ] = ["bigint"]
                    )
                  )
                )
              )
            }
          }
        }
      }
    '
    ;;
  "GET /api/compose.one?composeId=compose-id")
    clear_matching_pending_mutation compose compose-id
    command cat "$MOCK_COMPOSE_STATE"
    ;;
  "GET /api/compose.loadServices?composeId=compose-id&type=cache")
    if [[ ${MOCK_UNEXPECTED_OLD_SERVICE:-0} == 1 ]]; then
      printf '%s\n' \
        '["postgres","redis","migrate","api","worker","frontend","mystery"]'
    elif jq -e \
      '.composePath == "./docker-compose.infrastructure.yml"' \
      "$MOCK_COMPOSE_STATE" >/dev/null; then
      printf '%s\n' '["postgres","redis"]'
    else
      printf '%s\n' \
        '["postgres","redis","migrate","api","worker","frontend"]'
    fi
    ;;
  "GET /api/trpc/application.one?input="*)
    encoded_input=${path#*input=}
    input=$(printf '%b' "${encoded_input//%/\\x}")
    application_id=$(jq -r '.json.applicationId' <<<"$input")
    clear_matching_pending_mutation application "$application_id"
    jq '
      if .stopGracePeriodSwarm == null then
        {result:{data:{json:.,meta:{values:{}}}}}
      else
        {
          result: {
            data: {
              json: (. | .stopGracePeriodSwarm |= tostring),
              meta: {
                values: {
                  stopGracePeriodSwarm: ["bigint"]
                }
              }
            }
          }
        }
      end
    ' "$(application_file "$application_id")"
    ;;
  "GET /api/trpc/domain.byApplicationId?input="*)
    encoded_input=${path#*input=}
    input=$(printf '%b' "${encoded_input//%/\\x}")
    application_id=$(jq -r '.json.applicationId' <<<"$input")
    clear_matching_pending_mutation domain-list "$application_id"
    if [[ ${MOCK_FINAL_TOPOLOGY_DRIFT:-0} == 1 &&
      $(jq '.domains | length' "$MOCK_COMPOSE_STATE") == 0 &&
      ! -e $MOCK_FINAL_TOPOLOGY_DRIFT_FILE ]]; then
      : >"$MOCK_FINAL_TOPOLOGY_DRIFT_FILE"
      domains_json=$(jq --arg application_id "$application_id" '
        [
          .[] |
          select(.applicationId == $application_id)
        ] + [{
          domainId: "unexpected-duplicate",
          host: "api.systemvitals.link",
          applicationId: $application_id
        }]
      ' "$MOCK_DOMAIN_STATE")
    else
      domains_json=$(jq --arg application_id "$application_id" '
      [
        .[] |
        select(.applicationId == $application_id)
      ]
      ' "$MOCK_DOMAIN_STATE")
    fi
    jq -cn \
      --argjson domains "$domains_json" \
      --slurpfile application "$(application_file "$application_id")" '
        ($domains | map(. + {application: $application[0]})) as $domains |
        {
          result: {
            data: {
              json: (
                $domains |
                map(.application.stopGracePeriodSwarm |= tostring)
              ),
              meta: {
                values: (
                  reduce range(0; $domains | length) as $index ({};
                    .["\($index).application.stopGracePeriodSwarm"] =
                      ["bigint"]
                  )
                )
              }
            }
          }
        }
      '
    ;;
  "GET /api/domain.byComposeId?composeId=compose-id")
    clear_matching_pending_mutation domain-list compose-id
    if [[ ${MOCK_COMPOSE_DOMAIN_DRIFT:-0} == 1 ]]; then
      printf '%s\n' '[{
        "domainId":"drift-domain",
        "host":"api.systemvitals.link",
        "port":8888,
        "https":true,
        "path":"/",
        "serviceName":"api",
        "domainType":"compose",
        "certificateType":"letsencrypt",
        "composeId":"compose-id",
        "applicationId":null
      }]'
    else
      jq '.domains' "$MOCK_COMPOSE_STATE"
    fi
    ;;
  "GET /api/trpc/domain.one?input="*)
    encoded_input=${path#*input=}
    input=$(printf '%b' "${encoded_input//%/\\x}")
    domain_id=$(jq -r '.json.domainId' <<<"$input")
    clear_matching_pending_mutation domain "$domain_id"
    domain_json=$(jq -s --arg domain_id "$domain_id" '
      (.[0] + .[1].domains)[] |
      select(.domainId == $domain_id)
    ' "$MOCK_DOMAIN_STATE" "$MOCK_COMPOSE_STATE")
    application_id=$(jq -r '.applicationId // empty' <<<"$domain_json")
    if [[ -n $application_id ]]; then
      jq -cn \
        --argjson domain "$domain_json" \
        --slurpfile application "$(application_file "$application_id")" '
          {
            result: {
              data: {
                json: (
                  $domain + {application: $application[0]} |
                  .application.stopGracePeriodSwarm |= tostring
                ),
                meta: {
                  values: {
                    "application.stopGracePeriodSwarm": ["bigint"]
                  }
                }
              }
            }
          }
        '
    else
      jq -cn --argjson domain "$domain_json" \
        '{result:{data:{json:($domain + {application:null}),meta:{values:{}}}}}'
    fi
    ;;
  "GET /api/docker.getServiceContainersByAppName?appName="*)
    app_name=${path#*appName=}
    if [[ ${MOCK_UNHEALTHY_APPLICATION:-} == "$app_name" ]]; then
      jq -n --arg app_name "$app_name" '[{
        containerId: ($app_name + "-task"),
        name: ($app_name + ".1"),
        state: "running",
        currentState: "Rejected 2 seconds ago",
        node: "test-node",
        error: "health check failed"
      }]'
    else
      case "${MOCK_TASK_ERROR_MODE:-sentinel}" in
        empty)
          task_error='""'
          ;;
        null)
          task_error=null
          ;;
        sentinel)
          task_error='"Error:"'
          ;;
        trimmed-sentinel)
          task_error='"  Error:  "'
          ;;
        message)
          task_error='"Error: health check failed"'
          ;;
        other)
          task_error='"health check failed"'
          ;;
        *)
          exit 104
          ;;
      esac
      tasks=$(jq -n \
        --arg app_name "$app_name" \
        --argjson task_error "$task_error" '[{
        containerId: ($app_name + "-task"),
        name: ($app_name + ".1"),
        state: "running",
        currentState: "Running 1 minute ago",
        node: "test-node",
        error: $task_error
      }]')
      if [[ ${MOCK_MULTIPLE_RUNNING_TASKS:-0} == 1 ]]; then
        jq '. + [.[0] * {
          containerId: "second-running-task",
          name: "second-running-task"
        }]' <<<"$tasks"
      else
        printf '%s\n' "$tasks"
      fi
    fi
    ;;
  "GET /api/docker.getContainersByAppLabel?appName="*"&type=swarm")
    app_name=${path#*appName=}
    app_name=${app_name%%&*}
    jq -n --arg app_name "$app_name" '[{
      containerId: ($app_name + "-container"),
      name: ($app_name + ".1"),
      state: "running"
    }]'
    ;;
  "GET /api/docker.getConfig?containerId="*)
    container_id=${path##*=}
    app_name=${container_id%-container}
    health_status=healthy
    if [[ ${MOCK_UNHEALTHY_APPLICATION:-} == "$app_name" ]]; then
      health_status=unhealthy
    fi
    jq -n \
      --arg container_id "$container_id" \
      --arg health_status "$health_status" '{
        Id: $container_id,
        Name: ("/" + $container_id),
        State: {
          Status: "running",
          Health: {
            Status: $health_status
          }
        }
      }'
    ;;
  "GET /api/docker.getContainersByAppNameMatch?appName=systemvitals-stack-test&appType=docker-compose")
    if [[ -n ${MOCK_COMPOSE_CONTAINERS:-} ]]; then
      printf '%s\n' "$MOCK_COMPOSE_CONTAINERS"
    elif [[ -e ${MOCK_STATELESS_REMOVED:-/nonexistent} ]]; then
      if [[ ${MOCK_POST_REMOVAL_EMPTY:-0} == 1 ]]; then
        printf '%s\n' '[]'
      else
        printf '%s\n' '[
          {
            "containerId":"postgres-container-id",
            "name":"systemvitals-stack-test-postgres-1",
            "state":"running",
            "status":"Up 1 day (healthy)"
          },
          {
            "containerId":"redis-container-id",
            "name":"systemvitals-stack-test-redis-1",
            "state":"running",
            "status":"Up 1 day (healthy)"
          }
        ]'
      fi
    elif [[ ${MOCK_OLD_WORKER_RUNNING:-0} == 1 ]]; then
      printf '%s\n' '[
        {
          "containerId":"postgres-container-id",
          "name":"systemvitals-stack-test-postgres-1",
          "state":"running",
          "status":"Up 1 day (healthy)"
        },
        {
          "containerId":"redis-container-id",
          "name":"systemvitals-stack-test-redis-1",
          "state":"running",
          "status":"Up 1 day (healthy)"
        },
        {
          "containerId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "name":"systemvitals-stack-test-worker-1",
          "state":"running",
          "status":"Up 1 day (healthy)"
        }
      ]'
    else
      printf '%s\n' '[
        {
          "containerId":"postgres-container-id",
          "name":"systemvitals-stack-test-postgres-1",
          "state":"running",
          "status":"Up 1 day (healthy)"
        },
        {
          "containerId":"redis-container-id",
          "name":"systemvitals-stack-test-redis-1",
          "state":"running",
          "status":"Up 1 day (healthy)"
        },
        {
          "containerId":"legacy-api-container",
          "name":"systemvitals-stack-test-api-1",
          "state":"running",
          "status":"Up 1 day (healthy)"
        },
        {
          "containerId":"0123456789ab",
          "name":"systemvitals-stack-test-worker-1",
          "state":"exited",
          "status":"Exited (0) 1 minute ago"
        },
        {
          "containerId":"legacy-frontend-container",
          "name":"systemvitals-stack-test-frontend-1",
          "state":"running",
          "status":"Up 1 day (healthy)"
        },
        {
          "containerId":"legacy-migrate-container",
          "name":"systemvitals-stack-test-migrate-1",
          "state":"exited",
          "status":"Exited (0) 1 day ago"
        }
      ]'
    fi
    ;;
  "POST /api/application.create")
    verify_no_pending_mutation
    payload=$(read_payload)
    name=$(jq -r '.name' <<<"$payload")
    environment_id=$(jq -r '.environmentId' <<<"$payload")
    case "$name" in
      "SystemVitals API")
        application_id=api-id
        app_name=systemvitals-api-test
        ;;
      "SystemVitals Worker")
        application_id=worker-id
        app_name=systemvitals-worker-test
        ;;
      "SystemVitals Frontend")
        application_id=frontend-id
        app_name=systemvitals-frontend-test
        ;;
      *)
        exit 96
        ;;
    esac
    if jq -e --arg name "$name" '
      any(.[0].environments[0].applications[]?; .name == $name)
    ' "$MOCK_DOKPLOY_STATE" >/dev/null; then
      exit 97
    fi
    state_tmp="$MOCK_DOKPLOY_STATE.tmp"
    jq \
      --arg application_id "$application_id" \
      --arg name "$name" \
      --arg app_name "$app_name" '
        .[0].environments[0].applications += [{
          applicationId: $application_id,
          name: $name,
          appName: $app_name,
          applicationStatus: "idle"
        }]
      ' "$MOCK_DOKPLOY_STATE" >"$state_tmp"
    mv "$state_tmp" "$MOCK_DOKPLOY_STATE"
    jq -n \
      --arg application_id "$application_id" \
      --arg name "$name" \
      --arg app_name "$app_name" \
      --arg environment_id "$environment_id" '{
        applicationId: $application_id,
        name: $name,
        appName: $app_name,
        environmentId: $environment_id,
        applicationStatus: "idle",
        sourceType: "github",
        owner: null,
        repository: null,
        branch: null,
        buildPath: "/",
        githubId: null,
        triggerType: "push",
        enableSubmodules: false,
        buildType: "nixpacks",
        dockerfile: "Dockerfile",
        dockerContextPath: null,
        dockerBuildStage: null,
        env: null,
        buildArgs: null,
        buildSecrets: null,
        createEnvFile: true,
        autoDeploy: true,
        replicas: 1,
        healthCheckSwarm: null,
        restartPolicySwarm: null,
        updateConfigSwarm: null,
        modeSwarm: null,
        networkSwarm: null,
        stopGracePeriodSwarm: null,
        endpointSpecSwarm: null,
        domains: [],
        ports: [],
        deployments: []
      }' >"$(application_file "$application_id")"
    record_pending_mutation application "$application_id"
    jq -n \
      --arg application_id "$application_id" \
      --arg name "$name" \
      --arg app_name "$app_name" \
      --arg environment_id "$environment_id" '{
        applicationId: $application_id,
        name: $name,
        appName: $app_name,
        environmentId: $environment_id
      }'
    ;;
  "POST /api/application.saveGithubProvider")
    verify_no_pending_mutation
    payload=$(read_payload)
    application_id=$(jq -r '.applicationId' <<<"$payload")
    app_file=$(application_file "$application_id")
    if [[ ${MOCK_NOOP_MUTATION:-} != application.saveGithubProvider ]]; then
      app_tmp="$app_file.tmp"
      jq --argjson payload "$payload" '
        . * ($payload | del(.applicationId)) * {sourceType: "github"}
      ' "$app_file" >"$app_tmp"
      mv "$app_tmp" "$app_file"
    fi
    record_pending_mutation application "$application_id"
    printf 'true'
    ;;
  "POST /api/application.saveBuildType")
    verify_no_pending_mutation
    payload=$(read_payload)
    application_id=$(jq -r '.applicationId' <<<"$payload")
    app_file=$(application_file "$application_id")
    if [[ ${MOCK_NOOP_MUTATION:-} != application.saveBuildType ]]; then
      app_tmp="$app_file.tmp"
      jq --argjson payload "$payload" '
        . * ($payload | del(.applicationId))
      ' "$app_file" >"$app_tmp"
      mv "$app_tmp" "$app_file"
    fi
    record_pending_mutation application "$application_id"
    printf 'true'
    ;;
  "POST /api/application.saveEnvironment")
    verify_no_pending_mutation
    payload=$(read_payload)
    application_id=$(jq -r '.applicationId' <<<"$payload")
    app_file=$(application_file "$application_id")
    if [[ ${MOCK_NOOP_MUTATION:-} != application.saveEnvironment ]]; then
      app_tmp="$app_file.tmp"
      jq --argjson payload "$payload" '
        . * ($payload | del(.applicationId))
      ' "$app_file" >"$app_tmp"
      mv "$app_tmp" "$app_file"
    fi
    record_pending_mutation application "$application_id"
    printf 'true'
    ;;
  "POST /api/trpc/application.update")
    verify_no_pending_mutation
    payload=$(read_payload)
    jq -e '
      .meta.values.stopGracePeriodSwarm == ["bigint"] and
      (.json.stopGracePeriodSwarm | type) == "string"
    ' <<<"$payload" >/dev/null || exit 102
    application_id=$(jq -r '.json.applicationId' <<<"$payload")
    app_file=$(application_file "$application_id")
    if [[ ${MOCK_NOOP_MUTATION:-} != application.update ]]; then
      app_tmp="$app_file.tmp"
      jq --argjson payload "$payload" '
        . * (
          $payload.json |
          .stopGracePeriodSwarm |= tonumber |
          del(.applicationId)
        )
      ' "$app_file" >"$app_tmp"
      mv "$app_tmp" "$app_file"
    fi
    record_pending_mutation application "$application_id"
    printf '{"result":{"data":{"json":true}}}'
    ;;
  "POST /api/application.update")
    verify_no_pending_mutation
    payload=$(read_payload)
    application_id=$(jq -r '.applicationId' <<<"$payload")
    app_file=$(application_file "$application_id")
    if [[ ${MOCK_NOOP_MUTATION:-} != application.update ]]; then
      app_tmp="$app_file.tmp"
      jq --argjson payload "$payload" '
        . * ($payload | del(.applicationId))
      ' "$app_file" >"$app_tmp"
      mv "$app_tmp" "$app_file"
    fi
    record_pending_mutation application "$application_id"
    printf 'true'
    ;;
  "POST /api/compose.update")
    verify_no_pending_mutation
    payload=$(read_payload)
    compose_tmp="$MOCK_COMPOSE_STATE.tmp"
    jq --argjson payload "$payload" '
      . * ($payload | del(.composeId))
    ' "$MOCK_COMPOSE_STATE" >"$compose_tmp"
    mv "$compose_tmp" "$MOCK_COMPOSE_STATE"
    compose_name=$(jq -r '.name' "$MOCK_COMPOSE_STATE")
    state_tmp="$MOCK_DOKPLOY_STATE.tmp"
    jq --arg compose_name "$compose_name" '
      .[0].environments[0].compose[0].name = $compose_name
    ' "$MOCK_DOKPLOY_STATE" >"$state_tmp"
    mv "$state_tmp" "$MOCK_DOKPLOY_STATE"
    record_pending_mutation compose compose-id
    command cat "$MOCK_COMPOSE_STATE"
    ;;
  "POST /api/domain.create")
    verify_no_pending_mutation
    payload=$(read_payload)
    application_id=$(jq -r '.applicationId' <<<"$payload")
    host=$(jq -r '.host' <<<"$payload")
    printf 'DOMAIN CREATE %s %s\n' "$host" "$application_id" \
      >>"$MOCK_CURL_REQUEST_LOG"
    if [[ $application_id == null &&
      ${MOCK_FAIL_COMPOSE_RESTORE_HOST:-} == "$host" ]]; then
      exit 102
    fi
    case "$host" in
      api-staging.systemvitals.link)
        domain_id=api-temp-domain
        ;;
      staging.systemvitals.link)
        domain_id=frontend-temp-domain
        ;;
      api.systemvitals.link)
        domain_id="api-domain-$(date +%s%N)"
        ;;
      systemvitals.link)
        domain_id="frontend-domain-$(date +%s%N)"
        ;;
      api.systemvitals.nihey.org)
        domain_id="api-legacy-domain-$(date +%s%N)"
        ;;
      systemvitals.nihey.org)
        domain_id="frontend-legacy-domain-$(date +%s%N)"
        ;;
      *)
        exit 98
        ;;
    esac
    if [[ $application_id != null ]]; then
      domain_tmp="$MOCK_DOMAIN_STATE.tmp"
      jq --argjson payload "$payload" --arg domain_id "$domain_id" '
        . + [$payload + {
          domainId: $domain_id,
          composeId: null,
          serviceName: null
        }]
      ' "$MOCK_DOMAIN_STATE" >"$domain_tmp"
      mv "$domain_tmp" "$MOCK_DOMAIN_STATE"
      app_file=$(application_file "$application_id")
      app_tmp="$app_file.tmp"
      jq \
        --arg domain_id "$domain_id" \
        --arg host "$host" \
        '.domains += [{domainId: $domain_id, host: $host}]' \
        "$app_file" >"$app_tmp"
      mv "$app_tmp" "$app_file"
    else
      compose_tmp="$MOCK_COMPOSE_STATE.tmp"
      jq --argjson payload "$payload" --arg domain_id "$domain_id" '
        .domains += [$payload + {
          domainId: $domain_id,
          applicationId: null
        }]
      ' "$MOCK_COMPOSE_STATE" >"$compose_tmp"
      mv "$compose_tmp" "$MOCK_COMPOSE_STATE"
    fi
    record_pending_mutation domain "$domain_id"
    jq -s --arg domain_id "$domain_id" '
      (.[0] + .[1].domains)[] |
      select(.domainId == $domain_id)
    ' "$MOCK_DOMAIN_STATE" "$MOCK_COMPOSE_STATE"
    ;;
  "POST /api/domain.delete")
    verify_no_pending_mutation
    payload=$(read_payload)
    domain_id=$(jq -r '.domainId' <<<"$payload")
    domain=$(jq -s --arg domain_id "$domain_id" '
      (.[0] + .[1].domains)[] |
      select(.domainId == $domain_id)
    ' "$MOCK_DOMAIN_STATE" "$MOCK_COMPOSE_STATE")
    [[ -n $domain ]] || exit 100
    application_id=$(jq -r '.applicationId // empty' <<<"$domain")
    compose_owner=$(jq -r '.composeId // empty' <<<"$domain")
    domain_tmp="$MOCK_DOMAIN_STATE.tmp"
    jq --arg domain_id "$domain_id" \
      'map(select(.domainId != $domain_id))' \
      "$MOCK_DOMAIN_STATE" >"$domain_tmp"
    mv "$domain_tmp" "$MOCK_DOMAIN_STATE"
    compose_tmp="$MOCK_COMPOSE_STATE.tmp"
    jq --arg domain_id "$domain_id" \
      '.domains |= map(select(.domainId != $domain_id))' \
      "$MOCK_COMPOSE_STATE" >"$compose_tmp"
    mv "$compose_tmp" "$MOCK_COMPOSE_STATE"
    if [[ -n $application_id ]]; then
      app_file=$(application_file "$application_id")
      app_tmp="$app_file.tmp"
      jq --arg domain_id "$domain_id" \
        '.domains |= map(select(.domainId != $domain_id))' \
        "$app_file" >"$app_tmp"
      mv "$app_tmp" "$app_file"
      record_pending_mutation domain-list "$application_id"
    else
      [[ $compose_owner == compose-id ]] || exit 101
      record_pending_mutation domain-list compose-id
    fi
    printf 'true'
    ;;
  *)
    printf '%s\n' "unexpected endpoint: $method $path" >&2
    exit 99
    ;;
esac >"$output_file"
printf '200'
EOF
chmod +x "$provision_bin/curl"

state_file="$test_root/dokploy-state.json"
compose_state_file="$test_root/compose-state.json"
cat >"$state_file" <<'EOF'
[
  {
    "projectId": "project-id",
    "name": "SystemVitals",
    "environments": [
      {
        "environmentId": "environment-id",
        "name": "production",
        "applications": [],
        "compose": [
          {
            "composeId": "compose-id",
            "name": "SystemVitals Stack",
            "appName": "systemvitals-stack-test",
            "composeStatus": "done"
          }
        ]
      }
    ]
  }
]
EOF
cat >"$compose_state_file" <<'EOF'
{
  "composeId": "compose-id",
  "name": "SystemVitals Stack",
  "appName": "systemvitals-stack-test",
  "environmentId": "environment-id",
  "composeType": "docker-compose",
  "sourceType": "github",
  "owner": "nihey",
  "repository": "systemvitals",
  "branch": "main",
  "composePath": "./docker-compose.dokploy.yml",
  "autoDeploy": true,
  "composeStatus": "done",
  "serverId": null,
  "githubId": "github-provider-id",
  "env": "DATABASE_URL=PLAN_DATABASE_SECRET\nREDIS_URL=PLAN_REDIS_SECRET\nJWT_SECRET=PLAN_JWT_SECRET\nAPP_URL=https://systemvitals.nihey.org\nMIGRATION_RETRY_WINDOW_SECONDS=1800\nMIGRATION_RETRY_BASE_SECONDS=2\nMIGRATION_RETRY_MAX_SECONDS=30\nHTTP_DRAIN_DELAY_MS=5000\nHTTP_SHUTDOWN_TIMEOUT_MS=25000\nQUEUE_ALERT=alert\nQUEUE_PROBE=probe\nQUEUE_INVITE=invite\nWATCHDOG_INTERVAL_MS=30000\nPROBE_SCHEDULER_INTERVAL_MS=15000\nSCHEDULER_LEASE_TTL_MS=90000\nWORKER_SHUTDOWN_TIMEOUT_MS=45000\nWORKER_READINESS_PATH=/tmp/systemvitals-worker-ready\nWORKER_READINESS_HEARTBEAT_INTERVAL_MS=5000\nWORKER_READINESS_MAX_AGE_SECONDS=30\nSTRIPE_SECRET_KEY=STRIPE_SECRET_VALUE\nSTRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_VALUE\nSTRIPE_PRICE_SIGNAL=price_signal\nSTRIPE_PRICE_FLEET=price_fleet\nSMTP_HOST=smtp.test\nSMTP_PORT=587\nSMTP_USER=smtp-user\nSMTP_PASS=SMTP_SECRET_VALUE\nMAIL_FROM=alerts@systemvitals.test\nADMIN_EMAILS=admin@systemvitals.test\nGOOGLE_CLIENT_ID=google-client\nGOOGLE_CLIENT_SECRET=GOOGLE_SECRET_VALUE\nGOOGLE_CALLBACK_URL=https://api.systemvitals.nihey.org/auth/google/callback\nTELEGRAM_BOT_TOKEN=TEST_TELEGRAM_TOKEN\nTELEGRAM_WEBHOOK_SECRET=TEST_TELEGRAM_WEBHOOK_SECRET\nTELEGRAM_WEBHOOK_URL=https://api.systemvitals.nihey.org/integrations/telegram/webhook\nNEXT_PUBLIC_API_URL=https://api.systemvitals.nihey.org\nNEXT_PUBLIC_APP_URL=https://systemvitals.nihey.org\nNEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true\nPOSTGRES_PASSWORD=POSTGRES_SECRET_VALUE\nUNEXPECTED_SECRET=DO_NOT_COPY",
  "domains": [
    {
      "domainId": "frontend-domain-old",
      "host": "systemvitals.nihey.org",
      "https": true,
      "port": 9999,
      "path": "/",
      "serviceName": "frontend",
      "domainType": "compose",
      "certificateType": "letsencrypt",
      "customCertResolver": null,
      "internalPath": "/",
      "stripPath": false,
      "composeId": "compose-id",
      "applicationId": null
    },
    {
      "domainId": "api-domain-old",
      "host": "api.systemvitals.nihey.org",
      "https": true,
      "port": 8888,
      "path": "/",
      "serviceName": "api",
      "domainType": "compose",
      "certificateType": "letsencrypt",
      "customCertResolver": null,
      "internalPath": "/",
      "stripPath": false,
      "composeId": "compose-id",
      "applicationId": null
    }
  ]
}
EOF

provision_request_log="$test_root/provision-requests.log"
provision_argv_log="$test_root/provision-argv.log"
jq_argv_log="$test_root/jq-argv.log"
provision_output="$test_root/provision-output"
provision_error="$test_root/provision-error"
application_dir="$test_root/applications"
domain_state_file="$test_root/domains.json"
pending_mutation_file="$test_root/pending-mutation"
final_topology_drift_file="$test_root/final-topology-drift"
network_state_file="$test_root/network-created"
docker_mutation_log="$test_root/docker-mutations.log"
operation_log="$test_root/operations.log"
postgres_connected_file="$test_root/postgres-connected"
redis_connected_file="$test_root/redis-connected"
stateless_removed_file="$test_root/stateless-removed"
preflight_log="$test_root/preflight.log"
receipt_dir="$test_root/receipts"
mkdir -p "$application_dir"
printf '%s\n' '[]' >"$domain_state_file"

cat >"$provision_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'DOCKER' >>"$MOCK_OPERATION_LOG"
printf ' %q' "$@" >>"$MOCK_OPERATION_LOG"
printf '\n' >>"$MOCK_OPERATION_LOG"

case "${1:-} ${2:-}" in
  "network inspect")
    if [[ -e $MOCK_NETWORK_STATE ]]; then
      containers='{}'
      if [[ -e $MOCK_POSTGRES_CONNECTED ]]; then
        containers=$(jq -cn '{
          "postgres-container-id": {
            Name: "systemvitals-stack-test-postgres-1",
            IPv4Address: "10.0.0.2/24"
          }
        }')
      fi
      if [[ -e $MOCK_REDIS_CONNECTED ]]; then
        containers=$(jq -cn --argjson containers "$containers" '
          $containers + {
            "redis-container-id": {
              Name: "systemvitals-stack-test-redis-1",
              IPv4Address: "10.0.0.3/24"
            }
          }
        ')
      fi
      jq -n --argjson containers "$containers" '[{
        Name:"systemvitals-internal",
        Id:"network-id",
        Driver:"overlay",
        Scope:"swarm",
        Attachable:true,
        Containers:$containers
      }]'
    else
      exit 1
    fi
    ;;
  "network create")
    printf '%q ' "$@" >>"$MOCK_DOCKER_MUTATION_LOG"
    printf '\n' >>"$MOCK_DOCKER_MUTATION_LOG"
    : >"$MOCK_NETWORK_STATE"
    printf '%s\n' network-id
    ;;
  "network connect")
    printf '%q ' "$@" >>"$MOCK_DOCKER_MUTATION_LOG"
    printf '\n' >>"$MOCK_DOCKER_MUTATION_LOG"
    alias_name=$4
    container_id=$6
    case "$alias_name $container_id" in
      "sv-postgres postgres-container-id")
        : >"$MOCK_POSTGRES_CONNECTED"
        ;;
      "sv-redis redis-container-id")
        : >"$MOCK_REDIS_CONNECTED"
        ;;
      *)
        exit 82
        ;;
    esac
    ;;
  "ps -q")
    case "$*" in
      *"com.docker.compose.service=postgres"*)
        printf '%s\n' postgres-container-id
        ;;
      *"com.docker.compose.service=redis"*)
        printf '%s\n' redis-container-id
        ;;
      *)
        exit 83
        ;;
    esac
    ;;
  "inspect postgres-container-id")
    networks='{
      "systemvitals-stack-test_default": {
        "NetworkID":"legacy-network-id",
        "Aliases":["postgres"]
      }
    }'
    if [[ -e $MOCK_POSTGRES_CONNECTED ]]; then
      networks=$(jq -cn --argjson networks "$networks" '
        $networks + {
          "systemvitals-internal": {
            NetworkID:"network-id",
            Aliases:["sv-postgres"]
          }
        }
      ')
    fi
    jq -n --argjson networks "$networks" '[{
      Id:"postgres-container-id",
      State:{Status:"running",Health:{Status:"healthy"}},
      Mounts:[{
        Type:"volume",
        Name:"test-postgres-volume",
        Destination:"/var/lib/postgresql",
        RW:true
      }],
      NetworkSettings:{Networks:$networks}
    }]'
    ;;
  "inspect redis-container-id")
    networks='{
      "systemvitals-stack-test_default": {
        "NetworkID":"legacy-network-id",
        "Aliases":["redis"]
      }
    }'
    if [[ -e $MOCK_REDIS_CONNECTED ]]; then
      networks=$(jq -cn --argjson networks "$networks" '
        $networks + {
          "systemvitals-internal": {
            NetworkID:"network-id",
            Aliases:["sv-redis"]
          }
        }
      ')
    fi
    jq -n --argjson networks "$networks" '[{
      Id:"redis-container-id",
      State:{Status:"running",Health:{Status:"healthy"}},
      Mounts:[{
        Type:"volume",
        Name:"test-redis-volume",
        Destination:"/data",
        RW:true
      }],
      NetworkSettings:{Networks:$networks}
    }]'
    ;;
  "compose --project-name")
    printf '%q ' "$@" >>"$MOCK_DOCKER_MUTATION_LOG"
    printf '\n' >>"$MOCK_DOCKER_MUTATION_LOG"
    case "$*" in
      *" --profile infrastructure-cutover up -d --no-recreate postgres redis")
        ;;
      *" rm --stop --force "*)
        : >"$MOCK_STATELESS_REMOVED"
        ;;
      *)
        exit 84
        ;;
    esac
    ;;
  *)
    printf '%s\n' "unexpected docker command: $*" >&2
    exit 81
    ;;
esac
EOF
chmod +x "$provision_bin/docker"

cat >"$provision_bin/preflight" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'PREFLIGHT' >>"$MOCK_OPERATION_LOG"
if (($# > 0)); then
  printf ' %q' "$@" >>"$MOCK_OPERATION_LOG"
fi
printf '\n' >>"$MOCK_OPERATION_LOG"
printf '%s\n' "$*" >>"$MOCK_PREFLIGHT_LOG"
[[ ${MOCK_PREFLIGHT_FAIL:-0} != 1 ]] || exit 71

case "${1:-}" in
  "")
    printf '%s\n' 'PREFLIGHT OK'
    ;;
  --verify-unchanged)
    [[ ${SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID:-} == \
      postgres-container-id ]] || exit 72
    [[ ${SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID:-} == \
      redis-container-id ]] || exit 73
    printf '%s\n' 'FINALIZATION VERIFIED'
    ;;
  *)
    exit 74
    ;;
esac
EOF
chmod +x "$provision_bin/preflight"

common_provision_env=(
  "PATH=$provision_bin:$PATH"
  "DOKPLOY_URL=https://dokploy.test"
  "DOKPLOY_API_KEY=provision-test-api-key"
  "MOCK_CURL_REQUEST_LOG=$provision_request_log"
  "MOCK_CURL_ARGV_LOG=$provision_argv_log"
  "MOCK_JQ_ARGV_LOG=$jq_argv_log"
  "REAL_JQ=$real_jq"
  "MOCK_DOKPLOY_STATE=$state_file"
  "MOCK_COMPOSE_STATE=$compose_state_file"
  "MOCK_APPLICATION_DIR=$application_dir"
  "MOCK_DOMAIN_STATE=$domain_state_file"
  "MOCK_PENDING_MUTATION=$pending_mutation_file"
  "MOCK_FINAL_TOPOLOGY_DRIFT_FILE=$final_topology_drift_file"
  "MOCK_NETWORK_STATE=$network_state_file"
  "MOCK_DOCKER_MUTATION_LOG=$docker_mutation_log"
  "MOCK_OPERATION_LOG=$operation_log"
  "MOCK_POSTGRES_CONNECTED=$postgres_connected_file"
  "MOCK_REDIS_CONNECTED=$redis_connected_file"
  "MOCK_STATELESS_REMOVED=$stateless_removed_file"
  "MOCK_PREFLIGHT_LOG=$preflight_log"
  "SYSTEMVITALS_DOKPLOY_RECEIPT_DIR=$receipt_dir"
  "SYSTEMVITALS_PREFLIGHT_COMMAND=$provision_bin/preflight"
  "SYSTEMVITALS_POSTGRES_VOLUME=test-postgres-volume"
  "SYSTEMVITALS_REDIS_VOLUME=test-redis-volume"
  "SYSTEMVITALS_BACKUP_ID=test-backup-id"
  "SYSTEMVITALS_BACKUP_DESTINATION_ID=test-destination-id"
  "POSTGRES_PASSWORD=test-postgres-password"
  "SYSTEMVITALS_API_IMAGE=test-api-image"
  "SYSTEMVITALS_WORKER_IMAGE=test-worker-image"
  "SYSTEMVITALS_FRONTEND_IMAGE=test-frontend-image"
  "SYSTEMVITALS_GITHUB_OWNER=SystemVitals"
  "SYSTEMVITALS_GITHUB_REPOSITORY=systemvitals"
  "SYSTEMVITALS_GITHUB_BRANCH=main"
  "SYSTEMVITALS_CUTOVER_AUTH_TOKEN=cutover-auth-secret"
  "MOCK_EXPECTED_CUTOVER_TOKEN=cutover-auth-secret"
  "SYSTEMVITALS_CUTOVER_VERIFY_ATTEMPTS=3"
  "SYSTEMVITALS_CUTOVER_VERIFY_RETRY_DELAY_SECONDS=0"
)

env "${common_provision_env[@]}" "$provisioner" plan \
  >"$provision_output" 2>"$provision_error"
assert_contains "$provision_output" '"projectId": "project-id"'
assert_contains "$provision_output" '"name": "SystemVitals Stack"'
assert_contains "$provision_output" '"variableNames"'
assert_contains "$provision_output" '"DATABASE_URL"'
assert_not_contains "$provision_output" 'PLAN_DATABASE_SECRET'
assert_not_contains "$provision_output" 'PLAN_REDIS_SECRET'
assert_not_contains "$provision_output" 'PLAN_JWT_SECRET'
assert_not_contains "$provision_output" 'DO_NOT_COPY'
assert_not_contains "$provision_error" 'PLAN_DATABASE_SECRET'
assert_not_contains "$provision_argv_log" 'provision-test-api-key'
if grep -Eq '^(POST|PATCH|PUT|DELETE) ' "$provision_request_log"; then
  fail "plan issued a mutating Dokploy request"
fi

if env "${common_provision_env[@]}" "$provisioner" \
  >"$provision_output" 2>"$provision_error"; then
  fail "provisioner accepted a missing mode"
fi
assert_contains "$provision_error" 'mode is required'

for stage in apply-apps cutover-domains finalize-infrastructure; do
  : >"$provision_request_log"
  if env "${common_provision_env[@]}" "$provisioner" "$stage" \
    >"$provision_output" 2>"$provision_error"; then
    fail "$stage accepted missing confirmation"
  fi
  assert_contains "$provision_error" "--confirm $stage"
  [[ ! -s $provision_request_log ]] ||
    fail "$stage performed discovery before refusing missing confirmation"

  if env "${common_provision_env[@]}" "$provisioner" "$stage" \
    --confirm wrong-stage >"$provision_output" 2>"$provision_error"; then
    fail "$stage accepted the wrong confirmation"
  fi
  assert_contains "$provision_error" "--confirm $stage"
done

for duplicate_mode in \
  MOCK_DUPLICATE_PROJECT \
  MOCK_DUPLICATE_ENVIRONMENT \
  MOCK_DUPLICATE_COMPOSE \
  MOCK_DUPLICATE_APPLICATION; do
  if env "${common_provision_env[@]}" "$duplicate_mode=1" \
    "$provisioner" plan >"$provision_output" 2>"$provision_error"; then
    fail "plan accepted ambiguous state from $duplicate_mode"
  fi
  assert_contains "$provision_error" 'expected exactly one'
done

: >"$provision_request_log"
: >"$provision_argv_log"
if ! env "${common_provision_env[@]}" "$provisioner" apply-apps \
  --confirm apply-apps >"$provision_output" 2>"$provision_error"; then
  sed -n '1,80p' "$provision_error" >&2
  fail "apply-apps failed"
fi

[[ $(grep -Fc 'POST /api/application.create' "$provision_request_log") == 3 ]] ||
  fail "apply-apps did not create exactly three applications"
[[ $(grep -Fc 'POST /api/domain.create' "$provision_request_log") == 2 ]] ||
  fail "apply-apps did not create exactly two temporary domains"
for endpoint in \
  application.create \
  application.saveGithubProvider \
  application.saveBuildType \
  application.saveEnvironment \
  domain.create; do
  assert_contains "$provision_request_log" "/api/$endpoint"
done

assert_contains "$provision_request_log" \
  'POST /api/trpc/application.update'
assert_contains "$provision_request_log" \
  'GET /api/trpc/application.one?input='
assert_contains "$provision_request_log" \
  'GET /api/trpc/domain.one?input='
assert_contains "$provision_request_log" \
  'GET /api/trpc/domain.byApplicationId?input='
assert_not_contains "$provision_request_log" \
  'GET /api/domain.one?'
assert_not_contains "$provision_request_log" \
  'GET /api/domain.byApplicationId?'

assert_contains "$docker_mutation_log" \
  'network create --driver overlay --attachable systemvitals-internal'

jq -e '
  .name == "SystemVitals API" and
  .environmentId == "environment-id" and
  .sourceType == "github" and
  .owner == "SystemVitals" and
  .repository == "systemvitals" and
  .branch == "main" and
  .buildPath == "/" and
  .githubId == "github-provider-id" and
  .triggerType == "push" and
  .enableSubmodules == false and
  .buildType == "dockerfile" and
  .dockerfile == "api/Dockerfile" and
  .dockerContextPath == "." and
  .dockerBuildStage == null and
  .autoDeploy == false and
  .replicas == 1 and
  .modeSwarm == {Replicated:{Replicas:1}} and
  .updateConfigSwarm == {
    Parallelism: 1,
    Delay: 10000000000,
    FailureAction: "rollback",
    Monitor: 60000000000,
    MaxFailureRatio: 0,
    Order: "start-first"
  } and
  .restartPolicySwarm == {Condition:"on-failure"} and
  .stopGracePeriodSwarm == 60000000000 and
  .networkSwarm == [
    {Target:"dokploy-network"},
    {Target:"systemvitals-internal"}
  ] and
  .endpointSpecSwarm == {Mode:"vip",Ports:[]} and
  .healthCheckSwarm.Interval == 10000000000 and
  .healthCheckSwarm.Timeout == 5000000000 and
  .healthCheckSwarm.StartPeriod == 1860000000000 and
  .healthCheckSwarm.Retries == 3 and
  .healthCheckSwarm.Test[0] == "CMD-SHELL" and
  (.healthCheckSwarm.Test[1] | contains("/health/ready"))
' "$application_dir/api-id.json" >/dev/null ||
  fail "API application configuration is not exact"

jq -e '
  .name == "SystemVitals Worker" and
  .buildType == "dockerfile" and
  .dockerfile == "worker/Dockerfile" and
  .dockerContextPath == "." and
  .autoDeploy == false and
  .networkSwarm == [{Target:"systemvitals-internal"}] and
  .endpointSpecSwarm == {Mode:"vip",Ports:[]} and
  .healthCheckSwarm.StartPeriod == 1860000000000 and
  .healthCheckSwarm.Test[0] == "CMD-SHELL" and
  (.healthCheckSwarm.Test[1] | contains("WORKER_READINESS_PATH")) and
  (.domains | length) == 0 and
  (.ports | length) == 0
' "$application_dir/worker-id.json" >/dev/null ||
  fail "worker application configuration is not exact"

jq -e '
  .name == "SystemVitals Frontend" and
  .buildType == "dockerfile" and
  .dockerfile == "frontend/Dockerfile" and
  .dockerContextPath == "frontend" and
  .autoDeploy == false and
  .networkSwarm == [{Target:"dokploy-network"}] and
  .healthCheckSwarm.StartPeriod == 60000000000 and
  .healthCheckSwarm.Test[0] == "CMD-SHELL" and
  (.healthCheckSwarm.Test[1] | contains("/api/health"))
' "$application_dir/frontend-id.json" >/dev/null ||
  fail "frontend application configuration is not exact"

jq -e '
  (.env | contains("DATABASE_URL=PLAN_DATABASE_SECRET")) and
  (.env | contains("JWT_SECRET=PLAN_JWT_SECRET")) and
  (.env | contains("STRIPE_SECRET_KEY=STRIPE_SECRET_VALUE")) and
  (.env | contains("GOOGLE_CLIENT_SECRET=GOOGLE_SECRET_VALUE")) and
  (.env | contains("APP_URL=https://systemvitals.link")) and
  (.env | contains(
    "GOOGLE_CALLBACK_URL=https://api.systemvitals.link/auth/google/callback"
  )) and
  (.env | contains("TELEGRAM_BOT_TOKEN=TEST_TELEGRAM_TOKEN")) and
  (.env | contains(
    "TELEGRAM_WEBHOOK_SECRET=TEST_TELEGRAM_WEBHOOK_SECRET"
  )) and
  (.env | contains(
    "TELEGRAM_WEBHOOK_URL=https://api.systemvitals.link/integrations/telegram/webhook"
  )) and
  ([.env | split("\n")[] | select(startswith("TELEGRAM_"))] | sort) == ([
    "TELEGRAM_BOT_TOKEN=TEST_TELEGRAM_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET=TEST_TELEGRAM_WEBHOOK_SECRET",
    "TELEGRAM_WEBHOOK_URL=https://api.systemvitals.link/integrations/telegram/webhook"
  ] | sort) and
  (.env | contains("APP_URL=https://systemvitals.nihey.org") | not) and
  (.env | contains("SMTP_PASS=SMTP_SECRET_VALUE")) and
  (.env | contains("UNEXPECTED_SECRET") | not) and
  (.env | contains("POSTGRES_PASSWORD") | not) and
  .buildArgs == "" and
  .buildSecrets == "" and
  .createEnvFile == true
' "$application_dir/api-id.json" >/dev/null ||
  fail "API environment allowlist is incorrect"

jq -e '
  (.env | contains("DATABASE_URL=PLAN_DATABASE_SECRET")) and
  (.env | contains("QUEUE_PROBE=probe")) and
  (.env | contains("QUEUE_" + "ESCALATION") | not) and
  (.env | contains("SCHEDULER_LEASE_TTL_MS=90000")) and
  (.env | contains("TELEGRAM_BOT_TOKEN=TEST_TELEGRAM_TOKEN")) and
  ([.env | split("\n")[] | select(startswith("TELEGRAM_"))]) == [
    "TELEGRAM_BOT_TOKEN=TEST_TELEGRAM_TOKEN"
  ] and
  (.env | contains("APP_URL=https://systemvitals.link")) and
  (.env | contains("APP_URL=https://systemvitals.nihey.org") | not) and
  (.env | contains("SMTP_PASS=SMTP_SECRET_VALUE")) and
  (.env | contains("UNEXPECTED_SECRET") | not) and
  (.env | contains("JWT_SECRET") | not) and
  (.env | contains("STRIPE_SECRET_KEY") | not) and
  .buildArgs == ""
' "$application_dir/worker-id.json" >/dev/null ||
  fail "worker environment allowlist is incorrect"

jq -e '
  (.env | split("\n") | sort) == ([
    "NEXT_PUBLIC_API_URL=https://api.systemvitals.link",
    "NEXT_PUBLIC_APP_URL=https://systemvitals.link",
    "NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true"
  ] | sort) and
  .buildArgs == .env and
  (.env | contains("TELEGRAM_") | not) and
  (.buildArgs | contains("TELEGRAM_") | not) and
  (.env | contains("UNEXPECTED_SECRET") | not)
' "$application_dir/frontend-id.json" >/dev/null ||
  fail "frontend runtime/build argument allowlist is incorrect"

jq -e '
  length == 2 and
  any(.[];
    .host == "api-staging.systemvitals.link" and
    .applicationId == "api-id" and
    .domainType == "application" and
    .port == 8888 and
    .https == true and
    .certificateType == "letsencrypt"
  ) and
  any(.[];
    .host == "staging.systemvitals.link" and
    .applicationId == "frontend-id" and
    .domainType == "application" and
    .port == 9999 and
    .https == true and
    .certificateType == "letsencrypt"
  )
' "$domain_state_file" >/dev/null ||
  fail "temporary validation domains are not exact"

receipt_file=$(find "$receipt_dir" -maxdepth 1 -type f -name 'apply-apps-*.json')
[[ -n $receipt_file && $(stat -c '%a' "$receipt_file") == 600 ]] ||
  fail "apply-apps receipt is missing or not mode 0600"
[[ $(stat -c '%a' "$receipt_dir") == 700 ]] ||
  fail "receipt directory is not mode 0700"
case "$receipt_file" in
  "$repo_root"/*)
    fail "receipt was written inside the repository"
    ;;
esac
jq -e '
  .stage == "apply-apps" and
  .objectIds.projectId == "project-id" and
  .objectIds.environmentId == "environment-id" and
  .objectIds.composeId == "compose-id" and
  .objectIds.applicationIds == {
    api:"api-id",
    worker:"worker-id",
    frontend:"frontend-id"
  } and
  (.beforeHash | test("^[a-f0-9]{64}$")) and
  (.afterHash | test("^[a-f0-9]{64}$"))
' "$receipt_file" >/dev/null ||
  fail "apply-apps receipt metadata is incomplete"
for secret_marker in \
  PLAN_DATABASE_SECRET \
  PLAN_REDIS_SECRET \
  PLAN_JWT_SECRET \
  STRIPE_SECRET_VALUE \
  SMTP_SECRET_VALUE \
  GOOGLE_SECRET_VALUE \
  TEST_TELEGRAM_TOKEN \
  TEST_TELEGRAM_WEBHOOK_SECRET \
  POSTGRES_SECRET_VALUE \
  DO_NOT_COPY \
  NESTED_DISCOVERY_SECRET \
  NESTED_COMPOSE_SECRET; do
  assert_not_contains "$provision_output" "$secret_marker"
  assert_not_contains "$provision_error" "$secret_marker"
  assert_not_contains "$provision_argv_log" "$secret_marker"
  assert_not_contains "$jq_argv_log" "$secret_marker"
  assert_not_contains "$receipt_file" "$secret_marker"
done
assert_not_contains "$receipt_file" 'TELEGRAM_'

api_readback_backup="$test_root/api-readback-backup.json"
frontend_readback_backup="$test_root/frontend-readback-backup.json"
cp "$application_dir/api-id.json" "$api_readback_backup"
cp "$application_dir/frontend-id.json" "$frontend_readback_backup"
for readback_case in source build env buildArgs; do
  case "$readback_case" in
    source)
      readback_app_file="$application_dir/api-id.json"
      readback_backup="$api_readback_backup"
      readback_endpoint=application.saveGithubProvider
      jq '.owner = "wrong-owner"' "$readback_backup" \
        >"$readback_app_file"
      ;;
    build)
      readback_app_file="$application_dir/api-id.json"
      readback_backup="$api_readback_backup"
      readback_endpoint=application.saveBuildType
      jq '.dockerfile = "wrong/Dockerfile"' "$readback_backup" \
        >"$readback_app_file"
      ;;
    env)
      readback_app_file="$application_dir/api-id.json"
      readback_backup="$api_readback_backup"
      readback_endpoint=application.saveEnvironment
      jq '.env = "NODE_ENV=wrong"' "$readback_backup" \
        >"$readback_app_file"
      ;;
    buildArgs)
      readback_app_file="$application_dir/frontend-id.json"
      readback_backup="$frontend_readback_backup"
      readback_endpoint=application.saveEnvironment
      jq '.buildArgs = "NEXT_PUBLIC_API_URL=https://wrong.test"' \
        "$readback_backup" >"$readback_app_file"
      ;;
  esac

  readback_unexpected_success=0
  if env "${common_provision_env[@]}" \
    "MOCK_NOOP_MUTATION=$readback_endpoint" \
    "$provisioner" apply-apps --confirm apply-apps \
    >"$provision_output" 2>"$provision_error"; then
    readback_unexpected_success=1
  fi
  cp "$readback_backup" "$readback_app_file"
  ((readback_unexpected_success == 0)) ||
    fail "$readback_case no-op mutation passed without returned-state verification"
  assert_contains "$provision_error" 'did not read back exactly'
done

plan_post_count_before=$(grep -Ec '^(POST|PATCH|PUT|DELETE) ' \
  "$provision_request_log")
env "${common_provision_env[@]}" "$provisioner" plan \
  >"$provision_output" 2>"$provision_error"
plan_post_count_after=$(grep -Ec '^(POST|PATCH|PUT|DELETE) ' \
  "$provision_request_log")
[[ $plan_post_count_after == "$plan_post_count_before" ]] ||
  fail "plan mutated Dokploy after applications existed"
jq -e '
  (.applications | length) == 3 and
  .receiptGeneration.replacementSmoke.mode ==
    "generate-replacement-smoke" and
  .receiptGeneration.replacementSmoke.performsLiveChecks == true and
  .receiptGeneration.workerDrain.mode == "generate-worker-drain" and
  (.receiptGeneration.workerDrain.requiredAttestations | length) == 3 and
  any(.applications[];
    .name == "SystemVitals API" and
    .dockerfile == "api/Dockerfile" and
    .dockerContextPath == "." and
    .autoDeploy == false and
    (.variableNames | index("DATABASE_URL") != null) and
    any(.domains[];
      .host == "api-staging.systemvitals.link" and
      .port == 8888
    )
  ) and
  any(.applications[];
    .name == "SystemVitals Worker" and
    .dockerfile == "worker/Dockerfile" and
    .dockerContextPath == "." and
    .autoDeploy == false and
    (.domains | length) == 0 and
    (.variableNames | index("QUEUE_PROBE") != null)
  ) and
  any(.applications[];
    .name == "SystemVitals Frontend" and
    .dockerfile == "frontend/Dockerfile" and
    .dockerContextPath == "frontend" and
    .autoDeploy == false and
    (.variableNames | index("NEXT_PUBLIC_API_URL") != null) and
    (.buildVariableNames | index("NEXT_PUBLIC_API_URL") != null) and
    any(.domains[];
      .host == "staging.systemvitals.link" and
      .port == 9999
    )
  )
' "$provision_output" >/dev/null ||
  fail "plan omitted application domains, build settings, or variable names"
for secret_marker in \
  PLAN_DATABASE_SECRET \
  PLAN_REDIS_SECRET \
  PLAN_JWT_SECRET \
  STRIPE_SECRET_VALUE \
  SMTP_SECRET_VALUE \
  GOOGLE_SECRET_VALUE \
  DO_NOT_COPY; do
  assert_not_contains "$provision_output" "$secret_marker"
  assert_not_contains "$provision_error" "$secret_marker"
done

create_count_before=$(grep -Fc 'POST /api/application.create' \
  "$provision_request_log")
domain_count_before=$(grep -Fc 'POST /api/domain.create' \
  "$provision_request_log")
env "${common_provision_env[@]}" "$provisioner" apply-apps \
  --confirm apply-apps >"$provision_output" 2>"$provision_error"
create_count_after=$(grep -Fc 'POST /api/application.create' \
  "$provision_request_log")
domain_count_after=$(grep -Fc 'POST /api/domain.create' \
  "$provision_request_log")
[[ $create_count_after == "$create_count_before" ]] ||
  fail "repeated apply-apps created duplicate applications"
[[ $domain_count_after == "$domain_count_before" ]] ||
  fail "repeated apply-apps created duplicate temporary domains"
[[ $(grep -Fc 'network create' "$docker_mutation_log") == 1 ]] ||
  fail "repeated apply-apps recreated the internal network"

finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for application_id in api-id worker-id frontend-id; do
  app_file="$application_dir/$application_id.json"
  app_tmp="$app_file.tmp"
  jq \
    --arg deployment_id "$application_id-deployment" \
    --arg finished_at "$finished_at" '
      .applicationStatus = "done" |
      .deployments = [{
        deploymentId: $deployment_id,
        status: "done",
        startedAt: $finished_at,
        finishedAt: $finished_at
      }]
    ' "$app_file" >"$app_tmp"
  mv "$app_tmp" "$app_file"
done
state_tmp="$state_file.tmp"
jq '
  .[0].environments[0].applications |= map(.applicationStatus = "done")
' "$state_file" >"$state_tmp"
mv "$state_tmp" "$state_file"

receipt_hmac_key=receipt-authentication-test-key

: >"$provision_request_log"
full_worker_container_id=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
if ! env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" generate-replacement-smoke \
  --confirm generate-replacement-smoke \
  --api-deployment-id api-id-deployment \
  --worker-deployment-id worker-id-deployment \
  --frontend-deployment-id frontend-id-deployment \
  >"$provision_output" 2>"$provision_error"; then
  sed -n '1,100p' "$provision_error" >&2
  fail "replacement-smoke receipt generation failed"
fi
fresh_smoke_receipt=$(jq -r '.receipt' "$provision_output")
[[ -f $fresh_smoke_receipt && ! -L $fresh_smoke_receipt &&
  $(stat -c '%a' "$fresh_smoke_receipt") == 600 ]] ||
  fail "generated replacement-smoke receipt is not a mode-0600 regular file"
case "$fresh_smoke_receipt" in
  "$repo_root"/*)
    fail "generated replacement-smoke receipt was written inside the repository"
    ;;
esac
jq -e '
  .schemaVersion == 1 and
  .kind == "replacement-smoke" and
  .projectId == "project-id" and
  .environmentId == "environment-id" and
  .applicationIds == {
    api:"api-id",
    worker:"worker-id",
    frontend:"frontend-id"
  } and
  .deploymentIds == {
    api:"api-id-deployment",
    worker:"worker-id-deployment",
    frontend:"frontend-id-deployment"
  } and
  .temporaryDomains == {
    api:"api-staging.systemvitals.link",
    frontend:"staging.systemvitals.link"
  } and
  (.checkedAt | fromdateiso8601 | type == "number") and
  .checks == {
    apiReadiness:true,
    apiGraphql:true,
    apiAuthenticatedRead:true,
    frontendHealth:true,
    frontendPage:true,
    workerReady:true
  } and
  (.signature | test("^[a-f0-9]{64}$"))
' "$fresh_smoke_receipt" >/dev/null ||
  fail "generated replacement-smoke receipt schema is incorrect"
if grep -q '^POST ' "$provision_request_log"; then
  fail "replacement-smoke generation mutated Dokploy"
fi
for secret_file in \
  "$provision_output" \
  "$provision_error" \
  "$provision_request_log" \
  "$provision_argv_log" \
  "$fresh_smoke_receipt"; do
  assert_not_contains "$secret_file" "$receipt_hmac_key"
  assert_not_contains "$secret_file" 'cutover-auth-secret'
done

for accepted_task_error in empty null trimmed-sentinel; do
  if ! env "${common_provision_env[@]}" \
    MOCK_TASK_ERROR_MODE="$accepted_task_error" \
    SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
    "$provisioner" generate-replacement-smoke \
    --confirm generate-replacement-smoke \
    --api-deployment-id api-id-deployment \
    --worker-deployment-id worker-id-deployment \
    --frontend-deployment-id frontend-id-deployment \
    >"$provision_output" 2>"$provision_error"; then
    fail "replacement health rejected task error mode $accepted_task_error"
  fi
done

for rejected_task_error in message other; do
  if env "${common_provision_env[@]}" \
    MOCK_TASK_ERROR_MODE="$rejected_task_error" \
    SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
    "$provisioner" generate-replacement-smoke \
    --confirm generate-replacement-smoke \
    --api-deployment-id api-id-deployment \
    --worker-deployment-id worker-id-deployment \
    --frontend-deployment-id frontend-id-deployment \
    >"$provision_output" 2>"$provision_error"; then
    fail "replacement health accepted task error mode $rejected_task_error"
  fi
  assert_contains "$provision_error" \
    'replacement task is not healthy and running'
done

if env "${common_provision_env[@]}" \
  MOCK_MULTIPLE_RUNNING_TASKS=1 \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" generate-replacement-smoke \
  --confirm generate-replacement-smoke \
  --api-deployment-id api-id-deployment \
  --worker-deployment-id worker-id-deployment \
  --frontend-deployment-id frontend-id-deployment \
  >"$provision_output" 2>"$provision_error"; then
  fail "replacement health accepted multiple running tasks"
fi
assert_contains "$provision_error" \
  'replacement task is not healthy and running'

receipt_count_before=$(find "$receipt_dir" -maxdepth 1 -type f | wc -l)
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" generate-replacement-smoke \
  --confirm generate-replacement-smoke \
  --api-deployment-id wrong-deployment \
  --worker-deployment-id worker-id-deployment \
  --frontend-deployment-id frontend-id-deployment \
  >"$provision_output" 2>"$provision_error"; then
  fail "replacement-smoke generation accepted a mismatched deployment"
fi
receipt_count_after=$(find "$receipt_dir" -maxdepth 1 -type f | wc -l)
[[ $receipt_count_after == "$receipt_count_before" ]] ||
  fail "failed replacement-smoke generation wrote a receipt"

: >"$provision_request_log"
if ! env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" generate-worker-drain \
  --confirm generate-worker-drain \
  --old-worker-container-id "$full_worker_container_id" \
  --new-worker-deployment-id worker-id-deployment \
  --attest-active-jobs-zero \
  --attest-queue-failures-unchanged \
  --attest-no-duplicate-scheduler-dispatches \
  >"$provision_output" 2>"$provision_error"; then
  sed -n '1,100p' "$provision_error" >&2
  fail "worker-drain receipt generation failed"
fi
fresh_worker_receipt=$(jq -r '.receipt' "$provision_output")
[[ -f $fresh_worker_receipt && ! -L $fresh_worker_receipt &&
  $(stat -c '%a' "$fresh_worker_receipt") == 600 ]] ||
  fail "generated worker-drain receipt is not a mode-0600 regular file"
jq -e '
  .schemaVersion == 1 and
  .kind == "worker-drain" and
  .projectId == "project-id" and
  .environmentId == "environment-id" and
  .composeId == "compose-id" and
  .applicationIds == {worker:"worker-id"} and
  .oldWorker == {
    serviceName:"worker",
    containerId:"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    activeJobs:0,
    drained:true,
    stopped:true
  } and
  .newWorker == {
    applicationId:"worker-id",
    deploymentId:"worker-id-deployment",
    ready:true,
    schedulerLeaseObserved:true
  } and
  (.checkedAt | fromdateiso8601 | type == "number") and
  .checks == {
    queueFailuresUnchanged:true,
    noDuplicateSchedulerDispatches:true
  } and
  (.signature | test("^[a-f0-9]{64}$"))
' "$fresh_worker_receipt" >/dev/null ||
  fail "generated worker-drain receipt schema is incorrect"
if grep -q '^POST ' "$provision_request_log"; then
  fail "worker-drain generation mutated Dokploy"
fi
for secret_file in \
  "$provision_output" \
  "$provision_error" \
  "$provision_request_log" \
  "$provision_argv_log" \
  "$fresh_worker_receipt"; do
  assert_not_contains "$secret_file" "$receipt_hmac_key"
done

short_worker_container_id=${full_worker_container_id:0:12}
short_worker_container_json=$(jq -cn \
  --arg container_id "$short_worker_container_id" '[{
    containerId: $container_id,
    name: "systemvitals-stack-test-worker-1",
    state: "exited",
    status: "Exited (0) 1 minute ago"
  }]')
if ! env "${common_provision_env[@]}" \
  MOCK_COMPOSE_CONTAINERS="$short_worker_container_json" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" generate-worker-drain \
  --confirm generate-worker-drain \
  --old-worker-container-id "$full_worker_container_id" \
  --new-worker-deployment-id worker-id-deployment \
  --attest-active-jobs-zero \
  --attest-queue-failures-unchanged \
  --attest-no-duplicate-scheduler-dispatches \
  >"$provision_output" 2>"$provision_error"; then
  fail "worker-drain generation rejected a valid 12-character Docker ID prefix"
fi

assert_worker_drain_container_rejected() {
  local description=$1
  local operator_container_id=$2
  local compose_containers=$3
  local expected_error=${4:-old worker is not uniquely present and stopped}

  if env "${common_provision_env[@]}" \
    MOCK_COMPOSE_CONTAINERS="$compose_containers" \
    SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
    "$provisioner" generate-worker-drain \
    --confirm generate-worker-drain \
    --old-worker-container-id "$operator_container_id" \
    --new-worker-deployment-id worker-id-deployment \
    --attest-active-jobs-zero \
    --attest-queue-failures-unchanged \
    --attest-no-duplicate-scheduler-dispatches \
    >"$provision_output" 2>"$provision_error"; then
    fail "worker-drain generation accepted $description"
  fi
  assert_contains "$provision_error" "$expected_error"
}

worker_container_entry() {
  local container_id=$1
  local name=${2:-systemvitals-stack-test-worker-1}
  local state=${3:-exited}

  jq -cn \
    --arg container_id "$container_id" \
    --arg name "$name" \
    --arg state "$state" \
    '[{containerId: $container_id, name: $name, state: $state}]'
}

assert_worker_drain_container_rejected \
  "an identical invalid container ID" \
  legacy-worker-container \
  "$(worker_container_entry legacy-worker-container)" \
  "old-worker-container-id must be exactly 64 hexadecimal characters"
assert_worker_drain_container_rejected \
  "an identical too-short hex container ID" \
  0123456789ab \
  "$(worker_container_entry 0123456789ab)" \
  "old-worker-container-id must be exactly 64 hexadecimal characters"
assert_worker_drain_container_rejected \
  "an 11-character Docker ID prefix" \
  "$full_worker_container_id" \
  "$(worker_container_entry "${full_worker_container_id:0:11}")"
assert_worker_drain_container_rejected \
  "a non-hex Dokploy container ID" \
  "$full_worker_container_id" \
  "$(worker_container_entry 0123456789ag)"
assert_worker_drain_container_rejected \
  "a non-prefix Dokploy container ID" \
  "$full_worker_container_id" \
  "$(worker_container_entry f123456789ab)"
assert_worker_drain_container_rejected \
  "a shortened ID for a non-full operator container ID" \
  "${full_worker_container_id:0:32}" \
  "$short_worker_container_json" \
  "old-worker-container-id must be exactly 64 hexadecimal characters"
assert_worker_drain_container_rejected \
  "a matching stopped container with the wrong service name" \
  "$full_worker_container_id" \
  "$(worker_container_entry "$short_worker_container_id" \
    systemvitals-stack-test-api-1)"
assert_worker_drain_container_rejected \
  "a matching worker container that is still running" \
  "$full_worker_container_id" \
  "$(worker_container_entry "$short_worker_container_id" \
    systemvitals-stack-test-worker-1 running)"
for unsafe_worker_state in restarting paused created removing unknown; do
  assert_worker_drain_container_rejected \
    "a matching worker container in state $unsafe_worker_state" \
    "$full_worker_container_id" \
    "$(worker_container_entry "$short_worker_container_id" \
      systemvitals-stack-test-worker-1 "$unsafe_worker_state")"
done
worker_container_without_state=$(jq -cn \
  --arg container_id "$short_worker_container_id" '[{
    containerId: $container_id,
    name: "systemvitals-stack-test-worker-1"
  }]')
assert_worker_drain_container_rejected \
  "a matching worker container without state" \
  "$full_worker_container_id" \
  "$worker_container_without_state"
ambiguous_worker_containers=$(jq -cn \
  --arg container_id "$short_worker_container_id" '[{
    containerId: $container_id,
    name: "systemvitals-stack-test-worker-1",
    state: "exited"
  }, {
    containerId: $container_id,
    name: "systemvitals-stack-test-worker-2",
    state: "exited"
  }]')
assert_worker_drain_container_rejected \
  "ambiguous matching worker containers" \
  "$full_worker_container_id" \
  "$ambiguous_worker_containers"

receipt_count_before=$(find "$receipt_dir" -maxdepth 1 -type f | wc -l)
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" generate-worker-drain \
  --confirm generate-worker-drain \
  --old-worker-container-id legacy-worker-container \
  --new-worker-deployment-id worker-id-deployment \
  --attest-active-jobs-zero \
  --attest-queue-failures-unchanged \
  >"$provision_output" 2>"$provision_error"; then
  fail "worker-drain generation accepted missing scheduler attestation"
fi
receipt_count_after=$(find "$receipt_dir" -maxdepth 1 -type f | wc -l)
[[ $receipt_count_after == "$receipt_count_before" ]] ||
  fail "failed worker-drain generation wrote a receipt"

sign_gate_receipt() {
  local file=$1
  local canonical
  local signature
  local signed_tmp="$file.signed"

  canonical=$(jq -cS 'del(.signature)' "$file")
  signature=$(
    {
      printf '%s\n' "$receipt_hmac_key"
      printf '%s' "$canonical"
    } | node -e '
      const crypto = require("node:crypto");
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const separator = input.indexOf("\n");
        const key = input.slice(0, separator);
        const data = input.slice(separator + 1);
        process.stdout.write(
          crypto.createHmac("sha256", key).update(data).digest("hex")
        );
      });
    '
  )
  jq --arg signature "$signature" '. + {signature:$signature}' \
    "$file" >"$signed_tmp"
  mv "$signed_tmp" "$file"
  chmod 0600 "$file"
}

write_smoke_receipt() {
  local file=$1
  local checked_at=$2
  local api_application_id=${3:-api-id}

  jq -n \
    --arg checked_at "$checked_at" \
    --arg api_application_id "$api_application_id" '{
      schemaVersion: 1,
      kind: "replacement-smoke",
      projectId: "project-id",
      environmentId: "environment-id",
      applicationIds: {
        api: $api_application_id,
        worker: "worker-id",
        frontend: "frontend-id"
      },
      deploymentIds: {
        api: "api-id-deployment",
        worker: "worker-id-deployment",
        frontend: "frontend-id-deployment"
      },
      temporaryDomains: {
        api: "api-staging.systemvitals.link",
        frontend: "staging.systemvitals.link"
      },
      checkedAt: $checked_at,
      checks: {
        apiReadiness: true,
        apiGraphql: true,
        apiAuthenticatedRead: true,
        frontendHealth: true,
        frontendPage: true,
        workerReady: true
      }
    }' >"$file"
  chmod 0600 "$file"
  sign_gate_receipt "$file"
}

manual_smoke_receipt="$test_root/replacement-smoke.json"
write_smoke_receipt "$manual_smoke_receipt" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" cutover-domains --confirm cutover-domains \
  >"$provision_output" 2>"$provision_error"; then
  fail "cutover-domains accepted a missing smoke receipt"
fi
assert_contains "$provision_error" '--smoke-receipt'
if grep -q '^POST ' "$provision_request_log"; then
  fail "missing smoke receipt allowed a mutation"
fi

bad_signature_receipt="$test_root/bad-signature-smoke.json"
cp "$fresh_smoke_receipt" "$bad_signature_receipt"
jq '.signature = "0"' "$bad_signature_receipt" \
  >"$bad_signature_receipt.tmp"
mv "$bad_signature_receipt.tmp" "$bad_signature_receipt"
chmod 0600 "$bad_signature_receipt"
: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" cutover-domains --confirm cutover-domains \
  --smoke-receipt "$bad_signature_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "cutover-domains accepted an unauthenticated smoke receipt"
fi
assert_contains "$provision_error" 'signature'
if grep -q '^POST ' "$provision_request_log"; then
  fail "unauthenticated smoke receipt allowed a mutation"
fi

stale_smoke_receipt="$test_root/stale-smoke.json"
write_smoke_receipt "$stale_smoke_receipt" \
  "$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" cutover-domains --confirm cutover-domains \
  --smoke-receipt "$stale_smoke_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "cutover-domains accepted a stale smoke receipt"
fi
assert_contains "$provision_error" 'fresh'
if grep -q '^POST ' "$provision_request_log"; then
  fail "stale smoke receipt allowed a mutation"
fi

mismatched_smoke_receipt="$test_root/mismatched-smoke.json"
write_smoke_receipt "$mismatched_smoke_receipt" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" other-api-id
: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" cutover-domains --confirm cutover-domains \
  --smoke-receipt "$mismatched_smoke_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "cutover-domains accepted a receipt bound to another application"
fi
assert_contains "$provision_error" 'bound'
if grep -q '^POST ' "$provision_request_log"; then
  fail "mismatched smoke receipt allowed a mutation"
fi

: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  MOCK_UNHEALTHY_APPLICATION=systemvitals-worker-test \
  "$provisioner" cutover-domains --confirm cutover-domains \
  --smoke-receipt "$fresh_smoke_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "cutover-domains accepted an unhealthy replacement task"
fi
assert_contains "$provision_error" 'healthy'
if grep -q '^POST ' "$provision_request_log"; then
  fail "unhealthy replacement allowed a domain mutation"
fi

: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_CUTOVER_AUTH_TOKEN= \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" cutover-domains --confirm cutover-domains \
  --smoke-receipt "$fresh_smoke_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "cutover-domains accepted a missing runtime auth credential"
fi
assert_contains "$provision_error" 'CUTOVER_AUTH_TOKEN'
if grep -q '^POST ' "$provision_request_log"; then
  fail "missing runtime auth credential allowed a domain mutation"
fi

for failed_check in \
  api-readiness \
  api-graphql \
  frontend-health \
  frontend-login \
  authenticated-read; do
  : >"$provision_request_log"
  if env "${common_provision_env[@]}" \
    SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
    MOCK_PUBLIC_FAIL_CHECK="$failed_check" \
    "$provisioner" cutover-domains --confirm cutover-domains \
    --smoke-receipt "$fresh_smoke_receipt" \
    >"$provision_output" 2>"$provision_error"; then
    fail "cutover-domains succeeded despite failed $failed_check"
  fi
  assert_contains "$provision_error" 'rolled back'
  assert_contains "$provision_request_log" "CHECK $failed_check"
  failed_check_count=$(grep -Fc "CHECK $failed_check" "$provision_request_log")
  ((failed_check_count == 3)) ||
    fail "$failed_check did not exhaust all cutover verification attempts"
  second_create_line=$({ grep -nF 'POST /api/domain.create' \
    "$provision_request_log" || true; } | sed -n '2p' | cut -d: -f1)
  failed_check_line=$({ grep -nF "CHECK $failed_check" \
    "$provision_request_log" || true; } | head -n 1 | cut -d: -f1)
  first_delete_line=$({ grep -nF 'POST /api/domain.delete' \
    "$provision_request_log" || true; } | head -n 1 | cut -d: -f1)
  [[ -n $second_create_line &&
    -n $failed_check_line &&
    -n $first_delete_line ]] ||
    fail "$failed_check lacked the expected transition operations"
  ((second_create_line < failed_check_line &&
    failed_check_line < first_delete_line)) ||
    fail "$failed_check did not preserve blue-green overlap through validation"
  jq -e '
    (.domains | length) == 2 and
    any(.domains[];
      .host == "api.systemvitals.nihey.org" and
      .composeId == "compose-id" and
      .applicationId == null and
      .serviceName == "api" and
      .port == 8888 and
      .https == true and
      .path == "/" and
      .certificateType == "letsencrypt" and
      .customCertResolver == null and
      .domainType == "compose" and
      .internalPath == "/" and
      .stripPath == false
    ) and
    any(.domains[];
      .host == "systemvitals.nihey.org" and
      .composeId == "compose-id" and
      .applicationId == null and
      .serviceName == "frontend" and
      .port == 9999 and
      .https == true and
      .path == "/" and
      .certificateType == "letsencrypt" and
      .customCertResolver == null and
      .domainType == "compose" and
      .internalPath == "/" and
      .stripPath == false
    )
  ' "$compose_state_file" >/dev/null ||
    fail "$failed_check did not restore both exact legacy domain objects"
  jq -e '
    all(.[];
      .host != "api.systemvitals.link" and
      .host != "systemvitals.link"
    )
  ' "$domain_state_file" >/dev/null ||
    fail "$failed_check left a production domain on an application"
  rollback_receipt=$(find "$receipt_dir" -maxdepth 1 -type f \
    -name 'cutover-domains-rollback-*.json' | tail -n 1)
  [[ -n $rollback_receipt &&
    $(stat -c '%a' "$rollback_receipt") == 600 ]] ||
    fail "$failed_check rollback lacked a mode-0600 receipt"
  jq -e '
    .settings.domainTransition.before.composeDomains == [
      {
        domainId:"api-domain-old",
        host:"api.systemvitals.nihey.org",
        port:8888,
        https:true,
        path:"/",
        serviceName:"api",
        certificateType:"letsencrypt",
        customCertResolver:null,
        domainType:"compose",
        internalPath:"/",
        stripPath:false
      },
      {
        domainId:"frontend-domain-old",
        host:"systemvitals.nihey.org",
        port:9999,
        https:true,
        path:"/",
        serviceName:"frontend",
        certificateType:"letsencrypt",
        customCertResolver:null,
        domainType:"compose",
        internalPath:"/",
        stripPath:false
      }
    ] and
    (.settings.domainTransition.after.composeDomains | length) == 2 and
    (
      .settings.domainTransition.after.composeDomains | map(del(.domainId))
    ) == (
      .settings.domainTransition.before.composeDomains | map(del(.domainId))
    ) and
    .settings.domainTransition.after.applicationDomains == {
      api:[],
      frontend:[]
    }
  ' "$rollback_receipt" >/dev/null ||
    fail "$failed_check rollback receipt lacks recoverable domain metadata"
  for secret_file in \
    "$provision_output" \
    "$provision_error" \
    "$provision_request_log" \
    "$provision_argv_log" \
    "$rollback_receipt"; do
    assert_not_contains "$secret_file" 'cutover-auth-secret'
  done
done

cp "$compose_state_file" "$test_root/compose-before-aggregate-rollback.json"
cp "$domain_state_file" "$test_root/domains-before-aggregate-rollback.json"
: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  MOCK_PUBLIC_FAIL_AFTER_LEGACY_DELETE=1 \
  MOCK_FAIL_COMPOSE_RESTORE_HOST=systemvitals.nihey.org \
  "$provisioner" cutover-domains --confirm cutover-domains \
  --smoke-receipt "$fresh_smoke_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "cutover-domains succeeded despite an incomplete aggregate rollback"
fi
assert_contains "$provision_error" 'rollback was incomplete'
frontend_restore_line=$({ grep -nF \
  'DOMAIN CREATE systemvitals.nihey.org null' "$provision_request_log" ||
  true; } |
  tail -n 1 | cut -d: -f1)
api_restore_line=$({ grep -nF \
  'DOMAIN CREATE api.systemvitals.nihey.org null' "$provision_request_log" ||
  true; } |
  tail -n 1 | cut -d: -f1)
[[ -n $frontend_restore_line && -n $api_restore_line ]] ||
  fail "aggregate rollback did not attempt both legacy route restorations"
((frontend_restore_line < api_restore_line)) ||
  fail "API rollback was not attempted after frontend rollback failed"
mapfile -t incomplete_rollback_receipts < <(
  find "$receipt_dir" -maxdepth 1 -type f \
    -name 'cutover-domains-rollback-*.json' -exec \
    grep -l '"rollback-incomplete"' {} +
)
((${#incomplete_rollback_receipts[@]} == 1)) ||
  fail "expected exactly one incomplete rollback receipt"
rollback_receipt=${incomplete_rollback_receipts[0]}
jq -e '
  .settings.result == "rollback-incomplete" and
  .settings.productionDomainsRestored == false and
  .settings.rollbackOutcomes == {
    frontend:false,
    api:true,
    finalTopology:false
  }
' "$rollback_receipt" >/dev/null ||
  fail "aggregate rollback receipt did not record independent outcomes"
cp "$test_root/compose-before-aggregate-rollback.json" "$compose_state_file"
cp "$test_root/domains-before-aggregate-rollback.json" "$domain_state_file"

: >"$provision_request_log"
receipt_count_before=$(find "$receipt_dir" -maxdepth 1 -type f \
  -name 'cutover-domains-rollback-*.json' | wc -l)
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  MOCK_FINAL_TOPOLOGY_DRIFT=1 \
  "$provisioner" cutover-domains --confirm cutover-domains \
  --smoke-receipt "$fresh_smoke_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "cutover-domains accepted a failed final topology readback"
fi
assert_contains "$provision_error" 'rolled back'
receipt_count_after=$(find "$receipt_dir" -maxdepth 1 -type f \
  -name 'cutover-domains-rollback-*.json' | wc -l)
((receipt_count_after == receipt_count_before + 1)) ||
  fail "final topology failure did not write exactly one rollback receipt"
jq -e '
  (.domains | length) == 2 and
  any(.domains[];
    .host == "api.systemvitals.nihey.org" and
    .serviceName == "api"
  ) and
  any(.domains[];
    .host == "systemvitals.nihey.org" and
    .serviceName == "frontend"
  )
' "$compose_state_file" >/dev/null ||
  fail "final topology failure did not restore both legacy routes"
jq -e '
  all(.[];
    .host != "api.systemvitals.link" and
    .host != "systemvitals.link"
  )
' "$domain_state_file" >/dev/null ||
  fail "final topology failure left a replacement production route"

: >"$provision_request_log"
transient_failures_file="$test_root/public-failures-remaining"
printf '2\n' >"$transient_failures_file"
if ! env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  MOCK_PUBLIC_TRANSIENT_FAIL_CHECK=api-readiness \
  MOCK_PUBLIC_FAILURES_REMAINING_FILE="$transient_failures_file" \
  "$provisioner" cutover-domains --confirm cutover-domains \
  --smoke-receipt "$fresh_smoke_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  sed -n '1,100p' "$provision_error" >&2
  fail "cutover-domains did not tolerate transient route propagation failures"
fi
[[ $(<"$transient_failures_file") == 0 ]] ||
  fail "cutover-domains did not consume both transient failures"
api_readiness_count=$(grep -Fc \
  'PUBLIC GET https://api.systemvitals.link/health/ready CHECK api-readiness' \
  "$provision_request_log")
((api_readiness_count == 4)) ||
  fail "cutover-domains did not retry twice before both successful envelopes"
jq -e '
  (.domains | length) == 0
' "$compose_state_file" >/dev/null ||
  fail "successful cutover left production domains on Compose"
jq -e '
  any(.[];
    .host == "api.systemvitals.link" and
    .applicationId == "api-id" and
    .port == 8888 and
    .https == true and
    .certificateType == "letsencrypt"
  ) and
  any(.[];
    .host == "systemvitals.link" and
    .applicationId == "frontend-id" and
    .port == 9999 and
    .https == true and
    .certificateType == "letsencrypt"
  )
' "$domain_state_file" >/dev/null ||
  fail "successful cutover did not bind exact production domains"
assert_contains "$provision_request_log" \
  'PUBLIC GET https://api.systemvitals.link/health/ready CHECK api-readiness'
assert_contains "$provision_request_log" \
  'PUBLIC POST https://api.systemvitals.link/graphql CHECK api-graphql'
assert_contains "$provision_request_log" \
  'PUBLIC GET https://systemvitals.link/api/health CHECK frontend-health'
assert_contains "$provision_request_log" \
  'PUBLIC GET https://systemvitals.link/login CHECK frontend-login'
assert_contains "$provision_request_log" \
  'PUBLIC POST https://api.systemvitals.link/graphql CHECK authenticated-read'
for container_id in \
  systemvitals-api-test-container \
  systemvitals-worker-test-container \
  systemvitals-frontend-test-container; do
  assert_contains "$provision_request_log" \
    "GET /api/docker.getConfig?containerId=$container_id"
done
api_public_line=$({ grep -nF \
  'PUBLIC GET https://api.systemvitals.link/health/ready CHECK api-readiness' \
  "$provision_request_log" || true; } | head -n 1 | cut -d: -f1)
second_create_line=$({ grep -nF 'POST /api/domain.create' \
  "$provision_request_log" || true; } | sed -n '2p' | cut -d: -f1)
first_delete_line=$({ grep -nF 'POST /api/domain.delete' \
  "$provision_request_log" || true; } | head -n 1 | cut -d: -f1)
[[ -n $second_create_line && -n $api_public_line &&
  -n $first_delete_line ]] ||
  fail "successful cutover lacked the expected transition operations"
((second_create_line < api_public_line &&
  api_public_line < first_delete_line)) ||
  fail "production routes were not validated during blue-green overlap"

cutover_receipt=$(find "$receipt_dir" -maxdepth 1 -type f \
  -name 'cutover-domains-*.json' ! -name '*rollback*' | tail -n 1)
[[ -n $cutover_receipt && $(stat -c '%a' "$cutover_receipt") == 600 ]] ||
  fail "successful cutover receipt is missing or not mode 0600"
jq -e '
  .stage == "cutover-domains" and
  .objectIds.applicationIds.api == "api-id" and
  .objectIds.applicationIds.frontend == "frontend-id" and
  (.settings.domainTransition.before.composeDomains | length) == 2 and
  (.settings.domainTransition.before.composeDomains |
    any(.[];
      (.domainId | type) == "string" and
      (.domainId | length) > 0 and
      .host == "api.systemvitals.nihey.org" and
      .port == 8888 and
      .serviceName == "api" and
      .domainType == "compose"
    )
  ) and
  (.settings.domainTransition.before.composeDomains |
    any(.[];
      (.domainId | type) == "string" and
      (.domainId | length) > 0 and
      .host == "systemvitals.nihey.org" and
      .port == 9999 and
      .serviceName == "frontend" and
      .domainType == "compose"
    )
  ) and
  .settings.domainTransition.after.composeDomains == [] and
  (.settings.domainTransition.after.applicationDomains.api |
    any(.[];
      .host == "api.systemvitals.link" and
      .applicationId == "api-id" and
      .port == 8888
    )
  ) and
  (.settings.domainTransition.after.applicationDomains.frontend |
    any(.[];
      .host == "systemvitals.link" and
      .applicationId == "frontend-id" and
      .port == 9999
    )
  ) and
  (.beforeHash | test("^[a-f0-9]{64}$")) and
  (.afterHash | test("^[a-f0-9]{64}$"))
' "$cutover_receipt" >/dev/null ||
  fail "cutover receipt metadata is incomplete"
assert_not_contains "$cutover_receipt" "$receipt_hmac_key"

write_worker_drain_receipt() {
  local file=$1
  local checked_at=$2
  local worker_application_id=${3:-worker-id}

  jq -n \
    --arg checked_at "$checked_at" \
    --arg worker_application_id "$worker_application_id" '{
      schemaVersion: 1,
      kind: "worker-drain",
      projectId: "project-id",
      environmentId: "environment-id",
      composeId: "compose-id",
      applicationIds: {
        worker: $worker_application_id
      },
      oldWorker: {
        serviceName: "worker",
        containerId: "legacy-worker-container",
        activeJobs: 0,
        drained: true,
        stopped: true
      },
      newWorker: {
        applicationId: $worker_application_id,
        deploymentId: "worker-id-deployment",
        ready: true,
        schedulerLeaseObserved: true
      },
      checkedAt: $checked_at,
      checks: {
        queueFailuresUnchanged: true,
        noDuplicateSchedulerDispatches: true
      }
    }' >"$file"
  chmod 0600 "$file"
  sign_gate_receipt "$file"
}

manual_worker_receipt="$test_root/worker-drain.json"
write_worker_drain_receipt "$manual_worker_receipt" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

: >"$provision_request_log"
: >"$docker_mutation_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" finalize-infrastructure \
  --confirm finalize-infrastructure \
  >"$provision_output" 2>"$provision_error"; then
  fail "finalize-infrastructure accepted a missing worker drain receipt"
fi
assert_contains "$provision_error" '--worker-drain-receipt'
if grep -q '^POST ' "$provision_request_log"; then
  fail "missing worker drain receipt allowed an API mutation"
fi
[[ ! -s $docker_mutation_log ]] ||
  fail "missing worker drain receipt allowed a Docker mutation"

bad_worker_receipt="$test_root/bad-worker-drain.json"
cp "$fresh_worker_receipt" "$bad_worker_receipt"
jq '.signature = "bad"' "$bad_worker_receipt" >"$bad_worker_receipt.tmp"
mv "$bad_worker_receipt.tmp" "$bad_worker_receipt"
chmod 0600 "$bad_worker_receipt"
: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" finalize-infrastructure \
  --confirm finalize-infrastructure \
  --worker-drain-receipt "$bad_worker_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "finalize-infrastructure accepted an unauthenticated drain receipt"
fi
assert_contains "$provision_error" 'signature'
if grep -q '^POST ' "$provision_request_log"; then
  fail "unauthenticated drain receipt allowed an API mutation"
fi

stale_worker_receipt="$test_root/stale-worker-drain.json"
write_worker_drain_receipt "$stale_worker_receipt" \
  "$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" finalize-infrastructure \
  --confirm finalize-infrastructure \
  --worker-drain-receipt "$stale_worker_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "finalize-infrastructure accepted a stale drain receipt"
fi
assert_contains "$provision_error" 'fresh'
if grep -q '^POST ' "$provision_request_log"; then
  fail "stale drain receipt allowed an API mutation"
fi

mismatched_worker_receipt="$test_root/mismatched-worker-drain.json"
write_worker_drain_receipt "$mismatched_worker_receipt" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" other-worker-id
: >"$provision_request_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" finalize-infrastructure \
  --confirm finalize-infrastructure \
  --worker-drain-receipt "$mismatched_worker_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "finalize-infrastructure accepted a drain receipt for another worker"
fi
assert_contains "$provision_error" 'bound'
if grep -q '^POST ' "$provision_request_log"; then
  fail "mismatched drain receipt allowed an API mutation"
fi

assert_finalization_worker_container_rejected() {
  local description=$1
  local compose_containers=$2

  : >"$provision_request_log"
  : >"$docker_mutation_log"
  if env "${common_provision_env[@]}" \
    MOCK_COMPOSE_CONTAINERS="$compose_containers" \
    SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
    "$provisioner" finalize-infrastructure \
    --confirm finalize-infrastructure \
    --worker-drain-receipt "$fresh_worker_receipt" \
    >"$provision_output" 2>"$provision_error"; then
    fail "finalize-infrastructure accepted $description"
  fi
  assert_contains "$provision_error" \
    'worker drain receipt does not match live stopped worker status'
  if grep -q '^POST ' "$provision_request_log"; then
    fail "$description allowed an API mutation"
  fi
  [[ ! -s $docker_mutation_log ]] ||
    fail "$description allowed a Docker mutation"
}

assert_finalization_worker_container_rejected \
  "an invalid live worker container ID" \
  "$(worker_container_entry 0123456789ag)"
assert_finalization_worker_container_rejected \
  "a non-prefix live worker container ID" \
  "$(worker_container_entry f123456789ab)"
for unsafe_worker_state in restarting paused created removing unknown; do
  assert_finalization_worker_container_rejected \
    "a matching live worker container in state $unsafe_worker_state" \
    "$(worker_container_entry "$short_worker_container_id" \
      systemvitals-stack-test-worker-1 "$unsafe_worker_state")"
done
assert_finalization_worker_container_rejected \
  "a matching live worker container without state" \
  "$worker_container_without_state"
ambiguous_finalization_worker_containers=$(jq -cn \
  --arg container_id "$short_worker_container_id" '[{
    containerId: $container_id,
    name: "systemvitals-stack-test-worker-1",
    state: "exited"
  }, {
    containerId: $container_id,
    name: "systemvitals-stack-test-worker-2",
    state: "exited"
  }]')
assert_finalization_worker_container_rejected \
  "ambiguous live worker container ID prefixes" \
  "$ambiguous_finalization_worker_containers"

for gate_mode in \
  domain-drift \
  new-worker-unhealthy \
  old-worker-running \
  unexpected-service; do
  : >"$provision_request_log"
  : >"$docker_mutation_log"
  extra_env=()
  case "$gate_mode" in
    domain-drift)
      extra_env+=("MOCK_COMPOSE_DOMAIN_DRIFT=1")
      ;;
    new-worker-unhealthy)
      extra_env+=("MOCK_UNHEALTHY_APPLICATION=systemvitals-worker-test")
      ;;
    old-worker-running)
      extra_env+=("MOCK_OLD_WORKER_RUNNING=1")
      ;;
    unexpected-service)
      extra_env+=("MOCK_UNEXPECTED_OLD_SERVICE=1")
      ;;
  esac
  if env "${common_provision_env[@]}" "${extra_env[@]}" \
    SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
    "$provisioner" finalize-infrastructure \
    --confirm finalize-infrastructure \
    --worker-drain-receipt "$fresh_worker_receipt" \
    >"$provision_output" 2>"$provision_error"; then
    fail "finalize-infrastructure accepted failed gate: $gate_mode"
  fi
  if grep -q '^POST ' "$provision_request_log"; then
    fail "$gate_mode allowed an API mutation before all gates passed"
  fi
  [[ ! -s $docker_mutation_log ]] ||
    fail "$gate_mode allowed a Docker mutation before all gates passed"
done

: >"$provision_request_log"
: >"$docker_mutation_log"
: >"$operation_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  MOCK_PREFLIGHT_FAIL=1 \
  "$provisioner" finalize-infrastructure \
  --confirm finalize-infrastructure \
  --worker-drain-receipt "$fresh_worker_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "finalize-infrastructure ignored a failed Task 6 preflight"
fi
assert_contains "$provision_error" 'preflight'
if grep -Fq ' --no-recreate ' "$docker_mutation_log" ||
  grep -Fq ' rm ' "$docker_mutation_log"; then
  fail "failed preflight allowed infrastructure or stateless mutation"
fi
blocked_receipt=$(find "$receipt_dir" -maxdepth 1 -type f \
  -name 'finalize-infrastructure-blocked-*.json')
[[ -n $blocked_receipt && $(stat -c '%a' "$blocked_receipt") == 600 ]] ||
  fail "preflight failure after auto-deploy mutation lacked a 0600 receipt"

cp "$compose_state_file" "$test_root/pre-post-removal-compose.json"
cp "$state_file" "$test_root/pre-post-removal-state.json"
: >"$provision_request_log"
: >"$docker_mutation_log"
: >"$operation_log"
: >"$preflight_log"
if env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  MOCK_POST_REMOVAL_EMPTY=1 \
  "$provisioner" finalize-infrastructure \
  --confirm finalize-infrastructure \
  --worker-drain-receipt "$fresh_worker_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  fail "finalization accepted an empty post-removal container list"
fi
assert_contains "$provision_error" 'exactly two'
assert_contains "$docker_mutation_log" \
  'rm --stop --force migrate api worker frontend'
cp "$test_root/pre-post-removal-compose.json" "$compose_state_file"
cp "$test_root/pre-post-removal-state.json" "$state_file"
rm -f \
  "$postgres_connected_file" \
  "$redis_connected_file" \
  "$stateless_removed_file" \
  "$pending_mutation_file"

: >"$provision_request_log"
: >"$docker_mutation_log"
: >"$operation_log"
: >"$preflight_log"
if ! env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" finalize-infrastructure \
  --confirm finalize-infrastructure \
  --worker-drain-receipt "$fresh_worker_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  sed -n '1,120p' "$provision_error" >&2
  fail "healthy finalize-infrastructure failed"
fi

jq -e '
  .name == "SystemVitals Infrastructure" and
  .composePath == "./docker-compose.infrastructure.yml" and
  .autoDeploy == false and
  .composeId == "compose-id" and
  .appName == "systemvitals-stack-test"
' "$compose_state_file" >/dev/null ||
  fail "infrastructure Compose identity/path/auto-deploy is incorrect"
for application_id in api-id worker-id frontend-id; do
  jq -e '.autoDeploy == true' \
    "$application_dir/$application_id.json" >/dev/null ||
    fail "$application_id auto-deploy was not enabled after finalization"
done

assert_contains "$docker_mutation_log" \
  'network connect --alias sv-postgres systemvitals-internal postgres-container-id'
assert_contains "$docker_mutation_log" \
  'network connect --alias sv-redis systemvitals-internal redis-container-id'
assert_contains "$docker_mutation_log" \
  '--profile infrastructure-cutover up -d --no-recreate postgres redis'
assert_contains "$docker_mutation_log" \
  'rm --stop --force migrate api worker frontend'
[[ $(grep -Fc -- '--verify-unchanged' "$preflight_log") == 2 ]] ||
  fail "finalization did not run Task 6 unchanged verification twice"
if grep -Eq '(^|[[:space:]])(down|volume)[[:space:]]|--volumes|(^|[[:space:]])-v([[:space:]]|$)' \
  "$docker_mutation_log"; then
  fail "finalization attempted volume or broad Compose deletion"
fi
if grep -Fq '/api/compose.delete' "$provision_request_log"; then
  fail "finalization attempted to delete the Compose object"
fi

preflight_line=$(grep -n '^PREFLIGHT *$' "$operation_log" |
  head -n 1 | cut -d: -f1)
postgres_connect_line=$(grep -nF \
  'DOCKER network connect --alias sv-postgres' "$operation_log" |
  head -n 1 | cut -d: -f1)
no_recreate_line=$(grep -nF \
  'up -d --no-recreate postgres redis' "$operation_log" |
  head -n 1 | cut -d: -f1)
verify_unchanged_line=$(grep -nF \
  'PREFLIGHT --verify-unchanged' "$operation_log" |
  head -n 1 | cut -d: -f1)
post_removal_verify_line=$(grep -nF \
  'PREFLIGHT --verify-unchanged' "$operation_log" |
  tail -n 1 | cut -d: -f1)
compose_path_line=$(grep -nF 'API POST /api/compose.update' \
  "$operation_log" | tail -n 1 | cut -d: -f1)
stateless_remove_line=$(grep -nF \
  'rm --stop --force migrate api worker frontend' "$operation_log" |
  head -n 1 | cut -d: -f1)
((preflight_line < postgres_connect_line)) ||
  fail "network attachment occurred before the Task 6 preflight"
((postgres_connect_line < no_recreate_line)) ||
  fail "no-recreate ran before stateful network attachment"
((no_recreate_line < verify_unchanged_line)) ||
  fail "unchanged state was not verified after no-recreate"
((verify_unchanged_line < compose_path_line)) ||
  fail "Compose path changed before unchanged infrastructure verification"
((compose_path_line < stateless_remove_line)) ||
  fail "legacy stateless services were removed before the Compose path change"
((stateless_remove_line < post_removal_verify_line)) ||
  fail "Task 6 unchanged verification did not run after stateless removal"

finalize_receipt=$(find "$receipt_dir" -maxdepth 1 -type f \
  -name 'finalize-infrastructure-*.json' ! -name '*blocked*' | tail -n 1)
[[ -n $finalize_receipt && $(stat -c '%a' "$finalize_receipt") == 600 ]] ||
  fail "finalization receipt is missing or not mode 0600"
jq -e '
  .stage == "finalize-infrastructure" and
  .objectIds.composeId == "compose-id" and
  .settings.composeName == "SystemVitals Infrastructure" and
  .settings.composePath == "./docker-compose.infrastructure.yml" and
  .settings.composeAutoDeploy == false and
  .settings.applicationAutoDeploy == true and
  .settings.preservedVolumes == [
    "test-postgres-volume",
    "test-redis-volume"
  ] and
  .settings.removedServices == ["migrate","api","worker","frontend"] and
  (.beforeHash | test("^[a-f0-9]{64}$")) and
  (.afterHash | test("^[a-f0-9]{64}$"))
' "$finalize_receipt" >/dev/null ||
  fail "finalization receipt metadata is incomplete"
for secret_marker in \
  "$receipt_hmac_key" \
  PLAN_DATABASE_SECRET \
  PLAN_REDIS_SECRET \
  test-postgres-password; do
  assert_not_contains "$finalize_receipt" "$secret_marker"
  assert_not_contains "$provision_output" "$secret_marker"
  assert_not_contains "$provision_error" "$secret_marker"
  assert_not_contains "$jq_argv_log" "$secret_marker"
done

: >"$provision_request_log"
: >"$docker_mutation_log"
if ! env "${common_provision_env[@]}" \
  SYSTEMVITALS_RECEIPT_HMAC_KEY="$receipt_hmac_key" \
  "$provisioner" finalize-infrastructure \
  --confirm finalize-infrastructure \
  --worker-drain-receipt "$fresh_worker_receipt" \
  >"$provision_output" 2>"$provision_error"; then
  sed -n '1,120p' "$provision_error" >&2
  fail "idempotent finalize-infrastructure rerun failed"
fi
if grep -q '^POST ' "$provision_request_log"; then
  fail "idempotent finalization repeated a Dokploy mutation"
fi
if grep -Eq 'network connect| rm ' "$docker_mutation_log"; then
  fail "idempotent finalization repeated network or stateless mutations"
fi

: >"$provision_request_log"
: >"$docker_mutation_log"
: >"$preflight_log"
if ! env "${common_provision_env[@]}" \
  "$provisioner" verify >"$provision_output" 2>"$provision_error"; then
  sed -n '1,120p' "$provision_error" >&2
  fail "strict verify rejected the expected final topology"
fi
if grep -q '^POST ' "$provision_request_log"; then
  fail "verify issued a mutating Dokploy request"
fi
[[ ! -s $docker_mutation_log ]] ||
  fail "verify issued a Docker mutation"
assert_contains "$preflight_log" '--verify-unchanged'
jq -e '
  .stage == "verify" and
  .status == "verified" and
  .project == {
    projectId:"project-id",
    name:"SystemVitals"
  } and
  .environment == {
    environmentId:"environment-id",
    name:"production"
  } and
  .compose.composeId == "compose-id" and
  .compose.name == "SystemVitals Infrastructure" and
  .compose.appName == "systemvitals-stack-test" and
  .compose.status == "done" and
  .compose.composePath == "./docker-compose.infrastructure.yml" and
  .compose.autoDeploy == false and
  .compose.services == ["postgres","redis"] and
  (.compose.variableNames | index("DATABASE_URL") != null) and
  (.applications | length) == 3 and
  any(.applications[];
    .applicationId == "api-id" and
    .name == "SystemVitals API" and
    .status == "done" and
    .dockerfile == "api/Dockerfile" and
    .dockerContextPath == "." and
    .autoDeploy == true and
    .replicas == 1 and
    (.variableNames | index("DATABASE_URL") != null)
  ) and
  any(.applications[];
    .applicationId == "worker-id" and
    .name == "SystemVitals Worker" and
    .status == "done" and
    .dockerfile == "worker/Dockerfile" and
    .dockerContextPath == "." and
    .autoDeploy == true and
    .domains == []
  ) and
  any(.applications[];
    .applicationId == "frontend-id" and
    .name == "SystemVitals Frontend" and
    .status == "done" and
    .dockerfile == "frontend/Dockerfile" and
    .dockerContextPath == "frontend" and
    .autoDeploy == true and
    .variableNames == [
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_GOOGLE_AUTH_ENABLED"
    ] and
    .buildVariableNames == .variableNames
  ) and
  .infrastructure == {
    network:"systemvitals-internal",
    postgresContainerId:"postgres-container-id",
    redisContainerId:"redis-container-id",
    task6Preflight:"verified-unchanged"
  }
' "$provision_output" >/dev/null ||
  fail "verify output omitted exact non-secret final state"
for secret_marker in \
  "$receipt_hmac_key" \
  provision-test-api-key \
  PLAN_DATABASE_SECRET \
  PLAN_REDIS_SECRET \
  PLAN_JWT_SECRET \
  STRIPE_SECRET_VALUE \
  SMTP_SECRET_VALUE \
  GOOGLE_SECRET_VALUE \
  test-postgres-password; do
  assert_not_contains "$provision_output" "$secret_marker"
  assert_not_contains "$provision_error" "$secret_marker"
done

for verify_drift in compose application domain health service; do
  : >"$provision_request_log"
  : >"$docker_mutation_log"
  extra_env=()
  case "$verify_drift" in
    compose)
      compose_tmp="$compose_state_file.tmp"
      jq '.autoDeploy = true' "$compose_state_file" >"$compose_tmp"
      mv "$compose_tmp" "$compose_state_file"
      ;;
    application)
      app_tmp="$application_dir/api-id.json.tmp"
      jq '.autoDeploy = false' "$application_dir/api-id.json" >"$app_tmp"
      mv "$app_tmp" "$application_dir/api-id.json"
      ;;
    domain)
      extra_env+=("MOCK_COMPOSE_DOMAIN_DRIFT=1")
      ;;
    health)
      extra_env+=("MOCK_UNHEALTHY_APPLICATION=systemvitals-api-test")
      ;;
    service)
      extra_env+=("MOCK_UNEXPECTED_OLD_SERVICE=1")
      ;;
  esac
  if env "${common_provision_env[@]}" "${extra_env[@]}" \
    "$provisioner" verify >"$provision_output" 2>"$provision_error"; then
    fail "strict verify accepted $verify_drift drift"
  fi
  if grep -q '^POST ' "$provision_request_log"; then
    fail "verify mutation occurred while rejecting $verify_drift drift"
  fi
  [[ ! -s $docker_mutation_log ]] ||
    fail "verify Docker mutation occurred while rejecting $verify_drift drift"
  case "$verify_drift" in
    compose)
      compose_tmp="$compose_state_file.tmp"
      jq '.autoDeploy = false' "$compose_state_file" >"$compose_tmp"
      mv "$compose_tmp" "$compose_state_file"
      ;;
    application)
      app_tmp="$application_dir/api-id.json.tmp"
      jq '.autoDeploy = true' "$application_dir/api-id.json" >"$app_tmp"
      mv "$app_tmp" "$application_dir/api-id.json"
      ;;
  esac
done

echo "Dokploy provisioning tests passed."
