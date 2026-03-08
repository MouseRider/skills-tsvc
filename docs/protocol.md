# TSVC Protocol Specification

**Version:** 1.0  
**Status:** Production (in active use)  
**Last Updated:** 2026-03-05

## Overview

TSVC (Topic-Scoped Virtual Context) is a file-based protocol for isolating conversational context by topic in persistent AI agents. Each topic maintains its own context file, exchange history, and decision chain — preventing cross-topic contamination and reducing context window pressure.

This specification describes the data structures, switching protocol, and operational rules that any agent framework can implement.

## Design Principles

1. **Files over databases.** Everything is markdown and JSON. No vector DB, no Redis, no PostgreSQL required.
2. **Framework agnostic.** TSVC doesn't care about your agent framework. If your agent can read files and reset its session, it can use TSVC.
3. **One topic at a time.** The active topic gets the full context budget. Other topics are paged out to disk.
4. **Invisible switching.** the user should never notice a topic switch. No "goodbye" before, seamless continuation after.
5. **Lean storage.** Save decisions and key outcomes — not every utterance.

## Directory Structure

```
tsvc/
├── active-state.json              # Current active topic pointer
├── metrics.json                   # Cross-topic telemetry
├── unresolved-intentions.md       # Tasks where the WHY is unclear
│
├── topic_files/
│   ├── index.json                 # Topic registry (all topics, metadata)
│   └── <topic_id>.json            # Per-topic state (status, timestamps, stats)
│
├── contexts/
│   └── <topic_id>.md              # Per-topic hot context (decisions, state, recent exchanges)
│
├── conversations/
│   └── <topic_id>.jsonl           # Per-topic exchange log (full history)
│
├── telemetry/
│   └── switches.jsonl             # Switch timing and performance data
│
├── backups/                       # Versioned backups of known-good states
│
└── scripts/                       # Management utilities (reference implementation)
    ├── tsvc-manager.js            # Core operations
    ├── tsvc-switch.sh             # Full switch procedure
    └── capture-telemetry.sh       # Performance measurement
```

## Data Structures

### active-state.json

```json
{
  "activeTopicId": "topic_trading",
  "activeSince": "2026-03-05T15:00:00Z",
  "sessionId": "abc123"
}
```

### topic_files/index.json

```json
{
  "topics": [
    {
      "id": "topic_trading",
      "title": "Options Trading",
      "status": "active",
      "createdAt": "2026-02-20T10:00:00Z",
      "lastAccessedAt": "2026-03-05T15:00:00Z",
      "exchangeCount": 142,
      "decisionCount": 23,
      "switchCount": 15
    },
    {
      "id": "topic_infrastructure",
      "title": "Infrastructure & DevOps",
      "status": "paged",
      "createdAt": "2026-02-18T08:00:00Z",
      "lastAccessedAt": "2026-03-04T22:00:00Z",
      "exchangeCount": 89,
      "decisionCount": 12,
      "switchCount": 8
    }
  ]
}
```

**Topic statuses:**
- `active` — currently loaded, receiving the full context budget
- `paged` — saved to disk, not in context window
- `archived` — old topic, preserved but unlikely to be re-accessed

### contexts/<topic_id>.md

The hot context file is the heart of TSVC. It contains everything the agent needs to resume work on a topic:

```markdown
# Topic: Options Trading

## Active Decisions
- 2026-03-04: Switched to iron condors on SPY for March expiry [reason: low IV environment]
- 2026-03-03: Set max position size to 2% of portfolio [reason: risk management review]

## Decision Chains
- [root] → Set max position size to 2% → Applied to all new positions
- [root] → Switched to iron condors → Closed existing credit spreads first

## Current State
- Open positions: 3 iron condors (SPY, QQQ, IWM)
- Watching: VIX term structure for reversal signal
- Next action: Review positions at market close Friday

## Recent Exchanges (last 5)
- user: "What's our P&L on the SPY condor?"
- assistant: "Up $142, 3 DTE, theta working in our favor..."
- user: "Should we close early or let it expire?"
- assistant: "With 3 DTE and $142 profit on a $500 max, I'd close at 80%..."

## Open Items
- [ ] Research LEAPS strategy for Q2
- [ ] Set up automated P&L tracking
```

**Key principles for context files:**
- Keep them lean — this loads into the context window
- Decisions are first-class citizens (timestamped, with reasoning)
- Recent exchanges provide conversational continuity
- Open items prevent dropped threads

### conversations/<topic_id>.jsonl

Full exchange history in append-only JSONL format:

```jsonl
{"ts":"2026-03-05T15:04:00Z","role":"user","content":"What's the status on...","topicId":"topic_trading"}
{"ts":"2026-03-05T15:04:05Z","role":"assistant","content":"Here's where we are...","topicId":"topic_trading"}
```

This is the source of truth for conversation history. The context file contains only recent exchanges; the JSONL file contains everything.

### telemetry/switches.jsonl

```jsonl
{
  "switchId": "sw_001",
  "fromTopic": "topic_trading",
  "toTopic": "topic_infrastructure",
  "t0": "2026-03-05T15:00:00Z",
  "t1": "2026-03-05T15:00:03Z",
  "t2": "2026-03-05T15:00:08Z",
  "preContextSize": 45000,
  "postContextSize": 22000,
  "triggeringMessage": "Let's check on the Docker setup",
  "detectionMethod": "explicit"
}
```

**Timing:**
- `t0` — switch initiated (pre-reset)
- `t1` — new session loaded (post-reset)
- `t2` — first reply sent to user

## Protocol Operations

### 1. Topic Detection

When the user sends a message, the agent must determine whether it belongs to the current topic or requires a switch.

**Detection methods:**
- **Explicit:** User says "switch to X" or "let's talk about Y"
- **Implicit:** Message content doesn't match current topic's domain. Agent classifies against known topics.
- **New:** Message doesn't match any existing topic. Agent creates a new one.

**Rules:**
- Don't create topics for tiny asides — only for substantive threads
- Don't ask "want to switch?" — just do it, unless genuinely ambiguous
- When uncertain, stay on current topic and note the potential switch

### 2. Topic Switch

The switch procedure has two phases: pre-reset (current session) and post-reset (new session).

#### Pre-Reset (current session)

1. Save current topic state to disk
2. Log any unlogged exchanges to current topic
3. Append the user's triggering message to the TARGET topic
4. Write `pending-reset.json`:

```json
{
  "reason": "topic_switch",
  "fromTopic": {
    "id": "topic_trading",
    "title": "Options Trading"
  },
  "toTopic": {
    "id": "topic_infrastructure",
    "title": "Infrastructure & DevOps"
  },
  "triggeringMessage": "Let's check on the Docker setup",
  "recentExchanges": [...],
  "recentDecisions": [...],
  "telemetry": {
    "t0": "2026-03-05T15:00:00Z",
    "preContextSize": 45000,
    "preMessageCount": 128
  }
}
```

5. Trigger a session reset (implementation-specific — see Integration Guide)
6. Do NOT send any "switching" message to the user

#### Post-Reset (new session)

1. On boot, check for `pending-reset.json`
2. If found with `reason === "topic_switch"`:
   a. Load the target topic's context file
   b. Read `triggeringMessage` and `recentExchanges` from the pending file
   c. Delete `pending-reset.json`
   d. Respond to the user immediately:
      - If triggering message was a **question** → answer it
      - If it was a **statement/direction** → acknowledge and continue
      - If it was "switch to X" → summarize where you left off
3. Log telemetry (t1 on load, t2 after first reply)

**Critical rule:** the user must receive a response after every switch. Silence = broken.

### 3. Context Management

#### Appending Exchanges

Not every message needs to be logged. Log exchanges that:
- Contain decisions
- Introduce new information
- Change direction or priorities
- Are needed for continuity on next resume

#### Logging Decisions

Decisions are first-class in TSVC. Each decision includes:
- Timestamp
- The decision text
- The reasoning (why)
- Chain relationship (what it supersedes, if anything)

```
decision(topicId, "Switched to iron condors", reason="low IV environment", supersedes="dec_previous")
```

#### Context File Maintenance

The context file must stay lean enough to fit comfortably in a context window. Periodically:
- Archive old exchanges (keep only last 5-10)
- Summarize resolved decision chains
- Move completed items off the open items list
- Target: context file under 2-3K tokens per topic

### 4. Awareness Layer

The agent maintains a lightweight awareness of all topics (~100-200 tokens total) even when only one topic is active. This enables topic detection without loading full contexts.

```
Topics: Trading (active, 23 decisions), Infrastructure (paged, last: 2h ago), 
Family (paged, last: 1d ago), TSVC Development (paged, last: 3h ago)
```

### 5. Topic Lifecycle

```
[created] → [active] → [paged] ←→ [active] → [archived]
```

- **Created → Active:** New topic, immediately active
- **Active → Paged:** Another topic becomes active
- **Paged → Active:** User switches back
- **Paged → Archived:** Topic inactive for extended period (configurable, e.g., 30 days)
- **Archived → Active:** User explicitly returns to an old topic

## Implementation Requirements

To implement TSVC, your agent framework needs:

1. **File read/write** — Read and write markdown and JSON files
2. **Session reset** — Ability to get a clean context window (implementation varies by framework)
3. **Boot hook** — Code that runs on session start to check for `pending-reset.json`
4. **Message classification** — Ability to determine which topic a message belongs to (can be LLM-based or keyword-based)

## Performance Characteristics

From production use with a 128K context window agent handling 10+ concurrent topics:

| Metric | Before TSVC | After TSVC |
|--------|------------|------------|
| Context utilization | 90%+ (constant pressure) | 40-60% per topic |
| Compaction frequency | Every 20-30 messages | Every 60-100 messages |
| Topic coherence | Cross-contamination common | Isolated by design |
| Resume quality | Degraded after 2-3 switches | Consistent regardless of switches |
| Switch latency | N/A | 3-8 seconds (including session reset) |

## Anti-Patterns

- **Don't create a topic for every message.** Topics are for sustained threads, not one-off questions.
- **Don't load multiple topics simultaneously.** One topic gets the full budget. The awareness layer is tiny by design.
- **Don't store everything in context files.** Keep them lean. Full history goes in JSONL files.
- **Don't ask before switching.** If the topic clearly changed, just switch. Asking adds friction and breaks the "invisible" principle.
- **Don't send goodbye messages.** The switch is invisible. No "I'm switching now" or "one moment while I change topics."

## Versioning

This is version 1.0 of the TSVC protocol. Future versions may add:
- Multi-topic awareness (loading summaries from 2-3 related topics)
- Topic relationships and dependency tracking
- Automated context file summarization
- Cross-topic decision impact analysis
