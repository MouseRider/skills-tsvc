#!/usr/bin/env bash
# tsvc-spawn.sh — Create a new topic and move exchanges from the current topic
#
# Usage: tsvc-spawn.sh <title> <from_line_number>
#   title           — Name for the new topic
#   from_line_number — Line number in current topic's conversation.jsonl to start moving from
#                      (1-indexed; all lines from this number to end get moved)
#
# What it does:
#   1. Creates a new topic via tsvc-manager.js
#   2. Moves exchanges from current topic's conversation.jsonl (from_line onward) to new topic
#   3. Updates exchange counts in index.json
#   4. Refreshes both topics' context files
#   5. Triggers a topic switch to the new topic
#
# The calling agent is responsible for:
#   - Identifying the semantic boundary (from_line_number)
#   - Asking for the topic name if not obvious
#   - Triggering self-reset after this script completes

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
TSVC_DIR="$WORKSPACE/tsvc"
SCRIPTS_DIR="$TSVC_DIR/scripts"
TOPICS_DIR="$TSVC_DIR/topic_files"
INDEX_FILE="$TOPICS_DIR/index.json"

source "$SCRIPTS_DIR/tsvc-log.sh" 2>/dev/null || true

TITLE="$1"
FROM_LINE="$2"

if [[ -z "$TITLE" || -z "$FROM_LINE" ]]; then
  echo '{"error":"Usage: tsvc-spawn.sh <title> <from_line_number>"}'
  exit 1
fi

# Get current active topic
CURRENT_TOPIC=$(node -e "const i=require('$INDEX_FILE');console.log(i.activeTopic)")
if [[ -z "$CURRENT_TOPIC" ]]; then
  echo '{"error":"No active topic"}'
  exit 1
fi

CURRENT_CONV="$TOPICS_DIR/$CURRENT_TOPIC/conversation.jsonl"
if [[ ! -f "$CURRENT_CONV" ]]; then
  echo '{"error":"No conversation file for current topic"}'
  exit 1
fi

TOTAL_LINES=$(wc -l < "$CURRENT_CONV")
if (( FROM_LINE < 1 || FROM_LINE > TOTAL_LINES )); then
  echo "{\"error\":\"from_line $FROM_LINE out of range (1-$TOTAL_LINES)\"}"
  exit 1
fi

# Count how many exchanges we're moving
MOVE_COUNT=$(( TOTAL_LINES - FROM_LINE + 1 ))

# 1. Create new topic (this also sets it as active in index)
CREATE_OUTPUT=$(node "$SCRIPTS_DIR/tsvc-manager.js" create "$TITLE")
NEW_TOPIC=$(echo "$CREATE_OUTPUT" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")

if [[ -z "$NEW_TOPIC" ]]; then
  echo '{"error":"Failed to create topic"}'
  exit 1
fi

# 2. Ensure new topic conversation dir exists
mkdir -p "$TOPICS_DIR/$NEW_TOPIC"

# 3. Move exchanges: tail from FROM_LINE to new topic, then truncate current
tail -n +"$FROM_LINE" "$CURRENT_CONV" > "$TOPICS_DIR/$NEW_TOPIC/conversation.jsonl"
head -n $(( FROM_LINE - 1 )) "$CURRENT_CONV" > "${CURRENT_CONV}.tmp"
mv "${CURRENT_CONV}.tmp" "$CURRENT_CONV"

# 4. Update exchange counts in index
REMAINING_LINES=$(wc -l < "$CURRENT_CONV")
node -e "
const fs = require('fs');
const idx = JSON.parse(fs.readFileSync('$INDEX_FILE', 'utf8'));
idx.topics['$CURRENT_TOPIC'].exchangeCount = $REMAINING_LINES;
idx.topics['$NEW_TOPIC'].exchangeCount = $MOVE_COUNT;
fs.writeFileSync('$INDEX_FILE', JSON.stringify(idx, null, 2));
"

# 5. Refresh context files for both topics
node "$SCRIPTS_DIR/tsvc-manager.js" refresh "$CURRENT_TOPIC" 2>/dev/null || true
node "$SCRIPTS_DIR/tsvc-manager.js" refresh "$NEW_TOPIC" 2>/dev/null || true

tsvc_log "SPAWN" "Created $NEW_TOPIC ('$TITLE') from $CURRENT_TOPIC, moved $MOVE_COUNT exchanges (lines $FROM_LINE-$TOTAL_LINES)" 2>/dev/null || true

echo "{\"action\":\"spawned\",\"newTopic\":\"$NEW_TOPIC\",\"title\":\"$TITLE\",\"movedExchanges\":$MOVE_COUNT,\"fromTopic\":\"$CURRENT_TOPIC\",\"remainingExchanges\":$REMAINING_LINES}"
