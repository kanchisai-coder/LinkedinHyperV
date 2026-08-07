#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env}"
COMPOSE_ARGS=(-f docker-compose.yml -f docker-compose.prod.yml)

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed. Run deployment/ubuntu-setup.sh first."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is not available."
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy env.example to .env and fill all required values."
  exit 1
fi

# Cleanup known invalid line users often add by mistake.
sed -i '/^NewPassword123!=/d' "$ENV_FILE"

# Load environment for validation and compose.
set -a
source "$ENV_FILE"
set +a

# Ensure DB_PASSWORD is exported even if shell interpolation is strict.
DB_PASSWORD_FROM_FILE="$(grep -E '^[[:space:]]*DB_PASSWORD[[:space:]]*=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
if [[ -n "$DB_PASSWORD_FROM_FILE" ]]; then
  export DB_PASSWORD="$DB_PASSWORD_FROM_FILE"
fi

required_vars=(
  API_SECRET
  REDIS_PASSWORD
  SESSION_ENCRYPTION_KEY
  DB_PASSWORD
  DASHBOARD_PASSWORD
  JWT_SECRET
  NEXT_PUBLIC_API_URL
  NEXT_PUBLIC_WS_URL
)

missing=()
for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    missing+=("$v")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required env variables in $ENV_FILE:"
  printf ' - %s\n' "${missing[@]}"
  exit 1
fi

if [[ ${#SESSION_ENCRYPTION_KEY} -ne 64 ]]; then
  echo "SESSION_ENCRYPTION_KEY must be exactly 64 hex characters."
  exit 1
fi

echo "Validating compose config..."
docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" config >/dev/null

echo "Building and starting production stack..."
docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" up -d --build

echo "Waiting for services..."
sleep 8

echo "Running Prisma schema sync (db push)..."
docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" exec -T worker \
  npx prisma db push --schema=prisma/schema.prisma

echo "Service status:"
docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" ps

echo "Health checks:"
curl -fsS http://127.0.0.1:3001/health && echo
curl -fsS -o /dev/null http://127.0.0.1:3000 && echo "frontend: ok"

echo
echo "Deployment completed."
echo "If Nginx + SSL are configured, open your domain URL."
