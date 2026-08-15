#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"
DOMAIN=""
ACCOUNTS=""

usage() {
  cat <<'EOF'
Usage:
  bash deployment/auto-deploy.sh --domain <host> --accounts <id1,id2,...>

Examples:
  bash deployment/auto-deploy.sh --domain myapp.example.com --accounts alice,bob

Environment Variables (when OpenSSL is unavailable):
  API_SECRET              — 64-character hex string for API secret (required)
  REDIS_PASSWORD          — 32-character hex string for Redis (required)
  DB_PASSWORD             — 32-character hex string for PostgreSQL (required)
  SESSION_ENCRYPTION_KEY  — 64-character hex string for sessions (required)
  JWT_SECRET              — 64-character base64 string for JWT tokens (required)
  DASHBOARD_PASSWORD      — Secure password for dashboard access (required)

Note: These variables are only required if openssl is not installed. For production,
use a secure secret store (Vault, AWS Secrets Manager) instead.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --accounts)
      ACCOUNTS="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-.env}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "Missing --domain"
  usage
  exit 1
fi

if [[ -z "$ACCOUNTS" ]]; then
  echo "Missing --accounts"
  usage
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed. Run deployment/ubuntu-setup.sh first."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is not available."
  exit 1
fi

touch "$ENV_FILE"

# Cleanup known invalid line users often add by mistake.
sed -i '/^NewPassword123!=/d' "$ENV_FILE"

set_env() {
  local key="$1"
  local value="$2"
  if grep -Eq "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE"; then
    sed -i -E "s|^[[:space:]]*${key}[[:space:]]*=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

set_if_missing() {
  local key="$1"
  local value="$2"
  local line
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" | tail -n 1 || true)"
  if [[ -n "$line" ]]; then
    local current
    current="$(echo "$line" | sed -E 's/^[[:space:]]*[^=]+=[[:space:]]*//')"
    if [[ -n "$current" ]]; then
      return 0
    fi
  fi
  set_env "$key" "$value"
}

if command -v openssl >/dev/null 2>&1; then
  RAND_API_SECRET="$(openssl rand -hex 32)"
  RAND_REDIS_PASSWORD="$(openssl rand -hex 16)"
  RAND_DB_PASSWORD="$(openssl rand -hex 16)"
  RAND_SESSION_KEY="$(openssl rand -hex 32)"
  RAND_JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
else
  echo "WARNING: openssl is not installed. Using environment variables for secret generation."
  echo "Setting secrets from environment variables..."
  
  RAND_API_SECRET="${API_SECRET:-}"
  RAND_REDIS_PASSWORD="${REDIS_PASSWORD:-}"
  RAND_DB_PASSWORD="${DB_PASSWORD:-}"
  RAND_SESSION_KEY="${SESSION_ENCRYPTION_KEY:-}"
  RAND_JWT_SECRET="${JWT_SECRET:-}"
  
  if [[ -z "$RAND_API_SECRET" ]]; then
    echo "ERROR: API_SECRET environment variable not set and openssl unavailable."
    echo "Please provide: export API_SECRET=<64-char-hex>"
    exit 1
  fi
  
  if [[ -z "$RAND_REDIS_PASSWORD" ]]; then
    echo "ERROR: REDIS_PASSWORD environment variable not set and openssl unavailable."
    echo "Please provide: export REDIS_PASSWORD=<32-char-hex>"
    exit 1
  fi
  
  if [[ -z "$RAND_DB_PASSWORD" ]]; then
    echo "ERROR: DB_PASSWORD environment variable not set and openssl unavailable."
    echo "Please provide: export DB_PASSWORD=<32-char-hex>"
    exit 1
  fi
  
  if [[ -z "$RAND_SESSION_KEY" ]]; then
    echo "ERROR: SESSION_ENCRYPTION_KEY environment variable not set and openssl unavailable."
    echo "Please provide: export SESSION_ENCRYPTION_KEY=<64-char-hex>"
    exit 1
  fi
  
  if [[ -z "$RAND_JWT_SECRET" ]]; then
    echo "ERROR: JWT_SECRET environment variable not set and openssl unavailable."
    echo "Please provide: export JWT_SECRET=<64-char-base64>"
    exit 1
  fi
fi

set_if_missing API_SECRET "$RAND_API_SECRET"
set_if_missing REDIS_PASSWORD "$RAND_REDIS_PASSWORD"
set_if_missing DB_PASSWORD "$RAND_DB_PASSWORD"
set_if_missing SESSION_ENCRYPTION_KEY "$RAND_SESSION_KEY"
set_if_missing JWT_SECRET "$RAND_JWT_SECRET"

# Dashboard password must be set explicitly or provided via environment variable
if [[ -z "$(grep -E "^[[:space:]]*DASHBOARD_PASSWORD[[:space:]]*=" "$ENV_FILE" | tail -n 1 || true)" ]]; then
  DASHBOARD_PASSWORD_VALUE="${DASHBOARD_PASSWORD:-}"
  if [[ -z "$DASHBOARD_PASSWORD_VALUE" ]]; then
    echo "ERROR: DASHBOARD_PASSWORD environment variable not set and not found in .env"
    echo "Please provide: export DASHBOARD_PASSWORD=<secure-password>"
    exit 1
  fi
  set_env DASHBOARD_PASSWORD "$DASHBOARD_PASSWORD_VALUE"
fi

set_if_missing SESSION_MAX_AGE "86400"
set_env ACCOUNT_IDS "$ACCOUNTS"

set_env API_URL "http://worker:3001"
set_env NEXT_PUBLIC_API_URL "https://${DOMAIN}"
set_env NEXT_PUBLIC_WS_URL "wss://${DOMAIN}/ws"

echo "Validating compose config..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" config >/dev/null

echo "Stopping existing stack..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" down || true

echo "Freeing local port 3000 if occupied..."
fuser -k 3000/tcp 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "publish=3000") 2>/dev/null || true

echo "Starting stack..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" up -d --build

echo "Waiting for worker..."
sleep 8

echo "Running Prisma db push..."
DB_PASSWORD_VALUE="$(grep -E '^[[:space:]]*DB_PASSWORD[[:space:]]*=' "$ENV_FILE" | tail -n 1 | sed -E 's/^[[:space:]]*DB_PASSWORD[[:space:]]*=[[:space:]]*//')"
if [[ -z "$DB_PASSWORD_VALUE" ]]; then
  echo "FATAL: DB_PASSWORD is empty in ${ENV_FILE}"
  exit 1
fi
DB_PASSWORD_VALUE="$(echo "$DB_PASSWORD_VALUE" | tr -d '\r' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
export DB_PASSWORD="$DB_PASSWORD_VALUE"

REDIS_PASSWORD_VALUE="$(grep -E '^[[:space:]]*REDIS_PASSWORD[[:space:]]*=' "$ENV_FILE" | tail -n 1 | sed -E 's/^[[:space:]]*REDIS_PASSWORD[[:space:]]*=[[:space:]]*//')"
REDIS_PASSWORD_VALUE="$(echo "$REDIS_PASSWORD_VALUE" | tr -d '\r' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
if [[ -n "$REDIS_PASSWORD_VALUE" ]]; then
  export REDIS_PASSWORD="$REDIS_PASSWORD_VALUE"
fi

DATABASE_URL_VALUE="postgresql://linkedinuser:${DB_PASSWORD_VALUE}@postgres:5432/linkedin_db"

echo "Aligning database password with .env..."
DB_PASSWORD_SQL="${DB_PASSWORD_VALUE//\'/''}"
if ! docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" exec -T postgres sh -lc \
  "psql -v ON_ERROR_STOP=1 -U linkedinuser -d linkedin_db -c \"ALTER USER \\\"linkedinuser\\\" WITH PASSWORD '${DB_PASSWORD_SQL}';\"" >/dev/null 2>&1; then
  echo "Could not update existing postgres password. Recreating postgres data volume..."
  docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" down -v
  docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" up -d --build
  sleep 8
fi

docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" exec -T worker \
  npx prisma db push --schema=prisma/schema.prisma --url="$DATABASE_URL_VALUE"

echo
echo "Deployment status:"
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" ps

echo
echo "Quick health checks:"
curl -fsS http://127.0.0.1:3001/health && echo
curl -fsS -I http://127.0.0.1:3000 | head -n 1

echo
echo "Done. Open: https://${DOMAIN}"
echo "IMPORTANT: Verify DASHBOARD_PASSWORD in ${ENV_FILE} is secure and restart frontend if changed."
