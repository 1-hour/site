#!/usr/bin/env node
/**
 * Step 1: Generate Unsplash search keywords for each tutorial.
 *
 * Reads content/tutorials/<slug>/{meta.yaml, en.mdx} → produces
 * output/keywords.json with { slug: [hero_query, step1_query, ..., step5_query] }.
 *
 * Strategy: derive from tutorial title + tags + section H2 headers.
 * NO llm call — deterministic heuristic keyed off tags + section names.
 * (LLM keyword generation is a possible future upgrade but heuristic is
 *  good enough for a first pass and doesn't require network / API keys.)
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTENT_DIR = path.join(ROOT, 'content');
const OUT_DIR = path.join(import.meta.dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Category → base scene vocabulary. Steers keyword generation so
// e.g. "resume-ai-rewrite" ends up querying "office desk laptop resume"
// instead of trying to imagine what "resume rewrite" looks like literally.
const CATEGORY_BASE = {
  'ai-tools': ['laptop workspace ai', 'chatgpt screen', 'ai chatbot interface'],
  'creators':  ['content creator studio', 'camera vlog setup', 'social media phone'],
  'marketing': ['analytics dashboard', 'marketing team meeting', 'growth chart screen'],
  'product':   ['product designer sketching', 'whiteboard planning', 'user research'],
  'design':    ['designer tablet drawing', 'color palette workspace', 'creative process'],
  'code':      ['developer coding screen', 'terminal command line', 'programming workspace'],
  'office':    ['office desk laptop', 'business documents', 'productivity workspace'],
  'automation':['workflow diagram screen', 'automation dashboard', 'data pipeline'],
  'side-hustle':['entrepreneur laptop coffee shop', 'startup workspace', 'indie hacker desk'],
  'mind':      ['journaling notebook', 'thinking mindfulness', 'reading concentration'],
};

// Parse H2 section headers from MDX (## 标题) — we use these as step queries.
function extractH2s(mdx) {
  const lines = mdx.split('\n');
  const sections = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)(?:\s*\{|\s*$)/);
    if (m) sections.push(m[1].trim());
  }
  return sections;
}

// Clean a section title into a searchable query.
// - Remove emoji, step numbers, time blocks
// - Strip Chinese punctuation
function cleanTitle(title) {
  return title
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // emoji
    .replace(/step\s*\d+:?/gi, '')
    .replace(/第\s*\d+\s*步[：:]?/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\d+\s*[-–]\s*\d+\s*(min|分钟)/gi, '')
    .replace(/[,，。：:]/g, ' ')
    .trim();
}

// Turn a category + section title into an English search query.
// Strategy: always ground in category vocabulary (guaranteed to return
// beautiful stock photos), then optionally salt with tags/section words.
// Chinese-only sections lose their words and rely on category vocab.
function toEnglishQuery(sectionTitle, category, tags, idx) {
  const base = CATEGORY_BASE[category] || CATEGORY_BASE['office'];
  const baseVocab = base[idx % base.length];
  const tag = tags[idx % Math.max(tags.length, 1)] || '';

  // Try to extract 1-2 vivid words from the section title.
  // Reject filler words that make bad Unsplash queries.
  const FILLER = new Set([
    'what', 'why', 'how', 'when', 'the', 'and', 'for', 'your', 'you',
    'build', 'get', 'make', 'add', 'create', 'setup', 'set', 'up',
    'first', 'second', 'third', 'step', 'part', 'phase',
    'summary', 'points', 'key', 'ship', 'try', 'test', 'run',
  ]);

  const vivid = sectionTitle
    .split(/\s+/)
    .filter(w => /^[a-zA-Z][\w-]{2,}$/.test(w))
    .filter(w => !FILLER.has(w.toLowerCase()))
    .slice(0, 2)
    .join(' ')
    .toLowerCase();

  // Query = category base + (vivid section word OR tag)
  // Category base is always present so Unsplash always finds *something*.
  const salt = vivid || tag;
  return salt ? `${baseVocab} ${salt}` : baseVocab;
}

function generateKeywords(slug, meta, enMdx) {
  const tags = (meta.tags || []).map(t => String(t).replace(/-/g, ' '));
  const category = meta.category || 'office';
  const base = CATEGORY_BASE[category] || CATEGORY_BASE['office'];

  // Hero: category-driven wide scene. Add first non-redundant tag.
  const heroTag = tags.find(t => !base[0].toLowerCase().includes(t.toLowerCase().split(' ')[0])) || '';
  const hero = `${base[0]} ${heroTag}`.trim();

  // Steps: from the first 5 H2 sections in the en.mdx
  // Skip common non-step sections like "Outcome", "Prerequisites",
  // "Time Blocks", "Bonus", "Next Steps", "Resources".
  const IGNORE = /^(outcome|prerequisites|time blocks?|bonus|next steps?|resources|extra|references|advanced|takeaways?|🎯|⏱|📋|📚|🎁|🔗|🎉)/i;
  const sections = extractH2s(enMdx)
    .filter(s => !IGNORE.test(s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim()))
    .slice(0, 5);

  const steps = [];
  for (let i = 0; i < 5; i++) {
    const raw = sections[i] || `${category} step ${i + 1}`;
    const clean = cleanTitle(raw);
    steps.push(toEnglishQuery(clean, category, tags, i));
  }

  return { hero, steps };
}

function main() {
  const tutorialsDir = path.join(CONTENT_DIR, 'tutorials');
  const slugs = fs.readdirSync(tutorialsDir).filter(s =>
    fs.statSync(path.join(tutorialsDir, s)).isDirectory()
  );

  const result = {};

  for (const slug of slugs) {
    const metaPath = path.join(tutorialsDir, slug, 'meta.yaml');
    const enPath = path.join(tutorialsDir, slug, 'en.mdx');
    if (!fs.existsSync(metaPath) || !fs.existsSync(enPath)) continue;

    const meta = yaml.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.published === false) continue;

    const enMdx = fs.readFileSync(enPath, 'utf8');
    result[slug] = generateKeywords(slug, meta, enMdx);
  }

  const out = path.join(OUT_DIR, 'keywords.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`Wrote ${Object.keys(result).length} tutorials → ${out}`);

  // Print a sample for quick sanity check
  const sampleSlug = Object.keys(result)[0];
  console.log(`\nSample (${sampleSlug}):`);
  console.log(JSON.stringify(result[sampleSlug], null, 2));
}

main();
