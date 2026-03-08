# Integration Guide

How to add TSVC to your agent.

## Prerequisites

Your agent framework needs:
1. **File I/O** — read/write markdown and JSON
2. **Session reset** — a way to get a clean context window
3. **Boot hook** — code that runs on session start
4. **Message handling** — intercept user messages before processing

## Quick Start

### 1. Create the directory structure

```bash
mkdir -p tsvc/{topic_files,contexts,conversations,telemetry,backups,scripts}
```

### 2. Initialize state

```bash
echo '{"activeTopicId": null, "activeSince": null}' > tsvc/active-state.json
echo '{"topics": []}' > tsvc/topic_files/index.json
echo '{}' > tsvc/metrics.json
```

### 3. Implement the core operations

You need four functions:

```python
# Pseudocode — adapt to your framework

def create_topic(title: str) -> str:
    """Create a new topic, return its ID."""
    topic_id = generate_id(title)
    # Add to index.json
    # Create contexts/<topic_id>.md with template
    # Create conversations/<topic_id>.jsonl (empty)
    # Set as active in active-state.json
    return topic_id

def switch_topic(from_id: str, to_id: str, triggering_message: str):
    """Switch from one topic to another."""
    # 1. Save current topic state
    save_topic(from_id)
    # 2. Write pending-reset.json
    write_pending_reset(from_id, to_id, triggering_message)
    # 3. Trigger session reset (framework-specific)
    trigger_reset()

def load_topic(topic_id: str) -> str:
    """Load a topic's context into the current session."""
    # Read contexts/<topic_id>.md
    # Update active-state.json
    # Return context content for injection into prompt
    return context_content

def detect_topic(message: str, current_topic: str, all_topics: list) -> str:
    """Determine which topic a message belongs to."""
    # Option 1: Keyword matching against topic titles
    # Option 2: LLM classification with awareness layer
    # Option 3: Explicit detection ("switch to X")
    # Returns topic_id or current_topic if no switch needed
    return topic_id
```

### 4. Add boot hook

On every session start:

```python
def on_boot():
    pending = read_json("tsvc/pending-reset.json")
    if pending and pending.get("reason") == "topic_switch":
        # Load target topic
        context = load_topic(pending["toTopic"]["id"])
        
        # Get triggering message
        trigger = pending["triggeringMessage"]
        
        # Clean up
        delete_file("tsvc/pending-reset.json")
        
        # Respond to user immediately
        if is_question(trigger):
            respond_with_answer(trigger, context)
        else:
            respond_with_continuation(trigger, context)
    else:
        # Normal boot — load active topic if exists
        state = read_json("tsvc/active-state.json")
        if state.get("activeTopicId"):
            load_topic(state["activeTopicId"])
```

### 5. Add message interceptor

Before processing each user message:

```python
def handle_message(message: str):
    current = get_active_topic()
    detected = detect_topic(message, current, get_all_topics())
    
    if detected != current:
        switch_topic(current, detected, message)
        return  # Session will reset
    
    # Normal processing
    process_message(message)
    
    # Log exchange if substantive
    if is_substantive(message, response):
        append_exchange(current, message, response)
```

## Framework-Specific Notes

### OpenClaw

TSVC was built on OpenClaw. The reference implementation uses:
- `tsvc-manager.js` for all core operations
- `self-reset.sh` for session reset (sends `/reset` via `openclaw message send`)
- Boot hook in `AGENTS.md` (checked on every session start)
- Exchange logging via `tsvc-exchange-logger.py` (cron-based)

### LangChain / LangGraph

- Use a `RunnablePassthrough` at the start of your chain to check `pending-reset.json`
- Session reset = create a new `ConversationBufferMemory` and drop the old one
- Store context files alongside your existing memory backend

### AutoGen / CrewAI

- Implement as a custom agent that wraps your existing agents
- Topic detection can be a dedicated classifier agent
- Session reset = restart the conversation with fresh system messages

### Letta (MemGPT)

- TSVC complements Letta's memory paging — Letta handles within-topic memory, TSVC handles between-topic isolation
- Use Letta's archival memory for conversation JSONL storage
- Topic switch = create new Letta agent state with scoped core memory

### Custom / Bare API

- Maintain your own message history array
- Session reset = clear the array, re-inject system prompt + topic context
- Simplest implementation — full control, no framework overhead

## Testing Your Implementation

### Smoke Test

1. Create two topics: "Topic A" and "Topic B"
2. Have a conversation in Topic A (make a decision, discuss something substantive)
3. Switch to Topic B (explicitly or by changing subject)
4. Verify: Topic A's context is NOT in the current window
5. Switch back to Topic A
6. Verify: The agent remembers the decision from step 2
7. Verify: Nothing from Topic B leaked into Topic A

### Continuity Test

1. Switch to a topic
2. Ask a question that requires context from the topic's recent exchanges
3. Verify the agent answers correctly using the loaded context
4. Repeat after multiple switches back and forth

### Latency Test

1. Time the full switch cycle (t0 → t2)
2. Target: under 10 seconds for a good user experience
3. Log telemetry for ongoing monitoring

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Agent doesn't respond after switch | Boot hook not checking `pending-reset.json` | Add boot hook |
| Context from old topic leaks in | Session reset not clearing full context | Verify reset mechanism |
| Topic detection misclassifies | Awareness layer too sparse | Add more descriptive topic titles |
| Context file growing too large | Not pruning old exchanges | Add periodic maintenance |
| Decisions lost between switches | Not saving before switch | Call `save_topic()` in switch procedure |
