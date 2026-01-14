# Claude Cowork 需求文档（含实现说明）

版本：v0.0.1（对应 `package.json`）  
最后更新：2026-01-13  
文档目的：以“需求/功能点”为主线，逐项对照当前代码实现（Electron + React）说明实现方式、数据流与关键边界。

---

## 1. 项目概述

### 1.1 背景
Claude Code 能力强，但主要在终端运行；本项目提供桌面端 GUI，使多会话管理、实时输出、工具调用可视化与交互更易用。

### 1.2 目标
- 以桌面应用方式运行“Claude Code/Agent 能力”（通过 `@anthropic-ai/claude-agent-sdk`）。
- 复用 Claude Code 的本地配置：自动读取 `~/.claude/settings.json`（主要是 `env`）。
- 提供会话生命周期管理：新建、继续、停止、删除、历史回放。
- 提供流式输出展示：逐步渲染模型输出、工具调用与工具结果。
- 提供交互式问答（AskUserQuestion）：在 GUI 内完成多选/单选/自定义输入并回传给 Agent。

### 1.3 非目标（当前代码未实现或未覆盖）
以下在 README 中可能被提及，但当前代码**未完整落地**（见“已知限制/改进建议”）：
- 按工具粒度的“敏感工具强制审批/白名单”（当前仅对 `AskUserQuestion` 做 UI 交互）。
- GUI 内展示系统资源统计（主进程有统计推送，但 UI 未消费）。

---

## 2. 用户与使用场景

### 2.1 目标用户
- 开发者/运维/数据分析等需要在本机执行“读写文件、运行命令、整理项目”的用户。
- 习惯 Claude Code 工作流、但希望获得更好的可视化与多会话管理体验的用户。

### 2.2 典型场景
- 在不同项目目录下创建多个任务会话，随时切换查看历史与输出。
- 观察模型“Thinking/Assistant”内容与工具链执行过程（Bash/Read/Edit 等）的结果。
- 当 Agent 需要用户选择（AskUserQuestion）时，在 GUI 里完成选择并继续执行。

---

## 3. 技术框架与依赖

### 3.1 技术栈（对照 `package.json`）
- 桌面框架：Electron 39（主进程 + 渲染进程）
- 前端框架：React 19
- 构建与开发：Vite（React 插件、`@tailwindcss/vite`、`vite-tsconfig-paths`）
- 样式：Tailwind CSS 4（`src/ui/index.css` 自定义主题变量）
- 状态管理：Zustand（`src/ui/store/useAppStore.ts`）
- 数据库：better-sqlite3（WAL 模式，`src/electron/libs/session-store.ts`）
- Agent/AI：`@anthropic-ai/claude-agent-sdk`（`query`、`unstable_v2_prompt`）
- Markdown 渲染：`react-markdown` + `remark-gfm` + `rehype-raw` + `rehype-highlight`
- 组件：Radix UI（Dialog / DropdownMenu）

### 3.2 目录结构（关键）
- `src/electron/*`：Electron 主进程/预加载脚本/IPC/数据库/Runner
- `src/ui/*`：React 渲染进程 UI
- `types.d.ts`：Preload 暴露 API 与 IPC payload 的全局类型
- `electron-builder.json`：打包配置（输出 `dist-react`、`dist-electron`）

---

## 4. 总体架构与数据流

### 4.1 进程分层
- **Main（Electron 主进程）**：创建窗口、管理 SQLite、运行 Agent（SDK query）、统一广播事件给 UI。
- **Preload（预加载脚本）**：使用 `contextBridge` 将安全的 IPC API 暴露给 `window.electron`。
- **Renderer（React 渲染进程）**：订阅主进程事件并渲染 UI；通过 `sendClientEvent` 发起会话操作。

### 4.2 关键数据流（事件驱动）

```text
Renderer(UI)                Preload                    Main(Electron)
   | onServerEvent()          |                          |
   |------------------------->| ipcRenderer.on(...)      |
   |                          |<-------------------------| webContents.send("server-event")
   | sendClientEvent(ev)      |                          |
   |------------------------->| ipcRenderer.send(...)    |
   |                          |------------------------->| ipcMain.on("client-event")
   |                          |                          | handleClientEvent(ev)
   |                          |                          |  - SessionStore(SQLite)
   |                          |                          |  - runClaude(query)
   |                          |                          |  - emit(ServerEvent)
```

### 4.3 事件协议（核心）
事件在 `src/electron/types.ts` 与 `src/ui/types.ts` 中定义，结构一致：
- Client -> Server：`session.start / session.continue / session.stop / session.delete / session.list / session.history / permission.response`
- Server -> Client：`stream.message / stream.user_prompt / session.status / session.list / session.history / session.deleted / permission.request / runner.error`

---

## 5. 数据设计（SQLite）

### 5.1 数据库位置
主进程中：`src/electron/ipc-handlers.ts`  
使用 `join(app.getPath("userData"), "sessions.db")`，各系统的 `userData` 路径由 Electron 决定。

### 5.2 表结构（见 `src/electron/libs/session-store.ts`）
#### sessions
- `id`：本应用会话 ID（UUID）
- `title`：会话标题（由 LLM 生成或默认）
- `claude_session_id`：SDK 返回的可 resume 的 session id
- `status`：`idle | running | completed | error`
- `cwd`：会话工作目录
- `allowed_tools`：允许工具集合（当前存储但未用于限制）
- `last_prompt`：最近一次用户输入
- `created_at / updated_at`

#### messages
- `id`：消息 id（优先取 SDK message 的 `uuid`；否则随机 UUID）
- `session_id`：关联会话
- `data`：消息 JSON（存 `StreamMessage`）
- `created_at`

### 5.3 WAL 模式
`initialize()` 中执行 `pragma journal_mode = WAL;`，提升并发读写表现并降低 UI 卡顿风险。

---

## 6. 功能需求与实现细节（逐项对照代码）

> 说明方式：每个功能点按“需求/交互 → 数据/状态 → 关键实现文件与逻辑 → 异常与边界”描述。

### 6.1 应用启动与窗口
**需求**
- 启动桌面窗口，加载 React UI；开发态从 Vite server 加载，生产态加载打包产物。

**实现**
- `src/electron/main.ts`：`app.on("ready")` 创建 `BrowserWindow`
  - `webPreferences.preload = getPreloadPath()` 注入预加载脚本
  - `titleBarStyle: "hiddenInset"`、`trafficLightPosition` 等用于 macOS 风格
  - `isDev()` 时 `loadURL("http://localhost:10087")`，否则 `loadFile(getUIPath())`

**边界**
- 开发态端口固定写死为 `10087`（`src/electron/main.ts`），而 Vite 端口来自 `vite.config.ts` 的 `env.PORT`：两者需一致。

### 6.2 Preload API（Renderer 可调用的能力）
**需求**
- 渲染进程不能直接访问 Node/Electron 敏感 API，通过白名单方式暴露能力：
  - 订阅主进程推送事件
  - 发起会话/权限响应
  - 获取最近目录、选择目录
  - 生成会话标题

**实现**
- `src/electron/preload.cts`：
  - `window.electron.onServerEvent(cb)`：监听 `"server-event"` 并 JSON.parse
  - `window.electron.sendClientEvent(event)`：`ipcRenderer.send("client-event", event)`
  - `generateSessionTitle/getRecentCwds/selectDirectory`：`ipcRenderer.invoke(...)`
  - `subscribeStatistics/getStaticData`：预留的系统监控接口（UI 当前未使用）

### 6.3 会话列表（Session List）与默认选中
**需求**
- UI 打开后自动加载历史会话列表。
- 若存在会话，默认选中“最新更新时间”的会话；若没有会话，自动弹出新建会话弹窗。

**实现**
- `src/ui/hooks/useIPC.ts`：挂载时调用 `window.electron.onServerEvent` 订阅事件并设置 `connected = true`。
- `src/ui/App.tsx`：`connected` 之后发送 `{ type: "session.list" }`。
- `src/electron/ipc-handlers.ts`：收到 `session.list`，从 `SessionStore.listSessions()` 查询并广播 `session.list`。
- `src/ui/store/useAppStore.ts`：
  - 处理 `session.list`：生成 `sessions` 字典、设置 `showStartModal`、计算默认 active session。

### 6.4 会话历史回放（Hydration）
**需求**
- 切换到某个会话时，若本地尚未加载该会话的 messages，则请求历史并回放。

**实现**
- `src/ui/store/useAppStore.ts`：每个 `SessionView` 有 `hydrated` 标记。
- `src/ui/App.tsx`：
  - 当 `activeSessionId` 变化且 session 未 hydrated 时，发送 `session.history`。
  - 使用 `historyRequested: Set<string>` 防止重复请求。
- `src/electron/ipc-handlers.ts`：
  - 查询 `SessionStore.getSessionHistory(sessionId)`，返回 sessions 行 + messages 表（按创建时间升序）。

**边界**
- 历史 messages 直接回放存储的 `StreamMessage`（包含 SDK 的 `stream_event` 等），UI 对不可渲染类型会忽略（`MessageCard` 未处理会返回 `null`）。

### 6.5 新建会话（Start Session）
**需求**
- 用户设置工作目录（cwd）和初始 prompt，点击 Start Session 创建新会话并开始运行 Agent。
- 自动生成一个可识别主题的标题。

**实现**
- UI 入口：
  - `src/ui/components/StartSessionModal.tsx`：收集 `cwd`、`prompt`；支持 “Browse...” 选择目录与“Recent”快速选择。
  - `src/ui/components/PromptInput.tsx`：当没有 `activeSessionId` 时也会走 `session.start`。
- 标题生成：
  - `src/ui/components/PromptInput.tsx`：`window.electron.generateSessionTitle(prompt)`
  - `src/electron/libs/util.ts`：`generateSessionTitle()` 调用 `unstable_v2_prompt` 生成标题
  - `src/electron/libs/claude-settings.ts`：启动时从 `~/.claude/settings.json` 的 `env` 注入到 `process.env`（如 `ANTHROPIC_MODEL` 等），用于 SDK 调用
- 会话创建与运行：
  - `src/electron/ipc-handlers.ts`：
    - `sessions.createSession({ cwd, title, allowedTools, prompt })` 写入 SQLite
    - 立即更新状态为 `running` 并广播 `session.status`
    - 广播 `stream.user_prompt`（UI 以“User”消息展示）
    - 调用 `runClaude({ prompt, session, resumeSessionId: session.claudeSessionId, ... })`

**状态**
- `pendingStart`（UI）用于在标题生成期间禁用按钮/避免重复触发；首次收到 `session.status` 后切换到该会话并关闭弹窗。

**边界**
- StartSessionModal 强制要求 `cwd` 与 `prompt` 非空；而 PromptInput 的新建逻辑允许 `cwd` 为空（此时 Runner 使用 `process.cwd()` 作为默认目录）。

### 6.6 继续会话（Continue Session）
**需求**
- 在已存在会话内输入新 prompt，继续同一个 Claude session（支持 resume）。

**实现**
- `src/ui/components/PromptInput.tsx`：存在 `activeSessionId` 时发送 `session.continue`。
- `src/electron/ipc-handlers.ts`：
  - 校验 session 存在，且必须有 `session.claudeSessionId` 才能 resume；否则发 `runner.error`。
  - 更新状态 `running`，广播 `stream.user_prompt`，调用 `runClaude({ resumeSessionId: session.claudeSessionId, ... })`。

### 6.7 停止会话（Stop / Abort）
**需求**
- 当会话正在运行时允许用户强制停止。

**实现**
- UI：`src/ui/components/PromptInput.tsx`
  - 运行中按钮变为 Stop；按 Enter（不带 Shift）也会 stop。
- 主进程：`src/electron/ipc-handlers.ts`
  - 从 `runnerHandles` 取到 `RunnerHandle.abort()`，触发 `AbortController.abort()`。
  - 将 session 状态更新为 `idle` 并广播 `session.status`。

### 6.8 删除会话（Delete）
**需求**
- 删除会话及其历史消息；如果会话正在运行，应先停止再删除。

**实现**
- UI：`src/ui/components/Sidebar.tsx` 的菜单项触发 `session.delete`。
- 主进程：`src/electron/ipc-handlers.ts`
  - 若正在运行则先 `abort()` 并从 `runnerHandles` 移除
  - `sessions.deleteSession(sessionId)` 删除 sessions/messages 表记录
  - 广播 `session.deleted`

### 6.9 工作目录选择与最近目录
**需求**
- 允许用户从系统文件选择器中选择工作目录。
- 允许快速选择最近使用的工作目录列表。

**实现**
- `src/electron/main.ts`：
  - `ipcMainHandle("select-directory")`：`dialog.showOpenDialog({ properties: ["openDirectory"] })`
  - `ipcMainHandle("get-recent-cwds")`：`sessions.listRecentCwds(limit)`（limit 做 1~20 的边界收敛）
- `src/ui/components/StartSessionModal.tsx`：
  - `window.electron.getRecentCwds()` 拉取列表并渲染成按钮
  - `Browse...` 调用 `window.electron.selectDirectory()`

### 6.10 流式输出（Partial Streaming + 最终消息）
**需求**
- 在 Agent 输出未完成时，界面能逐步显示输出内容，并提供“加载骨架”提示。

**实现**
- 主进程 Runner：
  - `src/electron/libs/runner.ts`：
    - `query({ prompt, options: { includePartialMessages: true, ... } })`
    - `for await (const message of q)` 持续推送 `stream.message`
- UI 聚合 partial：
  - `src/ui/App.tsx`：
    - 监听 `stream.message`，仅处理 `message.type === "stream_event"` 的 `content_block_start/delta/stop`
    - 将 delta 内容累计到 `partialMessageRef.current` 并渲染 `MDContent`
    - `showPartialMessage` 为 `true` 时展示 shimmer loading

**边界**
- `stream_event` 消息也会被追加到会话 messages 数组中（但 `MessageCard` 不渲染该类型），因此“历史回放”时不会复现 partial 的逐字过程。

### 6.11 Markdown 渲染与高亮
**需求**
- Assistant 输出支持 Markdown，代码块高亮，兼容 GFM。

**实现**
- `src/ui/render/markdown.tsx`
  - `react-markdown` + `remark-gfm`
  - `rehype-raw` 允许渲染 HTML（注意安全边界：应确保输入可信或做消毒）
  - `rehype-highlight` 进行代码高亮
  - 对 heading、p、ul、pre、code 等元素做 Tailwind 样式封装

### 6.12 工具调用可视化（Tool Use / Tool Result）
**需求**
- 将 SDK 的 tool_use/tool_result 以卡片形式展示，并标记 pending/success/error 状态。
- tool_result 文本过长时折叠显示，支持展开/收起。

**实现**
- `src/ui/components/EventCard.tsx`
  - `ToolUseCard`：
    - 对 `tool_use` 内容展示工具名与关键摘要（如 `Bash.command`、`Read.file_path`）
    - 使用 `toolStatusMap` 在 tool_use 出现时置 `pending`，等待 tool_result 更新
  - `ToolResult`：
    - 对 `tool_result` 判断 `is_error` 并设置 status（success/error）
    - 默认最多显示 3 行（`MAX_VISIBLE_LINES`），超过可展开
    - 将 tool_use_id 对应状态写入 `toolStatusMap`，驱动 ToolUseCard 小圆点状态

### 6.13 展示 System Init 与 Session Result
**需求**
- 显示 SDK init 信息（session id、模型、权限模式、cwd）。
- 会话结束时展示统计信息（耗时、token 用量、花费）。

**实现**
- `src/ui/components/EventCard.tsx`
  - `SystemInfoCard`：渲染 `message.type === "system" && message.subtype === "init"`
  - `SessionResult`：渲染 `message.type === "result" && subtype === "success"` 的用量与耗时信息

### 6.14 交互式问答/权限（AskUserQuestion）
**需求**
- 当 Agent 发起 AskUserQuestion（单选/多选/文本输入）时，UI 弹出可交互面板收集答案，回传并继续执行。

**实现**
- 主进程拦截：
  - `src/electron/libs/runner.ts`：
    - 在 `canUseTool(toolName, input, { signal })` 中，仅对 `toolName === "AskUserQuestion"` 走“等待用户响应”
    - 生成 `toolUseId = crypto.randomUUID()`，发出 `permission.request`
    - 将 Promise resolver 存入 `session.pendingPermissions`（Map），等待 UI 回传 `permission.response`
- UI 展示与回传：
  - `src/ui/store/useAppStore.ts`：收到 `permission.request` 放入 `SessionView.permissionRequests`
  - `src/ui/components/EventCard.tsx`：当渲染到对应 `AskUserQuestion` 的 tool_use 时，显示 `DecisionPanel`
  - `src/ui/components/DecisionPanel.tsx`：
    - 支持单选/多选选项，支持“Other”自由输入
    - 组装 `answers` 写入 `updatedInput`，调用 `onSubmit({ behavior: "allow", updatedInput })`
  - `src/ui/App.tsx`：`handlePermissionResult` 发送 `permission.response` 并在 store 中移除该 request
- 主进程完成：
  - `src/electron/ipc-handlers.ts`：收到 `permission.response`，查找 `pendingPermissions.get(toolUseId)` 并 `resolve(result)`

**边界**
- 当前 Runner 对除 AskUserQuestion 外的工具均自动 allow（见“已知限制/改进建议”）。

### 6.15 全局错误提示（Toast）
**需求**
- 当出现不可恢复错误（如会话不存在、无法 resume、标题生成失败）时提示用户。

**实现**
- `src/electron/ipc-handlers.ts`：通过 `runner.error` 或 `session.status(error)` 广播错误信息。
- `src/ui/store/useAppStore.ts`：处理 `runner.error` 设置 `globalError`。
- `src/ui/App.tsx`：底部显示可关闭提示条。

### 6.16 “在 Claude Code 中继续”（Resume 命令复制）
**需求**
- 在侧边栏可生成 `claude --resume <session_id>` 命令并复制。

**实现**
- `src/ui/components/Sidebar.tsx`：
  - 打开 Dialog，展示命令并支持复制到剪贴板。

**注意**
- 当前 UI 使用的是 `SessionView.id`（应用内 session id），而不是 `claudeSessionId`。若希望与 Claude Code 真正 resume 同一 SDK session，需在 `session.list` 中同步并显示 `claudeSessionId`（见“已知限制/改进建议”）。

### 6.17 系统资源统计（预留能力）
**需求（可选）**
- 展示 CPU / RAM / 磁盘使用率与机器信息。

**实现（主进程已具备）**
- `src/electron/test.ts`：
  - `pollResources(mainWindow)`：每 500ms 计算并通过 `statistics` IPC 推送
  - `getStaticData()`：CPU 型号、内存、磁盘总量
- `src/electron/main.ts`：启动时调用 `pollResources(mainWindow)` 并注册 `getStaticData` handler
- `types.d.ts`：定义 `statistics/getStaticData` 的 payload

**现状**
- UI 未消费 `statistics/getStaticData`（`src/ui` 中没有对应订阅/渲染）。

---

## 7. Agent/SDK 集成与兼容 Claude Code

### 7.1 复用 `~/.claude/settings.json`
**目的**
- 与 Claude Code 使用同一份环境配置（token/baseURL/model 等）。

**实现**
- `src/electron/libs/claude-settings.ts`
  - 读取 `~/.claude/settings.json`（JSON）
  - 若存在 `env` 字段，则把其中键值写入 `process.env`（仅当当前环境未设置该变量）
  - 提供 `claudeCodeEnv`（当前仅用于标题生成时读取 `ANTHROPIC_MODEL`）

### 7.2 Runner 执行策略
- `src/electron/libs/runner.ts`
  - 调用 `query()` 并将 `env: { ...process.env }` 传入，确保 SDK 读取到 Claude Code 配置
  - `cwd`：优先用会话设置的 `session.cwd`，否则回退 `process.cwd()`
  - `resume`：继续会话时传 `session.claudeSessionId`
  - `abortController`：支持 stop
  - `includePartialMessages: true`：支持 partial streaming
  - `canUseTool`：目前仅对 `AskUserQuestion` 做“等待 UI 回应”

---

## 8. 安全与权限设计（当前实现）

### 8.1 渲染进程隔离（Preload 白名单）
- UI 不直接调用主进程 API，通过 `window.electron` 暴露的有限方法与事件订阅。

### 8.2 IPC Frame 校验（typesafe handler）
- `src/electron/util.ts`：
  - `ipcMainHandle()` 在 handler 执行前对 `event.senderFrame` 做校验
  - 生产态要求 frame.url 必须是 `file://.../dist-react/index.html`
  - 开发态允许 `localhost:10087`

### 8.3 CSP（开发入口 HTML）
- `index.html` 设置了基础 CSP（`default-src 'self'` 等）。

### 8.4 AskUserQuestion 的“权限/交互”落点
- 当前把“用户确认/输入”的需求收敛到 `AskUserQuestion` 这一工具上，通过 UI 完成交互并将答案回传给 SDK。

---

## 9. 构建、运行与发布

### 9.1 开发模式
`package.json` scripts：
- `bun run dev`：同时启动 Vite 与 Electron（并尝试 `pkill` 清理旧进程）
- `bun run dev:react`：Vite dev server
- `bun run dev:electron`：先 `transpile:electron` 再启动 Electron

注意：
- `vite.config.ts` 需要 `PORT` 环境变量（小写 `PORT`）才能确定 dev server 端口；与主进程写死端口 `10087` 保持一致，否则会无法加载 UI。

### 9.2 构建与打包
- `bun run build`：TypeScript build + Vite build（产物 `dist-react`）
- `bun run transpile:electron`：编译 `src/electron/tsconfig.json` 到 `dist-electron`
- `electron-builder.json`：
  - 打包包含 `dist-electron` 与 `dist-react`
  - `extraResources` 携带 `dist-electron/preload.cjs`
  - 多平台 target：mac(dmg)、win(portable/msi)、linux(AppImage)

---

## 10. 已知限制与改进建议（基于当前代码）

> 以下不影响理解现有实现，但会影响“README 中承诺的能力”完整性或稳定性。

1. **allowedTools 仅存储未生效**：`session.allowedTools` 写入 DB，但 `runClaude(query)` 未使用该配置做工具限制。
2. **工具审批覆盖面有限**：Runner 对除 `AskUserQuestion` 外的工具默认 `allow`，与“敏感工具需审批”的产品预期不一致。
3. **Resume 命令可能不正确**：UI 侧边栏复制的是 `session.id` 而非 `claudeSessionId`，可能无法在 Claude Code 中 resume 同一会话。
4. **statistics/getStaticData 未接入 UI**：主进程已推送资源数据，但 UI 目前未订阅/展示。
5. **IPC 校验范围**：`ipcMainHandle` 有 frame 校验，但 `ipcMain.on("client-event")` 未做同等校验（可考虑统一校验策略）。

---

## 11. 术语表
- **Session**：本应用中的会话单元（SQLite `sessions` 表一行），对应一个任务/对话。
- **Claude Session ID / resume id**：SDK 返回的 `session_id`，用于继续同一上下文。
- **StreamMessage**：SDK 消息或用户 prompt 的统一结构（见 `src/ui/types.ts` / `src/electron/types.ts`）。
- **Tool Use / Tool Result**：Agent 执行工具的请求与结果（在 UI 中可视化展示）。
- **AskUserQuestion**：SDK 工具之一，用于向用户提问/请求输入；本项目把它作为 UI 交互入口。

---

## 12. 功能等价复刻必备补充（契约 / 状态机 / 验收）

本章的目标是：让另一个团队**只看本文档**，也能复刻出“功能等价”的版本（UI 可自由发挥），而无需再阅读当前源码。

### 12.1 IPC 与事件契约（必须实现）

#### 12.1.1 传输层约束
- **Server -> Client**：主进程通过 `webContents.send("server-event", JSON.stringify(event))` 广播；渲染进程通过 `window.electron.onServerEvent(cb)` 接收并 `JSON.parse`。
- **Client -> Server**：渲染进程通过 `window.electron.sendClientEvent(event)` 发送；主进程监听 `ipcMain.on("client-event", ...)`。
- **invoke 类 RPC**（可选但当前实现存在）：`generate-session-title`、`get-recent-cwds`、`select-directory`、`getStaticData`（见 `src/electron/preload.cts` 与 `types.d.ts`）。

> 备注：为“功能等价”，核心只需要实现 `client-event` + `server-event` 这一对事件通道；其余 invoke 可以按需裁剪/替换。

#### 12.1.2 ClientEvent（UI 必须发起）

1) `session.list`  
**语义**：请求会话列表。  
**输入**
```json
{ "type": "session.list" }
```
**期望输出**：`session.list`（见 12.1.3）。

2) `session.start`  
**语义**：创建新会话并开始运行。  
**输入**
```json
{
  "type": "session.start",
  "payload": {
    "title": "string",
    "prompt": "string",
    "cwd": "/abs/path (optional)",
    "allowedTools": "Read,Edit,Bash (optional)"
  }
}
```
**期望输出（时序约束）**
- 必须先发 `session.status(running)`（至少包含 `sessionId/status/title`，`cwd` 可选）
- 必须发 `stream.user_prompt`
- 随后持续发 `stream.message`（SDK 产出）
- 最终发 `session.status(completed|error)`

3) `session.history`  
**语义**：请求某个会话的历史消息（用于 UI hydration）。  
**输入**
```json
{ "type": "session.history", "payload": { "sessionId": "uuid" } }
```
**期望输出**
- 会话存在：`session.history`（messages 必须按时间升序）
- 会话不存在：`runner.error`（message 至少为 `"Unknown session"`）

4) `session.continue`  
**语义**：在同一会话内继续对话（依赖可 resume 的 claude session id）。  
**输入**
```json
{ "type": "session.continue", "payload": { "sessionId": "uuid", "prompt": "string" } }
```
**期望输出**
- 会话不存在：`runner.error("Unknown session")`
- 会话存在但无 resume id：`runner.error("Session has no resume id yet.")`
- 正常：同 `session.start` 的输出时序（running -> user_prompt -> stream -> completed/error）

5) `session.stop`  
**语义**：停止正在运行的会话（abort）。  
**输入**
```json
{ "type": "session.stop", "payload": { "sessionId": "uuid" } }
```
**期望输出**
- 会话存在：`session.status(idle)`（功能等价实现中“stop 视为回到 idle”）
- 会话不存在：允许静默忽略（当前实现无错误事件）

6) `session.delete`  
**语义**：删除会话及其消息（幂等）。  
**输入**
```json
{ "type": "session.delete", "payload": { "sessionId": "uuid" } }
```
**期望输出**
- 必须总是发 `session.deleted`（即使会话不存在也要发，保证 UI 幂等）

7) `permission.response`  
**语义**：对主进程发出的权限/提问请求进行回应（当前实现仅用于 AskUserQuestion）。  
**输入**
```json
{
  "type": "permission.response",
  "payload": {
    "sessionId": "uuid",
    "toolUseId": "uuid",
    "result": { "behavior": "allow", "updatedInput": { "any": "json" } }
  }
}
```
或
```json
{
  "type": "permission.response",
  "payload": {
    "sessionId": "uuid",
    "toolUseId": "uuid",
    "result": { "behavior": "deny", "message": "string (optional)" }
  }
}
```

#### 12.1.3 ServerEvent（主进程必须发出）

1) `session.list`  
**输入（发给 UI）**
```json
{
  "type": "session.list",
  "payload": {
    "sessions": [
      {
        "id": "uuid",
        "title": "string",
        "status": "idle|running|completed|error",
        "cwd": "/abs/path (optional)",
        "claudeSessionId": "string (optional)",
        "createdAt": 1730000000000,
        "updatedAt": 1730000000000
      }
    ]
  }
}
```
> 兼容说明：当前实现底层 DB 行可能还包含 `allowedTools/lastPrompt` 等字段；UI 可以忽略。功能等价实现只需保证上述字段齐全即可。

2) `session.history`  
```json
{
  "type": "session.history",
  "payload": {
    "sessionId": "uuid",
    "status": "idle|running|completed|error",
    "messages": [ { "type": "user_prompt", "prompt": "..." }, { "type": "system", "subtype": "init" } ]
  }
}
```

3) `session.status`  
```json
{
  "type": "session.status",
  "payload": {
    "sessionId": "uuid",
    "status": "running|idle|completed|error",
    "title": "string (optional)",
    "cwd": "/abs/path (optional)",
    "error": "string (optional)"
  }
}
```

4) `session.deleted`  
```json
{ "type": "session.deleted", "payload": { "sessionId": "uuid" } }
```

5) `stream.user_prompt`  
```json
{ "type": "stream.user_prompt", "payload": { "sessionId": "uuid", "prompt": "string" } }
```

6) `stream.message`  
```json
{ "type": "stream.message", "payload": { "sessionId": "uuid", "message": { "type": "assistant" } } }
```
其中 `message` 为 SDK 的消息对象或 `StreamMessage`（见 12.3）。

7) `permission.request`  
```json
{
  "type": "permission.request",
  "payload": {
    "sessionId": "uuid",
    "toolUseId": "uuid",
    "toolName": "AskUserQuestion",
    "input": { "questions": [ { "question": "..." } ] }
  }
}
```

8) `runner.error`  
```json
{ "type": "runner.error", "payload": { "message": "string", "sessionId": "uuid (optional)" } }
```

### 12.2 会话状态机与事件时序（必须一致）

#### 12.2.1 状态集合
`idle | running | completed | error`

#### 12.2.2 状态迁移规则（功能等价）
- `idle -> running`：收到 `session.start` 或 `session.continue` 且满足前置条件后。
- `running -> completed`：SDK 产出 `result.success` 或 runner 自然结束且未被 stop。
- `running -> error`：SDK 产出 `result != success` 或 runner 抛错（非 AbortError）。
- `running -> idle`：收到 `session.stop` 并成功 abort（stop 不记为 error）。
- `completed|error|idle -> running`：收到 `session.continue` 且具有 resume id。
- 任意状态 -> 删除：收到 `session.delete`（若 running 需先 abort），并必须发 `session.deleted`。

#### 12.2.3 时序要求（start/continue）
对 `session.start`/`session.continue`，主进程事件顺序必须满足：
1. `session.status(running)`
2. `stream.user_prompt`
3. 0..N 次 `stream.message`（SDK 产出）
4. `session.status(completed|error)`（最终态）

#### 12.2.4 resume id（claudeSessionId）写入时机
当 `stream.message` 收到 SDK 的 `system:init` 消息时，应立即提取 `session_id` 并持久化到 sessions 表（用于后续 continue/resume）。

### 12.3 SDK 消息子集与持久化策略（必须覆盖）

#### 12.3.1 最小可用消息集合（UI 必须能处理/忽略）
为实现“功能等价”，至少需要正确处理或安全忽略以下消息类型：
- `system:init`：用于展示系统信息与提取 `session_id`
- `assistant`：展示 `thinking/text/tool_use`
- `user`（含 `tool_result`）：展示工具输出与错误
- `result`：展示会话结束统计（成功）或错误信息（失败）
- `stream_event`：用于 partial streaming（可选展示，但当前实现会展示 partial）

> 兼容策略：如果 SDK 新增 message 类型，UI/主进程应“可忽略不崩溃”。

#### 12.3.2 StreamMessage 持久化规则（与当前实现一致）
- 每次发出 `stream.message`，必须把 `message` JSON 原样写入 `messages.data`。
- 每次发出 `stream.user_prompt`，必须写入一条：
```json
{ "type": "user_prompt", "prompt": "..." }
```
- `messages` 表需按 `created_at` 升序可回放。
- 消息去重：若 SDK 消息带 `uuid` 字段，用它作为 `messages.id` 并 `insert or ignore`，避免重复写入；否则生成随机 UUID。

#### 12.3.3 partial streaming 的解析算法（等价实现建议）
当前 UI 的等价算法（见 `src/ui/App.tsx`）：
- 仅当 `message.type === "stream_event"` 且 `message.event.type` 属于：
  - `content_block_start`：清空 partial buffer，显示 partial 区域
  - `content_block_delta`：从 `message.event.delta.type` 中取前缀（`text_delta` -> `text`；`thinking_delta` -> `thinking`），并累加 `message.event.delta[prefix]` 到 buffer
  - `content_block_stop`：关闭 partial 区域并清空 buffer

示例（文本 delta）：
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "delta": { "type": "text_delta", "text": "hello" }
  }
}
```

### 12.4 AskUserQuestion 协议（必须实现）

#### 12.4.1 工具输入最小结构
UI 侧等价实现至少要识别以下结构（字段可多不可少）：
```json
{
  "questions": [
    {
      "question": "string",
      "header": "string (optional)",
      "options": [ { "label": "string", "description": "string (optional)" } ],
      "multiSelect": false
    }
  ]
}
```

#### 12.4.2 主进程行为（阻塞等待用户）
当 SDK 请求使用 `AskUserQuestion` 时：
- 生成 `toolUseId`（UUID）
- 发 `permission.request(sessionId, toolUseId, toolName="AskUserQuestion", input)`
- 将一个 Promise resolver 存入 `session.pendingPermissions[toolUseId]`
- 直到收到 `permission.response` 才向 SDK 返回对应 `PermissionResult`
- 若会话被 stop/abort，应以 `deny` 结束等待（message 可为 `"Session aborted"`）

#### 12.4.3 UI 行为（问答面板与 updatedInput）
等价实现需要支持：
- 单选：点击某个 option 即可产生答案
- 多选：允许多个 option，并可追加“Other”自由文本
- 组装规则：把答案写回 `updatedInput.answers`（key 为 `question` 文本，value 为选项 label 或逗号拼接）

示例（allow）：
```json
{
  "behavior": "allow",
  "updatedInput": {
    "questions": [ { "question": "..." } ],
    "answers": { "问题文本": "用户选择或输入" }
  }
}
```

#### 12.4.4 关联 permission.request 与 tool_use 的匹配规则
当前实现中：
- `tool_use` 的 `id`（SDK 生成）与 `permission.request.toolUseId`（主进程生成）不同，无法直接关联。
- UI 通过“问题签名”匹配（见 `src/ui/components/EventCard.tsx#getAskUserQuestionSignature`）：由每个 question 的 `question/header/multiSelect/options(label|description)` 拼接而成。

为功能等价，复刻时应提供**确定性匹配**（可以复用签名法，或改为在主进程把 SDK tool_use id 一并透传给 UI；二选一，但必须可稳定匹配）。

### 12.5 工具策略与 allowedTools（必须明确）

为与当前代码行为一致：
- 除 `AskUserQuestion` 外，其它工具 **默认自动允许**（auto-allow）。
- `allowedTools` 仅作为会话元数据持久化，不参与实际限制（即使写了 `Read,Edit,Bash` 也不做 enforcement）。

如需在复刻版本中升级为“按工具审批/白名单”，必须在需求层重新定义规则与验收（不属于当前“功能等价”范围）。

### 12.6 运行配置与环境依赖（必须补齐）

#### 12.6.1 开发端口一致性
当前实现要求：
- Electron 主进程开发态固定加载 `http://localhost:10087`（`src/electron/main.ts`）
- IPC frame 校验也固定允许 `localhost:10087`（`src/electron/util.ts`）
- Vite dev server 端口来自环境变量 `PORT`（小写）：`vite.config.ts` 会 `parseInt(env.PORT)`

因此开发运行必须满足：`PORT=10087`（或同步修改三处常量/配置，使其一致）。

#### 12.6.2 Claude Code 配置复用
必须支持从 `~/.claude/settings.json` 读取 `env` 并注入 `process.env`（仅当未显式设置）。
最小需要兼容的 env key 集合（当前实现读取）：  
`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 等（详见 `src/electron/libs/claude-settings.ts`）。

缺失策略：
- settings.json 不存在/非法：允许忽略并继续启动（但 SDK 调用可能失败）

#### 12.6.3 DB 路径
等价实现推荐使用：`join(app.getPath("userData"), "sessions.db")`，保持与平台一致的存储位置。

### 12.7 错误与边界行为清单（必须覆盖）

| 场景 | 期望行为（事件层） |
| --- | --- |
| `session.history` 指定 session 不存在 | 发 `runner.error({message:"Unknown session"})` |
| `session.continue` session 不存在 | 发 `runner.error({message:"Unknown session"})` |
| `session.continue` 无 `claudeSessionId` | 发 `runner.error({sessionId, message:"Session has no resume id yet."})` |
| `session.stop` session 不存在 | 静默忽略（不发 error） |
| `session.delete` session 不存在 | 仍需发 `session.deleted`（幂等） |
| runner 内部异常（非 AbortError） | 发 `session.status(error, error:String(err))` |
| stop/abort 导致的 AbortError | 不应发 `session.status(error)`（视为正常停止） |
| `select-directory` 用户取消 | 返回 `null`（invoke 结果） |
| `get-recent-cwds(limit)` | limit 需被收敛到 1..20；默认 8 |

### 12.8 功能等价验收用例（Given/When/Then）

以下用例不依赖 UI 细节，只校验事件与数据效果：

1) **冷启动无会话**  
Given DB 无 sessions  
When UI 发送 `session.list`  
Then 收到 `session.list` 且 `sessions=[]`

2) **创建会话并运行**  
Given UI 有 `cwd` 与 `prompt`  
When UI 发送 `session.start`  
Then 事件顺序满足：`session.status(running)` → `stream.user_prompt` → 多次 `stream.message` → `session.status(completed|error)`  
And DB 中存在该 session 行与 messages（至少包含一条 `user_prompt`）

3) **继续会话（有 resume id）**  
Given session 存在且已写入 `claude_session_id`，且不在 running  
When UI 发送 `session.continue`  
Then 同“创建会话并运行”的时序与落库规则

4) **继续会话（无 resume id）**  
Given session 存在但 `claude_session_id` 为空  
When UI 发送 `session.continue`  
Then 收到 `runner.error("Session has no resume id yet.")` 且 session 状态不应变为 running

5) **停止会话**  
Given session 状态为 running  
When UI 发送 `session.stop`  
Then 收到 `session.status(idle)` 且不应出现 `session.status(error)`（AbortError 不算错误）

6) **删除会话（幂等）**  
Given session 存在或不存在  
When UI 发送 `session.delete`  
Then 必须收到 `session.deleted(sessionId)`；若存在则 DB 中 sessions/messages 均被删除

7) **AskUserQuestion 闭环**  
Given runner 发出 `permission.request(toolName="AskUserQuestion")`  
When UI 发 `permission.response(allow, updatedInput.answers=...)`  
Then runner 继续执行（后续能收到新的 `stream.message` 或 `tool_result`）

