#!/usr/bin/env bash
# self-reset.sh — Delete LLM session so next user message starts fresh
# Usage: nohup bash scripts/self-reset.sh [delay] > /tmp/self-reset.log 2>&1 &
# v2: Silent reset — does NOT send any message (current session already replied)

set -e

export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

DELAY="${1:-0}"
AGENT_ID="main"
SESSION_KEY="agent:main:telegram:direct:YOUR_SENDER_ID"
SESSIONS_DIR="$HOME/.openclaw/agents/$AGENT_ID/sessions"
STORE="$SESSIONS_DIR/sessions.json"
WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
LOCKFILE="$WORKSPACE/tsvc/.switch-lock"

# Logging
source "$WORKSPACE/tsvc/scripts/tsvc-log.sh" "SELF-RESET"

tsvc_log INFO "Self-reset initiated (delay=${DELAY}s)"

sleep "$DELAY"

# Write lockfile to prevent cron interference during switch
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCKFILE"

# Find session ID
SESSION_ID=$(python3 -c "
import json
with open('$STORE') as f:
    d = json.load(f)
print(d.get('$SESSION_KEY', {}).get('sessionId', ''))
")

[ -z "$SESSION_ID" ] && { tsvc_log ERROR "No session found"; rm -f "$LOCKFILE"; exit 1; }

tsvc_log INFO "Found session: $SESSION_ID"

# Delete transcript
rm -f "$SESSIONS_DIR/${SESSION_ID}.jsonl"

# Remove store entry
python3 -c "
import json
with open('$STORE') as f:
    d = json.load(f)
d.pop('$SESSION_KEY', None)
with open('$STORE', 'w') as f:
    json.dump(d, f, indent=2)
"

echo "Session $SESSION_ID deleted silently. Next message starts fresh."
tsvc_log INFO "Session $SESSION_ID deleted. Next message starts fresh."

# Remove lockfile
rm -f "$LOCKFILE"
