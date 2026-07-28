#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091 # Replaced by a fake beside this script in tests.
source "$repo_root/scripts/dokploy-api.sh"

project_name=SystemVitals
environment_name=production
api_name="SystemVitals API"
worker_name="SystemVitals Worker"
expected_bot_username=systemvitals_bot
fixed_webhook_url=https://api.systemvitals.link/integrations/telegram/webhook
transaction_dir=

cleanup() {
  if [[ -n $transaction_dir && -d $transaction_dir ]]; then
    rm -rf -- "$transaction_dir"
  fi
}
dokploy_register_cleanup cleanup

block() {
  printf 'BLOCKED: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/configure-managed-telegram-dokploy.sh plan
  scripts/configure-managed-telegram-dokploy.sh apply \
    --confirm configure-managed-telegram

Credentials are read only from DOKPLOY_URL, DOKPLOY_API_KEY,
SYSTEMVITALS_TELEGRAM_BOT_TOKEN, and
SYSTEMVITALS_TELEGRAM_WEBHOOK_SECRET in the protected operator environment.
Output contains safe object identities and boolean results only. This command
does not deploy applications.
EOF
}

mode=${1:-}
confirm=
[[ -n $mode ]] || block "mode is required; use plan or apply"
shift
case "$mode" in
  plan | apply) ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) block "unsupported mode '$mode'" ;;
esac

while (($# > 0)); do
  case "$1" in
    --confirm)
      (($# >= 2)) || block "--confirm requires a value"
      confirm=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) block "unsupported argument '$1'" ;;
  esac
done

if [[ $mode == apply ]]; then
  [[ $confirm == configure-managed-telegram ]] ||
    block "apply requires exact confirmation: --confirm configure-managed-telegram"
else
  [[ -z $confirm ]] || block "plan does not accept --confirm"
fi

require_environment() {
  local name=$1
  local value=${!name:-}

  [[ -n $value ]] || block "$name must be set and nonempty"
  [[ $value != *$'\n'* && $value != *$'\r'* ]] ||
    block "$name contains unsupported characters"
}

for required_name in \
  DOKPLOY_URL \
  DOKPLOY_API_KEY \
  SYSTEMVITALS_TELEGRAM_BOT_TOKEN \
  SYSTEMVITALS_TELEGRAM_WEBHOOK_SECRET; do
  require_environment "$required_name"
done

[[ $SYSTEMVITALS_TELEGRAM_BOT_TOKEN =~ ^[0-9]{6,}:[A-Za-z0-9_-]{35}$ ]] ||
  block "SYSTEMVITALS_TELEGRAM_BOT_TOKEN has an invalid format"
[[ $SYSTEMVITALS_TELEGRAM_WEBHOOK_SECRET =~ ^[A-Za-z0-9_-]{1,256}$ ]] ||
  block "SYSTEMVITALS_TELEGRAM_WEBHOOK_SECRET has an invalid format"

umask 077
transaction_dir=$(mktemp -d "/tmp/systemvitals-telegram.XXXXXXXX")
chmod 0700 "$transaction_dir"

write_file() {
  local path=$1
  command dd of="$path" status=none
  chmod 0600 "$path"
}

if ! declare -F telegram_api_request >/dev/null; then
  telegram_api_request() {
    local method=$1
    local payload_file=${2:-}
    local request_config="$transaction_dir/telegram-$method.conf"
    local response_file="$transaction_dir/telegram-$method.response"
    local error_file="$transaction_dir/telegram-$method.error"
    local api_url
    local http_code

    api_url="https://api.telegram.org/bot${SYSTEMVITALS_TELEGRAM_BOT_TOKEN}/$method"
    {
      printf '%s\n' \
        'fail-with-body' \
        'silent' \
        'show-error' \
        'max-time = 30'
      printf 'url = "%s"\n' "$api_url"
      if [[ -n $payload_file ]]; then
        printf '%s\n' \
          'header = "Content-Type: application/json"' \
          "data-binary = \"@$payload_file\""
      fi
    } | write_file "$request_config"

    if ! http_code=$(curl --config "$request_config" \
      --output "$response_file" --write-out '%{http_code}' \
      2>"$error_file"); then
      printf 'ERROR: Telegram %s request failed\n' "$method" >&2
      return 1
    fi
    [[ $http_code == 2?? ]] || {
      printf 'ERROR: Telegram %s request failed (HTTP status rejected)\n' \
        "$method" >&2
      return 1
    }
    jq -c '
      if .ok != true then error("Telegram response rejected")
      elif (.result | type) == "object" then
        {ok:true,result:{
          id:(.result.id // null),
          is_bot:(.result.is_bot // null),
          username:(.result.username // null),
          url:(.result.url // null),
          pending_update_count:(.result.pending_update_count // null),
          last_error_message:(.result.last_error_message // null)
        }}
      else {ok:true,result:.result}
      end
    ' "$response_file" 2>/dev/null || {
      printf 'ERROR: Telegram %s response was invalid\n' "$method" >&2
      return 1
    }
  }
fi

if ! declare -F dokploy_post_file >/dev/null; then
  dokploy_post_file() {
    local path=$1
    local payload_file=$2
    local response_file="$transaction_dir/dokploy.response"
    local error_file="$transaction_dir/dokploy.error"
    local http_code

    _dokploy_init
    _dokploy_validate_path "$path"
    jq -e . "$payload_file" >/dev/null 2>&1 || {
      printf 'ERROR: Dokploy POST payload was invalid\n' >&2
      return 1
    }
    if ! http_code=$(curl \
      --config "$DOKPLOY_API_TMPDIR/curl.conf" \
      --request POST \
      --data-binary "@$payload_file" \
      --output "$response_file" \
      --write-out '%{http_code}' \
      "$DOKPLOY_URL$path" 2>"$error_file"); then
      printf 'ERROR: Dokploy POST failed\n' >&2
      return 1
    fi
    [[ $http_code == 2?? ]] || {
      printf 'ERROR: Dokploy POST failed (HTTP status rejected)\n' >&2
      return 1
    }
    jq -e . "$response_file" >/dev/null 2>&1 || {
      printf 'ERROR: Dokploy POST returned an invalid response\n' >&2
      return 1
    }
  }
fi

bot_json=$(telegram_api_request getMe) ||
  block "Telegram bot identity verification failed"
bot_username=$(jq -r '
  if .ok == true and .result.is_bot == true
  then .result.username // ""
  else ""
  end
' <<<"$bot_json")
[[ $bot_username == "$expected_bot_username" ]] ||
  block "Telegram bot identity did not match expected username"

projects_json=$(dokploy_get "/api/project.all")
project_json=$(printf '%s' "$projects_json" |
  dokploy_expect_one \
    ".[] | select(.name == \"$project_name\")" \
    "project named '$project_name'") || exit 1
environment_json=$(printf '%s' "$project_json" |
  dokploy_expect_one \
    ".environments[]? | select(.name == \"$environment_name\")" \
    "environment named '$environment_name'") || exit 1
api_summary=$(printf '%s' "$environment_json" |
  dokploy_expect_one \
    ".applications[]? | select(.name == \"$api_name\")" \
    "application named '$api_name'") || exit 1
worker_summary=$(printf '%s' "$environment_json" |
  dokploy_expect_one \
    ".applications[]? | select(.name == \"$worker_name\")" \
    "application named '$worker_name'") || exit 1

project_id=$(jq -r '.projectId' <<<"$project_json")
environment_id=$(jq -r '.environmentId' <<<"$environment_json")
api_id=$(jq -r '.applicationId' <<<"$api_summary")
worker_id=$(jq -r '.applicationId' <<<"$worker_summary")
for resolved_id in "$project_id" "$environment_id" "$api_id" "$worker_id"; do
  [[ $resolved_id =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "resolved Dokploy ID contains unsupported characters"
done

api_input=$(jq -cn --arg application_id "$api_id" \
  '{applicationId: $application_id}')
worker_input=$(jq -cn --arg application_id "$worker_id" \
  '{applicationId: $application_id}')
api_json=$(dokploy_trpc_get "application.one" "$api_input")
worker_json=$(dokploy_trpc_get "application.one" "$worker_input")

verify_application() {
  local application_id=$1
  local expected_name=$2

  jq -e \
    --arg id "$application_id" \
    --arg environment_id "$environment_id" \
    --arg name "$expected_name" '
      .applicationId == $id and
      .environmentId == $environment_id and
      .name == $name
    ' >/dev/null
}

printf '%s' "$api_json" | verify_application "$api_id" "$api_name" ||
  block "API application identity did not match"
printf '%s' "$worker_json" | verify_application "$worker_id" "$worker_name" ||
  block "worker application identity did not match"

build_environment_payload() {
  local application_id=$1
  local source_file=$2
  shift 2

  SV_APPLICATION_ID=$application_id jq -c '
    . as $application |
    (env.SV_ENV_NAMES | split(",")) as $names |
    reduce $names[] as $name (
      ($application.env // "");
      (env[
        if $name == "TELEGRAM_BOT_TOKEN"
        then "SYSTEMVITALS_TELEGRAM_BOT_TOKEN"
        elif $name == "TELEGRAM_WEBHOOK_SECRET"
        then "SYSTEMVITALS_TELEGRAM_WEBHOOK_SECRET"
        else "SV_FIXED_TELEGRAM_WEBHOOK_URL"
        end
      ]) as $value |
      (split("\n")) as $lines |
      if ($lines | any(startswith($name + "="))) then
        $lines |
        reduce .[] as $line (
          {seen:false, lines:[]};
          if ($line | startswith($name + "=")) then
            if .seen then .lines += [""]
            else .seen = true | .lines += [$name + "=" + $value]
            end
          else .lines += [$line]
          end
        ) |
        .lines | join("\n")
      elif . == "" then
        $name + "=" + $value
      elif endswith("\n") then
        (match("\n+$")) as $suffix |
        .[0:$suffix.offset] as $body |
        .[$suffix.offset:] as $trailing |
        $body + "\n" + $name + "=" + $value + $trailing
      else
        . + "\n" + $name + "=" + $value
      end
    ) |
    {
      applicationId: env.SV_APPLICATION_ID,
      env: .,
      buildArgs: $application.buildArgs,
      buildSecrets: $application.buildSecrets,
      createEnvFile: $application.createEnvFile
    }
  ' "$source_file"
}

build_original_payload() {
  local application_id=$1
  local source_file=$2

  SV_APPLICATION_ID=$application_id jq -c '{
    applicationId: env.SV_APPLICATION_ID,
    env: (.env // ""),
    buildArgs,
    buildSecrets,
    createEnvFile
  }' "$source_file"
}

printf '%s' "$api_json" | write_file "$transaction_dir/api-before.json"
printf '%s' "$worker_json" | write_file "$transaction_dir/worker-before.json"

validate_target_assignments() {
  local source_file=$1
  shift
  local name

  for name in "$@"; do
    jq -e --arg name "$name" '
      (.env // "" | split("\n")) as $lines |
      ([$lines[] | select(startswith($name + "="))] | length) as $canonical |
      ([
        $lines[] |
        select(test(
          "^[[:space:]]*(export[[:space:]]+)?" +
          $name + "[[:space:]]*="
        ))
      ] | length) as $variants |
      $canonical <= 1 and $variants == $canonical
    ' "$source_file" >/dev/null ||
      block "ambiguous Telegram environment assignment for $name"
  done
}

validate_target_assignments "$transaction_dir/api-before.json" \
  TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_WEBHOOK_URL
validate_target_assignments "$transaction_dir/worker-before.json" \
  TELEGRAM_BOT_TOKEN

SV_FIXED_TELEGRAM_WEBHOOK_URL=$fixed_webhook_url
export SV_FIXED_TELEGRAM_WEBHOOK_URL
SV_ENV_NAMES=TELEGRAM_BOT_TOKEN,TELEGRAM_WEBHOOK_SECRET,TELEGRAM_WEBHOOK_URL
export SV_ENV_NAMES
build_environment_payload "$api_id" "$transaction_dir/api-before.json" |
  write_file "$transaction_dir/api-desired.json"
SV_ENV_NAMES=TELEGRAM_BOT_TOKEN
export SV_ENV_NAMES
build_environment_payload "$worker_id" "$transaction_dir/worker-before.json" |
  write_file "$transaction_dir/worker-desired.json"
build_original_payload "$api_id" "$transaction_dir/api-before.json" |
  write_file "$transaction_dir/api-rollback.json"
build_original_payload "$worker_id" "$transaction_dir/worker-before.json" |
  write_file "$transaction_dir/worker-rollback.json"

variable_state() {
  local current_file=$1
  local desired_file=$2

  if jq -e --slurpfile desired "$desired_file" \
    '.env == $desired[0].env' "$current_file" >/dev/null; then
    printf 'unchanged'
  else
    printf 'changed'
  fi
}

api_state=$(variable_state \
  "$transaction_dir/api-before.json" "$transaction_dir/api-desired.json")
worker_state=$(variable_state \
  "$transaction_dir/worker-before.json" "$transaction_dir/worker-desired.json")

if [[ $mode == plan ]]; then
  jq -n \
    --arg project_name "$project_name" \
    --arg project_id "$project_id" \
    --arg environment_name "$environment_name" \
    --arg environment_id "$environment_id" \
    --arg api_name "$api_name" \
    --arg api_id "$api_id" \
    --arg api_state "$api_state" \
    --arg worker_name "$worker_name" \
    --arg worker_id "$worker_id" \
    --arg worker_state "$worker_state" '{
      bot_identity_verified:true,
      project:{name:$project_name,id:$project_id},
      environment:{name:$environment_name,id:$environment_id},
      targets:[
        {name:$api_name,id:$api_id,state:$api_state,
         variables:["TELEGRAM_BOT_TOKEN","TELEGRAM_WEBHOOK_SECRET",
                    "TELEGRAM_WEBHOOK_URL"]},
        {name:$worker_name,id:$worker_id,state:$worker_state,
         variables:["TELEGRAM_BOT_TOKEN"]}
      ]
    }'
  exit 0
fi

old_webhook_json=$(telegram_api_request getWebhookInfo) ||
  block "could not inspect current Telegram webhook"
printf '%s' "$old_webhook_json" |
  write_file "$transaction_dir/webhook-before.json"
old_webhook_url=$(jq -r '.result.url // ""' <<<"$old_webhook_json")
if [[ -n $old_webhook_url ]]; then
  jq -j '
    .env |
    split("\n")[] |
    select(startswith("TELEGRAM_WEBHOOK_SECRET=")) |
    ltrimstr("TELEGRAM_WEBHOOK_SECRET=")
  ' "$transaction_dir/api-before.json" |
    write_file "$transaction_dir/previous-webhook-secret"
  grep -Eq '^[A-Za-z0-9_-]{1,256}$' \
    "$transaction_dir/previous-webhook-secret" ||
    block "previous API Telegram webhook secret is not safely restorable"
fi
api_rollback_needed=false
worker_rollback_needed=false
webhook_rollback_needed=false

rollback() {
  local rollback_ok=true
  local current
  local webhook_current

  if [[ $webhook_rollback_needed == true ]]; then
    if [[ -n $old_webhook_url ]]; then
      SV_OLD_WEBHOOK_URL=$old_webhook_url jq -n '{
        url:env.SV_OLD_WEBHOOK_URL,
        secret_token:$previous_secret
      }' --rawfile previous_secret \
        "$transaction_dir/previous-webhook-secret" |
        write_file "$transaction_dir/webhook-rollback.json"
      telegram_api_request setWebhook \
        "$transaction_dir/webhook-rollback.json" >/dev/null ||
        rollback_ok=false
    else
      telegram_api_request deleteWebhook >/dev/null || rollback_ok=false
    fi
    webhook_current=$(telegram_api_request getWebhookInfo) ||
      rollback_ok=false
    if [[ $rollback_ok == true ]] &&
      ! jq -e --slurpfile before "$transaction_dir/webhook-before.json" '
        .result.url == $before[0].result.url
      ' <<<"$webhook_current" >/dev/null; then
      rollback_ok=false
    fi
  fi
  if [[ $worker_rollback_needed == true ]]; then
    dokploy_post_file "/api/application.saveEnvironment" \
      "$transaction_dir/worker-rollback.json" >/dev/null ||
      rollback_ok=false
  fi
  if [[ $api_rollback_needed == true ]]; then
    dokploy_post_file "/api/application.saveEnvironment" \
      "$transaction_dir/api-rollback.json" >/dev/null ||
      rollback_ok=false
  fi

  current=$(dokploy_trpc_get "application.one" "$api_input") ||
    rollback_ok=false
  if [[ $rollback_ok == true ]] &&
    ! jq -e --slurpfile before "$transaction_dir/api-before.json" '
      .env == $before[0].env and
      .buildArgs == $before[0].buildArgs and
      .buildSecrets == $before[0].buildSecrets and
      .createEnvFile == $before[0].createEnvFile
    ' <<<"$current" >/dev/null; then
    rollback_ok=false
  fi
  current=$(dokploy_trpc_get "application.one" "$worker_input") ||
    rollback_ok=false
  if [[ $rollback_ok == true ]] &&
    ! jq -e --slurpfile before "$transaction_dir/worker-before.json" '
      .env == $before[0].env and
      .buildArgs == $before[0].buildArgs and
      .buildSecrets == $before[0].buildSecrets and
      .createEnvFile == $before[0].createEnvFile
    ' <<<"$current" >/dev/null; then
    rollback_ok=false
  fi
  printf 'rollback_verified=%s\n' "$rollback_ok" >&2
  [[ $rollback_ok == true ]]
}

transaction_failed() {
  local step=$1

  rollback || true
  block "$step failed"
}

api_rollback_needed=true
dokploy_post_file "/api/application.saveEnvironment" \
  "$transaction_dir/api-desired.json" >/dev/null ||
  transaction_failed "API environment update"
worker_rollback_needed=true
dokploy_post_file "/api/application.saveEnvironment" \
  "$transaction_dir/worker-desired.json" >/dev/null ||
  transaction_failed "worker environment update"

jq -n '{
  url:env.SV_FIXED_TELEGRAM_WEBHOOK_URL,
  secret_token:env.SYSTEMVITALS_TELEGRAM_WEBHOOK_SECRET
}' | write_file "$transaction_dir/webhook-desired.json"
webhook_rollback_needed=true
telegram_api_request setWebhook "$transaction_dir/webhook-desired.json" \
  >/dev/null || transaction_failed "Telegram setWebhook"
webhook_json=$(telegram_api_request getWebhookInfo) ||
  transaction_failed "Telegram getWebhookInfo"
jq -e --arg url "$fixed_webhook_url" '
  .ok == true and
  .result.url == $url and
  ((.result.last_error_message // "") == "")
' <<<"$webhook_json" >/dev/null ||
  transaction_failed "Telegram webhook verification"

api_readback=$(dokploy_trpc_get "application.one" "$api_input") ||
  transaction_failed "API environment readback"
worker_readback=$(dokploy_trpc_get "application.one" "$worker_input") ||
  transaction_failed "worker environment readback"
jq -e --slurpfile desired "$transaction_dir/api-desired.json" '
  .env == $desired[0].env and
  .buildArgs == $desired[0].buildArgs and
  .buildSecrets == $desired[0].buildSecrets and
  .createEnvFile == $desired[0].createEnvFile
' <<<"$api_readback" >/dev/null ||
  transaction_failed "API environment readback"
jq -e --slurpfile desired "$transaction_dir/worker-desired.json" '
  .env == $desired[0].env and
  .buildArgs == $desired[0].buildArgs and
  .buildSecrets == $desired[0].buildSecrets and
  .createEnvFile == $desired[0].createEnvFile
' <<<"$worker_readback" >/dev/null ||
  transaction_failed "worker environment readback"

jq -n \
  --arg project_name "$project_name" \
  --arg project_id "$project_id" \
  --arg environment_name "$environment_name" \
  --arg environment_id "$environment_id" \
  --arg api_name "$api_name" \
  --arg api_id "$api_id" \
  --arg worker_name "$worker_name" \
  --arg worker_id "$worker_id" '{
    bot_identity_verified:true,
    webhook_verified:true,
    project:{name:$project_name,id:$project_id},
    environment:{name:$environment_name,id:$environment_id},
    targets:[
      {name:$api_name,id:$api_id,updated:true},
      {name:$worker_name,id:$worker_id,updated:true}
    ]
  }'
