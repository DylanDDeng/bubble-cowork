# IPC Handler 拆分方案

## 现状

`src/electron/ipc-handlers.ts` — 7,787 行，262KB，包含 ~100+ 个 `ipcMainHandle()` 处理器，全部在一个文件中。

## 拆分原则

1. **按业务域拆分** — 每个模块只负责一类功能
2. **共享上下文提取** — 公共依赖（broadcast、sessions、runnerHandles 等）抽取到共享 context 对象
3. **增量迁移** — 每次迁移一个模块，保持 master 始终可运行
4. **零回归** — 迁移后行为完全不变

---

## 目标架构

```
src/electron/
├── ipc-handlers.ts          → 重构为薄胶水层 (~200行)
├── ipc/
│   ├── context.ts            # 共享上下文类型与工厂
│   ├── sessions.ts           # 会话 CRUD、列表、搜索、置顶、移动
│   ├── runner.ts             # 运行生命周期 (run/input/stop/abort)
│   ├── stream.ts             # 流消息处理、sanitization、broadcast
│   ├── files.ts              # 文件操作、diff、checkpoint
│   ├── models.ts             # 模型配置、provider 设置
│   ├── agents.ts             # Agent CRUD、配置、子代理生命周期
│   ├── channel.ts            # Channel/workspace 管理
│   ├── threads.ts            # Thread 管理
│   ├── terminal.ts           # PTY 终端
│   ├── mcp.ts                # MCP 服务器配置
│   ├── skills.ts             # Skills 管理
│   ├── folders.ts            # 文件夹管理
│   ├── profiles.ts           # Profile 快照 sync
│   ├── search.ts             # 语义搜索
│   └── settings.ts           # 应用设置
```

---

## 模块详情

### 0. `ipc/context.ts` — 共享上下文

每个 handler 模块需要访问共享状态。当前这些是全局变量或闭包捕获的变量：

```typescript
// 抽取为类型接口
export interface IPCHandlerContext {
  mainWindow: BrowserWindow
  sessions: SessionStore        // 会话数据层
  runnerHandles: Map<string, RunnerHandle>  // 运行中的 runner
  sessionStates: Map<string, SessionState>  // runner 状态
  terminalSessions: Map<string, TerminalSession>  // 终端会话
  folderConfig: FolderConfigStore  // 文件夹配置
  broadcast: (type, payload) => void  // IPC 广播函数
  handleSessionList: () => void       // 会话列表重新发送
  // ... 其他共享状态
}

export function createIPCHandlerContext(mainWindow: BrowserWindow): IPCHandlerContext
```

### 1. `ipc/sessions.ts` — 会话管理（~1,200 行）

| IPC 通道 | 功能 |
|----------|------|
| `session.create` | 创建新会话 |
| `session.delete` | 删除会话 |
| `session.rename` | 重命名会话 |
| `session.list` | 列出所有会话 |
| `session.move` | 移动会话到另一文件夹 |
| `session.search` | 搜索会话 |
| `session.toggle-pin` | 切换置顶状态 |
| `session.set-folder` | 设置会话所属文件夹 |
| `session.set-channel` | 设置会话所属 channel |
| `session.set-team` | 设置 team mode |
| `session.list-recent` | 最近会话列表 |
| `session.set-scope` | 设置会话 scope |
| `session.hide-from-threads` | 从线程列表隐藏 |
| `session.delete-all` | 删除所有会话 |

### 2. `ipc/runner.ts` — 运行生命周期（~800 行）

| IPC 通道 | 功能 |
|----------|------|
| `session.run` | 启动对话运行 |
| `session.input` | 发送用户输入 |
| `session.stop` | 停止运行 |
| `session.abort` | 强制中止 |
| `session.continue` | 继续运行 |
| `runner.status` | 获取运行状态 |

### 3. `ipc/stream.ts` — 流消息处理（~1,200 行）

流消息的回调逻辑——`messageCallback` 函数及其内部所有 sanitization、broadcast、turn tracking 逻辑。

### 4. `ipc/files.ts` — 文件操作（~500 行）

| IPC 通道 | 功能 |
|----------|------|
| `file.read` / `file.write` | 文件读写 |
| `file.list` | 列出目录 |
| `file.diff` | 文件差异对比 |
| `checkpoint.*` | Checkpoint 管理 |

### 5. `ipc/models.ts` — 模型与 Provider 配置（~400 行）

| IPC 通道 | 功能 |
|----------|------|
| `session.set-model` | 设置模型 |
| `session.set-provider` | 设置 provider |
| `session.set-compatible-provider` | 设置兼容 provider |
| `session.set-betas` | 设置 betas |
| `session.set-access-mode` | Claude 访问模式 |
| `session.set-execution-mode` | 执行模式 |
| `session.set-reasoning-effort` | 推理强度 |
| `session.set-permission-mode` | 权限模式 |
| `session.set-fast-mode` | Codex 快速模式 |

### 6. `ipc/agents.ts` — Agent 管理（~800 行）

| IPC 通道 | 功能 |
|----------|------|
| `agent.create` | 创建 agent 配置 |
| `agent.update` | 更新 agent 配置 |
| `agent.delete` | 删除 agent 配置 |
| `agent.list` | 列出所有 agent |
| `agent.set-session-agent` | 设置会话 agent |
| `agent.set-session-subagents` | 设置子代理列表 |
| `agent.status` | 子代理状态 |
| `agent.cancel-subagent` | 取消子代理 |

### 7. `ipc/channel.ts` — Channel/Workspace 管理（~300 行）

| IPC 通道 | 功能 |
|----------|------|
| `channel.list` | 列出 channels |
| `channel.create` | 创建 channel |
| `channel.update` | 更新 channel |
| `channel.delete` | 删除 channel |

### 8. `ipc/threads.ts` — 线程管理（~200 行）

| IPC 通道 | 功能 |
|----------|------|
| `thread.list` | 列出线程 |
| `thread.create` | 创建线程 |
| `thread.update` | 更新线程 |
| `thread.delete` | 删除线程 |

### 9. `ipc/terminal.ts` — 终端管理（~400 行）

| IPC 通道 | 功能 |
|----------|------|
| `terminal.create` | 创建 PTY 终端 |
| `terminal.input` | 终端输入 |
| `terminal.resize` | 终端大小调整 |
| `terminal.destroy` | 销毁终端 |
| `terminal.list` | 列出终端会话 |

### 10. `ipc/mcp.ts` — MCP 管理（~300 行）

| IPC 通道 | 功能 |
|----------|------|
| `mcp.get-config` | 获取 MCP 配置 |
| `mcp.save-config` | 保存 MCP 配置 |

### 11. `ipc/skills.ts` — Skills 管理（~200 行）

| IPC 通道 | 功能 |
|----------|------|
| `skills.list` | 列出 skills |
| `skills.install` | 安装 skill |
| `skills.uninstall` | 卸载 skill |

### 12. `ipc/folders.ts` — 文件夹管理（~200 行）

| IPC 通道 | 功能 |
|----------|------|
| `folder.list` | 列出文件夹 |
| `folder.create` | 创建文件夹 |
| `folder.update` | 更新文件夹 |
| `folder.delete` | 删除文件夹 |
| `folder.move` | 移动文件夹 |

### 13. `ipc/profiles.ts` — Profile 快照（~100 行）

| IPC 通道 | 功能 |
|----------|------|
| `profiles.sync` | 同步 profile 快照 |
| `profiles.list` | 获取配置列表 |

### 14. `ipc/search.ts` — 语义搜索（~200 行）

| IPC 通道 | 功能 |
|----------|------|
| `search.semantic` | 语义搜索 |
| `search.embed` | 向量嵌入 |

### 15. `ipc/settings.ts` — 应用设置（~200 行）

| IPC 通道 | 功能 |
|----------|------|
| `settings.get` | 获取设置 |
| `settings.set` | 更新设置 |
| `settings.app-update` | 检查更新 |

---

## 迁移步骤

| 阶段 | 内容 | 风险 |
|------|------|------|
| **Phase 1** | 提取 `context.ts`，创建共享上下文类型和工厂函数 | 低 — 纯提取 |
| **Phase 2** | 拆分 `folders.ts`，验证模式 | 低 — 独立模块 |
| **Phase 3** | 拆分 `mcp.ts`、`skills.ts`、`profiles.ts`、`search.ts`、`settings.ts` | 低 — 独立模块 |
| **Phase 4** | 拆分 `sessions.ts` | 中 — 依赖较多 |
| **Phase 5** | 拆分 `models.ts` | 中 — 与 runner 耦合 |
| **Phase 6** | 拆分 `channel.ts`、`threads.ts` | 低 |
| **Phase 7** | 拆分 `terminal.ts` | 中 — 有状态管理 |
| **Phase 8** | 拆分 `agents.ts` | 中 — 子代理生命周期 |
| **Phase 9** | 拆分 `files.ts` | 中 |
| **Phase 10** | 拆分 `stream.ts`，提取消息回调 | 高 — 核心路径 |
| **Phase 11** | 拆分 `runner.ts` | 高 — 与 stream 紧耦合 |
| **Phase 12** | 简化 `ipc-handlers.ts` 为薄胶水层 | 低 |

---

## 增量迁移策略

每个模块迁移时遵循以下步骤：

1. 创建 `src/electron/ipc/<module>.ts`
2. 导出 `register(context: IPCHandlerContext): void` 函数
3. 将对应的 `ipcMainHandle()` 调用移入 `register()`
4. 将 handler 函数也移入该文件
5. 在 `ipc-handlers.ts` 的 `setupIPCHandlers()` 中调用新模块的 `register(context)`
6. 删除 `ipc-handlers.ts` 中已迁移的代码
7. 构建 + 冒烟测试验证

## 验证

- `npm run build` 通过
- `npm start` 启动后功能正常
- 关键路径：创建会话 → 发送消息 → 接收流 → 停止 → 删除会话
