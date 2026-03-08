#!/usr/bin/env bash
# tsvc-route-async.sh — Route async reports to the correct topic
#
# When a sub-mind or Majordomo Agent reports back, this determines
# whether to process normally or file into the originating topic's state.
#
# Usage:
#   tsvc-route-async.sh --topic TOPIC_ID --source "majordomo" --message "Profile review done"
#   tsvc-route-async.sh --topic TOPIC_ID --source "submind" --message "Consolidation complete"
#
# Output:
#   ACTIVE  — topic is currently active, process result normally
#   FILED   — topic is paged, notification filed in where-are-we.md
#
# Exit codes:
#   0 = success
#   1 = error (missing args, topic not found)

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
TSVC_DIR="$WORKSPACE/tsvc"
INDEX="$TSVC_DIR/topic_files/index.json"
STATE_SCRIPT="$TSVC_DIR/scripts/tsvc-state.sh"

# Logging
source "$TSVC_DIR/scripts/tsvc-log.sh" "ROUTE-ASYNC"

# Parse args
TOPIC_ID=""
SOURCE=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --topic)  TOPIC_ID="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$TOPIC_ID" ] || [ -z "$SOURCE" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: tsvc-route-async.sh --topic TOPIC_ID --source SOURCE --message MESSAGE" >&2
  echo "" >&2
  echo "  --topic    Topic ID that originated the async work" >&2
  echo "  --source   Who completed it (majordomo, submind, cron)" >&2
  echo "  --message  Result summary" >&2
  exit 1
fi

# Check if topic exists
TOPIC_STATUS=$(node -e "
  const i = require('$INDEX');
  const t = i.topics['$TOPIC_ID'];
  if (t) { console.log(t.status); } else { console.log('not_found'); }
" 2>/dev/null)

if [ "$TOPIC_STATUS" = "not_found" ]; then
  echo "ERROR: Topic $TOPIC_ID not found in index" >&2
  exit 1
fi

TOPIC_TITLE=$(node -e "
  const i = require('$INDEX');
  console.log(i.topics['$TOPIC_ID']?.title || 'Unknown');
" 2>/dev/null)

# Route based on topic status
if [ "$TOPIC_STATUS" = "active" ]; then
  tsvc_log INFO "Topic '$TOPIC_TITLE' is ACTIVE — process normally"
  echo "ACTIVE"
  echo "Topic '$TOPIC_TITLE' is currently active. Process result normally." >&2
else
  # Topic is paged — file the notification
  NOTIFICATION="[${SOURCE}] ${MESSAGE}"
  tsvc_log INFO "Topic '$TOPIC_TITLE' is PAGED — filing notification: $NOTIFICATION"
  
  bash "$STATE_SCRIPT" append notification "$NOTIFICATION" --topic "$TOPIC_ID"
  
  tsvc_log INFO "Filed notification for '$TOPIC_TITLE'"
  echo "FILED"
  echo "Filed notification for paged topic '$TOPIC_TITLE': $NOTIFICATION" >&2
fi
