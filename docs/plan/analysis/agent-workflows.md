# 应用层协作交付分析

状态：设计阶段；尚未开始实现。唯一目标契约见 [协作方案](../../collaboration/README.md)。2026-10-05 按用户确认改为声明式流程：自然语言 → 结构化流程 → WorkflowEngine 解释执行 + Aegis Host；01–06 评审的约束保留为 Host 语义。

## 模块任务（M0）

| 阶段 | 责任与目标路径（拟新增除注明外） | 输入 → 输出 | 前置与验证 |
|---|---|---|---|
| W：流程定义与引擎 | `src/workflow-engine/{spec,convert,authorize,validate,engine,testing,templates}/`；独立 `tsconfig`（无 DOM/Node 类型）约束依赖方向。**已完成：**`spec/`、`convert/`、`authorize/` 及 `verify:workflow-engine` | 交换格式 → 树形流程；流程 JSON → 校验结果；已校验流程 → 步骤调度、实例键、输入指纹、续跑复用、预算 | 不依赖 Electron；交换格式与树形互转（`parent` 校验、无环、字段与 kind 匹配）；FakeWorkflowHost 覆盖顺序/parallel/repeat/if/ask/stop 语义、§4.3 引用解析、`reviewLoop` 宏展开与全部裁决收敛规则、静态校验的拒绝与警告、续跑时指纹一致才复用（含续用会话的前序链） |
| A：执行接口 | `src/electron/libs/session-execution-service.ts`；现有 `ipc-handlers.ts`、`agent-loop.ts`、`runner.ts`、`provider/types.ts` | 执行规格/轮次 → 有身份的 receipt、消息、`tool_denied`、`turn_settled`、停止与权限事件 | 先对现有行为做回归；真实 Claude/Codex 续轮、`tools` allowlist 与 PreToolUse hook 在 allow 规则和 bypass 模式下生效、轮末进程组收尾、Agent runtime 进程身份记录、错误、停止、迟到事件 |
| H：Aegis Host | `src/electron/libs/workflow/{host,store,service,member-configs}.ts` | 叶子步骤 → 执行、实例持久化、结果校验、finding 指纹、验收判定；IPC 传入的权限模式 → 成员配置清单 | 依赖 W、A；基础去重（requestId、instanceKey、租约唯一）、结果互斥规则、格式修复一次、权限模式经 IPC 传入并校验、未传入时用应用默认并标记、重启标 interrupted 且旧代际执行资源确认结束前阻止派发 |
| D：目录与验收 | `src/electron/libs/workflow/{workspace-coordinator,artifact-store,snapshot-copy,check-executor,check-authorization}.ts`；现有 `git-turn-snapshot.ts`、`git-service.ts`、`worktree-threads.ts` 的窄扩展 | 写入/snapshot/check 步骤 → 租约、严格快照、G0–G4、只读副本与 diff、检查命令授权、`snapshotIn/Out` 检查证据；运行目录（当前目录 / 隔离副本） | 依赖 A、H；检查命令自动授权与高亮分类、运行中 argv 与授权逐字一致、G0“采用并继续”、隔离副本的创建与 Apply/丢弃、命令进程组停止与重启识别、dirty/untracked、快照与 diff 失败、步骤间外部编辑、副本被写入、残留进程写入在关卡前被发现 |
| P：Planner | `src/electron/libs/workflow/planner.ts`、规划模型设置项、`scripts/` 下的 Planner 离线评估集 | 自然语言 + 交换格式 Schema + 成员配置清单 + 模型枚举 → 交换格式 | 依赖 W；交换格式 Schema 被 Claude 与 Codex 原生结构化输出接受（2026-10-05 已用 `scripts/probe-workflow-planner-schema.ts` 实测通过）；无原生结构化输出的 Provider 走末段 JSON；修复一次、`source`/`unsupported`/`assumptions` 标注；离线评估集（15–20 条）在每个可担任 Planner 的 Provider 上的通过率作为完成条件，在 E 之前完成 |
| E：产品接线 | `src/electron/ipc/workflows.ts`、`src/ui/store/useWorkflowStore.ts`、`src/ui/components/workflow/*`；现有 App.tsx、PromptInput、ChatPane、Sidebar、WorkspaceHost、SubagentPanel、AssistantWorkstream、utils/right-utility-tabs.ts、store/useAppStore.ts 及其面板持久化工具、store/layout-tree.ts、store/layout-adapter.ts、ui/types.ts、shared/types；`session-store.ts` 的 `hidden_from_threads`、`src/electron/remote/integration.ts` 等会话枚举点 | 输入/操作 → 计划卡（运行目录、成员与权限来源、验收、检查命令与授权、unsupported/assumptions、步骤树、警告）、同项目普通会话的协作提示、完整步骤胶囊、右侧详情、findings 视图、权限、`needs_input`、中断恢复 | 依赖 H、D、P；启动 IPC 携带各 Provider 解析后的权限模式；实际 IPC/SQLite/runtime/renderer 贯通，session/workflow/draft owner 迁移、layout 迁移、成员会话隐藏、窄窗口与重启 |
| C：Provider 一致性 | 各适配器（含 Claude 原生 runtime）新增 `workflowCapabilities` 声明；每个 Provider 一组真实 runtime 一致性测试 | 适配器 → 经测试证明的能力与可担任角色 | 依赖 A；覆盖 §6.2 每项能力：只读角色写文件/执行命令/可写 MCP 被拒，`permissionGatedWrites` 无自动放行路径，implementer 后台执行被拒、主轮结束后无存活子执行，停止可确认。M0 至少完成 Claude、Codex 与一个审批型 Provider；其余逐个补齐，不改引擎 |
| F：旧路径退出 | 现有 delegate 三模块、runner/ipc 注入和配置注册 | 旧调用 → 停止新注册、会话级排除、只读历史 | 新链路先在开发条件下成立；发布前无旧路径回退；配置不变与历史查看 |

建议顺序：W 与 A 并行起步（W 完全不依赖 Electron，可先用 FakeWorkflowHost 把编排语义做实）；P 在 W 的 Schema 稳定后开始，可先用真实模型离线评估生成质量；H、D 接上真实执行；E、F 最后贯通。阶段是内部顺序，不代表每阶段都可独立宣称产品完成。

## M1 项

| 项 | 涉及路径 |
|---|---|
| 运行中调整：新版本流程按键与指纹复用实例 | planner、engine 续跑、计划卡差异视图 |
| 仓库流程 `.aegis/workflows/`、命名成员配置、检查命令“项目内记住” | spec loader、设置页、check-authorization |
| “交给协作” | Composer、Planner 输入 |
| 重启后重连活跃执行 | Host、执行端口 `observe` |
| 多写入者 + worktree + 集成步骤 | WorkspaceCoordinator、`worktree-threads.ts` |
| 方案竞赛、问答模式的真实验收 | E2E |
| iPhone Run 视图与远程权限应答 | `src/electron/remote/*`、`apps/ios` |
| 旧配置迁移清理界面 | 迁移检测与原子写入模块、设置页 |
| 视真实使用评估：沙箱脚本高级模式 | 需满足复审 05 对脚本方案的全部要求 |

## 必须验证的集成关系（M0）

1. Composer 协作提交（携带 requestId 与各 Provider 权限模式） → typed IPC → 成员配置清单 → Planner → 交换格式 → 转换 → SpecValidator → 检查命令授权分类 → 计划卡 / 直接开始；重复提交返回已有 Run；原单 Agent 入口不误入工作流。
2. Engine 叶子步骤 → Host → 实例 `prepared`（含输入指纹） → SessionExecutionService.prepare（角色工具策略、成员配置的权限模式） → dispatch；早到事件也有归属。
3. Host → runAgentLoop → Claude 原生 runner 与各 ProviderAdapter 的真实路径；按成员角色与该 Provider 经证明的手段落实只读与后台限制（allowlist/hook、只读沙箱、审批自动拒绝、只读模式）。
4. 写入步骤：G0 → 执行 → 消息持久化 → 有 turn 身份的完成事件 → 收尾 → `turn_settled` → 快照 + G1 → ResultValidator → 实例 `settled` → 后续步骤可引用。
5. `check` → 授权核对（argv 与授权逐字一致） → CheckExecutor（租约、进程组） → `snapshotIn/Out` → G2 → 证据；snapshot 步骤 → 只读副本与 diff → 副本完整性校验 → G3 标记。
6. `reviewLoop`：findings → Host 指纹与 `workflow_findings` → 修复步骤（原会话续轮） → 新版本 → 复审带上一轮问题 → 逐条状态 → 收敛或 `needs_input` → 流程结束 → G4 → 验收判定。
7. 权限请求 → 工作流成员 UI → 原执行 request；不能应答到其他实例或旧轮次。
8. 暂停/取消 → 持久化控制意图 → Agent 与 command 两类执行停止并收尾 → 确认后释放租约；失败与 unknown 单独显示。
9. 应用重启 → Run 标 interrupted → 按应用代际核对 Agent runtime 进程与检查进程组 → 确认结束或终止有所有权证据的进程，无法确认则保持阻止 → 重新捕获目录 → 续跑（指纹一致才复用）或结束。
10. 旧 MCP 注入与配置写入退出 → 新 session 不暴露旧工具 → 历史 delegate 胶囊仍可查看。
11. 焦点 leaf → session/workflow/draft dock owner → 带 runId/instanceKey 的 member target → 经归属校验的真实 session 日志；视觉复用 SubagentPanel，数据不伪造旧 tool_use；多 Run/多 pane/重启隔离。
12. 成员会话 `hidden_from_threads` → 侧边栏、搜索、iPhone 列表与通知均不把成员当普通会话展示。
13. 运行目录为隔离副本 → worktree-threads 创建副本 → 流程在副本中执行 → 结束后 Apply to project 或丢弃；当前目录运行时，同项目普通会话显示提示，其写入由 G0 发现。

这些是集成验收，不以 mock 的方法被调用过替代。FakeWorkflowHost 测试覆盖编排语义，真实 runner 测试覆盖 runtime 语义，实际 Electron UI 测试覆盖用户可见流程。

## 发布前的能力验证关口

- 交换格式 Schema：Claude Agent SDK 的 `outputFormat` 与 Codex 的结构化输出都接受同一份 Schema（非递归、封闭、全部 required、无数值约束）。
- Planner：离线评估集在每个可担任 Planner 的 Provider 上的一次通过率（原生结构化输出与末段 JSON 分开统计）；`unsupported`/`assumptions` 是否如实填写；生成结果是否符合原意。
- 成员配置：各 Provider 的权限模式能由渲染进程可靠解析并随 IPC 传入（注意开发态与打包后 localStorage 分属不同 origin），并原样施加到成员会话。
- 检查命令授权：项目脚本识别（包管理器与 `package.json` 脚本）的准确性；高亮规则覆盖常见下载执行形式。
- Claude：`tools` allowlist 与 PreToolUse hook 在用户 settings 含 allow 规则、`bypassPermissions`、用户插件与 hook 存在时仍生效；`settingSources` 不能重新引入被排除的工具或可写 MCP。不使用 `canUseTool` 承担限制。
- Codex：关闭多 Agent 与后台执行的配置项、reviewer read-only sandbox 是否足以满足角色要求；用户 MCP 与 shell 是否可绕过。
- 审批型 Provider（Kimi、Grok、Devin、OpenCode、Qoder、Bubble、DeepSeek）：需要审批的权限模式下是否存在自动放行（内置白名单、yolo/auto、用户配置）；原生子 Agent 是否在本轮内结束；只读模式是否在 runtime 层阻止写入。Pi 暂未见权限请求事件，需先确认是否有只读手段。
- 两个 runtime 的结束/停止/权限事件可可靠归属到轮次；不能拿 ProviderSessionStatus 代替执行身份。
- 轮末收尾能定位并清理本执行登记的进程组；关卡前已发生的脱离写入被发现，之后的写入不影响被验收版本 R(n) 的记录。
- Agent runtime 进程（Claude CLI 子进程、Codex app-server）的 PID、启动时间与应用代际能可靠记录，重启后可核对是否仍存活。
- 审查副本只固定输入，不是沙箱；reviewer 以绝对路径写原项目必须被工具限制或沙箱拒绝。
- CheckExecutor 有独立的执行身份、进程组观察/停止与重启核对。
- 严格快照服务替换现有宽松返回；副本导出与 diff 生成失败不能静默。
- SessionExecutionService 抽取范围以 Host 需要为限；保留现有权限、usage、resume、stop lifecycle，不全量改造 IPC 文件。

## 实施时的工作区约束

设计盘点时主工作区已有 IPC、设置页和 remote companion 的未提交修改。后续实现先确认最新状态，保留这些修改，按文件职责分阶段交付，不依据本分析的旧行号覆盖文件。

本轮只产出设计文档，不运行 Provider、不改用户配置、不安装依赖、不创建实现分支或提交。实施启动后按本目录约定建立具体 task 文件及相应验证任务。

## 设计评审

- [独立初评 01](../reviews/agent-workflows-01.md)、[定向复审 02](../reviews/agent-workflows-02.md)：执行边界、检查命令生命周期、dock owner。
- [评审 03](../reviews/agent-workflows-03.md)：静止证明不可达、`canUseTool` 不可靠、首版范围、审查副本、收敛与 schema。
- [复审 04](../reviews/agent-workflows-04.md)：副本不是沙箱、关卡只发现已发生的变化、重启须确认旧执行停止、M0 基础去重。
- [复审 05](../reviews/agent-workflows-05.md)：针对 JS 脚本版本；4 个 blocking 与 5 个 P2、3 个 P3。改为声明式后：调用键错位与 QuickJS 变体问题不再存在（步骤实例键显式、无脚本执行）；写入缓存加入工作区版本指纹（§5.3）；权限来自成员配置（§3.2）；恢复声明式验收（§6.4）；新增 G0、G3 改为逐步标记；引用数据防注入；M0 真实验收收窄；检查拆 `snapshotIn/Out`；P3 各项已纳入。
- [复审 06](../reviews/agent-workflows-06.md)：声明式版本的复审；changes requested，2 个 blocking（递归与开放映射的 Schema 不被 Claude 结构化输出支持、模型生成的检查命令由应用直接执行而无授权）与 4 个 P2、3 个 P3。主方案已按其修订：交换格式（§4.7）、检查命令授权（§6.7）、权限模式经 IPC 传入（§3.2）、运行目录选择与 G0“采用并继续”（§3.6、§6.4）、`unsupported`/`assumptions`（§3.3）、引用解析（§4.3）、续用会话指纹、以 `previousFindings` 为收敛信号、Planner 离线评估集。待复审确认。
