#!/usr/bin/env python3
"""
TSVC Exchange Logger — Automated (v2)
Scans the active session transcript and extracts exchanges per topic,
writing them to the appropriate TSVC conversation.jsonl files.

KEY FIX (v2): Attributes exchanges to the topic that was active at the time
of the exchange, not the topic active when the logger runs. Uses switch
telemetry log to build a timeline of topic ownership.

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
TELEMETRY_FILE = os.path.join(TSVC_DIR, 'logs', 'switch-telemetry.jsonl')
INDEX_FILE = os.path.join(TOPICS_DIR, 'index.json')

def tsvc_log(level, msg):
    ts = subprocess.check_output(
        ['date', '+%Y-%m-%d %I:%M:%S %p PT'],
        env={**os.environ, 'TZ': 'America/Los_Angeles'}
    ).decode().strip()
    line = f"[{ts}] [EXCHANGE-LOGGER] [{level}] {msg}"
    os.makedirs(os.path.dirname(OPS_LOG), exist_ok=True)
    with open(OPS_LOG, 'a') as f:
        f.write(line + '\n')
    print(line)


def build_topic_timeline():
    """
    Build a sorted list of (timestamp_ms, topic_id) from switch telemetry.
    This tells us which topic was active at any point in time.
    """
    timeline = []

    # Read switch telemetry
    if os.path.exists(TELEMETRY_FILE):
        with open(TELEMETRY_FILE) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # t1 = when new session loaded (topic became active)
                t1 = entry.get('t1_new_session_loaded') or entry.get('t0_initiated')
                to_topic = entry.get('toTopic', {})
                topic_id = to_topic.get('id', '')

                if not t1 or not topic_id:
                    continue

                # Convert ISO to ms timestamp
                try:
                    ts_ms = int(datetime.fromisoformat(t1.replace('Z', '+00:00')).timestamp() * 1000)
                except (ValueError, AttributeError):
                    continue

                timeline.append((ts_ms, topic_id))

    # Sort by timestamp
    timeline.sort(key=lambda x: x[0])
    return timeline


def get_topic_at_time(timeline, timestamp_ms, fallback_topic):
    """
    Given a sorted timeline of (timestamp_ms, topic_id) switches,
    find which topic was active at the given timestamp.
    Uses binary search for efficiency.
    """
    if not timeline:
        return fallback_topic

    # Binary search: find the last switch that happened at or before timestamp_ms
    lo, hi = 0, len(timeline) - 1
    result = None

    while lo <= hi:
        mid = (lo + hi) // 2
        if timeline[mid][0] <= timestamp_ms:
            result = timeline[mid][1]
            lo = mid + 1
        else:
            hi = mid - 1

    return result if result else fallback_topic


def get_active_session():
    """Find the most recently modified session transcript."""
    pattern = os.path.join(SESSIONS_DIR, '*.jsonl')
    files = glob.glob(pattern)
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def get_active_topic():
    """Read current active topic from TSVC index."""
    if os.path.exists(INDEX_FILE):
        with open(INDEX_FILE) as f:
            d = json.load(f)
            return d.get('activeTopic')
    # Fallback to active-state.json
    af = os.path.join(TSVC_DIR, 'active-state.json')
    if os.path.exists(af):
        with open(af) as f:
            d = json.load(f)
            return d.get('activeTopicId') or d.get('activeTopic')
    return None


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"session_file": None, "last_line": 0}


def save_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)


def append_exchange(topic_id, exchange):
    topic_dir = os.path.join(TOPICS_DIR, topic_id)
    os.makedirs(topic_dir, exist_ok=True)
    convo_file = os.path.join(topic_dir, 'conversation.jsonl')
    with open(convo_file, 'a') as f:
        f.write(json.dumps(exchange) + '\n')


def update_topic_exchange_count(topic_id):
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
    if os.path.exists(INDEX_FILE):
        with open(INDEX_FILE) as f:
            index = json.load(f)
        if topic_id in index.get('topics', {}):
            index['topics'][topic_id]['exchangeCount'] = count
            with open(INDEX_FILE, 'w') as f:
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

    # Build topic timeline from switch telemetry
    timeline = build_topic_timeline()

    # Fallback: current active topic (only used if no telemetry covers the timestamp)
    fallback_topic = get_active_topic()
    if not fallback_topic and not timeline:
        print(json.dumps({"status": "skip", "reason": "no active topic and no telemetry"}))
        return

    new_exchanges = 0
    topics_updated = set()
    last_line = state["last_line"]

    with open(session_file) as f:
        lines = f.readlines()

    new_lines = lines[last_line:]

    for i, line in enumerate(new_lines):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Only log user/assistant exchanges
        if d.get('type') != 'message':
            continue

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
        if 'Read HEARTBEAT.md if it exists' in text:
            continue
        if text.startswith('Status at') and 'HEARTBEAT_OK' in text[-20:]:
            continue
        if '✅ **Email:**' in text and '✅ **Sub-minds:**' in text:
            continue
        if text.startswith('The conversation history before this point was compacted'):
            continue
        # Skip cron prompts
        if text.startswith('[cron:'):
            continue

        # Get the timestamp of this exchange
        exchange_ts = d.get('timestamp')
        if isinstance(exchange_ts, str):
            try:
                exchange_ts_ms = int(datetime.fromisoformat(exchange_ts.replace('Z', '+00:00')).timestamp() * 1000)
            except (ValueError, AttributeError):
                exchange_ts_ms = None
        elif isinstance(exchange_ts, (int, float)):
            exchange_ts_ms = int(exchange_ts)
        else:
            exchange_ts_ms = None

        # Determine which topic this exchange belongs to
        if exchange_ts_ms:
            topic_id = get_topic_at_time(timeline, exchange_ts_ms, fallback_topic)
        else:
            topic_id = fallback_topic

        if not topic_id:
            continue

        exchange = {
            "role": role,
            "text": text[:500],
            "timestamp": exchange_ts if isinstance(exchange_ts, str) else (
                datetime.utcfromtimestamp(exchange_ts_ms / 1000).isoformat() + 'Z'
                if exchange_ts_ms else datetime.utcnow().isoformat()
            ),
            "type": "exchange"
        }

        append_exchange(topic_id, exchange)
        topics_updated.add(topic_id)
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
            pass

    save_state(state)

    tsvc_log("INFO", f"Processed {new_exchanges} new exchanges across {len(topics_updated)} topics (line {state['last_line']})")

    print(json.dumps({
        "status": "ok",
        "session": os.path.basename(session_file),
        "new_exchanges": new_exchanges,
        "topics_updated": list(topics_updated),
        "last_line": state["last_line"],
        "timeline_entries": len(timeline)
    }))


if __name__ == '__main__':
    run()
