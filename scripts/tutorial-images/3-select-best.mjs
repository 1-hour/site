#!/usr/bin/env node
/**
 * Step 3: Auto-select the best candidate for each slot.
 *
 * Uses a heuristic scorer that rewards:
 *  - alt text with 2+ matched query terms
 *  - alt text length (more descriptive = higher confidence match)
 *  - de-dup across the same tutorial (don't pick the same photo twice)
 *
 * Output: output/selection.json = { slug: { hero: {src,alt}, steps: [...5] } }
 *
 * For a smoother human review step, print an HTML gallery at
 * output/selection.html that shows the picked image + rejected alternates.
 */

import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.join(import.meta.dirname, 'output');
const KEYWORDS = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'keywords.json'), 'utf8'));
const CANDIDATES = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'candidates.json'), 'utf8'));

function scoreCandidate(cand, queryWords, usedSrcs) {
  if (usedSrcs.has(cand.src)) return -100; // strong penalty against dup
  const alt = (cand.alt || '').toLowerCase();
  let score = 0;
  for (const w of queryWords) {
    if (alt.includes(w)) score += 10;
  }
  // Prefer longer, more descriptive alts
  score += Math.min(alt.length / 20, 5);
  // Penalize very short or empty alts
  if (alt.length < 10) score -= 3;
  return score;
}

function pickBest(query, candidates, usedSrcs) {
  if (!candidates || candidates.length === 0) return null;
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const scored = candidates.map(c => ({ ...c, _score: scoreCandidate(c, words, usedSrcs) }));
  scored.sort((a, b) => b._score - a._score);
  return scored[0];
}

function main() {
  const selection = {};

  for (const slug of Object.keys(CANDIDATES)) {
    const kw = KEYWORDS[slug];
    if (!kw) continue;
    const cands = CANDIDATES[slug];
    const usedSrcs = new Set();
    const entry = {};

    // Hero first. If hero candidates are empty, borrow from any step
    // that has candidates so at least we get a hero image.
    let heroCands = cands.hero;
    if (!heroCands || heroCands.length === 0) {
      for (let i = 0; i < 5; i++) {
        if (cands.steps?.[i]?.length > 0) {
          heroCands = cands.steps[i];
          break;
        }
      }
    }
    const hero = pickBest(kw.hero, heroCands, usedSrcs);
    if (hero) {
      entry.hero = { src: hero.src, alt: hero.alt, query: kw.hero };
      usedSrcs.add(hero.src);
    }

    entry.steps = [];
    for (let i = 0; i < 5; i++) {
      const q = kw.steps[i];
      const pick = pickBest(q, cands.steps?.[i], usedSrcs);
      if (pick) {
        entry.steps.push({ src: pick.src, alt: pick.alt, query: q });
        usedSrcs.add(pick.src);
      } else {
        entry.steps.push(null);
      }
    }

    selection[slug] = entry;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'selection.json'), JSON.stringify(selection, null, 2));
  console.log(`Wrote selection for ${Object.keys(selection).length} tutorials`);

  // Generate HTML preview
  let html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Tutorial Image Selection</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 1400px; margin: 20px auto; padding: 0 20px; background: #fafafa; }
  h2 { margin-top: 40px; padding-bottom: 8px; border-bottom: 2px solid #FF6B35; }
  .slug-block { background: white; padding: 16px 20px; border-radius: 12px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
  .images { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-top: 12px; }
  .img-slot { text-align: center; }
  .img-slot img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; border: 2px solid #FF6B35; }
  .img-slot .label { font-size: 11px; margin-top: 4px; color: #666; }
  .img-slot .alt { font-size: 10px; color: #999; margin-top: 2px; }
  .empty { background: #f0f0f0; aspect-ratio: 1; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #ccc; }
</style></head><body>
<h1>1hour.guide Tutorial Images — Auto Selection Preview</h1>
<p>${Object.keys(selection).length} tutorials × 6 images each. Auto-picked by heuristic scorer.</p>
`;

  for (const slug of Object.keys(selection).sort()) {
    const entry = selection[slug];
    html += `<div class="slug-block"><h2>${slug}</h2>`;
    html += `<div class="images">`;
    const slots = [
      { key: 'Hero', img: entry.hero },
      ...entry.steps.map((s, i) => ({ key: `Step ${i + 1}`, img: s })),
    ];
    for (const slot of slots) {
      if (slot.img) {
        html += `<div class="img-slot">
          <img src="${slot.img.src}?w=400&q=70" loading="lazy" />
          <div class="label"><strong>${slot.key}</strong></div>
          <div class="alt">${(slot.img.alt || '').slice(0, 60)}</div>
        </div>`;
      } else {
        html += `<div class="img-slot"><div class="empty">${slot.key}<br/>(no candidates)</div></div>`;
      }
    }
    html += `</div></div>`;
  }
  html += `</body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'selection.html'), html);
  console.log(`Preview: ${path.join(OUT_DIR, 'selection.html')}`);
}

main();
