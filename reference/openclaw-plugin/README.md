# OpenClaw TSVC Plugin — Reference Implementation

This is a working OpenClaw plugin that implements TSVC topic switching as an event-driven integration.

## What It Does

- **Intercepts incoming messages** and runs topic detection (`detect-topic-switch.js`)
- **Classifies switch confidence** into tiers (Tier 1 = obvious, Tier 2 = possible, Tier 3 = confirmed)
- **Injects context** into the agent's reply stream during switches
- **Triggers session reset** after the agent responds, so the next boot loads the new topic

## Architecture

```
User message → Plugin intercepts → detect-topic-switch.js
                                         │
                              ┌──────────┼──────────┐
                              │          │          │
                          No switch   Tier 2     Tier 3
                          (pass)     (suggest)  (execute)
                                                    │
                                          Save current topic
                                          Load new topic context
                                          Inject into agent reply
                                          Queue session reset
```

## Platform-Specific Parts

The only OpenClaw-specific pieces are:

1. **Event hooks** — `onBeforeRun` / `onAfterRun` (your platform's equivalent)
2. **Session reset** — deleting the transcript file to force a fresh boot
3. **Context injection** — prepending topic context to the agent's system prompt

Everything else (topic detection, context files, state management) is framework-agnostic and lives in `src/`.

## Adapting to Other Platforms

To port this to another agent harness:

1. Replace the event hook mechanism with your platform's equivalent
2. Implement session reset for your platform (restart, clear history, etc.)
3. Wire up context injection (system prompt, tool results, or whatever your platform supports)

See the main README's Portability section for more details.
