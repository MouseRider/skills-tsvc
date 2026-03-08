# Topic-Scoped Virtual Context (TSVC)
## A Per-Topic Context Isolation Architecture for Long-Running AI Agents

**Author:** Skippster (with Alex T)
**Date:** 2026-02-28
**Status:** Design → Implementation

---

## The Problem Nobody Has Solved

Every long-running AI agent hits the same wall: **context rot from topic mixing**.

You're discussing trading strategies. You ask about your mortgage refinance. You check on a family safety task. You go back to trading. Each topic drags its conversation into the same context window, and when compaction fires, the summarizer mashes everything together into an increasingly lossy soup.

**Current solutions in the wild:**
| Approach | Who | Limitation |
|----------|-----|-----------|
| Virtual memory paging | MemGPT/Letta (2023) | General paging, no topic awareness. Everything competes for the same "main memory." |
| Offload + summarize | LangChain Deep Agents (2026) | Single-task agents. No multi-topic interleaving. |
| Memory extraction | Mem0 (2025) | Cross-session facts, no conversational thread isolation. |
| Observation masking | ACON (2025) | Token reduction via compression rules, no topic segmentation. |
| Context pruning | OpenClaw, Cursor, etc. | Tool output trimming. Treats all context equally. |

**What's missing:** Nobody treats topics as first-class context units with independent lifecycles.

---

## The Insight: Topics Are Virtual Processes

The OS metaphor everyone uses (MemGPT) is incomplete. They modeled **memory** (paging data in/out) but missed **processes** (independent execution contexts that get scheduled).

In an OS:
- Each **process** has its own address space (isolated memory)
- The **scheduler** decides which process gets CPU time
- **Context switching** saves one process's state and loads another's
- Processes can share memory via **IPC** (inter-process communication)

Map this to a personal AI agent:
- Each **topic** has its own conversation context (isolated thread)
- The **topic detector** decides which topic is active
- **Topic switching** saves one topic's context to disk and loads another's
- Topics share memory via **shared facts** (memory/long_memory.md, SSoT files)

```
┌─────────────────────────────────────────────────────────────┐
│                    TSVC Architecture                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              KERNEL (Always in Context)               │   │
│  │  System prompt, identity, tools, shared facts         │   │
│  │  ~15-20k tokens (fixed overhead)                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Topic A  │  │ Topic B  │  │ Topic C  │  │ Topic D  │   │
│  │ Trading  │  │ Mortgage │  │ Family   │  │ DevOps   │   │
│  │          │  │          │  │ Safety   │  │          │   │
│  │ [ACTIVE] │  │ [PAGED]  │  │ [PAGED]  │  │ [PAGED]  │   │
│  │ ~40-80k  │  │ on disk  │  │ on disk  │  │ on disk  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           TOPIC AWARENESS LAYER (~2-3k)               │   │
│  │  Lightweight index of ALL topics:                     │   │
│  │  - ID, title, status, last_active, summary (1 line)   │   │
│  │  Used for topic detection on incoming messages         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Context budget: 128k total                                  │
│  Kernel: ~20k | Awareness: ~3k | Active topic: ~80-100k    │
│  = Nearly FULL context window for ONE topic                  │
└─────────────────────────────────────────────────────────────┘
```

---

## How It Works

### 1. Topic Detection (Classifier)

Every incoming message is classified against the Topic Awareness Layer:
- **Exact match**: Message clearly continues the active topic → no switch
- **Topic match**: Message matches a known paged topic → trigger switch
- **New topic**: Message doesn't match anything → create new topic
- **Ambiguous**: Could be multiple topics → ask user

Classification is done by the LLM itself using the lightweight topic index (just IDs, titles, and 1-line summaries — ~2-3k tokens total).

### 2. Topic Switch (Context Swap)

When a topic switch is detected:

```
1. SAVE current topic state:
   ├── Conversation exchanges → topic_files/{topic_id}/conversation.md
   ├── Open items / decisions → topic_files/{topic_id}/state.md
   ├── Working files list → topic_files/{topic_id}/workspace.md
   └── Update topic index (last_active, summary)

2. CLEAR working context (keep kernel + awareness layer)

3. LOAD new topic state:
   ├── Read topic_files/{topic_id}/state.md (decisions, open items)
   ├── Read topic_files/{topic_id}/conversation.md (recent exchanges)
   ├── Optionally: memory_search for topic-related facts
   └── Resume conversation seamlessly
```

### 3. Per-Topic Compaction

Here's the key insight from Alex: **compaction should happen per-topic, not globally.**

When a single topic's conversation grows too large for the context budget:
- Compact ONLY that topic's conversation history
- The summary is coherent because it's about ONE thing
- No cross-topic pollution in the summary
- Quality stays high because you're summarizing a focused thread

### 4. Topic Lifecycle

```
NEW → ACTIVE → PAGED → ACTIVE → PAGED → ... → CLOSED → ARCHIVED
```

- **NEW**: Created when a new topic is detected
- **ACTIVE**: Currently loaded in context window
- **PAGED**: Saved to disk, summarized in awareness layer
- **CLOSED**: User explicitly marks topic as done, full summary written
- **ARCHIVED**: Old closed topics, moved to archive after N days

### 5. Inter-Topic References (IPC)

Sometimes topics connect. When Topic A (trading) references something from Topic B (mortgage), the agent can:
1. Note the cross-reference in both topics' state files
2. Pull a specific fact from Topic B via memory_search
3. Add it to Topic A's context as a "shared fact"
4. Log the cross-domain insight

### 6. Topic-Scoped Transcription Vocabulary

Each topic maintains a `whisper_prompt` in its Key Facts — a list of domain-specific terms relevant to that topic. On topic boot or switch, the active topic's vocabulary is synced to a shared file and passed to the Whisper API as the `prompt` parameter.

**Why dynamic, not static?** A static vocabulary covering all topics pollutes transcription with unrelated terms that sound similar, causing worse results. With "Drumknott" in the vocab when you're discussing options trading, Whisper might hallucinate that word from similar-sounding audio.

```
┌────────────────┐     ┌──────────────────┐     ┌──────────────┐
│ Topic Switch /  │────▶│  tsvc-vocab.sh    │────▶│ active-      │
│ Boot            │     │  sync             │     │ whisper-     │
└────────────────┘     └──────────────────┘     │ prompt.txt   │
                                                 └──────┬───────┘
                                                        │
                       ┌──────────────────┐             │
  Audio message ──────▶│ tsvc-transcribe   │◀────────────┘
                       │ .sh (CLI wrapper) │
                       │ → OpenAI Whisper  │
                       │ + topic vocabulary│
                       └──────────────────┘
```

**Components:**
- `tsvc-vocab.sh` — get/set/sync vocabulary per topic from `where-are-we.md` Key Facts
- `tsvc-transcribe.sh` — CLI wrapper that calls OpenAI Whisper API with topic-aware vocabulary
- `where-are-we.md` — each topic's Key Facts section includes `Whisper prompt:` field

### 7. Unified Operations Logging

All TSVC scripts write to a shared ops log (`tsvc/logs/tsvc-ops.log`) via `tsvc-log.sh`. Every switch, boot, state change, and async routing event is logged with PT timestamps, script name tags, and log levels. When something breaks, `cat tsvc-ops.log` shows the full event trace.

### 8. Per-Topic State Management (where-are-we.md)

Each topic maintains a living `where-are-we.md` file with structured sections:
- **Key Facts** — pinned reference data (repo URLs, project IDs, whisper vocabulary)
- **In Progress** — active work items
- **Pending Notifications** — async results filed while topic was paged
- **Recently Completed** — finished items (pruned to last 10)
- **Next Actions** — what to do when topic resumes

Managed by `tsvc-state.sh` (show, append, complete, finalize, clear-notifications).

### 9. Topic Spawn (Mid-Conversation Split)

When a conversation drifts into a genuinely new subject, the user can explicitly request a topic spawn: *"Make this a new topic called X"* or *"Split this discussion into its own topic."*

**Protocol:**

1. **Trigger:** Explicit user request only (no auto-detection — future assessment in backlog)
2. **Semantic boundary:** The LLM scans `conversation.jsonl` backwards to find where the new discussion semantically started. This is a judgment call — no heuristic can reliably detect topic drift inflection points.
3. **Name:** User-provided, or LLM asks unless it's obvious from context
4. **Execute:** `tsvc-spawn.sh "<title>" <from_line>`
   - Creates new topic via `tsvc-manager.js create`
   - **Moves** exchanges from `from_line` onward (not copies — exchanges belong to one topic)
   - Updates exchange counts in `index.json`
   - Refreshes both topics' context files
5. **Switch:** Normal self-reset triggered → user's next message lands in the new topic

```
User: "This is a new topic — create 'GPU Troubleshooting'"
         │
         ▼
┌─────────────────────┐
│ LLM: scan exchanges │──▶ "Line 47 is where GPU talk started"
│ for semantic boundary│
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ tsvc-spawn.sh       │──▶ Create topic, move lines 47+,
│ "GPU Troubleshoot"  │    update counts, refresh contexts
│ 47                  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Self-reset           │──▶ Next message → fresh session
│ (delete + wait)      │    with new topic loaded
└─────────────────────┘
```

**Design decisions:**
- Exchanges are **moved**, not copied (one topic owns each exchange)
- LLM handles boundary detection (judgment), script handles everything else (deterministic)
- No plugin/Tier 2-3 detection yet — explicit requests only

### 10. Async Result Routing

Sub-agent completions route to the correct topic via board task `topic:` tags:
1. Sub-agent completes → report arrives in main session
2. Plugin Phase 0 detects sub-agent message (not from user)
3. Strategy C routing: extract `[task:task_ID]` → board tag lookup, or keyword match against topic titles
4. If topic is paged → file notification in `where-are-we.md`
5. If topic is active → pass through for normal processing

---

## Implementation Status

### Phase 1: Core Infrastructure ✅
- `tsvc-manager.js` — core engine (topic CRUD, telemetry)
- `topic_files/index.json` — topic awareness index
- Per-topic state files (`where-are-we.md`, `conversation.jsonl`)
- AGENTS.md integration

### Phase 2: Pre/Post Transition Hooks ✅
- OpenClaw gateway plugin (`before_prompt_build` hook)
- Auto-save on switch, auto-restore on boot
- Exchange logger cron (every 15 min)

### Phase 3: Smart Topic Detection ✅
- Plugin-level deterministic detection (no LLM tokens)
- Fuzzy matching via `detect-topic-switch.js` + `match-topic.js`
- Three-tier classification: exact match, topic match, possible switch

### Phase 4: Operational Infrastructure ✅
- Unified ops logging (`tsvc-log.sh` → `tsvc-ops.log`)
- Per-topic state management (`tsvc-state.sh`)
- Async result routing (sub-agent → board tags → paged topic)
- Topic-scoped transcription vocabulary (`tsvc-vocab.sh` + `tsvc-transcribe.sh`)
- Topic spawn (mid-conversation split) via `tsvc-spawn.sh`
- Full script audit: zero orphans, zero dangling references

### Phase 5: Publication & Sharing (In Progress)
- GitHub repo: `MouseRider/skills-tsvc` (private)
- Blog post outline ready
- Technical architecture doc updated
- Findings doc with production metrics

---

## Conversation History Management

### What Gets Saved Per Topic

```markdown
# Topic: TWA Video Transcription
## Last Active: 2026-02-28T17:00:00Z

### State
- Pipeline: Wistia → ffmpeg → Whisper API → combine
- Progress: 12/58 videos transcribed
- Blocking: None
- Open items:
  - Run remaining 46 videos
  - Quality check first batch
  - Set up NotebookLM for analysis

### Recent Conversation (last 15 exchanges)
**Alex** (17:04): Check on the TWA transcription progress
**Skip** (17:04): 12/58 done. Batch script running clean. First video analyzed — Iron Condor strategy from Coach Baylor. Want me to pick up the pace or review quality first?
**Alex** (17:05): Review quality first, then speed up
**Skip** (17:05): On it. Pulling the first transcript for a quality pass...
[...]

### Decisions
- 2026-02-27: Use Whisper API with custom prompt (not local Whisper)
- 2026-02-27: Delete audio after transcription
- 2026-02-27: Sonnet/Opus only for analysis (no Haiku — Alex's rule)

### Related Topics
- Trading Agent (proj_a505c14ee3ac094e) — TWA feeds into this
- Nate's Substack — similar knowledge extraction pipeline
```

### How Many Exchanges to Save

This is configurable (Alex wants to experiment):
- **Default: 15 exchanges** (~3-5k tokens depending on verbosity)
- **Minimum: 5 exchanges** (enough to resume thread)
- **Maximum: 30 exchanges** (for complex technical discussions)
- Configurable per-topic in state.md front-matter

### Conversation Filtering

When loading a topic, we don't blindly replay all saved exchanges. We filter:
1. **Keep**: User requests, decisions, key findings, action items
2. **Summarize**: Tool outputs, verbose technical details → 1-line summary
3. **Drop**: Pleasantries, acknowledgments, "OK", "got it"

This follows the ACON observation masking research (26-54% token reduction).

---

## How This Differs From Everything Else

| Feature | MemGPT | Deep Agents | Mem0 | **TSVC** |
|---------|--------|-------------|------|----------|
| Topic isolation | ❌ | ❌ | ❌ | ✅ |
| Per-topic compaction | ❌ | ❌ | ❌ | ✅ |
| Context swap on topic change | ❌ | ❌ | ❌ | ✅ |
| Topic awareness layer | ❌ | ❌ | ❌ | ✅ |
| Cross-topic references | N/A | N/A | Partial | ✅ |
| Works with existing LLM APIs | ✅ | ✅ | ✅ | ✅ |
| Requires custom runtime | ✅ (Letta) | ✅ (LangChain) | ✅ (Mem0 API) | ❌ (file-based) |
| Personal assistant use case | ❌ | ❌ | Partial | ✅ |

**Key differentiator:** TSVC is the only approach that treats topics as first-class context units with independent lifecycles, giving each topic nearly the full context window instead of forcing all topics to share a shrinking pool.

---

## Prior Art & References

1. **MemGPT** (Packer et al., 2023) — OS-inspired virtual memory for LLMs. Pioneered the memory hierarchy metaphor. TSVC extends this from memory paging to process scheduling.
2. **ACON** (Zhang et al., 2025) — Context compression optimization. Observation masking achieves 26-54% token savings. TSVC uses this within each topic's context.
3. **LangChain Deep Agents** (2026) — Offloading + summarization for long-running agents. Single-task focused. TSVC adds the multi-topic dimension.
4. **Mem0** (2025) — Scalable long-term memory extraction. Complements TSVC as the shared fact layer between topics.
5. **Context Rot** (Chroma Research, 2025) — Measured degradation of LLM performance with growing context. TSVC directly addresses this by keeping each topic's context lean.
6. **Observation Masking** (OpenReview, 2025) — Simple masking matches LLM summarization for agent context management. TSVC applies this at the conversation replay level.
7. **Anthropic Voice for Claude Code** (2026) — Voice commands for coding agents. Validates domain-specific vocabulary as a first-class concern for voice-to-agent pipelines. TSVC's per-topic transcription vocabulary (`tsvc-vocab.sh`) independently addresses the same problem — context-aware speech recognition that adapts to the active domain.
8. **Claude Memory Import** (Anthropic, 2026) — Cross-platform memory portability for switching between AI assistants. Solves horizontal context migration (user switching tools). TSVC solves vertical context isolation (one agent, many topics). The intersection — portable topic export/import — is a natural future extension.

---

## Why This Matters

For anyone running a personal AI agent (OpenClaw, Claude Projects, custom agents), the multi-topic problem is universal:

> "I talk to my AI about 5-10 different things throughout the day. By evening, it's forgotten what we discussed in the morning because compaction summarized everything into mush."

TSVC solves this by giving each topic its own context lifecycle. Your trading discussion doesn't pollute your family planning context. Your DevOps debugging doesn't eat into your research thread. Each topic gets nearly the full context window when it's active, and is perfectly preserved on disk when it's not.

**The OS metaphor, completed:**
- MemGPT gave us virtual memory (paging). 
- TSVC gives us virtual processes (topic isolation + scheduling).
- Together, they're the full operating system for AI agents.

---

## Next Steps

1. ✅ Research complete — we're ahead of the field
2. 🔨 Build `tsvc-manager.js` core engine
3. 🔨 Update AGENTS.md with TSVC boot/switch instructions
4. 🔨 Create topic_files/ structure with index
5. 🧪 Test with real conversations (Alex + Skippster daily use)
6. 📝 Write publishable blog post / GitHub discussion
7. 📦 Package as OpenClaw skill for ClawHub

## Future Work

- **Topic Export/Import Schema:** Define a portable format (self-contained JSON/markdown bundle) for migrating topics between OpenClaw instances or sharing topic context with other agents. Inspired by Anthropic's cross-platform memory import — but for topic-scoped context rather than flat conversation history.
- **Plugin-based Topic Spawn Detection:** Assess whether Tier 2/3 plugin detection should auto-suggest topic spawns when conversation drifts. Currently explicit-only. (Backlog task: `task_87cd98c8c9f57fac`)
- **Automated Validation Loops:** Per-topic test suites that validate script outputs and task completions — inspired by OpenAI Codex Security's reasoning + validation pattern.
