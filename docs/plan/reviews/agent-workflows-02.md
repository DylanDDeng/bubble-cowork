# 应用层协作方案定向复审 02

日期：2026-10-05。结论：**design pass（设计契约通过，尚未实施或验证 runtime 能力）**。

复审对象：修订后的 `docs/collaboration/README.md` 与 `docs/plan/analysis/agent-workflows.md`。范围仅限 [初评 01](agent-workflows-01.md) 的三项 blocking、一项 non-blocking 及修订引入的一致性问题。初评报告保持原样。

## 初评发现关闭情况

| 初评发现 | 修订位置 | 复审结论 |
|---|---|---|
| P1 / blocking：原生后台子 Agent 可能越过主轮结束边界继续写入 | 主方案 §3.1、§5.1–5.3、§6.1、§11；交付 A 阶段和能力关口 | **设计层关闭。** 首版明确禁用 runtime 原生派生与不可追踪后台能力；获准 shell/tool 资源必须绑定 attempt 并确认静止，不能把主 result 或 hash 稳定当成静止证明。确认不了则保留租约、阻止下游；无法验证的角色不算接入完成。 |
| P1 / blocking：CheckExecutor 缺少独立执行与恢复身份 | 主方案 §5.4、§6.1、§8、§11；交付 D 阶段和集成关系 8、9 | **设计层关闭。** 引入独立 CheckExecutionPort、command attempt、启动代际和进程树身份，覆盖停止、暂停、超时、退出和恢复；通过证据要求零退出码、日志、进程树静止、版本有效同时满足。检查修改版本后旧证据失效，与审查版本绑定规则一致。 |
| P2 / blocking：dock 按 activeSessionId 保存，会造成 workflow 状态串台 | 主方案 §9、§11；交付 E 阶段和集成关系 11 | **设计层关闭。** owner 区分 session/workflow/draft，焦点 leaf 决定 owner；成员 target 经归属校验解析 session/attempt，明确禁止回退 activeSessionId；App、store、utility target、snapshot 迁移与多 Run/多 pane 恢复均已列入范围。 |
| P2 / non-blocking：approved 与非空 blockers 的一致性 | 主方案 §6.4 | **关闭。** 明确将 approved 与 blocking finding 或非空 blockers 同时出现判为无效结果，格式修复后仍矛盾则进入 needs_input。 |

本次修订没有发现新的阻断性矛盾。实现可采用文档中的独立端口与共享 attempt/resource 存储，不需要把检查命令伪装成 Agent session，也不需要恢复旧协作 MCP。

## 用户指定的 UI 方向

**符合要求。** 成员入口继续使用现有 Agent 胶囊 / 任务行视觉，点击后在原右侧 utility dock 展开详情；复用 SubagentPanel 的外观和消息内容渲染，不伪造 MCP tool_use 或主 Agent 会话。

修改的是数据归属与调度接口。右侧面板的标签、展开收起、关闭行为沿用现有交互；状态更新不抢焦点，关闭详情不停止执行。当前与历史 attempt 可区分，双 Codex 或同名角色不以名称匹配日志。新的 workflow root 是真实工作流导航目标，不构成另起团队聊天界面的要求。

## 通过的边界

此处 design pass 表示初评指出的设计契约已闭合，可以据此拆分实现；**不表示当前 Claude/Codex 适配器已经支持这些能力，也不表示产品已可用。**

实施时仍须完成方案已经列明的真实验收，尤其是：runtime 层派生/后台能力限制和可写资源静止证明、reviewer 只读策略、命令进程树停止与恢复、协作配置隔离，以及重启实际 Electron 后的三成员流程与右侧面板隔离。若某能力验证失败，应按文档保持该角色接入未完成，不能用 mock 通过替代或退回旧 MCP 路径。

本次仅静态读取修订文档并新增本报告；未运行 runtime、未修改应用代码、用户配置或主方案。
