# Multica：通过 ACP 协议接入 Codex 的实现细节

> 面向读者：需要在 Multica 里理解/改造 Codex（`codex-acp`）接入链路的开发者  
> 范围：只描述本仓库里的实现（Multica 作为 **ACP Client**），不展开 `codex-acp`/`codex` 本体内部逻辑

---

## 0. 一句话结论（集成边界）

- Multica **不直接调用 OpenAI API**，也不直接实现 Codex 的工具系统。
- Multica 做的事情是：**启动一个 ACP Agent 子进程**（默认是 `codex-acp`），然后用 `@agentclientprotocol/sdk` 通过 **stdio + NDJSON(JSON-RPC 2.0)** 与该进程通信。
- 所谓“通过 ACP 接入 Codex”，在本项目语境下等价于：**通过 `codex-acp` 这个 ACP 适配器，把 Codex CLI 的能力映射成 ACP 的 `session/update`、`tool_call`、`requestPermission` 等事件/接口**。

关键文件：

- Agent 配置：`src/main/config/defaults.ts`
- 启动子进程：`src/main/conductor/AgentProcess.ts`
- 建立 ACP 连接：`src/main/conductor/AgentProcessManager.ts`
- 发送 prompt：`src/main/conductor/PromptHandler.ts`
- 接收 sessionUpdate 并落盘：`src/main/conductor/AcpClientFactory.ts` + `src/main/session/SessionStore.ts`
- Permission 请求转发：`src/main/permission/PermissionManager.ts`（GUI）

---

## 1. 组件与数据流总览

### 1.1 进程/模块关系图

```
┌────────────────────────────────────────────────────────────────────────────┐
│                               Multica (Electron)                            │
│                                                                            │
│  ┌───────────────────────────────┐     ┌────────────────────────────────┐  │
│  │ Renderer (React)              │     │ Main Process                     │  │
│  │                               │     │                                  │  │
│  │ useApp.ts                     │<--->│ IPC handlers                     │  │
│  │ ChatView.tsx                  │ IPC │ Conductor (Facade)               │  │
│  │ Permission UI                 │     │  ├─ SessionLifecycle             │  │
│  └───────────────────────────────┘     │  ├─ PromptHandler                │  │
│                                        │  ├─ AgentProcessManager          │  │
│                                        │  ├─ SessionStore (persistence)   │  │
│                                        │  └─ PermissionManager (GUI)      │  │
│                                        └──────────────┬───────────────────┘  │
│                                                       │ ACP (stdio NDJSON)    │
└───────────────────────────────────────────────────────┼──────────────────────┘
                                                        │
                                                        ▼
                                             ┌───────────────────────┐
                                             │ ACP Agent subprocess   │
                                             │   codex-acp            │
                                             │   (wraps codex CLI)    │
                                             └───────────────────────┘
```

### 1.2 “Codex 接入”在 Multica 的路径

1. **配置**：把 `codex` 作为一个 `AgentConfig` 注册（默认命令是 `codex-acp`）。
2. **启动**：主进程 `spawn('codex-acp', [])`，拿到 stdio。
3. **握手**：通过 ACP SDK：
   - `initialize({ protocolVersion, clientCapabilities })`
   - `newSession({ cwd, mcpServers }) -> sessionId`
4. **对话**：`prompt({ sessionId, prompt: [...] })` + `cancel({ sessionId })`
5. **渲染**：通过 `sessionUpdate` 通知流式接收 agent 输出和 tool 状态。
6. **权限**：当 agent 触发 `requestPermission`，Multica GUI 把它转成弹窗/卡片并返回选择结果。

---

## 2. 安装与可执行文件发现（Codex 相关）

### 2.1 默认要求：`codex` + `codex-acp` 都要存在

在主进程的 agent 检查逻辑里，Codex 被定义为需要同时满足以下命令可用：

- `codex`（Codex CLI）
- `codex-acp`（ACP 适配器）

实现位置：

- `src/main/utils/agent-check.ts`
  - `AGENT_COMMANDS.codex = ['codex', 'codex-acp']`
  - `installed` 只有在 **两个命令都存在**时才为 `true`

### 2.2 自动补全 PATH：解决 GUI App 找不到命令的问题

macOS 的 GUI 应用通常拿不到你的 shell 环境 PATH，因此项目做了两层处理：

1. `src/main/index.ts`：启动时调用 `fix-path`，把 shell PATH 注入进来（尽可能接近你终端里的 PATH）
2. `src/main/utils/path.ts`：额外拼上常见安装目录（例如 `~/.local/bin`、`/opt/homebrew/bin` 等），并在以下场景统一使用：
   - agent 检查：`src/main/utils/agent-check.ts`
   - 启动子进程：`src/main/conductor/AgentProcess.ts`

### 2.3 安装命令（来自项目内置 install 引导）

GUI 里的“安装”按钮不会自动安装，而是打开系统 Terminal 并把命令打出来给用户执行：

- `src/main/utils/agent-install.ts`
  - `INSTALL_COMMANDS.codex = 'npm install -g @openai/codex @zed-industries/codex-acp'`

> 注意：README 中也有简化写法，但**项目内置引导**以 `agent-install.ts` 为准。

### 2.4 鉴权提示（UI 侧）

UI 在判断“鉴权失败”时，会把错误以内联消息形式提示，并给出该 agent 的鉴权命令：

- `src/renderer/src/hooks/useApp.ts`
  - `AGENT_AUTH_COMMANDS.codex = 'codex auth'`

---

## 3. Agent 配置（参数层）

### 3.1 `AgentConfig` 接口

定义在 `src/shared/types.ts`：

```ts
export interface AgentConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}
```

解释：

- `command` / `args`：最终会交给 `child_process.spawn()`，即 ACP Agent 进程的启动方式
- `env`：会合并到子进程的环境变量中（可用于补充某些 CLI 所需的环境变量）
- `enabled`：是否在 UI/CLI 中可选

### 3.2 Codex 的默认配置

定义在 `src/main/config/defaults.ts`：

```ts
codex: {
  id: 'codex',
  name: 'Codex',
  command: 'codex-acp',
  args: [],
  enabled: true
}
```

要点：

- Multica 实际启动的是 `codex-acp`，而不是 `codex`
- `args` 为空：本项目没有给 `codex-acp` 追加任何 flags（如需增加，通常从这里改）

---

## 4. ACP 连接：从 spawn 到 newSession（协议层）

这一节是“接入”的核心：**把 Codex 包装成一个 ACP Agent 子进程，然后建立 ACP Client 连接。**

### 4.1 启动子进程：`AgentProcess`

文件：`src/main/conductor/AgentProcess.ts`

关键行为：

- `spawn(command, args, { stdio: ['pipe','pipe','inherit'], env: { ...process.env, ...env, PATH: getEnhancedPath() } })`
  - stdin/stdout：用于 ACP 数据通道（JSON-RPC NDJSON）
  - stderr：直接继承（你会在主进程日志里看到 agent 的错误输出）
- `getStdinWeb()` / `getStdoutWeb()`：把 Node stream 转成 Web Stream
  - ACP SDK 的 `ndJsonStream()` 需要 Web Stream 形态

### 4.2 把 stdio 变成 ACP 传输：`ndJsonStream`

文件：`src/main/conductor/AgentProcessManager.ts`

```ts
const stream = ndJsonStream(agentProcess.getStdinWeb(), agentProcess.getStdoutWeb())
```

含义：

- **NDJSON**：每行一个 JSON 消息（ACP SDK 用它封装 JSON-RPC 2.0 的 request/response/notification）
- 传输层：**stdio**（本项目只支持本地子进程 agent；不涉及 WebSocket/HTTP）

### 4.3 创建 ACP Client 端连接：`ClientSideConnection`

仍在 `src/main/conductor/AgentProcessManager.ts`：

```ts
const connection = new ClientSideConnection(
  (_agent) => createAcpClient(sessionId, { sessionStore, callbacks }),
  stream
)
```

这里的关键是 `createAcpClient(...)`：它返回一个实现了 ACP SDK `Client` 接口的对象，用来接收 agent 的通知、处理 permission 请求等（见下一节）。

### 4.4 initialize：协议版本与能力声明

```ts
const initResult = await connection.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false
  }
})
```

参数解释：

- `protocolVersion`: 使用 ACP SDK 常量 `PROTOCOL_VERSION`（来自 `@agentclientprotocol/sdk`）
- `clientCapabilities`：声明“客户端能做什么”
  - 这里明确告诉 agent：**不要指望客户端帮你读写文件，也不要指望客户端提供 terminal**
  - 因此对于 Codex 来说，文件读写/命令执行（若有）应由 agent 自行完成；Multica 只负责展示 `tool_call`/`tool_call_update`

> 如果未来要做“让 agent 通过 ACP 调用客户端的文件/终端能力”，就需要把这些 `false` 变为 `true`，并在 `Client` 侧实现对应 handler（当前项目未实现）。

### 4.5 newSession：传工作目录 + 返回 ACP sessionId

```ts
const acpResult = await connection.newSession({
  cwd,
  mcpServers: []
})
```

参数解释：

- `cwd`：用户在 UI 中选择的工作目录（Multica session 的 `workingDirectory`）
  - 这是“Codex 在哪个目录里工作”的关键参数
- `mcpServers: []`：当前不挂载任何 MCP Server（留有扩展位）

返回值：

- `acpResult.sessionId`：**ACP Agent Session ID**

在 Multica 中，这个 ID 会被保存到：

- 运行时：`SessionAgent.agentSessionId`
- 持久化：`MulticaSession.agentSessionId`

---

## 5. Multica Session vs ACP Session：ID 映射与生命周期

### 5.1 两种 Session ID

- `MulticaSession.id`：Multica 自己生成的 UUID（用于 UI 列表、IPC 调用等）
- `MulticaSession.agentSessionId`：ACP `newSession()` 返回的 sessionId（用于过滤/归档 `session/update`）

类型定义：`src/shared/types/session.ts`

### 5.2 Lazy Start：为什么创建会话时 agentSessionId 为空？

在 GUI 模式下，新建会话不会立刻启动 agent，而是等到用户第一次发送 prompt 才启动（减少资源占用）：

- `src/main/conductor/SessionLifecycle.ts`
  - `create()`：先创建记录，`agentSessionId: ''`
  - `ensureAgentForSession()`：在第一次 prompt 时才 `start()` agent 并调用 `newSession()`

为了让前端能用正确的 `agentSessionId` 过滤消息，主进程会在拿到新的 ACP sessionId 后通知前端：

- `src/main/conductor/SessionLifecycle.ts`：`events.onSessionMetaUpdated(updatedSession)`
- `src/main/index.ts`：把它通过 IPC `SESSION_META_UPDATED` 推给 renderer
- `src/renderer/src/hooks/useApp.ts`：订阅 `onSessionMetaUpdated` 更新当前 session

### 5.3 Resume / Switch Agent：为什么每次都会创建新的 ACP session？

本项目的策略是：**恢复会话/切换 agent 时，启动一个新的 agent 进程并创建一个新的 ACP session**，然后通过“历史回放”把上下文塞回去（见下一节）。

原因（从实现可推断）：

- 本地子进程 agent 生命周期不可控（崩溃/退出）
- ACP session 绑定到具体 agent 进程，进程重启后必须 newSession
- 为了在 UI 上维持“同一个对话线程”，Multica 自己做 session persistence + replay

---

## 6. 发送 Prompt：参数格式、图文消息、历史回放

### 6.1 Renderer → Main：`electronAPI.sendPrompt()`

接口定义：`src/shared/electron-api.d.ts`

```ts
sendPrompt(sessionId: string, content: MessageContent): Promise<{ stopReason: string }>
```

注意：

- 这里的 `sessionId` 是 **Multica sessionId**（不是 ACP sessionId）
- 主进程内部会把它映射到 `SessionAgent.agentSessionId` 再调用 ACP

### 6.2 `MessageContent`（多模态）格式

类型定义：`src/shared/types/message.ts`

```ts
export type MessageContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
>
```

### 6.3 Main 侧转换为 ACP prompt 结构

实现：`src/main/conductor/PromptHandler.ts`

核心做法：

- 把 `MessageContent` 映射为 ACP SDK 所需的 content block 数组：
  - `{ type: 'text', text }`
  - `{ type: 'image', data, mimeType }`
- 然后调用：

```ts
const result = await connection.prompt({
  sessionId: agentSessionId,
  prompt: promptContent
})
```

返回：

- `result.stopReason`：被原样返回给 renderer（UI 目前不强依赖它）

### 6.4 用户消息的持久化：自定义 `user_message`

在真正调用 ACP `prompt()` 前，主进程会先把用户消息写进 `SessionStore`：

- `src/main/conductor/PromptHandler.ts`
  - 追加一个自定义 update：`sessionUpdate: 'user_message'`
  - 支持 `_internal: true`（用于 G-3 机制，UI 不展示但会发给 agent）

注意：

- `user_message` **不是 ACP 标准**，是 Multica 为了“历史记录/回放/渲染一致性”自定义的存储类型
- UI 渲染时会识别并展示该类型（见 `src/renderer/src/components/ChatView.tsx`）

### 6.5 取消请求（cancel）与“处理中”状态（processing）

为了在 UI 上展示“agent 正在思考/执行中”，并支持用户中断当前回合，项目在 ACP 之上额外维护了一个**处理状态**：

- `src/main/conductor/PromptHandler.ts`
  - `processingSessions: Set<string>`
  - `send()` 一进入就 `add(sessionId)`（**在任何 await 之前**），并触发 `events.onStatusChange?.()`
  - `finally` 中一定会 `delete(sessionId)` 并再次触发 `events.onStatusChange?.()`

主进程会把状态广播给 renderer：

- `src/main/index.ts`：`IPC_CHANNELS.AGENT_STATUS`
- payload（见 `src/shared/electron-api.d.ts` 的 `RunningSessionsStatus`）：

```ts
{
  runningSessions: number,
  sessionIds: string[],
  processingSessionIds: string[]
}
```

取消请求本质上是 ACP 的 `cancel`：

- `src/main/conductor/PromptHandler.ts`
  - `connection.cancel({ sessionId: agentSessionId })`

---

## 7. 会话恢复：History Replay（为什么、怎么做、参数预算）

当 agent 进程重启后，ACP session 的上下文丢失。为保持对话连续性，Multica 在“恢复会话/切换 agent/lazy start 老会话”的第一次 prompt 时做历史回放。

实现位置：

- `src/main/conductor/historyReplay.ts`
- `src/main/conductor/PromptHandler.ts`（在 `needsHistoryReplay` 为 `true` 时 prepend）

关键点：

- 回放内容以纯文本形式 prepend 到用户 prompt 前面，格式大致为：

```
[Session History - N messages]

USER: ...

ASSISTANT: ...
[Used: ...]

[End of History]

Continue the conversation. The user's new message follows:
```

- 默认 token 预算：`DEFAULT_MAX_HISTORY_TOKENS = 20000`
  - token 粗估：`text.length / 4`（注释写的是“同 Codex 的启发式”）
- tool call 不会逐条回放，而是做一个简要 summary（`[Used: ...]`），避免历史过长

---

## 8. 接收 session/update：落盘、排序、渲染

### 8.1 `createAcpClient()`：统一入口

文件：`src/main/conductor/AcpClientFactory.ts`

它返回一个 ACP SDK `Client` 实现，主要处理两类来自 agent 的回调：

1. `sessionUpdate(params: SessionNotification)`
2. `requestPermission(params: RequestPermissionRequest)`

### 8.2 sessionUpdate 的处理：先存储再广播

在 `sessionUpdate` 中：

1.（可选）写入 `SessionStore.appendUpdate(...)`
2. 拿到 `sequenceNumber`（单调递增）
3. 调用 `callbacks.onSessionUpdate(params, sequenceNumber)` 通知上层（Conductor → main/index.ts）

### 8.3 `SessionStore` 的存储结构

文件：`src/main/session/SessionStore.ts`

默认路径：

- GUI：`{Electron userData}/sessions`（`app.getPath('userData')`）
- CLI：`~/.multica/sessions`

结构：

```
sessions/
  index.json            # session 列表索引
  data/
    {sessionId}.json    # 单个会话完整数据（session + updates）
```

每条 update 会被包成：

```ts
export interface StoredSessionUpdate {
  timestamp: string
  sequenceNumber?: number
  update: SessionNotification | { update: AskUserQuestionResponseUpdate }
}
```

其中 `sequenceNumber` 由 `SessionStore` 维护的 per-session 计数器生成，用于解决“并发/异步导致的乱序”。

### 8.4 Main → Renderer：通过 IPC 转发所有 sessionUpdate

主进程在 `src/main/index.ts` 里把更新广播给 renderer：

- IPC：`IPC_CHANNELS.AGENT_MESSAGE`
- payload 形态（见 `src/shared/electron-api.d.ts` 的 `AgentMessage`）：

```ts
{
  sessionId: params.sessionId,          // ACP sessionId
  sequenceNumber,                       // 用于排序
  update: params.update,                // 具体 update
  done: false
}
```

Renderer 侧在 `src/renderer/src/hooks/useApp.ts`：

- 只处理 `message.sessionId === currentSession.agentSessionId` 的消息（避免跨会话串线）
- 把 update append 到 `sessionUpdates` state
- 最终由 `ChatView.tsx` 负责“把 update 流组装成可展示的消息”

### 8.5 渲染侧排序：`ChatView.groupUpdatesIntoMessages()`

文件：`src/renderer/src/components/ChatView.tsx`

- 先按 `sequenceNumber` 排序（无序号的 update 保持相对顺序）
- 识别 `agent_message_chunk` / `agent_thought_chunk` 做 chunk 合并
- 识别 `tool_call` / `tool_call_update` 做同一 toolCallId 的“就地更新”
- 识别 `user_message`（自定义）渲染用户消息（支持 text+image）

配套说明可参考仓库已有文档：

- `docs/acp-message-rendering.md`

### 8.6 错误处理：为什么很多错误会“变成一条 agent 消息”

主进程发送 prompt 时，如果 ACP 调用失败，项目倾向于把错误**以内联消息**注入到对话里，而不是把异常一直抛到 IPC 层：

- `src/main/conductor/PromptHandler.ts`
  - `catch (error)` 后调用 `parseAcpError()` 做“更友好”的文案
  - 然后通过 `events.onSessionUpdate(...)` 发送一条伪装成 `agent_message_chunk` 的文本
    - 这样 UI 侧看到的是“对话里出现一条 Error 消息”，而不是弹出阻断式报错

UI 侧还有一类“鉴权错误”处理逻辑：

- `src/renderer/src/hooks/useApp.ts`
  - `isAuthError()` 命中时，会追加一个自定义的 `error_message` update，并带上 `authCommand`（例如 `codex auth`）

---

## 9. Tool Call：Codex 的 kind 缓存、文件树刷新与展示映射

### 9.1 ACP 中的 tool 事件（本项目关心的两种）

- `tool_call`：一次工具调用的开始（通常会带 `toolCallId`、`title`、`kind`、`rawInput` 等）
- `tool_call_update`：同一工具调用的状态更新（`in_progress`/`completed`/`failed` 等）

### 9.2 Codex 特性：`tool_call_update` 不带 kind（需要本地缓存）

仓库已有专门注释说明这一点：

- `src/renderer/src/hooks/useApp.ts`
  - `// This is needed because tool_call_update events don't include kind (for Codex etc.)`

实现方式：

1. 收到 `tool_call` 时：把 `toolCallId -> kind` 存到 `toolKindMapRef`
2. 收到 `tool_call_update` 时：从 map 取回 kind，判断是否属于“会改文件”的工具
3. 当该工具 `completed/failed`：触发文件树刷新并清理 map

文件修改类 kind 列表：

```ts
const FILE_MODIFYING_KINDS = new Set(['edit', 'write', 'delete', 'execute'])
```

### 9.3 Tool 名称的展示优先级（兼容多 agent）

在渲染侧（`ToolCallItem`）的解析逻辑里，工具名来源优先级为：

1. `update._meta?.claudeCode?.toolName`（Claude Code 专用）
2. `update.kind`（Codex 通常依赖这个）
3. `update.title`（兜底）

详见：`docs/acp-message-rendering.md` 的 “Tool Name Resolution Priority” 小节，以及：

- `src/renderer/src/components/ToolCallItem.tsx`

---

## 10. Permission：requestPermission 的参数、IPC 转发与返回

### 10.1 ACP → Main：`Client.requestPermission()`

入口：`src/main/conductor/AcpClientFactory.ts`

它会把 permission 请求交给回调 `callbacks.onPermissionRequest`（GUI 模式下由 `PermissionManager` 实现）。

### 10.2 Main：`PermissionManager` 把 permission 请求变成 UI 可交互的数据

文件：`src/main/permission/PermissionManager.ts`

流程：

1. 为这次 permission request 生成 `requestId`（UUID）
2. 把 ACP sessionId 映射成 Multica sessionId（用于 UI 过滤高亮）
3. 通过 IPC `IPC_CHANNELS.PERMISSION_REQUEST` 发给 renderer：

```ts
{
  requestId,
  sessionId: params.sessionId,               // ACP sessionId
  multicaSessionId,                          // 内部 sessionId（用于匹配）
  toolCall: { toolCallId, title, kind, status, rawInput },
  options: [{ optionId, name, kind }]
}
```

4. 等待 renderer 返回 `PermissionResponse`
5. 超时 5 分钟：自动选择 deny（若存在）或第一个选项

### 10.3 Renderer：permission store + UI 组件

状态管理：`src/renderer/src/stores/permissionStore.ts`

- 用队列支持并发 permission request
- 支持 AskUserQuestion 的多问题（multi-question）场景：收集所有回答后一次性回传

最终通过 preload 暴露的接口回到主进程：

- `window.electronAPI.respondToPermission(response)`

### 10.4 Main → ACP：返回 `RequestPermissionResponse`

`PermissionManager` 会把 renderer 的选择封装回 ACP 需要的 `outcome`：

```ts
{
  outcome: {
    outcome: 'selected',
    optionId: response.optionId,
    _meta: ... // （可选）用于附带用户回答
  }
}
```

> `_meta` 的具体内容在本项目主要用于 AskUserQuestion/G-3 机制，不是 Codex 接入的必要条件，但它走同一条 permission 管道。

---

## 11. 对外接口清单（你改接入时最常用的一组）

### 11.1 Renderer 可用的 Electron API（节选）

定义：`src/shared/electron-api.d.ts`

- 会话
  - `createSession(workingDirectory, agentId)`
  - `loadSession(sessionId)` / `getSession(sessionId)` / `resumeSession(sessionId)`
  - `switchSessionAgent(sessionId, newAgentId)`
- 对话
  - `sendPrompt(sessionId, content)`
  - `cancelRequest(sessionId)`
- 事件
  - `onAgentMessage(cb)`（ACP sessionUpdate 的透传）
  - `onPermissionRequest(cb)` / `respondToPermission(...)`
  - `onSessionMetaUpdated(cb)`（lazy start 时更新 agentSessionId 的关键）

### 11.2 IPC channel 名称

定义：`src/shared/ipc-channels.ts`

Codex 接入链路最相关的是：

- `agent:prompt` / `agent:cancel`
- `agent:message` / `agent:status`
- `permission:request` / `permission:response`
- `session:*`

---

## 12. 调试与常见问题（针对 Codex 接入）

### 12.1 “找不到 codex-acp/codex 命令”

排查点（按优先级）：

1. GUI 模式下 PATH：`fix-path` 是否生效（`src/main/index.ts`）
2. `getEnhancedPath()` 是否包含你的安装目录（`src/main/utils/path.ts`）
3. `pnpm cli doctor` 输出里是否显示 `codex` 与 `codex-acp` 都存在（`src/main/utils/agent-check.ts`）

### 12.2 “会话没消息/消息串线”

核心原则：renderer 只渲染 `message.sessionId === currentSession.agentSessionId` 的更新。

如果你看到“发送 prompt 后没任何更新”，通常是：

- 还没收到 `SESSION_META_UPDATED`（lazy start 后 agentSessionId 从 `''` 变成新值）
- 或者 session 切换太快，旧 session 的 ACP update 被过滤掉（`useApp.ts` 做了 pendingSession 防抖保护）

### 12.3 “tool_call_update 不触发文件树刷新”

Codex 的 `kind` 只在 `tool_call` 里出现（`tool_call_update` 可能缺失），所以必须依赖 `toolCallId -> kind` 缓存。

相关实现：`src/renderer/src/hooks/useApp.ts`

### 12.4 “鉴权错误怎么引导用户处理？”

UI 侧会把部分鉴权错误以内联形式展示，并提示 `codex auth`：

- `src/renderer/src/hooks/useApp.ts`

主进程侧对某些 ACP 错误会转成更友好的提示并以内联消息形式注入：

- `src/main/conductor/PromptHandler.ts` 的 `parseAcpError()`

---

## 13. 扩展点（你可能会改到的地方）

### 13.1 给 codex-acp 增加启动参数/环境变量

- 改 `src/main/config/defaults.ts` 的 `DEFAULT_AGENTS.codex.args/env`
- 或扩展配置持久化（当前 `config:update` 还没落盘）

### 13.2 启用 ACP Client 的 fs/terminal 能力（高级：让 agent 调用客户端执行）

当前 `initialize()` 明确声明：

- `fs.readTextFile=false`
- `fs.writeTextFile=false`
- `terminal=false`

要支持，需要同时做两件事：

1. 在 `src/main/conductor/AgentProcessManager.ts` 把 capability 改成 `true`
2. 在 `createAcpClient()` 返回的 `Client` 实现中，补齐对应 handler（当前项目未实现）

---

## 14. 相关参考（仓库内）

- ACP 消息渲染细节：`docs/acp-message-rendering.md`
- 系统设计概览：`docs/system-design.md`
