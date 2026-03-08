#!/usr/bin/env bash
# submind-result-router.sh — Route sub-mind completion results to the correct topic
#
# Checks a board task's tags for a "topic:<topic_id>" tag, then routes
# the result message to that topic's where-are-we.md via tsvc-route-async.sh.
#
# Usage:
#   submind-result-router.sh --task TASK_ID --source "submind" --message "Result summary"
#   submind-result-router.sh --topic TOPIC_ID --source "majordomo" --message "Result summary"
#
# If --task is provided, looks up the topic from the task's tags.
# If --topic is provided directly, skips the lookup.
#
# Exit codes:
#   0 = success (ACTIVE or FILED)
#   1 = error (task not found, no topic tag, etc.)
#   2 = no topic tag found (result should be processed in current session)

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
TSVC_DIR="$WORKSPACE/tsvc"
ROUTE_SCRIPT="$TSVC_DIR/scripts/tsvc-route-async.sh"

# Logging
source "$TSVC_DIR/scripts/tsvc-log.sh" "SUBMIND-ROUTER"

# Parse args
TASK_ID=""
TOPIC_ID=""
SOURCE=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)    TASK_ID="$2"; shift 2 ;;
    --topic)   TOPIC_ID="$2"; shift 2 ;;
    --source)  SOURCE="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$SOURCE" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: submind-result-router.sh (--task TASK_ID | --topic TOPIC_ID) --source SOURCE --message MESSAGE" >&2
  exit 1
fi

if [ -z "$TASK_ID" ] && [ -z "$TOPIC_ID" ]; then
  echo "ERROR: Must provide either --task or --topic" >&2
  exit 1
fi

# If task ID provided, look up topic from tags
if [ -n "$TASK_ID" ] && [ -z "$TOPIC_ID" ]; then
  # Query board for task tags
  TASK_JSON=$(mcporter call agent-board.board_list_tasks taskId="$TASK_ID" 2>/dev/null || echo "[]")
  
  # If board_list_tasks doesn't support taskId filter, try getting via project scan
  if [ "$TASK_JSON" = "[]" ] || [ -z "$TASK_JSON" ]; then
    # Try both projects
    for proj in proj_9102e4878e5967ae proj_7d54e5446b52eb40; do
      TASK_JSON=$(mcporter call agent-board.board_list_tasks projectId="$proj" 2>/dev/null || echo "[]")
      FOUND=$(echo "$TASK_JSON" | node -e "
        const d=require('fs').readFileSync('/dev/stdin','utf8');
        try {
          const tasks=JSON.parse(d);
          const t=tasks.find(t=>t.id==='$TASK_ID');
          if(t) console.log(JSON.stringify(t));
          else console.log('');
        } catch { console.log(''); }
      " 2>/dev/null)
      [ -n "$FOUND" ] && break
    done
    TASK_JSON="$FOUND"
  fi

  if [ -z "$TASK_JSON" ]; then
    echo "ERROR: Task $TASK_ID not found on any board" >&2
    exit 1
  fi

  # Extract topic tag
  TOPIC_ID=$(echo "$TASK_JSON" | node -e "
    const d=require('fs').readFileSync('/dev/stdin','utf8');
    try {
      const task=JSON.parse(d);
      const tags=Array.isArray(task.tags)?task.tags:(Array.isArray(task)?task[0]?.tags:[]);
      const topicTag=(tags||[]).find(t=>t.startsWith('topic:'));
      if(topicTag) console.log(topicTag.replace('topic:',''));
      else console.log('');
    } catch { console.log(''); }
  " 2>/dev/null)

  if [ -z "$TOPIC_ID" ]; then
    tsvc_log WARN "Task $TASK_ID has no topic: tag — processing in current session"
    echo "NO_TOPIC_TAG"
    echo "Task $TASK_ID has no topic: tag. Process in current session." >&2
    exit 2
  fi
fi

tsvc_log INFO "Routing result to topic $TOPIC_ID (source=$SOURCE)"

# Route via tsvc-route-async.sh
bash "$ROUTE_SCRIPT" --topic "$TOPIC_ID" --source "$SOURCE" --message "$MESSAGE"
