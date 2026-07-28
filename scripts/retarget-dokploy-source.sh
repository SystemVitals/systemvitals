#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091 # Resolved from the repository root at runtime.
source "$repo_root/scripts/dokploy-api.sh"

project_name=SystemVitals
environment_name=production
compose_name="SystemVitals Infrastructure"
application_names=(
  "SystemVitals API"
  "SystemVitals Worker"
  "SystemVitals Frontend"
)

block() {
  printf 'BLOCKED: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/retarget-dokploy-source.sh plan
  scripts/retarget-dokploy-source.sh apply --confirm retarget-systemvitals-source
  scripts/retarget-dokploy-source.sh verify
  scripts/retarget-dokploy-source.sh enable-auto-deploy --confirm enable-systemvitals-auto-deploy
  scripts/retarget-dokploy-source.sh rollback --receipt ABSOLUTE_PATH --confirm rollback-systemvitals-source

All operations inspect or mutate source-control settings only. They never read
or write application environment values, build arguments, or build secrets.
EOF
}

mode=${1:-}
confirm=
receipt_path=
[[ -n $mode ]] || block "mode is required"
shift

case "$mode" in
  plan | apply | verify | enable-auto-deploy | rollback)
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
      (($# >= 2)) || block "--confirm requires a value"
      confirm=$2
      shift 2
      ;;
    --receipt)
      (($# >= 2)) || block "--receipt requires a path"
      receipt_path=$2
      shift 2
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
  apply)
    [[ $confirm == retarget-systemvitals-source ]] ||
      block "apply requires exact confirmation: --confirm retarget-systemvitals-source"
    [[ -z $receipt_path ]] || block "apply does not accept --receipt"
    ;;
  enable-auto-deploy)
    [[ $confirm == enable-systemvitals-auto-deploy ]] ||
      block "enable-auto-deploy requires exact confirmation: --confirm enable-systemvitals-auto-deploy"
    [[ -z $receipt_path ]] ||
      block "enable-auto-deploy does not accept --receipt"
    ;;
  rollback)
    [[ $confirm == rollback-systemvitals-source ]] ||
      block "rollback requires exact confirmation: --confirm rollback-systemvitals-source"
    [[ -n $receipt_path ]] || block "rollback requires --receipt ABSOLUTE_PATH"
    ;;
  plan | verify)
    [[ -z $confirm && -z $receipt_path ]] ||
      block "$mode does not accept --confirm or --receipt"
    ;;
esac

require_variable() {
  local name=$1
  [[ -n ${!name:-} ]] || block "$name must be set and nonempty"
}

for variable in \
  DOKPLOY_URL \
  DOKPLOY_API_KEY \
  SYSTEMVITALS_GITHUB_OWNER \
  SYSTEMVITALS_GITHUB_REPOSITORY \
  SYSTEMVITALS_GITHUB_BRANCH \
  SYSTEMVITALS_DOKPLOY_GITHUB_ID \
  SYSTEMVITALS_CUTOVER_RECEIPT_DIR; do
  require_variable "$variable"
done

github_owner=$SYSTEMVITALS_GITHUB_OWNER
github_repository=$SYSTEMVITALS_GITHUB_REPOSITORY
github_branch=$SYSTEMVITALS_GITHUB_BRANCH
github_id=$SYSTEMVITALS_DOKPLOY_GITHUB_ID

[[ $github_owner =~ ^[A-Za-z0-9._-]+$ ]] ||
  block "SYSTEMVITALS_GITHUB_OWNER contains unsupported characters"
[[ $github_repository =~ ^[A-Za-z0-9._-]+$ ]] ||
  block "SYSTEMVITALS_GITHUB_REPOSITORY contains unsupported characters"
[[ $github_branch =~ ^[A-Za-z0-9._/-]+$ ]] ||
  block "SYSTEMVITALS_GITHUB_BRANCH contains unsupported characters"
[[ $github_id =~ ^[A-Za-z0-9._-]+$ ]] ||
  block "SYSTEMVITALS_DOKPLOY_GITHUB_ID contains unsupported characters"

project_json=
environment_json=
compose_json=
compose_id=
declare -A application_ids=()
declare -A applications=()

expect_one_named() {
  local collection=$1
  local name=$2
  local description=$3
  local count

  count=$(jq -r --arg name "$name" \
    '[.[]? | select(.name == $name)] | length' <<<"$collection")
  [[ $count == 1 ]] ||
    block "expected exactly one $description named '$name'; found $count"
  jq -c --arg name "$name" '.[] | select(.name == $name)' <<<"$collection"
}

get_application() {
  local application_id=$1
  local input

  [[ $application_id =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "resolved application ID contains unsupported characters"
  input=$(jq -cn --arg application_id "$application_id" \
    '{applicationId:$application_id}')
  dokploy_trpc_get "application.one" "$input" |
    jq -cS '{
      applicationId,
      name,
      environmentId,
      sourceType,
      githubId,
      owner,
      repository,
      branch,
      buildPath,
      triggerType,
      enableSubmodules,
      watchPaths,
      autoDeploy
    }'
}

get_compose() {
  local requested_compose_id=$1

  [[ $requested_compose_id =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "resolved Compose ID contains unsupported characters"
  dokploy_get "/api/compose.one?composeId=$requested_compose_id" |
    jq -cS '{
      composeId,
      name,
      environmentId,
      sourceType,
      githubId,
      owner,
      repository,
      branch,
      composePath,
      autoDeploy
    }'
}

discover() {
  local projects
  local environments
  local compose_summaries
  local application_summaries
  local name
  local summary
  local application_id

  projects=$(dokploy_get "/api/project.all")
  project_json=$(expect_one_named "$projects" "$project_name" "project")
  environments=$(jq -c '.environments // []' <<<"$project_json")
  environment_json=$(expect_one_named \
    "$environments" "$environment_name" "environment")

  compose_summaries=$(jq -c '.compose // []' <<<"$environment_json")
  summary=$(expect_one_named "$compose_summaries" "$compose_name" "Compose")
  compose_id=$(jq -r '.composeId // empty' <<<"$summary")
  [[ $compose_id =~ ^[A-Za-z0-9._-]+$ ]] ||
    block "resolved Compose ID contains unsupported characters"
  compose_json=$(get_compose "$compose_id")
  jq -e \
    --arg compose_id "$compose_id" \
    --arg name "$compose_name" \
    --arg environment_id "$(jq -r '.environmentId' <<<"$environment_json")" '
      .composeId == $compose_id and
      .name == $name and
      .environmentId == $environment_id
    ' <<<"$compose_json" >/dev/null ||
    block "Compose detail did not read back with its exact identity"

  application_summaries=$(jq -c '.applications // []' <<<"$environment_json")
  for name in "${application_names[@]}"; do
    summary=$(expect_one_named "$application_summaries" "$name" "application")
    application_id=$(jq -r '.applicationId // empty' <<<"$summary")
    [[ $application_id =~ ^[A-Za-z0-9._-]+$ ]] ||
      block "resolved application ID contains unsupported characters"
    application_ids["$name"]=$application_id
    applications["$name"]=$(get_application "$application_id")
    jq -e \
      --arg application_id "$application_id" \
      --arg name "$name" \
      --arg environment_id "$(jq -r '.environmentId' <<<"$environment_json")" '
        .applicationId == $application_id and
        .name == $name and
        .environmentId == $environment_id
      ' <<<"${applications[$name]}" >/dev/null ||
      block "application '$name' detail did not read back with its exact identity"
  done
}

safe_application_source() {
  jq -cS '{
    applicationId,
    name,
    sourceType,
    githubId,
    owner,
    repository,
    branch,
    buildPath,
    triggerType,
    enableSubmodules,
    watchPaths,
    autoDeploy
  }'
}

safe_compose_source() {
  jq -cS '{
    composeId,
    name,
    sourceType,
    githubId,
    owner,
    repository,
    branch,
    composePath,
    autoDeploy
  }'
}

target_application_source() {
  local application=$1

  jq -cS \
    --arg github_id "$github_id" \
    --arg owner "$github_owner" \
    --arg repository "$github_repository" \
    --arg branch "$github_branch" '
      {
        applicationId,
        name,
        sourceType: "github",
        githubId: $github_id,
        owner: $owner,
        repository: $repository,
        branch: $branch,
        buildPath,
        triggerType,
        enableSubmodules,
        watchPaths,
        autoDeploy
      }
    ' <<<"$application"
}

target_compose_source() {
  local compose=$1

  jq -cS \
    --arg github_id "$github_id" \
    --arg owner "$github_owner" \
    --arg repository "$github_repository" \
    --arg branch "$github_branch" '
      {
        composeId,
        name,
        sourceType: "github",
        githubId: $github_id,
        owner: $owner,
        repository: $repository,
        branch: $branch,
        composePath,
        autoDeploy: false
      }
    ' <<<"$compose"
}

assert_application_source() {
  local application=$1
  local expected=$2
  local description=$3
  local actual

  actual=$(printf '%s' "$application" | safe_application_source)
  [[ $actual == "$expected" ]] ||
    block "$description did not read back exactly"
}

assert_compose_source() {
  local compose=$1
  local expected=$2
  local description=$3
  local actual

  actual=$(printf '%s' "$compose" | safe_compose_source)
  [[ $actual == "$expected" ]] ||
    block "$description did not read back exactly"
}

verify_target_provider() {
  local providers
  local repositories
  local provider_count
  local repository_count

  providers=$(dokploy_get "/api/gitProvider.getAll")
  provider_count=$(jq -r --arg github_id "$github_id" '
    [
      .[]? |
      select(
        .providerType == "github" and
        .github.githubId == $github_id
      )
    ] |
    length
  ' <<<"$providers")
  [[ $provider_count == 1 ]] ||
    block "expected exactly one target GitHub provider; found $provider_count"

  repositories=$(dokploy_get \
    "/api/github.getGithubRepositories?githubId=$github_id")
  repository_count=$(jq -r \
    --arg full_name "$github_owner/$github_repository" '
      [
        .[]? |
        select(
          .fullName == $full_name or
          .full_name == $full_name or
          .nameWithOwner == $full_name
        )
      ] |
      length
    ' <<<"$repositories")
  [[ $repository_count == 1 ]] ||
    block "target GitHub provider cannot list the requested repository"
}

test_target_connection() {
  local payload
  local response

  payload=$(jq -cn --arg github_id "$github_id" '{githubId:$github_id}')
  response=$(dokploy_post "/api/github.testConnection" "$payload")
  jq -e 'type == "string" and length > 0' <<<"$response" >/dev/null ||
    block "target GitHub provider connection test failed"
}

require_compose_auto_deploy_disabled() {
  [[ $(jq -r '.autoDeploy' <<<"$compose_json") == false ]] ||
    block "Compose auto-deploy must be disabled before source retarget"
}

receipt_directory() {
  local receipt_dir=$SYSTEMVITALS_CUTOVER_RECEIPT_DIR
  local normalized

  [[ $receipt_dir == /* ]] ||
    block "SYSTEMVITALS_CUTOVER_RECEIPT_DIR must be an absolute path"
  normalized=$(realpath -m "$receipt_dir")
  mkdir -p "$normalized"
  chmod 0700 "$normalized"
  if git -C "$normalized" rev-parse --show-toplevel >/dev/null 2>&1; then
    block "cutover receipts must be stored outside Git repositories"
  fi
  printf '%s' "$normalized"
}

receipt_snapshot() {
  local applications_json
  local name

  applications_json=$(
    for name in "${application_names[@]}"; do
      printf '%s' "${applications[$name]}" | safe_application_source
    done | jq -sc .
  )
  jq -n \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson applications "$applications_json" \
    --argjson compose "$(printf '%s' "$compose_json" | safe_compose_source)" '{
      schemaVersion: 1,
      operation: "retarget-systemvitals-source",
      createdAt: $created_at,
      applications: $applications,
      compose: $compose
    }'
}

validate_current_receipt_snapshot() {
  local directory
  local temporary
  local normalized

  directory=$(receipt_directory)
  temporary=$(mktemp "$directory/.retarget-validation.XXXXXXXX")
  chmod 0600 "$temporary"
  if ! receipt_snapshot >"$temporary"; then
    rm -f -- "$temporary"
    block "current source snapshot could not be generated"
  fi
  if ! normalized=$(validate_receipt "$temporary" 2>/dev/null); then
    rm -f -- "$temporary"
    block "current source snapshot is not rollback-valid"
  fi
  rm -f -- "$temporary"
  [[ -n $normalized ]] ||
    block "current source snapshot is not rollback-valid"
  printf '%s' "$normalized"
}

write_receipt() {
  local snapshot=$1
  local directory
  local temporary
  local receipt
  local normalized

  directory=$(receipt_directory)
  receipt="$directory/retarget-source-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  temporary=$(mktemp "$directory/.retarget-source.XXXXXXXX")
  chmod 0600 "$temporary"
  if ! printf '%s\n' "$snapshot" >"$temporary"; then
    rm -f -- "$temporary"
    block "generated rollback receipt could not be written"
  fi
  if ! normalized=$(validate_receipt "$temporary" 2>/dev/null); then
    rm -f -- "$temporary"
    block "generated rollback receipt is invalid"
  fi
  printf '%s\n' "$normalized" >"$temporary"
  mv "$temporary" "$receipt"
  chmod 0600 "$receipt"
  printf '%s' "$receipt"
}

validate_receipt() {
  local path=$1
  local normalized
  local normalized_json
  local owner

  [[ $path == /* ]] || block "rollback receipt path must be absolute"
  normalized=$(realpath -e "$path" 2>/dev/null) ||
    block "rollback receipt does not exist"
  [[ -f $normalized && ! -L $path ]] ||
    block "rollback receipt must be a regular non-symlink file"
  [[ $(stat -c '%a' "$normalized") == 600 ]] ||
    block "rollback receipt must be mode 0600"
  owner=$(stat -c '%u' "$normalized")
  [[ $owner == "$(id -u)" ]] ||
    block "rollback receipt must be owned by the current user"
  if git -C "$(dirname "$normalized")" rev-parse --show-toplevel \
    >/dev/null 2>&1; then
    block "rollback receipts must be stored outside Git repositories"
  fi
  normalized_json=$(jq -ceS '
    def exact_keys($expected):
      (keys | sort) == ($expected | sort);
    def nonempty_string:
      type == "string" and length > 0;
    def safe_id:
      nonempty_string and test("^[A-Za-z0-9._-]+$");
    def safe_owner_or_repository:
      nonempty_string and test("^[A-Za-z0-9._-]+$");
    def safe_branch:
      nonempty_string and test("^[A-Za-z0-9._/-]+$");
    def valid_watch_paths:
      . == null or
      (
        type == "array" and
        all(.[]; type == "string" and length > 0)
      );
    def valid_application:
      exact_keys([
        "applicationId",
        "name",
        "sourceType",
        "githubId",
        "owner",
        "repository",
        "branch",
        "buildPath",
        "triggerType",
        "enableSubmodules",
        "watchPaths",
        "autoDeploy"
      ]) and
      (.applicationId | safe_id) and
      (.name | nonempty_string) and
      .sourceType == "github" and
      (.githubId | safe_id) and
      (.owner | safe_owner_or_repository) and
      (.repository | safe_owner_or_repository) and
      (.branch | safe_branch) and
      (
        .buildPath |
        . == null or
        (nonempty_string and test("^/[A-Za-z0-9._/-]*$"))
      ) and
      (.triggerType == "push" or .triggerType == "tag") and
      (.enableSubmodules | type == "boolean") and
      (.watchPaths | valid_watch_paths) and
      (.autoDeploy | type == "boolean");
    def valid_compose:
      exact_keys([
        "composeId",
        "name",
        "sourceType",
        "githubId",
        "owner",
        "repository",
        "branch",
        "composePath",
        "autoDeploy"
      ]) and
      (.composeId | safe_id) and
      .name == "SystemVitals Infrastructure" and
      .sourceType == "github" and
      (.githubId | safe_id) and
      (.owner | safe_owner_or_repository) and
      (.repository | safe_owner_or_repository) and
      (.branch | safe_branch) and
      (
        .composePath |
        nonempty_string and test("^\\./[A-Za-z0-9._/-]+$")
      ) and
      (.autoDeploy | type == "boolean");
    if
      exact_keys([
        "schemaVersion",
        "operation",
        "createdAt",
        "applications",
        "compose"
      ]) and
      .schemaVersion == 1 and
      .operation == "retarget-systemvitals-source" and
      (
        .createdAt |
        nonempty_string and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
      ) and
      (.applications | type == "array" and length == 3) and
      all(.applications[]; valid_application) and
      (
        [.applications[].name] | sort
      ) == [
        "SystemVitals API",
        "SystemVitals Frontend",
        "SystemVitals Worker"
      ] and
      (
        [.applications[].applicationId, .compose.composeId] |
        unique |
        length
      ) == 4 and
      (.compose | type == "object" and valid_compose)
    then
      {
        schemaVersion,
        operation,
        createdAt,
        applications: (
          [
            .applications[] |
            {
              applicationId,
              name,
              sourceType,
              githubId,
              owner,
              repository,
              branch,
              buildPath,
              triggerType,
              enableSubmodules,
              watchPaths,
              autoDeploy
            }
          ] |
          sort_by(.name)
        ),
        compose: (
          .compose |
          {
            composeId,
            name,
            sourceType,
            githubId,
            owner,
            repository,
            branch,
            composePath,
            autoDeploy
          }
        )
      }
    else
      error("invalid receipt")
    end
  ' "$normalized" 2>/dev/null) ||
    block "rollback receipt is invalid"
  printf '%s' "$normalized_json"
}

application_provider_payload() {
  local source=$1

  jq -cS '{
    applicationId,
    githubId,
    owner,
    repository,
    branch,
    buildPath,
    triggerType,
    enableSubmodules,
    watchPaths
  }' <<<"$source"
}

disable_application_preserving_source() {
  local name=$1
  local current=${applications[$name]}
  local expected
  local payload

  expected=$(printf '%s' "$current" | safe_application_source |
    jq -cS '.autoDeploy = false')
  if [[ $(jq -r '.autoDeploy' <<<"$current") != false ]]; then
    payload=$(jq -cn --arg application_id "${application_ids[$name]}" '{
      applicationId: $application_id,
      autoDeploy: false
    }')
    dokploy_post "/api/application.update" "$payload" >/dev/null
    current=$(get_application "${application_ids[$name]}")
  fi
  assert_application_source "$current" "$expected" \
    "application '$name' auto-deploy update"
  applications["$name"]=$current
}

save_application_source() {
  local name=$1
  local expected=$2
  local payload
  local current

  payload=$(application_provider_payload "$expected")
  dokploy_post "/api/application.saveGithubProvider" "$payload" >/dev/null
  current=$(get_application "${application_ids[$name]}")
  assert_application_source "$current" "$expected" "application '$name' source"
  applications["$name"]=$current
}

save_compose_source() {
  local expected=$1
  local payload

  payload=$(jq -cS '{
    composeId,
    sourceType,
    githubId,
    owner,
    repository,
    branch,
    composePath,
    autoDeploy
  }' <<<"$expected")
  dokploy_post "/api/compose.update" "$payload" >/dev/null
  compose_json=$(get_compose "$compose_id")
  assert_compose_source "$compose_json" "$expected" "Compose source"
}

safe_plan() {
  local applications_json
  local name

  applications_json=$(
    for name in "${application_names[@]}"; do
      printf '%s' "${applications[$name]}" |
        safe_application_source |
        jq -c '{applicationId,name,owner,repository,branch,githubId,autoDeploy}'
    done | jq -sc .
  )
  jq -n \
    --arg owner "$github_owner" \
    --arg repository "$github_repository" \
    --arg branch "$github_branch" \
    --arg github_id "$github_id" \
    --argjson applications "$applications_json" \
    --argjson compose "$(printf '%s' "$compose_json" |
      safe_compose_source |
      jq -c '{composeId,name,owner,repository,branch,githubId,composePath,autoDeploy}')" '{
      operation: "retarget-systemvitals-source",
      target: {
        owner: $owner,
        repository: $repository,
        branch: $branch,
        githubId: $github_id
      },
      applications: $applications,
      compose: $compose
    }'
}

apply_retarget() {
  local receipt
  local rollback_snapshot
  local name
  local expected

  require_compose_auto_deploy_disabled
  verify_target_provider
  rollback_snapshot=$(validate_current_receipt_snapshot)
  test_target_connection
  receipt=$(write_receipt "$rollback_snapshot")

  for name in "${application_names[@]}"; do
    disable_application_preserving_source "$name"
  done
  for name in "${application_names[@]}"; do
    expected=$(target_application_source "${applications[$name]}" |
      jq -cS '.autoDeploy = false')
    save_application_source "$name" "$expected"
  done
  expected=$(target_compose_source "$compose_json")
  save_compose_source "$expected"

  jq -n --arg receipt "$receipt" '{
    operation: "retarget-systemvitals-source",
    status: "applied",
    receipt: $receipt,
    applicationCount: 3,
    composeCount: 1,
    autoDeploy: false
  }'
}

verify_retarget() {
  local name
  local expected
  local current

  verify_target_provider
  for name in "${application_names[@]}"; do
    current=${applications[$name]}
    expected=$(target_application_source "$current")
    assert_application_source "$current" "$expected" \
      "application '$name' target source"
  done
  expected=$(target_compose_source "$compose_json")
  assert_compose_source "$compose_json" "$expected" "Compose target source"
  jq -n '{
    operation: "verify-systemvitals-source",
    status: "verified",
    applicationCount: 3,
    composeCount: 1,
    composeAutoDeploy: false
  }'
}

enable_auto_deploy() {
  local name
  local current
  local expected
  local payload

  require_compose_auto_deploy_disabled
  verify_target_provider
  test_target_connection
  expected=$(target_compose_source "$compose_json")
  assert_compose_source "$compose_json" "$expected" "Compose target source"
  for name in "${application_names[@]}"; do
    current=${applications[$name]}
    expected=$(target_application_source "$current")
    assert_application_source "$current" "$expected" \
      "application '$name' target source"
  done
  for name in "${application_names[@]}"; do
    current=${applications[$name]}
    expected=$(printf '%s' "$current" | safe_application_source |
      jq -cS '.autoDeploy = true')
    if [[ $(jq -r '.autoDeploy' <<<"$current") != true ]]; then
      payload=$(jq -cn --arg application_id "${application_ids[$name]}" '{
        applicationId: $application_id,
        autoDeploy: true
      }')
      dokploy_post "/api/application.update" "$payload" >/dev/null
      current=$(get_application "${application_ids[$name]}")
    fi
    assert_application_source "$current" "$expected" \
      "application '$name' auto-deploy enable"
    applications["$name"]=$current
  done
  jq -n '{
    operation: "enable-systemvitals-auto-deploy",
    status: "enabled",
    applicationCount: 3,
    composeAutoDeploy: false
  }'
}

rollback_provider_preflight() {
  local receipt=$1
  local providers
  local entries
  local entry
  local provider_id
  local full_name
  local provider_count
  local repository_count
  local repositories

  providers=$(dokploy_get "/api/gitProvider.getAll")
  entries=$(jq -cS '
    [.applications[], .compose] |
    unique_by([.githubId, .owner, .repository])
  ' <<<"$receipt")
  while IFS= read -r entry; do
    provider_id=$(jq -r '.githubId' <<<"$entry")
    full_name=$(jq -r '.owner + "/" + .repository' <<<"$entry")
    provider_count=$(jq -r --arg github_id "$provider_id" '
      [
        .[]? |
        select(
          .providerType == "github" and
          .github.githubId == $github_id
        )
      ] |
      length
    ' <<<"$providers")
    [[ $provider_count == 1 ]] ||
      block "rollback provider preflight failed"

    repositories=$(dokploy_get \
      "/api/github.getGithubRepositories?githubId=$provider_id")
    repository_count=$(jq -r --arg full_name "$full_name" '
      [
        .[]? |
        select(
          .fullName == $full_name or
          .full_name == $full_name or
          .nameWithOwner == $full_name
        )
      ] |
      length
    ' <<<"$repositories")
    [[ $repository_count == 1 ]] ||
      block "rollback provider preflight failed"
  done < <(jq -c '.[]' <<<"$entries")
}

rollback_retarget() {
  local receipt=$1
  local name
  local application_id
  local expected
  local receipt_name
  local receipt_compose

  for name in "${application_names[@]}"; do
    application_id=${application_ids[$name]}
    receipt_name=$(jq -r --arg name "$name" \
      '[.applications[] | select(.name == $name)] |
       if length == 1 then .[0].applicationId else empty end' <<<"$receipt")
    [[ $receipt_name == "$application_id" ]] ||
      block "rollback receipt identity does not match application '$name'"
  done
  receipt_compose=$(jq -r '.compose.composeId // empty' <<<"$receipt")
  [[ $receipt_compose == "$compose_id" ]] ||
    block "rollback receipt identity does not match the Compose"

  require_compose_auto_deploy_disabled
  rollback_provider_preflight "$receipt"

  for name in "${application_names[@]}"; do
    disable_application_preserving_source "$name"
  done
  for name in "${application_names[@]}"; do
    expected=$(jq -cS --arg name "$name" '
      .applications[] |
      select(.name == $name) |
      .autoDeploy = false
    ' <<<"$receipt")
    save_application_source "$name" "$expected"
  done
  expected=$(jq -cS '.compose | .autoDeploy = false' <<<"$receipt")
  save_compose_source "$expected"

  jq -n '{
    operation: "rollback-systemvitals-source",
    status: "rolled-back",
    applicationCount: 3,
    composeCount: 1,
    autoDeploy: false
  }'
}

receipt_json=
if [[ $mode == rollback ]]; then
  receipt_json=$(validate_receipt "$receipt_path")
fi

discover
case "$mode" in
  plan)
    verify_target_provider
    safe_plan
    ;;
  apply)
    apply_retarget
    ;;
  verify)
    verify_retarget
    ;;
  enable-auto-deploy)
    enable_auto_deploy
    ;;
  rollback)
    rollback_retarget "$receipt_json"
    ;;
esac
