#!/usr/bin/env bash
# 1hour.guide 一键发布脚本
#
# 用法：
#   ./deploy.sh                  # 拉新内容、构建、部署
#   ./deploy.sh --skip-pull      # 不拉远端 content
#   ./deploy.sh --skip-build     # 直接 deploy 现有 out/（适合内容没变只想重发）
#   ./deploy.sh --dry-run        # 仅构建，不 deploy
#
# 前置：wrangler 已登录正确的 CF 账号（jsz3@live.com / Zoe 个人开发者账户）
#
# 部署目标：
#   Cloudflare Worker (Static Assets)
#   - name: 1hour-guide-website
#   - 绑定: 1hour.guide
#   - account: 2621ae8a1333cd2b4bf0dfc5e0127ded

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

SKIP_PULL=false
SKIP_BUILD=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --skip-pull)  SKIP_PULL=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --dry-run)    DRY_RUN=true ;;
    -h|--help)
      head -15 "$0" | tail -13 | sed 's/^# //'
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

echo "▶ ROOT=$ROOT_DIR"
echo "▶ skip-pull=$SKIP_PULL  skip-build=$SKIP_BUILD  dry-run=$DRY_RUN"

# 1) 同步 content submodule（除非跳过）
if [ "$SKIP_PULL" = false ]; then
  echo
  echo "==> [1/4] 同步 content submodule"
  cd content
  git pull --ff-only origin main
  cd ..

  # 如有变更，提交 submodule pointer
  if ! git diff --quiet --cached -- content || ! git diff --quiet -- content; then
    git add content
    git commit -m "chore: bump content $(cd content && git log -1 --format=%h)" || true
  fi
fi

# 2) 构建静态站点
if [ "$SKIP_BUILD" = false ]; then
  echo
  echo "==> [2/4] 构建 framework"
  cd framework
  if [ ! -d node_modules/fuse.js ]; then
    pnpm install --prefer-offline
  fi
  CONTENT_DIR=../content pnpm build
  cd ..

  # 复制 out
  echo
  echo "==> [3/4] 整理 out/"
  rm -rf out
  cp -r framework/out ./out
  # 2026-07-21: Cloudflare Workers Static Assets now supports _redirects
  # (https://developers.cloudflare.com/workers/static-assets/redirects/).
  # framework/public/_redirects handles the root URL 302 → /en/ for SEO.
  # Keep the file, don't delete it.
  ls out/ | head -8
fi

# 3) 推送 Worker
if [ "$DRY_RUN" = true ]; then
  echo
  echo "==> [DRY-RUN] 跳过 wrangler deploy"
  echo "    out/ 已就绪，可手动检查"
  exit 0
fi

echo
echo "==> [4/4] wrangler deploy"
if [ ! -f wrangler.jsonc ]; then
  echo "❌ wrangler.jsonc 不存在，无法部署"
  exit 1
fi
wrangler deploy

echo
echo "✅ 部署完成"
echo "   主站  : https://1hour.guide/"
echo "   预览  : https://1hour-guide-website.wuma.workers.dev/"
echo "   sitemap: https://1hour.guide/sitemap.xml"
