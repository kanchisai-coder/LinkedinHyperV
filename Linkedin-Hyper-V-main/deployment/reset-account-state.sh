#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"
ACCOUNT_ID="${1:-}"

if [[ -z "$ACCOUNT_ID" ]]; then
  echo "Usage: bash deployment/reset-account-state.sh <accountId>"
  echo "Example: bash deployment/reset-account-state.sh alice"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}"
  exit 1
fi

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE")

REDIS_PASSWORD_VALUE="$(grep -E '^[[:space:]]*REDIS_PASSWORD[[:space:]]*=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
if [[ -z "$REDIS_PASSWORD_VALUE" ]]; then
  echo "REDIS_PASSWORD is missing in ${ENV_FILE}"
  exit 1
fi

TODAY_UTC="$(date -u +%F)"
echo "Resetting state for account: ${ACCOUNT_ID} (UTC day: ${TODAY_UTC})"

redis_cmd() {
  "${COMPOSE[@]}" exec -T redis redis-cli -a "$REDIS_PASSWORD_VALUE" "$@"
}

# Remove stale UI activity entries and counters that can show false "sent" history.
redis_cmd DEL "activity:log:${ACCOUNT_ID}" >/dev/null
redis_cmd DEL "stats:messages:${ACCOUNT_ID}" >/dev/null
redis_cmd DEL "stats:connections:${ACCOUNT_ID}" >/dev/null

# Reset today's rate-limit buckets so live inbox sync can run again.
for action in messagesSent connectRequests profileViews searchQueries inboxReads; do
  redis_cmd DEL "ratelimit:${ACCOUNT_ID}:${action}:${TODAY_UTC}" >/dev/null
done

echo "Restarting worker to clear in-memory caches..."
"${COMPOSE[@]}" restart worker >/dev/null

echo "Done. Re-import cookies and test send again."
