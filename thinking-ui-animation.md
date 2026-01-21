# Craft Agents：等待 Agent 回复时「思考过程」展示与动画实现分析

> 这份文档聚焦 **UI 上“正在思考/执行中”的可视化**：为什么在等待回复时会出现 *Thinking... / Preparing response... / Streaming...*、工具步骤列表、以及这些元素的动画是如何实现的。  
> 说明：这里展示的“思考过程”主要是 **工具执行轨迹 + 中间态（intermediate）评论文本**，并不是把模型的原始 chain-of-thought 逐字输出到界面。

---

## 1. 你在界面上看到的“思考中”到底是什么

在 Electron App 的聊天界面里，当你发送消息后，通常会看到一个 **TurnCard**（一次 assistant 回合）在不断更新：

- **步骤列表（Activities）**：每个工具调用（tool_use）会变成一行，带有执行中/完成/错误的状态图标。
- **Thinking... 行**：当没有正在运行的工具、也还没到展示最终回复文本的时机时，会出现一个 “Thinking...” 的占位行。
- **Preparing response... 行**：当最终回复已开始流式传输，但 UI 仍在“缓冲”（为了避免闪烁/半句就展示），会显示 “Preparing response...”。
- **Streaming...**：当最终回复文本已展示并持续流式更新，回复卡片底部会显示一个 “Streaming...” 的小状态条。

这些都不是“额外的后台黑魔法”，而是 **对流式事件的不同阶段做了 UI 映射**。

---

## 2. 从 SDK 到 UI：事件流（Streaming Pipeline）

整个“等待中动态更新”的链路可以分成 4 层：

1) **Agent/SDK 层**（`packages/shared`）
- `CraftAgent` 对 Anthropic/Claude Agent SDK 的流式输出做解析，把 SDK stream 事件转换成项目内部的 `AgentEvent`：
  - `text_delta`：文本增量
  - `text_complete`：一段文本块结束（会附带 `isIntermediate`）
  - `tool_start` / `tool_result`：工具开始/结束

关键位置：
- `packages/shared/src/agent/craft-agent.ts`
  - `convertSDKMessage(...)`：把 SDK message/stream_event 变成项目的 `AgentEvent`
  - **用 `message_delta.delta.stop_reason` 判定 `isIntermediate`**：`stop_reason === 'tool_use'` 视为中间态文本（后续还有工具/更多工作）

2) **Electron Main 层（SessionManager）**（`apps/electron/src/main`）
- Main 进程负责：
  - 把 `AgentEvent` 记录到 `managed.messages`（可持久化）
  - 通过 IPC 把事件推送到 renderer（界面实时更新）
  - **对 `text_delta` 做 batching**，避免每秒 50+ 次 IPC 导致卡顿

关键位置：
- `apps/electron/src/main/sessions.ts`
  - `processEvent(...)`：处理 `text_delta` / `text_complete` / `tool_*` 等事件
  - `queueDelta(...)` / `flushDelta(...)`：把多个 `text_delta` 合并后每 ~50ms 发一次 IPC（减少渲染压力）

3) **Electron Renderer 状态机（Event Processor）**（`apps/electron/src/renderer/event-processor`）
- renderer 收到 IPC 事件后，用纯函数把 session state 更新成新的引用，驱动 React 重新渲染。
- `text_delta` 会创建/更新一条 `role: 'assistant'` 的“流式消息”，并标记：
  - `isStreaming: true`
  - `isPending: true`（**关键：此时还不知道它最终是不是 intermediate**）
- `text_complete` 会把这条消息 finalize：
  - `isStreaming: false`
  - `isPending: false`
  - `isIntermediate: true/false`（来自 main/agent 的判定）

关键位置：
- `apps/electron/src/renderer/event-processor/handlers/text.ts`
  - `handleTextDelta(...)`
  - `handleTextComplete(...)`
- `apps/electron/src/preload/index.ts`
  - `onSessionEvent(...)`：renderer 通过 preload API 订阅 `session:event`

4) **UI 组件层（TurnCard / Turn Utils）**（`packages/ui`）
- `packages/ui` 把扁平的 `Message[]` 转成“按回合聚合”的 Turn 结构：
  - 工具消息 → activities（列表）
  - assistant 的 intermediate/pending → 也作为 activities（显示“过程”）
  - assistant 的最终非 intermediate → response（最终回复卡片）

关键位置：
- `packages/ui/src/components/chat/turn-utils.ts`
  - `groupMessagesByTurn(...)`：分组、决定哪些是 activity，哪些是最终 response
  - `deriveTurnPhase(...)` / `shouldShowThinkingIndicator(...)`：决定何时显示 “Thinking...”
- `packages/ui/src/components/chat/TurnCard.tsx`
  - 负责渲染 activities 列表、Thinking/Buffering 指示、以及 ResponseCard（最终回复）

---

## 3. “中间态文本（intermediate）”是如何产生并展示的

### 3.1 生成：用 stop_reason 判定中间态

在 `CraftAgent` 中：

- SDK 在流式过程中会不断发 `content_block_delta(text_delta)`，但此时 assistant message 的 stop_reason 还未确定。
- 当 SDK 发出 `message_delta` 时，才会带上真实的 `stop_reason`。
- 本项目的策略是：
  - 如果 `stop_reason === 'tool_use'`：说明这段文本只是“工具前的评论/铺垫”，后面还有工具调用和更多内容 → `isIntermediate = true`
  - 否则：认为是最终回复 → `isIntermediate = false`

对应代码：
- `packages/shared/src/agent/craft-agent.ts`：`convertSDKMessage(...)` 中处理 `message_delta` 并 `events.push({ type: 'text_complete', isIntermediate })`

### 3.2 传输：renderer 先显示“pending”，后补上 intermediate/最终判定

renderer 在 `text_delta` 阶段会创建一条 `assistant` 消息并标记 `isPending: true`（因为还没收到 `text_complete`）：
- 这能让 UI 立刻进入“工作中”的状态，而不是等到 `text_complete` 才出现任何反馈。

对应代码：
- `apps/electron/src/renderer/event-processor/handlers/text.ts`
  - `handleTextDelta`：创建 `isStreaming + isPending` 的消息
  - `handleTextComplete`：补齐 `isIntermediate`，并取消 pending/streaming

### 3.3 渲染：pending/intermediate 都作为 activity 展示

在 UI 分组逻辑里：

- `message.isIntermediate || message.isPending` → 作为 `ActivityItem`（`type: 'intermediate'`）
- pending 状态的 intermediate activity 会被标记为 `status: 'running'`

这样 UI 就能在“尚未决定是否 intermediate”时，也先把它当作“过程”来展示。

对应代码：
- `packages/ui/src/components/chat/turn-utils.ts`：`groupMessagesByTurn(...)` 中对 `assistant` 消息的处理

在 TurnCard 中：
- intermediate activity 如果是 `running`，不会直接显示半截文本，而是统一显示 `Thinking...`（避免文本抖动/闪烁）。

对应代码：
- `packages/ui/src/components/chat/TurnCard.tsx`：`ActivityRow` 中 `activity.type === 'intermediate'` 分支

---

## 4. 为什么有时是 “Thinking...”，有时是 “Preparing response...”

这是两个不同阶段的占位文案：

### 4.1 TurnPhase：把“回合状态”做成可推导状态机

`deriveTurnPhase(...)` 用 turn 的数据推导出状态：

- `complete`：turn 明确完成
- `streaming`：最终 response 正在流式输出
- `tool_active`：存在 **type=tool 且 status=running** 的 activity（真正的工具执行中）
- `awaiting`：有 activities，但没有 running tool（典型：工具刚完成，下一步还没出现 → “空档期”）
- `pending`：还没有 activities（刚开始）

对应代码：
- `packages/ui/src/components/chat/turn-utils.ts`：`deriveTurnPhase(...)`

### 4.2 Thinking 指示：覆盖“无可见输出的空档期”

`shouldShowThinkingIndicator(...)` 在这些情况下会返回 true：

- `pending`：刚开始，没任何 activity
- `awaiting`：工具都结束了，但最终回复还没出现（或下一个动作还没出现）
- `streaming && isBuffering`：最终回复已开始流式，但仍处于缓冲期（见下节）

对应代码：
- `packages/ui/src/components/chat/turn-utils.ts`：`shouldShowThinkingIndicator(...)`
- `packages/ui/src/components/chat/TurnCard.tsx`：根据 `isBuffering` 决定显示 `Preparing response...` 还是 `Thinking...`

> 这里的关键点是：**显式建模了“awaiting（空档期）”**，避免工具刚结束时 UI 没东西可渲染导致“卡片消失”的体验问题。

---

## 5. 最终回复为什么会“延迟出现”（Buffering / Smart Gating）

很多流式输出会先吐一些零碎的前缀或半句话，如果立即渲染，会导致：
- 文本快速跳动
- Markdown 解析频繁触发，性能差

因此 `ResponseCard` 做了“智能缓冲”策略：

- 至少等待 `MIN_BUFFER_MS`（500ms）
- 如果检测到结构化内容（代码块/标题/列表/疑问句）且达到较低词数阈值，会更快放开
- 最迟 `MAX_BUFFER_MS`（2.5s）且有一定词数就放开

对应代码：
- `packages/ui/src/components/chat/TurnCard.tsx`
  - `BUFFER_CONFIG`
  - `shouldShowContent(...)`
  - `isResponseBuffering(...)`

当 `isBuffering === true` 时：
- TurnCard 不渲染 ResponseCard
- 而是在 activities 列表底部渲染一行带 spinner 的 `Preparing response...`

---

## 6. 动画与“等待感”是怎么做出来的（用到的技术）

### 6.1 Spinner：纯 CSS Keyframes（3x3 grid）

项目的 spinner 不是 GIF，也不是 Canvas，而是：
- 9 个小方块（`spinner-cube`）
- `@keyframes spinner-grid` 做缩放
- 不同 nth-child 延迟实现错位跳动
- `currentColor + em`：自动继承颜色和字号，适配各种 UI 位置

对应代码：
- React 组件：`packages/ui/src/components/ui/LoadingIndicator.tsx`（`Spinner`）
- 样式：
  - `packages/ui/src/styles/index.css`（`.spinner`, `.spinner-cube`, `@keyframes spinner-grid`）
  - Electron 侧也有一份：`apps/electron/src/renderer/index.css`（同名样式）

### 6.2 TurnCard 动画：`motion`（Framer Motion）做过渡与分段入场

TurnCard 使用 `motion/react`：
- 折叠/展开：高度从 `0 → auto` + 透明度渐变（`AnimatePresence` + `motion.div`）
- 列表项入场：每条 activity 用 `x: -8 → 0` + `opacity: 0 → 1`
- Stagger：前 N 条按 `index * 0.03` 递增 delay
- Chevron 旋转：`rotate: 0 ↔ 90`
- 预览文案 crossfade：previewText 变化时用 `AnimatePresence` 做淡入淡出

对应代码：
- `packages/ui/src/components/chat/TurnCard.tsx`

### 6.3 性能优化：保证动画与流式渲染不互相拖垮

为了让动画在频繁 streaming 时仍然顺滑，项目做了两层优化：

1) **IPC batching（Main 进程合并 text_delta）**
- `apps/electron/src/main/sessions.ts`：`queueDelta`/`flushDelta`，把 delta 合并后再发，减少 renderer 压力

2) **Markdown 渲染节流（ResponseCard 每 300ms 更新一次显示文本）**
- `packages/ui/src/components/chat/TurnCard.tsx`：`ResponseCard` 内部用 `displayedText` + `CONTENT_THROTTLE_MS`
- 避免每个字符都触发一次 markdown 解析与重排

此外：
- `TurnCard` 对已完成回合做 `React.memo`，避免切换 session 或新增消息时重渲染历史卡片
  - `packages/ui/src/components/chat/TurnCard.tsx` 底部 memo 比较函数

---

## 7. 相关代码索引（从“现象”反查入口）

如果你想快速从某个 UI 现象定位实现：

- “Thinking.../Preparing response...” 行：
  - `packages/ui/src/components/chat/TurnCard.tsx`（`isThinking` + `Spinner` + 文案）
  - `packages/ui/src/components/chat/turn-utils.ts`（`deriveTurnPhase` / `shouldShowThinkingIndicator`）
- intermediate 文本（工具前评论）的出现/隐藏策略：
  - `packages/shared/src/agent/craft-agent.ts`（stop_reason → `isIntermediate`）
  - `apps/electron/src/renderer/event-processor/handlers/text.ts`（`isPending` → finalize）
  - `packages/ui/src/components/chat/turn-utils.ts`（pending/intermediate → activity）
  - `packages/ui/src/components/chat/TurnCard.tsx`（running intermediate 显示 `Thinking...`）
- 工具步骤列表与状态图标：
  - renderer：`apps/electron/src/renderer/event-processor/handlers/tool.ts`
  - UI：`packages/ui/src/components/chat/TurnCard.tsx`（`ActivityStatusIcon`）
- Spinner 动画本体：
  - `packages/ui/src/components/ui/LoadingIndicator.tsx`
  - `packages/ui/src/styles/index.css` 或 `apps/electron/src/renderer/index.css`

---

## 8. 可调参数（想改变“等待显示策略”该改哪里）

- 想让最终回复更早出现（减少 Preparing response...）：
  - 调整 `packages/ui/src/components/chat/TurnCard.tsx` 的 `BUFFER_CONFIG`
    - `MIN_WORDS_STANDARD` / `MIN_BUFFER_MS` / `MAX_BUFFER_MS` 等
- 想改变“Thinking...”判定：
  - 调整 `packages/ui/src/components/chat/turn-utils.ts`
    - `deriveTurnPhase(...)` 的规则
    - `shouldShowThinkingIndicator(...)` 的触发条件
- 想让动画更快/更慢：
  - `packages/ui/src/components/chat/TurnCard.tsx` 里 motion 的 `transition`（展开、stagger delay）
- 想减少流式带来的卡顿：
  - `apps/electron/src/main/sessions.ts`：IPC batching 间隔（`DELTA_BATCH_INTERVAL_MS`）
  - `packages/ui/src/components/chat/TurnCard.tsx`：`CONTENT_THROTTLE_MS`

---

## 9. 关于 “Thinking Level / Max Thinking” 的澄清

项目里确实有“思考等级”配置，用于 **给模型分配更多 thinking token 预算**：

- `packages/shared/src/agent/thinking-levels.ts`
- `packages/shared/src/agent/craft-agent.ts`：`maxThinkingTokens: thinkingTokens`

这会影响模型推理深度与响应耗时，但 **UI 的 “Thinking...” 并不是把这些 thinking token 的内容渲染出来**；UI 只是根据事件阶段显示一个等待/执行中的指示器。

