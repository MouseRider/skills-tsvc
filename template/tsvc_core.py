"""
TSVC Core — Topic-Scoped Virtual Context

Core logic for topic management, switching, and context maintenance.
Framework-agnostic — uses tsvc_adapter.py for framework-specific operations.

Usage:
    from tsvc_core import TSVCManager
    
    manager = TSVCManager("/path/to/tsvc")
    manager.handle_boot()
    
    # On each message:
    switch_needed = manager.detect_and_switch(user_message)
    if not switch_needed:
        # Process message normally
        ...
        # After processing, log if substantive:
        manager.log_exchange("user", user_message)
        manager.log_exchange("assistant", response)
"""

import os
import json
import hashlib
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any


class TSVCManager:
    def __init__(self, tsvc_dir: str = None):
        self.tsvc_dir = tsvc_dir or os.environ.get(
            "TSVC_DIR", os.path.join(os.getcwd(), "tsvc")
        )
        self.state_file = os.path.join(self.tsvc_dir, "active-state.json")
        self.index_file = os.path.join(self.tsvc_dir, "topic_files", "index.json")
        self.contexts_dir = os.path.join(self.tsvc_dir, "contexts")
        self.conversations_dir = os.path.join(self.tsvc_dir, "conversations")
        self.telemetry_dir = os.path.join(self.tsvc_dir, "telemetry")
        self.pending_file = os.path.join(self.tsvc_dir, "pending-reset.json")

    # ----------------------------------------------------------
    # Boot
    # ----------------------------------------------------------

    def handle_boot(self) -> Optional[Dict]:
        """
        Check for pending topic switch on boot.
        Returns pending data if a switch was pending, None otherwise.
        """
        if not os.path.exists(self.pending_file):
            return None

        with open(self.pending_file) as f:
            pending = json.load(f)

        if pending.get("reason") != "topic_switch":
            return None

        target_id = pending["toTopic"]["id"]

        # Load target topic context
        context = self.load_context(target_id)

        # Update active state
        self._set_active(target_id)

        # Log telemetry
        self._log_telemetry_event("session-loaded", {
            "switchId": pending.get("switchId"),
            "topicId": target_id,
            "t1": datetime.now(timezone.utc).isoformat(),
        })

        # Clean up
        os.remove(self.pending_file)
        next_topic_file = os.path.join(self.tsvc_dir, "next-topic.txt")
        if os.path.exists(next_topic_file):
            os.remove(next_topic_file)

        return pending

    # ----------------------------------------------------------
    # Topic CRUD
    # ----------------------------------------------------------

    def create_topic(self, title: str, description: str = "") -> str:
        """Create a new topic and set it as active."""
        topic_id = "topic_" + hashlib.md5(
            f"{title}_{datetime.now(timezone.utc).isoformat()}".encode()
        ).hexdigest()[:16]

        now = datetime.now(timezone.utc).isoformat()

        topic_entry = {
            "id": topic_id,
            "title": title,
            "description": description,
            "status": "active",
            "createdAt": now,
            "lastAccessedAt": now,
            "exchangeCount": 0,
            "decisionCount": 0,
            "switchCount": 0,
        }

        # Add to index
        index = self._read_index()
        # Page out current active topic
        for t in index["topics"]:
            if t["status"] == "active":
                t["status"] = "paged"
        index["topics"].append(topic_entry)
        self._write_index(index)

        # Create context file
        context_path = os.path.join(self.contexts_dir, f"{topic_id}.md")
        os.makedirs(self.contexts_dir, exist_ok=True)
        with open(context_path, "w") as f:
            f.write(f"# Topic: {title}\n\n")
            if description:
                f.write(f"{description}\n\n")
            f.write("## Active Decisions\n\n")
            f.write("## Current State\n\n")
            f.write("## Recent Exchanges\n\n")
            f.write("## Open Items\n\n")

        # Create conversation file
        conv_path = os.path.join(self.conversations_dir, f"{topic_id}.jsonl")
        os.makedirs(self.conversations_dir, exist_ok=True)
        open(conv_path, "a").close()

        # Set active
        self._set_active(topic_id)

        return topic_id

    def list_topics(self) -> List[Dict]:
        """List all topics with their metadata."""
        index = self._read_index()
        return index.get("topics", [])

    def get_active_topic(self) -> Optional[Dict]:
        """Get the currently active topic."""
        state = self._read_state()
        active_id = state.get("activeTopicId")
        if not active_id:
            return None
        index = self._read_index()
        for t in index["topics"]:
            if t["id"] == active_id:
                return t
        return None

    # ----------------------------------------------------------
    # Context Management
    # ----------------------------------------------------------

    def load_context(self, topic_id: str) -> str:
        """Load a topic's context file content."""
        path = os.path.join(self.contexts_dir, f"{topic_id}.md")
        if not os.path.exists(path):
            return ""
        with open(path) as f:
            return f.read()

    def save_context(self, topic_id: str, content: str):
        """Save updated context to a topic's context file."""
        path = os.path.join(self.contexts_dir, f"{topic_id}.md")
        os.makedirs(self.contexts_dir, exist_ok=True)
        with open(path, "w") as f:
            f.write(content)

    # ----------------------------------------------------------
    # Exchange Logging
    # ----------------------------------------------------------

    def log_exchange(self, topic_id: str, role: str, content: str):
        """Append an exchange to the topic's conversation log."""
        conv_path = os.path.join(self.conversations_dir, f"{topic_id}.jsonl")
        os.makedirs(self.conversations_dir, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "role": role,
            "content": content,
            "topicId": topic_id,
        }
        with open(conv_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

        # Update exchange count
        index = self._read_index()
        for t in index["topics"]:
            if t["id"] == topic_id:
                t["exchangeCount"] = t.get("exchangeCount", 0) + 1
                t["lastAccessedAt"] = datetime.now(timezone.utc).isoformat()
                break
        self._write_index(index)

    def log_decision(self, topic_id: str, decision: str, reason: str = "",
                     supersedes: str = ""):
        """Log a decision to the topic's context and conversation."""
        now = datetime.now(timezone.utc).isoformat()
        entry = {
            "ts": now,
            "type": "decision",
            "decision": decision,
            "reason": reason,
            "supersedes": supersedes,
            "topicId": topic_id,
        }
        # Log to conversation file
        conv_path = os.path.join(self.conversations_dir, f"{topic_id}.jsonl")
        with open(conv_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

        # Update decision count
        index = self._read_index()
        for t in index["topics"]:
            if t["id"] == topic_id:
                t["decisionCount"] = t.get("decisionCount", 0) + 1
                break
        self._write_index(index)

    # ----------------------------------------------------------
    # Topic Switching
    # ----------------------------------------------------------

    def switch(self, from_id: str, to_id: str, triggering_message: str,
               recent_exchanges: list = None, recent_decisions: list = None):
        """
        Initiate a topic switch. Writes pending-reset.json and
        returns — caller must trigger session reset after this.
        """
        now = datetime.now(timezone.utc).isoformat()
        switch_id = f"sw_{hashlib.md5(now.encode()).hexdigest()[:8]}"

        # Get topic info
        index = self._read_index()
        from_topic = next((t for t in index["topics"] if t["id"] == from_id), {})
        to_topic = next((t for t in index["topics"] if t["id"] == to_id), {})

        # Update statuses
        for t in index["topics"]:
            if t["id"] == from_id:
                t["status"] = "paged"
            if t["id"] == to_id:
                t["status"] = "active"
                t["switchCount"] = t.get("switchCount", 0) + 1
                t["lastAccessedAt"] = now
        self._write_index(index)

        # Write pending reset
        pending = {
            "reason": "topic_switch",
            "switchId": switch_id,
            "fromTopic": {"id": from_id, "title": from_topic.get("title", "")},
            "toTopic": {"id": to_id, "title": to_topic.get("title", "")},
            "triggeringMessage": triggering_message,
            "recentExchanges": recent_exchanges or [],
            "recentDecisions": recent_decisions or [],
            "telemetry": {
                "t0": now,
            },
        }
        with open(self.pending_file, "w") as f:
            json.dump(pending, f, indent=2)

        # Log telemetry
        self._log_telemetry_event("switch-initiated", {
            "switchId": switch_id,
            "fromTopic": from_id,
            "toTopic": to_id,
            "t0": now,
        })

        self._set_active(to_id)

    def detect_and_switch(self, message: str) -> bool:
        """
        Check if message requires a topic switch.
        If yes, initiates the switch and returns True.
        Caller should trigger session reset if True is returned.
        """
        from tsvc_adapter import classify_message

        active = self.get_active_topic()
        if not active:
            return False

        all_topics = self.list_topics()
        target_id = classify_message(message, active, all_topics)

        if target_id and target_id != active["id"]:
            self.switch(active["id"], target_id, message)
            return True

        return False

    # ----------------------------------------------------------
    # Awareness Layer
    # ----------------------------------------------------------

    def get_awareness(self) -> str:
        """
        Generate lightweight awareness text (~200 tokens) for topic detection.
        Include in every context window.
        """
        topics = self.list_topics()
        if not topics:
            return "No topics yet."

        lines = ["Active topics:"]
        for t in sorted(topics, key=lambda x: x.get("lastAccessedAt", ""), reverse=True):
            status = t.get("status", "unknown")
            title = t.get("title", "Untitled")
            decisions = t.get("decisionCount", 0)
            exchanges = t.get("exchangeCount", 0)
            last = t.get("lastAccessedAt", "never")
            lines.append(
                f"- {title} ({status}, {decisions} decisions, "
                f"{exchanges} exchanges, last: {last})"
            )

        return "\n".join(lines)

    # ----------------------------------------------------------
    # Internals
    # ----------------------------------------------------------

    def _read_state(self) -> Dict:
        if not os.path.exists(self.state_file):
            return {}
        with open(self.state_file) as f:
            return json.load(f)

    def _set_active(self, topic_id: str):
        state = {
            "activeTopicId": topic_id,
            "activeSince": datetime.now(timezone.utc).isoformat(),
        }
        os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
        with open(self.state_file, "w") as f:
            json.dump(state, f, indent=2)

    def _read_index(self) -> Dict:
        if not os.path.exists(self.index_file):
            return {"topics": []}
        with open(self.index_file) as f:
            return json.load(f)

    def _write_index(self, index: Dict):
        os.makedirs(os.path.dirname(self.index_file), exist_ok=True)
        with open(self.index_file, "w") as f:
            json.dump(index, f, indent=2)

    def _log_telemetry_event(self, event_type: str, data: Dict):
        os.makedirs(self.telemetry_dir, exist_ok=True)
        path = os.path.join(self.telemetry_dir, "switches.jsonl")
        entry = {"event": event_type, **data}
        with open(path, "a") as f:
            f.write(json.dumps(entry) + "\n")
