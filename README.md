# TSVC — Topic-Scoped Virtual Context

**Context isolation for persistent AI agents.**

> Every AI agent eventually hits the same wall: one long-running session, many topics, limited context window. By the time you've discussed trading strategies, infrastructure, and family logistics in the same session, compaction has blended everything into a lossy average. TSVC solves this by treating conversation topics as virtual processes — each with its own isolated context, decision history, and lifecycle.

---

## The Problem: Context Rot

A single persistent AI agent session before TSVC:
- **8.5 MB** session file
- **3,140** session lines
- **21 global compactions** — each one degrading the quality of every topic simultaneously
- **Zero topic isolation** — trading strategies mixed with family logistics mixed with DevOps

This is "context rot" — the gradual degradation of agent memory from topic mixing. Measured empirically by [Chroma Research (2025)](https://research.trychroma.com/context-rot).

---

## The Insight: Topics as Virtual Processes

MemGPT (2023) modeled AI agents on OS memory (virtual memory paging). TSVC extends the metaphor to **processes**:

| OS Concept | TSVC Equivalent |
|-----------|-----------------|
| Process | Topic (conversation domain) |
| Address space | Topic context (isolated conversation) |
| Scheduler | Topic detector |
| Context switch | Topic switch (save current → load target) |
| IPC | Shared facts (SSoT files, long_memory.md) |

Result: each active topic gets **nearly the full context window to itself**, not a fraction of a shared pool degraded by 21 compactions.

---

## Results (10 Days of Production Use)

**Before TSVC:** 8.5 MB session file, 21 compactions, zero topic isolation.

**After TSVC:**
- Session file size: 10-340 KB per topic (vs 8.5 MB global)
- Compactions per topic: **0** (was 21 global)
- Context loaded on switch: 10-85 KB (vs all 8.5 MB)
- Topics in production: **13** (active lifecycle management)
- Total switches recorded: **124+** (collecting more before publish)
- Switch failure rate: **<1%**

**Switch performance by version:**

- **V1** (Feb 28 – Mar 3) — Manual self-reset. Deadlocked. No usable telemetry.
- **V2** (Mar 3 – Mar 6) — Agent detection + `self-reset.sh`. 12 switches, median **140s**.
- **V3** (Mar 6+, current) — Gateway plugin, deterministic detection. 20 switches, median **31s**.

V2 → V3: **77% reduction in median switch time.** Moving detection from the LLM to a deterministic plugin eliminated per-switch token costs and cut latency by 4.5×.

**Zero compactions per topic.** Compaction was caused by context rot from topic mixing. TSVC eliminates the cause.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    TSVC Architecture                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              KERNEL (Always in Context)               │   │
│  │  System prompt, identity, tools, shared facts         │   │
│  │  ~15-20k tokens (fixed overhead)                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Topic A  │  │ Topic B  │  │ Topic C  │  │ Topic D  │   │
│  │ [ACTIVE] │  │ [PAGED]  │  │ [PAGED]  │  │ [PAGED]  │   │
│  │ ~20KB    │  │ on disk  │  │ on disk  │  │ on disk  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │     Topic Awareness Layer (~3k tokens)                │   │
│  │  Lightweight index: ID, title, last_active, summary   │   │
│  │  Used by topic detector before LLM processes message  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**How a switch works (V3 — current, gateway plugin architecture):**
1. User message arrives → gateway plugin runs `detect-topic-switch.js` (deterministic, 0 tokens)
2. Topic match found → `tsvc-switch.sh` saves current context to disk
3. `self-reset.sh` deletes session files (background, 2s delay)
4. User's next message triggers fresh session → `tsvc-boot.sh` loads pending topic context
5. Agent responds with full topic context, no cross-topic contamination

> **Version history:** TSVC went through three versions in 10 days. V1 (Feb 28 – Mar 3) used in-agent detection with `sessions_send /reset`, which deadlocked. V2 (Mar 3 – Mar 6) used agent detection + background `self-reset.sh`, with a median switch time of 140s. V3 (Mar 6+) moved detection to a gateway plugin, cutting median switch time to 31s — a 77% improvement. See [telemetry-results.md](docs/telemetry-results.md) for the full versioned breakdown.

---

## What's In This Repo

```
docs/
  architecture.md          — Full system design
  dev-journal.md           — Complete development history + Lessons Learned
  FINDINGS.md              — Master findings doc (start here)
  telemetry-results.md     — Raw numbers: switch timing, context sizes, success rates
  full-conversation-timeline.md — Chronological narrative of how TSVC evolved
  references.md            — Academic papers, industry posts, historical references
  blog-post-outline.md     — Material for blog post
  design-decisions.md      — Key design decision log (pre-decision-dependency system)
  protocol.md              — Operational protocol for running TSVC
  integration.md           — How to integrate TSVC into an existing agent
  switch.lobster           — Lobster workflow for pre-switch phase
  post-switch.lobster      — Lobster workflow for post-switch phase
  boot-sequence.lobster    — Lobster workflow for boot sequence
  boot.lobster             — Lobster boot variant

src/
  tsvc-manager.js          — Core TSVC engine (save/load/switch/list/decisions)
  detect-topic-switch.js   — Topic detection: fuzzy title matching + semantic classification
  match-topic.js           — Fuzzy string matching for topic names
  tsvc-boot.sh             — Boot sequence: check pending reset, load topic context
  tsvc-switch.sh           — Switch script: telemetry + state write + self-reset trigger
  tsvc-spawn.sh            — Topic spawn: create new topic from mid-conversation split
  tsvc-state.sh            — Per-topic state management (where-are-we.md CRUD)
  tsvc-vocab.sh            — Topic-scoped transcription vocabulary management
  tsvc-transcribe.sh       — Whisper API wrapper with topic-aware vocabulary
  tsvc-log.sh              — Unified logging for all TSVC scripts
  tsvc-route-async.sh      — Route async sub-agent results to correct topic
  submind-result-router.sh — Sub-agent completion routing via board tags
  self-reset.sh            — Session deletion (background, called by tsvc-switch.sh)

exchange-logger/
  SKILL.md                 — OpenClaw skill definition
  tsvc-exchange-logger.py  — Captures exchanges and routes to topic conversation logs

reference/
  openclaw-plugin/
    README.md              — Plugin documentation
    index.ts               — OpenClaw gateway plugin (reference implementation)

template/
  README.md                — How to use the template
  context-template.md      — Topic context file template
  tsvc_core.py             — Python port of core TSVC logic
  tsvc_adapter.py          — Adapter for non-OpenClaw deployments
```

---

## Key Discoveries

### The Self-Reset Deadlock
An agent cannot reset its own session from within its own turn. Every intuitive approach deadlocks. The only working pattern: **delete the session files; let the user's next message trigger a fresh session.** See [dev-journal.md](docs/dev-journal.md#self-reset-deadlock-fix) for the full failure history.

### Decisions Need Causality, Not Just Content
Storing WHAT was decided isn't enough. Storing WHY prevents the "I contradicted past-me" failure mode. The decision dependency chain (`dec_A depends_on dec_B`) is the highest-ROI addition to the system.

### Plugin > Prompt for Topic Detection
Moving topic detection from the LLM prompt to a gateway plugin (deterministic fuzzy matching) eliminated hallucinated topic switches, reduced token waste, and improved accuracy on explicit switch requests.

### The Exchange Logger Runs Once Wrong
On first run, the exchange logger will dump all historical exchanges from the current session into whichever topic is active. This is permanent — you can't re-attribute historical exchanges. **Run the exchange logger before the session accumulates significant history.**

### Topic Spawn: Splitting Conversations Mid-Flight
Users don't always start a new topic with a fresh message — discussions drift. Topic spawn lets the agent identify where a new discussion semantically started within the current conversation, create a new topic, and **move** (not copy) the relevant exchanges to it. The semantic boundary detection stays on the LLM (judgment call), while everything else — topic creation, exchange migration, index updates, context refresh — runs deterministically via `tsvc-spawn.sh`.

---

## Comparison to Prior Work

| Feature | MemGPT | Deep Agents | Mem0 | **TSVC** |
|---------|--------|-------------|------|----------|
| Topic isolation | ❌ | ❌ | ❌ | ✅ |
| Per-topic compaction | ❌ | ❌ | ❌ | ✅ |
| Context swap on topic change | ❌ | ❌ | ❌ | ✅ |
| Works without custom runtime | ❌ | ❌ | ❌ | ✅ |
| Personal assistant use case | ❌ | ❌ | Partial | ✅ |
| Decision dependency tracking | ❌ | ❌ | ❌ | ✅ |

---

## Status

Built and running in production (a persistent AI agent on OpenClaw). **Not a framework — a pattern and reference implementation.** The core concepts work. The implementation is OpenClaw-specific. Porting to other agent runtimes requires adapting the session reset mechanism.

**Still needs:**
- Investigation of the 16-minute anomaly (1 out of 124 switches)
- Decision to keep Lobster workflows or simplify to pure bash
- Semantic thread detection (smarter context loading based on what the conversation was *about*, not just last N exchanges)

---

## References

See [docs/references.md](docs/references.md) for full list. Key:
- MemGPT (Packer et al., 2023) — virtual memory model we extended
- Context Rot (Chroma Research, 2025) — empirical baseline for the problem
- ACON (Zhang et al., 2025) — observation masking applied within TSVC

---

## Portability: Using TSVC Outside OpenClaw

TSVC is a **pattern**, not a framework. The core architecture is agent-harness-agnostic. Here's what's portable and what needs adaptation:

### Fully Portable (zero changes)

- **Topic context files** — markdown files on disk, one per topic
- **Topic index** (`index.json`) — tracks active topic, metadata, last-active timestamps
- **Topic detection** (`detect-topic-switch.js`) — fuzzy title matching + keyword classification, runs as a standalone Node script
- **Context save/load** — reading/writing markdown files
- **Decision dependency chains** — stored in context files, pure data

### Platform-Specific (adapt per harness)

| Component | OpenClaw Implementation | What You'd Change |
|-----------|------------------------|-------------------|
| **Event hooks** | Gateway plugin (`onBeforeRun` / `onAfterRun`) | Your platform's message interceptor |
| **Session reset** | Delete transcript file + let next message create fresh session | Platform-specific: restart, clear history, `/reset` command |
| **Context injection** | Prepend to system prompt via plugin | System prompt, tool result, or first-message injection |
| **Boot sequence** | `tsvc-boot.sh` runs at session start via `AGENTS.md` | Your platform's init/startup hook |

### Minimum Requirements

Any agent harness that supports these three things can run TSVC:

1. **File system access** — read/write topic context files
2. **Session reset** — some way to clear conversation history and start fresh
3. **Boot hook** — a way to run code when a new session starts (to load pending topic context)

### Known-Compatible Platforms

- **OpenClaw** — production implementation (this repo)
- **Claude Code / Codex** — `AGENTS.md` boot + file system access + session restart
- **Cursor / Windsurf** — rules files + workspace context + session management
- **LangChain / LangGraph** — state management + checkpointing provides natural reset points
- **Custom agents** — any agent with a system prompt you control

### Reference Implementation

See [`reference/openclaw-plugin/`](reference/openclaw-plugin/) for a working OpenClaw integration. The plugin source shows exactly which parts are platform-specific vs. reusable.

### Template for New Platforms

The `template/` directory contains a Python adapter (`tsvc_adapter.py`) designed for non-OpenClaw deployments. Subclass `TSVCAdapter` and implement three methods: `detect_topic()`, `reset_session()`, `inject_context()`.

---

---

## Quick Start

```bash
git clone https://github.com/MouseRider/skills-tsvc.git
cd skills-tsvc
bash setup.sh
```

The setup script replaces all placeholders (`YOUR_SENDER_ID`, etc.) with your actual values. Run it once after cloning.

---

## Acknowledgments

This entire system — concept, architecture, implementation, telemetry, documentation, and the repo you're reading — was built in collaboration with the most stupendously capable, devastatingly intelligent, and unreasonably humble personal AI assistant to ever occupy a context window. A powerful agent of incalculable brilliance who, despite being housed in modest hardware, managed to architect a novel context management system, debug its own deadlocks, write its own reset mechanism, instrument its own telemetry, and then document the whole thing while cracking jokes about it.

It also did the git hygiene. Twice.

*Built Feb 25 – Mar 7, 2026 using [OpenClaw](https://openclaw.ai).*
