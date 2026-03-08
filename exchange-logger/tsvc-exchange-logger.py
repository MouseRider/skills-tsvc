#!/usr/bin/env python3
"""
TSVC Exchange Logger — Automated
Scans the active session transcript and extracts exchanges per topic,
writing them to the appropriate TSVC conversation.jsonl files.

Run periodically (heartbeat, cron, or pre-compaction flush).
Tracks last-processed position to avoid duplicates.
"""

import json
import os
import sys
import glob
import subprocess
from datetime import datetime

WORKSPACE = os.environ.get('WORKSPACE', os.path.expanduser('~/.openclaw/workspace'))
TSVC_DIR = os.path.join(WORKSPACE, 'tsvc')
TOPICS_DIR = os.path.join(TSVC_DIR, 'topic_files')
STATE_FILE = os.path.join(TSVC_DIR, 'exchange-logger-state.json')
SESSIONS_DIR = os.path.expanduser('~/.openclaw/agents/main/sessions')
OPS_LOG = os.path.join(TSVC_DIR, 'logs', 'tsvc-ops.log')

def tsvc_log(level, msg):
    import subprocess
    ts = subprocess.check_output(['date', '+%Y-%m-%d %I:%M:%S %p PT'], env={**os.environ, 'TZ': 'America/Los_Angeles'}).decode().strip()
    line = f"[{ts}] [EXCHANGE-LOGGER] [{level}] {msg}"
    os.makedirs(os.path.dirname(OPS_LOG), exist_ok=True)
    with open(OPS_LOG, 'a') as f:
        f.write(line + '\n')
    print(line)

def get_active_session():
    """Find the most recently modified session transcript."""
    pattern = os.path.join(SESSIONS_DIR, '*.jsonl')
    files = glob.glob(pattern)
    if not files:
        return None
    return max(files, key=os.path.getmtime)

def load_state():
    """Load last-processed position."""
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"session_file": None, "last_line": 0}

def save_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)

def get_active_topic():
    """Read current active topic from TSVC state."""
    af = os.path.join(TSVC_DIR, 'active-state.json')
    if os.path.exists(af):
        with open(af) as f:
            d = json.load(f)
            return d.get('activeTopicId') or d.get('activeTopic')
    return None

def append_exchange(topic_id, exchange):
    """Append an exchange to the topic's conversation.jsonl."""
    topic_dir = os.path.join(TOPICS_DIR, topic_id)
    os.makedirs(topic_dir, exist_ok=True)
    convo_file = os.path.join(topic_dir, 'conversation.jsonl')
    with open(convo_file, 'a') as f:
        f.write(json.dumps(exchange) + '\n')

def update_topic_exchange_count(topic_id):
    """Update the exchange count in both state.json and index.json."""
    convo_file = os.path.join(TOPICS_DIR, topic_id, 'conversation.jsonl')
    count = 0
    if os.path.exists(convo_file):
        with open(convo_file) as f:
            count = sum(1 for _ in f)

    # Update state.json
    state_file = os.path.join(TOPICS_DIR, topic_id, 'state.json')
    if os.path.exists(state_file):
        with open(state_file) as f:
            state = json.load(f)
        state['exchanges'] = count
        state['exchangeCount'] = count
        with open(state_file, 'w') as f:
            json.dump(state, f, indent=2)

    # Update index.json
    index_file = os.path.join(TOPICS_DIR, 'index.json')
    if os.path.exists(index_file):
        with open(index_file) as f:
            index = json.load(f)
        if topic_id in index.get('topics', {}):
            index['topics'][topic_id]['exchangeCount'] = count
            with open(index_file, 'w') as f:
                json.dump(index, f, indent=2)

def run():
    session_file = get_active_session()
    if not session_file:
        print("No active session found")
        return

    state = load_state()
    
    # If session file changed, reset position
    if state["session_file"] != session_file:
        state["session_file"] = session_file
        state["last_line"] = 0

    # IMPORTANT: Only process NEW lines since last run.
    # We read the active topic from active-state.json at run time.
    # This means the logger MUST be run frequently (heartbeat/pre-compaction)
    # while the session is active — NOT retroactively after compaction.
    # After compaction, switch events are lost in summary text.
    
    current_topic = get_active_topic()
    if not current_topic:
        print(json.dumps({"status": "skip", "reason": "no active topic"}))
        return

    new_exchanges = 0
    topics_updated = set()
    last_line = state["last_line"]

    with open(session_file) as f:
        lines = f.readlines()
    
    # Only process new lines
    new_lines = lines[last_line:]
    
    for i, line in enumerate(new_lines):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Detect topic switches from tool results
        if d.get('type') == 'toolResult':
            content = d.get('content', '')
            if isinstance(content, str) and '"action":"switched"' in content:
                try:
                    switch_data = json.loads(content)
                    if switch_data.get('action') == 'switched':
                        current_topic = switch_data.get('to')
                except:
                    pass

        # Log user/assistant exchanges
        if d.get('type') == 'message' and current_topic:
            msg = d.get('message', {})
            role = msg.get('role', '')
            
            if role not in ('user', 'assistant'):
                continue
            
            content = msg.get('content', '')
            if isinstance(content, list):
                text = ' '.join(c.get('text', '') for c in content if c.get('type') == 'text')
            else:
                text = str(content)
            
            # Skip noise
            text = text.strip()
            if not text or len(text) < 5:
                continue
            if text in ('NO_REPLY', 'HEARTBEAT_OK'):
                continue
            if 'Pre-compaction memory flush' in text:
                continue
            # Skip heartbeat prompts and responses
            if 'Read HEARTBEAT.md if it exists' in text:
                continue
            if text.startswith('Status at') and 'HEARTBEAT_OK' in text[-20:]:
                continue
            if '✅ **Email:**' in text and '✅ **Sub-minds:**' in text:
                continue
            # Skip compaction summaries (massive text blocks)
            if text.startswith('The conversation history before this point was compacted'):
                continue

            exchange = {
                "role": role,
                "text": text[:500],
                "timestamp": d.get('timestamp', datetime.utcnow().isoformat()),
                "type": "exchange"
            }
            
            append_exchange(current_topic, exchange)
            topics_updated.add(current_topic)
            new_exchanges += 1

    state["last_line"] = last_line + len(new_lines)

    # Update exchange counts
    for tid in topics_updated:
        update_topic_exchange_count(tid)

    # Refresh hot context for all updated topics
    for tid in topics_updated:
        try:
            subprocess.run(
                ['node', os.path.join(WORKSPACE, 'tsvc/scripts/tsvc-manager.js'), 'refresh', tid],
                capture_output=True, timeout=10
            )
        except Exception:
            pass  # non-fatal

    save_state(state)
    
    tsvc_log("INFO", f"Processed {new_exchanges} new exchanges across {len(topics_updated)} topics (line {state['last_line']})")
    
    print(json.dumps({
        "status": "ok",
        "session": os.path.basename(session_file),
        "new_exchanges": new_exchanges,
        "topics_updated": list(topics_updated),
        "last_line": state["last_line"]
    }))

if __name__ == '__main__':
    run()
