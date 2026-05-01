#!/bin/bash
# Build script for Cloudflare Pages
# Cloudflare Pages will clone this repo with submodules, then run this script.

set -euo pipefail

echo "==> Ensuring submodules are initialized..."
git submodule update --init --recursive

echo "==> Installing pnpm..."
npm install -g pnpm@10

echo "==> Installing framework dependencies..."
cd framework
pnpm install --frozen-lockfile

echo "==> Building static site..."
CONTENT_DIR=../content pnpm build

echo "==> Moving output to root..."
cd ..
rm -rf out
cp -r framework/out ./out

echo "==> Build complete! Output in ./out"
ls -la out/ | head -10
