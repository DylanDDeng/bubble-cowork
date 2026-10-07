# 交付计划

本目录保存设计对应的交付分析与后续任务。设计草案不等于实现批准、完成或已发布。

## 当前分析

- [应用层 Agent 协作](analysis/agent-workflows.md)：自然语言生成声明式流程，WorkflowEngine + Aegis Host 执行；移除新协作对 delegate MCP 的依赖。状态：设计阶段，按 M0/M1 拆分，已吸收复审 05、06，待复审。

## 设计评审

- [应用层协作初评 01](reviews/agent-workflows-01.md)：独立静态评审，保留初次发现。
- [应用层协作复审 02](reviews/agent-workflows-02.md)：design pass；主方案已按发现补充契约，尚未实施。
- [应用层协作评审 03](reviews/agent-workflows-03.md)：changes requested；主方案已按发现修订（M0/M1 拆分、写入边界、审查副本、收敛与 schema），待复审。
- [应用层协作复审 04](reviews/agent-workflows-04.md)：采纳 03 方向并修正四处边界；主方案已修订，待复审。
- [应用层协作复审 05](reviews/agent-workflows-05.md)：脚本化重写的复审；changes requested（重放键、写入缓存、QuickJS 变体、权限来源）。之后按用户决定改为声明式流程，主方案已吸收其发现。
- [应用层协作复审 06](reviews/agent-workflows-06.md)：声明式流程的复审；changes requested（流程 Schema 不能用于 Claude 结构化输出、检查命令缺少执行授权）；主方案已按其修订，待复审。

## 任务约定

实施时在 `tasks/` 建立具体任务，包含 `id`、`scope`、`status`、`depends-on` 以及 objective、context、path、verification。任务引用 [设计索引](../INDEX.md) 中的契约。

区分模块任务、真实集成任务与实际应用验收；状态为 pending、ready、in-progress、done、blocked。评审记录放 `reviews/`，未纳入本次交付的问题单独登记。未开始的任务不标记完成。
