# Agent Workspace 设计方案

日期：2026-04-30

## 一句话结论

Aegis 应该往 **Agent Workspace** 方向演进，而不是做任务看板，也不是复刻 Discord。

核心形态是：

- Project 是工作空间。
- Channel 是上下文边界。
- Agent 是可见的协作成员，带角色、runtime、model 和权限策略。
- DM 是和单个 agent 的专门对话。
- Thread / Run 是具体执行工作的边界。
- Activity 是后续派生出来的状态聚合，不是 MVP 里的一级 `Tasks` Tab。

主体验继续保持 chat-first。用户应该能在频道里讨论问题、`@agent` 分派工作、把一条消息转成可执行 run、在线程里观察进度，并在不离开聊天的情况下完成 review。

## 关键产品判断

MVP 不做显性的 `Tasks` Tab。

我们仍然需要内部的 task/run 对象，但不应该在主界面上放一个一级 `Tasks` Tab。原因是它会把用户心智重新拉回项目管理工具：用户会觉得这里有一个任务系统需要维护。这和 Aegis 当前更适合的方向冲突。

MVP 里应该这样处理任务：

- task/run 状态存在于 message thread 里。
- channel、DM、thread card 上显示状态 badge。
- 右侧 inspector 展示当前选中 run 的细节。
- 只有当真实使用中出现“找不到正在跑的事”的痛点时，再增加 Activity / Runs / Review 聚合入口。

如果后续真的需要聚合视图，命名也建议避开 `Tasks`，优先考虑：

- `Activity`
- `Runs`
- `Review`

## 设计目标

- 让多 agent 协作变得可理解，但不让界面变重。
- 保留 Aegis 现在最重要的 chat-first 体验。
- 让用户可以通过 `@agent` 和 message-to-run 自然分派任务。
- 让 agent 执行过程可见、可检查、可暂停、可继续。
- 复用现有 session、provider、project file、browser、terminal、permission、artifact 系统。
- 第一版可以分阶段落地，不要求一次性重写架构。

## 非目标

- 不重建 Board / Kanban。
- 不复制 Discord / Slack 的社交功能。
- 不允许多个 agent 默认自由群聊。
- 不依赖 Linear / GitHub Issues 等外部 tracker。
- 不允许代码修改类工作藏在私聊里悄悄发生。
- 不要求用户先维护任务字段，才能让 agent 做事。

## 核心心智模型

### Project

Project 是顶层工作空间，通常对应一个本地 `cwd`。

Project 拥有：

- Channels
- Agent roster
- Project-level instructions
- Files / Changes / Artifacts / Browser / Terminal
- Sessions
- Run threads

### Channel

Channel 是项目里的上下文边界。

例子：

- `#all`
- `#frontend`
- `#debug`
- `#release`
- `#research`

Channel 可以定义：

- 默认文件范围
- 默认 agent roster
- 默认 instructions
- 默认 permission profile
- 相关 sessions 和 run threads

Channel 应该像一个项目讨论房间，而不是文件夹，也不是看板列。

### Agent Member

Agent 是一个可见的工作空间成员，底层由现有 runtime/provider 驱动。

建议默认角色：

- `Kabi` / `Coordinator`：协调、拆解、决定是否需要拉其他 agent。
- `Builder`：实现代码、修改文件。
- `Reviewer`：审查 diff、找风险、补测试建议。
- `Runner`：运行 build/test，整理失败日志。
- `Researcher`：代码库调研或外部资料调研，后续再加。

每个 agent 有：

- 名字和头像
- 角色
- provider/runtime
- model
- permission profile
- capability summary
- 当前状态：idle / running / blocked / waiting / offline

Agent 不只是模型。它应该是：模型 + 角色 + 默认行为 + 权限 + 可见状态。

### DM

DM 是和单个 agent 的专门对话。

适合 DM 的事情：

- 问这个 agent 能做什么。
- 调整这个 agent 的偏好。
- 做不修改代码的分析。
- 在正式执行前准备任务描述。

如果用户在 DM 里要求修改项目代码，Aegis 应该把它转成或关联到一个可见的 project run thread，避免项目状态不可追踪。

### Thread / Run

Run thread 是具体执行工作的边界。

它可以来自：

- 一条被标记为 `Run` 的消息。
- 一个需要执行的 `@agent` mention。
- agent 回复里的后续操作。

它包含：

- 用户请求
- 被分派的 agent
- 流式输出
- tool calls
- permission requests
- file diffs
- terminal output
- artifacts
- validation state
- final summary

任务语义放在 thread 里。主 channel 只展示简洁的 run card 和状态更新。

## 信息架构

### 左侧全局窄栏

保留一个窄的全局入口栏：

- Workspace / Chat
- Agents
- Skills
- Prompts
- Settings

这里不要重新放 Board。

### 项目侧边栏

主 sidebar 变成 project-oriented：

- 当前 project
- Search
- Channels
- Direct Agents
- Recent activity / pinned threads

建议默认结构：

```text
PROJECT
  coworker

CHANNELS
  # all
  # frontend
  # debug
  # release

DIRECT AGENTS
  Kabi        idle
  Builder     running 1
  Reviewer    idle
  Runner      blocked 1
```

badge 表示未解决的执行状态，不是社交软件里的 unread message。

### 主区域

主区域仍然是 conversation。

顶部：

- Channel / DM 名称
- 简短上下文描述
- 活跃 agent 数量
- context/settings action
- inspector toggle

时间线：

- 用户消息
- agent 消息
- mention events
- run cards
- permission cards
- diff / artifact / validation summaries

输入区：

- Message input
- attachment / context controls
- `@agent` autocomplete
- run mode toggle
- assign-to selector
- send button

第一版不要放 `Chat / Tasks` tabs。

### 右侧 Inspector

右侧应逐步变成 contextual inspector。它可以复用并扩展当前 files / changes / browser / terminal 面板。

状态：

- 默认：workspace context
- 选中 agent：profile / capabilities / status / recent runs
- 选中 run：status / assignee / diff / validation / terminal / artifacts
- 选中文件：file preview / edit
- 打开 browser：browser panel

这样可以把细节放在右侧，主聊天保持清爽。

## 核心交互流

### 1. 默认进入 `#all`

用户打开一个项目时，Aegis 自动创建或选择 `#all`。

第一阶段里，Channel 先直接对应一个 chat session。也就是说，用户新建 channel 的体验应该等价于过去新建 `New Chat`：创建后点进 channel 就能开始聊，channel 下不要再展开第二层 chat 列表。

现有 sessions 不应该被折叠到 `#all` 下面。迁移时可以把每个现有 session 渲染成一个 channel row；如果多个旧 session 共享同一个 channel id，则用 session title 作为可辨识的 channel 名称。

用户第一天使用时，不需要理解 channel 系统，也能继续按现在的方式聊天。

### 2. `@agent`

用户输入：

```text
@Reviewer 看一下这个 diff 有没有明显风险
```

系统行为：

- 解析 `Reviewer`。
- 创建一个和当前 channel 关联的 agent run。
- 结果出现在当前 timeline。
- 如果需要工具调用或长时间执行，则生成 run thread。

### 3. 从消息启动 Run

用户写完需求后开启 run mode。

系统行为：

- 创建 `RunThread`。
- 分派给用户选择的 agent，或者默认 coordinator。
- 在 channel 中显示一个 compact run card。
- 执行过程在 thread 里流式展示。
- run card 状态随着执行更新：running / blocked / review / done / failed。

### 4. Review 已完成的 Run

Run 完成后：

- Channel 里出现简洁完成事件。
- 右侧 inspector 展示 changed files、validation result、artifacts。
- 用户可以 accept、continue、ask reviewer、discard。

对有风险的文件修改，accept 应该保持显式。

### 5. Agent DM

用户打开 `Builder` DM。

适合动作：

- 问实现策略。
- 问它需要什么上下文。
- 调整默认行为。

如果用户要求 Builder 修改项目，Aegis 应该：

- 在最近活跃 project channel 中创建可见 run thread；或
- 让用户选择 project / channel。

## 数据模型草案

下面是概念模型，不是最终实现细节。

```ts
type AgentStatus = 'idle' | 'running' | 'blocked' | 'waiting' | 'offline';
type RunStatus = 'draft' | 'queued' | 'running' | 'blocked' | 'review' | 'done' | 'failed' | 'cancelled';

interface WorkspaceChannel {
  id: string;
  projectCwd: string;
  name: string;
  description?: string;
  defaultAgentIds: string[];
  contextRules?: ChannelContextRules;
  createdAt: number;
  updatedAt: number;
}

interface ChannelContextRules {
  fileGlobs?: string[];
  instructions?: string;
  memoryScope?: 'project' | 'channel' | 'session';
  defaultPermissionProfileId?: string;
}

interface AgentMember {
  id: string;
  projectCwd?: string;
  name: string;
  role: 'coordinator' | 'builder' | 'reviewer' | 'runner' | 'researcher' | 'custom';
  provider: 'claude' | 'codex' | 'opencode';
  model?: string;
  avatar?: string;
  status: AgentStatus;
  capabilities: string[];
  permissionProfileId?: string;
  systemInstruction?: string;
  createdAt: number;
  updatedAt: number;
}

interface RunThread {
  id: string;
  projectCwd: string;
  channelId: string;
  sourceMessageId?: string;
  parentThreadId?: string;
  title: string;
  assigneeAgentIds: string[];
  status: RunStatus;
  linkedSessionIds: string[];
  acceptanceCriteria?: string;
  latestDiffSummary?: string;
  validationState?: ValidationState;
  createdAt: number;
  updatedAt: number;
}

interface ValidationState {
  command?: string;
  status: 'not_run' | 'running' | 'passed' | 'failed' | 'skipped';
  outputSummary?: string;
  finishedAt?: number;
}
```

现有 session 不要替换掉，而是增加轻量 metadata：

```ts
interface SessionWorkspaceMetadata {
  projectCwd?: string;
  channelId?: string;
  agentId?: string;
  runThreadId?: string;
  parentMessageId?: string;
}
```

## Runtime 模型

Coordinator 是 channel 的默认入口。

MVP 不做完全自治的多 agent 规划。第一版使用显式 dispatch：

- 用户 `@agent`。
- 用户在 run mode 中选择 assignee。
- Coordinator 可以建议分派，但如果要启动昂贵或会改代码的 agent run，需要用户确认。

执行层复用现有 provider routing：

- `claude`
- `codex`
- `opencode`

新层只决定“谁来跑、在哪里展示、如何关联上下文”，不复制 provider-specific agent loop。

## 和当前 Aegis 架构的关系

当前结构应尽量保留：

- `activeWorkspace` 仍然可以保持 `chat | skills | prompts`。
- 主聊天 layout 仍然是核心产品表面。
- 现有 ProjectTree、Changes、Browser、Terminal、Permission、Artifact 都继续复用。

预计改动区域：

- Sidebar：加入 project channels 和 direct agents。
- PromptInput：加入 `@agent` autocomplete、run mode、assign-to。
- Chat timeline：加入 run card、thread anchor、agent identity rendering。
- Store：加入 channels、agents、active channel / DM、run threads。
- Electron session store：持久化 channel、agent、run-thread records。
- IPC：新增 create/list/update channel、agent、run-thread 操作。
- Right panel：升级为 agent / run / workspace 的 contextual inspector。

## 分阶段落地

### Phase 1：Channel Shell

目标：先把左侧层级收敛成 `Project -> Channel`，其中 channel 本身就是 chat session，不改变执行语义。

范围：

- 新增 `WorkspaceChannel`。
- 每个 project 自动生成 `#all`。
- 新增 `activeChannelId`。
- Sidebar 显示 channels。
- 新建 channel 会立即创建对应的 draft session。
- channel 下不再展示子 session 列表。
- 每个 project 默认展示前 5 个 channels，更多内容通过 `Show more` 展开。
- 现有 sessions 渲染为 channel rows，避免丢失历史入口。

验收：

- 打开项目后能看到 `#all`。
- 老 sessions 不丢失。
- 新建 channel 后，点击该 channel 就进入对应聊天。
- 单个 project 超过 5 个 channels 时，默认只展示前 5 个，并出现 `Show more`。
- 不引入 task/run UX。

### Phase 2：Agent Roster + DM

目标：让 agent 作为 workspace member 可见。

范围：

- 新增默认 agent profiles。
- Sidebar 显示 direct agents。
- 右侧 inspector 能显示 agent profile。
- 加入 DM 模式。
- DM 中的代码修改请求需要转到 project/channel run thread。

验收：

- 用户能看到有哪些 agent，以及它们分别负责什么。
- 用户能打开某个 agent 的 DM。
- agent identity 和 provider/model 设置不是同一件事。

### Phase 3：`@agent` Mention

目标：允许用户从 channel chat 显式分派。

范围：

- Composer 支持 `@agent` autocomplete。
- 发送时解析 `@agent`。
- 根据 agent profile 启动 linked provider session。
- Timeline 渲染 agent identity。
- Agent roster 显示 running / blocked 状态。

验收：

- `@Reviewer ...` 会走 Reviewer profile。
- 结果出现在当前 channel。
- Sidebar 能看到 agent 当前是否正在运行或阻塞。

### Phase 4：Run Thread

目标：让可执行工作可见、可 review，但不做 Tasks Tab。

范围：

- Composer 加 run mode。
- 创建 `RunThread`。
- Timeline 显示 compact run card。
- 右侧 inspector 显示 run detail。
- tool output、permission、diff、validation、artifact 都能关联到 run。

验收：

- 用户能从一条消息启动 run。
- 正在执行的 agent 有可见 thread 和状态。
- 完成后的 run 可以在 inspector review。
- 中间主聊天仍然可读。

### Phase 5：Activity / Review View

目标：只有在真实使用证明需要时，再增加聚合入口。

范围：

- 增加 Activity 入口或 command palette filter。
- 显示 running、blocked、needs review 的 runs。
- 不做 Kanban columns。
- 不默认增加一级 `Tasks` Tab。

验收：

- 用户能跨 channel 找到未解决 runs。
- 这个功能像执行队列，而不是项目管理板。

## 视觉和交互细节

### Agent Identity

Agent 消息展示：

- avatar
- name
- role badge
- provider/model 放在 hover 或 details 中
- 必要时展示 status

Timeline 不应该过度强调模型名。用户应该感知的是角色和责任。

### Run Card

Run card 应该紧凑：

```text
Builder is running
Fix settings page scroll issue

Files changed: 3
Validation: npm run build running
```

操作：

- Open details
- Pause / stop
- Continue
- Ask reviewer
- Accept / discard

### 状态语言

用执行语言，不用项目管理语言：

- Running
- Waiting for permission
- Blocked
- Needs review
- Done
- Failed

### Permission

Permission 仍然要显著。

当 permission 发生在 run thread 中：

- thread 里显示完整 permission prompt。
- channel 里显示一个 compact alert。
- 如果右侧选中了该 run，inspector 聚焦到 pending decision。

### Context

Channel context 必须可检查。

用户应该随时能回答：

- 当前 channel 关注哪些文件？
- 哪些 instructions 生效？
- 哪个 agent 被分派？
- 当前修改的是哪个 project directory？

多 agent 产品里，隐藏上下文会直接削弱信任。

## 风险与应对

### 风险：产品重新变重

应对：

- MVP 不做一级 `Tasks` Tab。
- 不做 Kanban。
- 不要求 task metadata。
- 所有执行从 chat 里自然发生。

### 风险：agent 噪音过多

应对：

- agent 不会默认发言。
- agent 只有在被 mention、被分派、或用户确认 coordinator 建议后才运行。
- 长输出折叠成 summary。

### 风险：上下文碎片化

应对：

- 从 `#all` 开始。
- channels 可选。
- 保留 project-level search。
- 后续如果引入 run thread，再考虑 channel 内部的 thread/card，而不是恢复 channel 下的 chat 列表。

### 风险：状态迁移复杂

应对：

- 保留 session 作为真实执行对象，只把 sidebar 层级改成 channel row。
- 老 session 直接显示为 channel row；重复 channel id 时使用 session title 避免多个 `#all` 无法区分。
- 不改 `activeWorkspace` 主结构。

### 风险：代码修改藏在 DM 里

应对：

- DM 可以讨论。
- 代码修改必须创建或关联 project run thread。
- run 记录 cwd、agent、diff、validation state。

### 风险：并发修改冲突

应对：

- 第一版不做并行 isolated workspace。
- 如果后续引入并行代码修改 run，必须做冲突检查和显式 merge/accept。
- 每个 run 保持一个清晰 owner。

## 待定问题

- 默认 agents 是全局模板，还是 project-local instances？
- Channel context 放在轻量 inspector 里编辑，还是单独 modal？
- Run thread 第一版是嵌在消息下方，还是优先放右侧 inspector？
- 现有 ProjectTreePanel 有多少应该升级为通用 inspector？
- `@agent` mention 是否总是启动执行，还是有些 agent 先 inline 回答？
- Composer 里的 run mode 应该叫 `Run`、`Assign`，还是 `As Run`？

## 推荐下一步

从 Phase 1：Channel Shell 开始。

这一步能先把 Discord-like agent collaboration 的底层结构放进去，但不改变 runtime 行为，也不重新引入 Board-like 产品面。

Phase 1 稳定后，再做 Agent Roster + DM。之后才进入 `@agent` dispatch 和 run thread。
