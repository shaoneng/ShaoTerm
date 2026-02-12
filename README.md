<div align="center">
  <img src="icon.png" alt="ShaoTerm Icon" width="128" height="128">
  <h1>ShaoTerm</h1>
  <p>多标签终端管理器，面向 Codex/Claude 等 AI CLI，支持 AI 智能标签命名。</p>
</div>

ShaoTerm 让你同时运行多个 AI 编码会话（默认 Codex），并通过 AI 自动识别每个对话的主题来命名标签页。

## 功能特性

- **多标签终端** — 同时运行多个终端会话
- **AI CLI 集成** — 一键在指定目录启动 AI 会话（默认 `codex`，可切换 `claude` 或自定义命令）
- **智能标签命名** — 点击"刷新主题"，AI 自动用 3-5 个字总结每个标签的对话内容
- **普通终端** — 也支持打开纯终端标签页
- **确认弹窗** — 关闭标签页等关键操作会先提示确认
- **日间/夜间模式** — 一键切换主题
- **快捷键** — Cmd+T、Cmd+W、Cmd+1-9、Cmd+R
- **手动重命名** — 双击标签名即可修改

## 下载

| 平台 | 下载 |
|------|------|
| macOS (Apple Silicon / M系列芯片) | [ShaoTerm-arm64.dmg](https://github.com/shaoneng/ShaoTerm/releases/latest) |
| macOS (Intel) | [ShaoTerm-x64.dmg](https://github.com/shaoneng/ShaoTerm/releases/latest) |
| Windows | [ShaoTerm-Setup.exe](https://github.com/shaoneng/ShaoTerm/releases/latest) |

## 使用说明

### 1. 安装

- **macOS**：打开 `.dmg` 文件，将 ShaoTerm 拖入"应用程序"文件夹。首次打开时，右键点击应用选择"打开"（未签名应用需要此操作）。
- **Windows**：运行 `.exe` 安装程序。

如果 macOS 提示“已损坏，无法打开”，执行：

```bash
xattr -dr com.apple.quarantine /Applications/ShaoTerm.app
```

### 2. 配置 API（用于智能标签命名）

首次启动时会弹出设置窗口，请填写：

- **默认 AI 命令**：例如 `codex`、`claude`
- **Base URL**：你的 Claude API 地址（例如 `https://api.anthropic.com`）
- **API Key**：你的 API 密钥

之后也可以通过工具栏的"设置"按钮修改。

> API 仅用于标签自动命名功能（使用 claude-3-5-haiku 模型）。每次命名约花费 $0.001。终端会话本身使用你本地的 CLI（如 `codex`/`claude`），与该 API 无关。

### 3. 使用

- 点击 **`AI+`** — 新建 AI 会话（会弹出 Finder 选择工作目录）
- 点击 **`+`** — 新建普通终端
- 点击 **刷新主题** — AI 自动识别并重命名所有标签
- **双击标签名** — 手动重命名

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd+T` | 新建 AI 标签页（默认 Codex） |
| `Cmd+W` | 关闭当前标签页 |
| `Cmd+R` | 刷新所有标签主题 |
| `Cmd+1-9` | 切换到指定标签页 |

## 系统要求

- **macOS** 10.13+ 或 **Windows** 10+
- 已安装 [Codex CLI](https://github.com/openai/codex) 或 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- Anthropic API Key（用于智能标签命名功能）

## 技术栈

基于 Electron、xterm.js、node-pty 构建。
