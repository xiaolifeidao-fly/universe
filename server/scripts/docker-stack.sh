#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly ENV_FILE="${REPOSITORY_ROOT}/.env"
readonly COMPOSE_FILE="${REPOSITORY_ROOT}/compose.yaml"
readonly DEBUG_COMPOSE_FILE="${REPOSITORY_ROOT}/compose.debug.yaml"
readonly HEALTH_TIMEOUT_SECONDS="${STACK_HEALTH_TIMEOUT_SECONDS:-120}"

debug_api=false

usage() {
  cat <<'EOF'
Usage: scripts/docker-stack.sh [--debug-api] <command> [service]

Commands:
  config             Validate the Compose configuration without printing secrets.
  build [service]    Build all images or one of: web-api, client-web.
  up                 Build, start, and wait for the stack to become ready.
  down               Stop containers and remove only this stack's network.
  restart [service]  Restart all services or one named service.
  status             Show service state and health.
  logs [-f] [service]  Show logs; use -f or --follow to follow them.
  check              Verify web-api health, the UI, and /api/healthz proxying.

Options:
  --debug-api        Publish web-api on WEB_API_BIND:WEB_API_PORT using
                     compose.debug.yaml. It is loopback-only by default.

Environment:
  STACK_HEALTH_TIMEOUT_SECONDS  Readiness timeout in seconds (default: 120).
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "'$1' is required."
}

require_docker() {
  require_command docker
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
  docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable; start Docker and try again."
}

read_env_value() {
  local variable_name="$1"
  local default_value="$2"
  local value="${!variable_name-}"

  if [[ -z "$value" && -f "$ENV_FILE" ]]; then
    value="$(awk -v name="$variable_name" '
      $0 ~ "^[[:space:]]*" name "=" {
        line = $0
        sub("^[[:space:]]*" name "=", "", line)
        sub(/[[:space:]]*\r$/, "", line)
        result = line
      }
      END { print result }
    ' "$ENV_FILE")"
  fi

  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "${value:-$default_value}"
}

require_env_file() {
  [[ -f "$ENV_FILE" ]] || fail "Missing ${ENV_FILE}. Copy .env.example to .env and set required values."
}

require_required_variables() {
  local variable_name value
  for variable_name in WEB_API_SQLCONN WEB_API_AUTH_TOKEN_SECRET; do
    value="$(read_env_value "$variable_name" "")"
    [[ -n "$value" ]] || fail "${variable_name} must be set in ${ENV_FILE}."
  done
}

validate_service() {
  case "${1:-}" in
    web-api | client-web) ;;
    *) fail "Unknown service '${1:-}'. Use web-api or client-web." ;;
  esac
}

compose() {
  local -a command=(docker compose --project-directory "$REPOSITORY_ROOT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  if [[ "$debug_api" == true ]]; then
    command+=(-f "$DEBUG_COMPOSE_FILE")
  fi
  command+=("$@")
  "${command[@]}"
}

print_diagnostics() {
  echo "\nStack diagnostics:" >&2
  compose ps >&2 || true
  compose logs --tail 100 >&2 || true
}

wait_for_ready() {
  local started_at now api_container client_container api_health client_state
  started_at="$(date +%s)"

  while true; do
    api_container="$(compose ps -q web-api 2>/dev/null || true)"
    client_container="$(compose ps -q client-web 2>/dev/null || true)"
    api_health=""
    client_state=""

    if [[ -n "$api_container" ]]; then
      api_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$api_container" 2>/dev/null || true)"
    fi
    if [[ -n "$client_container" ]]; then
      client_state="$(docker inspect --format '{{.State.Status}}' "$client_container" 2>/dev/null || true)"
    fi

    if [[ "$api_health" == healthy && "$client_state" == running ]]; then
      return 0
    fi

    now="$(date +%s)"
    if (( now - started_at >= HEALTH_TIMEOUT_SECONDS )); then
      echo "Timed out after ${HEALTH_TIMEOUT_SECONDS}s (web-api=${api_health:-not-created}, client-web=${client_state:-not-created})." >&2
      print_diagnostics
      return 1
    fi
    sleep 2
  done
}

check_stack() {
  local client_port check_host base_url
  require_command curl
  wait_for_ready

  client_port="$(read_env_value CLIENT_WEB_PORT 7893)"
  check_host="$(read_env_value CLIENT_WEB_CHECK_HOST 127.0.0.1)"
  base_url="http://${check_host}:${client_port}"

  curl --fail --silent --show-error --location --max-time 15 --output /dev/null "$base_url/" || {
    echo "Frontend homepage check failed: ${base_url}/" >&2
    return 1
  }
  curl --fail --silent --show-error --location --max-time 15 --output /dev/null "$base_url/api/healthz" || {
    echo "Frontend proxy health check failed: ${base_url}/api/healthz" >&2
    return 1
  }

  echo "Stack check passed: ${base_url}/ and ${base_url}/api/healthz"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug-api)
      debug_api=true
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

[[ $# -gt 0 ]] || {
  usage >&2
  exit 2
}

command_name="$1"
shift

require_env_file
require_required_variables
require_docker

case "$command_name" in
  config)
    [[ $# -eq 0 ]] || fail "config does not accept service arguments."
    compose config --quiet
    echo "Compose configuration is valid."
    ;;
  build)
    if [[ $# -gt 0 ]]; then
      [[ $# -eq 1 ]] || fail "build accepts at most one service."
      validate_service "$1"
    fi
    compose build "$@"
    ;;
  up)
    [[ $# -eq 0 ]] || fail "up does not accept service arguments."
    compose up --detach --build
    wait_for_ready
    check_stack
    ;;
  down)
    [[ $# -eq 0 ]] || fail "down does not accept service arguments."
    compose down --remove-orphans
    ;;
  restart)
    if [[ $# -gt 0 ]]; then
      [[ $# -eq 1 ]] || fail "restart accepts at most one service."
      validate_service "$1"
    fi
    compose restart "$@"
    wait_for_ready
    ;;
  status)
    [[ $# -eq 0 ]] || fail "status does not accept service arguments."
    compose ps
    ;;
  logs)
    follow_args=()
    if [[ "${1:-}" == "-f" || "${1:-}" == "--follow" ]]; then
      follow_args=(--follow)
      shift
    fi
    if [[ $# -gt 0 ]]; then
      [[ $# -eq 1 ]] || fail "logs accepts one optional service."
      validate_service "$1"
    fi
    compose logs --tail 100 "${follow_args[@]}" "$@"
    ;;
  check)
    [[ $# -eq 0 ]] || fail "check does not accept service arguments."
    check_stack
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
