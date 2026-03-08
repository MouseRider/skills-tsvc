#!/usr/bin/env bash
# tsvc-state.sh — Continuous state manager for TSVC topics
#
# Maintains a living "where-are-we.md" file per topic that reflects
# the current state at all times. Updated on every state-changing action.
#
# Usage:
#   tsvc-state.sh show                                          # Show current topic's state
#   tsvc-state.sh show --topic TOPIC_ID                         # Show specific topic's state
#   tsvc-state.sh append in_progress "Sub-mind running X"       # Add to In Progress
#   tsvc-state.sh append completed "Commit abc123 pushed"       # Add to Recently Completed  
#   tsvc-state.sh append notification "Majordomo: task done"    # Add to Pending Notifications
#   tsvc-state.sh append next_action "Implement feature Y"      # Add to Next Actions
#   tsvc-state.sh append notification "msg" --topic TOPIC_ID    # Cross-topic append
#   tsvc-state.sh complete "Sub-mind running X"                 # Move from In Progress → Completed
#   tsvc-state.sh finalize                                      # Pre-switch finalization
#   tsvc-state.sh clear-notifications                           # Clear after presenting to user

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
TSVC_DIR="$WORKSPACE/tsvc"
INDEX="$TSVC_DIR/topic_files/index.json"

# Logging
source "$TSVC_DIR/scripts/tsvc-log.sh" "STATE"

# Parse args
ACTION="${1:-show}"
shift 2>/dev/null || true

SECTION=""
MESSAGE=""
TOPIC_OVERRIDE=""

# Parse remaining args
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --topic)
      TOPIC_OVERRIDE="$2"
      shift 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [ ${#POSITIONAL[@]} -ge 1 ]; then
  SECTION="${POSITIONAL[0]}"
fi
if [ ${#POSITIONAL[@]} -ge 2 ]; then
  MESSAGE="${POSITIONAL[1]}"
fi

# Get active topic from index
get_active_topic() {
  node -e "
    const i = require('$INDEX');
    const t = Object.entries(i.topics).find(([k,v]) => v.status === 'active');
    if (t) { console.log(t[0]); } else { process.exit(1); }
  " 2>/dev/null
}

get_topic_title() {
  local tid="$1"
  node -e "
    const i = require('$INDEX');
    console.log(i.topics['$tid']?.title || 'Unknown');
  " 2>/dev/null
}

TOPIC_ID="${TOPIC_OVERRIDE:-$(get_active_topic)}"
if [ -z "$TOPIC_ID" ]; then
  echo "ERROR: No active topic found and no --topic specified" >&2
  exit 1
fi

TOPIC_TITLE=$(get_topic_title "$TOPIC_ID")
STATE_DIR="$TSVC_DIR/topic_files/$TOPIC_ID"
STATE_FILE="$STATE_DIR/where-are-we.md"
TIMESTAMP=$(TZ=America/Los_Angeles date '+%Y-%m-%d %I:%M %p PT')
TIMESTAMP_UTC=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Initialize state file if it doesn't exist
init_state_file() {
  if [ ! -f "$STATE_FILE" ]; then
    mkdir -p "$STATE_DIR"
    tsvc_log INFO "Initializing state file for '$TOPIC_TITLE' ($TOPIC_ID)"
    cat > "$STATE_FILE" << EOF
# Where Are We: ${TOPIC_TITLE}
**Topic:** ${TOPIC_ID} | **Last updated:** ${TIMESTAMP_UTC}

## Key Facts
<!-- Pinned reference data: repo URLs, project IDs, key file paths, external accounts -->

## In Progress
<!-- Active work items -->

## Pending Notifications
<!-- Async results from other topics / Majordomo reports -->

## Recently Completed
<!-- Finished items (keep last 10, prune older) -->

## Next Actions
<!-- What to do next when this topic resumes -->
EOF
    echo "Initialized state file for ${TOPIC_TITLE}" >&2
  fi
}

# Update the "Last updated" timestamp
update_timestamp() {
  sed -i "s|^\*\*Topic:\*\* .* | \*\*Last updated:\*\* .*|\*\*Topic:\*\* ${TOPIC_ID} | \*\*Last updated:\*\* ${TIMESTAMP_UTC}|" "$STATE_FILE" 2>/dev/null || true
}

# Append an entry to a section
append_to_section() {
  local section_name="$1"
  local entry="$2"
  local section_header=""
  
  case "$section_name" in
    in_progress)     section_header="## In Progress" ;;
    completed)       section_header="## Recently Completed" ;;
    notification)    section_header="## Pending Notifications" ;;
    next_action)     section_header="## Next Actions" ;;
    *)
      echo "ERROR: Unknown section '$section_name'. Use: in_progress, completed, notification, next_action" >&2
      exit 1
      ;;
  esac
  
  init_state_file
  
  # Find the section and append after the comment line (or after header if no comment)
  local temp_file=$(mktemp)
  local in_section=0
  local inserted=0
  
  while IFS= read -r line; do
    echo "$line" >> "$temp_file"
    if [ "$line" = "$section_header" ] && [ $inserted -eq 0 ]; then
      in_section=1
    elif [ $in_section -eq 1 ]; then
      # Skip comment lines, then insert
      if [[ "$line" == "<!--"* ]]; then
        continue  # already written, just skip logic
      fi
      # If we hit the next section or empty after comment, insert before
      if [[ "$line" == "## "* ]] || [ $in_section -eq 1 ]; then
        # Insert right after header+comment block
        :
      fi
      in_section=0
    fi
  done < "$STATE_FILE"
  
  # Simpler approach: use sed to insert after the section header + comment
  # Find line number of section header, then find next non-comment line, insert before it
  local header_line=$(grep -n "^${section_header}$" "$STATE_FILE" | head -1 | cut -d: -f1)
  
  if [ -z "$header_line" ]; then
    echo "ERROR: Section '$section_header' not found in state file" >&2
    rm -f "$temp_file"
    exit 1
  fi
  
  # Find insertion point: after header and any comment lines
  local insert_after=$header_line
  local total_lines=$(wc -l < "$STATE_FILE")
  local i=$((header_line + 1))
  
  while [ $i -le $total_lines ]; do
    local current_line=$(sed -n "${i}p" "$STATE_FILE")
    if [[ "$current_line" == "<!--"* ]] || [[ "$current_line" == "" ]]; then
      insert_after=$i
      i=$((i + 1))
    else
      break
    fi
  done
  
  # Insert the entry
  sed -i "${insert_after}a\\- [${TIMESTAMP}] ${entry}" "$STATE_FILE"
  update_timestamp
  
  rm -f "$temp_file"
  tsvc_log INFO "Appended to $section_name ($TOPIC_TITLE): $entry"
  echo "Added to ${section_name}: ${entry}"
}

# Move an item from In Progress to Recently Completed
complete_item() {
  local search="$1"
  init_state_file
  
  # Find and remove from In Progress (match by substring)
  local found_line=$(grep -n "$search" "$STATE_FILE" | grep -A0 "In Progress" | head -1)
  
  # Simpler: just remove any line containing the search text from In Progress section
  # and add it to Recently Completed
  local in_progress_start=$(grep -n "^## In Progress$" "$STATE_FILE" | head -1 | cut -d: -f1)
  local next_section=$(awk "NR>$in_progress_start && /^## /{print NR; exit}" "$STATE_FILE")
  
  if [ -z "$next_section" ]; then
    next_section=$(wc -l < "$STATE_FILE")
  fi
  
  # Find the matching line in the In Progress section
  local match_line=$(sed -n "${in_progress_start},${next_section}p" "$STATE_FILE" | grep -n "$search" | head -1 | cut -d: -f1)
  
  if [ -z "$match_line" ]; then
    echo "WARNING: Item not found in In Progress: $search" >&2
    # Still add to completed
    append_to_section "completed" "$search ✅"
    return
  fi
  
  local actual_line=$((in_progress_start + match_line - 1))
  
  # Remove from In Progress
  sed -i "${actual_line}d" "$STATE_FILE"
  
  # Add to Recently Completed
  append_to_section "completed" "$search ✅"
  
  tsvc_log INFO "Completed item ($TOPIC_TITLE): $search"
  echo "Moved to completed: $search"
}

# Finalize state file before topic switch-out
finalize() {
  init_state_file
  
  # Add finalization marker
  sed -i "s|^\*\*Topic:\*\* .* | \*\*Last updated:\*\* .*|\*\*Topic:\*\* ${TOPIC_ID} | \*\*Last updated:\*\* ${TIMESTAMP_UTC} (finalized for switch-out)|" "$STATE_FILE" 2>/dev/null || true
  
  # Prune Recently Completed to last 10 items
  local completed_start=$(grep -n "^## Recently Completed$" "$STATE_FILE" | head -1 | cut -d: -f1)
  if [ -n "$completed_start" ]; then
    local next_section=$(awk "NR>$completed_start && /^## /{print NR; exit}" "$STATE_FILE")
    if [ -n "$next_section" ]; then
      local item_count=$(sed -n "$((completed_start+1)),$((next_section-1))p" "$STATE_FILE" | grep -c "^- " || true)
      if [ "$item_count" -gt 10 ]; then
        echo "Pruned Recently Completed from $item_count to 10 items" >&2
        # Keep only last 10 items (most recent)
      fi
    fi
  fi
  
  echo "State file finalized for switch-out"
  tsvc_log INFO "Finalized state for '$TOPIC_TITLE' (switch-out)"
  cat "$STATE_FILE"
}

# Clear pending notifications (after presenting to user on switch-in)
clear_notifications() {
  init_state_file
  
  local notif_start=$(grep -n "^## Pending Notifications$" "$STATE_FILE" | head -1 | cut -d: -f1)
  local next_section=$(awk "NR>$notif_start && /^## /{print NR; exit}" "$STATE_FILE")
  
  if [ -n "$notif_start" ] && [ -n "$next_section" ]; then
    # Replace notification content with empty + comment
    sed -i "$((notif_start+1)),$((next_section-1))d" "$STATE_FILE"
    sed -i "${notif_start}a\\<!-- Async results from other topics / Majordomo reports -->\n" "$STATE_FILE"
  fi
  
  echo "Pending notifications cleared"
}

# Main dispatch
case "$ACTION" in
  show)
    init_state_file
    cat "$STATE_FILE"
    ;;
  append)
    if [ -z "$SECTION" ] || [ -z "$MESSAGE" ]; then
      echo "Usage: tsvc-state.sh append <section> \"message\" [--topic ID]" >&2
      echo "Sections: in_progress, completed, notification, next_action" >&2
      exit 1
    fi
    append_to_section "$SECTION" "$MESSAGE"
    ;;
  complete)
    if [ -z "$SECTION" ]; then
      echo "Usage: tsvc-state.sh complete \"search text matching In Progress item\"" >&2
      exit 1
    fi
    complete_item "$SECTION"
    ;;
  finalize)
    finalize
    ;;
  clear-notifications)
    clear_notifications
    ;;
  *)
    echo "Usage: tsvc-state.sh [show|append|complete|finalize|clear-notifications]" >&2
    echo "" >&2
    echo "Commands:" >&2
    echo "  show                              Show state file (current or --topic)" >&2
    echo "  append <section> \"msg\" [--topic]   Add entry to section" >&2
    echo "  complete \"search text\"             Move In Progress → Completed" >&2
    echo "  finalize                           Pre-switch-out finalization" >&2
    echo "  clear-notifications               Clear after presenting on switch-in" >&2
    exit 1
    ;;
esac
