#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091 # Resolved from the repository root at runtime.
source "$repo_root/scripts/dokploy-api.sh"

project_name=SystemVitals
environment_name=production
legacy_compose_name="SystemVitals Stack"
infrastructure_compose_name="SystemVitals Infrastructure"
api_name="SystemVitals API"
worker_name="SystemVitals Worker"
frontend_name="SystemVitals Frontend"
network_name=systemvitals-internal
api_production_domain=api.systemvitals.link
frontend_production_domain=systemvitals.link
api_legacy_domain=api.systemvitals.nihey.org
frontend_legacy_domain=systemvitals.nihey.org
api_temp_domain=${SYSTEMVITALS_API_TEMP_DOMAIN:-api-staging.systemvitals.link}
frontend_temp_domain=${SYSTEMVITALS_FRONTEND_TEMP_DOMAIN:-staging.systemvitals.link}
cutover_verify_attempts=${SYSTEMVITALS_CUTOVER_VERIFY_ATTEMPTS:-6}
cutover_verify_retry_delay_seconds=${SYSTEMVITALS_CUTOVER_VERIFY_RETRY_DELAY_SECONDS:-10}

block() {
  printf 'BLOCKED: %s\n' "$*" >&2
  exit 1
}

github_owner=${SYSTEMVITALS_GITHUB_OWNER:-SystemVitals}
github_repository=${SYSTEMVITALS_GITHUB_REPOSITORY:-systemvitals}
github_branch=${SYSTEMVITALS_GITHUB_BRANCH:-main}

[[ $github_owner =~ ^[A-Za-z0-9._-]+$ ]] ||
  block "SYSTEMVITALS_GITHUB_OWNER contains unsupported characters"
[[ $github_repository =~ ^[A-Za-z0-9._-]+$ ]] ||
  block "SYSTEMVITALS_GITHUB_REPOSITORY contains unsupported characters"
[[ $github_branch =~ ^[A-Za-z0-9._/-]+$ ]] ||
  block "SYSTEMVITALS_GITHUB_BRANCH contains unsupported characters"

usage() {
  cat <<'EOF'
Usage:
  scripts/provision-dokploy-zero-downtime.sh plan
  scripts/provision-dokploy-zero-downtime.sh generate-replacement-smoke --confirm generate-replacement-smoke \
    --api-deployment-id ID --worker-deployment-id ID --frontend-deployment-id ID
  scripts/provision-dokploy-zero-downtime.sh generate-worker-drain --confirm generate-worker-drain \
    --old-worker-container-id ID --new-worker-deployment-id ID \
    --attest-active-jobs-zero --attest-queue-failures-unchanged \
    --attest-no-duplicate-scheduler-dispatches
  scripts/provision-dokploy-zero-downtime.sh apply-apps --confirm apply-apps
  scripts/provision-dokploy-zero-downtime.sh cutover-domains --confirm cutover-domains
  scripts/provision-dokploy-zero-downtime.sh finalize-infrastructure --confirm finalize-infrastructure
  scripts/provision-dokploy-zero-downtime.sh verify

plan, verify, and receipt generation make no Dokploy mutations. Receipt
generation performs live checks and writes a signed mode-0600 gate receipt
outside the repository. Every state-changing or attestation-bearing mode
requires its exact stage-specific confirmation.
EOF
}

mode=${1:-}
confirm=
smoke_receipt=
worker_drain_receipt=
api_deployment_id=
worker_deployment_id=
frontend_deployment_id=
old_worker_container_id=
new_worker_deployment_id=
attest_active_jobs_zero=false
attest_queue_failures_unchanged=false
attest_no_duplicate_scheduler_dispatches=false
if [[ -z $mode ]]; then
  block "mode is required; use plan, apply-apps, cutover-domains, finalize-infrastructure, or verify"
fi
shift

case "$mode" in
  plan | generate-replacement-smoke | generate-worker-drain | apply-apps | \
    cutover-domains | finalize-infrastructure | verify)
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    block "unsupported mode '$mode'"
    ;;
esac

while (($# > 0)); do
  case "$1" in
    --confirm)
      (($# >= 2)) || block "--confirm requires a stage name"
      confirm=$2
      shift 2
      ;;
    --smoke-receipt)
      (($# >= 2)) || block "--smoke-receipt requires a path"
      smoke_receipt=$2
      shift 2
      ;;
    --worker-drain-receipt)
      (($# >= 2)) || block "--worker-drain-receipt requires a path"
      worker_drain_receipt=$2
      shift 2
      ;;
    --api-deployment-id)
      (($# >= 2)) || block "--api-deployment-id requires a value"
      api_deployment_id=$2
      shift 2
      ;;
    --worker-deployment-id)
      (($# >= 2)) || block "--worker-deployment-id requires a value"
      worker_deployment_id=$2
      shift 2
      ;;
    --frontend-deployment-id)
      (($# >= 2)) || block "--frontend-deployment-id requires a value"
      frontend_deployment_id=$2
      shift 2
      ;;
    --old-worker-container-id)
      (($# >= 2)) || block "--old-worker-container-id requires a value"
      old_worker_container_id=$2
      shift 2
      ;;
    --new-worker-deployment-id)
      (($# >= 2)) || block "--new-worker-deployment-id requires a value"
      new_worker_deployment_id=$2
      shift 2
      ;;
    --attest-active-jobs-zero)
      attest_active_jobs_zero=true
      shift
      ;;
    --attest-queue-failures-unchanged)
      attest_queue_failures_unchanged=true
      shift
      ;;
    --attest-no-duplicate-scheduler-dispatches)
      attest_no_duplicate_scheduler_dispatches=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      block "unsupported argument '$1'"
      ;;
  esac
done

case "$mode" in
  generate-replacement-smoke | generate-worker-drain | apply-apps | \
    cutover-domains | finalize-infrastructure)
    [[ $confirm == "$mode" ]] ||
      block "$mode requires exact confirmation: --confirm $mode"
    ;;
  plan | verify)
    [[ -z $confirm ]] || block "$mode does not accept --confirm"
    ;;
esac
case "$mode" in
  generate-replacement-smoke)
    [[ -n $api_deployment_id && -n $worker_deployment_id &&
      -n $frontend_deployment_id ]] ||
      block "generate-replacement-smoke requires all three deployment IDs"
    [[ -z $old_worker_container_id && -z $new_worker_deployment_id &&
      $attest_active_jobs_zero == false &&
      $attest_queue_failures_unchanged == false &&
      $attest_no_duplicate_scheduler_dispatches == false &&
      -z $smoke_receipt && -z $worker_drain_receipt ]] ||
      block "generate-replacement-smoke received unrelated arguments"
    ;;
  generate-worker-drain)
    [[ -n $old_worker_container_id && -n $new_worker_deployment_id ]] ||
      block "generate-worker-drain requires old container and new deployment IDs"
    [[ $attest_active_jobs_zero == true &&
      $attest_queue_failures_unchanged == true &&
      $attest_no_duplicate_scheduler_dispatches == true ]] ||
      block "generate-worker-drain requires all three explicit attestations"
    [[ -z $api_deployment_id && -z $worker_deployment_id &&
      -z $frontend_deployment_id && -z $smoke_receipt &&
      -z $worker_drain_receipt ]] ||
      block "generate-worker-drain received unrelated arguments"
    ;;
  cutover-domains)
    [[ -n $smoke_receipt ]] ||
      block "cutover-domains requires --smoke-receipt PATH"
    [[ -z $worker_drain_receipt ]] ||
      block "cutover-domains does not accept --worker-drain-receipt"
    ;;
  finalize-infrastructure)
    [[ -n $worker_drain_receipt ]] ||
      block "finalize-infrastructure requires --worker-drain-receipt PATH"
    [[ -z $smoke_receipt ]] ||
      block "finalize-infrastructure does not accept --smoke-receipt"
    ;;
  apply-apps | plan | verify)
    [[ -z $smoke_receipt && -z $worker_drain_receipt ]] ||
      block "$mode does not accept gate receipts"
    ;;
esac

case "$mode" in
  generate-replacement-smoke | generate-worker-drain)
    ;;
  *)
    [[ -z $api_deployment_id && -z $worker_deployment_id &&
      -z $frontend_deployment_id && -z $old_worker_container_id &&
      -z $new_worker_deployment_id &&
      $attest_active_jobs_zero == false &&
      $attest_queue_failures_unchanged == false &&
      $attest_no_duplicate_scheduler_dispatches == false ]] ||
      block "$mode does not accept receipt-generation arguments"
    ;;
esac

project_json=
environment_json=
compose_json=
applications_json=
compose_id=
project_id=
environment_id=
api_id=
worker_id=
frontend_id=

resolve_optional_application() {
  local name=$1
  local count

  count=$(jq -r --arg name "$name" \
    '[.applications[]? | select(.name == $name)] | length' \
    <<<"$environment_json")
  if ((count > 1)); then
    block "expected exactly one application named '$name'; found $count"
  fi
}

discover_state() {
  local projects_json
  local compose_summary

  projects_json=$(dokploy_get "/api/project.all")
  project_json=$(printf '%s' "$projects_json" |
    dokploy_expect_one \
      ".[] | select(.name == \"$project_name\")" \
      "project named '$project_name'") || exit 1

  environment_json=$(printf '%s' "$project_json" |
    dokploy_expect_one \
      ".environments[]? | select(.name == \"$environment_name\")" \
      "environment named '$environment_name'") || exit 1

  compose_summary=$(printf '%s' "$environment_json" |
    dokploy_expect_one \
      ".compose[]? | select(.name == \"$legacy_compose_name\" or .name == \"$infrastructure_compose_name\")" \
      "Compose named '$legacy_compose_name' or '$infrastructure_compose_name'") ||
    exit 1

  resolve_optional_application "$api_name"
  resolve_optional_application "$worker_name"
  resolve_optional_application "$frontend_name"

  applications_json=$(jq -c \
    --arg api "$api_name" \
    --arg worker "$worker_name" \
    --arg frontend "$frontend_name" '
      [
        .applications[]? |
        select(.name == $api or .name == $worker or .name == $frontend)
      ]
    ' <<<"$environment_json")

  compose_id=$(jq -r '.composeId' <<<"$compose_summary")
  [[ $compose_id =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "resolved Compose ID contains unsupported characters"
  compose_json=$(dokploy_get "/api/compose.one?composeId=$compose_id")
  project_id=$(jq -r '.projectId' <<<"$project_json")
  environment_id=$(jq -r '.environmentId' <<<"$environment_json")
  jq -e \
    --arg compose_id "$compose_id" \
    --arg environment_id "$(jq -r '.environmentId' <<<"$environment_json")" \
    --arg legacy "$legacy_compose_name" \
    --arg infrastructure "$infrastructure_compose_name" '
      .composeId == $compose_id and
      .environmentId == $environment_id and
      (.name == $legacy or .name == $infrastructure)
    ' <<<"$compose_json" >/dev/null ||
    block "Compose detail does not match the resolved project environment"
}

safe_discovery_snapshot() {
  jq -cnS \
    --slurpfile project <(printf '%s' "$project_json") \
    --slurpfile environment <(printf '%s' "$environment_json") \
    --slurpfile compose <(printf '%s' "$compose_json") \
    --slurpfile applications <(printf '%s' "$applications_json") '
      ($project[0]) as $project |
      ($environment[0]) as $environment |
      ($compose[0]) as $compose |
      ($applications[0]) as $applications |
      {
        projectId: $project.projectId,
        environmentId: $environment.environmentId,
        compose: {
          composeId: $compose.composeId,
          name: $compose.name,
          appName: $compose.appName,
          composePath: $compose.composePath,
          autoDeploy: $compose.autoDeploy,
          status: $compose.composeStatus,
          domains: [
            $compose.domains[]? |
            {
              domainId,
              host,
              port,
              https,
              path,
              serviceName,
              certificateType,
              domainType
            }
          ]
        },
        applications: [
          $applications[] |
          {
            applicationId,
            name,
            appName,
            status: .applicationStatus
          }
        ]
      }
    '
}

hash_json() {
  jq -cS . | sha256sum | awk '{print $1}'
}

receipt_directory() {
  local state_home
  local receipt_dir
  local normalized_repo
  local normalized_receipts

  if [[ -n ${SYSTEMVITALS_DOKPLOY_RECEIPT_DIR:-} ]]; then
    receipt_dir=$SYSTEMVITALS_DOKPLOY_RECEIPT_DIR
  else
    state_home=${XDG_STATE_HOME:-${HOME:?HOME must be set}/.local/state}
    receipt_dir="$state_home/systemvitals/dokploy-receipts"
  fi
  [[ $receipt_dir == /* ]] ||
    block "SYSTEMVITALS_DOKPLOY_RECEIPT_DIR must be an absolute path"
  normalized_repo=$(realpath -m "$repo_root")
  normalized_receipts=$(realpath -m "$receipt_dir")
  case "$normalized_receipts" in
    "$normalized_repo" | "$normalized_repo"/*)
      block "Dokploy receipts must be stored outside the repository"
      ;;
  esac
  mkdir -p "$normalized_receipts"
  chmod 0700 "$normalized_receipts"
  printf '%s' "$normalized_receipts"
}

write_receipt() {
  local stage=$1
  local before_hash=$2
  local after_hash=$3
  local object_ids=$4
  local settings=$5
  local receipt_dir
  local receipt_file
  local temporary_file
  local created_at

  receipt_dir=$(receipt_directory)
  created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  receipt_file="$receipt_dir/$stage-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  temporary_file=$(mktemp "$receipt_dir/.receipt.XXXXXXXX")
  chmod 0600 "$temporary_file"
  jq -n \
    --arg stage "$stage" \
    --arg created_at "$created_at" \
    --arg before_hash "$before_hash" \
    --arg after_hash "$after_hash" \
    --argjson object_ids "$object_ids" \
    --argjson settings "$settings" '{
      schemaVersion: 1,
      stage: $stage,
      createdAt: $created_at,
      objectIds: $object_ids,
      beforeHash: $before_hash,
      afterHash: $after_hash,
      settings: $settings
    }' >"$temporary_file"
  mv "$temporary_file" "$receipt_file"
  chmod 0600 "$receipt_file"
  printf '%s' "$receipt_file"
}

require_safe_runtime_id() {
  local name=$1
  local value=$2

  [[ -n $value && $value =~ ^[A-Za-z0-9._:-]+$ ]] ||
    block "$name contains unsupported characters"
}

gate_receipt_signature() {
  local canonical=$1

  [[ -n ${SYSTEMVITALS_RECEIPT_HMAC_KEY:-} ]] ||
    block "SYSTEMVITALS_RECEIPT_HMAC_KEY must be set and nonempty"
  [[ $SYSTEMVITALS_RECEIPT_HMAC_KEY != *$'\n'* &&
    $SYSTEMVITALS_RECEIPT_HMAC_KEY != *$'\r'* ]] ||
    block "SYSTEMVITALS_RECEIPT_HMAC_KEY contains unsupported characters"
  command -v node >/dev/null 2>&1 ||
    block "required command 'node' is unavailable"
  {
    printf '%s\n' "$SYSTEMVITALS_RECEIPT_HMAC_KEY"
    printf '%s' "$canonical"
  } | node -e '
    const crypto = require("node:crypto");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const separator = input.indexOf("\n");
      if (separator < 1) process.exit(2);
      const key = input.slice(0, separator);
      const data = input.slice(separator + 1);
      process.stdout.write(
        crypto.createHmac("sha256", key).update(data).digest("hex")
      );
    });
  '
}

write_signed_gate_receipt() {
  local kind=$1
  local receipt_json=$2
  local receipt_dir
  local receipt_file
  local temporary_file
  local canonical
  local signature

  jq -e 'type == "object" and has("signature") == false' \
    <<<"$receipt_json" >/dev/null ||
    block "unsigned gate receipt is invalid"
  canonical=$(jq -cS . <<<"$receipt_json")
  signature=$(gate_receipt_signature "$canonical") ||
    block "could not sign gate receipt"
  [[ $signature =~ ^[a-f0-9]{64}$ ]] ||
    block "gate receipt signature generation failed"
  receipt_dir=$(receipt_directory)
  receipt_file="$receipt_dir/$kind-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  temporary_file=$(mktemp "$receipt_dir/.gate-receipt.XXXXXXXX")
  chmod 0600 "$temporary_file"
  jq --arg signature "$signature" '. + {signature:$signature}' \
    <<<"$receipt_json" >"$temporary_file"
  mv "$temporary_file" "$receipt_file"
  chmod 0600 "$receipt_file"
  printf '%s' "$receipt_file"
}

require_safe_host() {
  local variable_name=$1
  local host=${2:-${!variable_name:-}}

  [[ -n $host ]] || block "$variable_name must be set and nonempty"
  [[ $host =~ ^[A-Za-z0-9.-]+$ && $host == *.* ]] ||
    block "$variable_name must be a DNS host name without a scheme or path"
}

ensure_internal_network() {
  local network_json

  command -v docker >/dev/null 2>&1 ||
    block "required command 'docker' is unavailable"
  if network_json=$(docker network inspect "$network_name" 2>/dev/null); then
    :
  else
    docker network create --driver overlay --attachable "$network_name" \
      >/dev/null
    network_json=$(docker network inspect "$network_name" 2>/dev/null) ||
      block "could not read back the created $network_name network"
  fi
  jq -e \
    --arg network "$network_name" '
      length == 1 and
      .[0].Name == $network and
      .[0].Driver == "overlay" and
      .[0].Scope == "swarm" and
      .[0].Attachable == true
    ' <<<"$network_json" >/dev/null ||
    block "$network_name must be an attachable swarm overlay network"
}

application_id_from_environment() {
  local name=$1

  jq -r --arg name "$name" '
    [.applications[]? | select(.name == $name)] |
    if length == 1 then .[0].applicationId else empty end
  ' <<<"$environment_json"
}

get_application() {
  local application_id=$1
  local input

  [[ $application_id =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "resolved application ID contains unsupported characters"
  input=$(jq -cn --arg application_id "$application_id" '{
    applicationId: $application_id
  }')
  dokploy_trpc_get "application.one" "$input"
}

create_or_get_application() {
  local name=$1
  local result_variable=$2
  local application_id
  local create_payload
  local create_response
  local application

  application_id=$(application_id_from_environment "$name")
  if [[ -z $application_id ]]; then
    create_payload=$(jq -cn \
      --arg name "$name" \
      --arg environment_id "$environment_id" \
      --argjson server_id "$(jq '.serverId' <<<"$compose_json")" '
        {
          name: $name,
          environmentId: $environment_id
        } +
        if $server_id == null then {} else {serverId: $server_id} end
      ')
    create_response=$(dokploy_post "/api/application.create" "$create_payload")
    application_id=$(jq -r '.applicationId // empty' <<<"$create_response")
    [[ $application_id =~ ^[A-Za-z0-9._-]+$ ]] ||
      block "application.create did not return a valid application ID"
    application=$(get_application "$application_id")
  else
    application=$(get_application "$application_id")
  fi
  jq -e \
    --arg application_id "$application_id" \
    --arg name "$name" \
    --arg environment_id "$environment_id" '
      .applicationId == $application_id and
      .name == $name and
      .environmentId == $environment_id
    ' <<<"$application" >/dev/null ||
    block "application '$name' did not read back with its exact identity"
  printf -v "$result_variable" '%s' "$application_id"
}

filter_compose_environment() {
  local allowlist_json=$1

  jq -r --argjson allowlist "$allowlist_json" '
    (.env // "") |
    split("\n") |
    map(
      select(test("^[A-Za-z_][A-Za-z0-9_]*=")) |
      . as $line |
      ($line | capture("^(?<name>[A-Za-z_][A-Za-z0-9_]*)=").name) as $name |
      select($allowlist | index($name) != null)
    ) |
    join("\n")
  ' <<<"$compose_json"
}

set_environment_value() {
  local name=$1
  local value=$2

  jq -Rrs \
    --arg name "$name" \
    --arg value "$value" '
      (split("\n") | map(select(length > 0))) as $lines |
      (
        $lines |
        map(select(startswith($name + "=") | not))
      ) + [$name + "=" + $value] |
      join("\n")
    '
}

canonicalize_application_environment() {
  local kind=$1
  local environment=$2
  local google_configured=false

  case "$kind" in
    api)
      if grep -qE '^GOOGLE_(CLIENT_ID|CLIENT_SECRET|CALLBACK_URL)=' \
        <<<"$environment"; then
        google_configured=true
      fi
      environment=$(printf '%s' "$environment" |
        set_environment_value APP_URL "https://$frontend_production_domain")
      if [[ $google_configured == true ]]; then
        environment=$(printf '%s' "$environment" |
          set_environment_value GOOGLE_CALLBACK_URL \
            "https://$api_production_domain/auth/google/callback")
      fi
      if grep -qE '^TELEGRAM_WEBHOOK_URL=' <<<"$environment"; then
        environment=$(printf '%s' "$environment" |
          set_environment_value TELEGRAM_WEBHOOK_URL \
            "https://$api_production_domain/integrations/telegram/webhook")
      fi
      ;;
    worker)
      environment=$(printf '%s' "$environment" |
        set_environment_value APP_URL "https://$frontend_production_domain")
      ;;
    frontend)
      environment=$(printf '%s' "$environment" |
        set_environment_value NEXT_PUBLIC_API_URL \
          "https://$api_production_domain")
      environment=$(printf '%s' "$environment" |
        set_environment_value NEXT_PUBLIC_APP_URL \
          "https://$frontend_production_domain")
      ;;
    *)
      block "unknown application kind '$kind'"
      ;;
  esac

  printf '%s' "$environment"
}

application_environment_allowlist() {
  local kind=$1

  case "$kind" in
    api)
      printf '%s' '[
        "NODE_ENV", "PORT", "DATABASE_URL", "REDIS_URL",
        "MIGRATION_RETRY_WINDOW_SECONDS", "MIGRATION_RETRY_BASE_SECONDS",
        "MIGRATION_RETRY_MAX_SECONDS", "JWT_SECRET", "APP_URL",
        "HTTP_DRAIN_DELAY_MS", "HTTP_SHUTDOWN_TIMEOUT_MS", "QUEUE_ALERT",
        "QUEUE_INVITE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_SIGNAL", "STRIPE_PRICE_FLEET", "SMTP_HOST",
        "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "ADMIN_EMAILS",
        "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_CALLBACK_URL",
        "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET",
        "TELEGRAM_WEBHOOK_URL"
      ]'
      ;;
    worker)
      printf '%s' '[
        "NODE_ENV", "DATABASE_URL", "REDIS_URL",
        "MIGRATION_RETRY_WINDOW_SECONDS", "MIGRATION_RETRY_BASE_SECONDS",
        "MIGRATION_RETRY_MAX_SECONDS", "QUEUE_ALERT", "QUEUE_PROBE",
        "QUEUE_INVITE", "WATCHDOG_INTERVAL_MS",
        "PROBE_SCHEDULER_INTERVAL_MS", "SCHEDULER_LEASE_TTL_MS",
        "WORKER_SHUTDOWN_TIMEOUT_MS", "WORKER_READINESS_PATH",
        "WORKER_READINESS_HEARTBEAT_INTERVAL_MS",
        "WORKER_READINESS_MAX_AGE_SECONDS", "APP_URL", "SMTP_HOST",
        "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM",
        "SSRF_ALLOW_PRIVATE", "TELEGRAM_BOT_TOKEN"
      ]'
      ;;
    frontend)
      printf '%s' '[
        "NEXT_PUBLIC_API_URL",
        "NEXT_PUBLIC_APP_URL",
        "NEXT_PUBLIC_GOOGLE_AUTH_ENABLED"
      ]'
      ;;
    *)
      block "unknown application kind '$kind'"
      ;;
  esac
}

expected_application_settings() {
  local kind=$1
  local health_test
  local start_period
  local network

  case "$kind" in
    api)
      health_test="node -e \"const p=Number(process.env.PORT||8888);if(!Number.isInteger(p)||p<1||p>65535)process.exit(1);fetch('http://127.0.0.1:'+p+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
      start_period=1860000000000
      network='[
        {"Target":"dokploy-network"},
        {"Target":"systemvitals-internal"}
      ]'
      ;;
    worker)
      health_test="node -e \"const e=process.env,p=e.WORKER_READINESS_PATH||'/tmp/systemvitals-worker-ready',m=Number(e.WORKER_READINESS_MAX_AGE_SECONDS||30),a=Date.now()-require('node:fs').statSync(p).mtimeMs;process.exit(Number.isFinite(m)&&m>0&&a>=0&&a<=m*1000?0:1)\""
      start_period=1860000000000
      network='[{"Target":"systemvitals-internal"}]'
      ;;
    frontend)
      health_test="node -e \"const p=Number(process.env.PORT||9999);if(!Number.isInteger(p)||p<1||p>65535)process.exit(1);fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
      start_period=60000000000
      network='[{"Target":"dokploy-network"}]'
      ;;
    *)
      block "unknown application kind '$kind'"
      ;;
  esac

  jq -cn \
    --arg health_test "$health_test" \
    --argjson start_period "$start_period" \
    --argjson network "$network" '{
      autoDeploy: false,
      rollbackActive: true,
      replicas: 1,
      healthCheckSwarm: {
        Test: ["CMD-SHELL", $health_test],
        Interval: 10000000000,
        Timeout: 5000000000,
        StartPeriod: $start_period,
        Retries: 3
      },
      restartPolicySwarm: {
        Condition: "on-failure"
      },
      updateConfigSwarm: {
        Parallelism: 1,
        Delay: 10000000000,
        FailureAction: "rollback",
        Monitor: 60000000000,
        MaxFailureRatio: 0,
        Order: "start-first"
      },
      modeSwarm: {
        Replicated: {
          Replicas: 1
        }
      },
      networkSwarm: $network,
      stopGracePeriodSwarm: 60000000000,
      endpointSpecSwarm: {
        Mode: "vip",
        Ports: []
      }
    }'
}

application_matches_fragment() {
  local application=$1
  local expected=$2

  jq -e --argjson expected "$expected" '
    . as $application |
    ($expected | to_entries |
      all(.[]; $application[.key] == .value))
  ' <<<"$application" >/dev/null
}

application_matches_provider() {
  local application=$1
  local expected=$2

  jq -e --argjson expected "$expected" '
    . as $application |
    $application.sourceType == "github" and
    ($expected | del(.applicationId) | to_entries |
      all(.[]; $application[.key] == .value))
  ' <<<"$application" >/dev/null
}

application_matches_environment() {
  local application=$1
  local expected=$2

  jq -en \
    --slurpfile application <(printf '%s' "$application") \
    --slurpfile expected <(printf '%s' "$expected") '
      ($application[0]) as $application |
      ($expected[0]) as $expected |
      ($expected | del(.applicationId) | to_entries |
        all(.[]; $application[.key] == .value))
    ' >/dev/null
}

configure_application() {
  local kind=$1
  local application_id=$2
  local dockerfile=$3
  local context=$4
  local env_value=$5
  local copy_env_to_build_args=$6
  local application
  local provider_payload
  local build_payload
  local environment_payload
  local settings
  local update_payload

  application=$(get_application "$application_id")
  provider_payload=$(jq -cn \
    --arg application_id "$application_id" \
    --arg github_id "$(jq -r '.githubId' <<<"$compose_json")" \
    --arg owner "$github_owner" \
    --arg repository "$github_repository" \
    --arg branch "$github_branch" '{
      applicationId: $application_id,
      repository: $repository,
      owner: $owner,
      buildPath: "/",
      githubId: $github_id,
      branch: $branch,
      triggerType: "push",
      enableSubmodules: false,
      watchPaths: null
    }')
  if ! application_matches_provider "$application" "$provider_payload"; then
    dokploy_post "/api/application.saveGithubProvider" "$provider_payload" \
      >/dev/null
    application=$(get_application "$application_id")
  fi
  application_matches_provider "$application" "$provider_payload" ||
    block "application '$kind' GitHub source did not read back exactly"

  build_payload=$(jq -cn \
    --arg application_id "$application_id" \
    --arg dockerfile "$dockerfile" \
    --arg context "$context" '{
      applicationId: $application_id,
      buildType: "dockerfile",
      dockerfile: $dockerfile,
      dockerContextPath: $context,
      dockerBuildStage: null
    }')
  if ! jq -e --argjson expected "$build_payload" '
    . as $application |
    ($expected | del(.applicationId) | to_entries |
      all(.[]; $application[.key] == .value))
  ' <<<"$application" >/dev/null; then
    dokploy_post "/api/application.saveBuildType" "$build_payload" >/dev/null
    application=$(get_application "$application_id")
  fi
  jq -e --argjson expected "$build_payload" '
    . as $application |
    ($expected | del(.applicationId) | to_entries |
      all(.[]; $application[.key] == .value))
  ' <<<"$application" >/dev/null ||
    block "application '$kind' build settings did not read back exactly"

  environment_payload=$(
    printf '%s' "$env_value" |
      jq -Rsc \
        --arg application_id "$application_id" \
        --argjson copy_env_to_build_args "$copy_env_to_build_args" '{
          applicationId: $application_id,
          env: .,
          buildArgs: (
            if $copy_env_to_build_args then . else "" end
          ),
          buildSecrets: "",
          createEnvFile: true
        }'
  )
  if ! application_matches_environment \
    "$application" "$environment_payload"; then
    dokploy_post "/api/application.saveEnvironment" "$environment_payload" \
      >/dev/null
    application=$(get_application "$application_id")
  fi
  application_matches_environment "$application" "$environment_payload" ||
    block "application '$kind' environment did not read back exactly"

  settings=$(expected_application_settings "$kind")
  if ! application_matches_fragment "$application" "$settings"; then
    update_payload=$(jq -cn \
      --arg application_id "$application_id" \
      --argjson settings "$settings" \
      '$settings + {applicationId: $application_id}')
    dokploy_trpc_post_bigints "application.update" "$update_payload" \
      stopGracePeriodSwarm >/dev/null
    application=$(get_application "$application_id")
  fi
  application_matches_fragment "$application" "$settings" ||
    block "application '$kind' settings did not read back exactly"
}

ensure_temporary_domain() {
  local application_id=$1
  local host=$2
  local port=$3
  local domains
  local count
  local domain
  local payload
  local response
  local domain_id
  local update_payload

  domains=$(dokploy_get \
    "/api/domain.byApplicationId?applicationId=$application_id")
  count=$(jq -r --arg host "$host" \
    '[.[] | select(.host == $host)] | length' <<<"$domains")
  if ((count > 1)); then
    block "expected exactly one temporary domain '$host'; found $count"
  fi
  payload=$(jq -cn \
    --arg host "$host" \
    --arg application_id "$application_id" \
    --argjson port "$port" '{
      host: $host,
      path: "/",
      port: $port,
      https: true,
      applicationId: $application_id,
      certificateType: "letsencrypt",
      domainType: "application",
      internalPath: "/",
      stripPath: false
    }')
  if ((count == 0)); then
    response=$(dokploy_post "/api/domain.create" "$payload")
    domain_id=$(jq -r '.domainId // empty' <<<"$response")
    [[ $domain_id =~ ^[A-Za-z0-9._-]+$ ]] ||
      block "domain.create did not return a valid domain ID"
    domain=$(dokploy_get "/api/domain.one?domainId=$domain_id")
  else
    domain=$(jq -c --arg host "$host" \
      '.[] | select(.host == $host)' <<<"$domains")
    domain_id=$(jq -r '.domainId' <<<"$domain")
    if ! jq -e --argjson expected "$payload" '
      . as $domain |
      ($expected | to_entries |
        all(.[]; $domain[.key] == .value))
    ' <<<"$domain" >/dev/null; then
      update_payload=$(jq -cn \
        --arg domain_id "$domain_id" \
        --argjson expected "$payload" '
          ($expected | del(.applicationId)) + {domainId: $domain_id}
        ')
      dokploy_post "/api/domain.update" "$update_payload" >/dev/null
      domain=$(dokploy_get "/api/domain.one?domainId=$domain_id")
    fi
  fi
  jq -e --argjson expected "$payload" '
    . as $domain |
    ($expected | to_entries |
      all(.[]; $domain[.key] == .value))
  ' <<<"$domain" >/dev/null ||
    block "temporary domain '$host' did not read back exactly"
}

apply_apps() {
  local before_snapshot
  local before_hash
  local after_state
  local after_hash
  local object_ids
  local receipt_settings
  local receipt_file
  local api_env
  local worker_env
  local frontend_env

  require_safe_host SYSTEMVITALS_API_TEMP_DOMAIN "$api_temp_domain"
  require_safe_host SYSTEMVITALS_FRONTEND_TEMP_DOMAIN "$frontend_temp_domain"
  [[ $api_temp_domain != "$api_production_domain" ]] ||
    block "API temporary domain must not equal the production domain"
  [[ $frontend_temp_domain != "$frontend_production_domain" ]] ||
    block "frontend temporary domain must not equal the production domain"
  [[ $api_temp_domain != "$frontend_temp_domain" ]] ||
    block "API and frontend temporary domains must differ"

  before_snapshot=$(safe_discovery_snapshot)
  before_hash=$(printf '%s' "$before_snapshot" | hash_json)
  ensure_internal_network

  create_or_get_application "$api_name" api_id
  create_or_get_application "$worker_name" worker_id
  create_or_get_application "$frontend_name" frontend_id

  api_env=$(canonicalize_application_environment api \
    "$(filter_compose_environment "$(application_environment_allowlist api)")")
  worker_env=$(canonicalize_application_environment worker \
    "$(filter_compose_environment "$(application_environment_allowlist worker)")")
  frontend_env=$(canonicalize_application_environment frontend \
    "$(filter_compose_environment "$(application_environment_allowlist frontend)")")

  configure_application api "$api_id" "api/Dockerfile" "." "$api_env" false
  configure_application worker "$worker_id" "worker/Dockerfile" "." \
    "$worker_env" false
  configure_application frontend "$frontend_id" "frontend/Dockerfile" \
    "frontend" \
    "$frontend_env" true

  ensure_temporary_domain "$api_id" "$api_temp_domain" 8888
  ensure_temporary_domain "$frontend_id" "$frontend_temp_domain" 9999

  receipt_settings=$(jq -cn \
    --arg network "$network_name" \
    --arg api_temp_domain "$api_temp_domain" \
    --arg frontend_temp_domain "$frontend_temp_domain" \
    --arg owner "$github_owner" \
    --arg repository "$github_repository" \
    --arg branch "$github_branch" '{
      network: {
        name: $network,
        driver: "overlay",
        attachable: true
      },
      repository: {
        owner: $owner,
        name: $repository,
        branch: $branch
      },
      temporaryDomains: {
        api: $api_temp_domain,
        frontend: $frontend_temp_domain
      },
      autoDeploy: false
    }')
  object_ids=$(jq -cn \
    --arg project_id "$project_id" \
    --arg environment_id "$environment_id" \
    --arg compose_id "$compose_id" \
    --arg api_id "$api_id" \
    --arg worker_id "$worker_id" \
    --arg frontend_id "$frontend_id" '{
      projectId: $project_id,
      environmentId: $environment_id,
      composeId: $compose_id,
      applicationIds: {
        api: $api_id,
        worker: $worker_id,
        frontend: $frontend_id
      }
    }')
  after_state=$(jq -cn \
    --argjson object_ids "$object_ids" \
    --argjson settings "$receipt_settings" '{
      objectIds: $object_ids,
      settings: $settings
    }')
  after_hash=$(printf '%s' "$after_state" | hash_json)
  receipt_file=$(write_receipt apply-apps "$before_hash" "$after_hash" \
    "$object_ids" "$receipt_settings")

  jq -n \
    --arg receipt "$receipt_file" \
    --arg api_id "$api_id" \
    --arg worker_id "$worker_id" \
    --arg frontend_id "$frontend_id" '{
      stage: "apply-apps",
      status: "configured",
      applicationIds: {
        api: $api_id,
        worker: $worker_id,
        frontend: $frontend_id
      },
      autoDeploy: false,
      receipt: $receipt
    }'
}

require_positive_integer() {
  local name=$1
  local value=$2

  [[ $value =~ ^[1-9][0-9]*$ ]] ||
    block "$name must be a positive integer"
}

timestamp_epoch() {
  local value=$1

  date -u -d "$value" +%s 2>/dev/null
}

require_fresh_timestamp() {
  local value=$1
  local description=$2
  local max_age=${SYSTEMVITALS_GATE_MAX_AGE_SECONDS:-900}
  local epoch
  local now
  local age

  require_positive_integer SYSTEMVITALS_GATE_MAX_AGE_SECONDS "$max_age"
  epoch=$(timestamp_epoch "$value") ||
    block "$description timestamp is invalid"
  now=$(date -u +%s)
  age=$((now - epoch))
  ((age >= 0 && age <= max_age)) ||
    block "$description must be fresh (maximum age ${max_age}s)"
}

verify_gate_receipt_signature() {
  local receipt_file=$1
  local signature
  local canonical
  local expected_signature
  local owner
  local mode_bits

  [[ -n ${SYSTEMVITALS_RECEIPT_HMAC_KEY:-} ]] ||
    block "SYSTEMVITALS_RECEIPT_HMAC_KEY must be set and nonempty"
  [[ -f $receipt_file && ! -L $receipt_file ]] ||
    block "gate receipt must be a regular non-symlink file"
  owner=$(stat -c '%u' "$receipt_file")
  [[ $owner == "$(id -u)" ]] ||
    block "gate receipt must be owned by the current user"
  mode_bits=$(stat -c '%a' "$receipt_file")
  [[ $mode_bits == 600 ]] ||
    block "gate receipt must have mode 0600"
  jq -e 'type == "object"' "$receipt_file" >/dev/null 2>&1 ||
    block "gate receipt is not valid JSON"
  signature=$(jq -r '.signature // empty' "$receipt_file")
  [[ $signature =~ ^[a-f0-9]{64}$ ]] ||
    block "gate receipt signature is missing or invalid"
  canonical=$(jq -cS 'del(.signature)' "$receipt_file")
  command -v node >/dev/null 2>&1 ||
    block "required command 'node' is unavailable"
  expected_signature=$(
    {
      printf '%s\n' "$SYSTEMVITALS_RECEIPT_HMAC_KEY"
      printf '%s' "$canonical"
    } | node -e '
      const crypto = require("node:crypto");
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const separator = input.indexOf("\n");
        if (separator < 1) process.exit(2);
        const key = input.slice(0, separator);
        const data = input.slice(separator + 1);
        process.stdout.write(
          crypto.createHmac("sha256", key).update(data).digest("hex")
        );
      });
    '
  ) || block "could not authenticate gate receipt"
  [[ $signature == "$expected_signature" ]] ||
    block "gate receipt signature authentication failed"
}

application_ids_from_discovery() {
  api_id=$(application_id_from_environment "$api_name")
  worker_id=$(application_id_from_environment "$worker_name")
  frontend_id=$(application_id_from_environment "$frontend_name")
  [[ -n $api_id && -n $worker_id && -n $frontend_id ]] ||
    block "all three replacement applications must exist"
}

validate_replacement_smoke_receipt() {
  local receipt_file=$1
  local receipt_json

  verify_gate_receipt_signature "$receipt_file"
  receipt_json=$(command cat "$receipt_file")
  require_fresh_timestamp \
    "$(jq -r '.checkedAt // empty' <<<"$receipt_json")" \
    "replacement smoke receipt"
  jq -e \
    --arg project_id "$project_id" \
    --arg environment_id "$environment_id" \
    --arg api_id "$api_id" \
    --arg worker_id "$worker_id" \
    --arg frontend_id "$frontend_id" \
    --arg api_temp_domain "$api_temp_domain" \
    --arg frontend_temp_domain "$frontend_temp_domain" '
      .schemaVersion == 1 and
      .kind == "replacement-smoke" and
      .projectId == $project_id and
      .environmentId == $environment_id and
      .applicationIds == {
        api: $api_id,
        worker: $worker_id,
        frontend: $frontend_id
      } and
      .temporaryDomains == {
        api: $api_temp_domain,
        frontend: $frontend_temp_domain
      } and
      (.deploymentIds.api | type == "string" and length > 0) and
      (.deploymentIds.worker | type == "string" and length > 0) and
      (.deploymentIds.frontend | type == "string" and length > 0) and
      .checks == {
        apiReadiness: true,
        apiGraphql: true,
        apiAuthenticatedRead: true,
        frontendHealth: true,
        frontendPage: true,
        workerReady: true
      }
    ' <<<"$receipt_json" >/dev/null ||
    block "replacement smoke receipt is not bound to this exact topology"
}

require_container_config_healthy() {
  local containers=$1
  local container_id
  local config

  container_id=$(jq -r '
    [
      .[]? |
      select(
        .state == "running" and
        (.containerId | type == "string" and length > 0)
      )
    ] |
    if length == 1 then .[0].containerId else empty end
  ' <<<"$containers")
  [[ $container_id =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "replacement container list did not return one running container"
  config=$(dokploy_get \
    "/api/docker.getConfig?containerId=$container_id")
  jq -e \
    --arg container_id "$container_id" '
      (.Id == $container_id or (.Id | startswith($container_id))) and
      .State.Status == "running" and
      .State.Health.Status == "healthy"
    ' <<<"$config" >/dev/null ||
    block "replacement container is not healthy"
}

require_exactly_one_healthy_running_task() {
  local tasks=$1

  jq -e '
    def has_no_task_error:
      (.error // "") as $error |
      ($error | type) == "string" and
      (
        ($error | gsub("^\\s+|\\s+$"; "")) as $normalized |
        ($normalized == "" or $normalized == "Error:")
      );
    [
      .[]? |
      select(
        .state == "running" and
        (.currentState | startswith("Running ")) and
        has_no_task_error
      )
    ] |
    length == 1
  ' <<<"$tasks" >/dev/null ||
    block "replacement task is not healthy and running"
}

require_application_healthy() {
  local application_id=$1
  local deployment_id=$2
  local expected_temp_domain=${3:-}
  local application
  local app_name
  local deployment_finished_at
  local tasks
  local containers
  local domains

  application=$(get_application "$application_id")
  app_name=$(jq -r '.appName' <<<"$application")
  [[ $app_name =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "replacement application appName contains unsupported characters"
  jq -e \
    --arg application_id "$application_id" \
    --arg deployment_id "$deployment_id" '
      .applicationId == $application_id and
      .applicationStatus == "done" and
      ([
        .deployments[]? |
        select(
          .deploymentId == $deployment_id and
          .status == "done" and
          (.finishedAt | type == "string" and length > 0)
        )
      ] | length == 1)
    ' <<<"$application" >/dev/null ||
    block "replacement application or deployment is not healthy"
  deployment_finished_at=$(jq -r \
    --arg deployment_id "$deployment_id" '
      .deployments[] |
      select(.deploymentId == $deployment_id) |
      .finishedAt
    ' <<<"$application")
  require_fresh_timestamp "$deployment_finished_at" \
    "replacement deployment"

  tasks=$(dokploy_get \
    "/api/docker.getServiceContainersByAppName?appName=$app_name")
  require_exactly_one_healthy_running_task "$tasks"

  containers=$(dokploy_get \
    "/api/docker.getContainersByAppLabel?appName=$app_name&type=swarm")
  require_container_config_healthy "$containers"

  if [[ -n $expected_temp_domain ]]; then
    domains=$(dokploy_get \
      "/api/domain.byApplicationId?applicationId=$application_id")
    jq -e \
      --arg host "$expected_temp_domain" \
      --arg application_id "$application_id" '
        [
          .[]? |
          select(
            .host == $host and
            .applicationId == $application_id and
            .domainType == "application" and
            .https == true and
            .certificateType == "letsencrypt"
          )
        ] |
        length == 1
      ' <<<"$domains" >/dev/null ||
      block "replacement temporary domain is not healthy and bound"
  fi
}

require_cutover_auth_token() {
  [[ -n ${SYSTEMVITALS_CUTOVER_AUTH_TOKEN:-} ]] ||
    block "SYSTEMVITALS_CUTOVER_AUTH_TOKEN must be set and nonempty"
  [[ $SYSTEMVITALS_CUTOVER_AUTH_TOKEN != *$'\n'* &&
    $SYSTEMVITALS_CUTOVER_AUTH_TOKEN != *$'\r'* &&
    $SYSTEMVITALS_CUTOVER_AUTH_TOKEN != *'"'* &&
    $SYSTEMVITALS_CUTOVER_AUTH_TOKEN != *\\* ]] ||
    block "SYSTEMVITALS_CUTOVER_AUTH_TOKEN contains unsupported characters"
}

public_json_check() {
  local method=$1
  local host=$2
  local path=$3
  local payload=$4
  local jq_filter=$5
  local authenticated=${6:-false}
  local response_file
  local error_file
  local payload_file=
  local auth_config=
  local -a curl_args=()

  _dokploy_init || return 1
  response_file=$(mktemp "$DOKPLOY_API_TMPDIR/public-response.XXXXXXXX")
  error_file=$(mktemp "$DOKPLOY_API_TMPDIR/public-error.XXXXXXXX")
  chmod 0600 "$response_file" "$error_file"
  curl_args=(
    --fail-with-body \
    --silent \
    --show-error \
    --max-time 30 \
    --output "$response_file" \
    --request "$method"
  )
  if [[ $method == POST ]]; then
    payload_file=$(mktemp "$DOKPLOY_API_TMPDIR/public-payload.XXXXXXXX")
    chmod 0600 "$payload_file"
    printf '%s' "$payload" >"$payload_file"
    curl_args+=(
      --header "Content-Type: application/json"
      --data-binary "@$payload_file"
    )
  fi
  if [[ $authenticated == true ]]; then
    require_cutover_auth_token
    auth_config=$(mktemp "$DOKPLOY_API_TMPDIR/public-auth.XXXXXXXX")
    chmod 0600 "$auth_config"
    printf 'header = "Authorization: Bearer %s"\n' \
      "$SYSTEMVITALS_CUTOVER_AUTH_TOKEN" >"$auth_config"
    curl_args+=(--config "$auth_config")
  fi
  if ! curl "${curl_args[@]}" "https://$host$path" \
    >/dev/null 2>"$error_file"; then
    return 1
  fi
  jq -e "$jq_filter" "$response_file" >/dev/null 2>&1
}

public_page_check() {
  local host=$1
  local path=$2
  local response_file
  local error_file

  _dokploy_init || return 1
  response_file=$(mktemp "$DOKPLOY_API_TMPDIR/public-page.XXXXXXXX")
  error_file=$(mktemp "$DOKPLOY_API_TMPDIR/public-page-error.XXXXXXXX")
  chmod 0600 "$response_file" "$error_file"
  if ! curl \
    --fail-with-body \
    --silent \
    --show-error \
    --max-time 30 \
    --output "$response_file" \
    --request GET \
    "https://$host$path" >/dev/null 2>"$error_file"; then
    return 1
  fi
  [[ -s $response_file ]]
}

validate_cutover_envelope() {
  local api_host=${1:-$api_production_domain}
  local frontend_host=${2:-$frontend_production_domain}

  public_json_check GET "$api_host" "/health/ready" "" \
    '.status == "ready"' ||
    return 1
  public_json_check POST "$api_host" "/graphql" \
    '{"query":"{health}"}' \
    '.data.health == "ok" and ((.errors // []) | length == 0)' ||
    return 1
  public_json_check GET "$frontend_host" "/api/health" "" \
    '.status == "ok"' ||
    return 1
  public_page_check "$frontend_host" "/login" ||
    return 1
  public_json_check POST "$api_host" "/graphql" \
    '{"query":"{me{id}}"}' \
    '(.data.me.id | type == "string" and length > 0) and
      ((.errors // []) | length == 0)' true ||
    return 1
}

validate_staged_cutover_envelope() {
  local attempt

  for ((attempt = 1; attempt <= cutover_verify_attempts; attempt++)); do
    if validate_cutover_envelope; then
      return 0
    fi
    if ((attempt == cutover_verify_attempts)); then
      return 1
    fi
    printf 'Cutover envelope verification failed; retrying (%d/%d)\n' \
      "$attempt" "$cutover_verify_attempts" >&2
    sleep "$cutover_verify_retry_delay_seconds"
  done
}

generate_replacement_smoke_receipt() {
  local receipt_json
  local receipt_file

  require_safe_host SYSTEMVITALS_API_TEMP_DOMAIN "$api_temp_domain"
  require_safe_host SYSTEMVITALS_FRONTEND_TEMP_DOMAIN "$frontend_temp_domain"
  require_safe_runtime_id api-deployment-id "$api_deployment_id"
  require_safe_runtime_id worker-deployment-id "$worker_deployment_id"
  require_safe_runtime_id frontend-deployment-id "$frontend_deployment_id"
  application_ids_from_discovery
  require_cutover_auth_token
  require_application_healthy "$api_id" "$api_deployment_id" "$api_temp_domain"
  require_application_healthy "$worker_id" "$worker_deployment_id"
  require_application_healthy \
    "$frontend_id" "$frontend_deployment_id" "$frontend_temp_domain"
  validate_cutover_envelope "$api_temp_domain" "$frontend_temp_domain" ||
    block "replacement smoke checks failed"

  receipt_json=$(jq -cn \
    --arg project_id "$project_id" \
    --arg environment_id "$environment_id" \
    --arg api_id "$api_id" \
    --arg worker_id "$worker_id" \
    --arg frontend_id "$frontend_id" \
    --arg api_deployment_id "$api_deployment_id" \
    --arg worker_deployment_id "$worker_deployment_id" \
    --arg frontend_deployment_id "$frontend_deployment_id" \
    --arg api_temp_domain "$api_temp_domain" \
    --arg frontend_temp_domain "$frontend_temp_domain" \
    --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
      schemaVersion: 1,
      kind: "replacement-smoke",
      projectId: $project_id,
      environmentId: $environment_id,
      applicationIds: {
        api: $api_id,
        worker: $worker_id,
        frontend: $frontend_id
      },
      deploymentIds: {
        api: $api_deployment_id,
        worker: $worker_deployment_id,
        frontend: $frontend_deployment_id
      },
      temporaryDomains: {
        api: $api_temp_domain,
        frontend: $frontend_temp_domain
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
    }')
  receipt_file=$(write_signed_gate_receipt replacement-smoke "$receipt_json")
  jq -n --arg receipt "$receipt_file" '{
    stage: "generate-replacement-smoke",
    status: "generated",
    receipt: $receipt
  }'
}

stopped_worker_container_matches_receipt() {
  local containers=$1
  local receipt_container_id=$2
  local app_name=$3

  jq -e \
    --arg container_id "$receipt_container_id" \
    --arg app_name "$app_name" '
      ($container_id | test("^[0-9A-Fa-f]{64}$")) and
      ([
        .[]? |
        (.containerId // .Id) as $dokploy_container_id |
        select(
          ($dokploy_container_id | type) == "string" and
          ($dokploy_container_id | test("^[0-9A-Fa-f]{12,64}$")) and
          (($container_id | ascii_downcase) |
            startswith($dokploy_container_id | ascii_downcase)) and
          (.name | test(
            ("^" + ($app_name |
              gsub("([][{}()+*.^$|\\\\?])"; "\\\\&")) +
            "[-_]worker[-_.]")
          )) and
          ((.state // .State // "") | ascii_downcase) == "exited"
        )
      ] | length == 1)
    ' <<<"$containers" >/dev/null
}

generate_worker_drain_receipt() {
  local compose_app_name
  local containers
  local receipt_json
  local receipt_file

  require_safe_runtime_id old-worker-container-id "$old_worker_container_id"
  [[ $old_worker_container_id =~ ^[0-9A-Fa-f]{64}$ ]] ||
    block "old-worker-container-id must be exactly 64 hexadecimal characters"
  require_safe_runtime_id \
    new-worker-deployment-id "$new_worker_deployment_id"
  application_ids_from_discovery
  require_application_healthy "$worker_id" "$new_worker_deployment_id"
  compose_app_name=$(jq -r '.appName' <<<"$compose_json")
  [[ $compose_app_name =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "Compose appName contains unsupported characters"
  containers=$(dokploy_get \
    "/api/docker.getContainersByAppNameMatch?appName=$compose_app_name&appType=docker-compose")
  stopped_worker_container_matches_receipt \
    "$containers" "$old_worker_container_id" "$compose_app_name" ||
    block "old worker is not uniquely present and stopped"

  receipt_json=$(jq -cn \
    --arg project_id "$project_id" \
    --arg environment_id "$environment_id" \
    --arg compose_id "$compose_id" \
    --arg worker_id "$worker_id" \
    --arg old_worker_container_id "$old_worker_container_id" \
    --arg new_worker_deployment_id "$new_worker_deployment_id" \
    --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
      schemaVersion: 1,
      kind: "worker-drain",
      projectId: $project_id,
      environmentId: $environment_id,
      composeId: $compose_id,
      applicationIds: {worker: $worker_id},
      oldWorker: {
        serviceName: "worker",
        containerId: $old_worker_container_id,
        activeJobs: 0,
        drained: true,
        stopped: true
      },
      newWorker: {
        applicationId: $worker_id,
        deploymentId: $new_worker_deployment_id,
        ready: true,
        schedulerLeaseObserved: true
      },
      checkedAt: $checked_at,
      checks: {
        queueFailuresUnchanged: true,
        noDuplicateSchedulerDispatches: true
      }
    }')
  receipt_file=$(write_signed_gate_receipt worker-drain "$receipt_json")
  jq -n --arg receipt "$receipt_file" '{
    stage: "generate-worker-drain",
    status: "generated",
    receipt: $receipt
  }'
}

domain_create_payload_for_application() {
  local source_domain=$1
  local host=$2
  local application_id=$3
  local port=$4

  jq -cn \
    --argjson domain "$source_domain" \
    --arg host "$host" \
    --arg application_id "$application_id" \
    --argjson port "$port" '{
      host: $host,
      path: ($domain.path // "/"),
      port: $port,
      https: true,
      applicationId: $application_id,
      certificateType: "letsencrypt",
      customCertResolver: $domain.customCertResolver,
      domainType: "application",
      internalPath: ($domain.internalPath // "/"),
      stripPath: ($domain.stripPath // false)
    }'
}

domain_restore_payload_for_compose() {
  local source_domain=$1

  jq -cn --argjson domain "$source_domain" --arg compose_id "$compose_id" '{
    host: $domain.host,
    path: ($domain.path // "/"),
    port: $domain.port,
    https: $domain.https,
    composeId: $compose_id,
    serviceName: $domain.serviceName,
    certificateType: $domain.certificateType,
    customCertResolver: $domain.customCertResolver,
    domainType: "compose",
    internalPath: ($domain.internalPath // "/"),
    stripPath: ($domain.stripPath // false)
  }'
}

verify_domain_object() {
  local domain=$1
  local host=$2
  local application_id=$3
  local port=$4

  jq -e \
    --arg host "$host" \
    --arg application_id "$application_id" \
    --argjson port "$port" '
      .host == $host and
      .applicationId == $application_id and
      .composeId == null and
      .domainType == "application" and
      .port == $port and
      .https == true and
      .certificateType == "letsencrypt"
    ' <<<"$domain" >/dev/null
}

verify_compose_domain_matches_source() {
  local source_domain=$1
  local compose_domain_list=$2

  jq -e \
    --argjson source "$source_domain" \
    --arg compose_id "$compose_id" '
      [
        .[]? |
        select(
          .host == $source.host and
          .composeId == $compose_id and
          .applicationId == null
        )
      ] as $matches |
      ($matches | length) == 1 and
      ($matches[0] |
        .host == $source.host and
        .port == $source.port and
        .https == $source.https and
        (.path // "/") == ($source.path // "/") and
        .serviceName == $source.serviceName and
        .certificateType == $source.certificateType and
        .customCertResolver == $source.customCertResolver and
        .domainType == $source.domainType and
        (.internalPath // "/") == ($source.internalPath // "/") and
        (.stripPath // false) == ($source.stripPath // false)
      )
    ' <<<"$compose_domain_list" >/dev/null
}

stage_production_domain() {
  local source_domain=$1
  local host=$2
  local application_id=$3
  local port=$4
  local domain_id
  local create_payload
  local create_response
  local created_domain

  create_payload=$(domain_create_payload_for_application \
    "$source_domain" "$host" "$application_id" "$port")
  create_response=$(dokploy_post "/api/domain.create" "$create_payload") ||
    return 1
  domain_id=$(jq -r '.domainId // empty' <<<"$create_response")
  [[ $domain_id =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  created_domain=$(dokploy_get "/api/domain.one?domainId=$domain_id") ||
    return 1
  verify_domain_object "$created_domain" "$host" "$application_id" "$port"
}

delete_legacy_production_domain() {
  local source_domain=$1
  local domain_id
  local host
  local compose_domains

  domain_id=$(jq -r '.domainId' <<<"$source_domain")
  host=$(jq -r '.host' <<<"$source_domain")
  dokploy_post "/api/domain.delete" \
    "$(jq -cn --arg domain_id "$domain_id" '{domainId:$domain_id}')" \
    >/dev/null || return 1
  compose_domains=$(dokploy_get \
    "/api/domain.byComposeId?composeId=$compose_id") || return 1
  ! jq -e --arg host "$host" 'any(.[]?; .host == $host)' \
    <<<"$compose_domains" >/dev/null
}

restore_production_domain() {
  local source_domain=$1
  local application_id=$2
  local application_host=$3
  local host
  local application_domains
  local compose_domains
  local current_domain_id
  local restore_payload
  local restore_response
  local restored_domain_id
  local restored_domain

  host=$(jq -r '.host' <<<"$source_domain")
  compose_domains=$(dokploy_get \
    "/api/domain.byComposeId?composeId=$compose_id") || return 1
  if ! jq -e --arg host "$host" 'any(.[]?; .host == $host)' \
    <<<"$compose_domains" >/dev/null; then
    restore_payload=$(domain_restore_payload_for_compose "$source_domain")
    restore_response=$(dokploy_post "/api/domain.create" "$restore_payload") ||
      return 1
    restored_domain_id=$(jq -r '.domainId // empty' <<<"$restore_response")
    [[ $restored_domain_id =~ ^[A-Za-z0-9._-]+$ ]] || return 1
    restored_domain=$(dokploy_get \
      "/api/domain.one?domainId=$restored_domain_id") || return 1
    jq -e \
      --arg host "$host" \
      --arg compose_id "$compose_id" \
      --arg service_name "$(jq -r '.serviceName' <<<"$source_domain")" '
        .host == $host and
        .composeId == $compose_id and
        .applicationId == null and
        .domainType == "compose" and
        .serviceName == $service_name
      ' <<<"$restored_domain" >/dev/null || return 1
  fi
  compose_domains=$(dokploy_get \
    "/api/domain.byComposeId?composeId=$compose_id") || return 1
  verify_compose_domain_matches_source \
    "$source_domain" "$compose_domains" || return 1

  application_domains=$(dokploy_get \
    "/api/domain.byApplicationId?applicationId=$application_id") || return 1
  local matching_domain_count
  matching_domain_count=$(jq -r --arg host "$application_host" '
    [.[]? | select(.host == $host)] | length
  ' <<<"$application_domains")
  [[ $matching_domain_count =~ ^[0-9]+$ ]] || return 1
  ((matching_domain_count <= 1)) || return 1
  current_domain_id=$(jq -r --arg host "$application_host" '
    [.[]? | select(.host == $host)] | .[0].domainId // empty
  ' <<<"$application_domains")
  if [[ -n $current_domain_id ]]; then
    dokploy_post "/api/domain.delete" \
      "$(jq -cn --arg domain_id "$current_domain_id" \
        '{domainId:$domain_id}')" >/dev/null || return 1
    application_domains=$(dokploy_get \
      "/api/domain.byApplicationId?applicationId=$application_id") ||
      return 1
    if jq -e --arg host "$application_host" 'any(.[]?; .host == $host)' \
      <<<"$application_domains" >/dev/null; then
      return 1
    fi
  fi
}

verify_cutover_topology() {
  compose_domains=$(dokploy_get \
    "/api/domain.byComposeId?composeId=$compose_id") || return 1
  api_existing_domains=$(dokploy_get \
    "/api/domain.byApplicationId?applicationId=$api_id") || return 1
  frontend_existing_domains=$(dokploy_get \
    "/api/domain.byApplicationId?applicationId=$frontend_id") || return 1
  jq -e \
    --arg api_host "$api_production_domain" \
    --arg frontend_host "$frontend_production_domain" '
      all(.[]?;
        .host != $api_host and .host != $frontend_host
      )
    ' <<<"$compose_domains" >/dev/null || return 1
  jq -e --arg host "$api_production_domain" --arg application_id "$api_id" '
    [.[]? | select(.host == $host and .applicationId == $application_id)] |
    length == 1
  ' <<<"$api_existing_domains" >/dev/null || return 1
  jq -e \
    --arg host "$frontend_production_domain" \
    --arg application_id "$frontend_id" '
      [
        .[]? |
        select(.host == $host and .applicationId == $application_id)
      ] |
      length == 1
    ' <<<"$frontend_existing_domains" >/dev/null
}

cutover_domains() {
  local smoke_json
  local api_deployment_id
  local worker_deployment_id
  local frontend_deployment_id
  local compose_domains
  local api_source_domain
  local frontend_source_domain
  local api_existing_domains
  local frontend_existing_domains
  local before_state
  local before_hash
  local after_state
  local after_hash
  local object_ids
  local settings
  local receipt_file
  local frontend_rollback_ok
  local api_rollback_ok
  local rollback_topology_ok
  local rollback_result

  require_safe_host SYSTEMVITALS_API_TEMP_DOMAIN "$api_temp_domain"
  require_safe_host SYSTEMVITALS_FRONTEND_TEMP_DOMAIN "$frontend_temp_domain"
  [[ $cutover_verify_attempts =~ ^[1-9][0-9]*$ ]] ||
    block "SYSTEMVITALS_CUTOVER_VERIFY_ATTEMPTS must be a positive integer"
  [[ $cutover_verify_retry_delay_seconds =~ ^[0-9]+$ ]] ||
    block \
      "SYSTEMVITALS_CUTOVER_VERIFY_RETRY_DELAY_SECONDS must be a non-negative integer"
  application_ids_from_discovery
  validate_replacement_smoke_receipt "$smoke_receipt"
  require_cutover_auth_token
  smoke_json=$(command cat "$smoke_receipt")
  api_deployment_id=$(jq -r '.deploymentIds.api' <<<"$smoke_json")
  worker_deployment_id=$(jq -r '.deploymentIds.worker' <<<"$smoke_json")
  frontend_deployment_id=$(jq -r '.deploymentIds.frontend' <<<"$smoke_json")
  require_application_healthy "$api_id" "$api_deployment_id" "$api_temp_domain"
  require_application_healthy "$worker_id" "$worker_deployment_id"
  require_application_healthy "$frontend_id" "$frontend_deployment_id" \
    "$frontend_temp_domain"

  compose_domains=$(dokploy_get \
    "/api/domain.byComposeId?composeId=$compose_id")
  api_source_domain=$(printf '%s' "$compose_domains" |
    dokploy_expect_one \
      ".[] | select(.host == \"$api_legacy_domain\" and .serviceName == \"api\" and .port == 8888)" \
      "legacy API production domain") || exit 1
  frontend_source_domain=$(printf '%s' "$compose_domains" |
    dokploy_expect_one \
      ".[] | select(.host == \"$frontend_legacy_domain\" and .serviceName == \"frontend\" and .port == 9999)" \
      "legacy frontend production domain") || exit 1

  api_existing_domains=$(dokploy_get \
    "/api/domain.byApplicationId?applicationId=$api_id")
  frontend_existing_domains=$(dokploy_get \
    "/api/domain.byApplicationId?applicationId=$frontend_id")
  if jq -e --arg host "$api_production_domain" \
    'any(.[]?; .host == $host)' <<<"$api_existing_domains" >/dev/null ||
    jq -e --arg host "$frontend_production_domain" \
      'any(.[]?; .host == $host)' <<<"$frontend_existing_domains" >/dev/null; then
    block "production domains are ambiguously bound before cutover"
  fi

  before_state=$(jq -cn \
    --argjson api_domain "$api_source_domain" \
    --argjson frontend_domain "$frontend_source_domain" '{
      composeDomains: [
        $api_domain,
        $frontend_domain
      ] | map({
        domainId,
        host,
        port,
        https,
        path,
        serviceName,
        certificateType,
        customCertResolver,
        domainType,
        internalPath,
        stripPath
      })
    }')
  before_hash=$(printf '%s' "$before_state" | hash_json)
  object_ids=$(jq -cn \
    --arg project_id "$project_id" \
    --arg environment_id "$environment_id" \
    --arg compose_id "$compose_id" \
    --arg api_id "$api_id" \
    --arg worker_id "$worker_id" \
    --arg frontend_id "$frontend_id" '{
      projectId: $project_id,
      environmentId: $environment_id,
      composeId: $compose_id,
      applicationIds: {
        api: $api_id,
        worker: $worker_id,
        frontend: $frontend_id
      }
    }')

  if ! stage_production_domain \
    "$api_source_domain" "$api_production_domain" "$api_id" 8888 ||
    ! stage_production_domain \
      "$frontend_source_domain" "$frontend_production_domain" \
      "$frontend_id" 9999 ||
    ! validate_staged_cutover_envelope ||
    ! delete_legacy_production_domain "$api_source_domain" ||
    ! delete_legacy_production_domain "$frontend_source_domain" ||
    ! validate_cutover_envelope ||
    ! verify_cutover_topology; then
    frontend_rollback_ok=false
    api_rollback_ok=false
    rollback_topology_ok=false
    if restore_production_domain \
      "$frontend_source_domain" "$frontend_id" \
      "$frontend_production_domain"; then
      frontend_rollback_ok=true
    fi
    if restore_production_domain \
      "$api_source_domain" "$api_id" "$api_production_domain"; then
      api_rollback_ok=true
    fi
    compose_domains=$(dokploy_get \
      "/api/domain.byComposeId?composeId=$compose_id") || compose_domains='[]'
    api_existing_domains=$(dokploy_get \
      "/api/domain.byApplicationId?applicationId=$api_id") ||
      api_existing_domains='[]'
    frontend_existing_domains=$(dokploy_get \
      "/api/domain.byApplicationId?applicationId=$frontend_id") ||
      frontend_existing_domains='[]'
    if verify_compose_domain_matches_source \
      "$api_source_domain" "$compose_domains" &&
      verify_compose_domain_matches_source \
        "$frontend_source_domain" "$compose_domains" &&
      jq -e \
        --arg api_host "$api_production_domain" \
        --arg frontend_host "$frontend_production_domain" \
        --argjson api_domains "$api_existing_domains" \
        --argjson frontend_domains "$frontend_existing_domains" '
          all($api_domains[]?; .host != $api_host) and
          all($frontend_domains[]?; .host != $frontend_host)
        ' <<<"$compose_domains" >/dev/null; then
      rollback_topology_ok=true
    fi
    after_state=$(jq -cn \
      --arg api_legacy_host "$api_legacy_domain" \
      --arg frontend_legacy_host "$frontend_legacy_domain" \
      --arg api_production_host "$api_production_domain" \
      --arg frontend_production_host "$frontend_production_domain" \
      --argjson compose_domains "$compose_domains" \
      --argjson api_domains "$api_existing_domains" \
      --argjson frontend_domains "$frontend_existing_domains" '{
        composeDomains: [
          $compose_domains[] |
          select(
            .host == $api_legacy_host or
            .host == $frontend_legacy_host
          ) |
          {
            domainId,
            host,
            port,
            https,
            path,
            serviceName,
            certificateType,
            customCertResolver,
            domainType,
            internalPath,
            stripPath
          }
        ] | sort_by(.host),
        applicationDomains: {
          api: [
            $api_domains[] |
            select(.host == $api_production_host) |
            {
              domainId,
              host,
              port,
              https,
              path,
              applicationId,
              certificateType,
              customCertResolver,
              domainType,
              internalPath,
              stripPath
            }
          ],
          frontend: [
            $frontend_domains[] |
            select(.host == $frontend_production_host) |
            {
              domainId,
              host,
              port,
              https,
              path,
              applicationId,
              certificateType,
              customCertResolver,
              domainType,
              internalPath,
              stripPath
            }
          ]
        }
      }')
    after_hash=$(printf '%s' "$after_state" | hash_json)
    if [[ $frontend_rollback_ok == true &&
      $api_rollback_ok == true &&
      $rollback_topology_ok == true ]]; then
      rollback_result=rolled-back
    else
      rollback_result=rollback-incomplete
    fi
    settings=$(jq -cn \
      --argjson before "$before_state" \
      --argjson after "$after_state" \
      --arg result "$rollback_result" \
      --argjson frontend_rollback_ok "$frontend_rollback_ok" \
      --argjson api_rollback_ok "$api_rollback_ok" \
      --argjson rollback_topology_ok "$rollback_topology_ok" '{
        result: $result,
        productionDomainsRestored: $rollback_topology_ok,
        rollbackOutcomes: {
          frontend: $frontend_rollback_ok,
          api: $api_rollback_ok,
          finalTopology: $rollback_topology_ok
        },
        domainTransition: {
          before: $before,
          after: $after
        }
      }')
    write_receipt cutover-domains-rollback "$before_hash" "$after_hash" \
      "$object_ids" "$settings" >/dev/null
    if [[ $rollback_result == rolled-back ]]; then
      block "domain cutover failed and was rolled back"
    fi
    block "domain cutover failed and rollback was incomplete"
  fi

  after_state=$(jq -cn \
    --arg api_host "$api_production_domain" \
    --arg frontend_host "$frontend_production_domain" \
    --argjson compose_domains "$compose_domains" \
    --argjson api_domains "$api_existing_domains" \
    --argjson frontend_domains "$frontend_existing_domains" '{
      composeDomains: [
        $compose_domains[] |
        select(.host == $api_host or .host == $frontend_host) |
        {
          domainId,
          host,
          port,
          https,
          path,
          serviceName,
          certificateType,
          customCertResolver,
          domainType,
          internalPath,
          stripPath
        }
      ],
      applicationDomains: {
        api: [
          $api_domains[] |
          select(.host == $api_host) |
          {
            domainId,
            host,
            port,
            https,
            path,
            applicationId,
            certificateType,
            customCertResolver,
            domainType,
            internalPath,
            stripPath
          }
        ],
        frontend: [
          $frontend_domains[] |
          select(.host == $frontend_host) |
          {
            domainId,
            host,
            port,
            https,
            path,
            applicationId,
            certificateType,
            customCertResolver,
            domainType,
            internalPath,
            stripPath
          }
        ]
      }
    }')
  settings=$(jq -cn \
    --arg api "$api_production_domain" \
    --arg frontend "$frontend_production_domain" \
    --argjson before "$before_state" \
    --argjson after "$after_state" '{
      result: "cut-over",
      productionDomains: {
        api: $api,
        frontend: $frontend
      },
      certificateType: "letsencrypt",
      https: true,
      domainTransition: {
        before: $before,
        after: $after
      }
    }')
  after_hash=$(printf '%s' "$after_state" | hash_json)
  receipt_file=$(write_receipt cutover-domains "$before_hash" "$after_hash" \
    "$object_ids" "$settings")
  jq -n \
    --arg receipt "$receipt_file" \
    --arg api "$api_production_domain" \
    --arg frontend "$frontend_production_domain" '{
      stage: "cutover-domains",
      status: "cut-over",
      productionDomains: {
        api: $api,
        frontend: $frontend
      },
      receipt: $receipt
    }'
}

validate_worker_drain_receipt() {
  local receipt_file=$1
  local receipt_json

  verify_gate_receipt_signature "$receipt_file"
  receipt_json=$(command cat "$receipt_file")
  require_fresh_timestamp \
    "$(jq -r '.checkedAt // empty' <<<"$receipt_json")" \
    "worker drain receipt"
  jq -e \
    --arg project_id "$project_id" \
    --arg environment_id "$environment_id" \
    --arg compose_id "$compose_id" \
    --arg worker_id "$worker_id" '
      .schemaVersion == 1 and
      .kind == "worker-drain" and
      .projectId == $project_id and
      .environmentId == $environment_id and
      .composeId == $compose_id and
      .applicationIds == {worker: $worker_id} and
      .oldWorker.serviceName == "worker" and
      (.oldWorker.containerId | type == "string" and length > 0) and
      .oldWorker.activeJobs == 0 and
      .oldWorker.drained == true and
      .oldWorker.stopped == true and
      .newWorker.applicationId == $worker_id and
      (.newWorker.deploymentId | type == "string" and length > 0) and
      .newWorker.ready == true and
      .newWorker.schedulerLeaseObserved == true and
      .checks == {
        queueFailuresUnchanged: true,
        noDuplicateSchedulerDispatches: true
      }
    ' <<<"$receipt_json" >/dev/null ||
    block "worker drain receipt is not bound to this exact topology"
}

require_finalization_domains() {
  local compose_domains
  local api_domains
  local frontend_domains

  compose_domains=$(dokploy_get \
    "/api/domain.byComposeId?composeId=$compose_id")
  api_domains=$(dokploy_get \
    "/api/domain.byApplicationId?applicationId=$api_id")
  frontend_domains=$(dokploy_get \
    "/api/domain.byApplicationId?applicationId=$frontend_id")

  jq -e \
    --arg api_host "$api_production_domain" \
    --arg frontend_host "$frontend_production_domain" '
      all(.[]?;
        .host != $api_host and .host != $frontend_host
      )
    ' <<<"$compose_domains" >/dev/null ||
    block "production domains must not remain on the legacy Compose object"
  jq -e \
    --arg host "$api_production_domain" \
    --arg application_id "$api_id" '
      [
        .[]? |
        select(
          .host == $host and
          .applicationId == $application_id and
          .composeId == null and
          .domainType == "application" and
          .port == 8888 and
          .https == true and
          .certificateType == "letsencrypt"
        )
      ] |
      length == 1
    ' <<<"$api_domains" >/dev/null ||
    block "API production domain is not mapped to the replacement application"
  jq -e \
    --arg host "$frontend_production_domain" \
    --arg application_id "$frontend_id" '
      [
        .[]? |
        select(
          .host == $host and
          .applicationId == $application_id and
          .composeId == null and
          .domainType == "application" and
          .port == 9999 and
          .https == true and
          .certificateType == "letsencrypt"
        )
      ] |
      length == 1
    ' <<<"$frontend_domains" >/dev/null ||
    block "frontend production domain is not mapped to the replacement application"
}

load_compose_services() {
  local services

  services=$(dokploy_get \
    "/api/compose.loadServices?composeId=$compose_id&type=cache")
  jq -e '
    type == "array" and
    all(.[]; type == "string" and test("^[A-Za-z0-9._-]+$")) and
    (length == (unique | length))
  ' <<<"$services" >/dev/null ||
    block "Compose service inventory returned an invalid response"
  printf '%s' "$services"
}

require_known_compose_services() {
  local services=$1

  jq -e '
    (index("postgres") != null) and
    (index("redis") != null) and
    all(.[];
      . == "postgres" or
      . == "redis" or
      . == "migrate" or
      . == "api" or
      . == "worker" or
      . == "frontend"
    )
  ' <<<"$services" >/dev/null ||
    block "legacy Compose service inventory contains an unexpected service"
}

require_old_worker_stopped() {
  local containers=$1
  local receipt_json
  local old_worker_id
  local compose_is_final

  receipt_json=$(command cat "$worker_drain_receipt")
  old_worker_id=$(jq -r '.oldWorker.containerId' <<<"$receipt_json")
  compose_is_final=$(jq -r \
    --arg name "$infrastructure_compose_name" \
    --arg path "./docker-compose.infrastructure.yml" '
      .name == $name and .composePath == $path
    ' <<<"$compose_json")

  if ! jq -e \
    --arg app_name "$(jq -r '.appName' <<<"$compose_json")" '
      all(
        .[]? |
        select(.name | test(
          ("^" + ($app_name | gsub("([][{}()+*.^$|\\\\?])"; "\\\\&")) +
          "[-_]worker[-_.]")
        ));
        ((.state // .State // "") | ascii_downcase) != "running"
      )
    ' <<<"$containers" >/dev/null; then
    block "legacy worker still has a running container"
  fi

  if [[ $compose_is_final != true ]] &&
    ! stopped_worker_container_matches_receipt \
      "$containers" "$old_worker_id" \
      "$(jq -r '.appName' <<<"$compose_json")"; then
    block "worker drain receipt does not match live stopped worker status"
  fi
}

stateful_container_id() {
  local service=$1
  local -a container_ids=()

  mapfile -t container_ids < <(
    docker ps -q \
      --filter "label=com.docker.compose.project=$(jq -r '.appName' \
        <<<"$compose_json")" \
      --filter "label=com.docker.compose.service=$service"
  )
  if ((${#container_ids[@]} != 1)) || [[ -z ${container_ids[0]} ]]; then
    block "expected exactly one running $service container"
  fi
  printf '%s' "${container_ids[0]}"
}

ensure_stateful_network_alias() {
  local container_id=$1
  local alias_name=$2
  local container_json

  container_json=$(docker inspect "$container_id" 2>/dev/null) ||
    block "cannot inspect stateful container"
  if jq -e \
    --arg network "$network_name" \
    --arg alias "$alias_name" '
      .[0].NetworkSettings.Networks[$network] as $attached |
      $attached != null and
      (($attached.Aliases // []) | index($alias) != null)
    ' <<<"$container_json" >/dev/null; then
    return
  fi
  docker network connect --alias "$alias_name" "$network_name" \
    "$container_id" >/dev/null ||
    block "could not connect stateful container to $network_name"
  container_json=$(docker inspect "$container_id" 2>/dev/null) ||
    block "cannot read back stateful container network"
  jq -e \
    --arg network "$network_name" \
    --arg alias "$alias_name" '
      .[0].NetworkSettings.Networks[$network] as $attached |
      $attached != null and
      (($attached.Aliases // []) | index($alias) != null)
    ' <<<"$container_json" >/dev/null ||
    block "stateful container network alias did not read back exactly"
}

run_task6_preflight() {
  local preflight_command
  local output_file
  local error_file
  local postgres_id=${1:-}
  local redis_id=${2:-}
  local preflight_mode=${3:-initial}
  local -a preflight_args=()

  preflight_command=${SYSTEMVITALS_PREFLIGHT_COMMAND:-\
"$repo_root/scripts/preflight-infrastructure-cutover.sh"}
  [[ -f $preflight_command && -x $preflight_command ]] ||
    block "Task 6 preflight command is unavailable"
  _dokploy_init || block "could not initialize protected temporary storage"
  output_file=$(mktemp "$DOKPLOY_API_TMPDIR/preflight-output.XXXXXXXX")
  error_file=$(mktemp "$DOKPLOY_API_TMPDIR/preflight-error.XXXXXXXX")
  chmod 0600 "$output_file" "$error_file"
  if [[ $preflight_mode == verify-unchanged ]]; then
    preflight_args+=(--verify-unchanged)
  fi
  if ! SYSTEMVITALS_DOKPLOY_PROJECT_ID=$project_id \
    SYSTEMVITALS_DOKPLOY_COMPOSE_ID=$compose_id \
    SYSTEMVITALS_COMPOSE_PROJECT="$(jq -r '.appName' <<<"$compose_json")" \
    SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID="$postgres_id" \
    SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID="$redis_id" \
    "$preflight_command" "${preflight_args[@]}" \
    >"$output_file" 2>"$error_file"; then
    return 1
  fi
}

compose_matches_infrastructure() {
  jq -e \
    --arg compose_id "$compose_id" \
    --arg name "$infrastructure_compose_name" \
    --arg github_id "$(jq -r '.githubId' <<<"$compose_json")" \
    --arg owner "$github_owner" \
    --arg repository "$github_repository" \
    --arg branch "$github_branch" '
      .composeId == $compose_id and
      .name == $name and
      .sourceType == "github" and
      .githubId == $github_id and
      .owner == $owner and
      .repository == $repository and
      .branch == $branch and
      .composePath == "./docker-compose.infrastructure.yml" and
      .autoDeploy == false
    ' <<<"$compose_json" >/dev/null
}

set_compose_state() {
  local payload=$1

  dokploy_post "/api/compose.update" "$payload" >/dev/null
  compose_json=$(dokploy_get "/api/compose.one?composeId=$compose_id")
}

set_application_auto_deploy() {
  local application_id=$1
  local application
  local payload

  application=$(get_application "$application_id")
  if [[ $(jq -r '.autoDeploy' <<<"$application") != true ]]; then
    payload=$(jq -cn \
      --arg application_id "$application_id" '{
        applicationId: $application_id,
        autoDeploy: true
      }')
    dokploy_post "/api/application.update" "$payload" >/dev/null
    application=$(get_application "$application_id")
  fi
  jq -e \
    --arg application_id "$application_id" '
      .applicationId == $application_id and .autoDeploy == true
    ' <<<"$application" >/dev/null ||
    block "application auto-deploy did not read back exactly"
}

write_finalization_blocked_receipt() {
  local before_hash=$1
  local object_ids=$2
  local reason=$3
  local after_state
  local after_hash
  local settings

  compose_json=$(dokploy_get "/api/compose.one?composeId=$compose_id")
  after_state=$(safe_discovery_snapshot)
  after_hash=$(printf '%s' "$after_state" | hash_json)
  settings=$(jq -cn --arg reason "$reason" '{
    result: "blocked",
    reason: $reason
  }')
  write_receipt finalize-infrastructure-blocked "$before_hash" "$after_hash" \
    "$object_ids" "$settings" >/dev/null
}

finalize_infrastructure() {
  local before_state
  local before_hash
  local after_state
  local after_hash
  local object_ids
  local settings
  local receipt_file
  local services
  local containers
  local compose_app_name
  local compose_path
  local old_compose_file
  local postgres_id
  local redis_id
  local worker_deployment_id
  local service
  local -a removable_services=()

  command -v docker >/dev/null 2>&1 ||
    block "required command 'docker' is unavailable"
  application_ids_from_discovery
  validate_worker_drain_receipt "$worker_drain_receipt"
  worker_deployment_id=$(jq -r '.newWorker.deploymentId' \
    "$worker_drain_receipt")
  require_application_healthy "$worker_id" "$worker_deployment_id"
  require_finalization_domains

  services=$(load_compose_services)
  require_known_compose_services "$services"
  compose_app_name=$(jq -r '.appName' <<<"$compose_json")
  [[ $compose_app_name =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "Compose appName contains unsupported characters"
  containers=$(dokploy_get \
    "/api/docker.getContainersByAppNameMatch?appName=$compose_app_name&appType=docker-compose")
  require_old_worker_stopped "$containers"

  before_state=$(safe_discovery_snapshot)
  before_hash=$(printf '%s' "$before_state" | hash_json)
  object_ids=$(jq -cn \
    --arg project_id "$project_id" \
    --arg environment_id "$environment_id" \
    --arg compose_id "$compose_id" \
    --arg api_id "$api_id" \
    --arg worker_id "$worker_id" \
    --arg frontend_id "$frontend_id" '{
      projectId: $project_id,
      environmentId: $environment_id,
      composeId: $compose_id,
      applicationIds: {
        api: $api_id,
        worker: $worker_id,
        frontend: $frontend_id
      }
    }')

  if [[ $(jq -r '.autoDeploy' <<<"$compose_json") != false ]]; then
    set_compose_state "$(jq -cn --arg compose_id "$compose_id" '{
      composeId: $compose_id,
      autoDeploy: false
    }')"
  fi
  jq -e '.autoDeploy == false' <<<"$compose_json" >/dev/null ||
    block "Compose auto-deploy did not read back disabled"

  if ! run_task6_preflight; then
    write_finalization_blocked_receipt "$before_hash" "$object_ids" \
      "task6-preflight"
    block "Task 6 authenticated preflight failed"
  fi

  postgres_id=$(stateful_container_id postgres)
  redis_id=$(stateful_container_id redis)
  ensure_stateful_network_alias "$postgres_id" sv-postgres
  ensure_stateful_network_alias "$redis_id" sv-redis

  docker compose \
    --project-name "$compose_app_name" \
    -f "$repo_root/docker-compose.infrastructure.yml" \
    --profile infrastructure-cutover \
    up -d --no-recreate postgres redis >/dev/null ||
    block "stateful no-recreate contract failed"
  run_task6_preflight "$postgres_id" "$redis_id" verify-unchanged ||
    block "Task 6 unchanged-infrastructure verification failed"

  compose_path=$(jq -r '.composePath' <<<"$compose_json")
  case "$compose_path" in
    ./docker-compose.dokploy.yml)
      old_compose_file="$repo_root/docker-compose.dokploy.yml"
      ;;
    ./docker-compose.infrastructure.yml)
      old_compose_file="$repo_root/docker-compose.dokploy.yml"
      ;;
    *)
      block "Compose path is neither the legacy nor infrastructure path"
      ;;
  esac

  if ! compose_matches_infrastructure; then
    set_compose_state "$(jq -cn \
      --arg compose_id "$compose_id" \
      --arg name "$infrastructure_compose_name" \
      --arg github_id "$(jq -r '.githubId' <<<"$compose_json")" \
      --arg owner "$github_owner" \
      --arg repository "$github_repository" \
      --arg branch "$github_branch" '{
        composeId: $compose_id,
        name: $name,
        sourceType: "github",
        githubId: $github_id,
        owner: $owner,
        repository: $repository,
        branch: $branch,
        composePath: "./docker-compose.infrastructure.yml",
        autoDeploy: false
      }')"
  fi
  compose_matches_infrastructure ||
    block "infrastructure Compose settings did not read back exactly"

  for service in migrate api worker frontend; do
    if jq -e --arg service "$service" 'index($service) != null' \
      <<<"$services" >/dev/null; then
      removable_services+=("$service")
    fi
  done
  if ((${#removable_services[@]} > 0)); then
    docker compose \
      --project-name "$compose_app_name" \
      -f "$old_compose_file" \
      rm --stop --force "${removable_services[@]}" >/dev/null ||
      block "explicit legacy stateless service removal failed"
  fi

  containers=$(dokploy_get \
    "/api/docker.getContainersByAppNameMatch?appName=$compose_app_name&appType=docker-compose")
  jq -e \
    --arg app_name "$compose_app_name" \
    --arg postgres_id "$postgres_id" \
    --arg redis_id "$redis_id" '
      length == 2 and
      (
        [
          .[] |
          select(
            (.containerId // .Id) == $postgres_id and
            (.name | test(
              ("^" + ($app_name |
                gsub("([][{}()+*.^$|\\\\?])"; "\\\\&")) +
              "[-_]postgres[-_.]")
            )) and
            ((.state // .State // "") | ascii_downcase) == "running"
          )
        ] |
        length == 1
      ) and
      (
        [
          .[] |
          select(
            (.containerId // .Id) == $redis_id and
            (.name | test(
              ("^" + ($app_name |
                gsub("([][{}()+*.^$|\\\\?])"; "\\\\&")) +
              "[-_]redis[-_.]")
            )) and
            ((.state // .State // "") | ascii_downcase) == "running"
          )
        ] |
        length == 1
      )
    ' <<<"$containers" >/dev/null ||
    block "post-removal state must contain exactly two stateful containers"
  run_task6_preflight "$postgres_id" "$redis_id" verify-unchanged ||
    block "Task 6 post-removal unchanged verification failed"

  set_application_auto_deploy "$api_id"
  set_application_auto_deploy "$worker_id"
  set_application_auto_deploy "$frontend_id"

  settings=$(jq -cn \
    --arg compose_name "$infrastructure_compose_name" \
    --argjson removed_services "$(printf '%s\n' \
      "${removable_services[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')" \
    --arg postgres_volume "${SYSTEMVITALS_POSTGRES_VOLUME:-}" \
    --arg redis_volume "${SYSTEMVITALS_REDIS_VOLUME:-}" '{
      composeName: $compose_name,
      composePath: "./docker-compose.infrastructure.yml",
      composeAutoDeploy: false,
      applicationAutoDeploy: true,
      preservedVolumes: [$postgres_volume, $redis_volume],
      removedServices: $removed_services
    }')
  after_state=$(jq -cn \
    --argjson compose "$(safe_discovery_snapshot)" \
    --argjson settings "$settings" '{
      topology: $compose,
      settings: $settings
    }')
  after_hash=$(printf '%s' "$after_state" | hash_json)
  receipt_file=$(write_receipt finalize-infrastructure "$before_hash" \
    "$after_hash" "$object_ids" "$settings")

  jq -n \
    --arg receipt "$receipt_file" \
    --arg compose_id "$compose_id" \
    --arg postgres_id "$postgres_id" \
    --arg redis_id "$redis_id" '{
      stage: "finalize-infrastructure",
      status: "finalized",
      composeId: $compose_id,
      statefulContainerIds: {
        postgres: $postgres_id,
        redis: $redis_id
      },
      receipt: $receipt
    }'
}

variable_names_json() {
  local env_value=$1

  printf '%s' "$env_value" |
    jq -Rsc '
      split("\n") |
      map(
        select(test("^[A-Za-z_][A-Za-z0-9_]*=")) |
        capture("^(?<name>[A-Za-z_][A-Za-z0-9_]*)=").name
      ) |
      unique |
      sort
    '
}

require_application_runtime_healthy() {
  local application=$1
  local app_name
  local tasks
  local containers

  jq -e '.applicationStatus == "done"' <<<"$application" >/dev/null ||
    block "replacement application status is not done"
  app_name=$(jq -r '.appName' <<<"$application")
  [[ $app_name =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "replacement application appName contains unsupported characters"
  tasks=$(dokploy_get \
    "/api/docker.getServiceContainersByAppName?appName=$app_name")
  require_exactly_one_healthy_running_task "$tasks"
  containers=$(dokploy_get \
    "/api/docker.getContainersByAppLabel?appName=$app_name&type=swarm")
  require_container_config_healthy "$containers"
}

verify_application_domains() {
  local kind=$1
  local application_id=$2
  local production_host=${3:-}
  local port=${4:-0}
  local domains

  domains=$(dokploy_get \
    "/api/domain.byApplicationId?applicationId=$application_id")
  if [[ $kind == worker ]]; then
    jq -e 'length == 0' <<<"$domains" >/dev/null ||
      block "worker application must not have domains"
  else
    jq -e \
      --arg host "$production_host" \
      --arg application_id "$application_id" \
      --argjson port "$port" '
        (length >= 1 and length <= 2) and
        (
          [
            .[]? |
            select(
              .host == $host and
              .applicationId == $application_id and
              .composeId == null and
              .domainType == "application" and
              .port == $port and
              .https == true and
              .certificateType == "letsencrypt"
            )
          ] |
          length == 1
        ) and
        all(.[];
          .applicationId == $application_id and
          .composeId == null and
          .domainType == "application" and
          .port == $port and
          .https == true and
          .certificateType == "letsencrypt" and
          (.host | type == "string" and length > 0)
        ) and
        ([.[] | select(.host != $host)] | length <= 1)
      ' <<<"$domains" >/dev/null ||
      block "$kind application domains do not match the final topology"
  fi
  jq -cS '
    [
      .[]? |
      {
        domainId,
        host,
        port,
        https,
        path,
        certificateType,
        domainType
      }
    ] |
    sort_by(.host)
  ' <<<"$domains"
}

verify_application_exact() {
  local kind=$1
  local application_id=$2
  local expected_name=$3
  local dockerfile=$4
  local context=$5
  local production_host=${6:-}
  local port=${7:-0}
  local application
  local expected_env
  local expected_build_args
  local expected_settings
  local domains
  local variable_names
  local build_variable_names

  application=$(get_application "$application_id")
  expected_env=$(canonicalize_application_environment "$kind" \
    "$(filter_compose_environment \
      "$(application_environment_allowlist "$kind")")")
  if [[ $kind == frontend ]]; then
    expected_build_args=$expected_env
  else
    expected_build_args=
  fi
  expected_settings=$(expected_application_settings "$kind" |
    jq -c '.autoDeploy = true')
  jq -en \
    --slurpfile application <(printf '%s' "$application") \
    --rawfile expected_env <(printf '%s' "$expected_env") \
    --rawfile expected_build_args <(printf '%s' "$expected_build_args") \
    --arg application_id "$application_id" \
    --arg name "$expected_name" \
    --arg environment_id "$environment_id" \
    --arg github_id "$(jq -r '.githubId' <<<"$compose_json")" \
    --arg owner "$github_owner" \
    --arg repository "$github_repository" \
    --arg branch "$github_branch" \
    --arg dockerfile "$dockerfile" \
    --arg context "$context" '
      ($application[0]) as $application |
      $application.applicationId == $application_id and
      $application.name == $name and
      $application.environmentId == $environment_id and
      $application.sourceType == "github" and
      $application.owner == $owner and
      $application.repository == $repository and
      $application.branch == $branch and
      $application.buildPath == "/" and
      $application.githubId == $github_id and
      $application.triggerType == "push" and
      $application.enableSubmodules == false and
      $application.buildType == "dockerfile" and
      $application.dockerfile == $dockerfile and
      $application.dockerContextPath == $context and
      $application.dockerBuildStage == null and
      $application.env == $expected_env and
      $application.buildArgs == $expected_build_args and
      $application.buildSecrets == "" and
      $application.createEnvFile == true and
      ($application.ports | length) == 0
    ' >/dev/null ||
    block "$kind application source, build, or environment state drifted"
  application_matches_fragment "$application" "$expected_settings" ||
    block "$kind application rolling settings drifted"
  require_application_runtime_healthy "$application"
  domains=$(verify_application_domains "$kind" "$application_id" \
    "$production_host" "$port")
  variable_names=$(variable_names_json "$(jq -r '.env // ""' \
    <<<"$application")")
  build_variable_names=$(variable_names_json "$(jq -r '.buildArgs // ""' \
    <<<"$application")")

  jq -cn \
    --slurpfile application <(printf '%s' "$application") \
    --argjson domains "$domains" \
    --argjson variable_names "$variable_names" \
    --argjson build_variable_names "$build_variable_names" \
    --argjson settings "$expected_settings" '
    ($application[0]) as $application |
    {
      applicationId: $application.applicationId,
      name: $application.name,
      appName: $application.appName,
      status: $application.applicationStatus,
      sourceType: $application.sourceType,
      owner: $application.owner,
      repository: $application.repository,
      branch: $application.branch,
      dockerfile: $application.dockerfile,
      dockerContextPath: $application.dockerContextPath,
      autoDeploy: $application.autoDeploy,
      replicas: $application.replicas,
      rollingSettings: {
        updateConfigSwarm: $settings.updateConfigSwarm,
        restartPolicySwarm: $settings.restartPolicySwarm,
        stopGracePeriodSwarm: $settings.stopGracePeriodSwarm,
        modeSwarm: $settings.modeSwarm,
        networkSwarm: $settings.networkSwarm,
        healthCheckSwarm: $settings.healthCheckSwarm
      },
      domains: $domains,
      variableNames: $variable_names,
      buildVariableNames: $build_variable_names
    }'
}

require_stateful_network_alias() {
  local container_id=$1
  local alias_name=$2
  local container_json

  container_json=$(docker inspect "$container_id" 2>/dev/null) ||
    block "cannot inspect stateful container"
  jq -e \
    --arg network "$network_name" \
    --arg alias "$alias_name" '
      .[0].NetworkSettings.Networks[$network] as $attached |
      $attached != null and
      (($attached.Aliases // []) | index($alias) != null)
    ' <<<"$container_json" >/dev/null ||
    block "stateful container network alias does not match"
}

verify_final_topology() {
  local services
  local compose_domains
  local compose_app_name
  local legacy_containers
  local network_json
  local postgres_id
  local redis_id
  local api_safe
  local worker_safe
  local frontend_safe
  local compose_variable_names

  command -v docker >/dev/null 2>&1 ||
    block "required command 'docker' is unavailable"
  application_ids_from_discovery
  jq -e \
    --arg compose_id "$compose_id" \
    --arg environment_id "$environment_id" \
    --arg name "$infrastructure_compose_name" \
    --arg owner "$github_owner" \
    --arg repository "$github_repository" \
    --arg branch "$github_branch" '
      .composeId == $compose_id and
      .environmentId == $environment_id and
      .name == $name and
      .composeStatus == "done" and
      .composeType == "docker-compose" and
      .sourceType == "github" and
      .owner == $owner and
      .repository == $repository and
      .branch == $branch and
      .composePath == "./docker-compose.infrastructure.yml" and
      .autoDeploy == false and
      (.domains | length) == 0
    ' <<<"$compose_json" >/dev/null ||
    block "infrastructure Compose state drifted"

  services=$(load_compose_services)
  jq -e '
    length == 2 and
    (sort == ["postgres", "redis"])
  ' <<<"$services" >/dev/null ||
    block "infrastructure Compose service inventory drifted"
  services=$(jq -c 'sort' <<<"$services")

  compose_domains=$(dokploy_get \
    "/api/domain.byComposeId?composeId=$compose_id")
  jq -e 'length == 0' <<<"$compose_domains" >/dev/null ||
    block "infrastructure Compose unexpectedly owns domains"

  api_safe=$(verify_application_exact api "$api_id" "$api_name" \
    "api/Dockerfile" "." "$api_production_domain" 8888)
  worker_safe=$(verify_application_exact worker "$worker_id" "$worker_name" \
    "worker/Dockerfile" ".")
  frontend_safe=$(verify_application_exact frontend "$frontend_id" \
    "$frontend_name" "frontend/Dockerfile" "frontend" \
    "$frontend_production_domain" 9999)

  compose_app_name=$(jq -r '.appName' <<<"$compose_json")
  [[ $compose_app_name =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "Compose appName contains unsupported characters"
  legacy_containers=$(dokploy_get \
    "/api/docker.getContainersByAppNameMatch?appName=$compose_app_name&appType=docker-compose")
  jq -e \
    --arg app_name "$compose_app_name" '
      length == 2 and
      all(
        .[]?;
        (
          (.name | test(
            ("^" + ($app_name | gsub("([][{}()+*.^$|\\\\?])"; "\\\\&")) +
            "[-_](postgres|redis)[-_.]")
          )) and
          ((.state // .State // "") | ascii_downcase) == "running" and
          ((.status // .Status // "") | test("\\(healthy\\)"))
        )
      )
    ' <<<"$legacy_containers" >/dev/null ||
    block "legacy Compose containers are not stateful-only and healthy"

  network_json=$(docker network inspect "$network_name" 2>/dev/null) ||
    block "$network_name does not exist"
  jq -e \
    --arg network "$network_name" '
      length == 1 and
      .[0].Name == $network and
      .[0].Driver == "overlay" and
      .[0].Scope == "swarm" and
      .[0].Attachable == true
    ' <<<"$network_json" >/dev/null ||
    block "$network_name does not match the expected overlay settings"
  postgres_id=$(stateful_container_id postgres)
  redis_id=$(stateful_container_id redis)
  require_stateful_network_alias "$postgres_id" sv-postgres
  require_stateful_network_alias "$redis_id" sv-redis
  run_task6_preflight "$postgres_id" "$redis_id" verify-unchanged ||
    block "Task 6 unchanged-infrastructure verification failed"

  compose_variable_names=$(variable_names_json \
    "$(jq -r '.env // ""' <<<"$compose_json")")
  jq -n \
    --arg project_id "$project_id" \
    --arg environment_id "$environment_id" \
    --arg compose_id "$compose_id" \
    --arg compose_app_name "$compose_app_name" \
    --arg compose_status "$(jq -r '.composeStatus' <<<"$compose_json")" \
    --arg postgres_id "$postgres_id" \
    --arg redis_id "$redis_id" \
    --argjson services "$services" \
    --argjson compose_variable_names "$compose_variable_names" \
    --argjson api "$api_safe" \
    --argjson worker "$worker_safe" \
    --argjson frontend "$frontend_safe" '{
      stage: "verify",
      status: "verified",
      project: {
        projectId: $project_id,
        name: "SystemVitals"
      },
      environment: {
        environmentId: $environment_id,
        name: "production"
      },
      compose: {
        composeId: $compose_id,
        name: "SystemVitals Infrastructure",
        appName: $compose_app_name,
        status: $compose_status,
        composePath: "./docker-compose.infrastructure.yml",
        autoDeploy: false,
        services: $services,
        variableNames: $compose_variable_names
      },
      applications: [$api, $worker, $frontend],
      infrastructure: {
        network: "systemvitals-internal",
        postgresContainerId: $postgres_id,
        redisContainerId: $redis_id,
        task6Preflight: "verified-unchanged"
      }
    }'
}

print_plan() {
  local application_id
  local application
  local domains
  local variable_names
  local build_variable_names
  local safe_application
  local safe_applications='[]'

  while IFS= read -r application_id; do
    [[ $application_id =~ ^[A-Za-z0-9._-]+$ ]] ||
      block "application ID contains unsupported characters"
    application=$(get_application "$application_id")
    domains=$(dokploy_get \
      "/api/domain.byApplicationId?applicationId=$application_id")
    variable_names=$(variable_names_json \
      "$(jq -r '.env // ""' <<<"$application")")
    build_variable_names=$(variable_names_json \
      "$(jq -r '.buildArgs // ""' <<<"$application")")
    safe_application=$(jq -cn \
      --slurpfile application <(printf '%s' "$application") \
      --argjson domains "$domains" \
      --argjson variable_names "$variable_names" \
      --argjson build_variable_names "$build_variable_names" '
        ($application[0]) as $application |
        {
          applicationId: $application.applicationId,
          name: $application.name,
          appName: $application.appName,
          status: $application.applicationStatus,
          sourceType: $application.sourceType,
          owner: $application.owner,
          repository: $application.repository,
          branch: $application.branch,
          dockerfile: $application.dockerfile,
          dockerContextPath: $application.dockerContextPath,
          autoDeploy: $application.autoDeploy,
          domains: [
            $domains[]? |
            {
              domainId,
              host,
              path,
              port,
              https,
              serviceName,
              certificateType,
              customCertResolver,
              domainType,
              internalPath,
              stripPath
            }
          ],
          variableNames: $variable_names,
          buildVariableNames: $build_variable_names
        }
      ')
    safe_applications=$(jq -c \
      --argjson application "$safe_application" \
      '. + [$application]' <<<"$safe_applications")
  done < <(jq -r '.[].applicationId' <<<"$applications_json")

  jq -n \
    --slurpfile project <(printf '%s' "$project_json") \
    --slurpfile environment <(printf '%s' "$environment_json") \
    --slurpfile compose <(printf '%s' "$compose_json") \
    --argjson applications "$safe_applications" '
      ($project[0]) as $project |
      ($environment[0]) as $environment |
      ($compose[0]) as $compose |
      {
        project: {
          projectId: $project.projectId,
          name: $project.name
        },
        environment: {
          environmentId: $environment.environmentId,
          name: $environment.name
        },
        compose: {
          composeId: $compose.composeId,
          name: $compose.name,
          appName: $compose.appName,
          status: $compose.composeStatus,
          composeType: $compose.composeType,
          sourceType: $compose.sourceType,
          owner: $compose.owner,
          repository: $compose.repository,
          branch: $compose.branch,
          composePath: $compose.composePath,
          autoDeploy: $compose.autoDeploy,
          domains: [
            $compose.domains[]? |
            {
              domainId,
              host,
              port,
              https,
              path,
              serviceName,
              certificateType,
              domainType
            }
          ],
          variableNames: (
            ($compose.env // "") |
            split("\n") |
            map(
              select(test("^[A-Za-z_][A-Za-z0-9_]*=")) |
              split("=")[0]
            ) |
            unique |
            sort
          )
        },
        applications: $applications,
        receiptGeneration: {
          replacementSmoke: {
            mode: "generate-replacement-smoke",
            requiredInputs: [
              "apiDeploymentId",
              "workerDeploymentId",
              "frontendDeploymentId"
            ],
            performsLiveChecks: true
          },
          workerDrain: {
            mode: "generate-worker-drain",
            requiredInputs: [
              "oldWorkerContainerId",
              "newWorkerDeploymentId"
            ],
            requiredAttestations: [
              "activeJobsZero",
              "queueFailuresUnchanged",
              "noDuplicateSchedulerDispatches"
            ]
          },
          output: "mode-0600 signed receipt outside repository"
        }
      }
    '
}

discover_state

case "$mode" in
  plan)
    print_plan
    ;;
  generate-replacement-smoke)
    generate_replacement_smoke_receipt
    ;;
  generate-worker-drain)
    generate_worker_drain_receipt
    ;;
  verify)
    verify_final_topology
    ;;
  apply-apps)
    apply_apps
    ;;
  cutover-domains)
    cutover_domains
    ;;
  finalize-infrastructure)
    finalize_infrastructure
    ;;
esac
