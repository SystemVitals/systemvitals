#!/usr/bin/env bash
set -euo pipefail

repo_root=${DEPLOYMENT_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
compose_file=${DEPLOYMENT_COMPOSE_FILE:-"$repo_root/docker-compose.infrastructure.yml"}
skip_images=false

fail() {
  echo "Deployment configuration validation failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/validate-deployment-config.sh [--skip-images]

Validates the infrastructure Compose topology and the built API, worker, and
frontend image metadata. --skip-images is only for static CI validation when
images are unavailable; live cutover preflight never permits it.
EOF
}

while (($# > 0)); do
  case "$1" in
    --skip-images)
      skip_images=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is unavailable"
}

require_nonempty() {
  local name=$1
  [[ -n ${!name:-} ]] || fail "$name must be set and nonempty"
}

require_file() {
  [[ -f "$1" ]] || fail "required file is missing: $1"
}

require_executable() {
  [[ -f "$1" && -x "$1" ]] ||
    fail "required executable is missing: $1"
}

inspect_image() {
  local variable_name=$1
  local service_name=$2
  local assertion=$3
  local image_ref=${!variable_name}
  local image_config

  if ! image_config=$(docker image inspect "$image_ref" 2>/dev/null); then
    fail "$service_name image is unavailable: $image_ref"
  fi
  if ! printf '%s' "$image_config" | jq -e "$assertion" >/dev/null; then
    fail "$service_name built image metadata is invalid"
  fi
}

require_command docker
require_command jq
docker compose version >/dev/null 2>&1 ||
  fail "the Docker Compose plugin is unavailable"

require_nonempty SYSTEMVITALS_POSTGRES_VOLUME
require_nonempty SYSTEMVITALS_REDIS_VOLUME
require_nonempty POSTGRES_PASSWORD
require_file "$compose_file"

if ! resolved_config=$(docker compose --profile infrastructure-cutover \
  -f "$compose_file" config --format json 2>/dev/null); then
  fail "docker compose config rejected $compose_file"
fi

if ! printf '%s' "$resolved_config" | jq -e \
  --arg postgres_volume "$SYSTEMVITALS_POSTGRES_VOLUME" \
  --arg redis_volume "$SYSTEMVITALS_REDIS_VOLUME" '
    (.services | keys | sort) == ["postgres", "redis"] and
    (.services.postgres.image == "postgres:18") and
    (.services.redis.image == "redis:7") and
    (.services.postgres.restart == "unless-stopped") and
    (.services.redis.restart == "unless-stopped") and
    (.services.postgres.stop_grace_period == "1m0s") and
    (.services.redis.stop_grace_period == "1m0s") and
    (.services.postgres.profiles == ["infrastructure-cutover"]) and
    (.services.redis.profiles == ["infrastructure-cutover"]) and
    ((.services.postgres.environment.POSTGRES_PASSWORD | type) == "string") and
    ((.services.postgres.environment.POSTGRES_PASSWORD | length) > 0) and
    ((.services.postgres.environment.POSTGRES_USER | length) > 0) and
    ((.services.postgres.environment.POSTGRES_DB | length) > 0) and
    (.services.postgres.volumes | length == 1) and
    (.services.postgres.volumes[0].type == "volume") and
    (.services.postgres.volumes[0].source == "sv_pgdata") and
    (.services.postgres.volumes[0].target == "/var/lib/postgresql") and
    (.services.redis.volumes | length == 1) and
    (.services.redis.volumes[0].type == "volume") and
    (.services.redis.volumes[0].source == "sv_redisdata") and
    (.services.redis.volumes[0].target == "/data") and
    (.volumes | keys | sort) == ["sv_pgdata", "sv_redisdata"] and
    (.volumes.sv_pgdata.external == true) and
    (.volumes.sv_pgdata.name == $postgres_volume) and
    (.volumes.sv_redisdata.external == true) and
    (.volumes.sv_redisdata.name == $redis_volume) and
    (.networks | keys) == ["systemvitals-internal"] and
    (.networks["systemvitals-internal"].external == true) and
    (.networks["systemvitals-internal"].name == "systemvitals-internal") and
    (.services.postgres.networks | keys) == ["systemvitals-internal"] and
    (.services.redis.networks | keys) == ["systemvitals-internal"] and
    (.services.postgres.networks["systemvitals-internal"].aliases == ["sv-postgres"]) and
    (.services.redis.networks["systemvitals-internal"].aliases == ["sv-redis"]) and
    (.services.postgres.healthcheck.test[0] == "CMD-SHELL") and
    (.services.postgres.healthcheck.test[1] | startswith("pg_isready -U ")) and
    (.services.postgres.healthcheck.interval == "10s") and
    (.services.postgres.healthcheck.timeout == "5s") and
    (.services.postgres.healthcheck.retries == 5) and
    (.services.redis.healthcheck.test == ["CMD", "redis-cli", "ping"]) and
    (.services.redis.healthcheck.interval == "10s") and
    (.services.redis.healthcheck.timeout == "5s") and
    (.services.redis.healthcheck.retries == 5) and
    ([.services[] | (.ports // []) | length] | all(. == 0))
  ' >/dev/null; then
  fail "resolved Compose topology does not satisfy deployment invariants"
fi
unset resolved_config

require_file "$repo_root/api/Dockerfile"
require_file "$repo_root/worker/Dockerfile"
require_file "$repo_root/frontend/Dockerfile"
require_executable \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/retarget-dokploy-source.sh"

if "$skip_images"; then
  echo "Static deployment configuration is valid; built images were explicitly skipped."
  exit 0
fi

require_nonempty SYSTEMVITALS_API_IMAGE
require_nonempty SYSTEMVITALS_WORKER_IMAGE
require_nonempty SYSTEMVITALS_FRONTEND_IMAGE

inspect_image SYSTEMVITALS_API_IMAGE api '
  length == 1 and
  .[0].Config.Entrypoint == ["/app/api/docker-entrypoint.sh"] and
  .[0].Config.Cmd == ["node", "api/dist/main.js"] and
  ((.[0].Config.Healthcheck.Test // []) | join(" ") | contains("/health/ready")) and
  .[0].Config.Healthcheck.Interval == 10000000000 and
  .[0].Config.Healthcheck.Timeout == 5000000000 and
  .[0].Config.Healthcheck.StartPeriod == 1860000000000 and
  .[0].Config.Healthcheck.Retries == 3
'
inspect_image SYSTEMVITALS_WORKER_IMAGE worker '
  length == 1 and
  .[0].Config.Entrypoint == ["/app/worker/docker-entrypoint.sh"] and
  .[0].Config.Cmd == ["node", "/app/worker/dist/cli/worker.js"] and
  ((.[0].Config.Healthcheck.Test // []) | join(" ") | contains("WORKER_READINESS_PATH")) and
  .[0].Config.Healthcheck.Interval == 10000000000 and
  .[0].Config.Healthcheck.Timeout == 5000000000 and
  .[0].Config.Healthcheck.StartPeriod == 1860000000000 and
  .[0].Config.Healthcheck.Retries == 3
'
inspect_image SYSTEMVITALS_FRONTEND_IMAGE frontend '
  length == 1 and
  .[0].Config.Cmd == ["node", "server.js"] and
  ((.[0].Config.Healthcheck.Test // []) | join(" ") | contains("/api/health")) and
  .[0].Config.Healthcheck.Interval == 10000000000 and
  .[0].Config.Healthcheck.Timeout == 5000000000 and
  .[0].Config.Healthcheck.StartPeriod == 60000000000 and
  .[0].Config.Healthcheck.Retries == 3
'

echo "Deployment configuration and built image metadata are valid."
