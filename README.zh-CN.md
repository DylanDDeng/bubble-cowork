<p align="center">
  <img src="build/icon.png" alt="Aegis logo" width="96" height="96" />
</p>

<h1 align="center">Aegis</h1>

<p align="center">
  一个围绕本地项目目录展开的桌面 AI 工作台，可统一承载 Claude、Codex、MCP 工具与项目文件工作流。
</p>

<p align="center">
  <a href="./README.md">English</a> | 简体中文
</p>

## Aegis 能做什么

Aegis 的目标不是只提供一个聊天窗口，而是把“对话、工具调用、项目文件、生成结果”放进同一个桌面工作流里：

- 围绕真实项目目录创建和管理多个 AI 工作会话
- 在同一个界面里切换 Claude Code 与 Codex
- 接入 MiniMax、智谱、Moonshot、DeepSeek 等 Anthropic-compatible provider
- 在正常提示词之外使用 MCP Server 和 Claude Skills
- 浏览项目文件、预览输出结果、查看生成 artifacts，而不用来回切换工具
- 通过会话分组、文件树和状态面板持续保留项目上下文

## 核心能力

### 多会话 AI 工作台
- 为不同任务或项目创建独立会话
- 支持搜索、置顶、恢复和按项目目录分组
- 在同一上下文中查看 thinking、工具执行痕迹和中间结果

### 项目目录优先的工作方式
- 每个会话都可以绑定工作目录
- 右侧文件面板可直接浏览项目文件
- 支持预览 HTML、Markdown、PDF、图片、PPTX 等常见输出

### Claude 与兼容 Provider 路由
- 可直接使用 Claude Code
- 可通过兼容 Provider 路由 Claude 风格请求
- 可在 Settings 中配置模型、访问模式和运行时状态

### Skills、MCP 与扩展能力
- 自动发现用户级与项目级 Claude Skills
- 在应用内浏览并安装 marketplace skills
- 支持全局或项目级 MCP Server 配置

### 桌面端体验优化
- 支持主题、深浅模式与字体设置
- 支持应用内更新检查，并跳转 GitHub Releases 手动下载
- Claude 会话输入栏支持上下文占用指示器

## 适合的使用场景

- 一边让 AI 协助分析仓库，一边保留文件和输出可见
- 基于项目上下文直接生成 PPTX、PDF、DOCX 等交付物
- 借助 Claude Skills 和 MCP 工具运行固定工作流
- 在同一个桌面应用里比较不同模型和不同 provider 的行为

## 技术栈

- Electron
- React
- Vite
- TypeScript
- Tailwind CSS
- better-sqlite3

## 快速开始

```bash
npm install
npm run dev
```

如果要打正式包：

```bash
npm run dist
```

## 项目结构

```text
.
├── src/            # Electron 主进程与 React 前端
├── dist-react/     # 前端构建产物
├── dist-electron/  # Electron 构建产物
├── release/        # 打包输出目录
└── build/          # 图标与打包资源
```

## 说明

- Aegis 当前采用 GitHub Releases 手动下载安装更新
- 当前发布流程主要产出 macOS 构建，Windows 打包取决于可用的构建环境
