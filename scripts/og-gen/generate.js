#!/usr/bin/env node
// og-gen: generate per-tutorial OG images
//
// usage:
//   node generate.js                    # 全部生成（增量：skip 已存在）
//   node generate.js --force             # 强制重生
//   node generate.js --slug figma-basics # 仅生成单个

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import matter from 'gray-matter';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTENT_DIR = path.join(ROOT, '..', '1hour-guide-content');
const OUT_DIR = path.join(ROOT, 'framework', 'public', 'og');
const TPL = fs.readFileSync(path.join(import.meta.dirname, 'template.html'), 'utf8');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const SLUG_FILTER = (() => {
  const i = args.indexOf('--slug');
  return i >= 0 ? args[i + 1] : null;
})();

// labels per locale
const LABELS = {
  en: { brand: '1 Hour Guide', duration: (m) => `${m} minutes` },
  zh: { brand: '一小时指南', duration: (m) => `${m} 分钟` },
};

const CATEGORY_LABEL = {
  en: { ai: 'AI', code: 'Code', web: 'Web', design: 'Design', business: 'Business', mind: 'Mind' },
  zh: { ai: '人工智能', code: '编程', web: 'Web', design: '设计', business: '商业', mind: '心智' },
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function render(data) {
  return TPL
    .replace('__LOCALE__', data.locale)
    .replace('__BRAND__', escapeHtml(data.brand))
    .replace('__CATEGORY__', escapeHtml(data.category))
    .replace('__DURATION_LABEL__', escapeHtml(data.durationLabel))
    .replace('__TITLE__', escapeHtml(data.title))
    .replace('__DESCRIPTION__', escapeHtml(data.description))
    .replace('__TAGS__', escapeHtml(data.tags));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // discover tutorials
  const tutorialsDir = path.join(CONTENT_DIR, 'tutorials');
  const slugs = fs.readdirSync(tutorialsDir).filter(s =>
    fs.statSync(path.join(tutorialsDir, s)).isDirectory()
  ).filter(s => !SLUG_FILTER || s === SLUG_FILTER);

  if (slugs.length === 0) {
    console.error('no tutorials found');
    process.exit(1);
  }

  // launch
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
    defaultViewport: { width: 1200, height: 630, deviceScaleFactor: 1 },
  });

  let generated = 0, skipped = 0, failed = 0;

  try {
    for (const slug of slugs) {
      const dir = path.join(tutorialsDir, slug);
      let meta = {};
      try {
        meta = yaml.parse(fs.readFileSync(path.join(dir, 'meta.yaml'), 'utf8')) || {};
      } catch (e) {
        console.error(`[skip] ${slug}: invalid meta.yaml: ${e.message}`);
        failed++; continue;
      }
      const category = meta.category || 'other';
      const duration = meta.duration || 60;
      const tags = (meta.tags || []).slice(0, 4).join(' • ');

      for (const locale of ['en', 'zh']) {
        const mdxPath = path.join(dir, `${locale}.mdx`);
        if (!fs.existsSync(mdxPath)) continue;

        const outPath = path.join(OUT_DIR, `${slug}-${locale}.png`);
        if (!FORCE && fs.existsSync(outPath)) { skipped++; continue; }

        const fm = matter(fs.readFileSync(mdxPath, 'utf8')).data || {};
        const title = fm.title || slug;
        const description = fm.description || '';
        const labels = LABELS[locale];
        const catLabel = (CATEGORY_LABEL[locale] && CATEGORY_LABEL[locale][category]) || category;

        const html = render({
          locale,
          brand: labels.brand,
          category: catLabel,
          durationLabel: labels.duration(duration),
          title,
          description,
          tags,
        });

        const page = await browser.newPage();
        try {
          await page.setContent(html, { waitUntil: 'networkidle0' });
          await page.screenshot({ path: outPath, type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
          console.log(`✓ ${slug}-${locale}.png`);
          generated++;
        } catch (e) {
          console.error(`✗ ${slug}-${locale}: ${e.message}`);
          failed++;
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${generated} generated, ${skipped} skipped, ${failed} failed → ${OUT_DIR}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
