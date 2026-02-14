<div align="center">
  <img src="icon.png" alt="ShaoTerm Icon" width="128" height="128">
  <h1>ShaoTerm</h1>
  <p>多标签终端管理器，面向 Codex/Claude 等 AI CLI，支持 AI 智能标签命名。</p>
</div>

ShaoTerm 让你同时运行多个 AI 编码会话（默认 Codex），并通过 AI 自动识别每个对话的主题来命名标签页。

## 功能特性

- **多标签终端** — 同时运行多个终端会话
- **AI CLI 集成** — 一键在指定目录启动 AI 会话（默认 `codex`，可切换 `claude` 或自定义命令）
- **智能标签命名** — 使用 `Cmd+R` 可自动用 3-5 个字总结每个标签的对话内容
- **普通终端** — 也支持打开纯终端标签页
- **确认弹窗** — 关闭标签页等关键操作会先提示确认
- **运行中确认提醒** — 会话输出中出现需要确认的提示时自动通知（不阻塞）
- **会话心跳总结** — 会话期间默认每 10 分钟自动汇总并分析最新内容（支持 5/10/15/30 分钟）；心跳结果默认静默归档，确认类提示才会通知
- **心跳状态点** — 每个标签显示心跳状态（进行中/待输入/阶段完成/异常），悬停可查看最近一次总结
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

- **默认 AI 命令**：例如 `codex -m gpt-5.2-codex`、`claude`
- **Base URL**：
  - OpenAI 直连：`https://api.openai.com`
  - VibeProxy 本地代理：`http://localhost:8317`
- **API Key**：
  - OpenAI 模式填写 API Key
  - VibeProxy 模式可留空（使用本地 OAuth 凭证）

之后也可以通过标签栏右侧的"设置"按钮修改。

> 标签命名与心跳汇总默认走 ChatGPT（OpenAI-compatible Chat Completions）。当 Base URL 指向本地代理（如 VibeProxy）时，会优先通过该代理执行；失败时自动回退到本地规则摘要。

### 3. 使用

- 点击 **`AI+`** — 新建 AI 会话（会弹出 Finder 选择工作目录）
- 点击 **`+`** — 新建普通终端
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
- 可选：OpenAI API Key（OpenAI 直连模式）
- 若使用 VibeProxy：需先完成 VibeProxy 的 Codex OAuth 登录

## 技术栈

基于 Electron、xterm.js、node-pty 构建。
