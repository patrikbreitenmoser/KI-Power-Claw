#!/usr/bin/env bash
# Send a message to your Telegram bot from the command line.
# Usage: ./scripts/notify.sh "Your message here"
#
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID from .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env not found at $ENV_FILE"
  exit 1
fi

# Read values from .env
TELEGRAM_BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2-)
ALLOWED_CHAT_ID=$(grep '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d'=' -f2-)

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not set in .env"
  exit 1
fi

if [ -z "$ALLOWED_CHAT_ID" ]; then
  echo "Error: ALLOWED_CHAT_ID not set in .env"
  exit 1
fi

MESSAGE="${1:-}"
if [ -z "$MESSAGE" ]; then
  echo "Usage: $0 \"message\""
  exit 1
fi

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${ALLOWED_CHAT_ID}" \
  -d "text=${MESSAGE}" \
  -d "parse_mode=HTML" \
  > /dev/null

echo "Message sent."
