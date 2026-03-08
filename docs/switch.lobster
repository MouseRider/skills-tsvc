name: tsvc-switch
description: >
  Deterministic topic switch initiation via Lobster.
  Logs exchanges, writes pending-reset.json, triggers self-reset.
  After running, LLM responds with NO_REPLY.

args:
  topic_id:
    description: Target topic ID to switch to
  user_message:
    description: The user message that triggered the switch
    default: ""

steps:
  - id: log_exchanges
    command: python3 scripts/tsvc-exchange-logger.py 2>/dev/null; echo '{"logged":true}'
    cwd: /home/node/.openclaw/workspace

  - id: write_pending
    command: bash tsvc/scripts/tsvc-switch.sh "${topic_id}" "${user_message}"
    cwd: /home/node/.openclaw/workspace

  - id: self_reset
    command: nohup bash scripts/self-reset.sh > /tmp/self-reset.log 2>&1 & echo '{"reset_triggered":true}'
    cwd: /home/node/.openclaw/workspace
