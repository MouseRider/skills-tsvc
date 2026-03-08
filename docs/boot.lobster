name: tsvc-boot
description: >
  Deterministic TSVC boot sequence via Lobster.
  Checks for pending topic switch, executes all steps, outputs structured JSON.

steps:
  - id: boot
    command: bash tsvc/scripts/tsvc-boot.sh
    cwd: /home/node/.openclaw/workspace
