# Design Decisions

Why TSVC works the way it does.

## Files Over Databases

**Decision:** All state is stored in markdown and JSON files. No vector database, no Redis, no PostgreSQL.

**Why:**
- Zero operational overhead — no daemons, no migrations, no connection pooling
- Human-readable and editable — you can `cat` a topic context and understand it
- Git-friendly — version control, diff, blame all work naturally
- Portable — copy a directory, and you've moved your agent's memory
- Debuggable — when something goes wrong, you open a file and read it

**Tradeoff:** No semantic search across topics. The awareness layer (keyword-based topic detection) handles routing. For deep search, we use SQLite FTS5 or grep on raw files.

## One Topic At A Time

**Decision:** Only one topic is fully loaded into the context window. All others are paged to disk.

**Why:**
- Context windows are finite. Loading 3 topics at 3K tokens each = 9K tokens of context that's mostly irrelevant to the current conversation.
- Cross-topic contamination is the primary failure mode of persistent agents. A trading decision shouldn't be influenced by estate planning context floating in the window.
- The awareness layer (~200 tokens) provides just enough cross-topic visibility for detection.

**Tradeoff:** Switching topics requires a session reset. This adds 3-8 seconds of latency. We consider this acceptable — the alternative (degraded reasoning from context pollution) is worse.

## Invisible Switching

**Decision:** Topic switches trigger a full session reset. the user sees no interruption — no "switching now" message, no "loading new topic" indicator.

**Why:**
- Visible switching breaks conversational flow and creates cognitive overhead for the user
- The agent should feel like one entity with good memory, not a switchboard
- Session resets give the cleanest possible context — no residual tokens from the previous topic

**Tradeoff:** Implementation complexity. The pre-reset/post-reset dance with `pending-reset.json` is non-trivial. But it only needs to be implemented once.

## Decisions As First-Class Citizens

**Decision:** Every decision within a topic is explicitly logged with timestamp, reasoning, and chain relationships.

**Why:**
- Decisions are the highest-value information an agent produces. They represent commitments.
- Without explicit tracking, decisions get lost in conversation history and compaction summaries
- Chain relationships show how decisions evolved — "we started with X, then switched to Y because Z"
- Inspired by [Graphiti's](https://github.com/getzep/graphiti) bi-temporal knowledge model

**Tradeoff:** Requires discipline in logging. Not every statement is a decision — only commitments that affect future actions.

## Lean Context Files

**Decision:** Context files target 2-3K tokens. Only recent exchanges (last 5-10), active decisions, and open items.

**Why:**
- Context files load into the window on every topic resume. Bloated files defeat the purpose of TSVC.
- Full conversation history lives in JSONL files — the context file is a curated summary
- Open items prevent the most common failure: dropping threads between sessions

**Tradeoff:** Information loss. Old exchanges are summarized or dropped. The JSONL files preserve everything, but the agent doesn't see them by default.

## JSONL For Exchange History

**Decision:** Full conversation history stored as append-only JSONL (one JSON object per line).

**Why:**
- Append-only is crash-safe — partial writes don't corrupt existing data
- Line-oriented format works with standard Unix tools (`grep`, `wc -l`, `tail`, `jq`)
- No parsing overhead for the agent — only loaded when explicitly needed (deep search)
- Natural chronological ordering

## Session Reset Over Context Manipulation

**Decision:** Topic switches use a full session reset rather than trying to "unload" context from the current window.

**Why:**
- LLM context windows are append-only by nature. You can't surgically remove tokens from a live context.
- Summarization ("compress the last 50 messages") loses nuance and introduces hallucination risk
- A fresh session with the right context loaded is always cleaner than a manipulated one
- This is the insight from MemGPT/Letta — treat context like memory pages, not like a scratchpad

**Tradeoff:** Full reset means re-loading system prompts, personality files, and boot sequences. Adds latency but guarantees cleanliness.

## No Semantic Search (By Design)

**Decision:** Topic detection uses keyword matching and LLM classification, not vector embeddings.

**Why:**
- TSVC runs on CPU-only hardware. Embedding models add GPU requirements or API costs.
- Topic detection is a classification problem (which of N known topics?), not a retrieval problem
- The awareness layer gives the LLM enough context to classify accurately
- For deep historical search, SQLite FTS5 provides keyword search without embedding overhead

**Tradeoff:** May miss subtle topic relationships that embedding similarity would catch. In practice, explicit topic boundaries work better than fuzzy semantic ones.

## Telemetry Built In

**Decision:** Every topic switch logs timing data (t0/t1/t2), context sizes, and detection method.

**Why:**
- You can't improve what you don't measure
- Switch latency directly impacts user experience
- Context size trends reveal whether topics are staying lean or bloating
- Detection method tracking shows whether implicit detection is working or if users need to be explicit

## The Awareness Layer

**Decision:** A lightweight summary of all topics (~200 tokens) is always available, even when only one topic is active.

**Why:**
- Topic detection needs to know what topics exist without loading them
- Users don't always say "switch to trading" — they might just ask "what's our P&L?"
- The awareness layer is cheap enough to include in every context window

**Format:** Simple text listing topic names, status, last access time, and key stats. No markdown tables, no structured data — just enough for the LLM to pattern-match.
