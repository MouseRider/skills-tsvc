name: tsvc-boot-sequence
description: >
  Deterministic TSVC boot sequence. Checks for pending topic switch,
  captures telemetry, switches context, and outputs result as JSON.

steps:
  # Step 1: Check for pending reset
  - id: check_pending
    command: >
      if [ -f tsvc/pending-reset.json ]; then
        cat tsvc/pending-reset.json;
      else
        echo '{"reason":"none"}';
      fi
    cwd: /home/node/.openclaw/workspace

  # Step 2: Extract reason and bail if not a switch
  - id: get_reason
    command: echo '$check_pending.stdout' | jq -r '.reason'
    condition: true

  # Step 3: Capture post-reset telemetry (only if switch)
  - id: capture_telemetry
    command: bash tsvc/scripts/capture-post-reset-telemetry.sh
    cwd: /home/node/.openclaw/workspace
    when: "$get_reason.stdout != 'none'"

  # Step 4: Extract target topic ID
  - id: get_target
    command: echo '$check_pending.stdout' | jq -r '.toTopic.id'

  # Step 5: Switch TSVC manager to target topic
  - id: switch_topic
    command: node tsvc/scripts/tsvc-manager.js switch $get_target.stdout
    cwd: /home/node/.openclaw/workspace

  # Step 6: Load topic context
  - id: load_context
    command: cat tsvc/contexts/$get_target.stdout.md 2>/dev/null || echo "NO_CONTEXT_FILE"
    cwd: /home/node/.openclaw/workspace

  # Step 7: Extract triggering message
  - id: get_trigger
    command: echo '$check_pending.stdout' | jq -r '.triggeringMessage'

  # Step 8: Cleanup pending files
  - id: cleanup
    command: rm -f tsvc/pending-reset.json tsvc/next-topic.txt; echo "cleaned"
    cwd: /home/node/.openclaw/workspace

  # Step 9: Patch t2 telemetry
  - id: patch_t2
    command: bash tsvc/scripts/patch-t2-telemetry.sh 2>/dev/null || echo '{"status":"no_telemetry"}'
    cwd: /home/node/.openclaw/workspace

  # Step 10: Output summary for LLM consumption
  - id: summary
    command: >
      echo '{"switch_complete": true, "target_topic": "'$get_target.stdout'", "triggering_message": "'$get_trigger.stdout'"}'
