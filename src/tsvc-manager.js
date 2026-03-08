#!/usr/bin/env node
/**
 * TSVC Manager — Topic-Scoped Virtual Context
 * 
 * Per-topic context isolation for long-running AI agents.
 * Each topic gets its own conversation history, state, and lifecycle.
 * 
 * Commands:
 *   create <title>           Create a new topic
 *   switch <topic_id>        Save current topic, load target
 *   save                     Save current active topic to disk
 *   load <topic_id>          Load a topic (without saving current)
 *   close <topic_id> [summary]  Close topic with optional summary
 *   list                     List all topics with status
 *   status                   Show active topic and stats
 *   detect <message>         Classify message against topic index
 *   compact <topic_id>       Compact a single topic's conversation
 *   append <topic_id> <role> <text>  Append exchange to topic
 *   decision <topic_id> <text> [--supersedes <dec_id>] [--depends-on <dec_id|reason>]  Log a decision
 *   supersede <topic_id> <old_dec_id> <new_text>  Supersede a decision with a new one
 *   refresh [topic_id]                            Refresh hot context file for a topic
 *   chain <topic_id> <decision_id>                Show dependency chain for a decision
 *   decisions <topic_id> [--all]                   List decisions with dependency info
 *   metrics                  Show metrics/stats
 *   baseline                 Capture baseline metrics (pre-TSVC)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE = process.env.WORKSPACE || path.join(process.env.HOME, '.openclaw/workspace');
const TSVC_DIR = path.join(WORKSPACE, 'tsvc');
const TOPICS_DIR = path.join(TSVC_DIR, 'topic_files');
const INDEX_FILE = path.join(TOPICS_DIR, 'index.json');
const METRICS_FILE = path.join(TSVC_DIR, 'metrics.json');
const STATE_FILE = path.join(TSVC_DIR, 'active-state.json');

// Ensure dirs exist
[TOPICS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// --- Index Management ---

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return { topics: {}, activeTopic: null };
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
}

function saveIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function loadMetrics() {
  if (!fs.existsSync(METRICS_FILE)) return {
    baseline: null,
    sessions: [],
    topicSwitches: [],
    compactions: [],
    recallTests: [],
    perceptionRatings: []
  };
  return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
}

function saveMetrics(metrics) {
  fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
}

function loadActiveState() {
  if (!fs.existsSync(STATE_FILE)) return { activeTopicId: null, sessionStart: null, switchCount: 0 };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveActiveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Topic File Management ---

function topicDir(id) {
  const d = path.join(TOPICS_DIR, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function loadTopicState(id) {
  const f = path.join(topicDir(id), 'state.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function saveTopicState(id, state) {
  fs.writeFileSync(path.join(topicDir(id), 'state.json'), JSON.stringify(state, null, 2));
}

function loadConversation(id) {
  const f = path.join(topicDir(id), 'conversation.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function saveConversation(id, exchanges) {
  const f = path.join(topicDir(id), 'conversation.jsonl');
  fs.writeFileSync(f, exchanges.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function appendExchange(id, exchange) {
  const f = path.join(topicDir(id), 'conversation.jsonl');
  fs.appendFileSync(f, JSON.stringify(exchange) + '\n');
}

// Generate readable markdown of topic state for context injection
function renderTopicContext(id, maxExchanges = 15) {
  const state = loadTopicState(id);
  if (!state) return null;
  
  const convo = loadConversation(id);
  const recent = convo.slice(-maxExchanges);
  
  let md = `# Active Topic: ${state.title}\n`;
  md += `**ID:** ${id} | **Status:** ${state.status} | **Last Active:** ${state.lastActive}\n\n`;
  
  if (state.decisions && state.decisions.length > 0) {
    const active = getActiveDecisions(state);
    const superseded = state.decisions.filter(d => d.superseded_by);

    // Separate root decisions (no dependency) from chained ones
    const roots = active.filter(d => !d.depends_on || !d.depends_on.startsWith('dec_'));
    const chained = active.filter(d => d.depends_on && d.depends_on.startsWith('dec_'));

    md += `## Active Decisions (${active.length})\n`;
    roots.forEach(d => {
      let line = `- ${d.date}: ${d.text}`;
      if (d.depends_on) line += ` [reason: ${d.depends_on}]`;
      if (d.id) line += ` (${d.id})`;
      // Show dependents inline
      const deps = getDependents(state, d.id);
      if (deps.length > 0) {
        line += `\n  → leads to: ${deps.filter(dd => !dd.superseded_by).map(dd => dd.text.substring(0, 80)).join('; ')}`;
      }
      md += line + '\n';
    });
    if (chained.length > 0) {
      md += `\n### Decision Chains\n`;
      chained.forEach(d => {
        const chain = getDecisionChain(state, d.id);
        const chainStr = chain.map(c => c.text ? c.text.substring(0, 60) : '?').join(' → ');
        md += `- ${chainStr} (${d.id})\n`;
      });
    }
    if (superseded.length > 0) {
      md += `\n_${superseded.length} superseded decision(s) in history_\n`;
    }
    md += '\n';
  }
  
  if (state.openItems && state.openItems.length > 0) {
    md += `## Open Items\n`;
    state.openItems.forEach(item => { md += `- ${item}\n`; });
    md += '\n';
  }
  
  if (state.workingFiles && state.workingFiles.length > 0) {
    md += `## Working Files\n`;
    state.workingFiles.forEach(f => { md += `- ${f}\n`; });
    md += '\n';
  }
  
  if (recent.length > 0) {
    md += `## Recent Conversation (last ${recent.length} exchanges)\n`;
    recent.forEach(ex => {
      const role = ex.role === 'user' ? 'User' : 'Agent';
      const time = ex.timestamp ? ` (${ex.timestamp})` : '';
      // Observation masking: summarize tool outputs
      let text = ex.text;
      if (ex.type === 'tool_output' && text.length > 200) {
        text = text.substring(0, 150) + '... [truncated tool output]';
      }
      md += `**${role}**${time}: ${text}\n`;
    });
    md += '\n';
  }
  
  if (state.relatedTopics && state.relatedTopics.length > 0) {
    md += `## Related Topics\n`;
    state.relatedTopics.forEach(rt => { md += `- ${rt}\n`; });
  }
  
  return md;
}

// Generate lightweight awareness layer (all topics, minimal tokens)
function renderAwarenessLayer() {
  const index = loadIndex();
  const topics = Object.entries(index.topics);
  if (topics.length === 0) return '## Topics: None active\n';
  
  let md = `## Topic Awareness (${topics.length} topics)\n`;
  md += `| ID | Title | Status | Last Active | Summary |\n`;
  md += `|----|-------|--------|-------------|--------|\n`;
  
  topics.forEach(([id, t]) => {
    const shortId = id.substring(0, 8);
    const lastActive = t.lastActive ? new Date(t.lastActive).toISOString().split('T')[0] : 'never';
    md += `| ${shortId} | ${t.title} | ${t.status} | ${lastActive} | ${t.summary || '-'} |\n`;
  });
  
  md += `\n**Active:** ${index.activeTopic || 'none'}\n`;
  return md;
}

// --- Commands ---

function cmdCreate(title) {
  const id = 'topic_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  
  const state = {
    id,
    title,
    status: 'active',
    createdAt: now,
    lastActive: now,
    decisions: [],
    openItems: [],
    workingFiles: [],
    relatedTopics: [],
    compactionCount: 0,
    exchangeCount: 0,
    summary: ''
  };
  
  saveTopicState(id, state);
  
  // Update index
  const index = loadIndex();
  
  // If there's a current active topic, page it out
  if (index.activeTopic) {
    index.topics[index.activeTopic].status = 'paged';
    const prevState = loadTopicState(index.activeTopic);
    if (prevState) {
      prevState.status = 'paged';
      saveTopicState(index.activeTopic, prevState);
    }
  }
  
  index.topics[id] = {
    title,
    status: 'active',
    lastActive: now,
    summary: '',
    exchangeCount: 0
  };
  index.activeTopic = id;
  saveIndex(index);
  
  // Update active state
  const activeState = loadActiveState();
  activeState.activeTopicId = id;
  activeState.switchCount = (activeState.switchCount || 0) + 1;
  saveActiveState(activeState);
  
  // Log metric
  const metrics = loadMetrics();
  metrics.topicSwitches.push({ from: null, to: id, timestamp: now, type: 'create' });
  saveMetrics(metrics);
  
  console.log(JSON.stringify({ action: 'created', id, title, status: 'active' }));
}

function cmdSwitch(targetId) {
  const index = loadIndex();
  const now = new Date().toISOString();
  
  if (!index.topics[targetId]) {
    console.error(JSON.stringify({ error: `Topic ${targetId} not found` }));
    process.exit(1);
  }
  
  const previousId = index.activeTopic;
  
  // Save current active topic
  if (previousId && previousId !== targetId) {
    index.topics[previousId].status = 'paged';
    index.topics[previousId].lastActive = now;
    const prevState = loadTopicState(previousId);
    if (prevState) {
      prevState.status = 'paged';
      prevState.lastActive = now;
      saveTopicState(previousId, prevState);
    }
  }
  
  // Load target topic
  index.topics[targetId].status = 'active';
  index.topics[targetId].lastActive = now;
  index.activeTopic = targetId;
  saveIndex(index);
  
  const targetState = loadTopicState(targetId);
  if (targetState) {
    targetState.status = 'active';
    targetState.lastActive = now;
    saveTopicState(targetId, targetState);
  }
  
  // Update active state
  const activeState = loadActiveState();
  activeState.activeTopicId = targetId;
  activeState.switchCount = (activeState.switchCount || 0) + 1;
  saveActiveState(activeState);
  
  // Log metric
  const metrics = loadMetrics();
  metrics.topicSwitches.push({ from: previousId, to: targetId, timestamp: now, type: 'switch' });
  saveMetrics(metrics);
  
  // Auto-save: run exchange logger to capture conversations before switching
  try {
    const { execSync } = require('child_process');
    execSync(`python3 ${path.join(WORKSPACE, 'scripts/tsvc-exchange-logger.py')}`, {
      cwd: WORKSPACE,
      timeout: 10000,
      stdio: 'pipe'
    });
  } catch (e) {
    // Non-fatal — log but don't block switch
    console.error(JSON.stringify({ warning: 'exchange-logger failed', error: e.message }));
  }

  // Auto-save: generate context snapshot for the topic we're leaving
  if (previousId && previousId !== targetId) {
    try {
      const prevState = loadTopicState(previousId);
      const convoFile = path.join(topicDir(previousId), 'conversation.jsonl');
      let recentExchanges = [];
      if (fs.existsSync(convoFile)) {
        const lines = fs.readFileSync(convoFile, 'utf8').trim().split('\n').filter(Boolean);
        recentExchanges = lines.slice(-10).map(l => JSON.parse(l));
      }

      let ctx = `# Topic Context: ${index.topics[previousId].title}\n`;
      ctx += `**ID:** ${previousId} | **Last Active:** ${now}\n\n`;

      if (prevState && prevState.decisions && prevState.decisions.length > 0) {
        const active = getActiveDecisions(prevState);
        ctx += `## Active Decisions (${active.length})\n`;
        active.forEach(d => {
          let line = `- ${d.date || d.timestamp}: ${d.text}`;
          if (d.depends_on) line += ` [depends on: ${d.depends_on}]`;
          if (d.id) line += ` (${d.id})`;
          ctx += line + '\n';
        });
        ctx += '\n';
      }

      if (recentExchanges.length > 0) {
        ctx += `## Recent Exchanges (last ${recentExchanges.length})\n`;
        recentExchanges.forEach(ex => {
          const role = ex.role === 'user' ? 'User' : 'Agent';
          const text = (ex.text || '').substring(0, 200);
          ctx += `- **${role}:** ${text}\n`;
        });
      }

      const ctxDir = path.join(TSVC_DIR, 'contexts');
      fs.mkdirSync(ctxDir, { recursive: true });
      fs.writeFileSync(path.join(ctxDir, `${previousId}.md`), ctx);
    } catch (e) {
      console.error(JSON.stringify({ warning: 'context-snapshot failed', error: e.message }));
    }
  }

  // Mid-session: just flip the pointer. Context is already in the LLM window.
  // Full context load only at boot/post-compaction via `context <id>`.
  console.log(JSON.stringify({
    action: 'switched',
    to: targetId,
    title: index.topics[targetId].title
  }));
}

function cmdSave() {
  const index = loadIndex();
  if (!index.activeTopic) {
    console.log(JSON.stringify({ action: 'save', status: 'no_active_topic' }));
    return;
  }
  
  const id = index.activeTopic;
  const now = new Date().toISOString();
  index.topics[id].lastActive = now;
  saveIndex(index);
  
  const state = loadTopicState(id);
  if (state) {
    state.lastActive = now;
    saveTopicState(id, state);
  }
  
  console.log(JSON.stringify({ action: 'saved', id, title: index.topics[id].title }));
}

function cmdClose(topicId, summary) {
  const index = loadIndex();
  if (!index.topics[topicId]) {
    console.error(JSON.stringify({ error: `Topic ${topicId} not found` }));
    process.exit(1);
  }
  
  const now = new Date().toISOString();
  index.topics[topicId].status = 'closed';
  index.topics[topicId].lastActive = now;
  if (summary) index.topics[topicId].summary = summary;
  
  if (index.activeTopic === topicId) {
    index.activeTopic = null;
    const activeState = loadActiveState();
    activeState.activeTopicId = null;
    saveActiveState(activeState);
  }
  
  saveIndex(index);
  
  const state = loadTopicState(topicId);
  if (state) {
    state.status = 'closed';
    state.closedAt = now;
    state.lastActive = now;
    if (summary) state.summary = summary;
    saveTopicState(topicId, state);
  }
  
  console.log(JSON.stringify({ action: 'closed', id: topicId, summary: summary || '' }));
}

function cmdList() {
  const index = loadIndex();
  const topics = Object.entries(index.topics).map(([id, t]) => ({
    id,
    title: t.title,
    status: t.status,
    lastActive: t.lastActive,
    summary: t.summary || '',
    exchanges: t.exchangeCount || 0
  }));
  
  // Sort: active first, then by lastActive desc
  topics.sort((a, b) => {
    if (a.status === 'active') return -1;
    if (b.status === 'active') return 1;
    return new Date(b.lastActive) - new Date(a.lastActive);
  });
  
  console.log(JSON.stringify({ topics, activeTopic: index.activeTopic, count: topics.length }));
}

function cmdStatus() {
  const index = loadIndex();
  const activeState = loadActiveState();
  const metrics = loadMetrics();
  
  const result = {
    activeTopic: index.activeTopic ? {
      id: index.activeTopic,
      ...index.topics[index.activeTopic]
    } : null,
    totalTopics: Object.keys(index.topics).length,
    activeCount: Object.values(index.topics).filter(t => t.status === 'active').length,
    pagedCount: Object.values(index.topics).filter(t => t.status === 'paged').length,
    closedCount: Object.values(index.topics).filter(t => t.status === 'closed').length,
    switchCount: activeState.switchCount || 0,
    totalSwitches: metrics.topicSwitches.length,
    awarenessLayer: renderAwarenessLayer()
  };
  
  console.log(JSON.stringify(result));
}

function cmdAppend(topicId, role, text) {
  const index = loadIndex();
  if (!index.topics[topicId]) {
    console.error(JSON.stringify({ error: `Topic ${topicId} not found` }));
    process.exit(1);
  }
  
  const exchange = {
    role,
    text,
    timestamp: new Date().toISOString(),
    type: role === 'tool' ? 'tool_output' : 'message'
  };
  
  appendExchange(topicId, exchange);
  
  // Update exchange count
  index.topics[topicId].exchangeCount = (index.topics[topicId].exchangeCount || 0) + 1;
  index.topics[topicId].lastActive = exchange.timestamp;
  saveIndex(index);
  
  const state = loadTopicState(topicId);
  if (state) {
    state.exchangeCount = (state.exchangeCount || 0) + 1;
    state.lastActive = exchange.timestamp;
    saveTopicState(topicId, state);
  }
  
  console.log(JSON.stringify({ action: 'appended', topicId, role, exchanges: index.topics[topicId].exchangeCount }));

  // Proactively refresh hot context
  try { refreshHotContext(topicId); } catch (e) { /* non-fatal */ }
}

function refreshHotContext(topicId) {
  // Proactively maintain a per-topic essentials file
  // Called after every append and decision log
  const state = loadTopicState(topicId);
  if (!state) return;
  const index = loadIndex();
  const topicMeta = index.topics[topicId];
  if (!topicMeta) return;

  const now = new Date().toISOString();

  // Active decisions (not superseded)
  const activeDecisions = getActiveDecisions(state);

  // Recent exchanges (last 10)
  const convo = loadConversation(topicId);
  const recent = convo.slice(-10);

  // Open items
  const openItems = state.openItems || [];

  // Working files
  const workingFiles = state.workingFiles || [];

  // Build the hot context markdown
  let ctx = `# Hot Context: ${state.title}\n`;
  ctx += `**ID:** ${topicId} | **Status:** ${state.status} | **Updated:** ${now}\n`;
  ctx += `_Auto-maintained. Updated on every decision and exchange._\n\n`;

  if (activeDecisions.length > 0) {
    const roots = activeDecisions.filter(d => !d.depends_on || !d.depends_on.startsWith('dec_'));
    const chained = activeDecisions.filter(d => d.depends_on && d.depends_on.startsWith('dec_'));

    ctx += `## Active Decisions (${activeDecisions.length})\n`;
    roots.forEach(d => {
      let line = `- ${d.date}: ${d.text}`;
      if (d.depends_on) line += ` [reason: ${d.depends_on}]`;
      if (d.id) line += ` (${d.id})`;
      const deps = getDependents(state, d.id);
      if (deps.length > 0) {
        line += `\n  → leads to: ${deps.filter(dd => !dd.superseded_by).map(dd => dd.text.substring(0, 80)).join('; ')}`;
      }
      ctx += line + '\n';
    });
    if (chained.length > 0) {
      ctx += `\n### Decision Chains\n`;
      chained.forEach(d => {
        const chain = getDecisionChain(state, d.id);
        const chainStr = chain.map(c => c.text ? c.text.substring(0, 60) : '?').join(' → ');
        ctx += `- ${chainStr} (${d.id})\n`;
      });
    }
    const superseded = state.decisions.filter(d => d.superseded_by);
    if (superseded.length > 0) {
      ctx += `_${superseded.length} superseded decision(s) in history_\n`;
    }
    ctx += '\n';
  }

  if (openItems.length > 0) {
    ctx += `## Open Items\n`;
    openItems.forEach(item => { ctx += `- ${item}\n`; });
    ctx += '\n';
  }

  if (workingFiles.length > 0) {
    ctx += `## Working Files\n`;
    workingFiles.forEach(f => { ctx += `- ${f}\n`; });
    ctx += '\n';
  }

  if (recent.length > 0) {
    ctx += `## Recent Exchanges (last ${recent.length})\n`;
    recent.forEach(ex => {
      const role = (ex.role === 'user' || ex.role === 'alex') ? 'User' : 'Agent';
      const text = (ex.text || '').substring(0, 300);
      ctx += `- **${role}** (${ex.timestamp || 'unknown'}): ${text}\n`;
    });
    ctx += '\n';
  }

  // Topic awareness layer — other topics with summaries
  const otherTopics = Object.entries(index.topics)
    .filter(([id]) => id !== topicId)
    .sort((a, b) => (b[1].lastActive || '').localeCompare(a[1].lastActive || ''));
  if (otherTopics.length > 0) {
    ctx += `## Other Topics (${otherTopics.length})\n`;
    otherTopics.forEach(([id, t]) => {
      const summary = t.summary ? ` — ${t.summary}` : '';
      ctx += `- **${t.title}** (${id.slice(0, 12)})${summary}\n`;
    });
    ctx += '\n';
  }

  // Write to contexts dir
  const ctxDir = path.join(TSVC_DIR, 'contexts');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, `${topicId}.md`), ctx);
}

function generateDecisionId() {
  return 'dec_' + require('crypto').randomBytes(8).toString('hex');
}

function cmdDecision(topicId, text, opts = {}) {
  const state = loadTopicState(topicId);
  if (!state) {
    console.error(JSON.stringify({ error: `Topic ${topicId} not found` }));
    process.exit(1);
  }
  
  const now = new Date().toISOString();
  const decision = {
    id: generateDecisionId(),
    date: now.split('T')[0],
    timestamp: now,
    text,
    valid_from: now,
    superseded_by: null,
    superseded_at: null,
    depends_on: opts.dependsOn || null  // decision ID or freeform reason
  };

  // If this supersedes an existing decision, mark the old one
  if (opts.supersedes) {
    const oldDecision = state.decisions.find(d => d.id === opts.supersedes);
    if (oldDecision) {
      oldDecision.superseded_by = decision.id;
      oldDecision.superseded_at = now;
    } else {
      console.error(JSON.stringify({ warning: `Decision ${opts.supersedes} not found to supersede, logging new decision anyway` }));
    }
  }

  state.decisions.push(decision);
  saveTopicState(topicId, state);
  
  console.log(JSON.stringify({ action: 'decision_logged', topicId, decision, superseded: opts.supersedes || null }));

  // Proactively refresh hot context
  try { refreshHotContext(topicId); } catch (e) { /* non-fatal */ }
}

function cmdSupersede(topicId, oldDecisionId, newText, opts = {}) {
  // Convenience: supersede an old decision with a new one in one command
  cmdDecision(topicId, newText, { ...opts, supersedes: oldDecisionId });
}

function getActiveDecisions(state) {
  // Return only decisions that haven't been superseded
  if (!state.decisions) return [];
  return state.decisions.filter(d => !d.superseded_by);
}

function getDecisionChain(state, decisionId) {
  // Walk dependency chain UPWARD for a decision (what does this depend on?)
  const chain = [];
  const visited = new Set();
  let current = state.decisions.find(d => d.id === decisionId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.unshift(current);
    if (current.depends_on && current.depends_on.startsWith('dec_')) {
      current = state.decisions.find(d => d.id === current.depends_on);
    } else {
      // Freeform dependency — add it as a root label
      if (current.depends_on) {
        chain.unshift({ id: null, text: `[root: ${current.depends_on}]`, date: '' });
      }
      break;
    }
  }
  return chain;
}

function getDependents(state, decisionId) {
  // Find all decisions that depend ON this decision (downward)
  if (!state.decisions) return [];
  return state.decisions.filter(d => d.depends_on === decisionId);
}

function cmdChain(topicId, decisionId) {
  const state = loadTopicState(topicId);
  if (!state) {
    console.error(JSON.stringify({ error: `Topic ${topicId} not found` }));
    process.exit(1);
  }

  const chain = getDecisionChain(state, decisionId);
  const dependents = getDependents(state, decisionId);

  console.log(JSON.stringify({
    action: 'decision_chain',
    topicId,
    decisionId,
    chain: chain.map(d => ({
      id: d.id,
      date: d.date,
      text: d.text,
      superseded: !!d.superseded_by
    })),
    dependents: dependents.map(d => ({
      id: d.id,
      date: d.date,
      text: d.text,
      superseded: !!d.superseded_by
    }))
  }));
}

function cmdDecisions(topicId, opts = {}) {
  const state = loadTopicState(topicId);
  if (!state) {
    console.error(JSON.stringify({ error: `Topic ${topicId} not found` }));
    process.exit(1);
  }

  const showAll = opts.all || false;
  const decisions = showAll ? state.decisions : getActiveDecisions(state);
  const supersededCount = state.decisions.filter(d => d.superseded_by).length;

  // Build dependency tree info
  const output = decisions.map(d => {
    const deps = getDependents(state, d.id);
    return {
      id: d.id,
      date: d.date,
      text: d.text,
      depends_on: d.depends_on || null,
      superseded_by: d.superseded_by || null,
      dependents: deps.map(dep => dep.id),
      has_chain: !!(d.depends_on && d.depends_on.startsWith('dec_'))
    };
  });

  console.log(JSON.stringify({
    action: 'decisions_list',
    topicId,
    total: state.decisions.length,
    active: state.decisions.length - supersededCount,
    superseded: supersededCount,
    showingAll: showAll,
    decisions: output
  }));
}

function cmdDetect(message) {
  // Outputs the awareness layer + message for LLM classification
  const awareness = renderAwarenessLayer();
  const index = loadIndex();
  
  console.log(JSON.stringify({
    action: 'detect',
    awarenessLayer: awareness,
    activeTopic: index.activeTopic ? {
      id: index.activeTopic,
      title: index.topics[index.activeTopic].title
    } : null,
    message,
    instruction: 'Classify this message: does it continue the active topic, match a paged topic (specify which), or is it a new topic? Return: {match: "active"|"paged"|"new", topicId?: string, suggestedTitle?: string}'
  }));
}

function cmdCompact(topicId) {
  const convo = loadConversation(topicId);
  const state = loadTopicState(topicId);
  
  if (!state || convo.length === 0) {
    console.log(JSON.stringify({ action: 'compact', status: 'nothing_to_compact', topicId }));
    return;
  }
  
  const originalCount = convo.length;
  const originalSize = JSON.stringify(convo).length;
  
  // Keep last 15 exchanges, archive the rest
  const archiveThreshold = 30; // Only compact if > 30 exchanges
  if (convo.length <= archiveThreshold) {
    console.log(JSON.stringify({ action: 'compact', status: 'below_threshold', topicId, exchanges: convo.length, threshold: archiveThreshold }));
    return;
  }
  
  const keep = convo.slice(-15);
  const archive = convo.slice(0, -15);
  
  // Save archive
  const archiveFile = path.join(topicDir(topicId), `archive_${Date.now()}.jsonl`);
  fs.writeFileSync(archiveFile, archive.map(e => JSON.stringify(e)).join('\n') + '\n');
  
  // Replace conversation with just the recent
  saveConversation(topicId, keep);
  
  // Update state
  state.compactionCount = (state.compactionCount || 0) + 1;
  saveTopicState(topicId, state);
  
  // Log metric
  const metrics = loadMetrics();
  metrics.compactions.push({
    topicId,
    timestamp: new Date().toISOString(),
    originalExchanges: originalCount,
    keptExchanges: keep.length,
    archivedExchanges: archive.length,
    originalBytes: originalSize,
    keptBytes: JSON.stringify(keep).length
  });
  saveMetrics(metrics);
  
  const newSize = JSON.stringify(keep).length;
  console.log(JSON.stringify({
    action: 'compacted',
    topicId,
    originalExchanges: originalCount,
    keptExchanges: keep.length,
    archivedExchanges: archive.length,
    bytesSaved: originalSize - newSize,
    compressionRatio: (((originalSize - newSize) / originalSize) * 100).toFixed(1) + '%',
    archiveFile
  }));
}

function cmdBaseline() {
  // Capture baseline metrics from current (pre-TSVC) system
  const metrics = loadMetrics();
  
  // Try to read session file for compaction count
  const sessionsDir = path.join(process.env.HOME, '.openclaw/agents/main/sessions');
  let compactionCount = 0;
  let sessionSize = 0;
  let sessionLines = 0;
  
  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    files.forEach(f => {
      const fullPath = path.join(sessionsDir, f);
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const compactions = lines.filter(l => l.includes('"type":"compaction"')).length;
      if (compactions > compactionCount) {
        compactionCount = compactions;
        sessionSize = fs.statSync(fullPath).size;
        sessionLines = lines.length;
      }
    });
  } catch (e) { /* ignore */ }
  
  metrics.baseline = {
    capturedAt: new Date().toISOString(),
    compactionCount,
    sessionSizeBytes: sessionSize,
    sessionLines,
    notes: 'Pre-TSVC baseline. All topics shared single context. Compaction was global.'
  };
  
  saveMetrics(metrics);
  console.log(JSON.stringify({ action: 'baseline_captured', ...metrics.baseline }));
}

function cmdMetrics() {
  const metrics = loadMetrics();
  const index = loadIndex();
  
  const topicCount = Object.keys(index.topics).length;
  const totalExchanges = Object.values(index.topics).reduce((sum, t) => sum + (t.exchangeCount || 0), 0);
  
  const result = {
    baseline: metrics.baseline,
    current: {
      totalTopics: topicCount,
      totalExchanges,
      totalSwitches: metrics.topicSwitches.length,
      totalCompactions: metrics.compactions.length,
      perTopicCompactions: metrics.compactions.reduce((acc, c) => {
        acc[c.topicId] = (acc[c.topicId] || 0) + 1;
        return acc;
      }, {}),
      recallTests: metrics.recallTests.length,
      avgRecallScore: metrics.recallTests.length > 0 
        ? (metrics.recallTests.reduce((sum, r) => sum + r.score, 0) / metrics.recallTests.length).toFixed(2)
        : 'no data',
      perceptionRatings: metrics.perceptionRatings
    },
    comparison: metrics.baseline ? {
      baselineCompactions: metrics.baseline.compactionCount,
      tsvcCompactions: metrics.compactions.length,
      note: 'Compare global compactions (baseline) vs per-topic compactions (TSVC)'
    } : 'No baseline captured yet. Run: node tsvc-manager.js baseline'
  };
  
  console.log(JSON.stringify(result, null, 2));
}

function cmdRecall(topicId, question, score, notes) {
  const metrics = loadMetrics();
  metrics.recallTests.push({
    topicId,
    question,
    score: parseFloat(score),
    notes: notes || '',
    timestamp: new Date().toISOString()
  });
  saveMetrics(metrics);
  console.log(JSON.stringify({ action: 'recall_logged', topicId, score }));
}

function cmdRate(category, score, notes) {
  const metrics = loadMetrics();
  metrics.perceptionRatings.push({
    category,
    score: parseFloat(score),
    notes: notes || '',
    timestamp: new Date().toISOString()
  });
  saveMetrics(metrics);
  console.log(JSON.stringify({ action: 'perception_rated', category, score }));
}

function cmdContext(topicId, maxExchanges) {
  const context = renderTopicContext(topicId, parseInt(maxExchanges) || 15);
  if (!context) {
    console.error(JSON.stringify({ error: `Topic ${topicId} not found` }));
    process.exit(1);
  }
  // Output raw markdown (not JSON) for direct context injection
  console.log(context);
}

function cmdAwareness() {
  console.log(renderAwarenessLayer());
}

// --- Switch Telemetry ---

function cmdTelemetryComplete(phase, extraJson) {
  const pendingFile = path.join(TSVC_DIR, 'pending-reset.json');
  const telemetryLog = path.join(TSVC_DIR, 'switch-telemetry.jsonl');
  
  // Try to read pending-reset.json for telemetry data
  let pending = null;
  if (fs.existsSync(pendingFile)) {
    try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch(e) {}
  }
  
  // Also check if there's an in-progress telemetry record
  const activeTelemFile = path.join(TSVC_DIR, 'active-telemetry.json');
  let activeTelem = null;
  if (fs.existsSync(activeTelemFile)) {
    try { activeTelem = JSON.parse(fs.readFileSync(activeTelemFile, 'utf8')); } catch(e) {}
  }
  
  const now = new Date().toISOString();
  let extra = {};
  if (extraJson) {
    try { extra = JSON.parse(extraJson); } catch(e) {}
  }
  
  if (phase === 'session-loaded') {
    // Called right after new session reads pending-reset.json
    // Save telemetry state for later completion
    const telem = pending ? (pending.telemetry || {}) : {};
    telem.t1_new_session_loaded = now;
    
    // Capture post-switch session size
    const sessionsDir = path.join(process.env.HOME, '.openclaw/agents/main/sessions');
    try {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      const newest = files.map(f => ({ f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (newest) {
        const stat = fs.statSync(path.join(sessionsDir, newest.f));
        telem.postSwitch = telem.postSwitch || {};
        telem.postSwitch.contextSizeBytesLoaded = stat.size;
        telem.postSwitch.sessionFile = newest.f;
      }
    } catch(e) {}
    
    // Count boot files read (from extra if provided)
    if (extra.bootFilesRead) {
      telem.postSwitch = telem.postSwitch || {};
      telem.postSwitch.bootFilesRead = extra.bootFilesRead;
    }
    
    // Merge topic info from pending
    const record = {
      fromTopic: pending ? pending.fromTopic : null,
      toTopic: pending ? pending.toTopic : null,
      triggeringMessage: pending ? pending.triggeringMessage : null,
      telemetry: telem
    };
    
    fs.writeFileSync(activeTelemFile, JSON.stringify(record, null, 2));
    console.log(JSON.stringify({ action: 'telemetry_session_loaded', t1: now }));
    
  } else if (phase === 'reply-sent') {
    // Called right before/after first reply is sent to user
    const record = activeTelem || { telemetry: {} };
    record.telemetry.t2_first_reply_sent = now;
    
    // Calculate deltas
    const t0 = record.telemetry.t0_initiated ? new Date(record.telemetry.t0_initiated).getTime() : null;
    const t1 = record.telemetry.t1_new_session_loaded ? new Date(record.telemetry.t1_new_session_loaded).getTime() : null;
    const t2 = new Date(now).getTime();
    
    record.telemetry.deltas = {
      total_ms: t0 ? t2 - t0 : null,
      reset_to_load_ms: t0 && t1 ? t1 - t0 : null,
      load_to_reply_ms: t1 ? t2 - t1 : null
    };
    
    // Merge extra context size info
    if (extra.contextSizeBytes) {
      record.telemetry.postSwitch = record.telemetry.postSwitch || {};
      record.telemetry.postSwitch.contextSizeAtReply = extra.contextSizeBytes;
    }
    
    // Append to telemetry log (append-only JSONL)
    fs.appendFileSync(telemetryLog, JSON.stringify({
      timestamp: now,
      ...record
    }) + '\n');
    
    // Also add to metrics.json switchTelemetry array
    const metrics = loadMetrics();
    if (!metrics.switchTelemetry) metrics.switchTelemetry = [];
    metrics.switchTelemetry.push({
      timestamp: now,
      from: record.fromTopic,
      to: record.toTopic,
      deltas: record.telemetry.deltas,
      preSwitch: record.telemetry.preSwitch || null,
      postSwitch: record.telemetry.postSwitch || null
    });
    saveMetrics(metrics);
    
    // Cleanup
    try { fs.unlinkSync(activeTelemFile); } catch(e) {}
    
    console.log(JSON.stringify({ 
      action: 'telemetry_complete', 
      deltas: record.telemetry.deltas,
      preSwitch: record.telemetry.preSwitch,
      postSwitch: record.telemetry.postSwitch
    }));
    
  } else if (phase === 'report') {
    // Print telemetry report
    if (!fs.existsSync(telemetryLog)) {
      console.log(JSON.stringify({ action: 'report', switches: 0, message: 'No telemetry data yet' }));
      return;
    }
    
    const entries = fs.readFileSync(telemetryLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    
    const totalMs = entries.filter(e => e.telemetry?.deltas?.total_ms).map(e => e.telemetry.deltas.total_ms);
    const resetToLoad = entries.filter(e => e.telemetry?.deltas?.reset_to_load_ms).map(e => e.telemetry.deltas.reset_to_load_ms);
    const loadToReply = entries.filter(e => e.telemetry?.deltas?.load_to_reply_ms).map(e => e.telemetry.deltas.load_to_reply_ms);
    
    const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
    const min = arr => arr.length ? Math.min(...arr) : null;
    const max = arr => arr.length ? Math.max(...arr) : null;
    
    const preSizes = entries.filter(e => e.telemetry?.preSwitch?.sessionSizeBytes).map(e => e.telemetry.preSwitch.sessionSizeBytes);
    const postSizes = entries.filter(e => e.telemetry?.postSwitch?.contextSizeBytesLoaded).map(e => e.telemetry.postSwitch.contextSizeBytesLoaded);
    
    console.log(JSON.stringify({
      action: 'report',
      switches: entries.length,
      timing: {
        total: { avg_ms: avg(totalMs), min_ms: min(totalMs), max_ms: max(totalMs), samples: totalMs.length },
        resetToLoad: { avg_ms: avg(resetToLoad), min_ms: min(resetToLoad), max_ms: max(resetToLoad), samples: resetToLoad.length },
        loadToReply: { avg_ms: avg(loadToReply), min_ms: min(loadToReply), max_ms: max(loadToReply), samples: loadToReply.length }
      },
      contextSizes: {
        preSwitch: { avg_bytes: avg(preSizes), min_bytes: min(preSizes), max_bytes: max(preSizes), samples: preSizes.length },
        postSwitch: { avg_bytes: avg(postSizes), min_bytes: min(postSizes), max_bytes: max(postSizes), samples: postSizes.length }
      },
      entries: entries.map(e => ({
        time: e.timestamp,
        from: e.fromTopic?.title || e.fromTopic?.id || '?',
        to: e.toTopic?.title || e.toTopic?.id || '?',
        total_s: e.telemetry?.deltas?.total_ms ? (e.telemetry.deltas.total_ms / 1000).toFixed(1) : '?',
        preSizeKB: e.telemetry?.preSwitch?.sessionSizeBytes ? (e.telemetry.preSwitch.sessionSizeBytes / 1024).toFixed(0) : '?',
        preMessages: e.telemetry?.preSwitch?.sessionMessageCount || '?'
      }))
    }, null, 2));
  }
}

// --- CLI ---

const [,, command, ...args] = process.argv;

switch (command) {
  case 'create':
    cmdCreate(args.join(' '));
    break;
  case 'switch':
    cmdSwitch(args[0]);
    break;
  case 'save':
    cmdSave();
    break;
  case 'load':
  case 'context':
    cmdContext(args[0], args[1]);
    break;
  case 'close':
    cmdClose(args[0], args.slice(1).join(' '));
    break;
  case 'list':
    cmdList();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'detect':
    cmdDetect(args.join(' '));
    break;
  case 'compact':
    cmdCompact(args[0]);
    break;
  case 'append':
    cmdAppend(args[0], args[1], args.slice(2).join(' '));
    break;
  case 'decision': {
    // Parse optional flags: --supersedes <id> --depends-on <id|text>
    const dOpts = {};
    const dArgs = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--supersedes' && args[i+1]) { dOpts.supersedes = args[++i]; }
      else if (args[i] === '--depends-on' && args[i+1]) { dOpts.dependsOn = args[++i]; }
      else { dArgs.push(args[i]); }
    }
    cmdDecision(dArgs[0], dArgs.slice(1).join(' '), dOpts);
    break;
  }
  case 'supersede':
    // supersede <topic_id> <old_decision_id> <new text>
    cmdSupersede(args[0], args[1], args.slice(2).join(' '));
    break;
  case 'refresh':
    // refresh [topic_id] — refresh hot context for a topic (default: active topic)
    {
      const targetId = args[0] || loadIndex().activeTopic;
      if (!targetId) { console.error(JSON.stringify({ error: 'No topic specified or active' })); process.exit(1); }
      refreshHotContext(targetId);
      console.log(JSON.stringify({ action: 'hot_context_refreshed', topicId: targetId }));
    }
    break;
  case 'chain':
    // chain <topic_id> <decision_id> — show dependency chain for a decision
    cmdChain(args[0], args[1]);
    break;
  case 'decisions':
    // decisions <topic_id> [--all] — list decisions with dependency info
    {
      const dListOpts = {};
      const dListArgs = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--all') { dListOpts.all = true; }
        else { dListArgs.push(args[i]); }
      }
      cmdDecisions(dListArgs[0] || loadIndex().activeTopic, dListOpts);
    }
    break;
  case 'baseline':
    cmdBaseline();
    break;
  case 'metrics':
    cmdMetrics();
    break;
  case 'recall':
    cmdRecall(args[0], args[1], args[2], args.slice(3).join(' '));
    break;
  case 'rate':
    cmdRate(args[0], args[1], args.slice(2).join(' '));
    break;
  case 'awareness':
    cmdAwareness();
    break;
  case 'telemetry':
    cmdTelemetryComplete(args[0], args.slice(1).join(' '));
    break;
  default:
    console.log(`TSVC Manager — Topic-Scoped Virtual Context

Usage: node tsvc-manager.js <command> [args]

Topic Management:
  create <title>                    Create new topic (becomes active)
  switch <topic_id>                 Save current, load target topic
  save                              Save current active topic
  context <topic_id> [maxExchanges] Render topic context as markdown
  close <topic_id> [summary]        Close topic
  list                              List all topics
  status                            Show active topic + stats
  awareness                         Show topic awareness layer

Conversation:
  append <topic_id> <role> <text>   Add exchange (role: user|assistant|tool)
  decision <topic_id> <text> [--supersedes <id>] [--depends-on <id|reason>]  Log a decision
  supersede <topic_id> <old_id> <new_text>  Supersede a decision
  detect <message>                  Classify message against topics

Maintenance:
  compact <topic_id>                Compact topic conversation (archive old)

Metrics:
  baseline                          Capture pre-TSVC baseline
  metrics                           Show all metrics
  telemetry session-loaded [json]   Log t1 (new session loaded)
  telemetry reply-sent [json]       Log t2 (first reply sent) + finalize
  telemetry report                  Print telemetry report with averages
  recall <topic_id> <question> <score> [notes]  Log recall test
  rate <category> <score> [notes]   Log perception rating
    Categories: continuity, relevance, context_loss, switch_speed
    Score: 1-5 (1=terrible, 5=excellent)`);
}
