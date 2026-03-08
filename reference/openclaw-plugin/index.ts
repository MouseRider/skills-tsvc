import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const WORKSPACE = process.env.WORKSPACE_DIR || "/home/node/.openclaw/workspace";
const TSVC_DIR = join(WORKSPACE, "tsvc");
const INDEX_FILE = join(TSVC_DIR, "topic_files/index.json");
const PENDING_FILE = join(TSVC_DIR, "pending-reset.json");
const TRUSTED_SENDER = "YOUR_SENDER_ID";
const LOG_FILE = join(TSVC_DIR, "logs/plugin.log");

try { mkdirSync(join(TSVC_DIR, "logs"), { recursive: true }); } catch {}

function plog(level: string, msg: string, data?: Record<string, any>) {
  const ts = new Date().toISOString();
  const extra = data ? " " + JSON.stringify(data) : "";
  const line = `${ts} [${level}] ${msg}${extra}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
  console.log(`[tsvc-switcher] ${msg}${extra}`);
}

function extractCleanUserText(prompt: string): string {
  if (!prompt) return "";
  const transcriptMatch = prompt.match(/Transcript:\s*(.+?)$/m);
  if (transcriptMatch) return transcriptMatch[1].trim();
  const lastCodeBlockEnd = prompt.lastIndexOf("```");
  if (lastCodeBlockEnd !== -1) {
    const afterBlock = prompt.slice(lastCodeBlockEnd + 3).trim();
    if (afterBlock.length > 0) {
      return afterBlock
        .replace(/^\[Audio\]\s*User text:\s*/g, "")
        .replace(/^\[Telegram[^\]]*\]\s*/g, "")
        .replace(/^<media:audio>\s*/g, "")
        .trim();
    }
  }
  return prompt.trim();
}

function extractLastUserMessage(messages: any[]): string | undefined {
  if (!messages || !Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join(" ");
        return textParts || undefined;
      }
    }
  }
  return undefined;
}

/**
 * Load topic context file.
 */
function loadTopicContext(topicId: string): string | null {
  const contextFile = join(TSVC_DIR, "contexts", `${topicId}.md`);
  if (!existsSync(contextFile)) return null;
  try {
    return readFileSync(contextFile, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get recent exchanges from conversation.jsonl (lightweight — just last N entries).
 */
function getRecentExchanges(topicId: string, count: number = 10): string {
  try {
    const convFile = join(TSVC_DIR, "topic_files", topicId, "conversation.jsonl");
    if (!existsSync(convFile)) return "";
    const lines = readFileSync(convFile, "utf-8").trim().split("\n").slice(-count * 2);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return entries
      .map((e: any) => `- **${e.role === "user" ? "User" : "Agent"}:** ${(e.text || "").slice(0, 200)}`)
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Build resume hint from conversation.jsonl.
 */
function buildResumeHint(topicId: string): { type: string; lastUserMessage: string; lastAssistantMessage: string } | null {
  const convFile = join(TSVC_DIR, "topic_files", topicId, "conversation.jsonl");
  if (!existsSync(convFile)) return null;
  try {
    const lines = readFileSync(convFile, "utf-8").trim().split("\n").slice(-10);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const lastUser = [...entries].reverse().find(e => e.role === "user");
    const lastAssistant = [...entries].reverse().find(e => e.role === "assistant");
    return {
      type: lastUser?.text?.includes("?") ? "unanswered_question" : "continuation",
      lastUserMessage: lastUser?.text || "",
      lastAssistantMessage: lastAssistant?.text || "",
    };
  } catch {
    return null;
  }
}

/**
 * Queue silent self-reset AFTER current turn completes.
 * Runs in background: logs exchanges, writes pending-reset, deletes session.
 * Does NOT send any message — the current LLM turn already replied.
 */
function queueSilentReset(topicId: string, userMsg: string) {
  try {
    // Log exchanges before switch
    try {
      execSync(`python3 "${WORKSPACE}/scripts/tsvc-exchange-logger.py"`, {
        cwd: WORKSPACE, timeout: 5000, encoding: "utf-8",
      });
    } catch {}

    // Write pending-reset.json for inbound handler
    try {
      execSync(`bash "${WORKSPACE}/tsvc/scripts/tsvc-switch.sh" "${topicId}" ${JSON.stringify(userMsg)}`, {
        cwd: WORKSPACE, timeout: 5000, encoding: "utf-8",
      });
    } catch (err: any) {
      plog("ERROR", "tsvc-switch.sh failed", { error: err.message });
    }

    // Switch topic pointer
    try {
      execSync(`node tsvc/scripts/tsvc-manager.js switch "${topicId}"`, {
        cwd: WORKSPACE, timeout: 5000, encoding: "utf-8",
      });
    } catch (err: any) {
      plog("ERROR", "pointer switch failed", { error: err.message });
    }

    // Trigger self-reset in background (fires after LLM turn completes)
    // Using 2s delay to ensure the current response is fully delivered
    execSync(`nohup bash "${WORKSPACE}/scripts/self-reset.sh" 2 > /tmp/self-reset.log 2>&1 &`, {
      cwd: WORKSPACE, timeout: 3000, encoding: "utf-8",
      shell: "/bin/bash",
    });

    plog("INFO", "silent reset queued (2s delay)");
  } catch (err: any) {
    plog("ERROR", "queueSilentReset failed", { error: err.message });
  }
}

export default function register(api: any) {
  api.on(
    "before_prompt_build",
    async (event: any, ctx: any) => {
      const hookStart = Date.now();
      try {
        const rawPrompt = typeof event?.prompt === "string" ? event.prompt : "";
        const messagesCount = event?.messages?.length ?? 0;

        plog("INFO", "hook fired", {
          promptLen: rawPrompt.length,
          messagesCount,
          promptSnippet: rawPrompt.slice(0, 120),
        });

        // Skip cron/system messages
        if (rawPrompt.startsWith("[cron:") || rawPrompt.startsWith("[system")) {
          plog("DEBUG", "skip: cron/system message");
          return;
        }

        // Skip non-user messages: only run detection on User's messages
        // Audio messages have "id:YOUR_SENDER_ID", text messages have the conversation metadata block
        // Cron/system already filtered above. Heartbeat/reset prompts don't have conversation metadata.
        const hasAudioSenderId = rawPrompt.includes("id:YOUR_SENDER_ID");
        const hasConversationMeta = rawPrompt.includes('"chat_id"') || rawPrompt.includes("Conversation info (untrusted metadata)");
        const isUserMessage = hasAudioSenderId || hasConversationMeta;
        const isPendingSwitch = existsSync(PENDING_FILE);

        // ═══════════════════════════════════════════════════════════
        // PHASE 0: SUBAGENT ROUTING — Route sub-agent/Majordomo reports to correct topic
        // ═══════════════════════════════════════════════════════════
        if (!isUserMessage && !isPendingSwitch) {
          // Check if this is a sub-agent or Majordomo message (not a cron/system — those filtered above)
          const isSubagentMsg = rawPrompt.includes("Agent-to-agent") ||
            rawPrompt.includes("Majordomo") ||
            rawPrompt.includes("CRON UPDATE") ||
            rawPrompt.includes("CRON ALERT") ||
            rawPrompt.includes("Daily Report") ||
            rawPrompt.includes("[Subagent Context]");

          if (isSubagentMsg) {
            plog("INFO", "subagent/majordomo message detected, attempting topic routing");

            // Strategy C: Try task ID first, fall back to keyword matching
            let routedTopicId: string | null = null;
            let routeSource = "unknown";

            // C1: Extract [task:TASK_ID] from message
            const taskMatch = rawPrompt.match(/\[task:(task_[a-f0-9]+)\]/);
            if (taskMatch) {
              const taskId = taskMatch[1];
              plog("INFO", "found task ID in message", { taskId });
              try {
                const routeResult = execSync(
                  `bash "${WORKSPACE}/scripts/submind-result-router.sh" --task "${taskId}" --source "submind" --message ${JSON.stringify(rawPrompt.slice(0, 500))}`,
                  { cwd: WORKSPACE, timeout: 10000, encoding: "utf-8" }
                ).trim();
                plog("INFO", "task-based routing result", { taskId, result: routeResult });
                if (routeResult === "FILED") {
                  // Filed to paged topic — let LLM handle minimally
                  return { prependContext: `## 📥 Sub-agent report filed\nA sub-agent report for task ${taskId} was filed to its paged topic's where-are-we.md. No action needed now.` };
                }
                // ACTIVE or NO_TOPIC_TAG — fall through to normal processing
                routedTopicId = "handled";
              } catch (err: any) {
                plog("WARN", "task-based routing failed, trying keyword fallback", { error: err.message });
              }
            }

            // C2: Keyword matching against topic titles (fallback)
            if (!routedTopicId && !taskMatch) {
              try {
                const indexData = JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
                const activeTopic = indexData.activeTopic;
                const msgLower = rawPrompt.toLowerCase();

                for (const [topicId, topicInfo] of Object.entries(indexData.topics || {}) as [string, any][]) {
                  if (topicId === activeTopic) continue; // Skip active topic — it processes normally
                  const title = (topicInfo.title || "").toLowerCase();
                  // Check if topic title keywords appear in the message
                  const titleWords = title.split(/[\s—\-\/&]+/).filter((w: string) => w.length > 3);
                  const matchCount = titleWords.filter((w: string) => msgLower.includes(w)).length;
                  const matchRatio = titleWords.length > 0 ? matchCount / titleWords.length : 0;

                  if (matchRatio >= 0.5 && matchCount >= 2) {
                    plog("INFO", "keyword match for paged topic", { topicId, title: topicInfo.title, matchRatio });
                    try {
                      const routeResult = execSync(
                        `bash "${WORKSPACE}/scripts/submind-result-router.sh" --topic "${topicId}" --source "submind" --message ${JSON.stringify(rawPrompt.slice(0, 500))}`,
                        { cwd: WORKSPACE, timeout: 10000, encoding: "utf-8" }
                      ).trim();
                      plog("INFO", "keyword-based routing result", { topicId, result: routeResult });
                      if (routeResult === "FILED") {
                        return { prependContext: `## 📥 Sub-agent report filed\nA sub-agent report was keyword-matched and filed to topic "${topicInfo.title}" (${topicId}). No action needed now.` };
                      }
                    } catch (err: any) {
                      plog("WARN", "keyword-based routing failed", { error: err.message });
                    }
                    break;
                  }
                }
              } catch (err: any) {
                plog("WARN", "keyword matching failed", { error: err.message });
              }
            }

            // If we couldn't route it, pass through normally
            plog("DEBUG", "subagent message not routed to paged topic, processing normally");
          } else {
            plog("DEBUG", "skip: not a user message");
            return;
          }
        }

        // ═══════════════════════════════════════════════════════════
        // PHASE A: INBOUND — Handle pending topic switch (fresh session after reset)
        // ═══════════════════════════════════════════════════════════
        if (existsSync(PENDING_FILE)) {
          let pending: any;
          try {
            pending = JSON.parse(readFileSync(PENDING_FILE, "utf-8"));
          } catch (e: any) {
            plog("ERROR", "failed to parse pending-reset.json, removing", { error: e.message });
            try { unlinkSync(PENDING_FILE); } catch {}
            return;
          }

          if (pending.reason !== "topic_switch") {
            plog("INFO", "pending-reset not a topic switch, removing");
            try { unlinkSync(PENDING_FILE); } catch {}
            return;
          }

          const targetId = pending.toTopic?.id;
          const targetTitle = pending.toTopic?.title || "unknown";
          const fromTitle = pending.fromTopic?.title || "unknown";

          plog("INFO", `INBOUND SWITCH: completing ${fromTitle} → ${targetTitle}`, { targetId });

          // Ensure pointer is on the target topic
          try {
            execSync(`node tsvc/scripts/tsvc-manager.js switch "${targetId}"`, {
              cwd: WORKSPACE, timeout: 5000, encoding: "utf-8",
            });
          } catch (err: any) {
            plog("ERROR", "pointer switch failed during inbound", { error: err.message });
          }

          // Load full topic context (this is the NEW session — we want the full thing here)
          const context = loadTopicContext(targetId);
          const resumeHint = buildResumeHint(targetId);

          // Telemetry
          try {
            const t1 = new Date().toISOString();
            const telemetryLog = join(TSVC_DIR, "logs", "switch-telemetry.jsonl");
            appendFileSync(telemetryLog, JSON.stringify({
              ...pending.telemetry,
              t1_new_session_loaded: t1,
              fromTopic: pending.fromTopic,
              toTopic: pending.toTopic,
            }) + "\n");
          } catch {}

          // Clean up
          try { unlinkSync(PENDING_FILE); } catch {}
          try { unlinkSync(join(TSVC_DIR, "next-topic.txt")); } catch {}

          // Build context injection for the NEW session
          const contextParts: string[] = [
            `## 🔄 Topic Switch Complete: ${targetTitle}`,
            `Switched from "${fromTitle}" to "${targetTitle}".`,
            "",
          ];

          if (context) {
            contextParts.push("## Topic Context (auto-loaded)", context, "");
          }

          if (resumeHint) {
            contextParts.push(
              "## Resume Hint",
              `Type: ${resumeHint.type}`,
              `Last user message: ${resumeHint.lastUserMessage.slice(0, 300)}`,
              `Last assistant message: ${resumeHint.lastAssistantMessage.slice(0, 300)}`,
              "",
            );
          }

          const elapsed = Date.now() - hookStart;
          plog("INFO", `inbound switch complete (${elapsed}ms)`, { targetId, contextLoaded: !!context });

          return { prependContext: contextParts.join("\n") };
        }

        // ═══════════════════════════════════════════════════════════
        // PHASE B: OUTBOUND — Detect and initiate topic switch
        // ═══════════════════════════════════════════════════════════

        if (existsSync(join(TSVC_DIR, ".switch-lock"))) {
          plog("INFO", "skip: .switch-lock exists");
          return;
        }
        if (!existsSync(INDEX_FILE)) {
          plog("WARN", "skip: no index file");
          return;
        }

        // Extract user message
        const userMsg = extractCleanUserText(rawPrompt) || extractLastUserMessage(event?.messages);

        if (!userMsg || userMsg.trim().length === 0) {
          plog("DEBUG", "skip: empty user message");
          return;
        }
        if (userMsg.startsWith("/")) {
          plog("DEBUG", "skip: command message");
          return;
        }

        plog("INFO", "extracted user message", {
          text: typeof userMsg === "string" ? userMsg.slice(0, 150) : "NONE",
        });

        // Load topic index
        let index: any;
        try {
          index = JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
        } catch (e: any) {
          plog("ERROR", "failed to parse index", { error: e.message });
          return;
        }

        const activeTopic = index.activeTopic;
        if (!activeTopic) return;

        const activeTitle = index.topics?.[activeTopic]?.title || "unknown";

        // Run topic detection (deterministic, ~33ms)
        let result: any;
        try {
          const cmd = `node tsvc/scripts/detect-topic-switch.js ${JSON.stringify(userMsg)} ${JSON.stringify(activeTopic)}`;
          const out = execSync(cmd, { cwd: WORKSPACE, timeout: 5000, encoding: "utf-8" });
          result = JSON.parse(out.trim());
          plog("INFO", "detection result", result);
        } catch (err: any) {
          plog("ERROR", "detection failed", { error: err.message });
          return;
        }

        // ── Tier 1: No match — fast path ──
        if (!result.switchDetected && !result.suggestSwitch) {
          plog("DEBUG", "tier 1: no match", { reason: result.reason });
          return;
        }

        // ── Tier 2: Ambiguous — hint only, no auto-switch ──
        if (result.suggestSwitch && !result.switchDetected) {
          plog("INFO", `tier 2: suggest switch to "${result.title}"`);
          return {
            prependContext: [
              `## 💡 Possible Topic Switch`,
              `The user's message may relate to topic "${result.title}" (current: "${activeTitle}").`,
              `Consider asking: "Did you want to switch to ${result.title}?"`,
            ].join("\n"),
          };
        }

        // ── Tier 3: Confirmed switch — current session answers, then silent reset ──
        const targetId = result.topicId;
        const targetTitle = result.title || "new topic";

        plog("INFO", `tier 3: confirmed switch to "${targetTitle}"`, {
          targetId, confidence: result.confidence,
        });

        // Get recent exchanges from target topic (~10 exchanges, ~1k tokens)
        const recentExchanges = getRecentExchanges(targetId, 10);
        const resumeHint = buildResumeHint(targetId);

        // Build lightweight context injection for the CURRENT session
        const contextParts: string[] = [
          `## 🔄 Topic Switch: ${activeTitle} → ${targetTitle}`,
          "",
          "You are about to switch topics. Use the recent exchanges below to generate a meaningful, continuous response to the user's message.",
          "After you reply, a silent topic switch will happen automatically. Do NOT mention the switch mechanics — just answer naturally as if you're resuming the target topic.",
          "",
        ];

        if (recentExchanges) {
          contextParts.push(
            `### Recent exchanges on "${targetTitle}"`,
            recentExchanges,
            "",
          );
        }

        if (resumeHint) {
          contextParts.push(
            "### Where we left off",
            `Last user message: ${resumeHint.lastUserMessage.slice(0, 300)}`,
            `Last assistant message: ${resumeHint.lastAssistantMessage.slice(0, 300)}`,
            "",
          );
        }

        // Queue the silent reset (runs after this turn completes)
        queueSilentReset(targetId, userMsg);

        const elapsed = Date.now() - hookStart;
        plog("INFO", `tier 3 switch prepared (${elapsed}ms)`, { from: activeTitle, to: targetTitle });

        return { prependContext: contextParts.join("\n") };

      } catch (err: any) {
        const elapsed = Date.now() - hookStart;
        plog("ERROR", `unhandled error (${elapsed}ms)`, {
          error: err.message,
          stack: err.stack?.slice(0, 300),
        });
      }
    },
    { priority: 100 }
  );

  plog("INFO", "plugin registered");
}
