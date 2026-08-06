#!/usr/bin/env node
/**
 * Step 4: Download selected images + inject them into each tutorial's MDX.
 *
 * Reads output/selection.json → downloads each image to
 *   framework/public/tutorials/<slug>/hero.jpg
 *   framework/public/tutorials/<slug>/step-1.jpg ... step-5.jpg
 * Then inserts an ![alt](path) line right after each H2 header in
 * both zh.mdx and en.mdx (idempotent — skips if the image line already
 * exists in the file).
 *
 * Skips desk-repair-video since it already has images.
 *
 * Also appends an Unsplash attribution line to each tutorial (once).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT_DIR = path.join(import.meta.dirname, 'output');
const CONTENT_DIR = path.join(ROOT, 'content');
const ASSETS_DIR = path.join(ROOT, 'framework/public/tutorials');

const SELECTION = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'selection.json'), 'utf8'));
const SKIP_SLUGS = new Set(['desk-repair-video']); // already has images

const IMAGE_WIDTH = 1600;
const IMAGE_Q = 85;

async function downloadImage(url, dest) {
  if (fs.existsSync(dest)) return 'exists';
  const fullUrl = `${url}?w=${IMAGE_WIDTH}&q=${IMAGE_Q}&auto=format&fit=crop`;
  const r = await fetch(fullUrl);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  return 'downloaded';
}

// Common "skip" H2 headings (in both en and zh) — we don't want to
// insert step images at these sections.
const SKIP_H2_PATTERNS = [
  /🎯/,       // Outcome
  /⏱/,       // Time Blocks
  /📋/,       // Prerequisites
  /🎁/,       // Bonus
  /📚/,       // Next Steps
  /🔗/,       // Resources
  /^#+\s*outcome/i,
  /^#+\s*prerequisites/i,
  /^#+\s*time blocks/i,
  /^#+\s*next steps/i,
  /^#+\s*resources/i,
  /^#+\s*bonus/i,
  /^#+\s*🎉/,
];

function isSkipH2(line) {
  return SKIP_H2_PATTERNS.some(p => p.test(line));
}

function injectImages(mdxContent, slug, images, locale) {
  const lines = mdxContent.split('\n');
  const out = [];
  let seenStepCount = 0;
  let heroInserted = false;
  let frontmatterClosed = false;
  let frontmatterOpenCount = 0;

  const relPathHero = `/tutorials/${slug}/hero.jpg`;
  const attributionMarker = 'Photos on [Unsplash]';

  // Check idempotency: is this file already injected?
  const alreadyDone = mdxContent.includes(`/tutorials/${slug}/hero.jpg`) ||
                      mdxContent.includes(`/tutorials/${slug}/step-1.jpg`);
  if (alreadyDone) {
    return { content: mdxContent, changed: false, reason: 'already injected' };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);

    // Detect frontmatter close (second --- line)
    if (line.trim() === '---') {
      frontmatterOpenCount += 1;
      if (frontmatterOpenCount === 2) frontmatterClosed = true;
      continue;
    }

    // Hero: right after frontmatter, before any content. Find the first
    // blank line after frontmatter close.
    if (frontmatterClosed && !heroInserted && line.trim() === '' && images.hero) {
      out.push(`![${escapeAlt(images.hero.alt)}](${relPathHero})`);
      out.push('');
      heroInserted = true;
      continue;
    }

    // Step images: right after step H2 (## Step N: ... / ## 第 N 步...).
    // Match numbered step headers (English or Chinese).
    if (/^##\s+(Step\s+\d+|第\s*\d+\s*步)/i.test(line) && !isSkipH2(line)) {
      const stepIdx = seenStepCount;
      const stepImg = images.steps?.[stepIdx];
      if (stepImg && stepIdx < 5) {
        const relPath = `/tutorials/${slug}/step-${stepIdx + 1}.jpg`;
        // Insert blank + img + blank after the H2
        out.push('');
        out.push(`![${escapeAlt(stepImg.alt)}](${relPath})`);
      }
      seenStepCount += 1;
    }
  }

  let final = out.join('\n');

  // Append attribution once, right before end of file.
  if (!final.includes(attributionMarker)) {
    const attribution = locale === 'zh'
      ? '\n---\n\n_教程配图由 [Unsplash](https://unsplash.com) 摄影师提供，遵循 Unsplash License。_\n'
      : '\n---\n\n_Photos on [Unsplash](https://unsplash.com), used under the Unsplash License._\n';
    final = final.trimEnd() + '\n' + attribution;
  }

  return { content: final, changed: true };
}

function escapeAlt(s) {
  return String(s || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
}

async function processSlug(slug) {
  if (SKIP_SLUGS.has(slug)) {
    console.log(`  skip: ${slug} (in skip list)`);
    return;
  }
  const entry = SELECTION[slug];
  if (!entry?.hero || !entry.steps) {
    console.log(`  skip: ${slug} (no selection data)`);
    return;
  }

  const dir = path.join(ASSETS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });

  // Download hero
  console.log(`  ${slug} — downloading:`);
  try {
    const status = await downloadImage(entry.hero.src, path.join(dir, 'hero.jpg'));
    console.log(`    hero.jpg (${status})`);
  } catch (e) {
    console.log(`    hero.jpg FAILED: ${e.message}`);
  }

  // Download steps
  for (let i = 0; i < 5; i++) {
    const step = entry.steps[i];
    if (!step) continue;
    try {
      const status = await downloadImage(step.src, path.join(dir, `step-${i + 1}.jpg`));
      console.log(`    step-${i + 1}.jpg (${status})`);
    } catch (e) {
      console.log(`    step-${i + 1}.jpg FAILED: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // Inject into MDX
  const images = { hero: entry.hero, steps: entry.steps };
  for (const locale of ['zh', 'en']) {
    const mdxPath = path.join(CONTENT_DIR, 'tutorials', slug, `${locale}.mdx`);
    if (!fs.existsSync(mdxPath)) continue;
    const original = fs.readFileSync(mdxPath, 'utf8');
    const { content, changed, reason } = injectImages(original, slug, images, locale);
    if (changed) {
      fs.writeFileSync(mdxPath, content);
      console.log(`    ${locale}.mdx (injected)`);
    } else {
      console.log(`    ${locale}.mdx (${reason || 'no change'})`);
    }
  }
}

async function main() {
  const slugs = Object.keys(SELECTION);
  console.log(`Processing ${slugs.length} tutorials (skipping ${[...SKIP_SLUGS].join(',')})`);

  for (const slug of slugs) {
    await processSlug(slug);
  }

  console.log('\nDone.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
