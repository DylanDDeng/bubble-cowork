# Aegis

Aegis Desktop Application（Electron + Vite + React）。

## 项目简介

Aegis 是一个桌面端的多会话 AI 助手应用，围绕本地项目目录进行任务协作与信息整理。它支持会话管理、工具调用可视化、以及对工作目录内文件的浏览与预览，帮助你把“对话 → 结果文件 → 预览与操作”串成一个可追踪的工作流。

## 主要功能

- 多会话管理：新建任务、历史列表、搜索、置顶、按时间/文件夹视图与状态筛选
- 多提供商切换：内置 Claude / Codex（可在会话中切换）
- 项目目录联动：选择工作目录、文件树浏览、打开/定位到文件
- Artifacts 预览：从 Write/Edit 工具调用自动提取并预览 HTML/Markdown/JSON/图片/PDF
- 附件支持：上传文件/图片作为上下文

## 技术栈

- Electron（桌面应用）
- Vite + React（前端）
- Tailwind CSS
- TypeScript

## 快速开始

```bash
npm install
npm run dev
```

> `npm run dev` 会同时启动前端与 Electron。



## 项目结构

```
.
├── src/            # 前端与 Electron 主进程代码
├── dist-react/     # 前端构建产物
├── dist-electron/  # Electron 构建产物
├── release/        # 打包输出目录
└── scripts/        # 开发脚本
```

## 常用命令

- `npm run dev`：开发模式
- `npm run build`：构建
- `npm run dist`：打包发布

---
