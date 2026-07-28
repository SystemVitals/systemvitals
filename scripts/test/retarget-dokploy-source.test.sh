#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
retarget="$repo_root/scripts/retarget-dokploy-source.sh"
test_root=$(mktemp -d)

cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
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

mock_bin="$test_root/bin"
state_dir="$test_root/state"
receipt_dir="$test_root/receipts"
mkdir -p "$mock_bin" "$state_dir" "$receipt_dir"

cat >"$state_dir/projects.initial.json" <<'EOF'
[{
  "projectId": "project-id",
  "name": "SystemVitals",
  "environments": [{
    "environmentId": "environment-id",
    "name": "production",
    "applications": [
      {"applicationId":"api-id","name":"SystemVitals API","appName":"api","applicationStatus":"done"},
      {"applicationId":"worker-id","name":"SystemVitals Worker","appName":"worker","applicationStatus":"done"},
      {"applicationId":"frontend-id","name":"SystemVitals Frontend","appName":"frontend","applicationStatus":"done"}
    ],
    "compose": [{
      "composeId":"compose-id",
      "name":"SystemVitals Infrastructure",
      "appName":"infrastructure",
      "composeStatus":"done"
    }]
  }]
}]
EOF

for application in api worker frontend; do
  cat >"$state_dir/$application.initial.json" <<EOF
{
  "applicationId": "$application-id",
  "name": "SystemVitals ${application^}",
  "environmentId": "environment-id",
  "sourceType": "github",
  "githubId": "old-$application-provider",
  "owner": "LegacyOwner",
  "repository": "legacy-systemvitals",
  "branch": "legacy-main",
  "buildPath": "/",
  "triggerType": "push",
  "enableSubmodules": false,
  "watchPaths": null,
  "autoDeploy": true,
  "env": "JWT_SECRET=APPLICATION_SECRET",
  "buildArgs": "DATABASE_URL=BUILD_SECRET",
  "buildSecrets": "BUILD_SECRET_VALUE"
}
EOF
done
jq '.name = "SystemVitals API"' "$state_dir/api.initial.json" \
  >"$state_dir/api.initial.tmp"
mv "$state_dir/api.initial.tmp" "$state_dir/api.initial.json"
jq '.buildPath = null' "$state_dir/api.initial.json" \
  >"$state_dir/api.initial.tmp"
mv "$state_dir/api.initial.tmp" "$state_dir/api.initial.json"
jq '.watchPaths = ["worker/**"]' "$state_dir/worker.initial.json" \
  >"$state_dir/worker.initial.tmp"
mv "$state_dir/worker.initial.tmp" "$state_dir/worker.initial.json"
jq '.triggerType = "tag"' "$state_dir/frontend.initial.json" \
  >"$state_dir/frontend.initial.tmp"
mv "$state_dir/frontend.initial.tmp" "$state_dir/frontend.initial.json"

cat >"$state_dir/compose.initial.json" <<'EOF'
{
  "composeId": "compose-id",
  "name": "SystemVitals Infrastructure",
  "environmentId": "environment-id",
  "sourceType": "github",
  "githubId": "old-compose-provider",
  "owner": "LegacyOwner",
  "repository": "legacy-systemvitals",
  "branch": "legacy-main",
  "composePath": "./docker-compose.infrastructure.yml",
  "autoDeploy": false,
  "env": "DATABASE_URL=COMPOSE_SECRET"
}
EOF

cat >"$mock_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

method=GET
output_file=
data_file=
url=
while (($# > 0)); do
  case "$1" in
    --request)
      method=$2
      shift 2
      ;;
    --output)
      output_file=$2
      shift 2
      ;;
    --data-binary)
      data_file=${2#@}
      shift 2
      ;;
    --config | --write-out | --header)
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

path=${url#https://dokploy.test}
printf '%s %s\n' "$method" "$path" >>"$MOCK_REQUEST_LOG"

read_payload() {
  [[ -n $data_file && -f $data_file ]] || exit 90
  command cat "$data_file"
}

application_file() {
  local application_id=$1
  printf '%s/%s.json' "$MOCK_STATE_DIR" "${application_id%-id}"
}

pending=
[[ ! -f $MOCK_PENDING ]] || pending=$(<"$MOCK_PENDING")
if [[ -n $pending ]]; then
  case "$pending|$method $path" in
    application:*"|GET /api/trpc/application.one?input="*) ;;
    compose:compose-id"|GET /api/compose.one?composeId=compose-id") ;;
    *)
      printf 'mutation was not immediately read back: %s\n' "$pending" >&2
      exit 91
      ;;
  esac
fi

body=
case "$method $path" in
  "GET /api/trpc/project.all?input="*)
    projects=$(command cat "$MOCK_STATE_DIR/projects.json")
    if [[ ${MOCK_DUPLICATE_APPLICATION:-0} == 1 ]]; then
      projects=$(jq \
        '.[0].environments[0].applications += [.[0].environments[0].applications[0]]' \
        <<<"$projects")
    fi
    if [[ ${MOCK_DUPLICATE_COMPOSE:-0} == 1 ]]; then
      projects=$(jq \
        '.[0].environments[0].compose += [.[0].environments[0].compose[0]]' \
        <<<"$projects")
    fi
    body=$(jq -cn --argjson projects "$projects" \
      '{result:{data:{json:$projects,meta:{values:{}}}}}')
    ;;
  "GET /api/compose.one?composeId=compose-id")
    [[ $pending != compose:compose-id ]] || rm -f "$MOCK_PENDING"
    body=$(command cat "$MOCK_STATE_DIR/compose.json")
    ;;
  "GET /api/trpc/application.one?input="*)
    encoded=${path#*input=}
    input=$(printf '%b' "${encoded//%/\\x}")
    application_id=$(jq -r '.json.applicationId' <<<"$input")
    [[ $pending != "application:$application_id" ]] || rm -f "$MOCK_PENDING"
    application=$(command cat "$(application_file "$application_id")")
    body=$(jq -cn --argjson application "$application" \
      '{result:{data:{json:$application,meta:{values:{}}}}}')
    ;;
  "GET /api/gitProvider.getAll")
    body='[
      {
        "gitProviderId":"target-provider-record",
        "providerType":"github",
        "github":{
          "githubId":"target-provider",
          "name":"public-source",
          "accessToken":"PROVIDER_CREDENTIAL"
        }
      },
      {
        "gitProviderId":"old-api-provider-record",
        "providerType":"github",
        "github":{"githubId":"old-api-provider","accessToken":"PROVIDER_CREDENTIAL"}
      },
      {
        "gitProviderId":"old-worker-provider-record",
        "providerType":"github",
        "github":{"githubId":"old-worker-provider","accessToken":"PROVIDER_CREDENTIAL"}
      },
      {
        "gitProviderId":"old-frontend-provider-record",
        "providerType":"github",
        "github":{"githubId":"old-frontend-provider","accessToken":"PROVIDER_CREDENTIAL"}
      },
      {
        "gitProviderId":"old-compose-provider-record",
        "providerType":"github",
        "github":{"githubId":"old-compose-provider","accessToken":"PROVIDER_CREDENTIAL"}
      }
    ]'
    if [[ -n ${MOCK_MISSING_PROVIDER:-} ]]; then
      body=$(jq --arg github_id "$MOCK_MISSING_PROVIDER" '
        map(select(.github.githubId != $github_id))
      ' <<<"$body")
    fi
    ;;
  "POST /api/github.testConnection")
    payload=$(read_payload)
    jq -e 'keys == ["githubId"] and
      (.githubId | type == "string" and length > 0)' \
      <<<"$payload" >/dev/null || exit 93
    jq -c '{endpoint:"github.testConnection",payload:.}' <<<"$payload" \
      >>"$MOCK_PAYLOAD_LOG"
    body='"Connection successful"'
    ;;
  "GET /api/github.getGithubRepositories?githubId="*)
    requested_provider=${path#*githubId=}
    if [[ $requested_provider == target-provider ]]; then
      full_name=SystemVitals/systemvitals
    else
      full_name=LegacyOwner/legacy-systemvitals
    fi
    if [[ ${MOCK_INACCESSIBLE_PROVIDER:-} == "$requested_provider" ]]; then
      full_name=OtherOwner/other-repository
    fi
    body=$(jq -cn --arg full_name "$full_name" '[{
      fullName: $full_name,
      private: false,
      credential: "PROVIDER_CREDENTIAL"
    }]')
    ;;
  "POST /api/application.update")
    payload=$(read_payload)
    application_id=$(jq -r '.applicationId' <<<"$payload")
    jq -c '{endpoint:"application.update",payload:.}' <<<"$payload" \
      >>"$MOCK_PAYLOAD_LOG"
    file=$(application_file "$application_id")
    jq --argjson payload "$payload" '. * ($payload | del(.applicationId))' \
      "$file" >"$file.tmp"
    mv "$file.tmp" "$file"
    printf 'application:%s\n' "$application_id" >"$MOCK_PENDING"
    body='true'
    ;;
  "POST /api/application.saveGithubProvider")
    payload=$(read_payload)
    application_id=$(jq -r '.applicationId' <<<"$payload")
    jq -c '{endpoint:"application.saveGithubProvider",payload:.}' <<<"$payload" \
      >>"$MOCK_PAYLOAD_LOG"
    file=$(application_file "$application_id")
    jq --argjson payload "$payload" '
      . * ($payload | del(.applicationId)) | .sourceType = "github"
    ' "$file" >"$file.tmp"
    mv "$file.tmp" "$file"
    if [[ ${MOCK_SOURCE_READBACK_DRIFT_ID:-} == "$application_id" ]]; then
      jq '.owner = "ReadbackDrift"' "$file" >"$file.tmp"
      mv "$file.tmp" "$file"
    fi
    printf 'application:%s\n' "$application_id" >"$MOCK_PENDING"
    body='true'
    ;;
  "POST /api/compose.update")
    payload=$(read_payload)
    jq -c '{endpoint:"compose.update",payload:.}' <<<"$payload" \
      >>"$MOCK_PAYLOAD_LOG"
    jq --argjson payload "$payload" '. * ($payload | del(.composeId))' \
      "$MOCK_STATE_DIR/compose.json" >"$MOCK_STATE_DIR/compose.tmp"
    mv "$MOCK_STATE_DIR/compose.tmp" "$MOCK_STATE_DIR/compose.json"
    printf 'compose:compose-id\n' >"$MOCK_PENDING"
    body='true'
    ;;
  *)
    exit 92
    ;;
esac

printf '%s' "$body" >"$output_file"
printf '200'
EOF
chmod +x "$mock_bin/curl"

request_log="$test_root/requests.log"
payload_log="$test_root/payloads.log"
pending="$test_root/pending"
output="$test_root/output"
error="$test_root/error"

reset_state() {
  cp "$state_dir/projects.initial.json" "$state_dir/projects.json"
  cp "$state_dir/api.initial.json" "$state_dir/api.json"
  cp "$state_dir/worker.initial.json" "$state_dir/worker.json"
  cp "$state_dir/frontend.initial.json" "$state_dir/frontend.json"
  cp "$state_dir/compose.initial.json" "$state_dir/compose.json"
  : >"$request_log"
  : >"$payload_log"
  rm -f "$pending"
}

common_env=(
  "PATH=$mock_bin:$PATH"
  "DOKPLOY_URL=https://dokploy.test"
  "DOKPLOY_API_KEY=retarget-test-api-key"
  "SYSTEMVITALS_GITHUB_OWNER=SystemVitals"
  "SYSTEMVITALS_GITHUB_REPOSITORY=systemvitals"
  "SYSTEMVITALS_GITHUB_BRANCH=main"
  "SYSTEMVITALS_DOKPLOY_GITHUB_ID=target-provider"
  "SYSTEMVITALS_CUTOVER_RECEIPT_DIR=$receipt_dir"
  "MOCK_STATE_DIR=$state_dir"
  "MOCK_REQUEST_LOG=$request_log"
  "MOCK_PAYLOAD_LOG=$payload_log"
  "MOCK_PENDING=$pending"
)

check_safe_output() {
  local file
  for file in "$output" "$error"; do
    for forbidden in \
      '.env' buildArgs buildSecrets JWT_SECRET DATABASE_URL \
      PROVIDER_CREDENTIAL retarget-test-api-key; do
      assert_not_contains "$file" "$forbidden"
    done
  done
}

reset_state
env "${common_env[@]}" "$retarget" plan >"$output" 2>"$error"
check_safe_output
[[ $(grep -c '^POST ' "$request_log" || true) == 0 ]] ||
  fail "plan made a POST request"
assert_contains "$output" '"SystemVitals API"'
assert_contains "$output" '"SystemVitals Worker"'
assert_contains "$output" '"SystemVitals Frontend"'
assert_contains "$output" '"SystemVitals Infrastructure"'

for duplicate in MOCK_DUPLICATE_APPLICATION MOCK_DUPLICATE_COMPOSE; do
  reset_state
  if env "${common_env[@]}" "$duplicate=1" "$retarget" plan \
    >"$output" 2>"$error"; then
    fail "plan accepted ambiguous discovery from $duplicate"
  fi
  assert_contains "$error" 'expected exactly one'
  check_safe_output
done

reset_state
jq '.autoDeploy = true' "$state_dir/compose.json" \
  >"$state_dir/compose.tmp"
mv "$state_dir/compose.tmp" "$state_dir/compose.json"
if env "${common_env[@]}" "$retarget" apply \
  --confirm retarget-systemvitals-source >"$output" 2>"$error"; then
  fail "apply accepted Compose auto-deploy drift"
fi
assert_contains "$error" 'Compose auto-deploy must be disabled'
[[ $(grep -c '^POST ' "$request_log" || true) == 0 ]] ||
  fail "apply made a POST before rejecting Compose auto-deploy drift"
check_safe_output

reset_state
jq '.sourceType = "docker"' "$state_dir/frontend.json" \
  >"$state_dir/frontend.tmp"
mv "$state_dir/frontend.tmp" "$state_dir/frontend.json"
if env "${common_env[@]}" "$retarget" apply \
  --confirm retarget-systemvitals-source >"$output" 2>"$error"; then
  fail "apply accepted a current source snapshot rollback cannot restore"
fi
assert_contains "$error" 'current source snapshot is not rollback-valid'
[[ $(grep -c '^POST ' "$request_log" || true) == 0 ]] ||
  fail "apply posted before validating its generated rollback snapshot"
check_safe_output

reset_state
env "${common_env[@]}" "$retarget" apply \
  --confirm retarget-systemvitals-source >"$output" 2>"$error"
check_safe_output
receipt=$(jq -r '.receipt' "$output")
[[ $receipt == "$receipt_dir"/* && -f $receipt ]] ||
  fail "apply did not write its receipt to the configured external directory"
[[ $(stat -c '%a' "$receipt") == 600 ]] ||
  fail "apply receipt is not mode 0600"
jq -e '
  .schemaVersion == 1 and
  (.applications | length) == 3 and
  .compose.name == "SystemVitals Infrastructure" and
  (keys | sort) ==
    ["applications","compose","createdAt","operation","schemaVersion"] and
  ([.applications[] | keys | sort] | all(
    . == [
      "applicationId","autoDeploy","branch","buildPath",
      "enableSubmodules","githubId","name","owner","repository",
      "sourceType","triggerType","watchPaths"
    ]
  )) and
  (.compose | keys | sort) == [
    "autoDeploy","branch","composeId","composePath","githubId","name",
    "owner","repository","sourceType"
  ] and
  ([.. | objects | keys[]] |
    any(. == "env" or . == "buildArgs" or . == "buildSecrets") | not)
' "$receipt" >/dev/null || fail "apply receipt is incomplete or unsafe"

first_provider_line=$(grep -n \
  '"endpoint":"application.saveGithubProvider"' "$payload_log" |
  head -n 1 | cut -d: -f1)
last_disable_line=$(grep -n \
  '"endpoint":"application.update"' "$payload_log" |
  tail -n 1 | cut -d: -f1)
[[ $last_disable_line -lt $first_provider_line ]] ||
  fail "apply changed source before disabling all application auto-deploy flags"
[[ $(grep -c '"endpoint":"application.update"' "$payload_log") == 3 ]] ||
  fail "apply did not disable exactly three applications"
[[ $(grep -c '"endpoint":"application.saveGithubProvider"' "$payload_log") == 3 ]] ||
  fail "apply did not retarget exactly three applications"
[[ $(grep -c '"endpoint":"compose.update"' "$payload_log") == 1 ]] ||
  fail "apply did not retarget exactly one Compose"
[[ $(grep -c '"endpoint":"github.testConnection"' "$payload_log") == 1 ]] ||
  fail "apply did not test the target GitHub connection exactly once"
first_payload_endpoint=$(jq -r '.endpoint' "$payload_log" | head -n 1)
[[ $first_payload_endpoint == github.testConnection ]] ||
  fail "apply mutated source state before testing the target GitHub connection"
assert_contains "$request_log" \
  'POST /api/github.testConnection'
assert_contains "$request_log" \
  'GET /api/github.getGithubRepositories?githubId=target-provider'

for application in api worker frontend; do
  jq -e '
    .sourceType == "github" and
    .githubId == "target-provider" and
    .owner == "SystemVitals" and
    .repository == "systemvitals" and
    .branch == "main" and
    .autoDeploy == false
  ' "$state_dir/$application.json" >/dev/null ||
    fail "$application source did not read back exactly after apply"
done
jq -e '
  .sourceType == "github" and
  .githubId == "target-provider" and
  .owner == "SystemVitals" and
  .repository == "systemvitals" and
  .branch == "main" and
  .composePath == "./docker-compose.infrastructure.yml" and
  .autoDeploy == false
' "$state_dir/compose.json" >/dev/null ||
  fail "Compose source did not read back exactly after apply"

: >"$payload_log"
: >"$request_log"
env "${common_env[@]}" "$retarget" verify >"$output" 2>"$error"
[[ ! -s $payload_log ]] || fail "verify mutated Dokploy state"
[[ $(grep -c '^POST ' "$request_log" || true) == 0 ]] ||
  fail "verify made a POST request"
check_safe_output

env "${common_env[@]}" "$retarget" enable-auto-deploy \
  --confirm enable-systemvitals-auto-deploy >"$output" 2>"$error"
check_safe_output
[[ $(grep -c '"endpoint":"application.update"' "$payload_log") == 3 ]] ||
  fail "enable-auto-deploy did not affect exactly three applications"
[[ $(grep -c '"endpoint":"compose.update"' "$payload_log" || true) == 0 ]] ||
  fail "enable-auto-deploy changed the Compose"
[[ $(grep -c '"endpoint":"github.testConnection"' "$payload_log") == 1 ]] ||
  fail "enable-auto-deploy did not test the target GitHub connection"
for application in api worker frontend; do
  jq -e '.autoDeploy == true' "$state_dir/$application.json" >/dev/null ||
    fail "enable-auto-deploy did not enable $application"
done
jq -e '.autoDeploy == false' "$state_dir/compose.json" >/dev/null ||
  fail "enable-auto-deploy enabled the Compose"

malformed_second="$receipt_dir/malformed-second.json"
jq '.applications[1].unexpected = "unsafe-shape"' "$receipt" \
  >"$malformed_second"
chmod 0600 "$malformed_second"
: >"$request_log"
: >"$payload_log"
if env "${common_env[@]}" "$retarget" rollback --receipt "$malformed_second" \
  --confirm rollback-systemvitals-source >"$output" 2>"$error"; then
  fail "rollback accepted an application receipt entry with extra keys"
fi
assert_contains "$error" 'rollback receipt is invalid'
[[ $(grep -c '^POST ' "$request_log" || true) == 0 ]] ||
  fail "malformed second receipt entry caused a POST request"
check_safe_output

malformed_third="$receipt_dir/malformed-third.json"
jq '.applications[2].applicationId = .applications[1].applicationId' \
  "$receipt" >"$malformed_third"
chmod 0600 "$malformed_third"
: >"$request_log"
: >"$payload_log"
if env "${common_env[@]}" "$retarget" rollback --receipt "$malformed_third" \
  --confirm rollback-systemvitals-source >"$output" 2>"$error"; then
  fail "rollback accepted duplicate application IDs in its receipt"
fi
assert_contains "$error" 'rollback receipt is invalid'
[[ $(grep -c '^POST ' "$request_log" || true) == 0 ]] ||
  fail "malformed third receipt entry caused a POST request"
check_safe_output

malformed_watch_paths="$receipt_dir/malformed-watch-paths.json"
jq '.applications[1].watchPaths = "frontend/**"' \
  "$receipt" >"$malformed_watch_paths"
chmod 0600 "$malformed_watch_paths"
: >"$request_log"
: >"$payload_log"
if env "${common_env[@]}" "$retarget" rollback \
  --receipt "$malformed_watch_paths" \
  --confirm rollback-systemvitals-source >"$output" 2>"$error"; then
  fail "rollback accepted string watchPaths in a later receipt entry"
fi
assert_contains "$error" 'rollback receipt is invalid'
[[ $(grep -c '^POST ' "$request_log" || true) == 0 ]] ||
  fail "wrong-type watchPaths caused a rollback POST request"
check_safe_output

malformed_trigger="$receipt_dir/malformed-trigger.json"
jq '.applications[2].triggerType = "manual"' \
  "$receipt" >"$malformed_trigger"
chmod 0600 "$malformed_trigger"
: >"$request_log"
: >"$payload_log"
if env "${common_env[@]}" "$retarget" rollback \
  --receipt "$malformed_trigger" \
  --confirm rollback-systemvitals-source >"$output" 2>"$error"; then
  fail "rollback accepted an unsupported triggerType in a later receipt entry"
fi
assert_contains "$error" 'rollback receipt is invalid'
[[ $(grep -c '^POST ' "$request_log" || true) == 0 ]] ||
  fail "wrong-enum triggerType caused a rollback POST request"
check_safe_output

for provider_failure in \
  MOCK_MISSING_PROVIDER=old-frontend-provider \
  MOCK_INACCESSIBLE_PROVIDER=old-compose-provider; do
  : >"$request_log"
  : >"$payload_log"
  if env "${common_env[@]}" "$provider_failure" "$retarget" rollback \
    --receipt "$receipt" --confirm rollback-systemvitals-source \
    >"$output" 2>"$error"; then
    fail "rollback accepted unavailable old provider: $provider_failure"
  fi
  assert_contains "$error" 'rollback provider preflight failed'
  [[ $(grep -c '^POST ' "$request_log" || true) == 0 ]] ||
    fail "rollback posted before completing every old provider preflight"
  check_safe_output
done

: >"$payload_log"
: >"$request_log"
env "${common_env[@]}" "$retarget" rollback --receipt "$receipt" \
  --confirm rollback-systemvitals-source >"$output" 2>"$error"
check_safe_output
[[ $(grep -c \
  '^GET /api/github.getGithubRepositories?githubId=old-' \
  "$request_log") == 4 ]] ||
  fail "rollback did not preflight all four distinct old providers"
for application in api worker frontend; do
  jq -e --arg provider "old-$application-provider" '
    .sourceType == "github" and
    .githubId == $provider and
    .owner == "LegacyOwner" and
    .repository == "legacy-systemvitals" and
    .branch == "legacy-main" and
    .autoDeploy == false
  ' "$state_dir/$application.json" >/dev/null ||
    fail "rollback did not restore $application source"
done
jq -e '
  .sourceType == "github" and
  .githubId == "old-compose-provider" and
  .owner == "LegacyOwner" and
  .repository == "legacy-systemvitals" and
  .branch == "legacy-main" and
  .autoDeploy == false
' "$state_dir/compose.json" >/dev/null ||
  fail "rollback did not restore the Compose source"

reset_state
if env "${common_env[@]}" MOCK_SOURCE_READBACK_DRIFT_ID=worker-id \
  "$retarget" apply --confirm retarget-systemvitals-source \
  >"$output" 2>"$error"; then
  fail "apply continued after a failed source readback"
fi
assert_contains "$error" 'did not read back exactly'
[[ $(grep -c '"endpoint":"application.saveGithubProvider"' "$payload_log") == 2 ]] ||
  fail "apply did not stop at the first failed source readback"
[[ $(grep -c '"endpoint":"compose.update"' "$payload_log" || true) == 0 ]] ||
  fail "apply changed Compose after an application readback failure"
check_safe_output

echo "Dokploy source retarget tests passed."
