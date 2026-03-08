# Exchange Logger

**Per-topic conversation logging for agents with topic-scoped context.**

Captures user/assistant exchanges and routes them to the correct topic's conversation log. Designed for agents using [TSVC](https://github.com/MouseRider/skills-tsvc) but works with any topic-aware agent.

## The Problem

Long-running agents lose conversation history to compaction. By the time context pressure forces a summary, the nuance of individual exchanges is gone. You can't go back and see *exactly* what was discussed about a topic three days ago.

## What This Does

The exchange logger:

1. Scans the active session transcript
2. Identifies which topic each exchange belongs to
3. Writes exchanges to per-topic `.jsonl` files
4. Tracks last-processed position to avoid duplicates

Run it periodically (heartbeat, cron, or pre-compaction flush) to capture exchanges before compaction destroys them.

## Output Format

Each topic gets a `conversation.jsonl` file:

```jsonl
{"ts": "2026-03-05T15:04:00Z", "role": "user", "content": "What's the status on..."}
{"ts": "2026-03-05T15:04:05Z", "role": "assistant", "content": "Here's where we are..."}
```

## Usage

```bash
python3 tsvc-exchange-logger.py
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE` | `~/.openclaw/workspace` | Agent workspace root |

### Integration with TSVC

The logger reads `tsvc/active-state.json` to determine the current topic and routes exchanges accordingly. Conversation logs are written to `tsvc/conversations/<topic_id>.jsonl`.

### Integration with Cron

```bash
# Run every 30 minutes via OpenClaw cron
openclaw cron add --name exchange-logger --schedule "*/30 * * * *" --prompt "Run the exchange logger: python3 scripts/tsvc-exchange-logger.py"
```

## Requirements

- Python 3.8+
- Access to agent session transcripts (`.jsonl` files)
- TSVC directory structure (or compatible topic-aware setup)

## License

MIT
