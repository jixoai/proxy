#!/usr/bin/env bash
set -euo pipefail

# Replay a captured Anthropic request both to upstream and the local proxy,
# saving raw headers/bodies for diffing.

LOG_FILE=${1:-".tmp/anthropic-logs/2025-12-09T09-33-39-482Z_1_request.json"}

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not found." >&2
  exit 1
fi

if [ ! -f "$LOG_FILE" ]; then
  echo "Log file not found: $LOG_FILE" >&2
  exit 1
fi

BODY_FILE=$(mktemp /tmp/anthropic-body-XXXX.json)
jq '.bodyParsed' "$LOG_FILE" >"$BODY_FILE"

API_KEY=$(jq -r '.headers["x-api-key"] // empty' "$LOG_FILE")
if [ -z "$API_KEY" ]; then
  echo "x-api-key missing in log file." >&2
  exit 1
fi

header() {
  local key=$1
  jq -r ".headers[\"$key\"] // empty" "$LOG_FILE"
}

COMMON_HEADERS=(
  -H "anthropic-version: $(header anthropic-version)"
  -H "content-type: $(header content-type)"
  -H "accept: $(header accept)"
  -H "user-agent: $(header user-agent)"
  -H "accept-encoding: $(header accept-encoding)"
  -H "x-api-key: $API_KEY"
)

UP_URL="https://api.deepseek.com/anthropic/v1/messages"
PX_URL="http://localhost:20002/anthropic/v1/messages"

STAMP=$(date +%s)
UP_H="/tmp/upstream_headers_${STAMP}.txt"
UP_B="/tmp/upstream_body_${STAMP}.txt"
PX_H="/tmp/proxy_headers_${STAMP}.txt"
PX_B="/tmp/proxy_body_${STAMP}.txt"

echo "== upstream: $UP_URL =="
curl -v -N --raw -D "$UP_H" \
  "${COMMON_HEADERS[@]}" \
  "$UP_URL" \
  --data-binary @"$BODY_FILE" | tee "$UP_B"

echo
echo "== proxy: $PX_URL =="
curl -v -N --raw -D "$PX_H" \
  "${COMMON_HEADERS[@]}" \
  "$PX_URL" \
  --data-binary @"$BODY_FILE" | tee "$PX_B"

echo
echo "Saved files:"
echo "  upstream headers: $UP_H"
echo "  upstream body   : $UP_B"
echo "  proxy headers   : $PX_H"
echo "  proxy body      : $PX_B"
