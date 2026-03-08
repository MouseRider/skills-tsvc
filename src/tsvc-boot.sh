#!/bin/bash
# tsvc-boot.sh — Deterministic boot sequence for TSVC
# Called by the LLM on session start (single exec call, not markdown instructions)
# Outputs JSON that the LLM uses to formulate its response.
#
# Exit codes:
#   0 = success (check output JSON for type)
# Output JSON shapes:
#   {"type":"topic_switch", "targetTopic":"...", "triggeringMessage":"...", "context":"...", "telemetry":{...}}
#   {"type":"normal_boot"}

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
TSVC_DIR="$WORKSPACE/tsvc"
PENDING="$TSVC_DIR/pending-reset.json"

# Logging
source "$TSVC_DIR/scripts/tsvc-log.sh" "BOOT"

# ═══════════════════════════════════════════════
# PHASE 1: Check for pending topic switch
# ═══════════════════════════════════════════════
if [ ! -f "$PENDING" ]; then
  tsvc_log INFO "Normal boot (no pending reset)"
  # Sync whisper vocabulary for active topic
  bash "$WORKSPACE/scripts/tsvc-vocab.sh" sync 2>/dev/null || true
  echo '{"type":"normal_boot"}'
  exit 0
fi

REASON=$(jq -r '.reason // "none"' "$PENDING" 2>/dev/null || echo "none")
if [ "$REASON" != "topic_switch" ]; then
  tsvc_log INFO "Normal boot (pending reason=$REASON, not topic_switch)"
  echo '{"type":"normal_boot"}'
  exit 0
fi

tsvc_log INFO "Topic switch detected in pending-reset.json"

# ═══════════════════════════════════════════════
# PHASE 2: Topic switch detected — deterministic execution
# ═══════════════════════════════════════════════

# 2a. Capture post-reset telemetry
TELEMETRY=$(bash "$TSVC_DIR/scripts/capture-post-reset-telemetry.sh" 2>/dev/null || echo '{"status":"telemetry_error"}')

# 2b. Extract target topic
TARGET_TOPIC=$(jq -r '.toTopic.id' "$PENDING")
tsvc_log INFO "Switch target: $TARGET_TOPIC ($TARGET_TITLE)"
TARGET_TITLE=$(jq -r '.toTopic.title // ""' "$PENDING")

# 2c. Extract triggering message and recent exchanges
TRIGGERING_MSG=$(jq -r '.triggeringMessage // ""' "$PENDING")
RECENT_EXCHANGES=$(jq -c '.recentExchanges // []' "$PENDING")
RECENT_DECISIONS=$(jq -c '.recentDecisions // []' "$PENDING")

# 2d. Switch TSVC manager to target topic
SWITCH_RESULT=$(node "$TSVC_DIR/scripts/tsvc-manager.js" switch "$TARGET_TOPIC" 2>/dev/null || echo '{"error":"switch_failed"}')

# 2e. Load topic context
CONTEXT=""
CONTEXT_FILE="$TSVC_DIR/contexts/${TARGET_TOPIC}.md"
# (logging after context check below)
if [ -f "$CONTEXT_FILE" ]; then
  CONTEXT=$(cat "$CONTEXT_FILE")
fi

# 2e2. Load where-are-we state file
STATE=""
STATE_FILE="$TSVC_DIR/topic_files/${TARGET_TOPIC}/where-are-we.md"
if [ -f "$STATE_FILE" ]; then
  STATE=$(cat "$STATE_FILE")
fi

# 2e3. Extract pending notifications count
PENDING_NOTIFICATIONS=0
if [ -n "$STATE" ]; then
  PENDING_NOTIFICATIONS=$(echo "$STATE" | sed -n '/^## Pending Notifications/,/^## /p' | grep -c "^- " || echo 0)
fi

# 2f. Generate semantic resume hint from topic conversation
RESUME_HINT=""
CONV_FILE="$TSVC_DIR/topic_files/${TARGET_TOPIC}/conversation.jsonl"
if [ -f "$CONV_FILE" ]; then
  # Get last 5 exchanges, build a resume hint
  LAST_EXCHANGES=$(tail -10 "$CONV_FILE" | jq -sc '.' 2>/dev/null || echo '[]')
  LAST_USER_MSG=$(echo "$LAST_EXCHANGES" | jq -r '[.[] | select(.role=="user")] | last | .text // ""' 2>/dev/null || echo '')
  LAST_ASSISTANT_MSG=$(echo "$LAST_EXCHANGES" | jq -r '[.[] | select(.role=="assistant")] | last | .text // ""' 2>/dev/null || echo '')
  
  # Check if last user message was a question (ends with ?)
  if echo "$LAST_USER_MSG" | grep -q '?'; then
    RESUME_TYPE="unanswered_question"
  else
    RESUME_TYPE="continuation"
  fi
  
  RESUME_HINT=$(jq -n \
    --arg type "$RESUME_TYPE" \
    --arg lastUserMsg "$LAST_USER_MSG" \
    --arg lastAssistantMsg "$LAST_ASSISTANT_MSG" \
    --argjson lastExchanges "$LAST_EXCHANGES" \
    '{type: $type, lastUserMessage: $lastUserMsg, lastAssistantMessage: $lastAssistantMsg, lastExchanges: $lastExchanges}')
fi

# 2g. Cleanup pending files
rm -f "$PENDING" "$TSVC_DIR/next-topic.txt" 2>/dev/null
tsvc_log INFO "Cleaned up pending files"

# 2g. Patch t2 telemetry
T2_RESULT=$(bash "$TSVC_DIR/scripts/patch-t2-telemetry.sh" 2>/dev/null || echo '{"status":"t2_error"}')

# ═══════════════════════════════════════════════
# PHASE 3: Output structured result for LLM
tsvc_log INFO "Boot complete, outputting structured result"
# Sync whisper vocabulary for new topic
bash "$WORKSPACE/scripts/tsvc-vocab.sh" sync 2>/dev/null || true
# ═══════════════════════════════════════════════
jq -n \
  --arg type "topic_switch" \
  --arg targetTopic "$TARGET_TOPIC" \
  --arg targetTitle "$TARGET_TITLE" \
  --arg triggeringMessage "$TRIGGERING_MSG" \
  --arg context "$CONTEXT" \
  --arg state "$STATE" \
  --argjson pendingNotifications "$PENDING_NOTIFICATIONS" \
  --argjson recentExchanges "$RECENT_EXCHANGES" \
  --argjson recentDecisions "$RECENT_DECISIONS" \
  --argjson telemetry "$TELEMETRY" \
  --argjson switchResult "$SWITCH_RESULT" \
  --argjson resumeHint "${RESUME_HINT:-null}" \
  '{
    type: $type,
    targetTopic: $targetTopic,
    targetTitle: $targetTitle,
    triggeringMessage: $triggeringMessage,
    context: $context,
    state: $state,
    pendingNotifications: $pendingNotifications,
    resumeHint: $resumeHint,
    recentExchanges: $recentExchanges,
    recentDecisions: $recentDecisions,
    telemetry: $telemetry,
    switchResult: $switchResult
  }'
