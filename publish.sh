#!/usr/bin/env bash
# 1hour.guide 一键发布：把新教程从 content repo 推到线上
#
# 用法：
#   ./publish.sh                          # 提交 content 中所有未提交变更，然后 bump site
#   ./publish.sh "feat: add X tutorial"   # 自定义 commit message
#
# 流程：
#   1) 在 content repo 提交所有变更（含未跟踪的 tutorials/<slug>/）
#   2) git push origin main
#   3) 在 site repo bump submodule pointer
#   4) git push origin main → 触发 CF Workers Builds 自动部署

set -euo pipefail

SITE_DIR="/Users/zoe/projects/labs.zoe.im/1hour-guide"
CONTENT_DIR="/Users/zoe/projects/labs.zoe.im/1hour-guide-content"

MSG="${1:-}"

cd "$CONTENT_DIR"

# 1) 提交 content 变更
if [ -z "$(git status --porcelain)" ]; then
  echo "▶ content 仓库无变更，跳过 content commit"
else
  # 自动提取新增的 tutorial slug 作为默认 commit message
  if [ -z "$MSG" ]; then
    NEW_SLUGS=$(git status --porcelain | awk '$1=="??" && /^\?\? tutorials\// {sub("tutorials/","",$2); sub("/.*","",$2); print $2}' | sort -u | paste -sd "," -)
    if [ -n "$NEW_SLUGS" ]; then
      MSG="feat: add tutorials ($NEW_SLUGS)"
    else
      MSG="chore: update content"
    fi
  fi

  echo "▶ [content] commit: $MSG"
  git add -A
  git commit -m "$MSG"
  git push origin main
fi

CONTENT_HEAD=$(git rev-parse --short HEAD)

# 2) bump site submodule
cd "$SITE_DIR/content"
git fetch origin main
git checkout main
git pull --ff-only origin main

cd "$SITE_DIR"

# 2b) regenerate OG images for any new/changed tutorials and commit them
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && command -v node >/dev/null 2>&1; then
  echo "▶ [site] generating OG images..."
  (cd scripts/og-gen && [ -d node_modules ] || npm install --silent)
  node scripts/og-gen/generate.js || echo "WARN: og-gen failed, continuing"
  if ! git diff --quiet -- framework/public/og 2>/dev/null; then
    git add framework/public/og
    git commit -m "chore: regenerate og images" || true
  fi
fi

if git diff --quiet HEAD -- content framework/public/og 2>/dev/null; then
  echo "▶ site 仓库无变更，跳过"
else
  if ! git diff --cached --quiet 2>/dev/null; then
    : # already committed in step 2b
  fi
  if ! git diff --quiet -- content; then
    echo "▶ [site] bump content -> $CONTENT_HEAD"
    git add content
    git commit -m "chore: bump content -> $CONTENT_HEAD"
  fi
  git push origin main
fi

echo
echo "✅ 已推送，CF Workers Builds 将自动部署（通常 1-2 分钟）"
echo "   主站: https://1hour.guide/"
echo "   监控: gh api repos/1-hour/site/commits/main/check-runs | jq '.check_runs[]'"
