#!/bin/bash

# ShaoTerm Release Script (GitHub Actions first)
# 只负责: 版本号、提交、打 tag、推送。构建与 Release 上传由 GitHub Actions 自动完成。

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -z "${1:-}" ]; then
  echo -e "${RED}错误: 请提供版本号${NC}"
  echo "用法: ./release.sh <version> [release-notes]"
  echo "示例: ./release.sh 1.2.0 \"优化心跳状态展示\""
  exit 1
fi

VERSION="$1"
RELEASE_NOTES="${2:-Release v$VERSION}"
TAG="v$VERSION"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REPO_URL="$(git remote get-url origin 2>/dev/null || true)"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo -e "${RED}错误: 版本号需符合语义化格式，例如 1.2.3${NC}"
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo -e "${RED}错误: 标签 $TAG 已存在，请使用新的版本号${NC}"
  exit 1
fi

echo -e "${GREEN}=== ShaoTerm Release (Actions) ===${NC}"
echo -e "${YELLOW}分支:${NC} $BRANCH"
echo -e "${YELLOW}版本:${NC} $VERSION"
echo -e "${YELLOW}说明:${NC} $RELEASE_NOTES"
echo ""

read -p "确认创建并推送标签 $TAG ? (y/n) " -n 1 -r
echo
if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
  echo "已取消"
  exit 1
fi

echo -e "\n${GREEN}[1/5] 更新 package.json 版本号...${NC}"
node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=process.argv[1];fs.writeFileSync(p,JSON.stringify(j,null,2)+'\\n');" "$VERSION"
echo "✓ package.json 已更新为 $VERSION"

echo -e "\n${GREEN}[2/5] 提交变更...${NC}"
git add -A
git commit -m "Release $TAG" -m "$RELEASE_NOTES" || echo "没有新增改动，继续执行打标签流程"
echo "✓ 提交完成"

echo -e "\n${GREEN}[3/5] 创建标签...${NC}"
git tag -a "$TAG" -m "Release $TAG"
echo "✓ 标签 $TAG 已创建"

echo -e "\n${GREEN}[4/5] 推送代码和标签...${NC}"
git push origin "$BRANCH"
git push origin "$TAG"
echo "✓ 推送完成"

echo -e "\n${GREEN}[5/5] 触发 GitHub Actions 自动出包...${NC}"

if [[ "$REPO_URL" == git@github.com:* ]]; then
  REPO_PATH="${REPO_URL#git@github.com:}"
  REPO_PATH="${REPO_PATH%.git}"
elif [[ "$REPO_URL" == https://github.com/* ]]; then
  REPO_PATH="${REPO_URL#https://github.com/}"
  REPO_PATH="${REPO_PATH%.git}"
else
  REPO_PATH="shaoneng/ShaoTerm"
fi

ACTIONS_URL="https://github.com/${REPO_PATH}/actions/workflows/build-release.yml"
RELEASES_URL="https://github.com/${REPO_PATH}/releases"

echo "Actions: $ACTIONS_URL"
echo "Releases: $RELEASES_URL"
echo -e "\n${GREEN}发布流程已启动，安装包将由 GitHub Actions 自动构建并上传到 Release。${NC}"
