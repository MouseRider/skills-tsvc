name: tsvc-post-switch
description: >
  Post-switch response pipeline. Runs from self-reset.sh after session deletion.
  Reads pending-reset.json, crafts response, sends ack to Telegram.

steps:
  - id: read_pending
    command: |
      PENDING="/home/node/.openclaw/workspace/tsvc/pending-reset.json"
      [ ! -f "$PENDING" ] && echo '{"error":"no pending-reset.json"}' && exit 1
      python3 -c "
      import json
      with open('$PENDING') as f:
          d = json.load(f)
      print(json.dumps({
          'topicId': d.get('toTopic',{}).get('id',''),
          'topicTitle': d.get('toTopic',{}).get('title','the topic'),
          'triggeringMessage': d.get('triggeringMessage','').strip()
      }))
      "
    cwd: /home/node/.openclaw/workspace

  - id: craft_response
    command: |
      TRIGGER='${read_pending.triggeringMessage}'
      TITLE='${read_pending.topicTitle}'
      TRIGGER_LOWER=$(echo "$TRIGGER" | tr '[:upper:]' '[:lower:]')
      IS_QUESTION=false
      if echo "$TRIGGER_LOWER" | grep -qE '\?|^(how|what|why|when|where|can|do|is|are|should|could|will|did|has|have) '; then
        IS_QUESTION=true
      fi
      if [ "$IS_QUESTION" = true ]; then
        MSG="Switched to ${TITLE}. Give me a sec to pull up context for your question."
      else
        MSG="Switched to ${TITLE}. What do you want to dig into?"
      fi
      echo "{\"message\":\"$MSG\"}"
    cwd: /home/node/.openclaw/workspace

  - id: send_ack
    command: |
      openclaw message send \
        --target "YOUR_SENDER_ID" \
        --channel telegram \
        --message '${craft_response.message}' \
        --json 2>&1 || echo '{"error":"message send failed"}'
    cwd: /home/node/.openclaw/workspace
