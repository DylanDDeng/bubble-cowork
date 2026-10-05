# iOS 远程伴侣：实现与验收记录

日期：2026-10-04。状态：**P0 技术预览，尚未达到完整首版 P0–P4 的交付条件。**

## 已实现

- `apps/ios`：原生 SwiftUI 工程（iOS 26，Liquid Glass），2026-10-04 取代早期的 React + Capacitor 预览；会话、项目、设置、聊天、新任务、一次性审批、附件、模型/推理/权限设置；加密通道与客户端由 AegisKit（Swift）实现，工作轨迹与模型目录复用桌面端 TS 逻辑（JavaScriptCore）。
- 原生桥接：设备本地 Keychain 凭据、相机扫码、配对 URL 冷启动/热启动入口。SceneDelegate 使用注册桥接插件的自定义控制器。
- 桌面设置：启用远程访问、项目授权范围、二维码、手机授权确认和撤销。远程适配器复用现有创建/继续/停止/审批入口，并增加同会话提交锁。
- `src/shared/remote`：严格请求白名单、共享 DTO、历史消息投影；基于 ChainSafe libp2p Noise XX 的双向加密连接，固定主机身份，重连使用新握手。
- `src/electron/remote`：独立设备授权、运行轮次检查、命令去重、过期检查、加密持久命令日志、快照和刷新通知。历史分页绑定版本，并限制单页大小。
- `services/relay`：独立注册和路由凭据、二进制转发、帧/积压限制、心跳和连接上限；真实设备要求 TLS/WSS。尚未部署公网服务。
- 手机缓存和草稿、断线重连、查询原命令的结果；丢失确认时不会自动用新命令 ID 重发。

当前可执行操作为文本新建、续聊、停止和普通工具允许一次/拒绝。Claude、Codex、Bubble 已接入接口，但真实运行时兼容性须逐个验收。结构化提问、计划确认和 Computer Use 仍需回到桌面处理。

## 开发与正式环境

按用户要求，日常测试同步真实 Aegis Dev 数据，正式 iOS 版本同步正式 Aegis 数据。

| 配置 | 手机应用 | 桌面数据 | 配对入口 |
| --- | --- | --- | --- |
| Debug | Aegis Dev，`ai.aegis.companion.dev` | `~/Library/Application Support/Aegis Dev` | `aegis-dev://pair` |
| Release | Aegis，`ai.aegis.companion` | `~/Library/Application Support/aegis` | `aegis://pair` |

iOS 由原生编译配置确定环境；两端在配对与加密认证中检查环境。App 容器、Keychain service、桌面身份与授权文件分别隔离。测试数据标记为 fixture，普通开发/正式客户端均拒绝；不会把正式数据库复制到开发库。

2026-10-04 已将模拟器从假 runtime 切到真实 Aegis Dev，使用本机 8790 端口中继。原生界面显示 5 个项目、238 个既有会话，与开发库只读查询一致。在 coworker 中用手机创建一个 Codex 测试任务后，总数为 239；手机和桌面均显示 `Aegis Dev connected.`。随后从桌面续聊，手机同步了请求及 `Desktop sync confirmed.` 回复。两轮均要求不调用工具、不访问文件。重新构建安装并终止/启动 Debug App 后，无需重新配对即恢复“已同步”与 239 个会话。

测试会话 ID：`cbcfb3e3-f48f-4191-9747-0714d92616cf`。现有 `/Applications/Aegis.app` 正式安装包未替换，正式环境端到端验收尚未进行；Release 构建成功不代表正式同步已经上线。

## 验证证据与边界

| 验证 | 结果 | 能证明什么 |
| --- | --- | --- |
| `npm run verify:remote` | 通过 | 真实 WebSocket 中继上的 Noise 通道、双向 Unicode/150KB 消息；错误主机身份、篡改、重放均拒绝 |
| Gateway 测试 | 通过 | 未授权访问、项目隔离、白名单、同命令去重、载荷冲突、过期、旧轮次停止、审批竞争、截断详情禁止批准、崩溃未知状态、撤销 |
| Mobile client 测试 | 通过 | 开发/正式/fixture 跨环境配对拒绝，篡改配对环境后仍被加密认证拒绝；加密配对、250 条历史分页、版本变化拒绝、旧响应隔离、显式拒绝、ACK 丢失后恢复且只执行一次、撤销清缓存与草稿 |
| `npm run typecheck` / `npm run build` | 通过 | 桌面源码类型与打包构建；未替换当前安装的桌面 App |
| 现有会话/Provider 回归 | 通过 | 续聊权限、历史、Provider dispose、Claude interrupt-stop、warm-send-options；不等于手机到真实 Provider 的端到端验收 |
| `npm run ios:test` | 通过 | 共享视图逻辑的 Node 测试；AegisKit `swift test`（Noise 与桌面端双向互通、fixture 端到端） |
| Xcode Debug Simulator / Release iPhone arm64 | 通过 | 模拟器使用本地 ad-hoc 签名；Release 使用 `CODE_SIGNING_ALLOWED=NO`，不是已签名分发包 |
| 构建产物环境配置 | 通过 | 直接读取两种产物 Info.plist，确认 Debug 为 `.dev` / Aegis Dev / `aegis-dev`，Release 为正式 bundle / Aegis / `aegis` |
| iPhone 17 Pro / iOS 26.1 原生交互 | 部分通过 | 配对、会话列表、聊天、审批详情、允许一次和停止均已点击验证；使用本地加密中继与假 runtime。停止后显示“本轮已结束”，批准后审批卡片消失 |
| 原生模拟器 + 真实 Aegis Dev | 通过文本双向同步 | 5 个真实项目、既有历史、手机新建 Codex 任务与回复、桌面续聊及回复同步；新增仅 1 个会话 |
| 原生 Keychain | 保存与重启恢复通过 | 无签名构建出现读取失败；重新 ad-hoc 签名安装后保存身份和配对凭据。再次安装并重启后，未重新配对即恢复“已同步”及会话列表 |
| 原生键盘 | 输入与发送通过，软键盘待验收 | 接入官方 Keyboard 原生 resize、禁止外层 WebView 滚动并固定根容器溢出。模拟器硬件键盘输入配对链接和新任务时标题保持在安全区域，并成功发送；软件键盘、中文输入法和真机仍待验收 |
| Playwright，393 × 852 | 通过 | 配对、查看会话、审批、停止、续聊、新任务、刷新恢复、暗色切换，截图目视检查；使用测试 runtime，未调用真实 Provider |

早期浏览器与原生审批测试使用 `scripts/remote/fixture.mjs` 中的隔离假运行时；上述新增双向同步验证使用真实开发桌面与 Codex Provider。测试 fixture 的自动配对确认不适用于真实桌面，真实桌面仍需 Mac 原生确认。测试通过不是安全审计，也不能证明真实网络和所有 Provider 已兼容。

构建日志保存在本机 `/tmp/aegis-remote-tests.log`、`/tmp/aegis-desktop-build.log`、`/tmp/aegis-ios-sync.log`、`/tmp/aegis-ios-build-final.log`、`/tmp/aegis-ios-device-build.log`。截图位于 `output/playwright/aegis-ios-*.png`；日志和截图未加入版本控制。

## 尚未完成及环境阻塞

1. 原生模拟器发送、新建和真实开发环境双向同步已验证。软键盘、中文输入法、相机与真实设备验收仍待完成；真机测试还需连接、解锁并信任手机。
2. 公网中继（Fly.io，Mac 用 Ed25519 密钥证明房间归属，无共享令牌）、APNs 推送网关、手机端推送注册与签名配置已在代码中实现，见 `services/relay/README.md`。实际部署、Apple 付费开发者账号、APNs Key 与 TestFlight 尚未完成。
3. Capacitor 目前是预览路线；未完成与 React Native 的同场景真机比较，不能声称 P0 已验收。
4. 业务仅增加了远程适配入口，尚未完整提取 SessionService/PermissionRegistry。加密日志是独立原子文件，不与桌面 SQLite 组成一个事务；Provider 执行后崩溃仍可能得到 unknown，不能宣称跨崩溃严格执行一次。
5. 同步采用快照、失效通知和定期刷新，缺少正式 SQLite outbox、持久 feed、目录删除标记与游标缺口恢复；项目/会话目录尚未分页。仅支持一部手机同时连接。
6. 图片发送、附件/产物浏览、结构化问题、模型能力矩阵、APNs 与真机性能验收待做。手机重装后的强制重新配对策略也待验证，iOS Keychain 可能跨卸载保留。

## 阶段目标与下一步

| 阶段 | 下一项验收目标 | 当前状态 |
| --- | --- | --- |
| P0 | 真实 iPhone 经 WSS 完成发送、流式回复、审批、停止；对比并冻结移动框架 | 预览与自动化测试已有，真机环节受环境阻塞 |
| P1 | 桌面/手机共用业务服务、权限注册表和命令持久化；安装包回归 | 最小适配已有，正式拆分待做 |
| P2 | 配对/撤销、正式同步、持久恢复与故障验收 | 部分加密与授权测试已有，可靠同步待做 |
| P3 | 手机独立完成文本/图片任务、问题回答与结果查看，逐 Provider 验收 | 文本预览流程已有，其余待做 |
| P4 | 签名、推送、TestFlight 和已安装 Mac + 真实手机联调 | 待做 |

按方案的顺序，P0 真机结论应先于正式框架冻结与 P1–P4 产品交付。完整首版不应标记完成。

## 复现入口

从仓库根目录安装依赖后执行 `npm run verify:remote`、`npm run typecheck`、`npm run build`。手机执行 `npm run ios:project`，用 Xcode 打开 `apps/ios/Aegis.xcodeproj`，选择 Aegis scheme。模拟器保留本地签名（`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`），不要用无签名编译代替原生凭据验收。

配对与构建说明见 [iOS README](../apps/ios/README.md)，中继配置见 [relay README](../services/relay/README.md)。预览不会自动向公网部署，也不会自动替换 `/Applications` 中的 Aegis。
