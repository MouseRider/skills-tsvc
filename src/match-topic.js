#!/usr/bin/env node
// Deterministic topic matcher — fuzzy match user input against topic index
// Usage: node match-topic.js "tsvc"
// Output: JSON { matched: true, topicId, title, confidence } or { matched: false, candidates: [...] }

const fs = require('fs');
const path = require('path');

const input = process.argv[2];
if (!input) {
  console.log(JSON.stringify({ matched: false, error: 'No input provided' }));
  process.exit(1);
}

const indexPath = path.join(__dirname, '..', 'topic_files', 'index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

const query = input.toLowerCase().trim();
const topics = Object.entries(index.topics).map(([id, t]) => ({
  id,
  title: t.title,
  titleLower: t.title.toLowerCase(),
  status: t.status
}));

// Scoring: exact > starts-with > contains > acronym > word-match
function score(topic) {
  const t = topic.titleLower;
  
  // Exact match
  if (t === query) return 100;
  
  // Exact match ignoring special chars (dashes, em-dashes, etc)
  const tClean = t.replace(/[^a-z0-9 ]/g, '').trim();
  const qClean = query.replace(/[^a-z0-9 ]/g, '').trim();
  if (tClean === qClean) return 95;
  
  // Starts with query
  if (t.startsWith(query) || tClean.startsWith(qClean)) return 90;
  
  // Contains query as substring
  if (t.includes(query) || tClean.includes(qClean)) return 80;
  
  // Acronym match: "tsvc" matches "TSVC Development", "twa" matches "Education"
  const words = t.split(/[\s\-—]+/);
  const acronym = words.map(w => w[0]).join('');
  if (acronym === query) return 85;
  
  // Check if topic title contains query word as a standalone word
  const queryWords = query.split(/\s+/);
  const titleWords = t.split(/[\s\-—]+/);
  const wordMatches = queryWords.filter(qw => 
    titleWords.some(tw => tw === qw || tw.startsWith(qw))
  ).length;
  if (wordMatches > 0) return 50 + (wordMatches / queryWords.length) * 30;

  // Common aliases
  const aliases = {
    'avatar': 'business agent',
    'agent avatar': 'business agent',
    'book': 'sci-fi/fantasy book',
    'comms': 'agent & user',
    'setup': 'agent & user',
    'infra': 'infrastructure',
    'openclaw': 'infrastructure & openclaw',
    'nuc': 'infrastructure & openclaw',
    'presence': 'personal/professional online presence',
    'linkedin': 'personal/professional online presence',
    'safety': 'family',
    'family': 'family',
    'trading': 'finance',
    'finance': 'finance',
    'options': 'finance',
    'majordomo': 'majordomo',
    'majordomo': 'majordomo',
    'twa': 'education',
    'tsvc': 'tsvc development',
  };
  
  for (const [alias, target] of Object.entries(aliases)) {
    if (query.includes(alias) && t.includes(target)) return 88;
  }
  
  return 0;
}

const scored = topics
  .map(t => ({ ...t, score: score(t) }))
  .filter(t => t.score > 0)
  .sort((a, b) => b.score - a.score);

if (scored.length === 0) {
  console.log(JSON.stringify({ 
    matched: false, 
    error: 'No matching topic found',
    query,
    available: topics.map(t => t.title)
  }));
  process.exit(0);
}

// Clear winner: top score >= 50 and at least 10 points ahead of second
const top = scored[0];
const second = scored[1];
const clearWinner = top.score >= 50 && (!second || top.score - second.score >= 10);

if (clearWinner) {
  console.log(JSON.stringify({
    matched: true,
    topicId: top.id,
    title: top.title,
    confidence: top.score,
    status: top.status
  }));
} else {
  console.log(JSON.stringify({
    matched: false,
    ambiguous: true,
    candidates: scored.slice(0, 3).map(s => ({
      topicId: s.id,
      title: s.title,
      score: s.score
    }))
  }));
}
