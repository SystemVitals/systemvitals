#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
compose_file="$repo_root/docker-compose.infrastructure.yml"
validator="$repo_root/scripts/validate-deployment-config.sh"
preflight_command="$repo_root/scripts/preflight-infrastructure-cutover.sh"
dokploy_api_helper="$repo_root/scripts/dokploy-api.sh"
network_name=systemvitals-internal
backup_max_age_seconds=${SYSTEMVITALS_BACKUP_MAX_AGE_SECONDS:-86400}
postgres_db=${POSTGRES_DB:-systemvitals}
mode=preflight

block() {
  echo "BLOCKED: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/preflight-infrastructure-cutover.sh [--verify-unchanged]

Performs authenticated, read-only Dokploy and Docker checks, then prints the
stateful-only finalization contract. Profiles are not treated as a hard safety
boundary. This script requires live Dokploy state and real backup objects; a
local receipt can cache IDs but is never authority.

Task 6 never creates networks, connects containers, runs Compose up, or removes
legacy stateless services. Stateless removal belongs to Task 12 after
replacement health, domain cutover, and worker-drain gates. --apply is
intentionally unsupported.
EOF
}

if (($# > 0)); then
  case "$1" in
    --verify-unchanged)
      mode=verify-unchanged
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      block "this preflight is read-only; mutation arguments are not supported"
      ;;
  esac
  shift
fi
if (($# > 0)); then
  block "this preflight accepts only one read-only mode"
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || block "required command '$1' is unavailable"
}

require_nonempty() {
  local name=$1
  [[ -n ${!name:-} ]] || block "$name must be set and nonempty"
}

require_safe_identifier() {
  local name=$1
  local value=${!name}
  [[ $value =~ ^[a-zA-Z0-9_.-]+$ ]] ||
    block "$name contains unsupported characters"
}

require_positive_integer() {
  local name=$1
  local value=$2
  [[ $value =~ ^[1-9][0-9]*$ ]] || block "$name must be a positive integer"
}

require_command docker
require_command jq
require_nonempty DOKPLOY_URL
require_nonempty DOKPLOY_API_KEY
require_nonempty SYSTEMVITALS_DOKPLOY_PROJECT_ID
require_nonempty SYSTEMVITALS_DOKPLOY_COMPOSE_ID
require_nonempty SYSTEMVITALS_COMPOSE_PROJECT
require_nonempty SYSTEMVITALS_POSTGRES_VOLUME
require_nonempty SYSTEMVITALS_REDIS_VOLUME
require_nonempty SYSTEMVITALS_BACKUP_ID
require_nonempty SYSTEMVITALS_BACKUP_DESTINATION_ID
require_nonempty POSTGRES_PASSWORD
require_nonempty SYSTEMVITALS_API_IMAGE
require_nonempty SYSTEMVITALS_WORKER_IMAGE
require_nonempty SYSTEMVITALS_FRONTEND_IMAGE
require_safe_identifier SYSTEMVITALS_DOKPLOY_PROJECT_ID
require_safe_identifier SYSTEMVITALS_DOKPLOY_COMPOSE_ID
require_safe_identifier SYSTEMVITALS_COMPOSE_PROJECT
require_safe_identifier SYSTEMVITALS_POSTGRES_VOLUME
require_safe_identifier SYSTEMVITALS_REDIS_VOLUME
require_safe_identifier SYSTEMVITALS_BACKUP_ID
require_safe_identifier SYSTEMVITALS_BACKUP_DESTINATION_ID
require_positive_integer SYSTEMVITALS_BACKUP_MAX_AGE_SECONDS \
  "$backup_max_age_seconds"
# shellcheck source=scripts/dokploy-api.sh
source "$dokploy_api_helper"
_dokploy_init || block "authenticated Dokploy client initialization failed"

project_state=$(dokploy_get \
  "/api/project.one?projectId=$SYSTEMVITALS_DOKPLOY_PROJECT_ID")
if ! printf '%s' "$project_state" | jq -e \
  --arg project_id "$SYSTEMVITALS_DOKPLOY_PROJECT_ID" \
  --arg compose_id "$SYSTEMVITALS_DOKPLOY_COMPOSE_ID" '
    .projectId == $project_id and
    ([.environments[]?.compose[]?.composeId] | index($compose_id) != null)
  ' >/dev/null; then
  block "Dokploy project does not contain the exact Compose object"
fi
unset project_state

compose_state=$(dokploy_get \
  "/api/compose.one?composeId=$SYSTEMVITALS_DOKPLOY_COMPOSE_ID")
if ! printf '%s' "$compose_state" | jq -e \
  --arg compose_id "$SYSTEMVITALS_DOKPLOY_COMPOSE_ID" \
  --arg project_id "$SYSTEMVITALS_DOKPLOY_PROJECT_ID" \
  --arg app_name "$SYSTEMVITALS_COMPOSE_PROJECT" '
    .composeId == $compose_id and
    .appName == $app_name and
    .environment.project.projectId == $project_id
  ' >/dev/null; then
  block "live Dokploy Compose identity does not match the requested project"
fi
if ! printf '%s' "$compose_state" | jq -e '.autoDeploy == false' >/dev/null; then
  block "live Dokploy Compose auto-deploy must be disabled"
fi
if ! printf '%s' "$compose_state" | jq -e '
  [
    (.env // ""),
    (.environment.env // ""),
    (.environment.project.env // "")
  ] |
  all(test("(?m)^[ \t]*(export[ \t]+)?COMPOSE_PROFILES[ \t]*=") | not)
' >/dev/null; then
  block "live Dokploy environment must not define COMPOSE_PROFILES"
fi
if ! printf '%s' "$compose_state" | jq -e '
  .command == null or
  ((.command | type) == "string" and
    ((.command | gsub("[[:space:]]"; "")) | length == 0))
' >/dev/null; then
  block "live Dokploy Compose custom command must be empty"
fi

if ! printf '%s' "$compose_state" | jq -e \
  --arg backup_id "$SYSTEMVITALS_BACKUP_ID" \
  --arg destination_id "$SYSTEMVITALS_BACKUP_DESTINATION_ID" \
  --arg compose_id "$SYSTEMVITALS_DOKPLOY_COMPOSE_ID" \
  --arg database "$postgres_db" '
    [
      .backups[]? |
      select(
        .backupId == $backup_id and
        .enabled == true and
        .backupType == "compose" and
        .databaseType == "postgres" and
        .composeId == $compose_id and
        .serviceName == "postgres" and
        .database == $database and
        .destinationId == $destination_id and
        .destination.destinationId == $destination_id and
        (.prefix | type == "string")
      )
    ] |
    length == 1
  ' >/dev/null; then
  block "no exact enabled Dokploy Compose backup is configured"
fi
if ! printf '%s' "$compose_state" | jq -e \
  --arg backup_id "$SYSTEMVITALS_BACKUP_ID" \
  --argjson max_age "$backup_max_age_seconds" '
    def dokploy_timestamp_epoch:
      try (
        capture(
          "^(?<base>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})" +
          "(?<fraction>\\.[0-9]+)?(?<zone>Z|[+-][0-9]{2}:?[0-9]{2})$"
        ) as $timestamp |
        ($timestamp.zone | gsub(":"; "")) as $zone |
        (
          if $zone == "Z" then
            0
          else
            (
              (($zone[1:3] | tonumber) * 3600) +
              (($zone[3:5] | tonumber) * 60)
            ) *
            (if $zone[0:1] == "-" then -1 else 1 end)
          end
        ) as $offset |
        (($timestamp.base + "Z") | fromdateiso8601) +
        (($timestamp.fraction // "0") | tonumber) -
        $offset
      ) catch empty;

    [
      .backups[]? |
      select(.backupId == $backup_id) |
      .deployments[]? |
      select(
        .backupId == $backup_id and
        .status == "done" and
        (.finishedAt | dokploy_timestamp_epoch) as $finished |
        ((now - $finished) >= 0) and
        ((now - $finished) <= $max_age)
      )
    ] |
    length > 0
  ' >/dev/null; then
  block "Dokploy has no recent successful backup execution"
fi
backup_prefix_raw=$(printf '%s' "$compose_state" | jq -r \
  --arg backup_id "$SYSTEMVITALS_BACKUP_ID" '
    .backups[] | select(.backupId == $backup_id) | .prefix
  ')
compose_server_id=$(printf '%s' "$compose_state" | jq -r '.serverId // empty')
unset compose_state

backup_state=$(dokploy_get \
  "/api/backup.one?backupId=$SYSTEMVITALS_BACKUP_ID")
if ! printf '%s' "$backup_state" | jq -e \
  --arg backup_id "$SYSTEMVITALS_BACKUP_ID" \
  --arg destination_id "$SYSTEMVITALS_BACKUP_DESTINATION_ID" \
  --arg compose_id "$SYSTEMVITALS_DOKPLOY_COMPOSE_ID" \
  --arg prefix "$backup_prefix_raw" \
  --arg database "$postgres_db" '
    .backupId == $backup_id and
    .enabled == true and
    .backupType == "compose" and
    .databaseType == "postgres" and
    .composeId == $compose_id and
    .serviceName == "postgres" and
    .database == $database and
    .prefix == $prefix and
    .destinationId == $destination_id and
    .destination.destinationId == $destination_id
  ' >/dev/null; then
  block "authenticated Dokploy backup detail does not match live Compose state"
fi
unset backup_state

backup_prefix=$(printf '%s' "$backup_prefix_raw" | jq -Rr '
  gsub("^[[:space:]]+|[[:space:]]+$"; "") |
  gsub("^/+|/+$"; "")
')
if [[ -z $backup_prefix || $backup_prefix == *//* ]]; then
  block "configured Dokploy backup prefix is empty or unsafe"
fi
IFS=/ read -r -a backup_prefix_segments <<<"$backup_prefix"
if ((${#backup_prefix_segments[@]} < 2)); then
  block "configured Dokploy backup prefix is empty or unsafe"
fi
for backup_prefix_segment in "${backup_prefix_segments[@]}"; do
  if [[ -z $backup_prefix_segment ||
    $backup_prefix_segment == "." ||
    $backup_prefix_segment == ".." ||
    ! $backup_prefix_segment =~ ^[a-zA-Z0-9_.-]+$ ]]; then
    block "configured Dokploy backup prefix is empty or unsafe"
  fi
done
unset backup_prefix_segments backup_prefix_segment
backup_search="$backup_prefix/"
backup_destination_query=$(jq -nr \
  --arg value "$SYSTEMVITALS_BACKUP_DESTINATION_ID" '$value | @uri')
backup_search_query=$(jq -nr --arg value "$backup_search" '$value | @uri')
backup_files_path="/api/backup.listBackupFiles?destinationId=$backup_destination_query&search=$backup_search_query"
if [[ -n $compose_server_id ]]; then
  backup_server_query=$(jq -nr --arg value "$compose_server_id" '$value | @uri')
  backup_files_path+="&serverId=$backup_server_query"
fi
if ! backup_files=$(dokploy_get "$backup_files_path"); then
  block "authenticated Dokploy backup object listing failed"
fi
if ! printf '%s' "$backup_files" | jq -e \
  --arg path_prefix "$backup_search" \
  --argjson max_age "$backup_max_age_seconds" '
    def backup_filename_epoch:
      try (
        capture(
          "^(?<base>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})" +
          "(?<fraction>\\.[0-9]+)?Z\\.sql\\.gz$"
        ) as $timestamp |
        ($timestamp.base + "Z") as $canonical |
        ($canonical | fromdateiso8601) as $seconds |
        select(
          ($seconds | strftime("%Y-%m-%dT%H:%M:%SZ")) == $canonical
        ) |
        $seconds + (($timestamp.fraction // "0") | tonumber)
      ) catch empty;

    [
      .[]? |
      . as $file |
      ($file.Name | backup_filename_epoch) as $created |
      select(
        $file.IsDir == false and
        ($file.Size | type == "number" and . > 0) and
        ($file.Name | type == "string") and
        ((now - $created) >= 0) and
        ((now - $created) <= $max_age) and
        ($file.Path | type == "string" and
          . == ($path_prefix + $file.Name))
      )
    ] |
    length > 0
  ' >/dev/null; then
  block "no recent nonempty backup object exists in the configured destination"
fi
unset backup_files

if ! "$validator" >/dev/null; then
  block "deployment configuration or built image metadata is invalid"
fi

if ! network_config=$(docker network inspect "$network_name" 2>/dev/null); then
  block "$network_name does not exist; creation belongs to later provisioning"
fi
if ! printf '%s' "$network_config" | jq -e \
  --arg name "$network_name" '
    length == 1 and
    .[0].Name == $name and
    (.[0].Id | type == "string" and length > 0) and
    .[0].Driver == "overlay" and
    .[0].Scope == "swarm" and
    .[0].Attachable == true
  ' >/dev/null; then
  block "$network_name must be an attachable swarm overlay network"
fi
network_id=$(printf '%s' "$network_config" | jq -r '.[0].Id')
unset network_config

validate_stateful_container() {
  local service=$1
  local expected_volume=$2
  local expected_destination=$3
  local expected_alias=$4
  local result_variable=$5
  local -a container_ids=()
  local container_id
  local health_status
  local mounts
  local container_networks

  mapfile -t container_ids < <(
    docker ps -q \
      --filter "label=com.docker.compose.project=$SYSTEMVITALS_COMPOSE_PROJECT" \
      --filter "label=com.docker.compose.service=$service"
  )
  if ((${#container_ids[@]} != 1)) || [[ -z ${container_ids[0]} ]]; then
    block "expected exactly one running $service container"
  fi
  container_id=${container_ids[0]}

  if ! health_status=$(docker inspect --format '{{.State.Health.Status}}' \
    "$container_id" 2>/dev/null); then
    block "cannot inspect $service container health"
  fi
  [[ $health_status == healthy ]] ||
    block "$service container is not healthy"

  if ! mounts=$(docker inspect --format '{{json .Mounts}}' \
    "$container_id" 2>/dev/null); then
    block "cannot inspect $service container mounts"
  fi
  if ! printf '%s' "$mounts" | jq -e \
    --arg volume "$expected_volume" \
    --arg destination "$expected_destination" '
      length == 1 and
      .[0].Type == "volume" and
      .[0].Name == $volume and
      .[0].Destination == $destination and
      .[0].RW == true
    ' >/dev/null; then
    block "$service must have exactly one matching writable volume mount"
  fi

  if [[ $mode == verify-unchanged ]]; then
    if ! container_networks=$(docker inspect \
      --format '{{json .NetworkSettings.Networks}}' \
      "$container_id" 2>/dev/null); then
      block "cannot inspect $service container networks"
    fi
    if ! printf '%s' "$container_networks" | jq -e \
      --arg network "$network_name" \
      --arg network_id "$network_id" \
      --arg alias "$expected_alias" '
        .[$network].NetworkID == $network_id and
        ((.[$network].Aliases // []) | index($alias) != null)
      ' >/dev/null; then
      block "$service is not attached to the expected internal network and alias"
    fi
  fi

  printf -v "$result_variable" '%s' "$container_id"
}

postgres_container_id=
redis_container_id=
validate_stateful_container postgres "$SYSTEMVITALS_POSTGRES_VOLUME" \
  /var/lib/postgresql sv-postgres postgres_container_id
validate_stateful_container redis "$SYSTEMVITALS_REDIS_VOLUME" \
  /data sv-redis redis_container_id

if [[ $mode == verify-unchanged ]]; then
  require_nonempty SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID
  require_nonempty SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID
  require_safe_identifier SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID
  require_safe_identifier SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID
  [[ $postgres_container_id == "$SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID" ]] ||
    block "postgres container ID changed during finalization"
  [[ $redis_container_id == "$SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID" ]] ||
    block "redis container ID changed during finalization"
  echo "FINALIZATION VERIFIED: container, volume, network, and alias identities are unchanged."
  exit 0
fi

printf '%s\n' \
  "PREFLIGHT OK: authenticated Dokploy, backup objects, built images, network, containers, health, and mounts verified." \
  "Infrastructure auto-deploy is verified disabled and must remain disabled." \
  "Profiles are only a guardrail; live Dokploy environment and command checks are authoritative." \
  "1. docker network connect --alias sv-postgres $network_name $postgres_container_id" \
  "2. docker network connect --alias sv-redis $network_name $redis_container_id" \
  "3. docker compose --project-name $SYSTEMVITALS_COMPOSE_PROJECT -f $compose_file --profile infrastructure-cutover up -d --no-recreate postgres redis" \
  "4. SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID=$postgres_container_id SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID=$redis_container_id $preflight_command --verify-unchanged" \
  "5. VERIFY unchanged: $postgres_container_id $SYSTEMVITALS_POSTGRES_VOLUME $redis_container_id $SYSTEMVITALS_REDIS_VOLUME" \
  "Task 12 owns legacy stateless removal after replacement health, domain, and worker-drain gates."
