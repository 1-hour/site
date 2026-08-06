# tutorial-images

Half-automated pipeline for adding real photography to 1hour.guide tutorials.

## Pipeline

```
content/tutorials/<slug>/{meta.yaml, en.mdx}
        │
        ▼   1-generate-keywords.mjs
output/keywords.json     (hero + 5 step queries per slug)
        │
        ▼   2-search-candidates.mjs  (browser-driven Unsplash search)
output/candidates.json   (top-4 image candidates per query)
        │
        ▼   3-select-best.mjs        (heuristic scorer)
output/selection.json    (1 chosen image per slot)
output/selection.html    (visual QA gallery)
        │
        ▼   4-download-and-inject.mjs
framework/public/tutorials/<slug>/*.jpg
content/tutorials/<slug>/{en,zh}.mdx  (imgs injected at H2s)
```

## Run

```bash
node 1-generate-keywords.mjs           # instant, no network
node 2-search-candidates.mjs           # ~17 min, needs Chrome on CDP :18800
node 3-select-best.mjs                 # instant
node 4-download-and-inject.mjs         # ~2 min, idempotent
```

All four steps are resumable / idempotent.

## Coverage

First run (2026-08-07): 191/210 slots filled (91%).
Remaining 19 slots (typically step-3 with narrow queries) fall through
gracefully — the MDX injector skips them silently.

## Notes

- Unsplash blocks direct HTTP scraping (Anubis anti-bot). Must use a real
  browser session via CDP; OpenClaw's Chrome on `:18800` works.
- Images are stored in the **framework** repo (not content) because they're
  static assets, referenced from MDX via `/tutorials/<slug>/<name>.jpg`.
- Attribution line added once per MDX (idempotent check on marker string).
- To re-run with better keywords for a specific slug: delete that slug's
  entry from `output/candidates.json` and re-run step 2 (it will
  incrementally re-search only missing entries).

## Cost / Time

- Zero API cost (uses your existing Chrome + Unsplash CDN hotlink for search
  then downloads to self-host).
- ~17 min per full run (rate-limited to 1.5s between searches).
- ~48MB of images per 33 tutorials.
