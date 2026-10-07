# 应用层协作方案独立评审 01

日期：2026-10-05。结论：**blocked（设计契约需补齐，非否定总体方向）**。

审查对象：`docs/collaboration/README.md` 与 `docs/plan/analysis/agent-workflows.md`，包含用户刚确定的“现有 Agent 胶囊 / 任务行 + 右侧详情”视觉复用方案。本文保留首次评审结果，后续主方案修订不回写本次发现。

方法：对照当前工作区源码静态核查；未运行真实 Agent、未修改 runtime 配置或应用实现。源码本身存在用户未提交修改，以下行号是本次审查时的位置。审查重点是契约能否接上现有架构，不将拟新增模块尚不存在本身视为缺陷。

## P1 / blocking：原生后台子 Agent 未纳入“步骤已结束”的边界

**设计位置：**主方案 §3.1（81–85 行）、§5.1（150–156 行）、§7.1（235 行）；交付分析 A、D 阶段。

方案用有归属的 `turn_finished` 结算一次执行，之后冻结产物并启动测试 / reviewer，但仅移除 `aegis-delegate` 并不会禁止 Claude/Codex 自带的派生任务。实现者可能启动原生后台子 Agent，自己先返回最终结果，后台任务继续改文件。此时“单写入者结束”“3 并发 / 4 成员”和审查窗口的租约约束不覆盖这些后台执行；最终 hash 检查能发现部分变化，却不能证明后台写入者已经停止。

**源码证据：**

- `src/electron/libs/runner.ts:848–856` 显式启用原生 subagent 文本转发，并记录后台 Task 的转发限制。
- `src/ui/utils/workstream.ts:394–460` 已专门处理“主 Agent result 已到、session 已 completed，但后台 Task 仍工作”的情形；注释明确这一判断只存在于 UI，未改变主进程状态语义。
- `src/electron/libs/runner.ts:1296–1307` 当前先传递 result，再捕获 turn 快照；不能把现有 result 或快照直接作为全部后代执行已静止的证明。

**建议修订：**首版最小方案是在工作流成员的会话级策略中禁用 runtime 原生派生 Agent 和不可追踪的后台执行能力，并实际验证；保留普通会话及历史原生子 Agent 展示。若某 runtime 不支持禁用，则必须追踪其后代的执行与停止归属，只有全部可写执行已静止才产生 `workspace_quiescent`，继而允许快照和下游步骤。不要求首版实现完整嵌套编排，但必须明确选择哪一种。

**验证：**实现者尝试启动后台 Agent 后立即输出完成；确保被拒绝，或下游审查一直等待其完成 / 确认停止。取消、超时、unknown 恢复均不能遗留可写后代后释放租约。

## P1 / blocking：CheckExecutor 缺少与 Agent 同等级的执行、停止和恢复契约

**设计位置：**主方案 §5 模块图（126–132 行）、§6.4（227 行）、§7.1（235–243 行）、§8（261–268 行）；交付分析 D 阶段及集成关系 8、9。

测试命令由独立的 CheckExecutor 执行，但现有执行端口返回必需的 sessionId，停止 / observe 路径围绕 Agent runtime，数据模型没有明确 command execution 的实际进程身份和控制入口。测试命令本身可以生成文件、启动 watch 或子进程。如果用户在测试过程中取消，或主进程崩溃后恢复，单纯停止所有工作 Agent 无法说明测试进程已经停止；旧测试可能与后续修复同时写入，或迟到的退出结果被误用。记录 argv、退出码和超时不能替代这一生命周期。

**源码证据：**

- `src/electron/libs/provider/service.ts:115–127` 的 stop 仅查 Provider thread 绑定并调用 adapter，不处理独立命令进程。
- `src/electron/ipc-handlers.ts:11629–11669` 的停止入口围绕 session runner 和旧 delegation 级联，不存在可以直接借用的工作流测试执行身份。
- `src/electron/libs/terminal-manager.ts:263` 有独立的进程树终止实现，说明命令后代进程与 Agent 停止是不同资源；这不是建议把验收命令放进用户终端。

**建议修订：**在统一 attempt 模型中区分 `agent` / `command` 执行，或新增 CheckExecutionPort。明确命令启动前持久化身份，保存进程 / 进程组与启动代际、输入 artifact 和日志引用；命令执行按可能写入处理并占用租约；取消 / 超时终止并确认进程树；重启无法确认退出时保持 unknown，不启动替代检查或修复。禁止 watch / detached 检查作为自动验收步骤。确认测试已静止并完成前后版本校验，才允许正式审查。

**验证：**测试脚本启动一个会写文件的子进程；分别取消、超时和中断主进程。恢复后不能重复派发、提前释放租约或将迟到退出码算成新检查成功。

## P2 / blocking：右侧面板需要 workflow owner，独立 member target 不足以隔离状态

**设计位置：**主方案 §9（275–303 行）；交付分析 E 阶段及集成关系 11。

视觉复用方向可行，且方案正确禁止伪造 MCP tool_use。缺口在面板状态归属：新 workflow surface 没有主 session，而现有 dock 不是只按 target 打开，它按当前 activeSessionId 保存、切换并读取日志。若仅新增 workflow member target / 面板适配器，两个 workflow 都可能落到同一个空 session 的 dock 状态，或承接上一次普通聊天的 activeSessionId；切换聊天、Run、分屏焦点或重启时会出现标签串台、加载错会话或丢失详情。

**源码证据：**

- `src/ui/App.tsx:1280–1285` 给 SubagentPanel 固定传 `activeSessionId`，React key 也包含它。
- `src/ui/types.ts:300–312` 的 SessionRightPanelSnapshot 明确按 session 保存。
- `src/ui/store/useAppStore.ts:2817–2852` 仅在 activeSessionId 改变时切换面板，并将实时状态存入 `rightPanelSessionKey(activeSessionId)`。
- `src/ui/store/useAppStore.ts:1973–1986` 的 openSubagentPanel 只更新当前 dock；`src/ui/utils/right-utility-tabs.ts:61–71` 只解析已有 target kind。

**建议修订：**补充有类型的 dock owner（如 `{kind:'session', sessionId}` / `{kind:'workflow', runId}`，新聊天草稿另有稳定标识）。焦点 leaf 决定 owner；标签 target 负责定位 member / attempt，后端关系校验后解析真实 sessionId，禁止回退到 activeSessionId。持久化与恢复按 owner 隔离，保留旧 session snapshot 迁移。将 App.tsx、right-utility-tabs 和面板状态切换 / 持久化工具纳入 E 阶段明确接线范围。

**验证：**普通会话 A → Run B → Run C → A，分别保留各自 dock；B/C 中放同 Provider、同角色名称的成员，切换与重启后日志仍按真实身份加载；关闭详情不影响执行，多 pane 改焦点不串台。

## P2 / non-blocking：ReviewResult 的 blockers 与 approved 也应互斥

**设计位置：**主方案 §6.4（211–225 行）。

目前明确拒绝 `approved + blocking finding`，但 schema 还有独立的 `blockers: string[]`。建议把 `approved + 非空 blockers` 同样列为无效结果，并在格式修复后仍矛盾时进入 needs_input。现有 §3.1 的全局“无未处理阻塞”原则方向正确，补这一条是为了让 ResultValidator 的局部规则与之相符。此项没有现成实现，属于 schema 的一致性补充，不单独阻断整体设计。

## 已核实可保留的设计

- `runAgentLoop` 的 ProviderService / Claude 原生 runtime 双路径判断准确；不是简单调用 ProviderService 就能涵盖 Claude。
- 应用层调度、独立 Run/Step/Attempt、真实会话日志、有限交接上下文，与退出协作 MCP 的目标一致。
- 执行结束、步骤结束和业务通过分开；review verdict、版本绑定、完整结果先落盘再释放下游均合理。
- reviewer 不直接继承 full-access，要求验证 shell / MCP 写入限制，是必要的首版能力门槛。
- 旧配置精确检测、应用私有目录清理与用户配置清理分开；不因清理失败退回旧服务，方向合理。
- 新 UI 复用现有胶囊和右侧面板外观，同时引入真实成员身份，不需要重做团队聊天界面。

本次无 P3 发现。关闭前三项 blocking 后可重新判断设计 pass；真实 runtime 与 Electron 验收仍是实施后的独立关口，不由本次文档评审代替。
