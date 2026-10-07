# 应用层协作方案复审 06：声明式流程

日期：2026-10-05。结论：**changes requested（声明式方向成立，05 的发现大多已关闭；流程 Schema 的形态与检查命令的执行授权两处须修正）**。

复审对象：改为声明式流程后的 `docs/collaboration/README.md` 与 `docs/plan/analysis/agent-workflows.md`。重点：流程 Schema 能否被规划模型稳定生成、步骤实例键与续跑规则、05 发现的关闭情况、新引入的风险。

方法：静态阅读；核对 Claude API 结构化输出的 JSON Schema 限制（`claude-api` skill 的 `shared/tool-use-concepts.md`）、`@anthropic-ai/claude-agent-sdk` 0.3.220 的 `outputFormat`、渲染进程中各 Provider 权限偏好的存储位置。未运行 Planner 或任何 Provider。本报告保留原样。

## P1 / blocking：流程 Schema 无法直接作为 Claude 结构化输出的约束

**设计位置：**§3.3 “支持原生结构化输出时直接以流程 JSON Schema 约束”、§4.2 `Step` 与 `route`。

Claude 结构化输出明确**不支持递归 schema**，且要求所有对象 `additionalProperties: false`，不支持数值约束（`minimum`/`maximum`）。当前定义：

- `Step` 递归：`parallel.steps`、`repeat.steps` 的元素又是 `Step`；
- `route: Record<string, …>` 是以 schema 描述值的开放映射，需要 `additionalProperties` 为 schema；
- `maxRepairRounds`、`repeat.max`、`timeoutMs` 的上限只能靠数值约束表达。

按现状，Claude 作为规划模型时无法用原生结构化输出约束，只能退回“输出 JSON 再本地解析”，一次通过率会明显下降；而方案把 Planner 生成质量列为核心前提。Codex 一侧（OpenAI strict 模式）还要求所有字段 required、可选字段用可空类型表达。

**建议修订：**设计一个两家结构化输出都能接受的**非递归、封闭**的交换格式，由引擎在本地转换为内部树结构：

- 步骤用扁平数组表示：每项带 `id`、`parent`（所在 `parallel`/`repeat` 的 id 或 null）与同级顺序；嵌套由 `parent` 引用表达，深度与无环在本地校验。
- `route` 改为数组：`[{ name, kind: 'enum' | 'boolean', values }]`。
- 所有对象封闭；可选字段统一表示为可空并列入 `required`；数值上限、深度、步骤数全部在 SpecValidator 中校验，不依赖 schema。
- 流程 Schema 以 Claude 与 Codex 两种结构化输出的交集为准，在能力验证关口中实测两家对该 schema 的接受情况。

## P1 / blocking：`check` 的命令由模型生成、由应用直接执行，没有授权环节

**设计位置：**§4.2 `check.argv`、§4.4 `reviewLoop.checks`、§6.7、§3.4 自动开始规则。

`check` 由 CheckExecutor 以应用身份直接启动进程，不经过任何 Agent 的权限系统；而 `argv` 是 Planner 生成的。旧版本曾写明“任意 shell 命令仍走项目权限策略”，声明式重写后这一条没有保留。同时自动开始的条件只看成员与验收的 `source`，不看检查命令：用户说“跑测试”时，Planner 写出的 `argv` 可以是任何内容，计划卡可能不经确认就开始执行。若用户选择的上下文包含仓库文件，文件内容还可能影响 Planner 生成的命令。

这是一条绕过权限系统的命令执行路径。

**建议修订：**

- 计划卡逐条显示每个 `check` 的完整 argv 与工作目录。
- 自动开始额外要求：每条 argv 都是项目可识别的命令（例如 `package.json` 中已有脚本经项目包管理器调用），或与用户本次原话中给出的命令逐字一致，或是用户在该项目中已批准过的命令；否则必须确认。
- 以 `sh`/`bash`/`zsh -c`、`curl`、`wget`、`eval` 等开头或包含管道下载执行的 argv，始终要求确认，并在计划卡上高亮。
- 用户批准即为该命令在本 Run 的授权；批准记录持久化，M1 可提供“项目内记住”。

## P2：权限偏好存在渲染进程的 localStorage，Host 读不到

**设计位置：**§3.2 “权限模式取发起协作时输入框对该 Provider 的当前设置”。

输入框的 Provider 权限偏好保存在渲染进程 localStorage（例如 `src/ui/utils/codex-permission.ts` 的 `cowork.preferredCodexPermissionMode`，由 `useComposerAgentSelection` 读写）。主进程的 Host 无法直接读取；另外已知开发态与打包后 `file://` 的 origin 不同，localStorage 会分成两份。

**建议修订：**启动 Run 的 IPC 由渲染进程携带各 Provider 解析后的权限模式；Host 校验其取值属于该 Provider 的已知模式，记录到 `workflow_members` 的配置快照，此后不再读取偏好。未携带某 Provider 的取值时，使用主进程侧的应用默认值，并在计划卡标出“使用默认”。

## P2：与用户自己的工作争用同一目录，G0 会频繁打断

**设计位置：**§6.4 G0 与租约、§7.1。

G0 比较整个工作区 tree，用户在流程运行期间改动任意文件（包括与任务无关的文件），下一个写入步骤或检查都会停在 `needs_input`。另一方面，“持有租约期间禁止 Aegis 自己在相同目录启动其他写入执行”没有说明普通聊天会话是否受影响：如果受影响，协作运行期间用户无法在同一项目里用 Aegis 正常对话；如果不受影响，G0 会因为这些会话的写入而频繁触发。

**建议修订：**

- 明确普通会话的行为：不阻止，但在同项目普通会话的输入框显示“协作运行中，写入可能使其暂停”的提示。
- G0 的 `needs_input` 提供一键“采用当前目录并继续”，差异记入下一个版本并在完成卡标注“包含用户修改”。
- 启动时提供“在隔离副本中运行”选项，复用现有 `worktree-threads.ts` 的隔离副本与“Apply to project”流程；需写明隔离副本从 HEAD 创建、不包含未提交改动，工作区有未提交改动时默认仍在当前目录运行。

## P2：Planner 无法表达的要求会被静默丢弃

**设计位置：**§3.3、§3.4。

用户的话里可能包含流程无法表达或首版不支持的要求：并行写入、完成后提交或开 PR、使用不在成员配置清单中的 Provider、特定的 worktree 安排等。Schema 中没有地方记录这些，Planner 只能忽略或曲解，计划卡也无从提示。

**建议修订：**`WorkflowSpec` 增加 `unsupported: string[]`（无法满足的要求）与 `assumptions: string[]`（Planner 做出的假设）。任一非空时必须确认，计划卡逐条显示。

## P2：跨越 `repeat`/`parallel` 的引用与条件语义未定义

**设计位置：**§4.2 `Ref`、`Condition`；§4.1 示例中验收 `a1` 引用宏内部的 `tests`。

- 在 `repeat` 之后引用其内部步骤（如 `{ step: 'review_security' }`）时，取哪一轮的实例？
- `approved`、`checkPassed` 的“本轮”在 `repeat` 之外如何解释？
- 验收引用的 `tests` 位于 `reviewLoop` 展开后的 `repeat` 内部，应当绑定哪个实例？

**建议修订：**在 `repeat` 外引用其内部步骤，解析为最后一个已结算的实例；条件在 `repeat` 外求值时同样取最后实例；验收判定只认输入版本为 R(n) 的实例（与 §6.4 一致）。宏展开后的内部步骤 id 保持用户可见且唯一。

## P3

- **续用会话的步骤指纹。**`session: 'continue'` 的步骤结果依赖会话历史。前面某个同成员步骤重新执行后，后续续用步骤即使 task 与工作区相同也不应复用。指纹应包含同成员前序实例的标识链。
- **收敛判定的信号。**“同一指纹连续两轮未解决”依赖对 `reason` 前缀的规范化，措辞变化即失效。复审已对上一轮每条 blocking finding 给出 `previousFindings` 状态，应以“同一 finding 连续两次复审为 `unresolved`”为主信号，指纹只用于跨 reviewer 的去重与展示。
- **Planner 质量的离线评估。**能力验证关口提到一次通过率，但没有评估集。建议在 UI 接线前建立 15–20 条典型自然语言请求及其期望性质（成员、验收、是否需要确认、是否有 unsupported），用 Claude 与 Codex 两种规划模型各跑一遍，作为 P 阶段的完成条件。

## 05 发现的关闭情况

| 05 发现 | 声明式版本 | 结论 |
|---|---|---|
| P1 callKey 全局序号导致重放错位 | 步骤实例键 = 路径 + 轮次（§5.2） | 关闭 |
| P1 写入/检查缓存不感知工作区版本 | 输入指纹含 `snapshotIn`，继续前比对目录（§5.3） | 关闭；续用会话的指纹见 P3 |
| P1 QuickJS async 变体不支持并发 | 不执行模型代码 | 不再适用 |
| P1 implementer 权限来源缺失 | 成员配置清单，流程无权限字段（§3.2） | 设计关闭；取值来源见 P2 |
| P2 用户要求的审查可被漏掉 | `acceptance` + 结束时逐项判定 + 静态警告（§4.6、§6.4） | 关闭 |
| P2 G3 时机与缺少写入前关卡 | 新增 G0，G3 改为逐步标记（§6.4） | 关闭；G0 的打断频率见 P2 |
| P2 跨 Agent 注入放大 | 引用数据带来源分隔、字段长度上限（§6.5） | 关闭 |
| P2 M0 范围膨胀 | 真实验收收窄为两种模式（§10.1） | 关闭 |
| P2 检查改写文件的版本归属 | `snapshotIn/Out`（§6.7） | 关闭 |
| P3 参数视为不可信输入 | SpecValidator 封闭对象与上限（§4.6） | 关闭 |
| P3 write 预算口径 | 修复轮数只计产生新版本的写入（§5.4） | 关闭 |
| P3 Planner 模型选择 | 规划模型设置项并记录（§3.3） | 关闭 |

## 已核实可保留

- 去掉模型代码执行后，沙箱、确定性与调用键问题整体消失；引擎不依赖 Electron，可先用 FakeWorkflowHost 做实语义。
- 执行前完整预览、静态拒绝并行写入、条件只读有限取值、成员只能选 Host 提供的配置，这些边界设计正确，与 Paseo Hub 的做法一致。
- `acceptance` 让程序能判断“用户要求的检查与审查是否都在最终版本上完成”，补上了脚本版本的主要缺口。
- `reviewLoop` 宏“最后一轮不修复”、修复轮数只计产生新版本的写入、无进展保护，规则一致。
- Claude Agent SDK 提供 `outputFormat: { type: 'json_schema' }`，Planner 使用原生结构化输出有实现基础，前提是按 P1 调整 Schema 形态。
