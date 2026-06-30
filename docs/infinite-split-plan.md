# 无限分屏(递归 tiling)实现计划

> 本文经四维度 agent 评审(数据模型 / 状态持久化 / 渲染拖放 UX / 范围耦合分阶段)+ 用户决策定稿。

## 决策(已锁定)
1. **禁止**同一 session 出现在多个窗格。沿用现有去重,抽 `placeSession(leafId, sessionId)`:先腾空任何已持有该 session 的叶(触发收拢),再写入目标叶。split / setSession 复用它。
2. 落点只有 **4 个方向边缘区**(按对角线把窗格分成上/下/左/右),**无中间替换区**。空窗格(sessionId=null)则落上去直接填入,不算替换。
3. Side Chat **并入树**:删除 `RightSideChatPanel` / `dockSecondaryPane` / 右侧栏 `side-chat` 伪 tab 及相关特例;「Side Chat」启动项 = `splitPane(activeLeaf,'right',null)`。
4. 侧栏去掉 LEFT/RIGHT 配对行;在树里打开的会话在普通列表显示**选中高亮**(聚焦叶更强),不藏、不做徽标。
5. 命令面板开线程:**载入当前聚焦窗格、保留其它窗格**(取消原来的强制塌成单格)。

## 1. 数据模型
```ts
type PaneId = string;                       // uuid
type SplitOrientation = 'row' | 'col';
type PaneNode =
  | { type:'leaf';  id:PaneId; sessionId:string|null; surface:'chat'|'terminal' }
  | { type:'split'; id:PaneId; orientation:SplitOrientation; sizes:number[]; children:PaneNode[] };
interface WorkspaceLayout { root:PaneNode; activePaneId:PaneId; focusOrder:PaneId[]; } // focusOrder = MRU 焦点栈
```
- `chatLayoutMode` 退化为派生 `isSplit = root.type==='split'`。
- `chatSplitRatio` 由各 split 的 `sizes[]` 取代。
- `activeSessionId` 由 active leaf 派生(保留作缓存,每个树 op 后重算)。

## 2. layout-tree.ts(纯函数 + 单测)
- 查询:`findLeaf`、`findParent`、`firstLeaf`、`mapLeaves`、`getActiveLeaf`(**永不空**,悬空则 firstLeaf)。
- 变更:`placeSession`、`splitPane`、`closePane`、`movePane`、`resizeSplit`、`setPaneSurface`、`swapLeaves`(payload 交换,结构不变)。
- 不变量工厂:`makeSplit(orientation, children, sizes?)` 断言 `sizes.length===children.length`、全>0、Σ≈1(构造即归一)。

### 同向合并(i3/sway 规则)— splitPane
```
ori = edge∈{left,right}? 'row':'col';  before = edge∈{left,top}
parent = findParent(leafId)
if parent && parent.orientation===ori:
   i=indexOf(leaf); insertAt=before? i : i+1
   half=parent.sizes[i]/2; parent.sizes[i]=half
   splice newLeaf@insertAt, sizes half@insertAt          // Σ 保持
else: 用 makeSplit(ori, before?[new,leaf]:[leaf,new],[.5,.5]) 原地替换 leaf
```

### 收拢 + 反向 flatten — closePane
```
if leaf 是 root: leaf.sessionId=null; return            // 永不空树
parent=findParent; i=indexOf; splice 掉 children[i]+sizes[i]
if parent.children.length>=2: renormalize(parent.sizes)
else: survivor=parent.children[0]; gp=findParent(parent)
   if gp==null: root=survivor
   elif survivor.type==='split' && survivor.orientation===gp.orientation:
        FLATTEN: 把 survivor.children/sizes 按权重 splice 进 gp,renormalize
   else: gp.children[j]=survivor (sizes[j] 不变)
reselect activePane: MRU focusOrder → 否则同级前一叶 → 否则 firstLeaf
```

### sizes 不变量
插入=分裂叶份额对半;删除=去项后 `remaining/Σ`;resize=仅调相邻两项、保持其和、整体 renormalize 防漂移。

## 3. 渲染(WorkspaceHost 重写)
- 递归 `renderNode`;leaf→`<ChatPane>`(`React.memo`);split→`flex-row/col` + 每个边界一个**方向感知** resizer(`col/row-resize`、`clientWidth/Height`、用 **ref 捕获 split 容器**,不读 pooled event)。
- resize 期间用 local/ref 几何,**mouseup 才 dispatch `resizeSplit`**;用 selector 订阅,避免整树重渲染。
- 拖动时 `setPointerCapture` 或全窗透明遮罩,防 iframe/xterm 吞 mousemove。
- 最小尺寸在 resizer 组件按容器像素 clamp(数据层只存分数);split 创建前校验剩余空间 ≥ min×子数,不足则拒绝。
- 活跃叶给**可见 accent 描边**,不只 bg tint。

## 4. 拖放(ChatPane)
- `onDragOver` 按光标算 4 区(对角线),高亮对应半区;空叶则整块高亮=填入。
- `onDrop`:边缘→`splitPane(thisLeaf,edge,session)`;空叶→`placeSession(thisLeaf,session)`。**无中间替换。**
- 至少给每个叶 header 一个分屏按钮(四向),作为非拖拽入口 + 上下分屏的发现性;键盘分屏/切焦 + resizer `role=separator`+方向键 列为打磨项。

## 5. Side Chat 并入树
- 删 `RightSideChatPanel`、`dockSecondaryPane`(及其 producer)、`activateRightUtilityContent`/`keepSideChatDocked`/`closeUndockedSideChat`/`closeRightUtilityTab` 的 side-chat 分支、rightUtilityTabs 里的 `side-chat`。
- 启动项「Side Chat」→ `splitPane(activeLeaf,'right',null)`。
- Files/Browser/Review/Terminal 右侧工具 tab **不变**(非聊天窗格)。

## 6. 完整触点清单
**store(useAppStore.ts)— 会话生命周期 ↔ 窗格回收**
- `setActiveSession`(1303–1368,选会话中枢)→ `placeSession(activeLeaf,…)`,树形不变。
- `createDraftSession`(2444)、`removeDraftSession`(2469)、`setShowNewSession`(2106)→ 写/清 active leaf。
- `handleSessionsLoaded`(2983)、`handleSessionRemoved`(3314)→ `mapLeaves` 置空已消失会话 + 收拢空叶 + 重定位 activePaneId(沿用 normalizeChatPanes「丢弃陈旧/隐藏会话」不变量,但对**每个叶**)。
- 旧 action 替换:openSplitChat→splitPane/placeSession;closeSplitChat→closePane;swapChatPanes→swapLeaves。
- **每个树 op 末尾统一重算 `activeSessionId = sessionOf(activePaneId)`**(Browser/Review/Terminal/底部终端都 key 在它上)。

**组件 / 其它**
- `ChatPane.tsx`:`paneId` 类型 `'primary'|'secondary'`→`PaneId`(853);scroll key `getChatScrollPositionKey`(56)改为 key on sessionId,避免 split/unsplit 丢滚动位。
- `App.tsx`:render gate(860)用 `isSplit`/`leafCount>1`;移除 dockSecondaryPane 及其 producer(899);side-chat 特例 ~5 处(见 §5)。
- `useActiveEnvironmentContext.ts`:`paneLabelFor`→「Pane N」;`chatPanes[paneId]?? 'primary'`→`getActiveLeaf`。
- `Sidebar.tsx`:`openThreadFromPalette`(359)取消强制 single(决策 5);`onSessionClick`(463)的 `setChatLayoutMode` 与 `preserveSplit` 在新模型下变 dead,随 setActiveSession 改写一并删。
- `FolderTreeView.tsx`:删 `splitPair`/`SplitSessionRow`/`hiddenIds`;改为「在树里的会话 = 选中高亮」(决策 4)。
- `verify:side-chat-drop`:重写为新模型(splitPane 落点 / closePane 收拢 / 迁移自愈)。
- `TerminalLayout.ts`:**独立系统,不动**(仅 `surface:'terminal'` 命名易混,加注释)。

## 7. 持久化与迁移
- **两条路径都加版本**:zustand persist 加 `version`+`migrate`;`UiResumeState` 加 `schemaVersion`。按版本号迁移,不靠形状嗅探。
- 单一确定性 `migrateLegacyPanes(blob)→WorkspaceLayout`:旧 `{primary,secondary,chatLayoutMode,chatSplitRatio}`→树;**已是新数据则保留 UUID**(不重 mint)。
- 挂在**真实入口**:模块初始化 `getInitialUiResumeState`/`normalizeWorkspaceLayout` + persist `merge`,**两处共用同一函数同一 fallback**。**不要用 `applyUiResumeState`(死代码,零调用)**。
- **兼容影子**:过渡 1~2 个版本仍 dual-write 旧 `chatPanes/chatLayoutMode/chatSplitRatio`(由树派生),避免降级丢布局;之后再删。
- 迁移单测:legacy 单格 / 分屏 / 陈旧 secondary(须丢) / 损坏 JSON→安全默认 / 已新数据→identity / 降级模拟;property test:init 路径与 merge 路径同输入产出同构树。
- 手工审非类型化字面量:持久化 JSON 里的 `"primary"/"secondary"`、`=== 'secondary'`、`'primary' as const`、`activePaneId:'primary'` reset、WorkspaceHost 的 `dragTarget` 局部联合类型。tsc 抓不到。

## 8. 子决策默认
- 窗格软上限 8~12;最小尺寸 280px(resizer 像素 clamp);关到只剩 1 空叶。

## 9. Strangler 分阶段(每步可编译可发布)
1. 加法式类型 + `layout-tree.ts` 纯函数 + 单测。不碰旧字段。
2. **适配器 + 早迁移**:state 树与旧字段并存,树为内部真相、旧字段=派生 selector;迁移落在此步。行为不变,可发布。
3. 重写 WorkspaceHost 递归渲染(其余仍读旧 selector)。可发布。
4. 逐文件迁移读取方(含 §6 的 6 个 store 回收函数),每次一文件、都能编译。
5. 边缘落点分屏(真正 >2 能力)。
6. Side Chat 并入树 + 拆右侧 side-chat 特例(决策 3)。
7. 删旧字段/selector + 兼容影子;FolderTreeView 改选中高亮(决策 4)。
8. 打磨:上限、最小尺寸、空树兜底、键盘/a11y、活跃叶描边、动画。

## 10. 风险(残留)
- 核心重写,触点 ≥8 文件 + store 6 函数 + 双持久化 + 拖放。
- activeSessionId↔active leaf 同步要在**每个** op 保证,漏一处右侧面板就绑错会话。
- iframe resize 吞事件、降级兼容、迁移幂等是最易踩坑处,已在 §3/§7 给出对策。
