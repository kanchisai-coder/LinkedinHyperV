#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"
NEW_PASSWORD=""

usage() {
  cat <<'EOF'
Usage:
  bash deployment/reset-dashboard-password.sh [new-password] [--env-file .env]

Examples:
  bash deployment/reset-dashboard-password.sh
  bash deployment/reset-dashboard-password.sh "MyNewStrongPass123!"
  bash deployment/reset-dashboard-password.sh --env-file .env.production "MyNewStrongPass123!"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-.env}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$NEW_PASSWORD" ]]; then
        NEW_PASSWORD="$1"
        shift
      else
        echo "Unknown argument: $1"
        usage
        exit 1
      fi
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin not found"
  exit 1
fi

touch "$ENV_FILE"
sed -i 's/\r$//' "$ENV_FILE"

if [[ -z "$NEW_PASSWORD" ]]; then
  # Generate a shell-safe password (no quotes/spaces).
  NEW_PASSWORD="Hyper$(date +%Y)!$(openssl rand -hex 6)"
fi

upsert() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

json_escape() {
  local raw="$1"
  raw="${raw//\\/\\\\}"
  raw="${raw//\"/\\\"}"
  raw="${raw//$'\n'/}"
  printf '%s' "$raw"
}

upsert DASHBOARD_PASSWORD "$NEW_PASSWORD"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE")

echo "Recreating frontend with updated DASHBOARD_PASSWORD..."
"${COMPOSE[@]}" up -d --force-recreate frontend >/dev/null

echo "Waiting for frontend..."
for _ in {1..30}; do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/; then
    break
  fi
  sleep 1
done

ESCAPED_PASSWORD="$(json_escape "$NEW_PASSWORD")"
LOGIN_BODY="{\"password\":\"${ESCAPED_PASSWORD}\",\"rememberMe\":true}"
HTTP_CODE="$(curl -s -o /tmp/dashboard-login-check.json -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -X POST "http://127.0.0.1:3000/api/auth/login" \
  --data "$LOGIN_BODY" || true)"

echo
echo "Login API check status: $HTTP_CODE"
cat /tmp/dashboard-login-check.json || true
echo

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Password reset attempted, but login check failed."
  exit 1
fi

echo
echo "Dashboard password reset successful."
echo "Use this password:"
echo "$NEW_PASSWORD"
