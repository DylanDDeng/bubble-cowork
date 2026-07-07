# Design Mode 写回方案 (v2,经 4 视角评审修订)

> v1 经 4 个并行评审(技术断言核查/架构集成/对抗红队/产品决策)后修订。
> 3 个 BLOCKER 与主要结构性修改见各节内嵌的 ⚠ 标记;v1→v2 变更摘要在文末附录。

目标:在 Aegis 的 BrowserPanel 里对用户项目的渲染页面做可视化样式编辑,并把改动**写回源码文件**——不是浏览器里的临时状态,而是出现在 git diff 里、刷新后仍然生效的真实代码修改。

核心立场:**写回必须是可信的**。围绕四条原则组织(v2 新增第 4 条):

1. **分层降级**:能确定性写回的机器直接写;不确定的走 agent——但 agent 写回是**同一个 Apply 按钮的慢速形态,不是失败出口**。
2. **验证环**:写回后剥离预览、等样式稳定、全属性差分验证;失败可见、可回滚、绝不静默。
3. **git + patch 兜底**:所有写入以最小 patch 为原语,进 Review 面板;**任何路径都禁止整文件快照覆盖磁盘**。
4. **能力用运行时探针判定,不用文件存在性猜**:tailwind 是否真在管线里、组件是否透传 className、页面有没有 HMR——都注探针实测,探测不过就显式降级。

---

## 1. 总体架构

```
┌─ Renderer ─────────────────────────────────────────────┐
│  BrowserPanel                                           │
│  ├─ 浏览器 chrome 工具条: [design mode 开关]             │
│  └─ ⚠ DesignDrawer(面板内侧抽屉,压缩 viewport 宽度)     │
│      属性编辑器 / scope 切换 / ledger / undo             │
└──────────────┬──────────────────────────────────────────┘
               │ IPC (design-mode-ipc.ts,复刻 browser-ipc.ts 模式)
┌─ Main ───────┴──────────────────────────────────────────┐
│  browserManager 扩展            libs/design-writeback/   │
│  ├─ inspector 注入+did-navigate  ├─ source-locator.ts    │
│  │   重注入                      ├─ tailwind-writer.ts   │
│  ├─ CDP session(debugger)        ├─ css-writer.ts        │
│  │   + Runtime.addBinding 事件   ├─ inline-writer.ts     │
│  │   上行通道                    ├─ verify-loop.ts       │
│  ├─ DevTools 互斥管理            ├─ ledger.ts            │
│  └─ design 激活期 pin 住         └─ file-write-queue.ts  │
│      runtime(豁免 suspend)           (按路径串行,全局共用) │
└──────────────┬──────────────────────────────────────────┘
               │ patch 写入 → dev server HMR → 剥离预览后验证
```

**⚠ BLOCKER 修订(挂载位置)**:右侧 utility tab 是单活动模型(`activateRightUtilityContent` 激活一个即 collapse 其余;browser tab collapse → WebContentsView detach → 30s 后 `suspendSession` 销毁)。DesignModePanel **不能**做顶层 utility tab——那会"一打开属性面板,被编辑的页面就没了"。改为 **BrowserPanel 内部的侧抽屉**:与地址栏 chrome 同级,压缩 viewport div 宽度(bounds 同步已有 ResizeObserver 兜住),开关放浏览器工具条。

**生命周期契约**(v2 新增):design mode 激活期间该 tab 豁免 suspend 计时;`newTab`/导航/`render-process-gone`/view 销毁 → design 会话进入显式失效态:强制退出 design mode,**ledger 保留**并提示(可转 agent 通道),不静默丢弃。browserManager 需暴露 runtime 创建/销毁回调供 designModeService 挂接。

数据流(一次完整编辑):

1. 开启 design mode(门禁见 §2 前置探测)→ 注入 inspector,attach CDP debugger,建 `Runtime.addBinding` 上行通道。
2. 点选元素 → inspector 上报 `{定位键, 组件链, computed styles, matched rules}`。
3. 抽屉显示属性面板;拖动 → 实时预览。**路径 1/3 用带 `data-aegis-preview` 标记的 inline patch;路径 2 预览直接用 CDP `CSS.setStyleTexts` 改规则本身**(所见即所写,避免"inline 预览改 1 个、规则写回改 30 个"的预览欺骗)。
4. Apply(统一按钮,按能力显示"Apply(即时)"或"Apply via agent")→ ledger 整理成 `StyleIntent[]` → 写回引擎。
5. 引擎经 file-write-queue 打 patch → HMR → **剥离预览 → 验证** → 按三态结案(§4),diff 进 Review 面板。

### 前置依赖:dev server(v1 留白,v2 显式)

Aegis 目前**没有**"跑用户项目 dev server"的机制——现状是 agent/用户在终端里自己起,Aegis 不持有其生命周期。且 A 档定位只在 dev build 存在,验证环只在有 HMR 的页面成立(否则会把**正确的写回**超时误判并回滚)。因此:

- 开启 design mode 时探针检测:URL 是否 localhost 系、页面有无 React dev fiber、有无 HMR client(检测 `/@vite/client` script 标签 / webpack HMR 全局)。
- 探测不过 → 面板给一键引导"**让 agent 帮你把 dev server 跑起来**"(注入 composer),而不是一行降级文案。检测到 prod build 时明确说"需要 dev 模式"。
- 无 HMR 时 Apply(即时)禁用,只留 Apply via agent。

## 2. 元素选择与源码定位

### 注入与通道(v2 修订)

- inspector 经 `executeJavaScript` 注入(现有的是一次性调用,需新建可复用注入器),**`did-navigate`/`dom-ready` 时重注入**——脚本不跨导航存活。
- 上行事件(点选、HMR 观测)走 CDP `Runtime.addBinding` + `Runtime.bindingCalled`;guest 页是 sandbox + contextIsolation 且无 preload,没有其他现成 push 通道。
- **DevTools 互斥**:已开 DevTools 时 `debugger.attach` 抛错;attach 后用户点 "Inspect element" 会触发 debugger detach。design mode 期间拦截 `openDevTools`/右键 Inspect 入口,并监听 `debugger.on('detach')` 把面板转为可见错误态。

### 源码定位分档

| 档 | 机制 | 适用 |
|---|---|---|
| A | fiber `_debugSource`(DOM `__reactFiber$*` 反查) | React ≤18 dev |
| A' (v2 新增) | React 19.1+ dev 的 `_debugStack` / `captureOwnerStack()` + JS sourcemap 还原 | React 19,免插件 |
| B | 构建期 data 属性(`@aegis/vite-plugin-inspector` 注入 `data-aegis-src`) | 任何版本,可选增强 |
| C | 仅 selector + DOM 快照 | 兜底,只走 agent |

**⚠ 定位键修订(红队 B1/B5 + 技术核查)**:列号在 Babel(1-based)/@babel/parser(0-based)/SWC/esbuild 间约定不一,禁止精确 col 等值匹配。定位键 = **文件 + 行号锚定 + tagName + 行内序号 + className 原文指纹**,col 只做 ±1 容差参考;任一键歧义(同行多同名元素等)→ 拒绝确定性写回转 agent。文件 hash 变化后(格式化器、agent 改动)**禁止旧坐标盲配**:必须校验坐标处元素的 tagName+className 与 StyleIntent 记录一致,不一致强制重新点选。预打包依赖/无 source 的 `React.createElement` 定位缺失 → C 档。

**安全边界(v2 新增,架构评审)**:`source.file` 来自不受信页面(页面可伪造 fiber 上报 `~/.zshrc`)。写回引擎入口强制:realpath 必须落在会话项目 git toplevel(或其 `.worktrees/*`)内;design mode 仅在 localhost 系 URL 启用(复用 browser-preview-policy 的 pattern)。worktree 场景:写根 = debugSource 所属的 git toplevel,与 Review 面板 cwd 不一致时显式提示。

### Blast radius(⚠ 默认翻转,产品评审)

- **默认改定义处**(v1 默认调用处,评审推翻:调用处依赖组件透传 className,机械失败率高;且把 utility class 散落制度化——Cursor 被批的 design drift 正是这个)。
- 实例数 > 1 时抽屉显示 scope 切换器:"改组件 Button · 影响本页 N 处"(选中时页面高亮全部实例)/"只改这一处";记住用户对同一组件的上次选择。
- "只改这一处"启用前做**透传探针**:预览阶段向调用处试注 class,断言 DOM class 属性 = 旧值∪新增(接住 `{...props}` 顺序覆盖、不透传两种坏味道,红队 B2);探针失败则禁用该选项并说明,不让验证环去撞。
- 实例计数是每页信号,不是全局(红队 C5):定义处编辑前补一个跨文件 import 计数作为第二信号展示("该组件被 12 个文件引用");realpath 在项目根外或多 package 共享的 workspace 包按 node_modules 同等对待(禁写定义处)。
- CSS 规则维度另有自己的 blast radius,见 §3 路径 2。

## 3. 写回引擎

### 输入合同

```ts
interface StyleIntent {
  source: { file: string; line: number; column: number };
  anchor: { tagName: string; classNameSnapshot: string; siblingIndex: number }; // v2: 定位指纹
  edits: Array<{ property: string; value: string; oldComputed: string }>;
  target: 'definition' | 'callsite';
  matchedRules: MatchedRule[];       // CDP CSS.getMatchedStylesForNode
  activeVariantHint?: string;        // v2: 当前胜出的响应式/状态变体(如 'md:')
}
```

### 路径 1:Tailwind className 编辑(主路径)

**门禁(v2 改为运行时探针,红队 B3)**:不看 tailwind 配置文件存在性(styled-components 项目残留 config 会误入此路径导致每次 Apply 必败)。启用条件 = 注入探针元素挂标准类(`p-6`)实测 computed 生效;同时探测 prefix(v3 `tw-`/v4 `tw:`),检出 prefix 即整体降级 agent 并说明(而不是逐次写失败)。每会话探测一次,缓存。

写法:

- `@babel/parser`(TS/JSX/decorators 插件,parse 失败 fail-closed 转 agent)+ **magic-string 只替换 className 字符串那一段**。读文件剥 BOM 并记录、写回还原;不做任何换行 normalize。
- 值→类名:标准 scale 精确匹配优先,否则 arbitrary value(`p-[22px]`);值转义(空格→`_`)与歧义类型提示(`text-[color:var(--x)]`)进映射器。
- **冲突清理直接跑 `twMerge`(v2 修订)**:tailwind-merge 的 classGroup 解析器不外露,"只用冲突表"不可行。接受 twMerge 的副作用(顺手清理用户既有冗余类),在抽屉 diff 预览里如实展示。依赖版本随探测到的 Tailwind 主版本选(v2.x↔v3,v3.x↔v4)。**例外(红队 B4)**:遇到无类型提示的 arbitrary value(`text-[var(--x)]`)组别推断不唯一时,一律保留不删。
- **响应式/状态变体感知(红队 C4)**:写前用 matchedRules 反推当前胜出的类;若是变体类(`md:px-8` 在当前视口生效),则写该变体(`md:px-6`)并在抽屉标注"仅 md 及以上生效"。否则裸类写回在非移动视口会被变体压住,Apply 必败。

**动态 className 的阶梯(⚠ 产品评审:"拒绝悬崖"是全方案最大产品风险——目标用户重度使用 shadcn/cva,`cn(cva(...))` 是标配)**:

1. **静态字面量** → 直接编辑。
2. **cva 感知(v2 新增)**:`cva('base', {variants:{size:{sm:'h-8 px-3'}}})` 的类串全是静态字面量,fiber props 知道当前命中的 variant → 确定性编辑对应字面量。同套 parse+magic-string 手法,把 shadcn 生态从"全拒"翻成"大部分可写"。
3. **cn()/clsx 首参静态** → 编辑首参。
4. **保守追加(v2 新增)**:其余动态表达式,尾部追加类(`cn(expr, 'p-6')`)——文本上安全,生效与否交验证环判定;失败再降 agent。验证环本来就是为"写了但不确定对"设计的,要用足。
5. **agent**:以上全不适用。

### 路径 2:CSS 文件规则编辑

**⚠ BLOCKER 修订(定位链重写,技术核查)**:v1 的"CDP range 经 sourcemap 还原精确行列"在目标场景不成立——Vite dev 的 CSS sourcemap 默认关闭(`css.devSourcemap: false`),dev 下 CSS 是 JS 注入的 style 标签,无 sourceMappingURL。v2 定位链:

1. CDP 前置:`DOM.enable` → `CSS.enable`,监听 `styleSheetAdded` 收集 sheet header。
2. 源文件定位:优先 style 标签上 Vite 注入的 **`data-vite-dev-id`**(带模块绝对路径);sourcemap 可用时(用户开了 devSourcemap)作增强。
3. 文件内定位:按 **selector 原文 + 声明文本匹配**重找规则(不依赖行列),多处命中即拒绝转 agent。

范围:纯 .css / CSS Modules(类名 hash 靠 data-vite-dev-id 已解决源文件问题,规则内按原始类名匹配)。Sass/Less、node_modules、内联 style 标签 → agent。

**CSS 规则的 blast radius(红队 C3)**:写前 `querySelectorAll(selector)` 计数,>1 → 与组件定义处同款二选一("改规则 · 影响本页 N 处" / "只改这个元素"——后者转为在元素上加类/inline);**预览阶段就用 `CSS.setStyleTexts` 改规则本身**,让用户直接看到 30 张卡一起变,预览不撒谎。specificity 预判降级为 best-effort(CDP 不给 winning declaration),真判定交验证环。

### 路径 3:inline style 编辑

已有 `style={{}}` 对象字面量才改;不主动新建,除非用户显式选择。

### 路径 4:Apply via agent(⚠ 呈现方式修订,产品评审)

不再是"Apply 禁用(失败态)+ 另找 Ask agent 按钮"。**单一 Apply 主按钮按能力变形**:"Apply(即时)" ↔ "Apply via agent(数秒)"。用户在面板调好的精确值自动打包(源码定位 + 组件链 + 期望 CSS 值 + matched rules + 截图)注入 composer(`requestChatInjection`;注意其为单槽,pending 未消费时按钮置 pending 防连发)。市场基准里(Cursor)agent 写回本来就是常态,它是同一动作的另一种延迟,不是降级。

### 文本写回

静态 JSXText 直接替换,注意实体转义(`&`→`&amp;`)与 `{'{'}`——DOM textContent ≠ 源文本;`{variable}` 转 agent。

## 4. 验证环 v2(⚠ 红队重点修订区)

**⚠ BLOCKER 修订(A1 自指漏洞)**:预览 inline patch 不归 React 管,Fast Refresh/CSS HMR 都不会清它,验证时它还在元素上(specificity 最高)→ computed 永远等于期望 → 任何错误写回都验证通过。v2 事务把"剥离预览"定为第 0 步。

Apply 事务(逐 intent 粒度,批量 Apply 按条结案而非整批回滚——产品评审:一条失败毁掉整批攒的调整不可接受):

0. **剥离该元素所有 `data-aegis-preview` 标记的 inline 属性;sanity 断言剥离后 computed ≠ 期望值**(相等说明测量无效,本条标"未验证"而不是假绿)。路径 2 撤销 `CSS.setStyleTexts` 预览。
1. 经 file-write-queue 写入:**同 tick 内"重读文件-校验 anchor-打 patch-写"**(消 TOCTOU;agent 的文件写入未来也应并入该队列)。记录**逆向 patch(带上下文行)**,不存整文件快照。
2. 等 HMR:main 侧 `did-navigate` 判整页 reload;页内观测 `document.head` 的 style 标签变化(Tailwind/CSS 改动不触发目标元素 mutation)+ computed 轮询,不依赖 `import.meta.hot` 事件(注入脚本拿不到)。
3. **等样式 settle(红队 A3)**:被测属性连续两帧 computed 稳定再取值,或验证期临时注入 `*{transition:none!important}`——否则 `transition-all` 项目每次 Apply 都被过渡中间值误判回滚。
4. **全属性差分验证(红队 A5)**:比对的不只是被编辑属性(数值 0.5px 容差、颜色转 RGB),还断言:该元素其余 computed 不变;DOM class 属性 = 预期合并结果(接住 twMerge 误删、透传覆盖);路径 2 时对同 selector 其他命中元素采样断言只有目标属性变化。
5. 三态结案:
   - **成功** → 清该条 ledger,Review 面板经新增的 `reviewDiffRefreshNonce` 刷新(现有 hook 无外部刷新入口,需加;可选为写回生成 ChangeRecord 进 turn 级 diff)。
   - **失败** → 按类别处置(v2 细分,产品评审):(a) 构建报错/页面崩 → 自动回滚;(b) 代码写对但被更高优先级规则覆盖 → **不自动回滚**,三选:保留代码(解释为何没生效)/回滚/交 agent 顺手解决 specificity;回滚一律**重放预览 override**——页面视觉停在用户调好的状态,面板显示"写回被挡,预览已保留 → 一键交 agent",用户的调整劳动永不蒸发。
   - **未验证(v2 新增第三态,红队 A4)**:元素 HMR 后不在 DOM(modal/dropdown 状态丢失、Fast Refresh 整树 remount、深层路由整页刷新)→ **保留写入**,黄色标记"已写回、未验证",提示复现该 UI 状态后补验。不回滚(避免误杀正确写回),不绿灯(不说谎)。
6. 回滚 = 应用逆向 patch,应用前做上下文匹配;**磁盘内容 ≠ 自己写入后的内容时禁止覆盖**(红队 A2:那 3 秒窗口里用户/agent 可能保存了改动),改为逐行匹配打逆向 patch,不匹配即中止并提示人工处理。

## 5. 撤销与审查

- 写回 = 普通文件 patch,进 Review 面板(补 refresh nonce;给 design 来源的 hunk 打标记)。
- **undo 栈存逆向 patch + 上下文,不存文件快照**(红队 C2:快照恢复会抹掉 Apply 之后用户手写的代码)。上下文不匹配 → 拒绝 undo 并解释。
- 未 Apply 状态可见:抽屉常驻"N 处未应用"计数;关 design mode/导航/关 tab 前拦截确认。
- 不自动 commit。

## 6. 进程与模块划分

| 模块 | 位置 | 职责 |
|---|---|---|
| `design-inspector.js` | 注入页面 | 高亮/选中/预览 patch(带标记)/fiber 定位/head 观测/binding 上报 |
| `browserManager.ts` 扩展 | main | 注入与重注入、CDP session、DevTools 互斥、runtime 生命周期回调、design 期 pin suspend |
| `design-mode-ipc.ts`(新) | main | 复刻 browser-ipc.ts 模式:channel 常量 + register/dispose + ledger 状态广播 |
| `libs/design-writeback/` | main | source-locator / tailwind-writer / css-writer / inline-writer / verify-loop / ledger / **file-write-queue** — 全部纯函数化 |
| `DesignDrawer.tsx` | renderer | BrowserPanel 内抽屉:属性编辑、scope 切换、三态结果、undo、未应用计数 |

依赖:`@babel/parser`、`magic-string`、`tailwind-merge`(整包 twMerge,版本随探测)。全在 main,不进 renderer bundle。

测试:`scripts/verify-design-writeback.mjs`,fixture 覆盖:静态/cva/cn 首参/纯动态 className、同行多元素、CRLF/BOM、CSS Modules、Sass(应拒)、node_modules(应拒)、workspace 包(应拒定义处)、prefix 项目(应整体降级)、CSS 变量 arbitrary value(应保留)、响应式变体。**验证环 e2e 必测:预览剥离(A1)、transition settle、回滚不覆盖第三方写入**。

## 7. 里程碑

- **M1「Element Inspector」**(⚠ 改名,产品评审:没有写回前别叫 design mode,避免按 Onlook 预期被评为半成品):inspector 注入 + 重注入、CDP 通道与 DevTools 互斥、A/A' 档定位、组件链展示、点选上下文注入 composer、**抽屉壳 + 挂载位置**(BLOCKER 决定了抽屉必须 M1 就做对)、dev server 探测与引导。独立可交付:"用手指着元素跟 agent 说话"。
- **M1.5「精确值 via agent」**(v2 新增,产品评审):属性面板 + 实时预览 + "Apply via agent"打包精确值。自洽产品:可视化出 spec,agent 执行,覆盖 100% 代码形态。**它把确定性写回从"功能成败线"降格为"高频路径提速"——agent 是地板,确定性是加速**。
- **M2「Tailwind 即时写回」**:路径 1 全量(探针门禁、cva 感知、保守追加、twMerge、变体感知)+ 验证环 v2 全部机制 + file-write-queue + Review nonce + undo(patch 版)+ 文本写回。验收:HMR 探测通过的 Tailwind 项目上,Apply 即时成功率与"失败不丢工作"达标。
- **M3「CSS 文件写回」**:路径 2(data-vite-dev-id 定位链 + selector 计数 blast radius + CSS.setStyleTexts 预览)。
- **M4 打磨**:write-through 模式、B 档 Vite 插件发布、跨文件 import 计数、per-组件 scope 记忆。

## 8. 风险表(v2)

| 风险 | 对策 |
|---|---|
| 预览污染验证(A1) | 事务第 0 步剥离 + sanity 断言;e2e 必测 |
| 快照覆盖抹掉第三方改动(A2/C1/C2) | patch 原语 + 写队列同 tick 重读校验 + 回滚前 hash 复核 |
| 单属性验证盲区(A5/B2/B4/C3) | 全属性差分 + class 字符串断言 + selector 采样 |
| 拒绝悬崖杀留存(shadcn/cva) | cva 感知 + 保守追加 + Apply 统一形态;agent 是地板 |
| 无 HMR 页面误回滚正确写回 | HMR 探针门禁;探测不过禁用即时 Apply |
| React 19 无 `_debugSource` | A' 档 `_debugStack`/`captureOwnerStack`;B 档插件;C 档兜底 |
| 列号跨工具链不一致 | 行号+tag+序号+指纹匹配;歧义即拒 |
| DevTools/Inspect 杀死 CDP session | design 期拦截入口 + detach 监听转错误态 |
| view suspend/导航销毁 design 会话 | design 期 pin runtime;销毁 → 显式失效态,ledger 保留 |
| 页面伪造 source.file | realpath 项目根校验 + 仅 localhost 启用 |
| tailwind 假阳性探测(残留 config) | 运行时探针元素实测 + prefix 检测 |
| 格式化 watcher 使坐标失效 | anchor 指纹校验,不一致强制重选 |
| 与 agent 并发写同文件 | file-write-queue 按路径串行;长期把 agent 写入并入同队列 |

---

## 实现状态(feat/design-mode 分支)

M1 + M1.5 + M2 已落地并通过测试;两个实现决策与 v2 文本有偏差(都更保守),两块 M2 项顺延:

**已实现**:inspector 注入/重注入、A 档 fiber 定位、B 档 data-aegis-src 读取、组件链、
实时预览(`data-aegis-preview` 标记)、DesignDrawer(BrowserPanel 内抽屉,间距/字号/字重/圆角/颜色)、
Apply 统一按钮(即时 ↔ via agent)、路径 1 写回全量(scale+arbitrary+twMerge+var() 保留)、
验证环 v2(剥离预览→settle 轮询→全属性差分→三态)、file-write-queue、逆向 patch undo/rollback、
localhost + 项目根安全门禁、suspend pin、能力探针(fiber/HMR)。
测试:`verify:design-writeback`(纯逻辑 + wiring,进 npm test)、`verify:design-e2e`
(真实 Vite+React18+Tailwind4 页面全闭环,独立入口)、fixture 项目 `dev-fixtures/design-mode-demo`。

**实现偏差(比 v2 文本更保守)**:
1. **事件通道用页内队列轮询,不用 CDP `Runtime.addBinding`**——不 attach debugger,
   DevTools/Inspect element 互斥问题整类消失,代价是 ~300ms 轮询(仅 design mode 开启时)。
2. **anchor 解析为指纹优先**:实测(fixture)发现现代 @vitejs/plugin-react 的 fiber 行号是
   **中间转换阶段**坐标,连 served sourcemap 都无法正确回映(阶段错位)。解析链改为:
   直击 → className 指纹唯一匹配(命中即精确,歧义即拒)→ sourcemap 回映(best-effort)。
   静态 className 由快照校验兜底,动态 className 由验证环 "classes landed" 断言兜底。

**顺延项**:cva 感知写回(动态 className 阶梯的第 2 级,shadcn 关键)、变体感知的运行时推导
(接口已留 variantHint,drawer 暂传 null)、React 19 A' 档(`_debugStack`)、路径 2 CSS 文件写回(M3)、
文本写回、Review 面板 refresh nonce(写回 diff 需手动刷新/重开 Review 才可见)。

## 附录:v1 → v2 变更摘要

| # | 级别 | 变更 | 来源 |
|---|---|---|---|
| 1 | BLOCKER | 验证环加第 0 步"剥离预览 + sanity 断言"(否则任何错误写回都验证通过) | 红队 A1 |
| 2 | BLOCKER | DesignModePanel 从 utility tab 改为 BrowserPanel 内抽屉(tab 模型会销毁被编辑页面) | 架构 |
| 3 | BLOCKER | 路径 2 定位链从 sourcemap 改为 data-vite-dev-id + 文本匹配(Vite dev CSS sourcemap 默认不存在) | 技术 |
| 4 | 结构 | 整文件快照全面改为逆向 patch + file-write-queue(回滚/Apply/undo 三处都会抹掉第三方未提交改动) | 红队 A2/C1/C2 |
| 5 | 结构 | 验证面从"1 属性×1 元素"扩到全属性差分 + class 断言 + selector 采样 | 红队 A5/B2/B4/C3 |
| 6 | 结构 | blast radius 默认从调用处翻转为定义处;调用处启用前做透传探针;加跨文件 import 计数 | 产品+红队 |
| 7 | 结构 | 动态 className 从"拒绝"改为五级阶梯(cva 感知/保守追加);Apply 统一按钮形态,agent 是地板 | 产品 |
| 8 | 结构 | dev server 探测与引导、HMR 门禁写进正文(v1 留白) | 架构+产品 |
| 9 | 机制 | 验证结果三态化(成功/分类失败/未验证);回滚后重放预览;transition settle | 红队 A3/A4+产品 |
| 10 | 机制 | 定位键放弃精确列号,改行号+tag+序号+指纹;hash 变化禁止盲配 | 技术+红队 B1/B5 |
| 11 | 机制 | CDP 事件通道(Runtime.addBinding)、did-navigate 重注入、DevTools 互斥、suspend pin | 技术+架构 |
| 12 | 机制 | tailwind 门禁改运行时探针;twMerge 整跑;CSS 变量 arbitrary 保留;变体感知 | 技术+红队 B3/B4/C4 |
| 13 | 机制 | source.file 路径校验 + localhost 门禁;worktree 写根声明 | 架构 |
| 14 | 机制 | A' 档(React 19 `_debugStack`);Review 面板 refresh nonce | 技术+架构 |
| 15 | 产品 | M1 改名 Element Inspector;新增 M1.5 精确值 via agent;批量 Apply 按条结案 | 产品 |
