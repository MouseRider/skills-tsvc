---
name: exchange-logger
description: "Per-topic conversation logging for TSVC-aware agents. Captures exchanges before compaction destroys them."
metadata: {"openclaw":{"emoji":"📝","requires":{"bins":["python3"]}}}
user-invocable: false
---

# Exchange Logger

Run periodically to capture conversation exchanges to per-topic JSONL files.

## Usage

```bash
python3 {baseDir}/tsvc-exchange-logger.py
```

Recommended: run via cron or heartbeat every 30 minutes, and during pre-compaction memory flush.

See README.md for configuration and integration details.
