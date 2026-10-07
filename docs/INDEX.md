# Aegis 设计文档索引

本文只建立文档导航。各文档中的草案、历史设计、源代码状态和实际发布状态必须分别核实。

## 当前协作设计

- [应用层 Agent 协作](collaboration/README.md)：2026-10-05 改为声明式流程：自然语言 → 结构化流程 → WorkflowEngine + Aegis Host，Agent 通过流程相互协作；参考 Paseo Hub workflows；01–06 的约束保留为 Host 语义（含规划交换格式、检查命令授权、隔离副本选项）；M0 已于 2026-10-05 在代码中实现（未提交），端到端与 6 个 Provider 只读一致性已实测；实现状态与偏差见方案“实施状态”。
- [协作交付分析](plan/analysis/agent-workflows.md)：模块范围、真实调用关系与验收。
- [交付计划约定](plan/README.md)。

## 会话与工作台

- [现有 MCP 委派设计](delegate-mcp-plan.md)：旧协作方案；新方案尚未实施前，仍需以当前源码判定运行行为。
- [历史 Agent-First 方案](agent-first-plan.md)及[评审](agent-first-plan-review.md)：多方案 fan-out 路线，不作为当前协作实施计划。
- [会话引用](session-links.md)、[无限分屏](infinite-split-plan.md)、[IPC 拆分](ipc-split-plan.md)。
- [Design Mode 写回](design-mode-writeback-plan.md)。

## Runtime 与目标管理

- [Claude Goal](claude-goal-integration.md)、[Codex Goal](codex-goal-integration.md)。
- [Kimi server](kimi-server-adapter-plan.md)及[修复计划](kimi-server-fixes-plan.md)。
- [Qoder SDK](qoder-sdk-adapter-plan.md)、[DeepSeek Harness 升级](deepseek-harness-upgrade.md)。
- [Claude runtime 健康计划](plans/2026-03-11-claude-runtime-health.md)。

## 远程与历史

- [iOS Companion](ios-remote-companion-plan.md)、[实现状态](ios-remote-implementation-status.md)、[Orca/Paseo 远程研究](ios-remote-orca-paseo-research.md)。
- [历史 Agent Workspace 设计](archive/2026-04-30-agent-workspace-design.md)。
