#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env}"
COMPOSE_ARGS=(-f docker-compose.yml -f docker-compose.prod.yml)

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin not found"
  exit 1
fi

passed=0
failed=0

check() {
  local name="$1"
  local cmd="$2"
  echo -n "Checking ${name}... "
  if eval "$cmd" >/dev/null 2>&1; then
    echo "PASS"
    passed=$((passed + 1))
  else
    echo "FAIL"
    failed=$((failed + 1))
  fi
}

compose() {
  docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" "$@"
}

check "Docker daemon" "docker ps"
check "Compose status" "compose ps"
check "Redis healthy" "compose ps | grep -E 'redis.+healthy'"
check "Worker healthy" "compose ps | grep -E 'worker.+healthy'"
check "Frontend up" "compose ps | grep -E 'frontend.+Up'"
check "Worker /health" "curl -fsS http://127.0.0.1:3001/health"
check "Frontend HTTP" "curl -fsS http://127.0.0.1:3000"
check "Nginx running" "sudo systemctl is-active nginx"
check "Nginx config" "sudo nginx -t"

if [[ -n "${REDIS_PASSWORD:-}" ]]; then
  check "Redis auth ping" "compose exec -T redis redis-cli -a \"$REDIS_PASSWORD\" ping | grep -q PONG"
else
  echo "Skipping Redis auth ping (REDIS_PASSWORD missing in $ENV_FILE)"
fi

echo
echo "Passed: $passed"
echo "Failed: $failed"

if [[ $failed -gt 0 ]]; then
  exit 1
fi
