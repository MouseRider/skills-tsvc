#!/bin/bash
# TSVC Switch — Pre-reset telemetry capture + pending-reset.json writer
#
# Usage: bash tsvc-switch.sh <target_topic_id> "<triggering_message>" [from_topic_id]
#
# Captures:
#   - Pre-switch context size (current session .jsonl)
#   - Pre-switch session message count
#   - From-topic exchange count, decision count
#   - To-topic exchange count
#   - Timestamp (t0_initiated)
#
# Writes pending-reset.json with all telemetry embedded.
# The post-reset session completes the telemetry (t1_loaded, t2_replied, context sizes).

set -euo pipefail
trap '' PIPE  # Prevent SIGPIPE from sort|head pipelines killing the script

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
TSVC_DIR="$WORKSPACE/tsvc"
SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
MANAGER="node $TSVC_DIR/scripts/tsvc-manager.js"

# Logging
source "$TSVC_DIR/scripts/tsvc-log.sh" "SWITCH"

RAW_TARGET="$1"
TRIGGERING_MSG="${2:-}"
FROM_TOPIC="${3:-}"

# Fuzzy-match topic ID (like git short hashes)
TOPIC_FILES_DIR="$TSVC_DIR/topic_files"
if [ -d "$TOPIC_FILES_DIR/$RAW_TARGET" ]; then
  TARGET_TOPIC="$RAW_TARGET"
else
  # Try prefix match against existing topic directories
  MATCHES=$(find "$TOPIC_FILES_DIR" -maxdepth 1 -type d -name "${RAW_TARGET}*" 2>/dev/null | xargs -I{} basename {} | grep -v '^topic_files$' || true)
  MATCH_COUNT=$(echo "$MATCHES" | grep -c . 2>/dev/null || echo 0)
  if [ "$MATCH_COUNT" -eq 1 ]; then
    TARGET_TOPIC="$MATCHES"
    echo "{\"fuzzy_match\":\"$RAW_TARGET -> $TARGET_TOPIC\"}" >&2
  elif [ "$MATCH_COUNT" -gt 1 ]; then
    echo "{\"error\":\"ambiguous_topic_id\",\"input\":\"$RAW_TARGET\",\"matches\":$(echo "$MATCHES" | jq -Rs 'split("\n") | map(select(length > 0))')}" >&2
    exit 1
  else
    echo "{\"error\":\"topic_not_found\",\"input\":\"$RAW_TARGET\",\"available\":$(ls "$TOPIC_FILES_DIR" 2>/dev/null | jq -Rs 'split("\n") | map(select(length > 0))')}" >&2
    exit 1
  fi
fi

tsvc_log INFO "Switch initiated: $RAW_TARGET (from: ${FROM_TOPIC:-auto-detect})"
# Auto-detect from_topic if not provided
if [ -z "$FROM_TOPIC" ]; then
  FROM_TOPIC=$($MANAGER status 2>/dev/null | jq -r '.activeTopic.id // empty' 2>/dev/null || echo "")
fi

# Get current session file (most recently modified .jsonl)
CURRENT_SESSION=$(find "$SESSIONS_DIR" -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-) || true

# Pre-switch metrics
PRE_CONTEXT_BYTES=0
PRE_SESSION_MESSAGES=0
if [ -n "$CURRENT_SESSION" ]; then
  PRE_CONTEXT_BYTES=$(stat -c%s "$CURRENT_SESSION" 2>/dev/null || echo 0)
  PRE_SESSION_MESSAGES=$(wc -l < "$CURRENT_SESSION" 2>/dev/null || echo 0)
fi

# From-topic metrics
FROM_EXCHANGES=0
FROM_DECISIONS=0
FROM_TITLE=""
if [ -n "$FROM_TOPIC" ]; then
  FROM_STATE_FILE="$TSVC_DIR/topic_files/$FROM_TOPIC/state.json"
  if [ -f "$FROM_STATE_FILE" ]; then
    FROM_EXCHANGES=$(jq '.exchangeCount // 0' "$FROM_STATE_FILE" 2>/dev/null || echo 0)
    FROM_DECISIONS=$(jq '.decisions | length' "$FROM_STATE_FILE" 2>/dev/null || echo 0)
    FROM_TITLE=$(jq -r '.title // ""' "$FROM_STATE_FILE" 2>/dev/null || echo "")
  fi
fi

# To-topic metrics
TO_EXCHANGES=0
TO_TITLE=""
TO_DECISIONS=0
TO_STATE_FILE="$TSVC_DIR/topic_files/$TARGET_TOPIC/state.json"
if [ -f "$TO_STATE_FILE" ]; then
  TO_EXCHANGES=$(jq '.exchangeCount // 0' "$TO_STATE_FILE" 2>/dev/null || echo 0)
  TO_TITLE=$(jq -r '.title // ""' "$TO_STATE_FILE" 2>/dev/null || echo "")
  TO_DECISIONS=$(jq '.decisions | length' "$TO_STATE_FILE" 2>/dev/null || echo 0)
fi

# Get recent exchanges from target topic for context
RECENT_EXCHANGES="[]"
CONVO_FILE="$TSVC_DIR/topic_files/$TARGET_TOPIC/conversation.jsonl"
if [ -f "$CONVO_FILE" ]; then
  RECENT_EXCHANGES=$(tail -5 "$CONVO_FILE" | jq -s '.' 2>/dev/null || echo "[]")
fi

# Get recent decisions from target topic
RECENT_DECISIONS="[]"
if [ -f "$TO_STATE_FILE" ]; then
  RECENT_DECISIONS=$(jq '[.decisions[-5:] // [] | .[] ]' "$TO_STATE_FILE" 2>/dev/null || echo "[]")
fi

T0=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)

# Finalize the current topic's state file before switching out
tsvc_log INFO "Finalizing outgoing topic: $FROM_TOPIC"
if [ -n "$FROM_TOPIC" ]; then
  bash "$TSVC_DIR/scripts/tsvc-state.sh" finalize --topic "$FROM_TOPIC" >/dev/null 2>&1 || true
fi

# Write pending-reset.json with embedded telemetry
cat > "$TSVC_DIR/pending-reset.json" << RESETEOF
{
  "reason": "topic_switch",
  "createdAt": "$T0",
  "fromTopic": {
    "id": "$FROM_TOPIC",
    "title": "$FROM_TITLE"
  },
  "toTopic": {
    "id": "$TARGET_TOPIC",
    "title": "$TO_TITLE"
  },
  "triggeringMessage": $(echo "$TRIGGERING_MSG" | jq -Rs .),
  "recentExchanges": $RECENT_EXCHANGES,
  "recentDecisions": $RECENT_DECISIONS,
  "telemetry": {
    "t0_initiated": "$T0",
    "t1_new_session_loaded": null,
    "t2_first_reply_sent": null,
    "preSwitch": {
      "sessionSizeBytes": $PRE_CONTEXT_BYTES,
      "sessionMessageCount": $PRE_SESSION_MESSAGES,
      "fromTopicExchanges": $FROM_EXCHANGES,
      "fromTopicDecisions": $FROM_DECISIONS
    },
    "postSwitch": {
      "contextSizeBytesLoaded": null,
      "toTopicExchanges": $TO_EXCHANGES,
      "toTopicDecisions": $TO_DECISIONS,
      "bootFilesRead": null
    }
  }
}
RESETEOF

# Also write next-topic.txt as fallback
echo "$TARGET_TOPIC" > "$TSVC_DIR/next-topic.txt"
tsvc_log INFO "pending-reset.json written, target=$TARGET_TOPIC, preContext=${PRE_CONTEXT_BYTES}b, preMessages=$PRE_SESSION_MESSAGES"

echo "{\"status\":\"pending-reset-written\",\"t0\":\"$T0\",\"target\":\"$TARGET_TOPIC\",\"preContextBytes\":$PRE_CONTEXT_BYTES,\"preMessages\":$PRE_SESSION_MESSAGES}"
