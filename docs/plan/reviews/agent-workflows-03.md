# 应用层协作方案评审 03

日期：2026-10-05。结论：**changes requested（总体方向保留；需替换不可达的静止门槛、收敛首版范围并补齐产品语义）**。

审查对象：[复审 02](agent-workflows-02.md) 判定 design pass 后的 `docs/collaboration/README.md` 与 `docs/plan/analysis/agent-workflows.md`。01、02 只审查“契约是否闭合”，每轮修订都在增加保证；本次额外审查**可实现性、首版范围与产品语义**。本报告保留原样，修订关闭情况由后续复审记录。

方法：对照当前工作区源码与 `@anthropic-ai/claude-agent-sdk` 0.3.220 类型定义静态核查；未运行 runtime、未修改应用代码或用户配置。行号为本次审查时的位置。

## P1 / blocking：“证明可写资源已静止”在 Claude 上基本不可达，且与外部编辑的处理标准不一致

**设计位置：**主方案 §3.1、§5.1（`workspace_quiescent`）、§5.2（`workspaceQuiescence`）、§5.3、§11 第 11 条。

方案要求 Agent 主轮结束后，执行服务**确认所有获准的可写资源已完成或确认停止**，才产生 `workspace_quiescent`；无法达到时“该角色接入保持未完成”。Claude 的 Bash 在 CLI 子进程内部执行，Aegis 不持有这些工具进程的 PID；`nohup … &`、`setsid`、自行 daemonize 的程序均可脱离进程组。方案自己也承认解析 `&` 不能证明静止，但没有给出可行的证明机制。按现有写法，Claude 实现者角色要么永远无法接入，要么实现时以弱检查冒充“证明”。

同时 §7.1 对外部编辑器采用的是“检测变化 → 撤销通过资格”，并不要求证明编辑器已静止。两类“验收后目录又被改”的来源用了两套标准；而版本关卡复核本身就能同时覆盖二者。

**建议修订：**改为“硬限制 + 收尾 + 检测失效”：

1. 运行时硬限制：禁用原生派生与后台执行类工具（见下一项），拒绝工具级 background 参数。
2. 每轮收尾：清理该执行登记的进程组残留；脱离进程组的进程不承诺捕获。
3. 版本关卡：在捕获快照后、检查前后、审查汇合后、宣布完成前比较当前目录与被验收版本；变化即撤销对应结论。

去掉“证明静止”作为角色接入门槛；验收改为“限制生效 + 残留写入被关卡发现”。

## P1 / blocking：Claude 的工具限制不能建立在 `canUseTool` 上

**设计位置：**主方案 §5.3（禁止原生 Task/spawn 与后台执行）、§7.1（reviewer 禁用编辑与 shell）。

`src/electron/libs/runner.ts:902` 的 `canUseTool` 只在 runtime 需要询问权限时调用。`bypassPermissions` 模式（同文件 `allowDangerouslySkipPermissions`）、用户 settings 中的 `permissions.allow` 规则都会让工具调用不经过它；而 runner 通过 `settingSources` 加载用户与项目设置，用户插件和 hook 也随之进入。仅用 `canUseTool` 实现的“只读 reviewer”或“禁止后台”在这些配置下会被静默绕过。

另外，SDK 0.3.220 的内置工具已包含 `Agent`、`Workflow`、`Monitor`、`CronCreate`、`ScheduleWakeup`、`RemoteTrigger`、`REPL` 等可派生或延后执行的工具，`Bash` 与 `Agent` 的输入都有 `run_in_background`（`sdk-tools.d.ts:504`、`:548`）。逐个列 denylist 会随 SDK 升级失效。

**建议修订：**工作流成员使用 `tools` 内置工具 **allowlist**（SDK 支持 `tools?: string[]`），reviewer 仅 `Read/Glob/Grep`；对允许的 `Bash` 用 PreToolUse hook 以 `permissionDecision: 'deny'` 拒绝 `run_in_background`（hook 不受权限模式影响）；成员的 MCP 集合由工作流显式给出，不继承用户可写 MCP。验收必须包含“用户 settings 有 allow 规则”与 `bypassPermissions` 两种配置。

## P1 / blocking：首版范围过大，核心价值尚未验证

**设计位置：**主方案 §11（“首个可交付版本必须同时包含……”）、交付分析“首版交付包含 A–F”。

首版同时要求：自然语言规划器、跨重启带进程身份的重连恢复、旧配置迁移清理界面、layout tree 与 dock owner 两处持久化迁移、9 张表（其中 `workflow_events` 与状态表构成两个真相来源，`workflow_commands` 另做命令去重）。按 [delegate MCP 方案](../../delegate-mcp-plan.md)与 [agent-first 方案](../../agent-first-plan.md)的历史，前两次多 Agent 设计都在真实使用后被大幅调整；“实现 → 双审查 → 修复 → 复审 比单 Agent 更值得”这一前提本身尚未被使用数据验证。

**建议修订：**拆为 M0 竖切与 M1：

- M0：仅模板入口；Claude/Codex；当前目录；单写入者 + 并行审查；重启后标记 interrupted、保留租约、不自动重连；旧 MCP 只停止注册和会话级排除；状态表为唯一真相，事件只做审计。
- M1：自然语言规划、`needs_information`、运行中计划修订、按代际重连、迁移清理界面、`workflow_commands` 去重。

M0 用一到两周真实任务后再决定 M1 是否值得。

## P1 / blocking：reviewer 应读冻结的快照副本，而非实时工作目录

**设计位置：**主方案 §7.1（审查窗口租约、外部编辑撤销通过）、§7.2。

目前 reviewer 在用户的实时目录读取 R1，因此需要审查窗口期独占租约；用户在审查期间改文件会使结论失效；reviewer 的只读完全依赖 runtime 策略，一旦被绕过就直接写入用户代码。R1 本身已是 Git tree，可以导出为应用拥有的只读副本：

- 审查期间不再需要占用项目目录租约，外部编辑不再影响审查有效性，只在最终完成关卡比较。
- reviewer 即使越权写入，也只写进一次性副本，失败模式无害；只读策略仍然要求，但不再是唯一防线。
- 代价：副本不含 ignored 文件（如 `node_modules`），静态审查不需要；检查命令仍在项目目录运行。

建议用“导出 tree + 完整 diff 文件”而不是 `git worktree add`，避免在用户仓库登记 worktree。

## P2：修复循环缺少收敛规则

**设计位置：**主方案 §3.2。

每个新版本都开新 reviewer 会话以保证独立，但新会话不知道上一轮提过什么、修过什么，容易提出新的细节问题，使 2 轮上限频繁触发 `needs_input`。“重复出现同一阻塞”需要识别同一问题，而 findings 的 `id` 由模型生成，跨轮不稳定，目前没有匹配规则。

**建议修订：**复审输入包含上一轮 blocking findings 与 R(n-1)→R(n) diff，要求逐条给出 resolved / unresolved；复审中新提出的 blocking finding 须落在本轮变更范围内，或注明为何此前遗漏；同一问题由程序计算指纹（role + file + category + reviewer 声明的 `supersedes`）判定。

## P2：审查裁决规则缺失

**设计位置：**主方案 §3.1、§6.4。

未定义：只有 advisory 问题却给出 `changes_requested` 时如何处理；两个 reviewer 结论或建议相互冲突时由谁汇总；实现者是否可以带理由反驳某条 finding。缺这些规则时，修复步骤收到的“聚合问题”没有确定含义。

**建议修订：**`changes_requested` 必须至少有一条 blocking finding，否则视为格式矛盾；只有 blocking findings 驱动修复，advisory 只展示；实现者可将 finding 标为 `disputed` 并附理由，由同角色复审裁决，坚持则进入 `needs_input` 交用户决定；跨 reviewer 冲突不由模型合并，原样交给实现者并在 UI 标出。

## P2：核心 schema 未定义

**设计位置：**主方案 §2.1、§5、§6.3、§6.4。

PlanCompiler 是计划校验的中心，但 `WorkflowPlan` 没有 schema；`TaskBrief` 与实现报告也只有文字描述。只有 `ReviewResult` 给出了类型。没有这些，C 阶段无法开始，也无法判断“程序填充模板”与“模型生成计划”是否真的共享同一校验。

**建议修订：**在 §6.4 补齐 `WorkflowPlan`、`TaskBrief`、`ImplementationReport`，并给出 PlanCompiler 的主要校验规则。

## P2：成员会话会出现在所有会话枚举处

**设计位置：**主方案 §9（“成员不挤入普通会话列表”）。

方案只约束了 sidebar。`src/electron/remote/integration.ts:126`、`:154` 为 iPhone 端枚举会话（当前分支正在开发的能力），另有搜索、通知、用量与会话引用。现有 `sessions.hidden_from_threads`（`src/electron/libs/session-store.ts:407`，列表查询 `:1330`、`:1453` 已过滤）可直接复用，但方案未说明是否使用，也未说明 iPhone 上如何呈现 Run、成员权限请求能否在手机上处理。

**建议修订：**明确成员会话写入 `hidden_from_threads = 1`，列出必须识别工作流的枚举点；M0 明确 iPhone 不显示 Run、成员权限请求仅在桌面处理，作为已知限制。

## P2：自然语言计划直接执行有误分配风险

**设计位置：**主方案 §2.1（“已有明确任务时直接执行并显示计划卡，不增加一轮固定确认”）。

模型整理计划可能把“Claude 检查安全”映射错角色或 Provider，直接执行会立即消耗多个会话的额度。模板入口由程序填充，风险可控；自然语言入口不同。

**建议修订：**模板入口可直接开始；自然语言计划先显示计划卡，用户一键“开始”。

## P3：文档结构

主方案主要由大量“不能/不得”约束组成，缺少一页用户视角说明，难以据此拆任务或判断产品边界。建议在开头加入产品速览（用户做什么、看到什么、首版边界），工程契约保留在后文。

## 已核实可保留

- `runAgentLoop` 仅在 ProviderService 有适配器时走 Provider，否则回退原生 runtime，Claude 未注册适配器（`src/electron/libs/agent-loop.ts:24–54`）；主方案 §4 描述准确。
- `captureGitTreeSnapshot` 失败返回 null（`src/electron/libs/git-turn-snapshot.ts:28`、`:47`），宽松错误不能用于完成门槛；§7.2 判断准确。
- 后台 Task 自行转入后台后 CLI 停止转发消息（`src/electron/libs/runner.ts:848–853`），与 01 的发现一致。
- SDK 提供 `disallowedTools`、`tools` allowlist 与 PreToolUse hook 的 `permissionDecision`，上述替代方案有实现基础，但仍须真实验证插件与用户设置不能重新引入被排除的工具。
- 应用层调度、计划即数据、三种“完成”分离、审查版本绑定、不伪造 `tool_use`、UI 复用现有胶囊与右侧详情，均应保留。
