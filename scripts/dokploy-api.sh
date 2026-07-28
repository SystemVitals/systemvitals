#!/usr/bin/env bash

# Source this file from Dokploy automation. It intentionally keeps credentials,
# request bodies, response bodies, and curl diagnostics in one protected
# temporary directory that is removed when the calling shell exits.

declare -a _DOKPLOY_CLEANUP_HANDLERS=()
_DOKPLOY_CLEANUP_TRAP_INSTALLED=false

_dokploy_run_cleanups() {
  local exit_status=$?
  local index

  trap - EXIT
  for ((index = ${#_DOKPLOY_CLEANUP_HANDLERS[@]} - 1;
    index >= 0; index--)); do
    "${_DOKPLOY_CLEANUP_HANDLERS[index]}" || true
  done
  return "$exit_status"
}

dokploy_register_cleanup() {
  local handler=${1:-}
  local registered

  [[ $# == 1 && $handler =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    _dokploy_fail "cleanup handler must be one function name" || return 1
  declare -F "$handler" >/dev/null ||
    _dokploy_fail "cleanup handler '$handler' is not defined" || return 1
  for registered in "${_DOKPLOY_CLEANUP_HANDLERS[@]}"; do
    [[ $registered != "$handler" ]] || return 0
  done
  _DOKPLOY_CLEANUP_HANDLERS+=("$handler")
  if [[ $_DOKPLOY_CLEANUP_TRAP_INSTALLED != true ]]; then
    trap _dokploy_run_cleanups EXIT
    _DOKPLOY_CLEANUP_TRAP_INSTALLED=true
  fi
}

_dokploy_cleanup() {
  if [[ -n ${DOKPLOY_API_TMPDIR:-} && -d $DOKPLOY_API_TMPDIR ]]; then
    rm -rf -- "$DOKPLOY_API_TMPDIR"
  fi
}

_dokploy_fail() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

_dokploy_require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    _dokploy_fail "required command '$1' is unavailable"
}

_dokploy_validate_url() {
  if [[ $DOKPLOY_URL == https://* ]]; then
    return 0
  fi

  if [[ ${DOKPLOY_ALLOW_INSECURE_LOCALHOST_FOR_TESTS:-} == 1 ]] &&
    [[ $DOKPLOY_URL =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|$) ]]; then
    return 0
  fi

  _dokploy_fail \
    "DOKPLOY_URL must use HTTPS (HTTP is test-only and restricted to explicit loopback opt-in)"
}

_dokploy_init() {
  local escaped_key

  if [[ -n ${DOKPLOY_API_TMPDIR:-} ]]; then
    return 0
  fi

  _dokploy_require_command curl || return 1
  _dokploy_require_command jq || return 1
  [[ -n ${DOKPLOY_URL:-} ]] ||
    _dokploy_fail "DOKPLOY_URL must be set and nonempty" || return 1
  _dokploy_validate_url || return 1
  [[ -n ${DOKPLOY_API_KEY:-} ]] ||
    _dokploy_fail "DOKPLOY_API_KEY must be set and nonempty" || return 1
  [[ $DOKPLOY_API_KEY != *$'\n'* && $DOKPLOY_API_KEY != *$'\r'* ]] ||
    _dokploy_fail "DOKPLOY_API_KEY contains unsupported characters" || return 1
  [[ $DOKPLOY_API_KEY != *'"'* && $DOKPLOY_API_KEY != *\\* ]] ||
    _dokploy_fail "DOKPLOY_API_KEY contains unsupported characters" || return 1

  umask 077
  DOKPLOY_API_TMPDIR=$(mktemp -d "/tmp/dokploy-api.XXXXXXXX")
  chmod 0700 "$DOKPLOY_API_TMPDIR"
  export DOKPLOY_API_TMPDIR
  dokploy_register_cleanup _dokploy_cleanup || return 1

  DOKPLOY_URL=${DOKPLOY_URL%/}
  escaped_key=$DOKPLOY_API_KEY
  {
    printf '%s\n' \
      'fail-with-body' \
      'silent' \
      'show-error' \
      'max-time = 30'
    printf 'header = "x-api-key: %s"\n' "$escaped_key"
    printf '%s\n' \
      'header = "Accept: application/json"' \
      'header = "Content-Type: application/json"'
  } >"$DOKPLOY_API_TMPDIR/curl.conf"
  chmod 0600 "$DOKPLOY_API_TMPDIR/curl.conf"
}

_dokploy_validate_path() {
  local path=$1

  [[ $path == /api/* ]] ||
    _dokploy_fail "Dokploy API path must begin with /api/" || return 1
  [[ $path != *$'\n'* && $path != *$'\r'* ]] ||
    _dokploy_fail "Dokploy API path contains unsupported characters" || return 1
  if [[ ${path,,} =~ (api[_-]?key|authorization|password|secret|token|(^|[?&])env=) ]]; then
    _dokploy_fail "sensitive values are not permitted in Dokploy API paths"
    return 1
  fi
}

_dokploy_request() {
  local method=$1
  local path=$2
  local json=${3:-}
  local request_id
  local response_file
  local error_file
  local payload_file=
  local http_code=
  local curl_status=0
  local operation
  local -a curl_args=()

  _dokploy_init || return 1
  _dokploy_validate_path "$path" || return 1
  operation=${path%%\?*}
  request_id=$(printf '%s\n' "$DOKPLOY_API_TMPDIR"/request.* | wc -l)
  response_file="$DOKPLOY_API_TMPDIR/response.$request_id"
  error_file="$DOKPLOY_API_TMPDIR/error.$request_id"

  curl_args=(
    --config "$DOKPLOY_API_TMPDIR/curl.conf"
    --request "$method"
    --output "$response_file"
    --write-out '%{http_code}'
  )

  if [[ $method == POST ]]; then
    if ! jq -e . >/dev/null 2>&1 <<<"$json"; then
      _dokploy_fail "Dokploy POST payload is not valid JSON"
      return 1
    fi
    payload_file="$DOKPLOY_API_TMPDIR/payload.$request_id"
    printf '%s' "$json" >"$payload_file"
    chmod 0600 "$payload_file"
    curl_args+=(--data-binary "@$payload_file")
  fi

  if http_code=$(curl "${curl_args[@]}" \
    "$DOKPLOY_URL$path" 2>"$error_file"); then
    curl_status=0
  else
    curl_status=$?
  fi

  if ((curl_status != 0)); then
    if [[ $http_code =~ ^[0-9]{3}$ ]]; then
      _dokploy_fail "Dokploy $method $operation failed (HTTP $http_code)"
    else
      _dokploy_fail "Dokploy $method $operation failed"
    fi
    return 1
  fi

  if ! jq -e . "$response_file" >/dev/null 2>&1; then
    _dokploy_fail "Dokploy $method $operation returned an invalid response"
    return 1
  fi

  command cat "$response_file"
}

dokploy_get() {
  local path=${1:-}
  local object_id
  local input

  [[ $# == 1 ]] ||
    _dokploy_fail "dokploy_get requires exactly one API path" || return 1
  case "$path" in
    /api/project.all)
      dokploy_trpc_get "project.all" "null" |
        _dokploy_sanitize_project_discovery
      ;;
    /api/project.one?projectId=*)
      object_id=${path#*=}
      [[ $object_id =~ ^[A-Za-z0-9._-]+$ ]] ||
        _dokploy_fail "Dokploy project ID contains unsupported characters" ||
        return 1
      input=$(jq -cn --arg project_id "$object_id" \
        '{projectId: $project_id}')
      dokploy_trpc_get "project.one" "$input" |
        _dokploy_sanitize_project_discovery
      ;;
    /api/domain.one?domainId=*)
      object_id=${path#*=}
      [[ $object_id =~ ^[A-Za-z0-9._-]+$ ]] ||
        _dokploy_fail "Dokploy domain ID contains unsupported characters" ||
        return 1
      input=$(jq -cn --arg domain_id "$object_id" \
        '{domainId: $domain_id}')
      dokploy_trpc_get "domain.one" "$input" | jq -c 'del(.application)'
      ;;
    /api/domain.byApplicationId?applicationId=*)
      object_id=${path#*=}
      [[ $object_id =~ ^[A-Za-z0-9._-]+$ ]] ||
        _dokploy_fail \
          "Dokploy application ID contains unsupported characters" ||
        return 1
      input=$(jq -cn --arg application_id "$object_id" \
        '{applicationId: $application_id}')
      dokploy_trpc_get "domain.byApplicationId" "$input" |
        jq -c 'map(del(.application))'
      ;;
    *)
      _dokploy_request GET "$path"
      ;;
  esac
}

dokploy_post() {
  [[ $# == 2 ]] ||
    _dokploy_fail "dokploy_post requires an API path and JSON payload" ||
    return 1
  _dokploy_request POST "$1" "$2"
}

dokploy_trpc_get() {
  local procedure=${1:-}
  local input=${2:-}
  local envelope
  local encoded_input
  local response

  [[ $# == 2 ]] ||
    _dokploy_fail "dokploy_trpc_get requires a procedure and JSON input" ||
    return 1
  [[ $procedure =~ ^[A-Za-z0-9._-]+$ ]] ||
    _dokploy_fail "Dokploy tRPC procedure contains unsupported characters" ||
    return 1
  if ! jq -e 'type == "object" or . == null' \
    >/dev/null 2>&1 <<<"$input"; then
    _dokploy_fail "Dokploy tRPC input must be a JSON object or null"
    return 1
  fi

  envelope=$(jq -cn --argjson input "$input" '{json: $input}')
  encoded_input=$(printf '%s' "$envelope" | jq -Rsr '@uri')
  response=$(_dokploy_request GET \
    "/api/trpc/$procedure?input=$encoded_input") || return 1
  _dokploy_normalize_trpc_response "$response"
}

dokploy_trpc_post_bigints() {
  local procedure=${1:-}
  local input=${2:-}
  shift 2 || true
  local bigint_paths
  local envelope
  local response

  (($# > 0)) ||
    _dokploy_fail \
      "dokploy_trpc_post_bigints requires at least one bigint path" ||
    return 1
  [[ $procedure =~ ^[A-Za-z0-9._-]+$ ]] ||
    _dokploy_fail "Dokploy tRPC procedure contains unsupported characters" ||
    return 1
  if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$input"; then
    _dokploy_fail "Dokploy tRPC input must be a JSON object"
    return 1
  fi
  for path in "$@"; do
    [[ $path =~ ^[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$ ]] ||
      _dokploy_fail "Dokploy bigint path contains unsupported characters" ||
      return 1
  done

  bigint_paths=$(printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1]')
  if ! envelope=$(jq -cn \
    --argjson input "$input" \
    --argjson paths "$bigint_paths" '
      reduce $paths[] as $path (
        {json: $input, meta: {values: {}}};
        ($path | split(".")) as $parts |
        (.json | getpath($parts)) as $value |
        if ($value | type) != "number" or
          $value != ($value | floor)
        then error("bigint value must be an integer")
        else
          .json |= setpath($parts; ($value | tostring)) |
          .meta.values[$path] = ["bigint"]
        end
      )
    '); then
    _dokploy_fail "could not encode Dokploy bigint payload"
    return 1
  fi

  response=$(_dokploy_request POST "/api/trpc/$procedure" "$envelope") ||
    return 1
  _dokploy_normalize_trpc_response "$response"
}

_dokploy_normalize_trpc_response() {
  local response=$1

  if ! jq -ce '
    .result.data as $data |
    reduce (
      ($data.meta.values // {}) |
      to_entries[] |
      select(.value | index("bigint"))
    ) as $entry (
      $data.json;
      (
        $entry.key |
        split(".") |
        map(
          if test("^(0|[1-9][0-9]*)$") then tonumber else . end
        )
      ) as $path |
      (getpath($path)) as $value |
      if ($value | type) != "string" or
        ($value | test("^-?[0-9]+$") | not)
      then error("invalid bigint response")
      else
        ($value | tonumber) as $number |
        if $number < -9007199254740991 or $number > 9007199254740991
        then error("unsafe bigint response")
        else setpath($path; $number)
        end
      end
    )
  ' <<<"$response"; then
    _dokploy_fail "Dokploy tRPC response could not be normalized"
    return 1
  fi
}

_dokploy_sanitize_project_discovery() {
  jq -ce '
    def safe_environment:
      {
        environmentId,
        name,
        applications: [
          (.applications // [])[] |
          {
            applicationId,
            name,
            appName,
            applicationStatus
          }
        ],
        compose: [
          (.compose // [])[] |
          {
            composeId,
            name,
            appName,
            composeStatus
          }
        ]
      };
    def safe_project:
      {
        projectId,
        name,
        environments: [
          (.environments // [])[] |
          safe_environment
        ]
      };
    if type == "array" then map(safe_project) else safe_project end
  '
}

dokploy_expect_one() {
  local filter=${1:-}
  local description=${2:-object}
  local input_file
  local count

  [[ $# == 2 ]] ||
    _dokploy_fail "dokploy_expect_one requires a jq filter and description" ||
    return 1
  [[ $description != *$'\n'* && $description != *$'\r'* ]] ||
    _dokploy_fail "Dokploy object description contains unsupported characters" ||
    return 1
  _dokploy_init || return 1

  input_file=$(mktemp "$DOKPLOY_API_TMPDIR/expect-one.XXXXXXXX")
  chmod 0600 "$input_file"
  command cat >"$input_file"

  if ! count=$(jq -r "[${filter}] | length" "$input_file" 2>/dev/null); then
    _dokploy_fail "could not resolve $description from Dokploy response"
    return 1
  fi
  if [[ $count != 1 ]]; then
    _dokploy_fail "expected exactly one $description; found $count"
    return 1
  fi
  jq -c "[${filter}][0]" "$input_file"
}
