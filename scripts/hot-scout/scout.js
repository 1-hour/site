#!/usr/bin/env node
/**
 * hot-scout: discover trending topics from non-tech-friendly sources,
 * have an LLM rate them as candidates for a 1-hour tutorial, append
 * passing items to topics.yaml.
 *
 * Sources (curl-direct, no API key):
 *   - Hacker News (Show HN, front page)
 *   - Product Hunt (RSS feed)
 *   - GitHub Trending (HTML scrape)
 *   - Reddit RSS: r/SideProject, r/Entrepreneur, r/marketing, r/ChatGPT,
 *                 r/productivity, r/Notion, r/copywriting, r/PromptEngineering
 *   - IndieHackers (RSS)
 *
 * Usage:
 *   node scout.js                   # full run, append to topics.yaml
 *   node scout.js --dry-run         # don't write
 *   node scout.js --top 10          # only consider top N candidates
 *   node scout.js --no-llm          # skip evaluation, just print discovered
 */

import { XMLParser } from 'fast-xml-parser';
import yaml from 'yaml';
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TOPICS_FILE = path.join(ROOT, 'topics.yaml');
const STATE_FILE = path.join(import.meta.dirname, '.state.json');
const CONTENT_DIR = path.join(ROOT, '..', '1hour-guide-content');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_LLM = args.includes('--no-llm');
const TOP_N = (() => {
  const i = args.indexOf('--top');
  return i >= 0 ? parseInt(args[i + 1], 10) : 30;
})();

const UA = '1hour-scout/0.1 (https://1hour.guide)';
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
// fast-xml-parser caps entity expansions; some Reddit/IH feeds tickle this.
// We use a simple regex-based extractor for those instead.

function parseAtomLite(feed, source, limit = 25) {
  // Extract <entry>...<title>...</title>...<link href="..."/>...</entry>
  const entries = [];
  const reEntry = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = reEntry.exec(feed)) !== null && entries.length < limit) {
    const block = m[1];
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block);
    const linkMatch = /<link[^>]*href="([^"]+)"/.exec(block);
    if (!titleMatch) continue;
    let title = titleMatch[1]
      .replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/<[^>]+>/g, '')
      .trim();
    entries.push({ source, title, url: linkMatch?.[1] || '' });
  }
  return entries;
}

// ============================================================
// Sources
// ============================================================

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}
async function fetchJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function parseRedditAtom(feed, source) {
  return parseAtomLite(feed, source, 25);
}

async function fetchHN() {
  const data = await fetchJSON('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30');
  const items = (data.hits || []).map(h => ({
    source: 'hn-front',
    title: h.title,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    score: h.points,
    date: h.created_at,
  }));
  const showData = await fetchJSON('https://hn.algolia.com/api/v1/search?tags=show_hn&hitsPerPage=20');
  const show = (showData.hits || []).map(h => ({
    source: 'hn-show',
    title: h.title,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    score: h.points,
    date: h.created_at,
  }));
  return [...items, ...show].filter(x => (x.score || 0) >= 50);
}

async function fetchProductHunt() {
  const feed = await fetchText('https://www.producthunt.com/feed');
  const parsed = xml.parse(feed);
  // Product Hunt uses Atom format
  const entries = parsed?.feed?.entry || [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list.slice(0, 25).map(e => {
    const link = e.link;
    const url = Array.isArray(link)
      ? link.find(l => l.rel === 'alternate')?.href || link[0]?.href
      : link?.href || '';
    const content = typeof e.content === 'string'
      ? e.content
      : e.content?.['#text'] || '';
    const desc = content
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    return {
      source: 'producthunt',
      title: typeof e.title === 'string' ? e.title : e.title?.['#text'] || '',
      url,
      desc,
      date: e.updated || e.published,
    };
  }).filter(x => x.title);
}

async function fetchGithubTrending() {
  const html = await fetchText('https://github.com/trending?since=daily');
  const out = [];
  // 2024+ markup: <h2 class="h3 lh-condensed"><a ... href="/owner/repo">
  const re = /<h2 class="h3 lh-condensed">\s*<a[^>]*href="\/([^"]+)"[\s\S]*?<\/a>\s*<\/h2>([\s\S]*?)(?:<article|$)/g;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 25) {
    const repo = m[1].trim();
    const block = m[2];
    const descMatch = /<p[^>]*class="[^"]*col-9[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/p>/.exec(block)
                   || /<p[^>]*>\s*([\s\S]*?)\s*<\/p>/.exec(block);
    const desc = descMatch
      ? descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    out.push({
      source: 'github-trending',
      title: repo.split('/').slice(-1)[0],
      url: `https://github.com/${repo}`,
      desc,
    });
  }
  return out;
}

async function fetchRedditList() {
  // Reddit anonymous rate limits are extremely aggressive (~1 req per
  // several seconds). We pick the 5 highest-signal subs for our audience
  // and slow-walk them with a 4-second gap.
  const subs = [
    'SideProject',         // side hustle ideas
    'ChatGPT',             // AI tool flow
    'productivity',        // office / efficiency
    'PromptEngineering',   // prompt engineering
    'NoCode',              // no-code (operators / non-tech)
  ];
  const all = [];
  const REDDIT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  for (const s of subs) {
    try {
      await new Promise(r => setTimeout(r, 4000));
      const r = await fetch(`https://old.reddit.com/r/${s}/top.rss?t=week`, {
        headers: { 'User-Agent': REDDIT_UA, Accept: 'application/atom+xml,application/xml,*/*' },
      });
      if (!r.ok) {
        console.error(`  [skip] r/${s}: ${r.status}`);
        if (r.status === 429) await new Promise(r2 => setTimeout(r2, 8000));
        continue;
      }
      const feed = await r.text();
      const items = parseRedditAtom(feed, `r/${s}`);
      if (items.length > 0) all.push(...items);
    } catch (e) {
      console.error(`  [skip] r/${s}: ${e.message}`);
    }
  }
  return all;
}

async function fetchIndieHackers() {
  try {
    const feed = await fetchText('https://www.indiehackers.com/feed.xml');
    // IH RSS includes embedded HTML which tickles fast-xml-parser limits;
    // use the lite parser.
    const entries = [];
    const reItem = /<item[^>]*>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = reItem.exec(feed)) !== null && entries.length < 20) {
      const block = m[1];
      const titleMatch = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block);
      const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(block);
      if (!titleMatch) continue;
      const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
      entries.push({ source: 'indiehackers', title, url: linkMatch?.[1]?.trim() || '' });
    }
    return entries;
  } catch (e) {
    console.error(`  [skip] indiehackers: ${e.message}`);
    return [];
  }
}

// ============================================================
// Chinese sources (no cookie required)
// ============================================================

async function fetchZhihuHot() {
  // Mobile API works without auth.
  const r = await fetch('https://api.zhihu.com/topstory/hot-list?limit=30', {
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
  });
  if (!r.ok) throw new Error(`zhihu ${r.status}`);
  const data = await r.json();
  const items = data.data || [];
  return items.map(it => {
    const t = it.target || {};
    return {
      source: 'zhihu-hot',
      title: t.title || t.title_area?.text || '',
      desc: (t.excerpt_area?.text || t.excerpt || '').slice(0, 200),
      url: t.url || `https://www.zhihu.com/question/${t.id}`,
      score: t.metrics_area?.text || '',
    };
  }).filter(x => x.title).slice(0, 25);
}

async function fetchToutiaoHot() {
  const r = await fetch('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', {
    headers: { 'User-Agent': UA },
  });
  if (!r.ok) throw new Error(`toutiao ${r.status}`);
  const data = await r.json();
  const items = data.data || [];
  return items.map(it => ({
    source: 'toutiao-hot',
    title: it.Title,
    url: it.Url,
    score: it.HotValue,
  })).filter(x => x.title).slice(0, 25);
}

async function fetchBaiduHot() {
  const r = await fetch('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone)',
      'Referer': 'https://top.baidu.com/',
    },
  });
  if (!r.ok) throw new Error(`baidu ${r.status}`);
  const data = await r.json();
  const cards = data.data?.cards || [];
  const items = [];
  for (const c of cards) {
    for (const sub of (c.content || [])) {
      const inner = sub.content || [sub];
      for (const it of inner) {
        if (it.word) items.push({
          source: 'baidu-hot',
          title: it.word,
          desc: (it.desc || '').slice(0, 200),
          url: it.url || '',
          score: it.hotScore,
        });
      }
    }
  }
  return items.slice(0, 25);
}

async function fetchSspai() {
  // sspai (生产力/工具向) RSS — they only support GET, no HEAD
  try {
    const feed = await fetchText('https://sspai.com/feed');
    const entries = [];
    const reItem = /<item[^>]*>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = reItem.exec(feed)) !== null && entries.length < 20) {
      const block = m[1];
      const titleMatch = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block);
      const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(block);
      const descMatch = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/.exec(block);
      if (!titleMatch) continue;
      const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
      const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      entries.push({ source: 'sspai', title, url: linkMatch?.[1]?.trim() || '', desc });
    }
    return entries;
  } catch (e) {
    console.error(`  [skip] sspai: ${e.message}`);
    return [];
  }
}

// ============================================================
// LLM evaluation
// ============================================================

const EVAL_PROMPT = `You are evaluating trending topics for a tutorial site called 1hour.guide.

The site teaches a complete skill in EXACTLY 60 minutes, with 5 timed steps and concrete output. Target audiences (in priority order):
  1. content creators / 自媒体 (Xiaohongshu, short video, newsletter)
  2. operators / 运营 (community, ads, growth)
  3. product managers / 产品 (PRD, prototyping, research)
  4. office workers / 职场新人 (Excel, PPT, Notion, reporting)
  5. side-hustlers / 副业 (Xianyu, digital products, paid newsletter)
  6. designers (Figma, AI image generation)
  7. non-coder developers (no-code, AI tools)

For each topic, score 1-10 on these dimensions:
  - learnable: can a beginner DO something concrete in 60 min? (not "understand X")
  - audience: how big and pay-willing is the audience?
  - structure: can it be split into 5 hands-on steps with checkpoints?
  - differentiation: do we add value vs official docs / existing content?
  - keyword_demand: estimated search volume / topic stickiness next 6 months

Output STRICT JSON array. For each topic include:
  {
    "title": <original title>,
    "scores": { "learnable": N, "audience": N, "structure": N, "differentiation": N, "keyword_demand": N },
    "total": <sum>,
    "verdict": "accept" | "reject",
    "reason": "<one sentence>",
    "proposed_slug": "<kebab-case>",
    "proposed_category": "ai-tools|creators|marketing|product|design|automation|office|side-hustle|code|mind",
    "proposed_topic": "<English topic for the LLM, includes specific deliverable>",
    "proposed_audience": "<中文画像>",
    "proposed_pain_point": "<中文痛点>",
    "proposed_tags": "<comma list>",
    "proposed_priority": "P0|P1|P2"
  }

verdict rule: accept ONLY when total >= 35 AND every score >= 6 AND audience >= 7.

Special handling for Chinese hot-search items (sources zhihu-hot / toutiao-hot / baidu-hot / sspai):
  - Most baidu/toutiao items are political/entertainment news → reject (audience score 1-2 for our purposes).
  - Zhihu hot items mentioning AI tools, productivity, side hustle, AI workflow, ChatGPT/Claude/etc. are GOLD because they show 中文 search demand → score audience and keyword_demand high.
  - sspai items skew to 生产力/工具/AI → usually fits well, but reject pure product reviews (e.g. "X 评测") that are not learnable.
  - When the source signal is a Chinese question/topic, propose a tutorial that ANSWERS the question with a hands-on workflow (not just translates the title).

If a candidate is "build with X new framework" or pure dev tooling, reject (audience too small).
If it's a generic "what is X" article instead of a 60-min hands-on skill, reject.
If it duplicates an existing tutorial slug, reject (we'll provide the list).
`;

async function evaluateBatch(candidates, existingSlugs) {
  const apiKey = process.env.OPENAI_API_KEY || '09cce955-ab3a-41d6-b209-de3fc697c658';
  const baseURL = process.env.OPENAI_BASE_URL || 'https://llm-gateway-prod-sgp.corp.kuaishou.com/llm-serve/v1';
  const model = process.env.OPENAI_MODEL || 'claude-sonnet-4';

  // Process in small batches to avoid huge JSON payloads (which the LLM
  // sometimes mangles).
  const BATCH = 8;
  const out = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    process.stderr.write(`  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(candidates.length / BATCH)}... `);
    try {
      const verdicts = await evaluateOneBatch(slice, existingSlugs, apiKey, baseURL, model);
      out.push(...verdicts);
      process.stderr.write(`${verdicts.length} ok\n`);
    } catch (e) {
      process.stderr.write(`FAIL: ${e.message}\n`);
    }
  }
  return out;
}

async function evaluateOneBatch(candidates, existingSlugs, apiKey, baseURL, model) {
  const userMsg = [
    `Existing tutorial slugs (do NOT propose duplicates):`,
    existingSlugs.join(', '),
    ``,
    `Candidates to evaluate. Each has an explicit "id" — INCLUDE that id in your output object so we can trace back to the original source.`,
    ...candidates.map((c, i) => `id=${c._idx ?? (i + 1)}  [${c.source}] ${c.title}${c.desc ? ' — ' + c.desc.replace(/<[^>]+>/g, '').slice(0, 200) : ''}`),
    ``,
    `For each candidate output a JSON object with all fields from the system prompt PLUS an "id" field that matches the candidate id. Use \\u escapes for any unusual characters in strings. No markdown fence, no preamble.`,
  ].join('\n');

  const r = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: EVAL_PROMPT },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.3,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`gateway ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || '';
  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    // try to recover: extract complete top-level array elements
    const objs = [];
    const re = /\{[\s\S]*?\}\s*(?=,|\])/g;
    let m;
    while ((m = re.exec(jsonText)) !== null) {
      try {
        objs.push(JSON.parse(m[0]));
      } catch {}
    }
    if (objs.length > 0) return objs;
    throw new Error(`parse: ${e.message}; raw: ${jsonText.slice(0, 300)}`);
  }
}

// ============================================================
// State + topics.yaml management
// ============================================================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { seen: {} };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seen: {} }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function loadTopics() {
  return yaml.parse(fs.readFileSync(TOPICS_FILE, 'utf8')) || { queue: [] };
}
function saveTopics(data) {
  // Preserve top-of-file comment by reading raw + replacing queue
  const raw = fs.readFileSync(TOPICS_FILE, 'utf8');
  const headerEnd = raw.indexOf('\nqueue:');
  if (headerEnd < 0) {
    fs.writeFileSync(TOPICS_FILE, yaml.stringify(data));
    return;
  }
  const header = raw.slice(0, headerEnd + 1);
  const body = yaml.stringify({ queue: data.queue });
  fs.writeFileSync(TOPICS_FILE, header + body);
}

function existingSlugs() {
  const slugs = new Set();
  // from topics.yaml queue
  const t = loadTopics();
  for (const q of (t.queue || [])) slugs.add(q.slug);
  // from already-published tutorials
  const tDir = path.join(CONTENT_DIR, 'tutorials');
  if (fs.existsSync(tDir)) {
    for (const d of fs.readdirSync(tDir)) {
      if (fs.statSync(path.join(tDir, d)).isDirectory()) slugs.add(d);
    }
  }
  return Array.from(slugs);
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('▶ fetching trending sources...');
  const all = [];
  const sources = [
    ['hn',           fetchHN],
    ['producthunt',  fetchProductHunt],
    ['github',       fetchGithubTrending],
    ['reddit',       fetchRedditList],
    ['indiehackers', fetchIndieHackers],
    ['zhihu',        fetchZhihuHot],
    ['toutiao',      fetchToutiaoHot],
    ['baidu',        fetchBaiduHot],
    ['sspai',        fetchSspai],
  ];
  for (const [name, fn] of sources) {
    try {
      const items = await fn();
      console.log(`  ${name}: ${items.length}`);
      all.push(...items);
    } catch (e) {
      console.error(`  ${name}: FAIL ${e.message}`);
    }
  }

  // dedupe by url
  const seen = new Set();
  const dedup = all.filter(x => {
    const k = (x.url || x.title || '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`▶ ${dedup.length} unique candidates`);

  // skip ones we've already evaluated this week
  const state = loadState();
  const fresh = dedup.filter(x => {
    const k = (x.url || x.title || '').toLowerCase();
    if (state.seen[k]) return false;
    return true;
  });
  console.log(`▶ ${fresh.length} new (after state filter)`);

  // pick top N (already roughly ranked by source order)
  const top = fresh.slice(0, TOP_N);
  if (top.length === 0) {
    console.log('▶ nothing new to evaluate');
    return;
  }

  if (NO_LLM) {
    console.log('\n=== Discovered (no LLM eval) ===');
    for (const t of top) console.log(`  [${t.source}] ${t.title}`);
    return;
  }

  console.log(`▶ evaluating ${top.length} with LLM...`);
  const slugs = existingSlugs();
  // Tag each candidate with index so the LLM verdict can be traced back.
  const indexed = top.map((c, i) => ({ ...c, _idx: i + 1 }));
  const results = await evaluateBatch(indexed, slugs);
  console.log(`  got ${results.length} verdicts`);

  // mark seen
  for (const c of top) {
    state.seen[(c.url || c.title || '').toLowerCase()] = new Date().toISOString().slice(0, 10);
  }

  // append accepted to topics.yaml
  const accepted = results.filter(r => r.verdict === 'accept');
  console.log(`\n=== Verdicts ===`);
  for (const r of results) {
    const mark = r.verdict === 'accept' ? '✅' : '❌';
    console.log(`  ${mark} ${r.total}  ${r.proposed_slug || r.title.slice(0, 40)}  — ${r.reason}`);
  }

  if (accepted.length === 0) {
    console.log('\n▶ no accepted candidates this round');
    if (!DRY_RUN) saveState(state);
    return;
  }

  if (DRY_RUN) {
    console.log(`\n[DRY_RUN] would append ${accepted.length} items`);
    return;
  }

  const topics = loadTopics();
  const existingSlugSet = new Set((topics.queue || []).map(q => q.slug));
  let added = 0;
  for (const a of accepted) {
    if (!a.proposed_slug || existingSlugSet.has(a.proposed_slug)) continue;
    if (slugs.includes(a.proposed_slug)) continue; // already published
    // Resolve the original source candidate by id (added by main()).
    const orig = a.id != null ? top[a.id - 1] : top.find(c => c.title === a.title);
    topics.queue.push({
      slug: a.proposed_slug,
      category: a.proposed_category,
      audience: a.proposed_audience,
      pain_point: a.proposed_pain_point,
      topic: a.proposed_topic,
      tags: a.proposed_tags,
      priority: a.proposed_priority || 'P2',
      status: 'pending',
      _scout: {
        source: orig?.source || 'unknown',
        original_title: orig?.title || '',
        original_url: orig?.url || '',
        added_at: new Date().toISOString().slice(0, 10),
        scores: a.scores,
        total: a.total,
      },
    });
    added++;
  }

  saveTopics(topics);
  saveState(state);
  console.log(`\n▶ appended ${added} new topics to topics.yaml`);
}

main().catch(e => { console.error(e); process.exit(1); });
