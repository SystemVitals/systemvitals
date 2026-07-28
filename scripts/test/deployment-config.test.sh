#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
compose_file="$repo_root/docker-compose.infrastructure.yml"
validator="$repo_root/scripts/validate-deployment-config.sh"
preflight="$repo_root/scripts/preflight-infrastructure-cutover.sh"
test_root=$(mktemp -d)
real_docker=$(command -v docker)

cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_fails() {
  local description=$1
  shift

  if "$@" >"$test_root/failure-output" 2>&1; then
    fail "$description unexpectedly succeeded"
  fi
}

assert_fails_containing() {
  local description=$1
  local expected=$2
  shift 2

  if "$@" >"$test_root/failure-output" 2>&1; then
    fail "$description unexpectedly succeeded"
  fi
  if ! grep -Fq -- "$expected" "$test_root/failure-output"; then
    sed 's/test-api-key/[REDACTED]/g' "$test_root/failure-output" >&2
    [[ ! -f ${dokploy_read_log:-} ]] ||
      sed 's/test-api-key/[REDACTED]/g' "$dokploy_read_log" >&2
    fail "$description did not report: $expected"
  fi
}

rewrite_file() {
  local file=$1
  local program=$2
  local rewritten="$file.rewritten"

  awk "$program" "$file" >"$rewritten"
  mv "$rewritten" "$file"
}

make_fixture() {
  local name=$1
  local fixture="$test_root/$name"

  mkdir -p "$fixture/api" "$fixture/frontend" "$fixture/worker"
  cp "$compose_file" "$fixture/docker-compose.infrastructure.yml"
  cp "$repo_root/api/Dockerfile" "$fixture/api/Dockerfile"
  cp "$repo_root/frontend/Dockerfile" "$fixture/frontend/Dockerfile"
  cp "$repo_root/worker/Dockerfile" "$fixture/worker/Dockerfile"

  printf '%s\n' "$fixture"
}

run_static_validator() {
  SYSTEMVITALS_POSTGRES_VOLUME=deployment-test-postgres \
    SYSTEMVITALS_REDIS_VOLUME=deployment-test-redis \
    POSTGRES_PASSWORD=deployment-test-password \
    "$validator" --skip-images
}

[[ -f "$compose_file" ]] || fail "$compose_file is missing"
[[ -x "$validator" ]] || fail "$validator is missing or not executable"
[[ -x "$preflight" ]] || fail "$preflight is missing or not executable"

synthetic_postgres_volume=deployment-test-postgres
synthetic_redis_volume=deployment-test-redis
synthetic_password=deployment-test-password
resolved_config="$test_root/resolved-config.json"

SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  docker compose --profile infrastructure-cutover -f "$compose_file" \
  config --format json >"$resolved_config"

jq -e '
  (.services | keys | sort) == ["postgres", "redis"] and
  (.services.postgres.profiles == ["infrastructure-cutover"]) and
  (.services.redis.profiles == ["infrastructure-cutover"]) and
  (.services.postgres.stop_grace_period == "1m0s") and
  (.services.redis.stop_grace_period == "1m0s") and
  (.volumes.sv_pgdata.external == true) and
  (.volumes.sv_pgdata.name == "deployment-test-postgres") and
  (.volumes.sv_redisdata.external == true) and
  (.volumes.sv_redisdata.name == "deployment-test-redis") and
  (.networks["systemvitals-internal"].external == true) and
  (.networks["systemvitals-internal"].name == "systemvitals-internal") and
  (.services.postgres.networks["systemvitals-internal"].aliases == ["sv-postgres"]) and
  (.services.redis.networks["systemvitals-internal"].aliases == ["sv-redis"]) and
  (.services.postgres.volumes == [{
    type: "volume",
    source: "sv_pgdata",
    target: "/var/lib/postgresql",
    volume: {}
  }]) and
  (.services.redis.volumes == [{
    type: "volume",
    source: "sv_redisdata",
    target: "/data",
    volume: {}
  }]) and
  (.services.postgres.environment.POSTGRES_USER == "systemvitals") and
  (.services.postgres.environment.POSTGRES_DB == "systemvitals") and
  (.services.postgres.environment.POSTGRES_PASSWORD == "deployment-test-password") and
  (.services.postgres.healthcheck.test | length > 0) and
  (.services.redis.healthcheck.test | length > 0) and
  ([.services[] | (.ports // []) | length] | all(. == 0))
' "$resolved_config" >/dev/null ||
  fail "resolved infrastructure Compose invariants are invalid"

default_services=$(SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  docker compose -f "$compose_file" config --services)
[[ -z $default_services ]] ||
  fail "normal Compose invocation must select no cutover services"
grep -Fq 'CUTOVER SAFETY: never run a normal ' "$compose_file" ||
  fail "Compose runbook comments do not refuse normal cutover up"
grep -Fq 'Profiles are a guardrail, not a hard safety boundary.' "$compose_file" ||
  fail "Compose comments incorrectly treat profiles as a hard boundary"

run_static_validator >/dev/null

assert_fails "image validation without built image references" \
  env -u SYSTEMVITALS_API_IMAGE \
  -u SYSTEMVITALS_WORKER_IMAGE \
  -u SYSTEMVITALS_FRONTEND_IMAGE \
  SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  "$validator"

assert_fails "empty POSTGRES_PASSWORD Compose interpolation" \
  env \
  SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD= \
  docker compose -f "$compose_file" config --quiet

assert_fails "unset POSTGRES_PASSWORD validation" \
  env -u POSTGRES_PASSWORD \
  SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  "$validator" --skip-images

assert_fails "empty external Postgres volume name" \
  env \
  SYSTEMVITALS_POSTGRES_VOLUME= \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  "$validator" --skip-images

extra_service_fixture=$(make_fixture extra-service)
rewrite_file "$extra_service_fixture/docker-compose.infrastructure.yml" '
  /^services:/ {
    print
    print "  unexpected:"
    print "    image: busybox"
    next
  }
  { print }
'
assert_fails "unexpected Compose service" \
  env \
  DEPLOYMENT_REPO_ROOT="$extra_service_fixture" \
  SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  "$validator" --skip-images

host_port_fixture=$(make_fixture host-port)
rewrite_file "$host_port_fixture/docker-compose.infrastructure.yml" '
  /^  redis:/ {
    print
    print "    ports:"
    print "      - \"6379:6379\""
    next
  }
  { print }
'
assert_fails "host port binding" \
  env \
  DEPLOYMENT_REPO_ROOT="$host_port_fixture" \
  SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  "$validator" --skip-images

alias_fixture=$(make_fixture alias)
rewrite_file "$alias_fixture/docker-compose.infrastructure.yml" '
  { gsub(/sv-postgres/, "not-sv-postgres"); print }
'
assert_fails "incorrect Postgres network alias" \
  env \
  DEPLOYMENT_REPO_ROOT="$alias_fixture" \
  SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  "$validator" --skip-images

mock_bin="$test_root/mock-bin"
mkdir -p "$mock_bin"
cat >"$mock_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

record_mutation() {
  printf '%s\n' "$*" >>"$DOCKER_MUTATION_LOG"
  exit 90
}

case "${1:-}" in
  compose)
    case " $* " in
      *" up "*|*" rm "*|*" down "*)
        record_mutation "$@"
        ;;
    esac
    exec "$REAL_DOCKER" "$@"
    ;;
  image)
    [[ ${2:-} == inspect ]] || exit 91
    case "${3:-}" in
      test-api)
        printf '%s\n' '[{"Config":{"Entrypoint":["/app/api/docker-entrypoint.sh"],"Cmd":["node","api/dist/main.js"],"Healthcheck":{"Test":["CMD-SHELL","node -e fetch(/health/ready)"],"Interval":10000000000,"Timeout":5000000000,"StartPeriod":1860000000000,"Retries":3}}}]'
        ;;
      test-worker)
        printf '%s\n' '[{"Config":{"Entrypoint":["/app/worker/docker-entrypoint.sh"],"Cmd":["node","/app/worker/dist/cli/worker.js"],"Healthcheck":{"Test":["CMD-SHELL","node -e WORKER_READINESS_PATH"],"Interval":10000000000,"Timeout":5000000000,"StartPeriod":1860000000000,"Retries":3}}}]'
        ;;
      test-frontend)
        printf '%s\n' '[{"Config":{"Entrypoint":["docker-entrypoint.sh"],"Cmd":["node","server.js"],"Healthcheck":{"Test":["CMD-SHELL","node -e fetch(/api/health)"],"Interval":10000000000,"Timeout":5000000000,"StartPeriod":60000000000,"Retries":3}}}]'
        ;;
      test-bad-api)
        printf '%s\n' '[{"Config":{"Entrypoint":["/wrong-entrypoint.sh"],"Cmd":["node","api/dist/main.js"],"Healthcheck":{"Test":["CMD-SHELL","node -e fetch(/health/ready)"],"Interval":10000000000,"Timeout":5000000000,"StartPeriod":1860000000000,"Retries":3}}}]'
        ;;
      test-bad-health-api)
        printf '%s\n' '[{"Config":{"Entrypoint":["/app/api/docker-entrypoint.sh"],"Cmd":["node","api/dist/main.js"],"Healthcheck":{"Test":["CMD-SHELL","node -e fetch(/health/ready)"],"Interval":1,"Timeout":5000000000,"StartPeriod":1860000000000,"Retries":3}}}]'
        ;;
      *)
        exit 92
        ;;
    esac
    ;;
  network)
    [[ ${2:-} == inspect ]] || record_mutation "$@"
    case "${FAKE_NETWORK_MODE:-valid}" in
      valid)
        printf '%s\n' '[{"Name":"systemvitals-internal","Id":"network-id","Driver":"overlay","Scope":"swarm","Attachable":true}]'
        ;;
      wrong-driver)
        printf '%s\n' '[{"Name":"systemvitals-internal","Id":"network-id","Driver":"bridge","Scope":"local","Attachable":false}]'
        ;;
      missing)
        exit 1
        ;;
    esac
    ;;
  ps)
    case " $* " in
      *"com.docker.compose.service=postgres"*)
        printf '%s\n' postgres-container-id
        ;;
      *"com.docker.compose.service=redis"*)
        printf '%s\n' redis-container-id
        ;;
      *)
        exit 93
        ;;
    esac
    ;;
  inspect)
    [[ ${2:-} == --format ]] || exit 94
    format=${3:-}
    container_id=${4:-}
    case "$format:$container_id" in
      '{{.State.Health.Status}}:postgres-container-id')
        printf '%s\n' "${FAKE_POSTGRES_HEALTH:-healthy}"
        ;;
      '{{.State.Health.Status}}:redis-container-id')
        printf '%s\n' healthy
        ;;
      '{{json .Mounts}}:postgres-container-id')
        printf '%s\n' '[{"Type":"volume","Name":"deployment-test-postgres","Source":"/var/lib/docker/volumes/deployment-test-postgres/_data","Destination":"/var/lib/postgresql","RW":true}]'
        ;;
      '{{json .Mounts}}:redis-container-id')
        printf '%s\n' '[{"Type":"volume","Name":"deployment-test-redis","Source":"/var/lib/docker/volumes/deployment-test-redis/_data","Destination":"/data","RW":true}]'
        ;;
      '{{json .NetworkSettings.Networks}}:postgres-container-id')
        case "${FAKE_CONTAINER_NETWORK_MODE:-valid}" in
          valid)
            printf '%s\n' '{"systemvitals-internal":{"NetworkID":"network-id","Aliases":["postgres-container-id","sv-postgres"]}}'
            ;;
          wrong-id)
            printf '%s\n' '{"systemvitals-internal":{"NetworkID":"wrong-network-id","Aliases":["postgres-container-id","sv-postgres"]}}'
            ;;
          wrong-alias)
            printf '%s\n' '{"systemvitals-internal":{"NetworkID":"network-id","Aliases":["postgres-container-id"]}}'
            ;;
        esac
        ;;
      '{{json .NetworkSettings.Networks}}:redis-container-id')
        printf '%s\n' '{"systemvitals-internal":{"NetworkID":"network-id","Aliases":["redis-container-id","sv-redis"]}}'
        ;;
      *)
        exit 95
        ;;
    esac
    ;;
  *)
    exit 96
    ;;
esac
EOF
cat >"$mock_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

url=
api_key_seen=false
previous=
output_file=
printf '%q ' "$@" >>"$DOKPLOY_CURL_ARGV_LOG"
printf '\n' >>"$DOKPLOY_CURL_ARGV_LOG"
for argument in "$@"; do
  if [[ $previous == --config ]]; then
    [[ -f $argument ]] || exit 86
    [[ $(stat -c '%a' "$argument") == 600 ]] || exit 87
    grep -Fq "x-api-key: $DOKPLOY_API_KEY" "$argument" && api_key_seen=true
  fi
  if [[ $previous == --output ]]; then
    output_file=$argument
  fi
  if [[ $argument == http://* || $argument == https://* ]]; then
    url=$argument
  fi
  if [[ $previous == -X || $previous == --request ]]; then
    if [[ $argument != GET ]]; then
      echo "mutation method is forbidden" >&2
      exit 80
    fi
  fi
  previous=$argument
done

"$api_key_seen" || {
  echo "missing API key header" >&2
  exit 81
}
[[ -n $url ]] || exit 82
printf '%s\n' "$url" >>"$DOKPLOY_READ_LOG"

mode=${FAKE_DOKPLOY_MODE:-valid}
case "$mode" in
  millisecond-timestamp)
    finished_at=$(jq -nr \
      '(now - 2) | strftime("%Y-%m-%dT%H:%M:%S") + ".123Z"')
    ;;
  timezone-timestamp)
    finished_at=$(jq -nr \
      '(now + (5 * 60 * 60) + (30 * 60)) |
       strftime("%Y-%m-%dT%H:%M:%S") + "+05:30"')
    ;;
  *)
    finished_at=$(jq -nr 'now | todateiso8601')
    ;;
esac
if [[ $mode == millisecond-timestamp ]] &&
  ! jq -ne --arg timestamp "$finished_at" '
    ($timestamp |
      capture(
        "^(?<base>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})" +
        "(?<fraction>\\.[0-9]+)Z$"
      )
    ) as $parts |
    (
      now -
      (
        (($parts.base + "Z") | fromdateiso8601) +
        ($parts.fraction | tonumber)
      )
    ) >= 1
  ' >/dev/null; then
  echo "millisecond fixture is not at least one second old" >&2
  exit 85
fi

mock_response=$(mktemp)
trap 'rm -f "$mock_response"' EXIT
case "$url" in
  */api/trpc/project.one?input=*)
    [[ $url == *'%22projectId%22%3A%22project-id%22'* ]] || {
      echo "incorrect tRPC project.one input" >&2
      exit 83
    }
    if [[ $mode == project-mismatch ]]; then
      project='{"projectId":"project-id","name":"SystemVitals","organizationId":"secret-org","environments":[{"environmentId":"environment-id","name":"production","applications":[{"applicationId":"application-id","name":"SystemVitals API","appName":"systemvitals-api","applicationStatus":"done","env":"NESTED_DISCOVERY_SECRET","stopGracePeriodSwarm":"60000000000"}],"compose":[]}]}'
    else
      project='{"projectId":"project-id","name":"SystemVitals","organizationId":"secret-org","environments":[{"environmentId":"environment-id","name":"production","applications":[{"applicationId":"application-id","name":"SystemVitals API","appName":"systemvitals-api","applicationStatus":"done","env":"NESTED_DISCOVERY_SECRET","stopGracePeriodSwarm":"60000000000"}],"compose":[{"composeId":"compose-id","name":"SystemVitals Stack","appName":"deployment-test-project","composeStatus":"done","env":"NESTED_COMPOSE_SECRET"}]}]}'
    fi
    jq -cn --argjson project "$project" '{
      result: {
        data: {
          json: $project,
          meta: {
            values: {
              "environments.0.applications.0.stopGracePeriodSwarm":
                ["bigint"]
            }
          }
        }
      }
    }'
    ;;
  */api/compose.one*)
    auto_deploy=false
    command=null
    compose_env=''
    environment_env=''
    project_env=''
    backup_destination=destination-id
    backup_prefix=/systemvitals/postgres
    include_backup=true
    case "$mode" in
      auto-deploy)
        auto_deploy=true
        ;;
      active-compose-profile)
        compose_env='COMPOSE_PROFILES=infrastructure-cutover'
        ;;
      active-project-profile)
        project_env='COMPOSE_PROFILES=infrastructure-cutover'
        ;;
      active-environment-profile)
        environment_env='COMPOSE_PROFILES=infrastructure-cutover'
        ;;
      custom-command)
        command='"docker compose up -d"'
        ;;
      no-backup)
        include_backup=false
        ;;
      live-mismatch)
        backup_destination=other-destination
        ;;
      empty-prefix)
        backup_prefix=
        ;;
      root-prefix)
        backup_prefix=/
        ;;
      unsafe-prefix)
        backup_prefix=/systemvitals/../postgres
        ;;
      broad-prefix)
        backup_prefix=/systemvitals
        ;;
      broad-normalized-prefix)
        backup_prefix=' /systemvitals/ '
        ;;
    esac
    if "$include_backup"; then
      backups=$(jq -n \
        --arg finished_at "$finished_at" \
        --arg destination "$backup_destination" \
        --arg prefix "$backup_prefix" \
        '[{
          backupId: "backup-id",
          enabled: true,
          backupType: "compose",
          databaseType: "postgres",
          composeId: "compose-id",
          serviceName: "postgres",
          database: "systemvitals",
          prefix: $prefix,
          destinationId: $destination,
          destination: {destinationId: $destination},
          deployments: [{
            backupId: "backup-id",
            status: "done",
            finishedAt: $finished_at
          }]
        }]')
    else
      backups='[]'
    fi
    jq -n \
      --argjson auto_deploy "$auto_deploy" \
      --argjson command "$command" \
      --arg compose_env "$compose_env" \
      --arg environment_env "$environment_env" \
      --arg project_env "$project_env" \
      --argjson backups "$backups" \
      '{
        composeId: "compose-id",
        appName: "deployment-test-project",
        autoDeploy: $auto_deploy,
        command: $command,
        env: $compose_env,
        serverId: null,
        environment: {
          env: $environment_env,
          project: {
            projectId: "project-id",
            env: $project_env
          }
        },
        backups: $backups
      }'
    ;;
  */api/backup.one*)
    destination=destination-id
    backup_prefix=/systemvitals/postgres
    if [[ $mode == live-mismatch ]]; then
      destination=other-destination
    fi
    case "$mode" in
      empty-prefix)
        backup_prefix=
        ;;
      root-prefix)
        backup_prefix=/
        ;;
      unsafe-prefix)
        backup_prefix=/systemvitals/../postgres
        ;;
      broad-prefix)
        backup_prefix=/systemvitals
        ;;
      broad-normalized-prefix)
        backup_prefix=' /systemvitals/ '
        ;;
    esac
    jq -n \
      --arg destination "$destination" \
      --arg prefix "$backup_prefix" \
      '{
      backupId: "backup-id",
      enabled: true,
      backupType: "compose",
      databaseType: "postgres",
      composeId: "compose-id",
      serviceName: "postgres",
      database: "systemvitals",
      prefix: $prefix,
      destinationId: $destination,
      destination: {destinationId: $destination}
    }'
    ;;
  */api/backup.listBackupFiles*)
    case "$url" in
      *"destinationId=destination-id&search=systemvitals%2Fpostgres%2F"*)
        ;;
      *)
        echo "incorrect backup file query" >&2
        exit 83
        ;;
    esac
    if [[ $mode == no-file ]]; then
      printf '%s\n' '[]'
    else
      case "$mode" in
        stale-file)
          file_name=2020-01-01T00:00:00.525Z.sql.gz
          ;;
        malformed-file-date)
          file_name=2026-02-30T03:00:00.525Z.sql.gz
          ;;
        offset-file-timestamp)
          file_name=$(jq -nr \
            'now | strftime("%Y-%m-%dT%H:%M:%S") + "+00:00.sql.gz"')
          ;;
        future-file)
          file_name=$(jq -nr \
            '(now + 300) | strftime("%Y-%m-%dT%H:%M:%S") + ".525Z.sql.gz"')
          ;;
        no-fraction-file)
          file_name=$(jq -nr \
            'now | strftime("%Y-%m-%dT%H:%M:%S") + "Z.sql.gz"')
          ;;
        *)
          file_name=$(jq -nr \
            '(now - 2) | strftime("%Y-%m-%dT%H:%M:%S") + ".525Z.sql.gz"')
          ;;
      esac
      file_path="systemvitals/postgres/$file_name"
      file_size=1024
      if [[ $mode == outside-prefix ]]; then
        file_path="systemvitals/postgresql/$file_name"
      elif [[ $mode == traversing-file ]]; then
        file_name="../$file_name"
        file_path="systemvitals/postgres/$file_name"
      elif [[ $mode == zero-size-file ]]; then
        file_size=0
      fi
      jq -n \
        --arg file_name "$file_name" \
        --arg file_path "$file_path" \
        --argjson file_size "$file_size" \
        '[{
        Path: $file_path,
        Name: $file_name,
        Size: $file_size,
        IsDir: false
      }]'
    fi
    ;;
  *)
    echo "unexpected Dokploy endpoint" >&2
    exit 84
    ;;
esac >"$mock_response"

if [[ -n $output_file ]]; then
  cp "$mock_response" "$output_file"
  printf '200'
else
  cat "$mock_response"
fi
EOF
chmod +x "$mock_bin/docker" "$mock_bin/curl"
mutation_log="$test_root/docker-mutations"
dokploy_read_log="$test_root/dokploy-reads"
dokploy_curl_argv_log="$test_root/dokploy-curl-argv"

SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  SYSTEMVITALS_API_IMAGE=test-api \
  SYSTEMVITALS_WORKER_IMAGE=test-worker \
  SYSTEMVITALS_FRONTEND_IMAGE=test-frontend \
  PATH="$mock_bin:$PATH" \
  REAL_DOCKER="$real_docker" \
  DOCKER_MUTATION_LOG="$mutation_log" \
  "$validator" >/dev/null

assert_fails "invalid built API image metadata" \
  env \
  SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  SYSTEMVITALS_API_IMAGE=test-bad-api \
  SYSTEMVITALS_WORKER_IMAGE=test-worker \
  SYSTEMVITALS_FRONTEND_IMAGE=test-frontend \
  PATH="$mock_bin:$PATH" \
  REAL_DOCKER="$real_docker" \
  DOCKER_MUTATION_LOG="$mutation_log" \
  "$validator"

assert_fails "invalid built API health timing metadata" \
  env \
  SYSTEMVITALS_POSTGRES_VOLUME="$synthetic_postgres_volume" \
  SYSTEMVITALS_REDIS_VOLUME="$synthetic_redis_volume" \
  POSTGRES_PASSWORD="$synthetic_password" \
  SYSTEMVITALS_API_IMAGE=test-bad-health-api \
  SYSTEMVITALS_WORKER_IMAGE=test-worker \
  SYSTEMVITALS_FRONTEND_IMAGE=test-frontend \
  PATH="$mock_bin:$PATH" \
  REAL_DOCKER="$real_docker" \
  DOCKER_MUTATION_LOG="$mutation_log" \
  "$validator"

common_preflight_env=(
  "PATH=$mock_bin:$PATH"
  "REAL_DOCKER=$real_docker"
  "DOCKER_MUTATION_LOG=$mutation_log"
  "DOKPLOY_READ_LOG=$dokploy_read_log"
  "DOKPLOY_CURL_ARGV_LOG=$dokploy_curl_argv_log"
  "SYSTEMVITALS_COMPOSE_PROJECT=deployment-test-project"
  "SYSTEMVITALS_POSTGRES_VOLUME=$synthetic_postgres_volume"
  "SYSTEMVITALS_REDIS_VOLUME=$synthetic_redis_volume"
  "POSTGRES_PASSWORD=$synthetic_password"
  "POSTGRES_DB=systemvitals"
  "SYSTEMVITALS_API_IMAGE=test-api"
  "SYSTEMVITALS_WORKER_IMAGE=test-worker"
  "SYSTEMVITALS_FRONTEND_IMAGE=test-frontend"
  "SYSTEMVITALS_DOKPLOY_PROJECT_ID=project-id"
  "SYSTEMVITALS_DOKPLOY_COMPOSE_ID=compose-id"
  "SYSTEMVITALS_BACKUP_ID=backup-id"
  "SYSTEMVITALS_BACKUP_DESTINATION_ID=destination-id"
)
preflight_env=(
  "${common_preflight_env[@]}"
  "DOKPLOY_URL=https://dokploy.test"
  "DOKPLOY_API_KEY=test-api-key"
)

assert_fails_containing "missing Dokploy credentials" \
  "BLOCKED: DOKPLOY_URL must be set and nonempty" \
  env "${common_preflight_env[@]}" "$preflight"

assert_fails_containing "unencrypted remote Dokploy URL" \
  "DOKPLOY_URL must use HTTPS" \
  env "${common_preflight_env[@]}" \
  DOKPLOY_URL=http://dokploy.test \
  DOKPLOY_API_KEY=test-api-key \
  "$preflight"

assert_fails_containing "test HTTP opt-in cannot enable a remote Dokploy URL" \
  "DOKPLOY_URL must use HTTPS" \
  env "${common_preflight_env[@]}" \
  DOKPLOY_URL=http://dokploy.test \
  DOKPLOY_API_KEY=test-api-key \
  DOKPLOY_ALLOW_INSECURE_LOCALHOST_FOR_TESTS=1 \
  "$preflight"

assert_fails_containing "unencrypted loopback Dokploy URL without test opt-in" \
  "DOKPLOY_URL must use HTTPS" \
  env "${common_preflight_env[@]}" \
  DOKPLOY_URL=http://127.0.0.1:3000 \
  DOKPLOY_API_KEY=test-api-key \
  "$preflight"

assert_fails_containing "compose missing from exact project" \
  "BLOCKED: Dokploy project does not contain the exact Compose object" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=project-mismatch \
  "$preflight"

assert_fails_containing "live Compose auto-deploy enabled" \
  "BLOCKED: live Dokploy Compose auto-deploy must be disabled" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=auto-deploy \
  "$preflight"

assert_fails_containing "Compose-level profile activation" \
  "BLOCKED: live Dokploy environment must not define COMPOSE_PROFILES" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=active-compose-profile \
  "$preflight"

assert_fails_containing "project-level profile activation" \
  "BLOCKED: live Dokploy environment must not define COMPOSE_PROFILES" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=active-project-profile \
  "$preflight"

assert_fails_containing "environment-level profile activation" \
  "BLOCKED: live Dokploy environment must not define COMPOSE_PROFILES" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=active-environment-profile \
  "$preflight"

assert_fails_containing "custom Compose command" \
  "BLOCKED: live Dokploy Compose custom command must be empty" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=custom-command \
  "$preflight"

assert_fails_containing "missing authenticated backup configuration" \
  "BLOCKED: no exact enabled Dokploy Compose backup is configured" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=no-backup \
  "$preflight"

assert_fails_containing "missing real backup object" \
  "BLOCKED: no recent nonempty backup object exists in the configured destination" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=no-file \
  "$preflight"

assert_fails_containing "backup object outside configured prefix" \
  "BLOCKED: no recent nonempty backup object exists in the configured destination" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=outside-prefix \
  "$preflight"

assert_fails_containing "old backup object" \
  "BLOCKED: no recent nonempty backup object exists in the configured destination" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=stale-file \
  "$preflight"

assert_fails_containing "malformed backup object date" \
  "BLOCKED: no recent nonempty backup object exists in the configured destination" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=malformed-file-date \
  "$preflight"

assert_fails_containing "offset backup object timestamp" \
  "BLOCKED: no recent nonempty backup object exists in the configured destination" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=offset-file-timestamp \
  "$preflight"

assert_fails_containing "future backup object timestamp" \
  "BLOCKED: no recent nonempty backup object exists in the configured destination" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=future-file \
  "$preflight"

assert_fails_containing "traversing backup object name" \
  "BLOCKED: no recent nonempty backup object exists in the configured destination" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=traversing-file \
  "$preflight"

assert_fails_containing "zero-size backup object" \
  "BLOCKED: no recent nonempty backup object exists in the configured destination" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=zero-size-file \
  "$preflight"

env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=no-fraction-file \
  "$preflight" >/dev/null ||
  fail "recent Dokploy UTC filename without fractional seconds was rejected"

assert_fails_containing "empty backup prefix" \
  "BLOCKED: configured Dokploy backup prefix is empty or unsafe" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=empty-prefix \
  "$preflight"

assert_fails_containing "root backup prefix" \
  "BLOCKED: configured Dokploy backup prefix is empty or unsafe" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=root-prefix \
  "$preflight"

assert_fails_containing "traversing backup prefix" \
  "BLOCKED: configured Dokploy backup prefix is empty or unsafe" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=unsafe-prefix \
  "$preflight"

assert_fails_containing "single-segment backup prefix" \
  "BLOCKED: configured Dokploy backup prefix is empty or unsafe" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=broad-prefix \
  "$preflight"

assert_fails_containing "single-segment backup prefix after normalization" \
  "BLOCKED: configured Dokploy backup prefix is empty or unsafe" \
  env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=broad-normalized-prefix \
  "$preflight"

env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=millisecond-timestamp \
  "$preflight" >/dev/null ||
  fail "recent Dokploy timestamp with milliseconds was rejected"

env "${preflight_env[@]}" \
  FAKE_DOKPLOY_MODE=timezone-timestamp \
  "$preflight" >/dev/null ||
  fail "recent Dokploy timestamp with a timezone offset was rejected"

fabricated_receipt="$test_root/fabricated-receipt.json"
printf '%s\n' '{"status":"success","backupId":"backup-id"}' >"$fabricated_receipt"
assert_fails_containing "fabricated receipt with live mismatch" \
  "BLOCKED: no exact enabled Dokploy Compose backup is configured" \
  env "${preflight_env[@]}" \
  SYSTEMVITALS_BACKUP_RECEIPT="$fabricated_receipt" \
  FAKE_DOKPLOY_MODE=live-mismatch \
  "$preflight"

assert_fails_containing "invalid runtime network properties" \
  "BLOCKED: systemvitals-internal must be an attachable swarm overlay network" \
  env "${preflight_env[@]}" \
  FAKE_NETWORK_MODE=wrong-driver \
  "$preflight"

assert_fails_containing "unhealthy stateful container" \
  "BLOCKED: postgres container is not healthy" \
  env "${preflight_env[@]}" \
  FAKE_POSTGRES_HEALTH=unhealthy \
  "$preflight"

assert_fails_containing "live mutation request" \
  "read-only" \
  env "${preflight_env[@]}" "$preflight" --apply

contract_output="$test_root/cutover-contract"
env "${preflight_env[@]}" "$preflight" >"$contract_output"

if grep -Fq 'test-api-key' "$dokploy_curl_argv_log"; then
  fail "Dokploy API key leaked through curl process arguments"
fi

env "${common_preflight_env[@]}" \
  DOKPLOY_URL=http://127.0.0.1:3000 \
  DOKPLOY_API_KEY=test-api-key \
  DOKPLOY_ALLOW_INSECURE_LOCALHOST_FOR_TESTS=1 \
  "$preflight" >/dev/null ||
  fail "explicit loopback-only HTTP test opt-in was rejected"

grep -Fq \
  'docker network connect --alias sv-postgres systemvitals-internal postgres-container-id' \
  "$contract_output" ||
  fail "cutover contract is missing the Postgres network attachment"
grep -Fq \
  'docker network connect --alias sv-redis systemvitals-internal redis-container-id' \
  "$contract_output" ||
  fail "cutover contract is missing the Redis network attachment"
grep -Fq \
  "docker compose --project-name deployment-test-project -f $compose_file --profile infrastructure-cutover up -d --no-recreate postgres redis" \
  "$contract_output" ||
  fail "cutover contract is missing the no-recreate infrastructure command"
grep -Fq \
  'VERIFY unchanged: postgres-container-id deployment-test-postgres redis-container-id deployment-test-redis' \
  "$contract_output" ||
  fail "cutover contract is missing unchanged ID and mount verification"
grep -Fq \
  "SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID=postgres-container-id SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID=redis-container-id $preflight --verify-unchanged" \
  "$contract_output" ||
  fail "cutover contract is missing executable unchanged-state verification"
grep -Fq 'Infrastructure auto-deploy is verified disabled and must remain disabled.' \
  "$contract_output" ||
  fail "cutover contract does not keep infrastructure auto-deploy disabled"
if grep -Eq '(^|[[:space:]])(rm|stop)[[:space:]]|migrate|docker-compose\\.dokploy' \
  "$contract_output"; then
  fail "Task 6 emitted a legacy stateless removal command"
fi
if grep -Fq 'docker network create' "$contract_output"; then
  fail "Task 6 emitted a network creation command"
fi
if [[ -s "$mutation_log" ]]; then
  fail "read-only validation attempted a Docker mutation"
fi
for endpoint in trpc/project.one compose.one backup.one backup.listBackupFiles; do
  grep -Fq "$endpoint" "$dokploy_read_log" ||
    fail "preflight did not query authenticated Dokploy $endpoint"
done
if grep -Fq 'test-api-key' "$dokploy_read_log"; then
  fail "Dokploy API key leaked into the read log"
fi
if grep -Fq 'NESTED_DISCOVERY_SECRET' "$dokploy_curl_argv_log" ||
  grep -Fq 'NESTED_COMPOSE_SECRET' "$dokploy_curl_argv_log"; then
  fail "nested project discovery secrets leaked into curl arguments"
fi

verification_output="$test_root/finalization-verification"
env "${preflight_env[@]}" \
  SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID=postgres-container-id \
  SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID=redis-container-id \
  "$preflight" --verify-unchanged >"$verification_output"
grep -Fq 'FINALIZATION VERIFIED: container, volume, network, and alias identities are unchanged.' \
  "$verification_output" ||
  fail "finalization verification did not confirm unchanged state"

assert_fails_containing "changed Postgres container ID" \
  "BLOCKED: postgres container ID changed during finalization" \
  env "${preflight_env[@]}" \
  SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID=old-postgres-container-id \
  SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID=redis-container-id \
  "$preflight" --verify-unchanged

assert_fails_containing "wrong Postgres internal network ID" \
  "BLOCKED: postgres is not attached to the expected internal network and alias" \
  env "${preflight_env[@]}" \
  SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID=postgres-container-id \
  SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID=redis-container-id \
  FAKE_CONTAINER_NETWORK_MODE=wrong-id \
  "$preflight" --verify-unchanged

assert_fails_containing "missing Postgres internal alias" \
  "BLOCKED: postgres is not attached to the expected internal network and alias" \
  env "${preflight_env[@]}" \
  SYSTEMVITALS_EXPECTED_POSTGRES_CONTAINER_ID=postgres-container-id \
  SYSTEMVITALS_EXPECTED_REDIS_CONTAINER_ID=redis-container-id \
  FAKE_CONTAINER_NETWORK_MODE=wrong-alias \
  "$preflight" --verify-unchanged

postgres_connect_line=$(grep -nF 'docker network connect --alias sv-postgres' \
  "$contract_output" | cut -d: -f1)
redis_connect_line=$(grep -nF 'docker network connect --alias sv-redis' \
  "$contract_output" | cut -d: -f1)
compose_line=$(grep -nF ' --no-recreate postgres redis' \
  "$contract_output" | cut -d: -f1)
verify_line=$(grep -nF 'VERIFY unchanged:' "$contract_output" | cut -d: -f1)

((postgres_connect_line < redis_connect_line)) ||
  fail "Postgres must be attached before Redis in the cutover contract"
((redis_connect_line < compose_line)) ||
  fail "network attachment must precede Compose finalization"
((compose_line < verify_line)) ||
  fail "unchanged IDs and mounts must be verified after no-recreate"

echo "Deployment configuration tests passed."
