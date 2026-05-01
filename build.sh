#!/bin/bash
# Build script for Cloudflare Pages
set -euo pipefail

echo "==> Ensuring submodules are initialized..."
git submodule update --init --recursive

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
pnpm install --frozen-lockfile --prefer-offline

echo "==> Building static site..."
CONTENT_DIR=../content pnpm build

echo "==> Moving output to root..."
cd ..
rm -rf out
cp -r framework/out ./out

echo "==> Build complete! Output in ./out"
ls out/ | head -10
