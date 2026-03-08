#!/usr/bin/env node
// detect-topic-switch.js — Lightweight pre-check for topic switch intent
// Usage: node detect-topic-switch.js "<user_message>" "<current_topic_id>"
// Output: JSON { switchDetected, topicId, title, confidence, reason }
//
// Run on EVERY user message. If switchDetected=true, initiate switch.

const fs = require('fs');
const path = require('path');

const userMsg = (process.argv[2] || '').trim();
const currentTopicId = (process.argv[3] || '').trim();

if (!userMsg) {
  console.log(JSON.stringify({ switchDetected: false, reason: 'no_message' }));
  process.exit(0);
}

// Load topic index
const indexPath = path.join(__dirname, '..', 'topic_files', 'index.json');
let index;
try {
  index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
} catch (e) {
  console.log(JSON.stringify({ switchDetected: false, reason: 'no_index' }));
  process.exit(0);
}

// Get current topic title
const currentTitle = currentTopicId && index.topics[currentTopicId] 
  ? index.topics[currentTopicId].title 
  : '';

// ─── Step 1: Extract potential topic reference from message ───
let msgLower = userMsg.toLowerCase();

// Strip leading filler words (No, Yeah, Ok, Sure, Alright, etc.)
msgLower = msgLower.replace(/^(?:no|yeah|yes|yep|yup|ok|okay|sure|alright|right|nah|nope|well|so|hey|hmm|um|uh|please|pls)[,.\s!]*\s*/i, '').trim();

// Strip common prefixes/intent phrases to isolate the topic reference
const intentPatterns = [
  /(?:let'?s?\s+)?(?:switch\s+(?:back\s+)?to|go\s+(?:back\s+)?to|jump\s+(?:back\s+)?to|move\s+(?:back\s+)?to|back\s+to)\s+/i,
  /(?:let'?s?\s+)?(?:talk\s+about|discuss|work\s+on|look\s+at|dig\s+into|get\s+into|focus\s+on|continue\s+with|resume|pick\s+up|go\s+back\s+to|get\s+back\s+to|return\s+to)\s+/i,
  /(?:what\s+about|how\s+about|how'?s|what'?s\s+(?:up\s+with|happening\s+with|going\s+on\s+with))\s+/i,
  /(?:did\s+we|have\s+we|where\s+(?:are\s+we|were\s+we)\s+(?:on|with))\s+/i,
  /(?:any\s+(?:updates?\s+on|progress\s+on|news\s+on))\s+/i,
  /(?:open|load|bring\s+up|pull\s+up)\s+/i,
  /(?:back\s+to)\s+/i,
  /(?:can\s+(?:you|we)\s+)?(?:switch\s+(?:back\s+)?to|go\s+(?:back\s+)?to)\s+/i,
  /(?:we\s+need\s+to\s+be\s+in)\s+/i,
  /(?:let'?s?\s+go\s+to)\s+/i,
  /(?:open\s+(?:the\s+)?)\s*/i,
  /(?:i\s+want\s+to\s+talk\s+about)\s+/i,
  /(?:can\s+we\s+do)\s+/i,
];

// Check if message has explicit switch intent
let hasExplicitIntent = false;
let topicCandidate = msgLower;

for (const pattern of intentPatterns) {
  if (pattern.test(msgLower)) {
    hasExplicitIntent = true;
    topicCandidate = msgLower.replace(pattern, '').trim();
    break;
  }
}

// Also strip trailing noise: "topic", "please", "?", ".", etc.
topicCandidate = topicCandidate
  .replace(/\s*(?:topic|project|please|pls|now|real\s+quick|quickly)[\s.?!]*$/i, '')
  .replace(/[?.!,]+$/, '')
  .trim();

if (!topicCandidate) {
  console.log(JSON.stringify({ switchDetected: false, reason: 'no_topic_candidate' }));
  process.exit(0);
}

// ─── Step 2: Run topic matcher ───
// Inline the matching logic (same as match-topic.js but embedded)
const topics = Object.entries(index.topics).map(([id, t]) => ({
  id,
  title: t.title,
  titleLower: t.title.toLowerCase(),
  status: t.status
}));

const query = topicCandidate;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function score(topic) {
  const t = topic.titleLower;
  const tClean = t.replace(/[^a-z0-9 ]/g, '').trim();
  const qClean = query.replace(/[^a-z0-9 ]/g, '').trim();
  
  // Collect all applicable scores, return the max
  let best = 0;

  if (t === query) return 100;
  if (tClean === qClean) return 95;
  if (t.startsWith(query) || tClean.startsWith(qClean)) best = Math.max(best, 90);
  
  // Acronym match
  const words = t.split(/[\s\-—]+/);
  const acronym = words.map(w => w[0]).join('');
  if (acronym === query) best = Math.max(best, 85);
  
  if (t.includes(query) || tClean.includes(qClean)) best = Math.max(best, 80);

  // Word overlap
  const queryWords = query.split(/\s+/);
  const titleWords = t.split(/[\s\-—]+/);
  const wordMatches = queryWords.filter(qw =>
    titleWords.some(tw => tw === qw || tw.startsWith(qw))
  ).length;
  const matchRatio = wordMatches / queryWords.length;
  if (matchRatio >= 0.8) best = Math.max(best, 85);
  else if (wordMatches > 0) best = Math.max(best, 50 + (matchRatio) * 30);

  // Common aliases
  const aliases = {
    'avatar': 'business agent',
    'agent avatar': 'business agent',
    'book': 'sci-fi/fantasy book',
    'writing': 'sci-fi/fantasy book',
    'novel': 'sci-fi/fantasy book',
    'comms': 'agent & user',
    'setup': 'agent & user',
    'infra': 'infrastructure',
    'infrastructure': 'infrastructure & openclaw',
    'openclaw': 'infrastructure & openclaw',
    'nuc': 'infrastructure & openclaw',
    'docker': 'infrastructure & openclaw',
    'presence': 'personal/professional online presence',
    'linkedin': 'personal/professional online presence',
    'github profile': 'personal/professional online presence',
    'online presence': 'personal/professional online presence',
    'safety': 'family',
    'family': 'family',
    'will': 'family',
    'estate': 'family',
    'trading': 'finance',
    'finance': 'finance',
    'options': 'finance',
    'stocks': 'finance',
    'majordomo': 'majordomo',
    'majordomo': 'majordomo',
    'system agent': 'majordomo',
    'twa': 'education',
    'course': 'education',
    'tsvc': 'tsvc development',
    'topic switch': 'tsvc development',
    'context switch': 'tsvc development',
  };

  const baseScore = best;
  for (const [alias, target] of Object.entries(aliases)) {
    const aliasClean = alias.replace(/[^a-z0-9 ]/g, '').trim();
    const aliasWordRegex = new RegExp(`\\b${escapeRegExp(alias)}\\b`);
    const aliasWordMatch = aliasWordRegex.test(query);
    const aliasInQuery = aliasWordMatch || query.includes(alias);

    if (aliasInQuery && t.includes(target)) {
      if (aliasClean && qClean === aliasClean) {
        best = Math.max(best, 95);
      } else {
        const wordBonus = aliasWordMatch ? 2 : 0;
        best = Math.max(best, baseScore + 20 + wordBonus);
      }
    }
  }

  return best;
}

function isShortCommandOrQuestion(msg) {
  const words = msg.trim().split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;
  if (/\?$/.test(msg)) return true;
  if (/^(what|how|why|when|who|where|did|do|does|is|are|can|could|should|would|will)\b/i.test(msg)) return true;
  if (/^(show|status|update|progress|next|continue|resume|open|switch|go|back)\b/i.test(msg)) return true;
  return false;
}

function inferTitle(msg) {
  const stop = new Set([
    'the','a','an','and','or','but','if','then','else','when','where','what','why','how','who','whom','which','to','of','in','on','for','with','about','into','from','by','as','at','is','are','was','were','be','been','being','do','does','did','can','could','should','would','will','just','please','pls','let','lets',"let's",'we','you','i','me','my','our','us','your','it','this','that','these','those','need','want','talk','discuss','switch','topic','go','back','open','load','bring','pull','up','hey','ok','okay','yeah','yes','yep','yup','uh','um','hmm','so','well'
  ]);
  const clean = msg.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = clean.split(/\s+/).filter(w => w && w.length > 2 && !stop.has(w));
  const picked = [];
  for (const w of words) {
    if (!picked.includes(w)) picked.push(w);
    if (picked.length >= 3) break;
  }
  if (picked.length === 0) {
    return clean.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  }
  return picked.join(' ');
}

const scored = topics
  .map(t => ({ ...t, score: score(t) }))
  .filter(t => t.score > 0)
  .sort((a, b) => b.score - a.score);

const topScore = scored[0]?.score || 0;
const wordCount = userMsg.trim().split(/\s+/).filter(Boolean).length;

if (topScore <= 40 && wordCount > 5 && !isShortCommandOrQuestion(userMsg.toLowerCase())) {
  console.log(JSON.stringify({
    switchDetected: false,
    newTopicSuggested: true,
    suggestedTitle: inferTitle(userMsg),
    reason: 'new_topic',
    query: userMsg
  }));
  process.exit(0);
}

if (scored.length === 0) {
  console.log(JSON.stringify({ switchDetected: false, reason: 'no_match', query }));
  process.exit(0);
}

const top = scored[0];
const second = scored[1];
// Lower gap requirement when explicit intent is present
const gapThreshold = hasExplicitIntent ? 3 : 10;
const clearMatch = top.score >= 50 && (!second || top.score - second.score >= gapThreshold);

if (!clearMatch) {
  console.log(JSON.stringify({
    switchDetected: false,
    reason: 'ambiguous_match',
    candidates: scored.slice(0, 3).map(s => ({ topicId: s.id, title: s.title, score: s.score }))
  }));
  process.exit(0);
}

// ─── Step 3: Decision ───
// Same topic? No switch needed.
if (top.id === currentTopicId) {
  console.log(JSON.stringify({
    switchDetected: false,
    reason: 'already_on_topic',
    topicId: top.id,
    title: top.title
  }));
  process.exit(0);
}

// Explicit intent + clear match = switch
if (hasExplicitIntent) {
  console.log(JSON.stringify({
    switchDetected: true,
    topicId: top.id,
    title: top.title,
    confidence: top.score,
    reason: 'explicit_intent'
  }));
  process.exit(0);
}

// No explicit intent but clear match on a different topic = suggest (don't auto-switch)
// This handles "did we do something on trading?" — could be a question in current context
console.log(JSON.stringify({
  switchDetected: false,
  reason: 'implicit_reference',
  suggestSwitch: true,
  topicId: top.id,
  title: top.title,
  confidence: top.score
}));
