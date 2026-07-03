# Agent-First 方案 v2（orca 式执行编排）

> **路线变更记录（2026-07-02）**：v1 走的是 identity-first（agent = 有身份/记忆/任务收件箱的数字同事，profile 所有权翻转为 Phase 1）。经与 [stablyai/orca](https://github.com/stablyai/orca) 对照后拍板改走 **execution-first**：agent 是无状态的执行体（CLI runtime），一等公民是"一次并行运行"。不做 profile/persona 体系，不做 per-agent 记忆，不做花名册和 delegation。
>
> **新判据四问**：一个 prompt 能不能扇给 N 个 agent 各自隔离地跑？结果能不能并排比较、一键采纳赢家？关掉窗口它还在跑吗？跑完会主动告诉我吗？
>
> **评审修订（2026-07-02）**：经五维度 agent 评审团 + 逐条对抗验证（30 条发现，15 条确认），全部确认发现已修订进本文。完整评审报告见 `docs/agent-first-plan-review.md`。

## 0. 现状盘点（2026-07-02，基于全量代码扫描）

一句话：**fan-out 的机械基础已经全部就位，缺的是编排层和比较层**。这次迁移的性质与 v1 相同——大量是"接线"而非"新建"。

### 0.1 资产（已能跑的）

- **worktree 机制完整**：`envMode: 'local' | 'worktree'`（shared/types.ts:851），session 级 worktree（`sessions.worktree_path` 等四列，session-store.ts:651-654），`createWorktree`/`removeWorktree`（git-service.ts:221/250），默认落在 `<repoRoot>/.worktrees/<branch>`，handoff 双向切换（ipc-handlers.ts:5660-5778）
- **runner 并发无锁**：`runnerHandles` 是按 sessionId 的 Map（ipc-handlers.ts:3127-3146），多 session 天然并行，无全局上限
- **六 provider 双 runner 体系**：claude（Agent SDK 进程内）+ codex/opencode/kimi/grok/pi（ProviderAdapter，agent-loop.ts:22-27 注册）；`runAgentLoop` 统一分派
- **headless 启动路径已验证**：automation-scheduler 进程内直调 `handleSessionStart`（ipc-handlers.ts:3889），不需要 renderer 发起
- **递归 tiling 树已实现**（infinite-split 计划已落地）：`layout-tree.ts`（427 行 + 单测），无限 pane、i3/sway 同向合并、`placeSession`/`splitPane`/`closePane`。leaf 的 `surface: 'chat' | 'terminal'` **仅在类型/持久化层预留**——唯一渲染器 WorkspaceHost 对每个 leaf 无条件渲染 ChatPane、不消费 surface（WorkspaceHost.tsx:121-129）
- **agent detection**：六 provider 并行探测 ready/login_required/not_installed（agent-runtime-directory.ts:200-228），首启 onboarding 页 + composer readiness 圆点
- **PTY 终端**：node-pty（terminal-manager.ts:437）+ xterm.js 全家桶（src/ui/terminal/），terminal-agent-wrapper.ts 有 OSC 事件雏形——通往"任意 CLI agent"的现成通道（但现有终端挂在右侧 utility dock，不在 tiling 树内）

### 0.2 缺口（净新增）

- **无 fan-out 编排**：没有"一个 prompt → N 个 session × N 个 worktree"的入口和分组概念
- **无跨 session 比较**：`get-git-diff` 只对单 cwd（src/electron/ipc/git.ts:166）；无 N-way 对比视图、无"采纳赢家"、无 merge 回主工作区的逻辑（handoff 只有 stash/apply 搬未提交改动，不 merge）
- **worktree 无生命周期治理**：`removeWorktree` 全仓库只有一处调用且仅是失败回滚（ipc-handlers.ts:5844）；`deleteSession`（session-store.ts:2181-2194，硬删除只级联 messages）不清理 worktree；handoff 切回 local（ipc-handlers.ts:5689-5763）只置空 `worktreePath` 不删目录——**三条用户路径全部泄漏**
- **git 卫生缺失**：`.worktrees/` 建在仓库根内且代码从不写 `.git/info/exclude`——用户仓库主工作区会永久出现 `?? .worktrees/`（Aegis 自己的仓库干净只因开发者手工加了 exclude）
- **无 orphan running 清算**：app 崩溃后 `status='running'` 的 session 永远残留（无任何启动期 sweep），今天就会阻塞 handoff/checkout 门禁（ipc-handlers.ts:5575/5685）；`automation_runs` 已有同类卡死先例
- **系统通知空白**：全仓库无 Electron `Notification`/badge/tray
- **provider 硬编码**：`isProviderKind` 枚举固定六个，无任意 CLI 注册机制

### 0.3 Persona 脚手架的处置

v1 要激活的那批休眠管线（AgentProfile CRUD、delegation、builtin_memory、DM、roster）在 orca 路线下全部失去用途，见「横切：persona 脚手架清退」一节。原则：**先证明 orca 路线成立（Phase 1-2 落地），再集中拆桥**，避免边建边拆。

---

## 1. 总体路线

```
Phase 1  Fan-out              一个 prompt → N 个 agent × N 个隔离 worktree，并排流式输出
Phase 2  比较与采纳            N-way diff 对比、一键采纳赢家、落败清理 + worktree GC
Phase 3  后台执行与通知        关窗照跑、系统通知、点击回位
Phase 4  任意 CLI agent       PTY runtime 注册机制，非内建 CLI 也能参与 fan-out
横切     persona 脚手架清退   Phase 2 落地后集中一个 cleanup PR
```

依赖关系：

- Phase 2 依赖 Phase 1 的 run group 数据模型（没有组就没有比较对象）
- Phase 3 相对独立，可与 Phase 2 并行；但"group 全员完成"通知依赖 Phase 1
- Phase 4 依赖 Phase 1 的 fan-out 框架 + Phase 2 的 git-diff 比较（任意 CLI 无结构化消息流，比较只能靠 diff——这正是 orca 能兼容 20+ agent 的原因）
- **单 agent 单 session 的现有体验全程不变**：fan-out 是加法，N=1 且不选 worktree 时走完全现行的路径

---

## Phase 1：Fan-out

目标：composer 里一个 prompt 选中多个 agent（或同 agent 多份）→ 每个成员一个独立 worktree + 一个 session 并行执行 → tiling 树自动并排呈现。

### 1.1 数据模型

新表（run-group-store.ts，同一 SQLite）：

```sql
run_groups (
  id TEXT PRIMARY KEY,
  project_cwd TEXT NOT NULL,
  prompt TEXT NOT NULL,
  base_ref TEXT,                    -- 创建时项目 HEAD 的 commit sha，全组统一比较基准
  variants TEXT NOT NULL,           -- JSON 数组：每成员 {provider, model?, reasoningEffort?, permissionMode?, sessionId?, failReason?}
  status TEXT NOT NULL DEFAULT 'running',  -- running|settled|adopted|discarded|cancelled
  adopted_session_id TEXT,
  created_at INTEGER, settled_at INTEGER
)
-- sessions 表加列: run_group_id TEXT（ensureColumn 模式，同 env_mode 那批），索引 (run_group_id)
```

不建成员表，但**成员身份由 `variants` JSON 承载**（评审发现 3）：成功启动的成员回填 `sessionId`，执行状态由其 session 承载；没走到 session 那步就失败的成员（如 worktree 创建失败——session 行要到 `handleSessionStart` 内部才创建，ipc-handlers.ts:7438）在 variants 里持久化 `failReason`。这样"重启后 group 与成员关系从 SQLite 恢复"对失败成员也成立，3 选 2 的组不会重启后看起来像 2 成员组。

状态机语义（评审发现 4）：`settled` 由成员状态**派生**（见 1.2）；`adopted` = 已采纳赢家；`discarded` = 用户 Discard all 的落点；`cancelled` 保留给"全员启动失败"。级联：删除被采纳成员 session → `adopted_session_id` 置 NULL；删除组内最后一个成员 → group 行连带删除（`deleteSession` 是硬删除且现有删除路径无 group 感知，ipc-handlers.ts:8832-8856，需在删除路径补 group 收尾）。

### 1.2 Fan-out 服务（主进程）

新模块 `src/electron/libs/run-group-service.ts`：

```
startRunGroup({ projectCwd, prompt, variants: [{provider, model?, reasoningEffort?, permissionMode?}], attachments? })
```

- **git 卫生前置**（评审发现 1，高危）：首次在某仓库建 fan-out worktree 前，幂等向 `$(git rev-parse --git-common-dir)/info/exclude` 追加 `.worktrees/`（不动用户 `.gitignore`）。没有这步，链接 worktree 会以 `?? .worktrees/` 永久污染主工作区 `git status`：Phase 2 的 adopt dirty 门禁持续命中且无出路（`git stash -u` 对该路径无效并输出 "Ignoring path"、`git add .` 会把 worktree 提交成 embedded-repo gitlink），现有 handoff 的 `hasDirtyWorkingTree`（`--untracked-files=all`，git-service.ts:47-51）也会误判——决策点 9
- 记录 `base_ref = git rev-parse HEAD`；对每个 variant：
  1. 分支名 `aegis/fan/<groupSlug>/<n>-<provider>`（groupSlug 取 group id 前缀，天然免冲突）
  2. `createWorktree`（git-service.ts:221）——worktree 创建**串行**。串行的理由是防御 git 并发边界的最简做法（reftable 后端全局 ref 锁、`$GIT_DIR/worktrees` 管理目录竞态等罕见情况；linked worktree 各有独立 index，**不是**主 index lock 问题）。单次超时 120s（git-service.ts:238），大仓库串行 N 次期间该成员在 variants 里显示 `preparing`，UI 有状态可显（评审发现 12）
  3. 失败 → variants 条目写 `failReason` 并 broadcast，不阻塞其余成员
  4. 成功 → 构造 `SessionStartPayload`（模式照抄 `buildAutomationSessionPayload`，automation-scheduler.ts:23-51）：`envMode:'worktree'`、`worktreePath`、`runGroupId`、prompt/附件同一份 → 进程内 `handleSessionStart`（automation 已验证此路径）→ 回填 `sessionId`
- **settled 判定是从成员状态派生的幂等函数**（评审发现 2）：`deriveGroupStatus(variants, memberSessions)`，在每次成员终态变化**和每次 app 启动时**重算——不是一次性内存事件。全员启动失败 → `cancelled`
- **启动期状态清算**（评审发现 2，还历史债兼保 fan-out）：boot 时把无 runner 句柄的 `status='running'` session 标为 `error`（或新增 `interrupted`），随后重算所有 running group。现状代码没有任何 orphan running 清算，崩溃残留今天就会阻塞 handoff/checkout 门禁，`automation_runs` 有同类卡死先例——此项不做，崩溃后 group 永远停在 running、Phase 3 的完成通知永不触发
- **权限默认**：worktree 隔离下默认放宽为该 provider 的 full-access 档（取值照抄 scheduler:36-44），composer 可改回保守档。**如实陈述风险**（评审发现 11）：worktree 只隔离工作副本，不是沙箱——claude 的 bypassPermissions 无 fs/网络约束（runner.ts:649），codex 应优先用现成的 `workspaceWrite + writableRoots=worktree`（codex-app-server-manager.ts:667/681）而非 danger-full-access。参照基线：automation 现状已默认 full-access 且直接跑在主工作区（scheduler:37-45），fan-out 相对现状是收紧而非新风险——决策点 1

### 1.3 IPC

```
runGroup.start    { projectCwd, prompt, variants, ... }   → 返回 groupId + memberSessionIds
runGroup.cancel   { groupId }                              → 取消所有 running 成员 + 清理 clean worktree
广播 runGroup.changed { group 快照 + 成员摘要 }
```

- `runGroup.start` 的同步返回值是 renderer 布局的唯一触发点（见 1.5）
- `runGroup.cancel` 包含**最小 worktree 回收**（评审发现 5，从 Phase 2 前移）：对 clean 的成员 worktree 执行 `removeWorktree` + 删分支；dirty 的保留并提示。同一 PR 顺手修 `deleteSession` 的 worktree 清理（本就是还债）——否则 Phase 1 单独发布时每次 fan-out 净增 N 个工作区 checkout + N 个分支且零回收入口

（`runGroup.adopt` / `runGroup.discard` 属 Phase 2。）

### 1.4 Composer 入口

- `ComposerAgentControls`（已有 per-provider readiness 圆点）从单选 provider 扩展为**多选 + 份数**：点选多个 agent，或同一 agent ×2/×3（同 provider 不同 model/effort 也是合法 variant）
- 选中 ≥2 → 提交按钮语义变为 "Fan out (N)"，走 `runGroup.start`；选中 1 个 → 完全现行路径（可勾选 worktree，即现有 handoff 能力的前置化）
- readiness 语义与现有单选控件**对齐而非收紧**（评审发现 13）：现有控件故意允许选中非 ready 的 provider（"statuses can be stale"，ComposerAgentControls.tsx:72-79），且 readiness 有 'checking' 瞬态（首探前六个 provider 全是 checking、缓存 TTL 30s），硬禁用会在开窗瞬间灰掉整个多选。多选允许勾选非 ready，沿用圆点 + toast 警示，只对未安装（missing）禁用；终判交给 1.2 的成员级失败路径
- 非 git 项目：fan-out 入口禁用，tooltip 提示需要 git（决策点 5）

### 1.5 呈现

- 自动布局**只在 `runGroup.start` 调用返回处触发一次**（发起窗口的 renderer 拿到 memberSessionIds 后主动 `splitPane` 平铺）；`runGroup.changed` 只更新数据、绝不动布局——它是会重复到达的快照广播，按它布局会在错误时机重复平铺、砸掉用户手调的布局（评审发现 6）。N ≤ 4 全平铺（layout-tree 已支持任意 N 和同向合并）；N > 4 平铺前 4，其余从 sidebar group 节点进入（决策点 4）
- **前置修复**（评审发现 6）：`setChatLayoutMode('single')` 会把整棵树坍缩成单 leaf（useAppStore.ts:1948-1955），而搜索面板 `openThreadFromPalette` 无条件调用它（Sidebar.tsx:359）——fan-out 平铺后用户搜索打开任一线程（包括成员自己）布局即全毁且无 undo。审计该调用点改走保留布局的 `placeSession` 路径
- Sidebar：group 显示为一个可展开条目（"⑂ fan-out · 3 agents · running"），成员是其子项；成员 session 不再散落在普通 thread 列表里（`run_group_id` 非空则归组显示）
- 每个成员 pane header 显示 provider 徽标 + worktree 分支名 + 状态

### 1.6 验收标准

- [ ] 一个 prompt 扇出 claude + codex + opencode → 三个 worktree、三个 session 并行流式输出、三 pane 并排
- [ ] 任一成员失败/取消不影响其余成员；worktree 创建失败的成员重启后仍出现在组里（带失败原因）
- [ ] N=1 且未选 worktree 的提交路径与今天完全一致（字节级不变）
- [ ] 重启 app 后 group 与成员关系从 SQLite 恢复，**且状态收敛**：模拟崩溃（SIGKILL）后重启，running 成员被清算为终态、group 重算为 settled/cancelled
- [ ] fan-out 进行中，主工作区 `git status --porcelain` 不出现 `.worktrees` 条目
- [ ] 取消/删除组后 `.worktrees/` 无残留（clean worktree 被回收，dirty 保留并提示）
- [ ] 平铺后经搜索面板/侧栏导航打开线程，不破坏 fan-out 布局
- [ ] 同一项目连续两次 fan-out，分支/worktree 命名不冲突
- [ ] `AEGIS_USER_DATA_DIR` 隔离环境 + 干净 git 仓库跑通全流程

### 1.7 风险

- N 个 runner 并发的资源/token 消耗 → 单组软上限 6 个成员（决策点 6）；provider readiness gate 复用现有检查
- worktree 创建期间用户改动主工作区 → `base_ref` 在创建瞬间锁定，成员从同一 ref 出发；主工作区后续改动不影响组内比较
- full-access 默认权限的半径 → worktree 只隔离工作副本、不是沙箱（无网络/全局文件系统约束），仅在 worktree 模式提供 fan-out 是降低误操作概率而非安全边界；codex 成员用 workspaceWrite+writableRoots 收敛；与 automation 现状基线（主工作区 full-access）相比是收紧

---

## Phase 2：比较与采纳

目标：group 视图并排看 N 个结果的 diff，一键采纳赢家 merge 回主工作区，落败者清理。这是 orca 的 "compare the results and merge the winner"。

### 2.1 比较数据

- git-service 加 `getDiffStatAgainstRef(cwd, baseRef)`：`git diff --stat <base_ref>`（**工作树对 ref 的比较**，同时覆盖已 commit 与未 commit 的改动）。不能用 `<base_ref>...HEAD` 形式——CLI agent 通常不 commit，成员分支 HEAD == base_ref，该形式在最典型场景下 +/- 恒为 0（评审发现 10）。未跟踪文件经 `git status --porcelain` 计入 changed files（或 `git add -N` 后进 diffstat）
- IPC `runGroup.summary { groupId }` → 每成员：session 状态、耗时、diffstat、末条 assistant 文本摘要（截断）

### 2.2 Group 比较视图

新组件 `RunGroupView.tsx`。**装入 leaf 的接法是实质设计选择而非随手二选一**（评审发现 8，决策点 10）：(a) 新增持久化 `'group'` surface——需扩 LeafNode 载荷（现只有 `{sessionId, surface}`，layout-tree.ts:27-32）、bump layout schema version，并修 `validatePaneNode` 把未知 surface 强转 'chat' 的陷阱（layout-adapter.ts:124——不修则存过的 'group' leaf 重启后**静默降级成空 chat pane**，TS 不会报错）；(b) leaf 载荷不动，store 侧 paneId→groupId 临时映射驱动，零 schema 改动，代价是 group 视图不跨重启持久（三个入口均可重推导，验收未要求持久）。视图内容：

- 成员卡片网格：provider 徽标、状态、耗时、diffstat、摘要；点卡片 → 该成员 session 装入焦点 pane（`placeSession`）
- 卡片上 "View diff" → 全量 diff 视图（复用 `get-git-diff`，传成员 worktree cwd + `base_ref`）
- 主操作：**Adopt**（采纳该成员）/ **Discard all**（全组放弃）
- 入口：sidebar group 节点点击、成员 pane header 的 "Compare" 按钮、Phase 3 的完成通知点击落点

### 2.3 采纳（merge winner）

IPC `runGroup.adopt { groupId, sessionId }`，主进程流程：

1. 赢家 worktree 若有未提交改动 → 自动 commit 到其分支（message: `aegis: fan-out result (<provider>)`）
2. 主工作区 `git merge --squash <branch>`（不自动 commit，改动落在暂存区让用户审查后自行提交）——**squash-merge 而非 stash/apply**（决策点 2）：保留分支可追溯，冲突语义清晰
3. 冲突 → 中止 merge、group 保持 settled、提示用户手动处理（赢家 worktree 原样保留）
4. 成功 → group 置 `adopted`；**落败成员**：`removeWorktree`（git-service.ts:250）+ 删分支；session 与 transcript 保留（供回看），标记 workspace 失效（灰显 env 面板）
5. 赢家 worktree 也清理（改动已进主工作区），其分支保留一个版本周期后 GC

### 2.4 Worktree 生命周期治理（还历史债）

（cancel/deleteSession 的最小回收已前移进 Phase 1.3；本节补齐剩余部分。）

- `deleteSession` 的 group 收尾（评审发现 4）：删被采纳成员 → `adopted_session_id` 置 NULL；删最后一个成员 → group 行连带删除
- `deleteSession` 补上：session 带 `worktree_path` 且该 worktree 无其他 session 引用、工作区 clean → `removeWorktree`；dirty → 保留并提示
- 启动时 GC 扫描：`git worktree list --porcelain` 交叉 `sessions.worktree_path`，无引用且 clean 的 `.worktrees/*` 列入"可清理"（设置页一键清理，不默认静默删——决策点 3 的保守面）
- `runGroup.discard`：全组 worktree 按同规则清理

### 2.5 验收标准

- [ ] 三成员完成 → group 视图三卡片，diffstat/摘要正确 → 采纳其一 → 主工作区暂存区出现 squash 变更 → 其余 worktree 消失、transcript 仍可看
- [ ] 采纳冲突时 merge 干净中止，主工作区无残留状态（`git status` 干净或明确的冲突态）
- [ ] 删除普通 worktree session → worktree 被清理；dirty worktree 不被静默删
- [ ] GC 不会碰有未提交改动或有 session 引用的 worktree

### 2.6 风险

- squash-merge 撞上主工作区未提交改动 → adopt 前检查主工作区 dirty，dirty 时要求先 stash/commit（提示语明确）
- 成员间共享文件的三方冲突不可自动化 → 首版只支持"采纳一个"，不做跨成员 cherry-pick 合成（明确 non-goal）
- diff 大文件/二进制 → diffstat 层面无碍，全量 diff 视图沿用现有 `get-git-diff` 的行为

---

## Phase 3：后台执行与通知

目标：关掉窗口 agent 照跑（app 驻 dock 期间），跑完系统通知，点击回位。orca 的移动伴侣不在范围，但通知是同方向的第一步。

### 3.1 执行与窗口解耦

- runner 本就活在主进程，关 pane/关窗不杀 runner——**验证并固化这个语义**（补集成测试）
- **平台现实**（评审发现 7）：close→hide 驻留是 darwin-only（main.ts:624-627）；Windows/Linux 上 `window-all-closed` 直接 `app.quit()`（main.ts:945-949），关窗即杀所有 runner 和 fan-out 组——而三平台都是真实发布路径（electron-builder.json + release matrix），全仓无 Tray。必须显式拍板（决策点 11）：首版明文仅 macOS（win/linux 关窗时若有 running 任务弹确认对话框），或把最小 tray（win/linux 关窗转驻留 + 托盘退出菜单）纳入本 phase 并上调工作量
- automation-scheduler 摘掉 mainWindow 存活 gate（automation-scheduler.ts:88-99 的 `isDestroyed` 直接 return）：tick 不依赖窗口，broadcast 在无窗口时静默跳过
- 状态以 SQLite 为准：窗口重开全量拉取，错过的 broadcast 无害

### 3.2 系统通知（greenfield）

新模块 `src/electron/libs/notifications.ts`，封装 Electron `Notification`：

- 挂接点：
  - 单 session turn 完成/失败（仅当无窗口或窗口失焦，避免前台打扰）
  - **group 全员到达终态** → 汇总一条："Fan-out complete · 3/3 done — compare results"，点击 → 聚焦/重建窗口 + 打开 RunGroupView
  - runner 停在权限确认等待输入（headless 放宽后此场景变少，但 local 模式仍需要）
- 点击落点：`notification.on('click')` → 聚焦 mainWindow（无则重建）→ 广播定位事件（session 或 group）
- 设置项：通知总开关（默认开）+ 仅失焦时通知（默认开）

### 3.3 验收标准

- [ ] fan-out 后立即关窗（app 驻 dock）→ 全组照常跑完 → 通知弹出 → 点击回到 group 比较视图
- [ ] 前台聚焦时不弹通知（可配）
- [ ] automation 在无窗口时照常触发执行，窗口重开后历史可见

### 3.4 风险

- macOS 通知权限未授予 → 首次触发前 `Notification.isSupported()` + 引导；静默失败不阻塞执行
- 无窗口期间的错误积压 → 失败也通知（区分文案），重开窗口时 sidebar 给 failed 徽标

---

## Phase 4：任意 CLI agent（"if it runs in a terminal, it runs in Aegis"）

目标：非内建的 CLI agent（aider、goose、自研脚本……）可注册为 runtime 并参与 fan-out。这是 orca 兼容 20+ agent 的核心承诺，也是本方案里"agent-first"的最终形态：agent = 任何能在终端里跑的执行体。

### 4.1 为什么可行：比较不依赖消息流

Phase 2 的比较/采纳完全建立在 **git diff** 上，不需要结构化消息协议。任意 CLI 只要在 worktree 里改了文件，就能被比较和采纳。这是把比较层建在 git 而非 provider 协议上的最大红利。

### 4.2 Custom runtime 注册

- 数据：`custom_runtimes(id, name, command_template, cwd_mode, created_at)`；`command_template` 含 `{prompt}` 占位（如 `aider --message {prompt} --yes`）。**不做模型列表/版本枚举**——注册的是命令，不是模型目录（呼应既有原则：避免硬编码模型清单）
- 执行：PTY spawn（terminal-manager.ts:437 已有全套）；呈现用 leaf `surface:'terminal'` 嵌 xterm。**注意**（评审发现 9）：该 surface 只在类型/持久化层预留（layout-tree.ts:24），唯一渲染器 WorkspaceHost 对每个 leaf 无条件渲染 ChatPane、不消费 surface（WorkspaceHost.tsx:121-129），现有终端挂在右侧 utility dock 不在树内。本 phase 的净新增渲染层工作：WorkspaceHost 按 surface 分派 + 终端 leaf 的 pty 生命周期（关 pane/movePane 时的 pty 归属——layout-tree.ts:388-389 的注释已自证这是待办）
- 完成检测：进程退出码为准；terminal-agent-wrapper.ts 的 OSC 事件作为增强（有则显示细粒度状态）
- provider 类型系统：`AgentProvider` 加 `custom:<id>` 命名空间，或平行的 `RuntimeRef = builtin | custom` 判别联合——落地时定（决策点 7）
- detection：custom runtime 注册时 `which <argv0>` 验证可执行；不做全局 PATH 扫描猜测

### 4.3 Fan-out 集成

- composer 的 agent 多选列表包含 custom runtime（终端图标区分）
- custom 成员在 group 视图与内建成员并列：diffstat/diff/adopt 全部同构；仅"末条 assistant 摘要"降级为终端尾部输出截取

### 4.4 验收标准

- [ ] 注册一个非内建 CLI → 单独跑通（PTY pane 流式输出、退出即完成）
- [ ] claude + custom CLI 混合 fan-out → 比较、采纳、清理全流程同构
- [ ] command_template 注入安全：prompt 经 shell-safe 传参（argv 数组，不字符串拼接）

### 4.5 风险

- 任意命令执行的安全半径 → 注册即授权（用户自己写的命令），但 fan-out 时强制 worktree、不提供 local 模式
- CLI 无进度语义 → 首版接受"只有跑完才知道"，OSC wrapper 作为 opt-in 增强
- prompt 过长超 argv 限制 → 落临时文件 + `{promptFile}` 占位变体

---

## 横切：persona 脚手架清退

orca 路线下 v1 要激活的休眠管线全部失去用途。**时机：Phase 2 落地验证后，集中一个 cleanup PR**（决策点 3）——先证明新路线成立再拆桥，期间冻结（不修、不建、不依赖）。

| 项 | 处置 | 备注 |
|---|---|---|
| `AgentProfile`/`TeamProfile` CRUD、`profiles.sync`、`StoredAgentProfile`、~800 行 normalize | 删除 | 零 UI 调用者，删除无用户可见影响 |
| delegation 全链（`extractDelegationRequests` → `runRoutedAgentTurnSequence`，ipc-handlers.ts:6893-7051） | 删除 | 后端完整但永不可达 |
| `routedAgentTurns`/`teamAgentTurns`/`availableAgentTurns` payload 字段 | 删除 | composer 从不构造 |
| `DelegateCall`/`DelegateResult`/`delegate_activity` 类型 + MessageCard 渲染分支 | 删除 | 主进程从不发射 |
| `builtin_memory_*` 三表 + 全套函数（session-store.ts:538-576, 2378-2619） | 删除 | v1 决策点 3 的"否则删干净"分支 |
| `openAgentDirectMessage`、`scope:'dm'` 过滤、`projectAgentRostersByProject` 等 | 删除 | persona 导航专用 |
| `memory-mcp-server.ts`（孤儿）、`MemorySettings.tsx`（未挂载） | 删除 / 悬置 | 文件记忆域与本方案解耦 |
| 文件记忆系统（assistant/user/project 层，`~/.aegis/`） | **保留不动** | 与 persona 无关，另行演进 |
| automation `team_mode`/`team_id` 死字段 | 删列 | 随 cleanup PR |

## 测试与发布策略

- 每 phase 独立可发布；fan-out 全程是加法，无需 feature flag（N=1 路径不变即是回退面）；Phase 3 的 scheduler gate 摘除给一个环境变量开关灰度一版
- 主进程新模块（run-group-service / notifications / custom runtime）配单测；重点覆盖：fan-out 部分失败、adopt 冲突中止、worktree GC 的"不删 dirty"不变量
- 每 phase 结束用 `AEGIS_USER_DATA_DIR` 隔离环境 + 一次性 git 仓库走新用户全流程

## 工作量粗估（相对值）

Phase 1 ≈ 中大（服务编排 + composer 多选 + 自动布局，外加评审补进的启动清算/最小回收/布局审计；机械基础全在）；Phase 2 ≈ 中大（比较 UI + merge 语义 + GC 是新逻辑密集区）；Phase 3 ≈ 视决策点 11——仅 macOS 则小中，含 tray 则中；Phase 4 ≈ 大（PTY runtime 化 + 注册 UI + 类型系统扩展 + WorkspaceHost surface 分派与 pty 生命周期均为净新增）；cleanup PR ≈ 小（纯删除）。

---

## 决策点汇总（需要拍板）

1. fan-out 成员默认权限 —— 建议：worktree 下默认 full-access 档、composer 可改保守；rationale 如实：worktree 非沙箱，此默认与 automation 现状基线一致（automation 已在主工作区跑 full-access），属收紧；codex 用 workspaceWrite+writableRoots=worktree 替代 danger-full-access
2. 采纳策略 —— 建议：squash-merge 到主工作区暂存区（用户审查后自行 commit），不用 stash/apply
3. persona 脚手架删除时机 —— 建议：Phase 2 落地后集中 cleanup PR，期间冻结
4. N > 4 的呈现 —— 建议：平铺前 4，其余从 sidebar group 节点/比较视图进入
5. 非 git 项目 —— 建议：禁用 fan-out 入口并提示（worktree 是隔离前提，不做拷贝目录的降级方案）
6. 单组成员上限 —— 建议：软上限 6；全局并发维持现状（无锁）
7. custom runtime 的类型接法 —— `custom:<id>` 命名空间 vs 平行判别联合，Phase 4 动工时定
8. 赢家分支保留期 —— 建议：adopt 后保留一个版本周期再 GC（误采纳可恢复）
9. `.worktrees/` 的 git 排除方式（评审发现 1）—— 建议：幂等写 `.git/info/exclude`（不动用户 `.gitignore`）；备选：fan-out worktree 移出仓库到 userData 按 projectCwd hash 分目录（注意移出不改变 full-access 的 blast radius，仅降低误操作概率）
10. RunGroupView 的 leaf 接法（评审发现 8）—— 持久化 'group' surface（schema bump + validatePaneNode 修复）vs store 侧临时映射（零 schema、不跨重启）；Phase 2 动工前拍板
11. Phase 3 平台范围（评审发现 7）—— 建议：首版明文仅 macOS，win/linux 关窗遇 running 任务弹确认；最小 tray 作为后续
12. automation 能否触发 fan-out（评审发现 14）—— 建议：Phase 3 顺手做（scheduler 改调 `startRunGroup`，"每晚扇 3 个 agent、早上看比较"是本方案原语的自然组合）；若不做，明文列入 non-goals；cleanup PR 删 team 字段时顺路给 `AutomationRuntimeConfig` 加 variants 形状
