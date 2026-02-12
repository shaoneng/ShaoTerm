#!/bin/bash

# ShaoTerm Release Script
# 自动化版本发布流程

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== ShaoTerm Release Script ===${NC}\n"

# Check if version argument is provided
if [ -z "$1" ]; then
    echo -e "${RED}错误: 请提供版本号${NC}"
    echo "用法: ./release.sh <version> [release-notes]"
    echo "示例: ./release.sh 1.2.0 \"新功能: 添加了XXX\""
    exit 1
fi

VERSION=$1
RELEASE_NOTES=${2:-"Version $VERSION"}

echo -e "${YELLOW}版本号:${NC} $VERSION"
echo -e "${YELLOW}发布说明:${NC} $RELEASE_NOTES"
echo ""

# Confirm with user
read -p "确认发布版本 v$VERSION? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 1
fi

# Step 1: Update version in package.json
echo -e "\n${GREEN}[1/7] 更新 package.json 版本号...${NC}"
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json
echo "✓ 版本号已更新为 $VERSION"

# Step 2: Commit changes
echo -e "\n${GREEN}[2/7] 提交代码变更...${NC}"
git add .
git commit -m "Release v$VERSION

$RELEASE_NOTES

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>" || echo "没有需要提交的变更"
echo "✓ 代码已提交"

# Step 3: Create git tag
echo -e "\n${GREEN}[3/7] 创建 Git 标签...${NC}"
git tag -a "v$VERSION" -m "Version $VERSION"
echo "✓ 标签 v$VERSION 已创建"

# Step 4: Push to GitHub
echo -e "\n${GREEN}[4/7] 推送到 GitHub...${NC}"
git push origin main
git push origin "v$VERSION"
echo "✓ 已推送到 GitHub"

# Step 5: Build installers
echo -e "\n${GREEN}[5/7] 构建安装包...${NC}"
echo "正在构建 macOS 安装包..."
npm run dist
echo "✓ macOS 安装包构建完成"

# Step 6: Create GitHub Release
echo -e "\n${GREEN}[6/7] 创建 GitHub Release...${NC}"
RELEASE_BODY="## 版本 $VERSION

$RELEASE_NOTES

## 下载

- macOS (Apple Silicon): ShaoTerm-$VERSION-arm64.dmg

---
🤖 由 [Claude Code](https://claude.com/claude-code) 自动发布"

gh release create "v$VERSION" \
  --title "v$VERSION" \
  --notes "$RELEASE_BODY" \
  "dist/ShaoTerm-$VERSION-arm64.dmg"

echo "✓ GitHub Release 已创建"

# Step 7: Get release URL
echo -e "\n${GREEN}[7/7] 获取 Release 链接...${NC}"
RELEASE_URL="https://github.com/shaoneng/ShaoTerm/releases/tag/v$VERSION"
echo -e "✓ Release URL: ${GREEN}$RELEASE_URL${NC}"

echo -e "\n${GREEN}=== 发布完成! ===${NC}"
echo -e "版本 ${GREEN}v$VERSION${NC} 已成功发布到 GitHub"
echo -e "访问: ${GREEN}$RELEASE_URL${NC}"
