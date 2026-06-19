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

# CF Pages 用 _redirects 做 404 fallback，但 Workers Static Assets 不支持
# status 404，会导致 deploy 失败。删掉它，由 wrangler.jsonc 的
# `not_found_handling: "404-page"` 接管。
if [ -f out/_redirects ]; then
  echo "==> Removing _redirects (Workers Static Assets uses not_found_handling instead)..."
  rm -f out/_redirects
fi

echo "==> Build complete! Output in ./out"
ls out/ | head -10
