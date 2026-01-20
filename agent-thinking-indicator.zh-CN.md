# “Agent is thinking…”（等待模型输出）指示器：Multica 的实现拆解与可复用方案

本文把 Multica 里“正在等待模型输出 / Agent is thinking…”的展示与动画实现，按**端到端链路**拆开说明，方便你在其它项目复用同样的模式（不局限于 ACP）。

---

## 1. 设计目标：为什么要单独做一个 “processing/thinking” 状态

在流式输出的聊天产品里，常见的“正在思考”指示器有两种实现思路：

1. **基于输出启发式**：如果一段时间没收到 token/update，就显示“thinking”
2. **基于真实执行状态**：发送请求时立刻置为“processing”，请求结束时清除

Multica 选择第 2 种：以“**是否存在正在进行的 prompt 请求**”作为真源（source of truth），而不是用“有没有收到消息”来猜。

好处：

- **立即反馈**：用户点击发送后马上出现“thinking”，不需要等到 agent 的第一条 chunk
- **不依赖 agent 行为**：即使 agent 先做很久的 tool 或沉默一段时间，UI 仍能正确显示“处理中”
- **多会话隔离**：Multica 支持多个 session 并行跑 agent，状态按 session 维度维护，不串线

---

## 2. 全链路概览（从一次 prompt 到 UI 显示）

下面是 Multica 的“thinking 指示器”端到端链路（核心节点）：

1. **Renderer** 调用 `electronAPI.sendPrompt(multicaSessionId, content)`
2. **Main / PromptHandler** 在任何 await 前把该 `multicaSessionId` 标记为 processing，并触发 `onStatusChange`
3. **Main** 通过 IPC `agent:status` 广播 `processingSessionIds`
4. **Renderer / useApp** 订阅 `onAgentStatus` 并更新 `runningSessionsStatus`
5. **Renderer / ChatView** 计算得到 `isProcessing`，在消息列表底部渲染 “Agent is thinking…” + 动画

关键点：这里的 processing 维度是 **Multica sessionId**（不是 ACP sessionId）。

---

## 3. Main 侧：processing 状态的“真源”如何维护

### 3.1 PromptHandler：请求开始就置为 processing（在任何 await 之前）

实现位置：`src/main/conductor/PromptHandler.ts`

核心模式（伪代码）：

```ts
processingSessions.add(multicaSessionId)
events.onStatusChange?.()
try {
  await sendInternal(...) // ensureAgent + connection.prompt(...)
} finally {
  processingSessions.delete(multicaSessionId)
  events.onStatusChange?.()
}
```

为什么强调“在任何 await 之前”？

- 这样 UI 能在最短路径内收到状态更新，避免“点了发送但没有反馈”的体感延迟

### 3.2 Main 侧广播：onStatusChange → IPC `agent:status`

实现位置：`src/main/index.ts`

当 `PromptHandler` 触发 `events.onStatusChange` 时，主进程会组装并发送：

- `runningSessions`: 当前有多少 session 的 agent 子进程在跑
- `sessionIds`: 正在运行的 session 列表
- `processingSessionIds`: 正在处理请求的 session 列表

并通过 IPC `IPC_CHANNELS.AGENT_STATUS`（即 `agent:status`）广播给 renderer。

对应类型：`src/shared/electron-api.d.ts` 的 `RunningSessionsStatus`：

```ts
export interface RunningSessionsStatus {
  runningSessions: number
  sessionIds: string[]
  processingSessionIds: string[]
}
```

### 3.3 取消（Stop）与 processing 的关系

取消请求走的是 ACP 的 `cancel`：

- `src/main/conductor/PromptHandler.ts`：`connection.cancel({ sessionId: agentSessionId })`

注意：

- “点击 Stop”并不意味着立刻从 processing 变为 false
- processing 的清除点仍然是 `send()` 的 finally（也就是 prompt promise 完成/失败之后）

如果你要在别的项目复用，建议保留这种语义：**cancel 只是发出中断信号，最终状态由请求生命周期收敛**。

---

## 4. Renderer 侧：isProcessing 如何计算、如何避免串线

### 4.1 Preload 暴露事件：`onAgentStatus`

实现位置：`src/preload/index.ts`

preload 把 IPC `agent:status` 封装成：

- `window.electronAPI.onAgentStatus((status) => { ... })`

### 4.2 useApp：把 status 变成 UI 可用的 `isProcessing`

实现位置：`src/renderer/src/hooks/useApp.ts`

关键点：

- `runningSessionsStatus.processingSessionIds` 是 **Multica sessionId** 列表
- 所以 `isProcessing` 的判断是：

```ts
const isProcessing = currentSession
  ? runningSessionsStatus.processingSessionIds.includes(currentSession.id)
  : false
```

这点很容易踩坑：在 ACP 消息流里（`agent:message`）用的是 **ACP sessionId**，但 processing 用的是 **Multica sessionId**。两者混用会导致“永远显示 thinking / 永远不显示 thinking”。

---

## 5. ChatView：何时渲染 “Agent is thinking…”

实现位置：`src/renderer/src/components/ChatView.tsx`

ChatView 的逻辑可以概括为：

1. 如果有 permission request（等待用户选择 allow/deny），优先显示 permission UI
2. 否则如果 `isProcessing===true`，显示 “Agent is thinking…” + 动画

对应代码结构（简化）：

```tsx
{currentPermission && <PermissionRequestItem request={currentPermission} />}

{isProcessing && !currentPermission && (
  <div className="flex items-center gap-2 text-muted-foreground">
    <LoadingDots />
    <span className="text-sm">Agent is thinking...</span>
  </div>
)}
```

这个“permission 优先级更高”的设计很实用：当 agent 正在等用户授权时，不要让“thinking”误导用户以为系统卡住。

---

## 6. 动画细节：三点跳动（staggered bounce dots）

### 6.1 Multica 的实现：Tailwind `animate-bounce` + animationDelay

实现位置：`src/renderer/src/components/ChatView.tsx`（`LoadingDots()`）

核心思想：

- 用 3 个小圆点
- 每个圆点都用同一个 bounce 动画
- 通过 `animation-delay` 错开时间，形成“轮流跳动”的节奏

组件简化版：

```tsx
function LoadingDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" style={{ animationDelay: '0ms' }} />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" style={{ animationDelay: '150ms' }} />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" style={{ animationDelay: '300ms' }} />
    </span>
  )
}
```

几个值得复用的小点：

- `bg-current`：让点的颜色跟随父级文字颜色（适配暗色/浅色主题）
- `inline-flex gap-1`：点与点之间间距稳定，不受换行影响
- `animationDelay`：用内联 style 最直观，也能很容易参数化

### 6.2 不用 Tailwind 时的可移植 CSS 版本

如果你不想依赖 Tailwind 内置动画，可以直接用 CSS keyframes：

```css
.dots {
  display: inline-flex;
  gap: 4px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: currentColor;
  animation: dot-bounce 1s infinite;
}
.dot:nth-child(2) { animation-delay: 150ms; }
.dot:nth-child(3) { animation-delay: 300ms; }

@keyframes dot-bounce {
  0%, 100% { transform: translateY(-30%); }
  50% { transform: translateY(0); }
}
```

对应 HTML/JSX：

```html
<span class="dots" aria-label="Thinking">
  <span class="dot"></span>
  <span class="dot"></span>
  <span class="dot"></span>
</span>
```

建议加上：

- `aria-label="Thinking"` 或屏幕阅读器文案
- 或用更完整的 `role="status"` + visually hidden 文本（看你的可访问性要求）

---

## 7. 可复用的工程化建议（从 Multica 的实现抽象出来）

### 7.1 用“计数”替代 “Set/boolean”（防止并发 re-entrancy）

Multica 当前用 `Set<sessionId>` 就够用，因为 UI 会禁用输入（同一 session 通常不会并发发多次 prompt）。

但在更复杂系统里，可能会出现同一会话并发请求（比如后台自动补问、并行工具等）。此时建议把：

- `Set<sessionId>`

升级成：

- `Map<sessionId, inFlightCount>`

规则：

- 每次开始 `+1`
- 每次结束 `-1`（finally）
- `count>0` 才认为 processing

### 7.2 “正在思考”不应该覆盖“等待用户操作”

Multica 的一个关键体验点是：

- 有 permission request 时优先显示 permission UI
- “thinking”只是没有其它交互需要用户介入时的状态提示

你在别的项目里也可以抽象成一个优先级：

1. blocking user action（权限/确认/输入）
2. processing（等待模型/工具执行）
3. idle

### 7.3 UI 与协议 ID 分层：避免把 ACP sessionId 当作 UI sessionId

在 Multica：

- ACP 消息流（`agent:message`）用 ACP sessionId（用于过滤消息归属）
- processing 状态（`agent:status`）用 Multica sessionId（用于 UI 会话维度）

其它项目即使不用 ACP，也建议保持类似的分层：**协议层 ID 与产品层会话 ID 分离**，否则后期加“会话恢复/迁移/重连”会很痛苦。

---

## 8. 你在别的项目里最小复刻（Checklist）

1. 后端（或中间层）维护 `inFlight` 状态（按会话维度）
2. 请求发起时立刻置为 processing，并通知前端
3. 请求结束（success/error/cancel 收敛）时清除 processing，并再次通知
4. 前端订阅 status，计算 `isProcessing`
5. UI：在消息列表底部（或输入框附近）渲染 “thinking” + 轻量动画（例如三点 bounce）

