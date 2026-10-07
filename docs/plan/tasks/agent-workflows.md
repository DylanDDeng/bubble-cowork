---
id: agent-workflows-m0
scope: 应用层 Agent 协作 M0（docs/collaboration/README.md）
status: in-progress（M0 已实现，待复审与人工应用验收）
depends-on: docs/plan/analysis/agent-workflows.md
---

# 应用层协作 M0 任务

状态按本目录约定：pending、ready、in-progress、done、blocked。done 只表示列出的验证已通过；真实应用验收另列。

| id | 阶段 | 内容 | 路径 | 验证 | 状态 |
|---|---|---|---|---|---|
| W1 | W | 交换格式 Schema、转换器、检查命令授权 | `src/workflow-engine/{spec,convert,authorize}` | `verify:workflow-engine`；Claude/Codex 结构化输出实测（`scripts/probe-workflow-planner-schema.ts`） | done |
| W2 | W | 结果 schema 与校验、SpecValidator、reviewLoop 展开、解释器（实例键、指纹、续跑）、验收判定、FakeHost | `src/workflow-engine/{spec/results,validate,engine,testing}` | `verify:workflow-engine`（22 个场景） | done |
| A1 | A | 会话钩子：策略、轮次观察、只读与后台请求自动拒绝 | `src/electron/libs/workflow/session-hooks.ts`、`ipc-handlers.ts`（startRunner、stop） | 单元测试；端到端 | done |
| A2 | A | Claude 工作流成员：`tools` 白名单、PreToolUse 拦截、只读角色无 MCP、成员不注入 delegate | `src/electron/libs/runner.ts` | 端到端；一致性测试 | done |
| A3 | A | Codex 只读角色使用 read-only sandbox | `codex-app-server-manager.ts` | 端到端；一致性测试 | done |
| H1 | H | SQLite 存储、基础去重、成员与实例 | `workflow-store.ts` | 端到端 | done |
| H2 | H | Aegis Host：成员会话、G0/G1、审查副本与 diff、结果解析与一次修复、发现 id、租约 | `aegis-host.ts`、`task-brief.ts` | 单元测试（`workflow-host-units`）；端到端 | done |
| H3 | H | 成员配置清单（全部 Provider，未经一致性测试标记 unverified） | `member-configs.ts` | — | done |
| D1 | D | 严格快照、保留引用、审查副本、diff 文件 | `workspace-snapshot.ts` | `workflow-host-units` | done |
| D2 | D | 检查命令进程组执行、超时/取消、残留进程 | `check-executor.ts` | `workflow-host-units` | done |
| P1 | P | Planner（只读会话、空目录、一次修复）、项目脚本识别 | `planner.ts` | 端到端 planner 模式；离线评估集 | done |
| S1 | H | WorkflowService：规划、确认、引擎运行、needs_input 决策、暂停/取消、重启恢复、视图 | `workflow-service.ts`、`ipc/workflows.ts`、preload、`types.d.ts` | 端到端 | done |
| E1 | E | 计划卡、步骤胶囊、右侧成员详情、成员权限卡 | `src/ui/**` | Electron UI 验收 | done（2026-10-05 改为聊天内看板，见 E2） |
| E2 | E | 聊天内入口：`start_workflow` 应用工具、`current` 成员、`reviewLoop start: review`、HEAD 基准 diff、结果回传、聊天流看板、右侧 `workflow-member` 标签；移除独立 Workflows 页与输入框切换 | `session-mcp.ts`、`workflow/chat-entry.ts`、`workflow-service.ts`、`aegis-host.ts`、`src/ui/components/workflow/WorkflowBoard.tsx` | `verify:workflow-engine`；`verify:workflow-board`；`probe:workflow-chat-e2e`（review、fix 均通过，Claude 聊天 + Codex） | done（待人工验收） |
| C1 | C | 各 Provider 一致性测试套件 | `scripts/` | 每个 Provider 真实运行 | done（6/10 通过，见备注） |
| P2 | P | Planner 离线评估集（15–20 条） | `scripts/tests/workflow-planner-eval-electron.mjs` | 每个可规划 Provider | done（Claude 15/15、Codex 15/15） |
| F1 | F | 旧 delegate MCP 退出普通会话 | runner、ipc-handlers、delegate 三模块 | 配置不变、历史可读 | done |

## 备注（2026-10-05）

- E1 原以独立 Workflows 工作区实现；按用户要求改为聊天内看板（E2），独立页面已删除。看板属于发起会话，成员标签随该会话的右侧面板保存，无需 layout 叶子与 dock owner 重构。@-mention 入口延后。
- C1：6 个 Provider 通过只读一致性；Qoder、DeepSeek（账户额度）、OpenCode（启动不兼容）待复测；Pi 仅 implementer。
- P2 评估集见 `scripts/tests/workflow-planner-eval-electron.mjs`，结果记录于方案。
- 真实应用中的人工操作验收（完整 UI 流程、重启恢复）仍需在开发应用中进行。
