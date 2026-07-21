#!/bin/bash
# Build script for Cloudflare Workers Builds (Static Assets)
#
# 此脚本由 CF Workers Builds 在 git push 时自动调用，
# 也可本地用 deploy.sh 调用。
#
# 流程：
#   1) 初始化 submodules（framework + content）
#   2) pnpm install + next build
#   3) 复制 framework/out 到 ./out
#   4) 移除 _redirects（CF Pages 残留，Workers 不支持 status 404）

set -euo pipefail

echo "==> Ensuring submodules are initialized..."
git submodule update --init --recursive

# Sanitize MDX before build (defense-in-depth: avoid CF build failure on
# common LLM output issues like ASCII " in <Answer>...</Answer> or "<" in
# paragraphs).
if command -v python3 >/dev/null 2>&1 && [ -d content/tutorials ]; then
  python3 - <<'PY'
import re, pathlib
root = pathlib.Path("content")
for f in sorted(root.glob("tutorials/*/*.mdx")):
    s = f.read_text(encoding="utf-8")
    o = s
    s = re.sub(r"(<Answer>)(.*?)(</Answer>)",
               lambda m: m.group(1) + m.group(2).replace("`","").replace('"',"") + m.group(3),
               s, flags=re.DOTALL)
    s = s.replace('"<"', "left-arrow symbol").replace('">"', "right-arrow symbol")
    if s != o:
        f.write_text(s, encoding="utf-8")
        print(f"sanitized: {f}")
PY
fi

# Generate per-tutorial OG images. Skipped on Cloudflare Builds (no Chrome
# binary available there); regenerated locally before publish and committed
# to framework/public/og/ so they ship as static assets.
if [ -z "${CF_PAGES:-}${CI_NO_OG_GEN:-}" ] && command -v node >/dev/null 2>&1 && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  echo "==> Generating OG images..."
  (cd scripts/og-gen && [ -d node_modules ] || npm install --silent)
  node scripts/og-gen/generate.js || echo "WARN: og-gen failed, continuing build"
else
  echo "==> Skipping OG image generation (no local Chrome / CI env)"
fi

echo "==> Checking pnpm..."
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found, installing..."
  npm install -g pnpm@10
fi
pnpm --version

echo "==> Installing framework dependencies..."
cd framework
# Remove lockfile if it's corrupted/empty
if [ ! -s pnpm-lock.yaml ] 2>/dev/null; then
  rm -f pnpm-lock.yaml
fi
pnpm install --prefer-offline

echo "==> Building static site..."
CONTENT_DIR=../content pnpm build

echo "==> Moving output to root..."
cd ..
rm -rf out
cp -r framework/out ./out

# _redirects handling
#
# History: An earlier version of _redirects used the CF Pages
# `not_found_handling` 404 pattern (not supported by Workers Static Assets),
# so this script deleted the file to avoid a deploy failure.
#
# 2026-07-21: Workers Static Assets now supports _redirects for real
# HTTP redirect rules (see
# https://developers.cloudflare.com/workers/static-assets/redirects/).
# framework/public/_redirects now contains `/ /en/ 302` to fix the
# soft-404-at-root SEO issue. Keep the file.
#
# If a future _redirects grows a 404 rule again, prefer wrangler.jsonc
# `not_found_handling` instead of deleting the whole file.

echo "==> Build complete! Output in ./out"
ls out/ | head -10
