#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"
BASE_URL="http://127.0.0.1:3001"
PROFILE_URL=""
ACCOUNT_ID=""
TEXT="Hi, test message from automation"
API_KEY_DEFAULT="dev-api-secret-key-change-in-production"

usage() {
  cat <<'EOF'
Usage:
  bash deployment/e2e-smoke.sh --profile-url <linkedin-profile-url> [--account-id <id>] [--text <message>]

Example:
  bash deployment/e2e-smoke.sh \
    --profile-url "https://www.linkedin.com/in/some-profile/" \
    --account-id "alice"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile-url)
      PROFILE_URL="${2:-}"
      shift 2
      ;;
    --account-id)
      ACCOUNT_ID="${2:-}"
      shift 2
      ;;
    --text)
      TEXT="${2:-}"
      shift 2
      ;;
    --base-url)
      BASE_URL="${2:-}"
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

if [[ -z "$PROFILE_URL" ]]; then
  echo "Missing --profile-url"
  usage
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

API_KEY="$(grep -E '^API_SECRET=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
if [[ -z "$API_KEY" ]]; then
  API_KEY="$API_KEY_DEFAULT"
fi

if [[ -z "$ACCOUNT_ID" ]]; then
  ACCOUNT_ID="$(grep -E '^ACCOUNT_IDS=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | cut -d, -f1 | xargs || true)"
fi

if [[ -z "$ACCOUNT_ID" ]]; then
  echo "Could not resolve ACCOUNT_ID. Pass --account-id explicitly."
  exit 1
fi

call_api() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -H "X-Api-Key: $API_KEY" -H "Content-Type: application/json" -X "$method" "$url" -d "$body"
  else
    curl -sS -H "X-Api-Key: $API_KEY" -X "$method" "$url"
  fi
}

echo "1) Health"
curl -fsS "$BASE_URL/health"
echo
echo

echo "2) Verify session for account: $ACCOUNT_ID"
VERIFY_RESP="$(call_api POST "$BASE_URL/accounts/$ACCOUNT_ID/verify" || true)"
echo "$VERIFY_RESP"
if [[ "$VERIFY_RESP" != *"\"ok\":true"* ]]; then
  echo
  echo "E2E blocked: session is not active. Re-import LinkedIn cookies, then retry."
  exit 2
fi
echo

echo "3) Send message to: $PROFILE_URL"
SAFE_TEXT="${TEXT//\"/\\\"} (E2E $(date -u +%Y-%m-%dT%H:%M:%SZ))"
PAYLOAD="{\"accountId\":\"$ACCOUNT_ID\",\"profileUrl\":\"$PROFILE_URL\",\"text\":\"$SAFE_TEXT\"}"
SEND_RESP="$(call_api POST "$BASE_URL/messages/send-new" "$PAYLOAD" || true)"
echo "$SEND_RESP"
if [[ "$SEND_RESP" == *"\"error\""* ]]; then
  echo
  echo "Message send failed. Check error above (connection status / messageability / session)."
  exit 3
fi
echo

echo "4) Unified inbox quick check"
INBOX_RESP="$(call_api GET "$BASE_URL/inbox/unified?limit=20" || true)"
echo "$INBOX_RESP"
echo
echo "E2E smoke completed."
