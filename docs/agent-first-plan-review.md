> 本报告由五维度评审团（数据模型/git 正确性/编排/UI-UX/范围分期）+ 逐条对抗验证产出（2026-07-02）。原始发现 30 条，确认 15、反驳 15、存疑 0。

# 《Agent-First 方案 v2》最终评审报告

评审对象：`/Users/chengshengdeng/coworker/docs/agent-first-plan.md`（2026-07-02 版）
评审方式：多视角（数据模型 / git 正确性 / 编排 / UI-UX / 范围分期）评审 + 对抗验证。以下所有发现均经代码级核实**确认成立**，严重度已按验证阶段的修正意见调整（原始定级与验证后定级不一致处均采用验证后定级）。行号引用以当前 master 为准。

---

## 一、高危（不修不能动工 Phase 1）

### 1. `.worktrees/` 建在仓库根内且无任何 git 排除机制：用户仓库主工作区永久 dirty，Phase 2 的 adopt 门禁死锁
**（合并了 git-correctness 与 scope-phasing 两个视角的同一发现）**

- **问题**：`createWorktree` 默认把 worktree 建在 `<repoRoot>/.worktrees/`（git-service.ts:233），而全 `src/` 无任何写 `.git/info/exclude` 或 `.gitignore` 的代码。链接 worktree 目录会以 `?? .worktrees/` 出现在主工作区 `git status` 中——**Aegis 自己的仓库看起来干净，纯粹是因为开发者手工在 `.git/info/exclude` 里加了 `.worktrees/`（本仓库 exclude 第 7 行），用户的仓库不会有这行。**
- **后果链（均已实测复现）**：
  - Phase 2.6 的"adopt 前检查主工作区 dirty，dirty 时要求先 stash/commit"在 fan-out 存续期**持续命中**，且给出的两条出路分别无效和有害：`git stash -u` 对该路径输出 "Ignoring path .worktrees/…"、stash 后条目仍在；`git add .` 会把 worktree 加成 embedded-repo gitlink 提交进仓库。
  - Phase 2.5 验收标准"主工作区 git status 干净"在 fan-out 存续期无法达成。
  - 现有 handoff 的 stash 判定（`hasDirtyWorkingTree` 用 `--untracked-files=all`，git-service.ts:47-51，经 `stashWorkingTree` 在 ipc-handlers.ts:5728/5734 生效）在主工作区侧会误判 dirty 并创建多余的近空 stash 条目（worktree 侧 5790 不受影响）。
  - changes UI 会多出一条折叠的 `?? .worktrees/` 条目（非"成堆文件"，此处收窄原始表述）。
- **对方案的修改**：在 **Phase 1.2** 增加必做工作项并列为**新决策点**，三选一拍板：
  1. `createWorktree`（或 run-group-service 首次建 worktree 时）幂等向 `$(git rev-parse --git-common-dir)/info/exclude` 追加 `.worktrees/`（不动用户 `.gitignore`）；
  2. fan-out worktree 移出仓库（如 userData 下按 projectCwd hash 分目录）；
  3. 明确规定 2.6 的 dirty 检查用 `--untracked-files=no` 或 `git diff --quiet`（排除 untracked）。
  同时 **Phase 1.6 验收标准**加一条："fan-out 进行中，主工作区 `git status --porcelain` 不出现 `.worktrees` 条目"。**不能等 Phase 2 测 adopt 时才发现。**

### 2. 崩溃/强退后 `running` 状态无任何自动收敛路径，group 永远停在 running，Phase 3 通知永不触发

- **问题**：方案的 group `running → settled` 转移只由 run-group-service 在内存里监听"全员到达终态"驱动（1.2 行 91）。但 `sessions.status` 是持久化列（session-store.ts:449，DEFAULT 'idle'），app 崩溃后 runner 全部消失，被杀成员永远停在 `status='running'`——**代码库不存在任何启动期把 orphan running session 重置为终态的逻辑**（`listRunningSessions` 全仓唯一调用者是 ipc-handlers.ts:5531-5543 的分支切换阻塞检查；main.ts 无 startup sweep）。方案 3.1"状态以 SQLite 为准"只覆盖主进程存活的关窗场景，恰恰不覆盖主进程崩溃。
- **加重证据**：ipc-handlers.ts:5575/5685 用 `status==='running'` 门禁 handoff/checkout，崩溃残留今天就会实际阻塞 git 操作；`automation_runs` 已存在同类现症 bug（残留 running run 使 `listDueAutomations`/`hasRunningAutomationRun` 永久跳过该 automation）——这个 bug class 在本代码库有真实先例。
- **收窄**：并非字面"永远无法收敛"——用户可对成员逐个手动 stop（ipc-handlers.ts:8808 无条件置 idle）解卡，但不存在自动收敛，且 group 是否随之 settle 方案未作规定。故定级从 critical 调整为**高**。
- **对方案的修改**：**Phase 1**（不是 Phase 3）必须包含启动期清算：boot 时把无 runner 句柄的 `status='running'` session 标为 `'error'`（或新增 `'interrupted'`），随后重算所有 running group。更根本地，**1.2 应把 settled 判定改写为"从成员状态派生的幂等函数"**（每次成员终态变化和每次启动都跑），而非一次性内存事件。**1.6 验收标准**"重启后 group 与成员关系从 SQLite 恢复"应补上"状态也收敛"。

---

## 二、重要（Phase 1 范围内必须补的设计缺口）

### 3. "不建成员表"无法表达 worktree 创建失败的成员：失败成员没有 session 行，重启后从 group 里凭空消失

- **问题**：1.2 的启动顺序是 建分支 → `createWorktree` → 构造 payload → `handleSessionStart`，而 session 行是 `handleSessionStart` 内部才创建的（ipc-handlers.ts:7438）。1.2 明确列举的"worktree 建不出来 → 该成员标 failed"发生在 session 存在之前——此时"成员即 `sessions WHERE run_group_id`"里没有这个成员，failed 无处持久化，直接违反 1.6 验收"重启后 group 与成员关系从 SQLite 恢复"（3 选 2 的组重启后看起来像 2 成员组）。
- **收窄**："provider 未 ready"一类不受此影响（composer readiness gate + handleSessionStart 先建行后做 runtime 检查双重覆盖）；"sessions 无 error 明细列"属既有全局限制而非方案矛盾（现有代码 runtime 检查失败连 messages 都不写），可作为可选增强。
- **对方案的修改**：**1.2** 二选一：(a) 调整顺序为**先 `createSession`（带 run_group_id、variant 配置）再建 worktree**，失败则置 `'error'` 并写一条失败 message；(b) `run_groups` 存 `variants` JSON（每成员 provider/model/失败原因/可空 session_id），成员语义由 group 行承担。error 摘要字段为可选增强。

### 4. run_groups 状态机不完备：discard 无落点状态、`adopted_session_id` 会悬挂、成员删光后 group 成孤儿行

- **问题**：
  - 1.1 的枚举 `running|settled|adopted|cancelled` 没有 discard 的终态：2.2"Discard all"和 2.4 `runGroup.discard` 都只定义了 worktree 清理，未定义状态迁移；`cancelled` 已被 1.2 定义为"全员失败"，语义不可复用。（属规格缺口，非"内部矛盾"。）
  - `deleteSession` 是硬删除（session-store.ts:2181-2194，只级联 messages），ipc-handlers.ts:8832-8856 的删除路径无 group 感知，方案未定义 FK/级联：删被采纳 session → `adopted_session_id` 悬挂；成员逐个删光 → run_groups 孤儿行（是否渲染成空组取决于 1.5 分组从哪侧派生，UI 后果存推断成分，脏数据确定存在）。
  - **文档勘误**：0.2 引用的 "deleteSession（session-store.ts:748-760）" 实为 `purgeImportedClaudeCodeSessions` 事务内恰好同名的局部变量；真正的 `deleteSession` 在 **session-store.ts:2181**。0.2 的实质论断（不清理 worktree、纯泄漏）在正确位置依然成立。
- **对方案的修改**：**1.1** 枚举补 `'discarded'`（或明文重定义 cancelled 语义并声明 discard 复用之）；**2.4** 给 `deleteSession` 补 group 收尾：删的是 `adopted_session_id` 则置 NULL、删最后一个成员则连带删/标记 group 行；**0.2** 行号改为 2181。状态枚举建在 Phase 1 的 schema 里，动工前就应定对。

### 5. Phase 1 批量制造 worktree，但全部生命周期治理排在 Phase 2：泄漏被扇出倍数放大，且方案自称"每 phase 独立可发布"

- **问题**：方案 0.2 自己承认现状"纯泄漏"，但 Phase 1 的 `runGroup.cancel` 只取消成员不清 worktree，discard/GC 全在 Phase 2；1.6 验收六条无任何清理项，1.7 风险也不提磁盘积累。核实现存**三条用户路径全部泄漏**：cancel、删 session（session-store.ts:2181-2194 无 worktree 处理）、handoff 切回 local（ipc-handlers.ts:5689-5763 只置空 `worktreePath` 不删目录）；`removeWorktree` 全仓唯一调用点是 handoff 失败回滚（ipc-handlers.ts:5844）。Phase 1-only 状态下每次 fan-out 净增 N 个工作区 checkout + N 个分支（git worktree 共享对象库，是"N 倍工作区文件"而非 N 倍仓库，此处收窄），零回收入口。
- **对方案的修改**：把 **2.4 的最小子集前移进 Phase 1**：`runGroup.cancel`/组删除时对 clean worktree 执行 `removeWorktree` + 删分支；`deleteSession` 的 worktree 清理一并修掉（本就是还债）。启动时 GC 扫描可留 Phase 2。**1.6 验收**加"取消/删除组后 `.worktrees` 无残留"。

### 6. 自动平铺触发时机未定义，且现有搜索面板导航会砸掉整棵平铺树

- **问题**（两个方向）：
  - 1.5 说 "`runGroup.changed` 到达 renderer → 自动布局"，但该广播是组快照广播、会重复到达（至少 settle 时，1.2 行 91；成员失败时是否广播方案未定义——这本身也是时机未定义的佐证），按字面实现会在错误时机重复平铺，砸掉用户手动调整的布局。1.3 的 `runGroup.start` 同步返回 `groupId + memberSessionIds`，才是天然的一次性布局触发点——方案内部不一致。
  - 反向更实在：`setChatLayoutMode('single')` 会把整棵树坍缩成单 leaf（useAppStore.ts:1948-1955），而搜索面板 `openThreadFromPalette` 无条件调用它（Sidebar.tsx:359，src/ 下唯一 'single' 调用点，经 Sidebar.tsx:518 接入 SidebarSearchPalette）——fan-out 平铺后用户搜索打开任一线程（包括成员自己），4-pane 布局立即全毁且无 undo。
- **对方案的修改**：**1.5** 明确：布局只在 `runGroup.start` 调用返回处触发一次（renderer 主动布局），`runGroup.changed` 只更新数据。**Phase 1 加工作项**：审计 `setChatLayoutMode('single')` 调用点（至少搜索面板一处）改走保留布局的 `setActiveSession`/`placeSession` 路径。**1.6 验收**加"平铺后经搜索/侧栏导航不破坏布局"。

### 7. Phase 3 的"关窗照跑"在 Windows/Linux 上不成立，而 app 三平台发布

- **问题**：close→hide 驻留是 darwin-only（main.ts:624-627）；非 macOS 上 `window-all-closed` 直接 `app.quit()`（main.ts:945-949），关窗即杀所有 runner 和 fan-out 组。electron-builder.json:27-50 + release workflow matrix（macos/windows/ubuntu）证明三平台是真实发布路径；全仓无 Tray。方案 3.1 虽用括号承认"macOS 常规行为"，但对 win/linux 的后果、tray 方案或平台范围声明零提及，8 个决策点无一涉及——Phase 3 头号承诺在 2/3 平台静默失效。
- **对方案的修改**：**Phase 3 增加显式平台决策点**：要么明文声明 Phase 3 仅 macOS（win/linux 关窗前弹"仍有任务运行"确认），要么把最小 tray（win/linux 关窗转驻留 + 退出菜单）纳入 Phase 3 并把工作量从"小中"上调。

### 8. RunGroupView 装进 leaf 不是"随手二选一"，是一个未列入决策点清单的实质设计选择

- **问题**：2.2 一句括号"pane surface 沿用 'chat' 容器或新增 'group'"掩盖了两条路的成本差异：LeafNode 载荷只有 `{sessionId, surface}`（layout-tree.ts:27-32），run group 没有 session 可挂；若新增 'group' surface 并持久化，需扩 leaf 载荷、bump schema version（layout-adapter.ts:21），且有隐蔽陷阱——`validatePaneNode` 用字符串比较把未知 surface 强转 'chat'（layout-adapter.ts:124），扩了类型联合 TS 也不会在此报错，存过的 'group' leaf 重启后**静默降级成空 chat pane**。另有第三条路（原发现"必然返工"表述过强，验证时收窄）：leaf 载荷不动，用 store 侧 paneId→groupId 临时映射驱动 RunGroupView，零 schema 改动，代价是 group 视图不跨重启持久（方案验收未要求持久，三个入口均可重推导）。
- **对方案的修改**：把此项加入**决策点清单**，Phase 2 动工前拍板；若选持久化 'group' surface，把 `validatePaneNode`/schema 迁移/`placeSession`/`clearMissingSessions`/`closePane` 的不变量核对**计入 Phase 2 工作量**。

### 9. Phase 4 的 "`surface:'terminal'` 已支持"只在类型层面成立：渲染层从不消费 surface，终端根本不是树 leaf

- **问题**：4.2 与 0.1 都把它列为已就位资产，核实结果：'terminal' 只存在于类型枚举（layout-tree.ts:24）、持久化归一（layout-adapter.ts:124,169-170）和一条零调用者的 store 变更管线（`setChatPaneSurface`）里；唯一在用的 tiling 渲染器 WorkspaceHost 对每个 leaf 无条件渲染 ChatPane、全文不含 'surface'（WorkspaceHost.tsx:121-129）；现有终端挂在右侧 utility dock（App.tsx:1030-1038 + SessionTerminal），不在树内；layout-tree.ts:388-389 注释自证"revisit for terminal pty survival when terminals become tree leaves"（movePane 不保留 leaf id）。Phase 4 的 PTY pane 渲染层是净新增工作，工作量枚举未含。
- **对方案的修改**：**0.1** 资产描述改为"surface 枚举与持久化已预留 'terminal'，渲染层未接"；**Phase 4** 增加明确工作项：WorkspaceHost 按 surface 分派渲染 + 终端 leaf 的 pty 生命周期（关 pane/movePane 时 pty 归属），并相应上调工作量。

---

## 三、中低（应修，但不阻塞动工）

### 10. 2.1 的 diffstat 用 `base_ref...HEAD`，在"agent 不 commit"这个最典型场景下 +/- 恒为 0

- **问题**：`base_ref...HEAD` 是两个 commit 间的比较，不含工作树；成员分支从 base_ref 新建、CLI agent 通常不 commit（方案 0.2 / 2.3 第 1 步自己均以此为前提），故 HEAD == base_ref，该项恒为空；porcelain 补充只能给 changed files 数（含未跟踪文件，这点其实做对了），给不出承诺的 insertions/deletions——摘要卡片 +/- 在最常见场景显示 0/0，违反 2.5 验收"diffstat 正确"。**收窄**：2.2 的全量 View diff 传 worktree cwd + base_ref，是工作树对 ref 比较，不受影响——坏的只是摘要卡片数字，一行 spec 即愈，非"地基错误"（原 major 降为中低）。
- **对方案的修改**：**2.1** 改为 `git diff --stat <base_ref>`（工作树比较，与 2.2 形式一致；配合 `git add -N` 或沿用 porcelain 计入未跟踪文件），或把 2.3 第 1 步的自动 commit 提前到 summary 采集前。

### 11. 决策点 1 的 rationale"隔离已兜底"是事实错误的安全论证

- **问题**：git worktree 只隔离工作副本，不是沙箱：claude 的 bypassPermissions → `allowDangerouslySkipPermissions`（runner.ts:649，无 fs/网络约束）；codex 的 fullAccess → sandbox `'danger-full-access'`（codex-app-server-manager.ts:611-615）；且默认 worktree 就在 repoRoot 内。1.7 第三条虽列了"full-access 默认权限的半径"，但用同一错误前提消解风险。**收窄**（原 major 降为中低）：现有 automation 已默认 bypassPermissions/fullAccess/yolo 且直接跑在主工作区（automation-scheduler.ts:37-45）——fan-out 相对现状是收紧而非新风险类别；问题在于文档不应以失实论证背书。
- **对方案的修改**：**决策点 1** rationale 改为如实陈述风险（含与 automation 基线对比）再拍板；codex 成员可用现成的 `workspaceWrite + writableRoots=worktree` 机制（codex-app-server-manager.ts:667/681）替代 danger-full-access；worktree 移出 repoRoot 作为次要决策点列出（注意：移出不改变 full-access 的 blast radius，仅降低误操作概率）。

### 12. 1.2 串行化理由"git index lock"写错，且缺成员级 preparing 状态与串行延迟预期

- **问题**：每个 linked worktree 有独立 index（`$GIT_DIR/worktrees/<name>/index`），`worktree add` 不碰主 index；按方案自身命名方案（分支/路径两两不同），并发 add 连 refs 锁通常也不实际竞争，串行的正当理由是"防御 git 并发边界（reftable 全局 ref 锁、worktrees 管理目录竞态等）的最简做法"。理由写错会误导实现者的锁模型。另：`createWorktree` 单次超时 120s（git-service.ts:238），成员 session 在 worktree 建成后才创建，大仓库串行 N 次 checkout 期间成员无状态可显。
- **对方案的修改**：**1.2 步骤 2** 更正措辞；补充成员 `preparing → running` 状态显示与串行启动延迟预期。

### 13. 1.4 的"readiness 未 ready 不可选中"与现有故意放行的设计矛盾

- **问题**：现有单选控件刻意允许选中非 ready provider，注释明写 "Selecting an agent that isn't ready is allowed (statuses can be stale)"（ComposerAgentControls.tsx:72-79），走 toast + 圆点警示。readiness 有 'checking' 瞬态（首次探测前全部六 provider 均为 checking，缓存 TTL 30s），硬禁用会在开窗瞬间灰掉整个多选、同一 agent 单选可用多选置灰；且 1.2 已有服务端成员级 fail-soft，前端硬 gate 是多余且更脆的一层。
- **对方案的修改**：**1.4** 改为与现有语义对齐：多选允许勾选非 ready，沿用圆点 + toast（提交确认区汇总"N 个成员可能未就绪"），只对 'missing'（未安装）禁用，终判交给 1.2 的成员级失败路径。

### 14. automation × fan-out 的关系整块缺失

- **问题**：方案两处触碰 automation（Phase 3 摘 gate、cleanup 删 team 列），却从未回答定时任务能否触发 run group——"每晚扇 3 个 agent、早上看比较视图"恰是本方案原语的自然组合。现有 `buildAutomationSessionPayload` 与 `AutomationRuntimeConfig` 都是单 variant 形状，日后支持需再改一轮 schema。方案有明写 non-goal 的惯例（2.6、Phase 3），此处却既不排期也不排除。
- **对方案的修改**：加**决策点 9**：automation 触发 fan-out 是否在范围内。若做，最晚 Phase 3（scheduler 改调 `startRunGroup` 即可），并让 cleanup PR 删 team 字段时顺路给 runtime 加 variants 形状；若不做，明文列入 non-goals。

---

## 四、存疑的发现

无。所有进入本报告的发现均经对抗验证 confirmed，没有验证阶段无法达成一致的存疑项。需要说明的分歧仅是**定级与措辞的收敛**（已在上文各条标注），其中三处实质性下调：

- 发现 2（崩溃收敛）：从 critical 降为高——存在手动逃生口（逐成员 stop），失败模式是卡死而非数据丢失；
- 发现 10（diffstat）：从 major 降为中低——只影响摘要卡片数字，深比较与 adopt 流程不受影响，一行 spec 修复；
- 发现 11（full-access）：从 major 降为中低——相对现有 automation 基线不是新风险类别，问题在论证失实而非引入风险。

另有两处普遍性勘误请一并修入文档：0.2 的 `deleteSession` 行号（748-760 → 2181-2194）；1.2 的串行化理由措辞。

---

## 五、总体判断

**方案骨架成立，但不能按现状直接动工 Phase 1。** execution-first 的路线选择、"比较层建在 git 而非协议上"的核心判断、以及 N=1 路径不变的回退面设计都经得起推敲；问题集中在 Phase 1 的 schema/生命周期细节和几个被"落地时定"掩盖的实质决策上——而 schema 与 git 卫生是最难返工的部分。

**动工 Phase 1 前必须先修（写回方案再开工）：**

1. **`.worktrees/` 排除机制**（发现 1）——三选一拍板并进 Phase 1 验收，这是 Phase 2 adopt 的生死前提，也是 Phase 1 用户仓库卫生问题；
2. **启动期状态清算 + settled 判定改为派生幂等函数**（发现 2）——写进 1.2/1.6；
3. **成员失败的持久化落点**（发现 3）——先 createSession 再建 worktree，或 group 存 variants，影响 1.1 schema；
4. **状态枚举补 discarded + deleteSession 的 group 收尾语义**（发现 4）——枚举在 Phase 1 建表，动工前定对；
5. **最小 worktree 回收前移**（发现 5）——cancel/删除时清 clean worktree，进 1.6 验收；
6. **布局触发点改为 runGroup.start 返回处 + 修搜索面板砸布局**（发现 6）——否则 Phase 1 的核心演示场景（平铺后继续操作）当场破功。

**动工前只需在文档补决策点、可留到对应 Phase 实施的：** Phase 3 平台范围（发现 7）、RunGroupView surface 接法（发现 8）、Phase 4 terminal 渲染层工作量（发现 9）、diffstat 命令形式（发现 10）、决策点 1 rationale 重写（发现 11）、以及三条 minor（发现 12-14）。

上述 6 条前置修复中，1、2、5 有代码级现症先例佐证（手工 exclude、automation_runs 卡死、三条泄漏路径），不是理论风险。修完这六条并更新 1.6 验收标准后，Phase 1 可以放心动工。
