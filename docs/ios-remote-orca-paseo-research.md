# Orca / Paseo 移动远程实现调研

日期：2026-10-04。用于补充 [Aegis iOS 方案](ios-remote-companion-plan.md)。

范围：静态阅读公开仓库的协议、移动客户端、宿主与同步代码；没有安装或运行二者 App，没有验证生产部署。下述“实现”指所列版本中的源码，不等于线上验收。

| 项目 | 固定版本 |
| --- | --- |
| [stablyai/orca](https://github.com/stablyai/orca) | `d77c57022e51e6876b11c41b0fe42f3a2fa18514` |
| [getpaseo/paseo](https://github.com/getpaseo/paseo) | `05b074764dd1be4b7b04c7ab403ebeb88393aee3` |
| [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) | `3fc41c96c8c63f3a7109e832899cc57d473c4531`；本次只读其架构 README |

## 1. 主要结论

两个项目都把执行与权威状态留在用户机器上，手机通过远程协议操作同一执行环境。所查主要移动路径没有采用 Lody 那样的多端可写 CRDT 工作区同步。

| 维度 | Orca | Paseo |
| --- | --- | --- |
| 手机技术 | Expo / React Native；终端等复杂视图使用 WebView | Expo / React Native，兼顾 Web，提供统一 TypeScript client |
| 执行端 | Orca runtime，支持桌面与 headless 场景 | 独立 daemon，桌面自动启动 |
| 连接 | LAN/直连与 relay；有连接升级/恢复管理 | 直连 WebSocket、Tailscale/VPN、可选 relay |
| Relay | director 分配 cell，手机与宿主主动连接并转发帧 | 官方服务为独立 Elixir relay；主仓库的 Cloudflare adapter 为旧实现 |
| 数据保护 | 当前手机协议 E2EE v2，绑定会话、方向、帧类型与有序计数器 | Curve25519 + NaCl box；所查版本没有同一会话内的重放计数器 |
| 会话同步 | RPC 读取快照、各业务流订阅；重连重新订阅/刷新 | 目录最新状态增量 + timeline 实时流 + 权威分页追平 |
| 远程输入 | PTY 按键/文本路径与结构化 agentSession 路径并存 | 结构化 daemon API，统一 client 发 prompt、停止、审批 |
| 推送 | 独立 push gateway，APNs/FCM，持久投递记录 | daemon 调用 Expo Push API，再送达移动系统 |
| 公开边界 | 手机、relay、push 已公开；另有未公开 API/auth 服务 | 主仓库公开 app/server/client/协议，relay 服务另仓库 |

## 2. Orca：手机连接同一 runtime，按需订阅数据

### 2.1 连接与配对

配对 offer 包含版本、endpoint、deviceToken、桌面公钥；relay 模式还包含 director/cell 地址、relayHostId、短期 inviteToken、到期时间和 framing 版本。手机固定所配对主机的公钥，原生凭据存储由 SecureStore 相关代码负责。

公网 relay 路径：手机与宿主分别主动连接 cell。手机先做外层 relay-auth，随后在转发通道内做 E2EE 握手，再发送设备认证及 RPC。外层 relay credential 和内层主机设备授权属于不同层。

`cloud/README.md` 中“两端不直接通信”描述的是 relay 路径；产品本身还支持 LAN/直连。移动源码还包含 relay 到 direct 的升级管理，不能把 relay 路径的说明扩展成所有连接都必须经过云。

E2EE v2 固定桌面公钥，使用密钥交换结果、双方 nonce 和握手 transcript，通过 HKDF-SHA256 派生双向密钥及 sessionId；帧使用 NaCl secretbox，校验 sessionId、方向、text/binary 类型和递增计数器。断线后的新物理连接重建会话密钥。旧 shared/e2ee-crypto.ts 仍存在，不能只读那个文件就把当前手机协议描述成“随机 nonce 加密”。

证据：[配对 schema](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/src/shared/mobile-relay-pairing-offer.ts)、[relay E2EE 接线](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/mobile/src/transport/mobile-relay-e2ee-link.ts)、[客户端加密会话](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/mobile/src/transport/mobile-e2ee-v2-client-session.ts)、[帧验证](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/src/shared/mobile-e2ee-v2-framing.ts)。

### 2.2 状态如何到手机

- worktree 列表和元数据通过 RPC 读取；`useWorktreeResync` 在连接重新进入 connected 时重新获取 worktrees，避免只重连 socket 却继续显示旧缓存。
- 终端、session tabs、native chat、结构化 agentSession 等分别订阅。订阅 registry 保存逻辑需求；认证恢复后重放订阅，新连接取得新的服务端订阅标识。
- native chat 对 snapshot、append、replacement 分别处理，通过消息身份与保留窗口协调；历史分页游标在窗口被替换时重置。空快照还可能标记 pending，表示 Provider 尚未落出 transcript，不能把它当成“历史已完整”。
- 终端走 snapshot/输出帧，聊天走结构化消息；两种数据各自恢复，不能假定所有视图共用一个全局聊天事件游标。

证据：[列表恢复](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/mobile/src/transport/use-worktree-resync.ts)、[订阅恢复](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/mobile/src/transport/rpc-client-stream-registry.ts)、[聊天帧合并](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/mobile/src/session/mobile-native-chat-stream-frame.ts)。

### 2.3 手机操作有两种执行路径

**PTY 路径**：手机把文本、回车或选择按键发给电脑上的终端。native chat 的一些权限选择也通过完整控制序列提交，显式 `enter: false`；会对同一终端写入加锁，避免图片粘贴、回答和批准按键互相穿插。

请求发出但响应丢失时，结果为 `unknown`，不是“肯定没发出去”。当前路径不会盲目自动重发，因为重复终端输入可能触发第二次操作。

**结构化路径**：`agentSession.send` 带有 clientOperationId、payload fingerprint、runtime fence；手机保存发送操作记录，重试复用原操作身份，并区分 accepted、queued、rejected 和 unknown。能力协商决定是否支持 queue-if-active。这是业务级幂等，不能由“WebSocket 会重连”代替，也不能扩大成所有 RPC 都有相同保证。

Aegis 已经有 Provider API 和权限对象，应借鉴结构化路径；不必为了手机统一退回模拟终端按键。

证据：[PTY 发送与不确定结果](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/mobile/src/session/mobile-native-chat-send.ts)、[PTY 审批](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/mobile/src/session/mobile-native-chat-permission-send.ts)、[结构化消息发送](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/mobile/src/session/mobile-structured-agent-session-send.ts)。

### 2.4 推送独立于连接

公开 `cloud/apps/push` 是独立网关。宿主通过密钥证明取得网关会话，注册手机 native token 并提交通知；网关持久保存投递事件，通过 APNs/FCM 发送。notification socket 用于在线撤销和通知托盘恢复，不负责补发系统 banner。

因此手机被系统暂停时任务继续，通知走系统推送；回前台再恢复数据。E2EE relay 不意味着推送标题/正文也被端到端加密，推送有单独的数据边界。

证据：[relay 与 push 架构及公开范围](https://github.com/stablyai/orca/blob/d77c57022e51e6876b11c41b0fe42f3a2fa18514/cloud/README.md)。

## 3. Paseo：daemon API + 两类同步副本

### 3.1 连接与加密

手机、桌面、网页、CLI 通过 `packages/client` 的客户端能力调用 daemon。用户可直接连接网络地址，或让 daemon 主动连接 relay 后由手机进入同一 serverId 路由。

基础 v2 connection offer 包含 serverId、daemon 公钥、relay endpoint/TLS 设置，通过 URL fragment 传递。连接时手机生成临时 Curve25519 密钥，双方派生 shared key，NaCl box 保护应用消息；文本与二进制帧有能力协商。

正式 relay 是另仓库的 Elixir 服务，按 serverId 管理节点所有权与连接路由，提供背压和断线恢复配套。它转发密文，不承担聊天历史的合并或持久化。这里的“正式实现”来自主仓库架构说明与 relay README，本次没有验证线上实例实际运行版本。

加密和授权必须分开判断：所查源码 `session-admission-auth.ts` 仍有旧移动端兼容分支，在 relay 缺少 credential 时允许 owner admission；`SECURITY.md` 也承认同一加密会话内没有 nonce/计数器重放保护。因此不能照搬其鉴权边界，或把“知道主机公钥”当成用户授权。Aegis 应保留独立设备授权、撤销和完整的帧重放防护。

证据：[offer schema](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/protocol/src/connection-offer.ts)、[加密通道](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/relay/src/encrypted-channel.ts)、[准入实现](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/server/src/server/session-admission-auth.ts)、[安全说明](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/SECURITY.md)、[独立 relay](https://github.com/getpaseo/paseo-relay/tree/3fc41c96c8c63f3a7109e832899cc57d473c4531)。

### 3.2 目录同步：最新值与删除标记

project、workspace、agent 列表使用 versioned collection。每次更新推进 seq，缓存实体的最新投影；删除留下 tombstone。客户端携带游标读取变化；游标太旧、超出范围或 generation 改变时退回全量快照。

它不必保存列表实体每一次历史变化。对于“最近会话列表、当前运行状态”这类只关心最新值的数据，这比逐条重放所有中间状态更合适。Aegis 可采用同样的区分，避免用聊天流的高频同步逻辑刷新整个列表。

证据：[VersionedCollection](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/server/src/server/directory-sync/internal/versioned-collection.ts)。

### 3.3 聊天同步：实时呈现与权威历史分离

```text
Provider 输出 → daemon timeline 投影 → agent_stream → 手机立即呈现
                                    ↓
                       fetch_agent_timeline_request
                                    ↓
                         手机分页补齐并确认最新状态
```

核心语义：

1. `agent_stream` 提供即时文本、工具和生命周期更新；它不是唯一恢复来源。
2. timeline 使用 `epoch + seq`，投影消息携带 seqStart/seqEnd/sourceSeqRanges。一个工具状态或文本块可能覆盖多个源事件，不能把“可见消息数”当序号。
3. 发现中间缺口时发 `direction: after`，持续分页到 `hasNewer: false`；取到第一页不等于补齐。
4. `tail` 用于建立最新窗口，`before` 用于用户向上翻历史；重连/前台恢复根据当前有效范围规划追平。
5. epoch 改变、真正的中间缺口或 rewind 需要一致性替换窗口；相同 epoch/maxSeq 则不重建列表，保护滚动位置。
6. UI 分别显示“正在连接主机”和“正在更新消息”。心跳负责 presence/通知路由，不能据此跳过某些聊天事件。
7. 回前台先探测看起来仍连接的 socket；健康则保留，3 秒探测失败就重连。它不承诺 iOS 后台长连接持续存活。

重要差异：`InMemoryAgentTimelineStore` 保存内存投影，Provider history 是持久 transcript 来源，恢复时重新构建。它不是“把所有聊天事件永久写入自己的 SQL event log”。Aegis 已有 SQLite 消息库，应保留自身权威存储，仅借鉴投影、分页和追平语义。

证据：[同步契约](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/docs/timeline-sync.md)、[客户端同步规划](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/app/src/timeline/timeline-sync-plan.ts)、[内存 timeline](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/server/src/server/agent/agent-timeline-store.ts)。

### 3.4 操作与通知

统一 daemon client 提供创建 agent、sendMessage、停止与 respondToPermission 等能力。审批以 agentId/requestId 找到主机上的请求，交给 Provider adapter；部分 Provider 审批结果需要启动 follow-up turn。

`PushService` 通过 Expo Push API 批量发送通知，并处理部分无效 token 错误；不是依赖 socket 在 iOS 后台唤醒 UI。所查推送实现不能直接证明与 Orca 同等的持久 outbox/投递保证。其推送 title/body/data 会经过 Expo 和系统推送，不能将聊天 E2EE 的范围扩展到推送内容。

证据：[客户端 API](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/client/src/daemon-client.ts)、[审批转发](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/server/src/server/agent/permission-response.ts)、[推送服务](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/server/src/server/push/push-service.ts)。

## 4. 已采纳的方案修订

以下结论已合并到 [Aegis iOS 方案 v2](ios-remote-companion-plan.md)，主方案是当前实施依据；这里只保留调研依据与采用理由，不代表能力已经实现。首版阶段为 P0–P4，独立 daemon 为 P5，其余扩展为 P6。

1. **E2EE 提前进入 P0。** 将“受信任明文中继”改为“仅转发密文的中继”作为目标，验证主机身份固定、设备凭据、会话密钥、帧计数器、重连与撤销。使用成熟密码库，明确握手与认证边界，不自行凭几段参考代码设计密码协议。P0 是验证，不是完成安全审计。
2. **移动技术保留一次实机比较。** Orca/Paseo 是 React Native 的成熟参考，Lody 共享 UI 展示了 Web 壳路线。已有 React DOM 组件不等于能直接复用为 RN；应比较同一真实长会话在 Capacitor 与 RN 小样中的滚动、键盘、后台恢复和维护成本。只选定一条产品实现路线，不长期双轨。
3. **同步拆为目录和聊天两层。** 列表采用最新状态 + seq + tombstone；聊天采用快照/投影 + 连续范围追平。现有 SQLite、业务 outbox 与命令日志继续保留。
4. **显式增加 freshness 状态。** 连接与数据分别建模；`connected + catching_up` 不能显示成完全同步。相同 revision 不替换列表，断线保留可读缓存，旧 epoch 的返回结果拒绝覆盖新会话。
5. **明确读、写、订阅的重试区别。** 读可重试，订阅可重建，有副作用操作只有稳定 commandId 和主机幂等记录支持时才可重试。未知结果先查主机，不能自动生成新 ID 重发。
6. **首版仍然只开放结构化操作。** 复用 Aegis Provider/PermissionRegistry；完整终端、跨端布局同步、LAN 自动切换和多 cell 调度均不进入第一版必要范围。
7. **通知继续独立设计。** 保持主机事件 outbox、投递去重、点击后重新核实当前审批。默认通知只给状态，避免引入聊天 E2EE 后又从推送正文泄露内容。

这些发现保留了“执行留在电脑、手机是远程入口”的定位，并调整了加密优先级、同步协议与移动技术验证。各阶段目标、交付物、验收条件与暂定工期已统一到主方案第 11–12 节；P0 完成后按实测结果重新估算。

## 5. 视觉参考与采用规则

用户已指定 Paseo 为 Aegis iOS 的主要视觉参考。本节补充固定版本源码观察；官方 [移动效果图](https://paseo.sh/mobile-mockup.png) 由项目 README 引用，本次浏览器加载超时，未完成图片视觉检查，也未运行 Paseo App。

- [主题与 token](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/app/src/styles/theme.ts)：Zinc 灰阶、多层 surface、独立语义状态色和 diff 色；系统字体、等宽代码字体及统一间距/圆角。包含多个主题，不能将某一个色值代表为全部 Paseo 外观。
- [消息样式](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/app/src/components/message.tsx)：用户消息右对齐，使用 surface3 气泡；助手正文容器无统一气泡背景，回复内包含工具、图片和折叠详情等组件。
- [消息分组间距](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/app/src/agent-stream/spacing.ts)：同组助手内容与连续工具序列采用不同间距，减少碎片感。
- [工作区列表行](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/app/src/components/sidebar/sidebar-workspace-row.tsx)：轻量圆角行、次级文字、按下与选中表面，拖拽时另加反馈；这是组件样式证据，不证明 Aegis 应复制其导航结构。
- [原生输入 dock](https://github.com/getpaseo/paseo/blob/05b074764dd1be4b7b04c7ab403ebeb88393aee3/packages/app/src/composer/dock/index.native.tsx)：键盘位移和底部 safe-area inset 单独处理；键盘表现仍需 Aegis 原型实机验证。

Aegis 采用视觉层次与阅读模式，保留品牌、三入口导航和远程状态语义。正文暂定 17pt、触控目标至少 44pt，是 Aegis 的移动适配建议，不是对 Paseo 原始规格的描述。具体页面、状态和分阶段设计交付已写入主方案第 4.1–4.3 节。
