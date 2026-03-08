#!/usr/bin/env bash
# tsvc-vocab.sh — Topic-scoped transcription vocabulary manager
# Reads/writes whisper_prompt from active topic's where-are-we.md Key Facts
# and syncs to tsvc/active-whisper-prompt.txt for the transcription pipeline.
#
# Usage:
#   tsvc-vocab.sh get                          # Print active topic's vocabulary
#   tsvc-vocab.sh set "term1, term2, term3"    # Set vocabulary for active topic
#   tsvc-vocab.sh sync                         # Sync active topic vocab to prompt file
#   tsvc-vocab.sh get --topic TOPIC_ID         # Get specific topic's vocabulary

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
TSVC_DIR="$WORKSPACE/tsvc"
INDEX="$TSVC_DIR/topic_files/index.json"
VOCAB_OUTPUT="$TSVC_DIR/active-whisper-prompt.txt"

# Logging
source "$TSVC_DIR/scripts/tsvc-log.sh" "VOCAB"

# Parse args
ACTION="${1:-get}"
VALUE="${2:-}"
TOPIC_OVERRIDE=""

# Check for --topic flag
for i in "$@"; do
  if [ "$i" = "--topic" ]; then
    shift_next=1
  elif [ "${shift_next:-}" = "1" ]; then
    TOPIC_OVERRIDE="$i"
    shift_next=""
  fi
done

get_active_topic() {
  node -e "
    const i = require('$INDEX');
    const t = Object.entries(i.topics).find(([k,v]) => v.status === 'active');
    if (t) { console.log(t[0]); } else { process.exit(1); }
  " 2>/dev/null
}

TOPIC_ID="${TOPIC_OVERRIDE:-$(get_active_topic)}"
if [ -z "$TOPIC_ID" ]; then
  echo "ERROR: No active topic found and no --topic specified" >&2
  exit 1
fi

STATE_FILE="$TSVC_DIR/topic_files/$TOPIC_ID/where-are-we.md"

# Extract whisper_prompt from Key Facts section
extract_vocab() {
  if [ ! -f "$STATE_FILE" ]; then
    echo ""
    return
  fi
  # Look for "- **Whisper prompt:**" or "- **whisper_prompt:**" in Key Facts
  local vocab=$(sed -n '/^## Key Facts/,/^## /{/[Ww]hisper[_ ][Pp]rompt/p}' "$STATE_FILE" | sed 's/.*[Ww]hisper[_ ][Pp]rompt:\*\*\s*//' | sed 's/^ *//')
  echo "$vocab"
}

case "$ACTION" in
  get)
    VOCAB=$(extract_vocab)
    if [ -n "$VOCAB" ]; then
      echo "$VOCAB"
    else
      echo ""
    fi
    ;;
  set)
    if [ -z "$VALUE" ]; then
      echo "Usage: tsvc-vocab.sh set \"term1, term2, term3\"" >&2
      exit 1
    fi
    if [ ! -f "$STATE_FILE" ]; then
      echo "ERROR: State file not found: $STATE_FILE" >&2
      exit 1
    fi
    # Check if whisper_prompt line already exists
    if grep -q "[Ww]hisper[_ ][Pp]rompt" "$STATE_FILE"; then
      # Replace existing line
      sed -i "s/^- \*\*[Ww]hisper[_ ][Pp]rompt:\*\*.*/- **Whisper prompt:** ${VALUE}/" "$STATE_FILE"
    else
      # Add after the Key Facts comment line
      sed -i '/^## Key Facts$/,/^## /{/^<!-- /a\- **Whisper prompt:** '"${VALUE}"'
      }' "$STATE_FILE"
    fi
    tsvc_log INFO "Set whisper_prompt for $TOPIC_ID: $VALUE"
    echo "Set whisper_prompt: $VALUE"
    ;;
  sync)
    VOCAB=$(extract_vocab)
    echo "$VOCAB" > "$VOCAB_OUTPUT"
    if [ -n "$VOCAB" ]; then
      tsvc_log INFO "Synced vocab to active-whisper-prompt.txt ($TOPIC_ID): ${VOCAB:0:80}..."
    else
      tsvc_log INFO "Synced empty vocab to active-whisper-prompt.txt ($TOPIC_ID)"
    fi
    echo "Synced: $VOCAB_OUTPUT"
    ;;
  *)
    echo "Usage: tsvc-vocab.sh [get|set|sync] [value] [--topic ID]" >&2
    exit 1
    ;;
esac
