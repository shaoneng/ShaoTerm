# 版本发布指南

## 快速发布

使用自动化脚本一键发布新版本:

```bash
./release.sh <版本号> "<发布说明>"
```

### 示例

```bash
# 发布 1.2.0 版本
./release.sh 1.2.0 "新功能: 添加了主题切换动画"

# 发布 1.2.1 版本(bug 修复)
./release.sh 1.2.1 "修复: 解决了窗口拖动问题"
```

## 脚本功能

`release.sh` 脚本会自动完成以下步骤:

1. ✅ 更新 `package.json` 中的版本号
2. ✅ 提交所有代码变更到 Git
3. ✅ 创建版本标签 (如 `v1.2.0`)
4. ✅ 推送代码和标签到 GitHub
5. ✅ 构建 macOS 安装包
6. ✅ 创建 GitHub Release
7. ✅ 上传安装包到 Release
8. ✅ 生成 Release 链接

## 发布流程

### 1. 准备工作

确保:
- 所有代码变更已完成
- 已测试新功能
- 已更新 README (如需要)

### 2. 运行发布脚本

```bash
./release.sh 1.2.0 "新功能:
- 添加了主题切换动画
- 优化了性能
- 修复了已知 bug"
```

### 3. 确认发布

脚本会显示版本号和发布说明,输入 `y` 确认发布。

### 4. 等待完成

脚本会自动完成所有步骤,最后显示 Release 链接。

## 版本号规范

遵循 [语义化版本](https://semver.org/lang/zh-CN/):

- **主版本号** (1.x.x): 重大变更,可能不兼容
- **次版本号** (x.1.x): 新功能,向后兼容
- **修订号** (x.x.1): bug 修复,向后兼容

### 示例

- `1.0.0` → `1.1.0`: 添加新功能
- `1.1.0` → `1.1.1`: 修复 bug
- `1.1.1` → `2.0.0`: 重大更新

## 手动发布 (不推荐)

如果需要手动发布,按以下步骤:

```bash
# 1. 更新版本号
# 编辑 package.json 中的 "version" 字段

# 2. 提交变更
git add .
git commit -m "Release v1.2.0"

# 3. 创建标签
git tag -a v1.2.0 -m "Version 1.2.0"

# 4. 推送到 GitHub
git push origin main
git push origin v1.2.0

# 5. 构建安装包
npm run dist

# 6. 创建 GitHub Release
gh release create v1.2.0 \
  --title "v1.2.0" \
  --notes "发布说明..." \
  dist/ShaoTerm-1.2.0-arm64.dmg
```

## 故障排除

### 问题: 脚本执行失败

**解决方案:**
```bash
# 确保脚本有执行权限
chmod +x release.sh

# 检查 Git 状态
git status

# 检查 GitHub CLI 是否已登录
gh auth status
```

### 问题: 构建失败

**解决方案:**
```bash
# 重新安装依赖
npm install

# 清理并重新构建
rm -rf dist/
npm run dist
```

### 问题: 推送失败

**解决方案:**
```bash
# 检查远程仓库
git remote -v

# 拉取最新代码
git pull origin main

# 重新推送
git push origin main
```

## 注意事项

1. **版本号不能重复**: 每次发布必须使用新的版本号
2. **标签不能重复**: 如果标签已存在,需要先删除旧标签
3. **构建时间**: macOS 安装包构建需要 1-2 分钟
4. **网络连接**: 推送和创建 Release 需要稳定的网络连接

## 回滚版本

如果需要回滚到之前的版本:

```bash
# 删除远程标签
git push origin --delete v1.2.0

# 删除本地标签
git tag -d v1.2.0

# 删除 GitHub Release
gh release delete v1.2.0

# 回退提交
git reset --hard HEAD~1
git push origin main --force
```

⚠️ **警告**: 回滚操作会影响已发布的版本,请谨慎使用。
