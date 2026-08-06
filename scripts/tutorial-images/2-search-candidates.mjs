#!/usr/bin/env node
/**
 * Step 2: Batch-search Unsplash for candidate images.
 *
 * Reads output/keywords.json → for each { slug, hero, steps[5] } issues
 * 6 searches against Unsplash, keeps top-3 image URLs per query.
 *
 * Output: output/candidates.json with shape
 *   { slug: { hero: [{src,alt}...], steps: [[{src,alt}...] * 5] } }
 *
 * Rate-limiting: 1.2s between searches (~4 min total for 210 queries).
 *
 * Uses OpenClaw's already-running Chrome over CDP (port 18800).
 */

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const OUT_DIR = path.join(import.meta.dirname, 'output');
const KEYWORDS = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'keywords.json'), 'utf8'));

const CDP_HTTP = 'http://127.0.0.1:18800';
const CANDIDATES_PER_QUERY = 4;   // top-4 (we'll pick 1 later)
const DELAY_MS = 1500;
const SEARCH_TIMEOUT_MS = 12000;

// Resume support: if output/candidates.json exists, skip slugs already done.
const OUT_FILE = path.join(OUT_DIR, 'candidates.json');
const existing = fs.existsSync(OUT_FILE)
  ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'))
  : {};

async function newTab(url) {
  const r = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error(`newTab ${r.status}`);
  return await r.json();
}
async function closeTab(id) {
  await fetch(`${CDP_HTTP}/json/close/${id}`).catch(() => {});
}

// Connect to a page's WebSocket and evaluate JS after network idle.
async function evalOnPage(target, expression, timeoutMs = SEARCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 });
    let msgId = 0;
    const pending = new Map();

    function send(method, params = {}) {
      msgId += 1;
      const id = msgId;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timeout'));
    }, timeoutMs);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });

    ws.on('open', async () => {
      try {
        await send('Page.enable');
        await send('Runtime.enable');
        // Wait for network idle-ish: poll 2500ms then evaluate
        await new Promise(r => setTimeout(r, 2500));
        const { result } = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        clearTimeout(timer);
        ws.close();
        resolve(result.value);
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const EXTRACT_JS = `
(() => {
  const imgs = document.querySelectorAll('img');
  const out = [];
  const seen = new Set();
  imgs.forEach(img => {
    const src = (img.src || '').split('?')[0];
    if (!src.includes('images.unsplash.com/photo-') || src.includes('profile')) return;
    if (seen.has(src)) return;
    seen.add(src);
    out.push({ src, alt: img.alt || '' });
  });
  return out.slice(0, ${CANDIDATES_PER_QUERY});
})()
`;

async function searchOne(query) {
  const url = `https://unsplash.com/s/photos/${encodeURIComponent(query.replace(/\s+/g, '-'))}`;
  const tab = await newTab(url);
  try {
    const results = await evalOnPage(tab, EXTRACT_JS);
    return Array.isArray(results) ? results : [];
  } finally {
    await closeTab(tab.id);
  }
}

async function processSlug(slug, kw) {
  const result = existing[slug] || {};

  if (!result.hero || result.hero.length === 0) {
    process.stdout.write(`  hero "${kw.hero}"... `);
    try {
      result.hero = await searchOne(kw.hero);
      console.log(`${result.hero.length} imgs`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      result.hero = [];
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  result.steps = result.steps || [];
  for (let i = 0; i < 5; i++) {
    if (result.steps[i] && result.steps[i].length > 0) continue;
    const q = kw.steps[i];
    process.stdout.write(`  step${i+1} "${q}"... `);
    try {
      result.steps[i] = await searchOne(q);
      console.log(`${result.steps[i].length} imgs`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      result.steps[i] = [];
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  return result;
}

async function main() {
  const slugs = Object.keys(KEYWORDS);
  console.log(`Processing ${slugs.length} tutorials × 6 queries = ${slugs.length * 6} searches`);
  console.log(`Estimated time: ~${Math.round(slugs.length * 6 * (DELAY_MS + 3500) / 60000)} min\n`);

  const all = { ...existing };
  let done = 0;

  for (const slug of slugs) {
    done += 1;
    console.log(`\n[${done}/${slugs.length}] ${slug}`);
    try {
      all[slug] = await processSlug(slug, KEYWORDS[slug]);
      // Save after every slug so we can resume.
      fs.writeFileSync(OUT_FILE, JSON.stringify(all, null, 2));
    } catch (e) {
      console.error(`  slug failed: ${e.message}`);
    }
  }

  console.log(`\nDone. Saved to ${OUT_FILE}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
