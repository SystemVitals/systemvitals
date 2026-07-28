#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
configurator="$repo_root/scripts/configure-managed-telegram-dokploy.sh"
real_jq=$(command -v jq)
canonical_webhook_url=https://api.systemvitals.link/integrations/telegram/webhook
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2

  grep -Fq -- "$expected" "$file" ||
    fail "expected $file to contain: $expected"
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  local content

  content=$(<"$file")
  if [[ $content == *"$unexpected"* ]]; then
    fail "unexpected sensitive value in $file"
  fi
}

reset_captured_artifacts() {
  local artifact

  for artifact in "${captured_artifacts[@]}"; do
    : >"$artifact"
  done
}

assert_captured_artifacts_are_secret_free() {
  local artifact
  local fake_secret
  local secret_sentinel

  for artifact in "${captured_artifacts[@]}"; do
    for fake_secret in "${fake_secrets[@]}"; do
      assert_not_contains "$artifact" "$fake_secret"
    done
    for secret_sentinel in "${secret_sentinels[@]}"; do
      assert_not_contains "$artifact" "$secret_sentinel"
    done
  done
  [[ ! -e $marker_file ]] || fail "fake secret command syntax executed"
}

test_scripts="$test_root/scripts"
test_bin="$test_root/bin"
mkdir -p "$test_scripts" "$test_bin"
cp "$configurator" "$test_scripts/configure-managed-telegram-dokploy.sh"
chmod +x "$test_scripts/configure-managed-telegram-dokploy.sh"

fake_helper="$test_scripts/dokploy-api.sh"
cat >"$fake_helper" <<'EOF'
#!/usr/bin/env bash

declare -a MOCK_CLEANUP_HANDLERS=()
mock_run_cleanups() {
  local handler

  for handler in "${MOCK_CLEANUP_HANDLERS[@]}"; do
    "$handler"
  done
}
dokploy_register_cleanup() {
  MOCK_CLEANUP_HANDLERS+=("$1")
  trap mock_run_cleanups EXIT
}

if [[ ${MOCK_USE_REAL_TELEGRAM:-} != 1 ]]; then
telegram_api_request() {
  local method=$1
  local payload_file=${2:-}
  local temporary
  local webhook_url

  printf 'TELEGRAM %s\n' "$method" >>"$MOCK_OPERATION_LOG"
  [[ -z $payload_file || $(stat -c '%a' "$payload_file") == 600 ]] ||
    return 89
  case "$method" in
    getMe)
      jq -cn --arg username "${MOCK_BOT_USERNAME:-systemvitals_bot}" \
        '{ok: true, result: {id: 42, is_bot: true, username: $username}}'
      ;;
    setWebhook)
      webhook_url=$(jq -r '.url' "$payload_file")
      if [[ $webhook_url == "https://api.systemvitals.link/integrations/telegram/webhook" ]]; then
        jq -e \
          '.secret_token == env.SYSTEMVITALS_TELEGRAM_WEBHOOK_SECRET' \
          "$payload_file" >/dev/null || return 88
      else
        jq -e \
          '.secret_token == env.MOCK_PREVIOUS_WEBHOOK_SECRET' \
          "$payload_file" >/dev/null || return 88
      fi
      temporary="$MOCK_WEBHOOK_STATE.tmp"
      jq --arg url "$webhook_url" '
        .url = $url |
        .pending_update_count = 0 |
        .last_error_message = null
      ' "$MOCK_WEBHOOK_STATE" >"$temporary"
      mv "$temporary" "$MOCK_WEBHOOK_STATE"
      if [[ ${MOCK_FAILURE_CASE:-} == webhook-commit-response-fail &&
        $webhook_url == "https://api.systemvitals.link/integrations/telegram/webhook" &&
        ! -e $MOCK_FAILURE_MARKER ]]; then
        : >"$MOCK_FAILURE_MARKER"
        return 87
      fi
      printf '{"ok":true,"result":true}'
      ;;
    deleteWebhook)
      temporary="$MOCK_WEBHOOK_STATE.tmp"
      jq '.url = "" | .pending_update_count = 0 |
        .last_error_message = null' \
        "$MOCK_WEBHOOK_STATE" >"$temporary"
      mv "$temporary" "$MOCK_WEBHOOK_STATE"
      printf '{"ok":true,"result":true}'
      ;;
    getWebhookInfo)
      if [[ ${MOCK_FAILURE_CASE:-} == webhook-info-fail-after-set ]] &&
        grep -Fq 'TELEGRAM setWebhook' "$MOCK_OPERATION_LOG" &&
        [[ ! -e $MOCK_FAILURE_MARKER ]]; then
        : >"$MOCK_FAILURE_MARKER"
        return 83
      fi
      if [[ ${MOCK_FAILURE_CASE:-} == webhook-url-mismatch ]] &&
        grep -Fq 'TELEGRAM setWebhook' "$MOCK_OPERATION_LOG" &&
        [[ ! -e $MOCK_FAILURE_MARKER ]]; then
        temporary="$MOCK_WEBHOOK_STATE.tmp"
        jq '.url = "https://mismatch.systemvitals.test/telegram/webhook"' \
          "$MOCK_WEBHOOK_STATE" >"$temporary"
        mv "$temporary" "$MOCK_WEBHOOK_STATE"
        : >"$MOCK_FAILURE_MARKER"
      fi
      temporary="$MOCK_WEBHOOK_STATE.tmp"
      jq '
        .pending_update_count += 1 |
        .last_error_message = (
          if .url == "https://previous.systemvitals.test/telegram/webhook"
          then "volatile previous delivery error"
          else .last_error_message
          end
        )
      ' "$MOCK_WEBHOOK_STATE" >"$temporary"
      mv "$temporary" "$MOCK_WEBHOOK_STATE"
      jq -c '{ok:true,result:.}' "$MOCK_WEBHOOK_STATE"
      ;;
    *)
      return 86
      ;;
  esac
}
fi

dokploy_expect_one() {
  local filter=$1
  local description=$2
  local matches
  local count

  matches=$(jq -c "[$filter]" | jq -c 'map(select(. != null))')
  count=$(jq -r 'length' <<<"$matches")
  if [[ $count != 1 ]]; then
    printf 'BLOCKED: expected exactly one %s; found %s\n' \
      "$description" "$count" >&2
    return 1
  fi
  jq -c '.[0]' <<<"$matches"
}

dokploy_get() {
  local path=$1

  printf 'GET %s\n' "$path" >>"$MOCK_OPERATION_LOG"
  case "$path" in
    /api/project.all)
      command cat "$MOCK_PROJECT_STATE"
      ;;
    /api/compose.one?composeId=compose-id)
      if grep -Fq 'POST /api/compose.update' \
        "$MOCK_OPERATION_LOG"; then
        case "${MOCK_READBACK_DRIFT:-}" in
          compose-env-drop)
            jq '
              .env |= (
                split("\n") |
                map(select(. != "EXISTING_COMPOSE_VALUE=keep-compose")) |
                join("\n")
              )
            ' "$MOCK_COMPOSE_STATE"
            return
            ;;
          compose-blank-line-drop)
            jq '.env |= sub("\n\n"; "\n")' "$MOCK_COMPOSE_STATE"
            return
            ;;
          compose-identity-mismatch)
            jq '.name = "Other Infrastructure"' "$MOCK_COMPOSE_STATE"
            return
            ;;
        esac
      fi
      command cat "$MOCK_COMPOSE_STATE"
      ;;
    *)
      printf 'unexpected GET endpoint: %s\n' "$path" >&2
      return 99
      ;;
  esac
}

dokploy_trpc_get() {
  local procedure=$1
  local input=$2
  local application_id

  printf 'TRPC_GET %s\n' "$procedure" >>"$MOCK_OPERATION_LOG"
  [[ $procedure == application.one ]] || return 98
  application_id=$(jq -r '.applicationId' <<<"$input")
  if grep -Fq 'TELEGRAM getWebhookInfo' "$MOCK_OPERATION_LOG" &&
    [[ ! -e $MOCK_FAILURE_MARKER ]]; then
    case "${MOCK_FAILURE_CASE:-}:$application_id" in
      api-readback-mismatch:api-id)
        : >"$MOCK_FAILURE_MARKER"
        jq '
          .env |= (
            split("\n") |
            map(
              if . == "EXISTING_API_VALUE=keep-api"
              then "EXISTING_API_VALUE=altered-api"
              else .
              end
            ) |
            join("\n")
          )
        ' "$MOCK_APPLICATION_DIR/$application_id.json"
        return
        ;;
      worker-readback-mismatch:worker-id)
        : >"$MOCK_FAILURE_MARKER"
        jq '.env |= sub("EXISTING_WORKER_VALUE=keep-worker";
          "EXISTING_WORKER_VALUE=altered-worker")' \
          "$MOCK_APPLICATION_DIR/$application_id.json"
        return
        ;;
    esac
  fi
  command cat "$MOCK_APPLICATION_DIR/$application_id.json"
}

dokploy_post_file() {
  local path=$1
  local payload_file=$2
  local application_id
  local temporary

  [[ $(stat -c '%a' "$payload_file") == 600 ]] || return 85
  [[ $path == /api/application.saveEnvironment ]] || return 97
  printf 'POST %s\n' "$path" >>"$MOCK_OPERATION_LOG"
  application_id=$(jq -r '.applicationId // ""' "$payload_file")
  [[ -n $application_id ]] || return 96
  temporary="$MOCK_APPLICATION_DIR/$application_id.json.tmp"
  jq -s '.[0] * {
    env: .[1].env,
    buildArgs: .[1].buildArgs,
    buildSecrets: .[1].buildSecrets,
    createEnvFile: .[1].createEnvFile
  }' "$MOCK_APPLICATION_DIR/$application_id.json" \
    "$payload_file" >"$temporary"
  mv "$temporary" "$MOCK_APPLICATION_DIR/$application_id.json"
  case "${MOCK_FAILURE_CASE:-}:$application_id" in
    api-commit-response-fail:api-id | worker-commit-response-fail:worker-id)
      if [[ ! -e $MOCK_FAILURE_MARKER ]] &&
        jq -e '.env | contains("TELEGRAM_BOT_TOKEN=")' \
          "$payload_file" >/dev/null; then
        : >"$MOCK_FAILURE_MARKER"
        return 84
      fi
      ;;
  esac
}
EOF
chmod +x "$fake_helper"

cat >"$test_bin/jq" <<'EOF'
#!/usr/bin/env bash
printf 'jq' >>"$MOCK_ARGV_LOG"
printf ' <%s>' "$@" >>"$MOCK_ARGV_LOG"
printf '\n' >>"$MOCK_ARGV_LOG"
exec "$REAL_JQ" "$@"
EOF
chmod +x "$test_bin/jq"

cat >"$test_bin/curl" <<'EOF'
#!/usr/bin/env bash
config_file=
output_file=
while (($# > 0)); do
  printf 'curl-arg <%s>\n' "$1" >>"$MOCK_CURL_ARGV_LOG"
  case "$1" in
    --config)
      config_file=$2
      printf 'curl-arg <%s>\n' "$2" >>"$MOCK_CURL_ARGV_LOG"
      shift 2
      ;;
    --output)
      output_file=$2
      printf 'curl-arg <%s>\n' "$2" >>"$MOCK_CURL_ARGV_LOG"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[[ -n $config_file && -n $output_file ]] || exit 82
[[ $(stat -c '%a' "$config_file") == 600 ]] || exit 81
printf '%s\n' "$config_file" >>"$MOCK_TEMP_PATH_LOG"
if grep -Fq '/getMe"' "$config_file"; then
  printf '{"ok":true,"result":{"id":42,"is_bot":true,"username":"systemvitals_bot"}}' \
    >"$output_file"
else
  exit 80
fi
printf '200'
EOF
chmod +x "$test_bin/curl"

project_state="$test_root/projects.json"
compose_state="$test_root/compose.json"
application_dir="$test_root/applications"
webhook_state="$test_root/webhook.json"
failure_marker="$test_root/failure-marker"
operation_log="$test_root/operations.log"
argv_log="$test_root/argv.log"
curl_argv_log="$test_root/curl-argv.log"
temp_path_log="$test_root/temp-paths.log"
output="$test_root/output"
error="$test_root/error"
captured_artifacts=(
  "$output"
  "$error"
  "$operation_log"
  "$argv_log"
  "$curl_argv_log"
)
mkdir -p "$application_dir"
test_bot_token="123456:$(printf '%035d' 0)"

cat >"$project_state" <<'EOF'
[
  {
    "projectId": "project-id",
    "name": "SystemVitals",
    "environments": [
      {
        "environmentId": "environment-id",
        "name": "production",
        "compose": [
          {
            "composeId": "compose-id",
            "name": "SystemVitals Infrastructure"
          }
        ],
        "applications": [
          {
            "applicationId": "api-id",
            "name": "SystemVitals API"
          },
          {
            "applicationId": "worker-id",
            "name": "SystemVitals Worker"
          },
          {
            "applicationId": "frontend-id",
            "name": "SystemVitals Frontend"
          }
        ]
      }
    ]
  }
]
EOF

cat >"$compose_state" <<'EOF'
{
  "composeId": "compose-id",
  "environmentId": "environment-id",
  "name": "SystemVitals Infrastructure",
  "env": "POSTGRES_USER=systemvitals\n\nEXISTING_COMPOSE_VALUE=keep-compose\n"
}
EOF

cat >"$application_dir/api-id.json" <<EOF
{
  "applicationId": "api-id",
  "environmentId": "environment-id",
  "name": "SystemVitals API",
  "env": "DATABASE_URL=postgresql://test\n\nEXISTING_API_VALUE=keep-api\nTELEGRAM_BOT_TOKEN=$test_bot_token\nTELEGRAM_WEBHOOK_SECRET=TEST_PREVIOUS_TELEGRAM_WEBHOOK_SECRET_6K\nTELEGRAM_WEBHOOK_URL=https://previous.systemvitals.test/telegram/webhook\n\n",
  "buildArgs": "API_BUILD_ARG=keep-api-build",
  "buildSecrets": "API_BUILD_SECRET=TEST_API_BUILD_SECRET",
  "createEnvFile": false
}
EOF

cat >"$application_dir/worker-id.json" <<EOF
{
  "applicationId": "worker-id",
  "environmentId": "environment-id",
  "name": "SystemVitals Worker",
  "env": "REDIS_URL=redis://test\n\nEXISTING_WORKER_VALUE=keep-worker\nTELEGRAM_BOT_TOKEN=$test_bot_token\n",
  "buildArgs": "WORKER_BUILD_ARG=keep-worker-build",
  "buildSecrets": "WORKER_BUILD_SECRET=TEST_WORKER_BUILD_SECRET",
  "createEnvFile": true
}
EOF

cat >"$application_dir/frontend-id.json" <<'EOF'
{
  "applicationId": "frontend-id",
  "environmentId": "environment-id",
  "name": "SystemVitals Frontend",
  "env": "NEXT_PUBLIC_API_URL=https://api.systemvitals.link",
  "buildArgs": "NEXT_PUBLIC_API_URL=https://api.systemvitals.link",
  "buildSecrets": "FRONTEND_BUILD_SECRET=TEST_FRONTEND_BUILD_SECRET",
  "createEnvFile": true
}
EOF

cat >"$webhook_state" <<'EOF'
{
  "url": "https://previous.systemvitals.test/telegram/webhook",
  "pending_update_count": 17,
  "last_error_message": "previous volatile error",
  "max_connections": 40,
  "allowed_updates": ["message", "channel_post"],
  "ip_address": "192.0.2.10",
  "has_custom_certificate": false
}
EOF

cp "$application_dir/api-id.json" "$test_root/api-baseline.json"
cp "$application_dir/worker-id.json" "$test_root/worker-baseline.json"
cp "$webhook_state" "$test_root/webhook-baseline.json"

marker_file="$test_root/secret-marker-executed"
# shellcheck disable=SC2016 # Literal command syntax is part of the test value.
redaction_probe=$(
  printf '%s%s' '--TEST_DOKPLOY_SV_DOKPLOY_' \
    'KEY_SENTINEL_74Q_"double'\''single\slash $(touch TEST_MARKER) *?[glob]: spaced'
)
complex_bot_token="${test_bot_token%%:*}:SV_BOT_SECRET_SENTINEL_92F_ABCDEFGH"
complex_webhook_secret='SV_WEBHOOK_SECRET_SENTINEL_31C_ABCDEFGH'
redaction_probe=${redaction_probe/TEST_MARKER/$marker_file}
complex_bot_token=${complex_bot_token/TEST_MARKER/$marker_file}
complex_webhook_secret=${complex_webhook_secret/TEST_MARKER/$marker_file}
secret_sentinels=(
  SV_DOKPLOY_KEY_SENTINEL_74Q
  SV_BOT_SECRET_SENTINEL_92F
  SV_WEBHOOK_SECRET_SENTINEL_31C
)
fake_secrets=(
  "$redaction_probe"
  "$complex_bot_token"
  "$complex_webhook_secret"
  TEST_PREVIOUS_TELEGRAM_WEBHOOK_SECRET_6K
  TEST_AMBIGUOUS_TELEGRAM_VALUE
  TEST_API_BUILD_SECRET
  TEST_WORKER_BUILD_SECRET
  TEST_FRONTEND_BUILD_SECRET
)

set_test_environment() {
  export PATH="$test_bin:$PATH"
  export REAL_JQ="$real_jq"
  export MOCK_PROJECT_STATE="${TEST_PROJECT_STATE_OVERRIDE:-$project_state}"
  export MOCK_COMPOSE_STATE="$compose_state"
  export MOCK_APPLICATION_DIR="$application_dir"
  export MOCK_WEBHOOK_STATE="$webhook_state"
  export MOCK_FAILURE_MARKER="$failure_marker"
  export MOCK_OPERATION_LOG="$operation_log"
  export MOCK_ARGV_LOG="$argv_log"
  export MOCK_CURL_ARGV_LOG="$curl_argv_log"
  export MOCK_TEMP_PATH_LOG="$temp_path_log"
  export DOKPLOY_URL=https://dokploy.test
  export DOKPLOY_API_KEY="$redaction_probe"
  export SYSTEMVITALS_TELEGRAM_BOT_TOKEN="${TEST_BOT_TOKEN_OVERRIDE:-$complex_bot_token}"
  export SYSTEMVITALS_TELEGRAM_WEBHOOK_SECRET="${TEST_WEBHOOK_SECRET_OVERRIDE:-$complex_webhook_secret}"
  export MOCK_BOT_USERNAME="${TEST_BOT_USERNAME:-systemvitals_bot}"
  export MOCK_FAILURE_CASE="${TEST_FAILURE_CASE:-}"
  export MOCK_PREVIOUS_WEBHOOK_SECRET=TEST_PREVIOUS_TELEGRAM_WEBHOOK_SECRET_6K
  export MOCK_USE_REAL_TELEGRAM="${TEST_REAL_TELEGRAM:-0}"
}

reset_mutable_state() {
  cp "$test_root/api-baseline.json" "$application_dir/api-id.json"
  cp "$test_root/worker-baseline.json" "$application_dir/worker-id.json"
  cp "$test_root/webhook-baseline.json" "$webhook_state"
  rm -f "$failure_marker"
}

reset_first_install_state() {
  local state_file
  local temporary

  reset_mutable_state
  for state_file in \
    "$application_dir/api-id.json" \
    "$application_dir/worker-id.json"; do
    temporary="$state_file.tmp"
    jq '
      .env |= (
        split("\n") |
        map(select(
          test("^TELEGRAM_(BOT_TOKEN|WEBHOOK_SECRET|WEBHOOK_URL)=") | not
        )) |
        join("\n")
      )
    ' "$state_file" >"$temporary"
    mv "$temporary" "$state_file"
  done
  temporary="$webhook_state.tmp"
  jq '.url = "" | .pending_update_count = 0 |
    .last_error_message = null' "$webhook_state" >"$temporary"
  mv "$temporary" "$webhook_state"
}

make_target_assignment_ambiguous() {
  local service=$1
  local name=$2
  local style=$3
  local state_file="$application_dir/$service-id.json"
  local temporary="$state_file.tmp"

  jq --arg name "$name" --arg style "$style" '
    .env |= (
      split("\n") |
      if $style == "duplicate" then
        . + [$name + "=TEST_AMBIGUOUS_TELEGRAM_VALUE"]
      else
        map(
          if startswith($name + "=") then
            if $style == "export" then
              "export " + .
            elif $style == "leading" then
              " " + .
            else
              $name + " = TEST_AMBIGUOUS_TELEGRAM_VALUE"
            end
          else .
          end
        )
      end |
      join("\n")
    )
  ' "$state_file" >"$temporary"
  mv "$temporary" "$state_file"
}

grep -Fq \
  "const TELEGRAM_WEBHOOK_PATH = '/integrations/telegram/webhook';" \
  "$repo_root/api/src/main.ts" ||
  fail "API source no longer declares the expected Telegram webhook route"
grep -Fq "fixed_webhook_url=$canonical_webhook_url" "$configurator" ||
  fail "configurator canonical webhook drifted from the API source contract"

run_configurator() (
  set_test_environment
  "$test_scripts/configure-managed-telegram-dokploy.sh" "$@"
)

run_configurator_missing() (
  local missing_name=$1
  shift

  set_test_environment
  unset "$missing_name"
  "$test_scripts/configure-managed-telegram-dokploy.sh" "$@"
)

reset_captured_artifacts
: >"$temp_path_log"
if ! TEST_REAL_TELEGRAM=1 run_configurator plan \
  >"$output" 2>"$error"; then
  assert_captured_artifacts_are_secret_free
  command cat "$error" >&2
  fail "real Telegram curl-config plan failed"
fi
[[ $(grep -Fc 'curl-arg <--config>' "$curl_argv_log") == 1 ]] ||
  fail "real Telegram transport did not use one protected curl config"
while IFS= read -r protected_path; do
  [[ ! -e $protected_path ]] ||
    fail "real Telegram transport left a protected config behind"
done <"$temp_path_log"
assert_captured_artifacts_are_secret_free

invalid_token_head=${test_bot_token:0:24}
invalid_token_tail=${test_bot_token:25}
invalid_bot_tokens=(
  'malformed-token'
  "${invalid_token_head}\"${invalid_token_tail}"
  "${invalid_token_head}\\${invalid_token_tail}"
  "${invalid_token_head}"$'\n'"${invalid_token_tail}"
  "${invalid_token_head}"$'\001'"${invalid_token_tail}"
)
for invalid_value in "${invalid_bot_tokens[@]}"; do
  if [[ $invalid_value != malformed-token &&
    ${#invalid_value} -ne ${#test_bot_token} ]]; then
    fail "malformed Telegram bot token fixture changed length"
  fi
  reset_captured_artifacts
  : >"$temp_path_log"
  if TEST_REAL_TELEGRAM=1 TEST_BOT_TOKEN_OVERRIDE="$invalid_value" \
    run_configurator plan >"$output" 2>"$error"; then
    fail "plan accepted malformed Telegram bot token"
  fi
  [[ ! -s $curl_argv_log ]] ||
    fail "malformed Telegram bot token reached curl"
  assert_not_contains "$output" "$invalid_value"
  assert_not_contains "$error" "$invalid_value"
  assert_captured_artifacts_are_secret_free
done

invalid_webhook_secrets=(
  'bad secret'
  'bad"secret'
  'bad\secret'
  $'bad\nsecret'
  $'bad\001secret'
)
for invalid_value in "${invalid_webhook_secrets[@]}"; do
  reset_captured_artifacts
  : >"$temp_path_log"
  if TEST_REAL_TELEGRAM=1 TEST_WEBHOOK_SECRET_OVERRIDE="$invalid_value" \
    run_configurator plan >"$output" 2>"$error"; then
    fail "plan accepted malformed Telegram webhook secret"
  fi
  [[ ! -s $curl_argv_log ]] ||
    fail "malformed Telegram webhook secret reached curl"
  assert_not_contains "$output" "$invalid_value"
  assert_not_contains "$error" "$invalid_value"
  assert_captured_artifacts_are_secret_free
done

for missing_name in \
  DOKPLOY_URL \
  DOKPLOY_API_KEY \
  SYSTEMVITALS_TELEGRAM_BOT_TOKEN \
  SYSTEMVITALS_TELEGRAM_WEBHOOK_SECRET; do
  reset_captured_artifacts
  if run_configurator_missing "$missing_name" plan \
    >"$output" 2>"$error"; then
    fail "plan accepted missing $missing_name"
  fi
  assert_contains "$error" "$missing_name must be set and nonempty"
  [[ ! -s $operation_log ]] ||
    fail "plan discovered state before rejecting missing $missing_name"
  assert_captured_artifacts_are_secret_free
done

reset_captured_artifacts
if ! run_configurator plan >"$output" 2>"$error"; then
  assert_captured_artifacts_are_secret_free
  command cat "$error" >&2
  fail "plan failed"
fi

[[ $(head -n 1 "$operation_log") == 'TELEGRAM getMe' ]] ||
  fail "plan did not verify Telegram identity before discovery"

[[ ! -s $error ]] || fail "plan wrote stderr"
if grep -Eq '^POST ' "$operation_log"; then
  fail "plan performed a mutation"
fi
for expected in \
  'SystemVitals' \
  'project-id' \
  'production' \
  'environment-id' \
  'SystemVitals API' \
  'api-id' \
  'SystemVitals Worker' \
  'worker-id' \
  'TELEGRAM_BOT_TOKEN' \
  'TELEGRAM_WEBHOOK_SECRET' \
  'TELEGRAM_WEBHOOK_URL' \
  'changed'; do
  assert_contains "$output" "$expected"
done

assert_captured_artifacts_are_secret_free

for bad_confirmation in missing wrong; do
  reset_captured_artifacts
  if [[ $bad_confirmation == missing ]]; then
    command_to_run=(
      apply
    )
  else
    command_to_run=(
      apply
      --confirm
      wrong
    )
  fi
  if run_configurator "${command_to_run[@]}" \
    >"$output" 2>"$error"; then
    fail "apply accepted $bad_confirmation confirmation"
  fi
  assert_contains "$error" \
    '--confirm configure-managed-telegram'
  [[ ! -s $operation_log ]] ||
    fail "apply discovered state before rejecting $bad_confirmation confirmation"
  assert_captured_artifacts_are_secret_free
done

reset_captured_artifacts
reset_mutable_state
if ! run_configurator apply --confirm configure-managed-telegram \
  >"$output" 2>"$error"; then
  assert_captured_artifacts_are_secret_free
  command cat "$error" >&2
  fail "apply failed"
fi

[[ ! -s $error ]] || fail "apply wrote stderr"
[[ $(grep -Fc 'POST /api/compose.update' "$operation_log") == 0 ]] ||
  fail "apply mutated the infrastructure Compose environment"
[[ $(grep -Fc 'POST /api/compose.saveEnvironment' "$operation_log") == 0 ]] ||
  fail "apply called unsupported compose.saveEnvironment"
[[ $(grep -Fc 'POST /api/application.saveEnvironment' "$operation_log") == 2 ]] ||
  fail "apply did not save exactly two application environments"
if grep -Eq 'deploy|redeploy|deployment' "$operation_log"; then
  fail "apply called a deployment endpoint"
fi
assert_not_contains "$operation_log" 'frontend-id'
assert_contains "$operation_log" 'TELEGRAM setWebhook'
assert_contains "$operation_log" 'TELEGRAM getWebhookInfo'

jq -e '
  .env == "POSTGRES_USER=systemvitals\n\nEXISTING_COMPOSE_VALUE=keep-compose\n"
' "$compose_state" >/dev/null ||
  fail "Compose environment was mutated"

EXPECTED_TELEGRAM_BOT_TOKEN=$complex_bot_token \
EXPECTED_TELEGRAM_WEBHOOK_SECRET=$complex_webhook_secret \
jq -e '
  .env == (
    "DATABASE_URL=postgresql://test\n\n" +
    "EXISTING_API_VALUE=keep-api\n" +
    "TELEGRAM_BOT_TOKEN=" + env.EXPECTED_TELEGRAM_BOT_TOKEN + "\n" +
    "TELEGRAM_WEBHOOK_SECRET=" +
      env.EXPECTED_TELEGRAM_WEBHOOK_SECRET + "\n" +
    "TELEGRAM_WEBHOOK_URL=" +
      "https://api.systemvitals.link/integrations/telegram/webhook\n\n"
  ) and
  .buildArgs == "API_BUILD_ARG=keep-api-build" and
  .buildSecrets == "API_BUILD_SECRET=TEST_API_BUILD_SECRET" and
  .createEnvFile == false
' "$application_dir/api-id.json" >/dev/null ||
  fail "API environment or preserved fields are incorrect"

EXPECTED_TELEGRAM_BOT_TOKEN=$complex_bot_token \
jq -e '
  .env == (
    "REDIS_URL=redis://test\n\n" +
    "EXISTING_WORKER_VALUE=keep-worker\n" +
    "TELEGRAM_BOT_TOKEN=" + env.EXPECTED_TELEGRAM_BOT_TOKEN + "\n"
  ) and
  .buildArgs == "WORKER_BUILD_ARG=keep-worker-build" and
  .buildSecrets == "WORKER_BUILD_SECRET=TEST_WORKER_BUILD_SECRET" and
  .createEnvFile == true
' "$application_dir/worker-id.json" >/dev/null ||
  fail "worker environment or preserved fields are incorrect"

jq -e '
  .env == "NEXT_PUBLIC_API_URL=https://api.systemvitals.link" and
  .buildArgs == "NEXT_PUBLIC_API_URL=https://api.systemvitals.link" and
  .buildSecrets == "FRONTEND_BUILD_SECRET=TEST_FRONTEND_BUILD_SECRET" and
  .createEnvFile == true and
  (.env | contains("TELEGRAM_") | not) and
  (.buildArgs | contains("TELEGRAM_") | not)
' "$application_dir/frontend-id.json" >/dev/null ||
  fail "frontend was mutated"

assert_contains "$output" 'webhook_verified'
jq -e '
  .url == "https://api.systemvitals.link/integrations/telegram/webhook" and
  .last_error_message == null
' "$webhook_state" >/dev/null ||
  fail "successful apply did not configure the canonical webhook"
assert_captured_artifacts_are_secret_free

reset_captured_artifacts
if TEST_BOT_USERNAME=other_bot run_configurator \
  apply --confirm configure-managed-telegram >"$output" 2>"$error"; then
  fail "apply accepted the wrong Telegram bot"
fi
assert_contains "$error" 'Telegram bot identity did not match'
[[ $(grep -Ec '^POST |^TELEGRAM (setWebhook|getWebhookInfo)' \
  "$operation_log") == 0 ]] ||
  fail "identity mismatch mutated external state"
assert_captured_artifacts_are_secret_free

reset_first_install_state
cp "$application_dir/api-id.json" "$test_root/first-install-api-before.json"
cp "$application_dir/worker-id.json" \
  "$test_root/first-install-worker-before.json"
reset_captured_artifacts
if ! run_configurator apply --confirm configure-managed-telegram \
  >"$output" 2>"$error"; then
  assert_captured_artifacts_are_secret_free
  command cat "$error" >&2
  fail "clean first install failed"
fi
jq -e '
  .env |
  (contains("DATABASE_URL=postgresql://test\n\n") and
    contains("EXISTING_API_VALUE=keep-api\n") and
    ([split("\n")[] |
      select(startswith("TELEGRAM_BOT_TOKEN="))] | length) == 1 and
    ([split("\n")[] |
      select(startswith("TELEGRAM_WEBHOOK_SECRET="))] | length) == 1 and
    ([split("\n")[] |
      select(startswith("TELEGRAM_WEBHOOK_URL="))] | length) == 1)
' "$application_dir/api-id.json" >/dev/null ||
  fail "clean first install did not add exactly one canonical API assignment"
jq -e '
  .env |
  (contains("REDIS_URL=redis://test\n\n") and
    contains("EXISTING_WORKER_VALUE=keep-worker\n") and
    ([split("\n")[] |
      select(startswith("TELEGRAM_BOT_TOKEN="))] | length) == 1)
' "$application_dir/worker-id.json" >/dev/null ||
  fail "clean first install did not add one canonical worker assignment"
jq -j '
  .env |
  split("\n") |
  map(select(test("^TELEGRAM_(BOT_TOKEN|WEBHOOK_SECRET|WEBHOOK_URL)=") | not)) |
  join("\n")
' "$application_dir/api-id.json" >"$test_root/first-install-api-unrelated"
jq -j '.env' "$test_root/first-install-api-before.json" \
  >"$test_root/first-install-api-expected-unrelated"
cmp -s "$test_root/first-install-api-expected-unrelated" \
  "$test_root/first-install-api-unrelated" ||
  fail "clean first install changed unrelated API environment bytes"
jq -j '
  .env |
  split("\n") |
  map(select(startswith("TELEGRAM_BOT_TOKEN=") | not)) |
  join("\n")
' "$application_dir/worker-id.json" \
  >"$test_root/first-install-worker-unrelated"
jq -j '.env' "$test_root/first-install-worker-before.json" \
  >"$test_root/first-install-worker-expected-unrelated"
cmp -s "$test_root/first-install-worker-expected-unrelated" \
  "$test_root/first-install-worker-unrelated" ||
  fail "clean first install changed unrelated worker environment bytes"
assert_captured_artifacts_are_secret_free

reset_first_install_state
cp "$application_dir/api-id.json" "$test_root/first-install-api-before.json"
cp "$application_dir/worker-id.json" \
  "$test_root/first-install-worker-before.json"
reset_captured_artifacts
if TEST_FAILURE_CASE=webhook-commit-response-fail run_configurator \
  apply --confirm configure-managed-telegram >"$output" 2>"$error"; then
  fail "first-install webhook commit failure unexpectedly succeeded"
fi
cmp -s "$test_root/first-install-api-before.json" \
  "$application_dir/api-id.json" ||
  fail "first-install rollback did not restore API key absence"
cmp -s "$test_root/first-install-worker-before.json" \
  "$application_dir/worker-id.json" ||
  fail "first-install rollback did not restore worker key absence"
jq -e '.url == ""' "$webhook_state" >/dev/null ||
  fail "first-install rollback did not delete the newly committed webhook"
assert_contains "$operation_log" 'TELEGRAM deleteWebhook'
assert_contains "$error" 'rollback_verified=true'
assert_captured_artifacts_are_secret_free

reset_mutable_state
jq '
  .env |= (
    split("\n") |
    map(select(startswith("TELEGRAM_WEBHOOK_SECRET=") | not)) |
    join("\n")
  )
' "$application_dir/api-id.json" >"$test_root/api-without-webhook-secret.json"
mv "$test_root/api-without-webhook-secret.json" \
  "$application_dir/api-id.json"
reset_captured_artifacts
if run_configurator apply --confirm configure-managed-telegram \
  >"$output" 2>"$error"; then
  fail "apply accepted an API environment without a prior webhook secret"
fi
assert_contains "$error" \
  'previous API Telegram webhook secret is not safely restorable'
[[ $(grep -Ec '^POST |^TELEGRAM (setWebhook|deleteWebhook)' \
  "$operation_log") == 0 ]] ||
  fail "missing prior webhook secret mutated external state"
assert_captured_artifacts_are_secret_free

dotenv_targets=(
  "api TELEGRAM_BOT_TOKEN"
  "api TELEGRAM_WEBHOOK_SECRET"
  "api TELEGRAM_WEBHOOK_URL"
  "worker TELEGRAM_BOT_TOKEN"
)
for dotenv_target in "${dotenv_targets[@]}"; do
  read -r dotenv_service dotenv_name <<<"$dotenv_target"
  for dotenv_style in duplicate export leading around-equals; do
    reset_mutable_state
    make_target_assignment_ambiguous \
      "$dotenv_service" "$dotenv_name" "$dotenv_style"
    reset_captured_artifacts
    if run_configurator apply --confirm configure-managed-telegram \
      >"$output" 2>"$error"; then
      fail "apply accepted $dotenv_style $dotenv_name in $dotenv_service"
    fi
    assert_contains "$error" 'ambiguous Telegram environment assignment'
    [[ $(grep -Ec '^POST |^TELEGRAM (setWebhook|deleteWebhook)' \
      "$operation_log") == 0 ]] ||
      fail "$dotenv_style $dotenv_name mutated external state"
    assert_captured_artifacts_are_secret_free
  done
done

failure_scenarios=(
  api-commit-response-fail
  worker-commit-response-fail
  webhook-commit-response-fail
  webhook-info-fail-after-set
  webhook-url-mismatch
  api-readback-mismatch
  worker-readback-mismatch
)
for failure_scenario in "${failure_scenarios[@]}"; do
  reset_mutable_state
  reset_captured_artifacts
  if TEST_FAILURE_CASE=$failure_scenario run_configurator \
    apply --confirm configure-managed-telegram >"$output" 2>"$error"; then
    fail "apply accepted failure scenario $failure_scenario"
  fi
  cmp -s "$test_root/api-baseline.json" "$application_dir/api-id.json" ||
    fail "$failure_scenario did not restore the complete API state"
  cmp -s "$test_root/worker-baseline.json" "$application_dir/worker-id.json" ||
    fail "$failure_scenario did not restore the complete worker state"
  jq -e '
    .url == "https://previous.systemvitals.test/telegram/webhook" and
    .max_connections == 40 and
    .allowed_updates == ["message", "channel_post"] and
    .ip_address == "192.0.2.10" and
    .has_custom_certificate == false
  ' "$webhook_state" >/dev/null ||
    fail "$failure_scenario did not restore prior webhook configuration"
  assert_contains "$error" 'rollback_verified=true'
  assert_captured_artifacts_are_secret_free
done

for duplicate_mode in project environment api worker; do
  reset_captured_artifacts
  duplicate_state="$test_root/duplicate-$duplicate_mode.json"
  case "$duplicate_mode" in
    project)
      jq '. + [.[0]]' "$project_state" >"$duplicate_state"
      ;;
    environment)
      jq '.[0].environments += [.[0].environments[0]]' \
        "$project_state" >"$duplicate_state"
      ;;
    api)
      jq '.[0].environments[0].applications +=
        [.[0].environments[0].applications[0]]' \
        "$project_state" >"$duplicate_state"
      ;;
    worker)
      jq '.[0].environments[0].applications +=
        [.[0].environments[0].applications[1]]' \
        "$project_state" >"$duplicate_state"
      ;;
  esac
  if TEST_PROJECT_STATE_OVERRIDE=$duplicate_state run_configurator plan \
    >"$output" 2>"$error"; then
    fail "plan accepted duplicate $duplicate_mode state"
  fi
  assert_contains "$error" 'expected exactly one'
  assert_captured_artifacts_are_secret_free
done

for cleanup_exit in success failure; do
  cleanup_report="$test_root/cleanup-$cleanup_exit.paths"
  cleanup_harness="$test_root/cleanup-$cleanup_exit.sh"
  cat >"$cleanup_harness" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "$repo_root/scripts/dokploy-api.sh"
transaction_dir=\$(mktemp -d /tmp/systemvitals-cleanup-test.XXXXXXXX)
cleanup_transaction() {
  rm -rf -- "\$transaction_dir"
}
dokploy_register_cleanup cleanup_transaction
export DOKPLOY_URL=https://dokploy.test
export DOKPLOY_API_KEY=TEST_DOKPLOY_API_KEY
_dokploy_init
printf '%s\n%s\n' "\$transaction_dir" "\$DOKPLOY_API_TMPDIR" >"$cleanup_report"
[[ $cleanup_exit == success ]]
EOF
  chmod +x "$cleanup_harness"
  if [[ $cleanup_exit == success ]]; then
    "$cleanup_harness"
  elif "$cleanup_harness"; then
    fail "cleanup failure harness unexpectedly succeeded"
  fi
  while IFS= read -r cleanup_path; do
    [[ ! -e $cleanup_path ]] ||
      fail "$cleanup_exit left protected temporary directory behind"
  done <"$cleanup_report"
done

printf 'configure-managed-telegram-dokploy tests passed\n'
