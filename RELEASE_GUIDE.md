# 版本发布指南（GitHub Actions 自动出包）

## 推荐流程（默认）

使用 `release.sh` 创建版本并推送标签，随后由 GitHub Actions 自动构建并发布安装包。

```bash
./release.sh <版本号> "<发布说明>"
```

示例：

```bash
./release.sh 1.2.0 "优化会话容错、心跳状态可视化、发布链路稳定性"
```

脚本会自动完成：

1. 更新 `package.json` 版本号
2. 提交当前改动
3. 创建 tag（例如 `v1.2.0`）
4. 推送分支与标签到 GitHub
5. 触发 `.github/workflows/build-release.yml` 自动出包

## 自动构建产物

Workflow 会构建并上传：

- macOS arm64 `.dmg`
- macOS x64 `.dmg`
- Windows x64 `.exe`

构建完成后会自动创建/更新对应 GitHub Release。

## 手动触发 Workflow

当你不想创建 tag，也可以在 GitHub Actions 页面手动触发 `Build and Release`，并填写 `version`。

## 本地打包（调试用途）

优先使用：

```bash
npm run dist:mac:dir
```

正式本地打包：

```bash
npm run dist:mac
```

说明：构建配置已默认 `npmRebuild=false`，用于避免本地路径含空格时 `node-gyp` 重编译失败。

## 常见问题

### 1) 标签已存在

请提升版本号后重试，例如 `1.2.0 -> 1.2.1`。

### 2) Workflow 失败

优先检查：

- `package.json` 版本是否与 tag 一致
- GitHub Actions 日志中的具体失败步骤
- 依赖安装是否成功（`npm ci`）

### 3) macOS 提示“已损坏”

首次安装可执行：

```bash
xattr -dr com.apple.quarantine /Applications/ShaoTerm.app
```
