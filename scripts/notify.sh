#!/usr/bin/env bash
# Send a message or photo to your Telegram bot from the command line.
# Usage:
#   ./scripts/notify.sh "Your message here"
#   ./scripts/notify.sh "Caption text" /path/to/image.png
#   ./scripts/notify.sh "MEDIA: /path/to/image.png"   (auto-detected)
#
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS from .env.
# Uses the first ID from ALLOWED_USER_IDS.

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
ALLOWED_USER_IDS=$(grep '^ALLOWED_USER_IDS=' "$ENV_FILE" | cut -d'=' -f2-)
ALLOWED_USER_ID=$(echo "$ALLOWED_USER_IDS" | cut -d',' -f1 | xargs)

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not set in .env"
  exit 1
fi

if [ -z "$ALLOWED_USER_ID" ]; then
  echo "Error: ALLOWED_USER_IDS not set in .env"
  exit 1
fi

MESSAGE="${1:-}"
if [ -z "$MESSAGE" ]; then
  echo "Usage: $0 \"message\" [/path/to/image.png]"
  exit 1
fi

PHOTO_PATH="${2:-}"

# Auto-detect MEDIA: prefix in message
if [ -z "$PHOTO_PATH" ] && echo "$MESSAGE" | grep -qE '^MEDIA:\s*.+'; then
  PHOTO_PATH=$(echo "$MESSAGE" | grep -oE 'MEDIA:\s*.+' | head -1 | sed 's/^MEDIA:[[:space:]]*//')
  MESSAGE=""
fi

# Also extract MEDIA: lines embedded in multi-line message
if [ -z "$PHOTO_PATH" ] && echo "$MESSAGE" | grep -qE 'MEDIA:\s*.+'; then
  PHOTO_PATH=$(echo "$MESSAGE" | grep -oE 'MEDIA:\s*.+' | head -1 | sed 's/^MEDIA:[[:space:]]*//')
  MESSAGE=$(echo "$MESSAGE" | grep -vE '^MEDIA:\s*.+' | xargs)
fi

if [ -n "$PHOTO_PATH" ] && [ -f "$PHOTO_PATH" ]; then
  # Send photo (with optional caption)
  if [ -n "$MESSAGE" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto" \
      -F "chat_id=${ALLOWED_USER_ID}" \
      -F "photo=@${PHOTO_PATH}" \
      -F "caption=${MESSAGE}" \
      -F "parse_mode=HTML" \
      > /dev/null
  else
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto" \
      -F "chat_id=${ALLOWED_USER_ID}" \
      -F "photo=@${PHOTO_PATH}" \
      > /dev/null
  fi
  echo "Photo sent."
elif [ -n "$PHOTO_PATH" ]; then
  echo "Warning: Photo file not found: $PHOTO_PATH -- sending as text instead."
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${ALLOWED_USER_ID}" \
    -d "text=${MESSAGE}" \
    -d "parse_mode=HTML" \
    > /dev/null
  echo "Message sent."
else
  # Send text only
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${ALLOWED_USER_ID}" \
    -d "text=${MESSAGE}" \
    -d "parse_mode=HTML" \
    > /dev/null
  echo "Message sent."
fi
