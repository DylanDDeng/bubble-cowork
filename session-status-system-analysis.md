# Session Status 系统深入分析

本文档深入分析 Craft Agents 项目中聊天记录（Session）的 Status 功能实现，包括架构设计、数据流、业务逻辑和自定义扩展机制。

## 目录

1. [系统概述](#1-系统概述)
2. [核心类型定义](#2-核心类型定义)
3. [默认状态与设计理念](#3-默认状态与设计理念)
4. [数据存储架构](#4-数据存储架构)
5. [状态 CRUD 操作](#5-状态-crud-操作)
6. [图标系统](#6-图标系统)
7. [颜色系统](#7-颜色系统)
8. [前端状态管理](#8-前端状态管理)
9. [IPC 通信流程](#9-ipc-通信流程)
10. [侧边栏过滤逻辑](#10-侧边栏过滤逻辑)
11. [自定义状态指南](#11-自定义状态指南)
12. [架构设计亮点](#12-架构设计亮点)

---

## 1. 系统概述

### 1.1 什么是 Session Status？

Session Status 是一个**工作流状态管理系统**，允许用户为每个聊天会话分配状态标签，类似于看板（Kanban）系统中的卡片状态。

### 1.2 核心特性

| 特性 | 描述 |
|------|------|
| **工作空间级配置** | 每个工作空间独立配置状态列表 |
| **可自定义状态** | 支持创建自定义状态（标签、颜色、图标） |
| **分类过滤** | 状态分为 `open`（收件箱）和 `closed`（存档）两类 |
| **固定状态保护** | 核心状态（todo、done、cancelled）不可删除 |
| **图标系统** | 支持 emoji、SVG、PNG/JPG 图标 |
| **实时同步** | 状态变更实时同步到所有窗口 |

### 1.3 文件结构

```
packages/shared/src/statuses/
├── types.ts          # TypeScript 类型定义
├── storage.ts        # 文件系统存储操作
├── crud.ts           # CRUD 业务逻辑
├── default-icons.ts  # 默认 SVG 图标
└── validation.ts     # 输入验证

apps/electron/src/renderer/
├── config/todo-states.tsx    # 状态配置转换和图标解析
├── hooks/useStatuses.ts      # 状态加载 Hook
├── atoms/sessions.ts         # Jotai 状态原子
└── components/
    ├── app-shell/SessionMenu.tsx   # 会话右键菜单
    └── ui/todo-filter-menu.tsx     # 状态选择菜单

工作空间存储:
~/.craft-agent/workspaces/{workspaceId}/
├── statuses/
│   ├── config.json           # 状态配置文件
│   └── icons/                # 图标文件目录
│       ├── backlog.svg
│       ├── todo.svg
│       ├── needs-review.svg
│       ├── done.svg
│       └── cancelled.svg
```

---

## 2. 核心类型定义

### 2.1 StatusCategory - 状态分类

```typescript
// packages/shared/src/statuses/types.ts

/**
 * 状态分类决定过滤行为：
 * - 'open': 出现在收件箱（listInboxSessions）
 * - 'closed': 出现在存档（listCompletedSessions）
 */
export type StatusCategory = 'open' | 'closed';
```

**设计理念**：这是一个二分法设计，将所有状态归为"进行中"或"已完成"两大类，简化了过滤逻辑。

### 2.2 StatusConfig - 状态配置

```typescript
export interface StatusConfig {
  /** 唯一 ID（slug 风格：'todo', 'in-progress', 'my-custom-status'） */
  id: string;

  /** 显示名称 */
  label: string;

  /** 可选颜色（hex 代码或 Tailwind 类）。省略则使用设计系统默认值 */
  color?: string;

  /**
   * 图标：emoji 或 URL（自动下载）
   * - Emoji: "✅", "🔥" - 渲染为文本
   * - URL: "https://..." - 自动下载到 statuses/icons/{id}.{ext}
   * - 省略则使用自动发现的本地文件（statuses/icons/{id}.svg）
   */
  icon?: string;

  /** 分类（open = 收件箱, closed = 存档） */
  category: StatusCategory;

  /** 若为 true，不能删除/重命名（todo, done, cancelled） */
  isFixed: boolean;

  /** 若为 true，可修改但不能删除（in-progress, needs-review） */
  isDefault: boolean;

  /** UI 中的显示顺序（越低越优先） */
  order: number;
}
```

### 2.3 WorkspaceStatusConfig - 工作空间状态配置

```typescript
export interface WorkspaceStatusConfig {
  /** 架构版本（用于迁移） */
  version: number;

  /** 状态配置数组 */
  statuses: StatusConfig[];

  /** 新会话的默认状态 ID（通常是 'todo'） */
  defaultStatusId: string;
}
```

### 2.4 Session 中的 TodoState

```typescript
// packages/shared/src/sessions/types.ts

export type TodoState = string;  // 动态状态 ID，引用 workspace status config

export interface SessionConfig {
  id: string;
  // ... 其他字段
  /** 用户控制的待办状态 - 决定收件箱 vs 已完成 */
  todoState?: TodoState;
  // ...
}
```

---

## 3. 默认状态与设计理念

### 3.1 五种默认状态

```typescript
// packages/shared/src/statuses/storage.ts

export function getDefaultStatusConfig(): WorkspaceStatusConfig {
  return {
    version: 1,
    statuses: [
      {
        id: 'backlog',
        label: 'Backlog',
        category: 'open',
        isFixed: false,      // 可删除
        isDefault: true,     // 不可删除但可修改
        order: 0,
      },
      {
        id: 'todo',
        label: 'Todo',
        category: 'open',
        isFixed: true,       // 核心状态，不可删除
        isDefault: false,
        order: 1,
      },
      {
        id: 'needs-review',
        label: 'Needs Review',
        category: 'open',
        isFixed: false,
        isDefault: true,
        order: 2,
      },
      {
        id: 'done',
        label: 'Done',
        category: 'closed',  // 已完成类
        isFixed: true,       // 核心状态
        isDefault: false,
        order: 3,
      },
      {
        id: 'cancelled',
        label: 'Cancelled',
        category: 'closed',  // 已完成类
        isFixed: true,       // 核心状态
        isDefault: false,
        order: 4,
      },
    ],
    defaultStatusId: 'todo',  // 新会话默认状态
  };
}
```

### 3.2 状态保护级别

| 级别 | isFixed | isDefault | 能否删除 | 能否修改 | 示例 |
|------|---------|-----------|----------|----------|------|
| **固定状态** | `true` | `false` | 否 | 否（分类不可改） | todo, done, cancelled |
| **默认状态** | `false` | `true` | 否 | 是 | backlog, needs-review |
| **自定义状态** | `false` | `false` | 是 | 是 | 用户创建的任何状态 |

### 3.3 设计理念

```
工作流程设计：

  收件箱 (open)                          存档 (closed)
  ┌─────────────────────────────────┐   ┌─────────────────────┐
  │  Backlog → Todo → Needs Review  │ → │  Done / Cancelled   │
  └─────────────────────────────────┘   └─────────────────────┘
        ↑                                        │
        └────────────── 可重新打开 ──────────────┘
```

- **Backlog**: 未计划的任务，等待排期
- **Todo**: 准备工作的任务
- **Needs Review**: 需要审查/等待反馈的任务
- **Done**: 已完成的任务
- **Cancelled**: 取消的任务

---

## 4. 数据存储架构

### 4.1 配置文件位置

```
~/.craft-agent/workspaces/{workspaceId}/statuses/config.json
```

### 4.2 配置文件示例

```json
{
  "version": 1,
  "statuses": [
    {
      "id": "backlog",
      "label": "Backlog",
      "category": "open",
      "isFixed": false,
      "isDefault": true,
      "order": 0
    },
    {
      "id": "todo",
      "label": "Todo",
      "category": "open",
      "isFixed": true,
      "isDefault": false,
      "order": 1
    },
    {
      "id": "urgent",
      "label": "Urgent",
      "color": "#FF0000",
      "icon": "🔥",
      "category": "open",
      "isFixed": false,
      "isDefault": false,
      "order": 2
    }
  ],
  "defaultStatusId": "todo"
}
```

### 4.3 存储操作函数

```typescript
// packages/shared/src/statuses/storage.ts

// 加载配置（不存在则返回默认值）
export function loadStatusConfig(workspaceRootPath: string): WorkspaceStatusConfig

// 保存配置
export function saveStatusConfig(workspaceRootPath: string, config: WorkspaceStatusConfig): void

// 获取单个状态
export function getStatus(workspaceRootPath: string, statusId: string): StatusConfig | null

// 列出所有状态（按 order 排序）
export function listStatuses(workspaceRootPath: string): StatusConfig[]

// 验证状态 ID 是否有效
export function isValidStatusId(workspaceRootPath: string, statusId: string): boolean

// 获取状态分类
export function getStatusCategory(workspaceRootPath: string, statusId: string): StatusCategory | null
```

### 4.4 自愈机制

```typescript
export function loadStatusConfig(workspaceRootPath: string): WorkspaceStatusConfig {
  // 确保默认图标文件存在（自愈）
  ensureDefaultIconFiles(workspaceRootPath);

  const configPath = join(workspaceRootPath, STATUS_CONFIG_FILE);

  // 配置不存在则返回默认值
  if (!existsSync(configPath)) {
    return getDefaultStatusConfig();
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    // 验证必需的固定状态存在
    if (!validateStatusConfig(config)) {
      console.warn('Invalid config: missing required fixed statuses, returning defaults');
      return getDefaultStatusConfig();
    }

    return config;
  } catch (error) {
    console.error('Failed to parse config:', error);
    return getDefaultStatusConfig();
  }
}
```

---

## 5. 状态 CRUD 操作

### 5.1 创建状态

```typescript
// packages/shared/src/statuses/crud.ts

export function createStatus(
  workspaceRootPath: string,
  input: CreateStatusInput
): StatusConfig {
  const config = loadStatusConfig(workspaceRootPath);

  // 生成唯一 ID（slug 风格）
  let id = generateStatusSlug(input.label);  // "My Status" → "my-status"
  let suffix = 2;
  while (config.statuses.some(s => s.id === id)) {
    id = `${generateStatusSlug(input.label)}-${suffix}`;  // "my-status-2"
    suffix++;
  }

  // 设置 order 为最后
  const maxOrder = Math.max(...config.statuses.map(s => s.order), -1);

  const status: StatusConfig = {
    id,
    label: input.label,
    color: input.color,
    icon: input.icon,
    category: input.category,
    isFixed: false,      // 自定义状态不是固定的
    isDefault: false,    // 自定义状态不是默认的
    order: maxOrder + 1,
  };

  config.statuses.push(status);
  saveStatusConfig(workspaceRootPath, config);

  return status;
}
```

### 5.2 更新状态

```typescript
export function updateStatus(
  workspaceRootPath: string,
  statusId: string,
  updates: UpdateStatusInput
): StatusConfig {
  const config = loadStatusConfig(workspaceRootPath);
  const status = config.statuses.find(s => s.id === statusId);

  if (!status) {
    throw new Error(`Status '${statusId}' not found`);
  }

  // 固定状态不能改变分类
  if (status.isFixed && updates.category && updates.category !== status.category) {
    throw new Error('Cannot change category of fixed status');
  }

  // 应用更新
  if (updates.label !== undefined) status.label = updates.label;
  if (updates.color !== undefined) status.color = updates.color;
  if (updates.icon !== undefined) status.icon = updates.icon;
  if (updates.category !== undefined) status.category = updates.category;

  saveStatusConfig(workspaceRootPath, config);
  return status;
}
```

### 5.3 删除状态

```typescript
export function deleteStatus(
  workspaceRootPath: string,
  statusId: string
): { migrated: number } {
  const config = loadStatusConfig(workspaceRootPath);
  const status = config.statuses.find(s => s.id === statusId);

  if (!status) {
    throw new Error(`Status '${statusId}' not found`);
  }

  // 固定状态不能删除
  if (status.isFixed) {
    throw new Error(`Cannot delete fixed status '${statusId}'`);
  }

  // 默认状态不能删除
  if (status.isDefault) {
    throw new Error(`Cannot delete default status '${statusId}'. Modify it instead.`);
  }

  // 从配置中移除
  config.statuses = config.statuses.filter(s => s.id !== statusId);
  saveStatusConfig(workspaceRootPath, config);

  // 将使用该状态的会话迁移到 'todo'
  const migrated = migrateSessionsFromDeletedStatus(workspaceRootPath, statusId);

  return { migrated };
}
```

### 5.4 会话迁移逻辑

```typescript
function migrateSessionsFromDeletedStatus(
  workspaceRootPath: string,
  deletedStatusId: string
): number {
  const { listSessions, updateSessionMetadata } = require('../sessions/storage.ts');

  const sessions = listSessions(workspaceRootPath);
  let migratedCount = 0;

  for (const session of sessions) {
    if (session.todoState === deletedStatusId) {
      // 自动迁移到 'todo' 状态
      updateSessionMetadata(workspaceRootPath, session.id, { todoState: 'todo' });
      migratedCount++;
    }
  }

  return migratedCount;
}
```

### 5.5 重新排序状态

```typescript
export function reorderStatuses(
  workspaceRootPath: string,
  orderedIds: string[]
): void {
  const config = loadStatusConfig(workspaceRootPath);

  // 验证所有 ID 存在
  const validIds = new Set(config.statuses.map(s => s.id));
  for (const id of orderedIds) {
    if (!validIds.has(id)) {
      throw new Error(`Invalid status ID: ${id}`);
    }
  }

  // 根据数组位置更新 order
  for (let i = 0; i < orderedIds.length; i++) {
    const status = config.statuses.find(s => s.id === orderedIds[i]);
    if (status) {
      status.order = i;
    }
  }

  saveStatusConfig(workspaceRootPath, config);
}
```

---

## 6. 图标系统

### 6.1 图标优先级

```
优先级 1: 配置中的 emoji（用户在 config.json 中设置的 "icon" 字段）
    ↓
优先级 2: 本地文件（statuses/icons/{statusId}.svg|png|jpg）
    ↓
优先级 3: 回退 bullet（●）
```

### 6.2 默认 SVG 图标

```typescript
// packages/shared/src/statuses/default-icons.ts

export const DEFAULT_ICON_SVGS: Record<string, string> = {
  // Backlog - 虚线圆圈（未计划）
  'backlog': `<svg ...>
    <circle cx="12" cy="12" r="9" stroke-dasharray="6 5" />
  </svg>`,

  // Todo - 空心圆圈（准备工作）
  'todo': `<svg ...>
    <circle cx="12" cy="12" r="9" />
  </svg>`,

  // In Progress - 半填充圆圈（进行中）
  'in-progress': `<svg ...>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a9 9 0 0 0 0 18" fill="currentColor" stroke="none" />
  </svg>`,

  // Needs Review - 中心有点的圆圈（等待审查）
  'needs-review': `<svg ...>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  </svg>`,

  // Done - 填充圆圈 + 复选标记（已完成）
  'done': `<svg ...>
    <circle cx="12" cy="12" r="10" fill="currentColor" />
    <path d="M8 12l3 3 5-5" stroke="white" stroke-width="2" />
  </svg>`,

  // Cancelled - 填充圆圈 + X 标记（已取消）
  'cancelled': `<svg ...>
    <circle cx="12" cy="12" r="10" fill="currentColor" />
    <path d="M9 9l6 6M15 9l-6 6" stroke="white" stroke-width="2" />
  </svg>`,
};
```

### 6.3 图标视觉设计

```
  Backlog      Todo      In Progress   Needs Review    Done        Cancelled
    ◌           ○            ◐             ⊙            ✓            ✕
  (虚线圈)   (空心圈)     (半填充)     (中心点)     (填充+勾)    (填充+叉)
```

### 6.4 图标解析流程

```typescript
// apps/electron/src/renderer/config/todo-states.tsx

export async function resolveStatusIcon(
  statusId: string,
  icon: string | undefined,
  workspaceId: string,
  className: string = ICON_SIZE
): Promise<ResolvedIcon> {
  // 优先级 1: 配置中的 emoji
  if (icon && isEmoji(icon)) {
    return {
      node: <span className="text-[13px] leading-none">{icon}</span>,
      colorable: false,  // emoji 有自己的颜色
    }
  }

  // 优先级 2: 本地图标文件
  const iconFile = await tryLoadIconFile(workspaceId, statusId)
  if (iconFile) {
    if (iconFile.extension === '.svg') {
      const sanitized = sanitizeSvg(iconFile.content)
      const colorable = svgUsesCurrentColor(iconFile.content)
      return {
        node: (
          <div
            className={className}
            dangerouslySetInnerHTML={{ __html: sanitized }}
          />
        ),
        colorable,  // 如果 SVG 使用 currentColor，则可着色
      }
    } else {
      // PNG/JPG - 图像有自己的颜色
      return {
        node: <img src={iconFile.content} className={className} />,
        colorable: false,
      }
    }
  }

  // 优先级 3: 回退 bullet
  return {
    node: <span className={className}>●</span>,
    colorable: true,
  }
}
```

### 6.5 图标可着色性

```typescript
/**
 * 检查 SVG 是否使用 currentColor（意味着应继承状态颜色）
 * 使用硬编码颜色的 SVG 应以完全不透明度渲染
 */
function svgUsesCurrentColor(svgContent: string): boolean {
  return svgContent.includes('currentColor')
}
```

- **colorable: true** - 图标使用 `currentColor`，会继承状态颜色
- **colorable: false** - 图标有自己的颜色（emoji、图像、硬编码颜色的 SVG）

---

## 7. 颜色系统

### 7.1 默认颜色映射

```typescript
// apps/electron/src/renderer/config/todo-states.tsx

const DEFAULT_STATUS_COLORS: Record<string, string> = {
  'backlog': 'text-foreground/50',     // 淡灰 - 未计划
  'todo': 'text-foreground/50',         // 淡灰 - 准备工作
  'in-progress': 'text-success',       // 绿色 - 活跃工作
  'needs-review': 'text-info',         // 琥珀色 - 需要注意
  'done': 'text-accent',               // 紫色 - 已完成
  'cancelled': 'text-foreground/50',   // 淡灰 - 不活跃
}

const DEFAULT_FALLBACK_COLOR = 'text-foreground/50'  // 自定义状态默认颜色
```

### 7.2 颜色语义设计

| 状态 | 颜色 | 语义 |
|------|------|------|
| Backlog | 淡灰 (`text-foreground/50`) | 低优先级，等待排期 |
| Todo | 淡灰 (`text-foreground/50`) | 准备就绪，等待开始 |
| In Progress | 绿色 (`text-success`) | 活跃进行中 |
| Needs Review | 琥珀色 (`text-info`) | 需要关注/审查 |
| Done | 紫色 (`text-accent`) | 成功完成 |
| Cancelled | 淡灰 (`text-foreground/50`) | 已取消，不活跃 |

### 7.3 颜色格式支持

```typescript
// 支持两种颜色格式

// 1. Tailwind 类
color: 'text-success'
color: 'text-info'
color: 'text-foreground/50'

// 2. Hex 颜色值
color: '#FF0000'
color: '#00FF00'
```

### 7.4 颜色应用逻辑

```tsx
// apps/electron/src/renderer/components/app-shell/SessionMenu.tsx

<span
  className={cn(
    'shrink-0 flex items-center justify-center h-3.5 w-3.5',
    // 如果不是 hex 颜色，使用 Tailwind 类
    !isHexColor(state.color) && state.color
  )}
  style={
    // 如果是 hex 颜色，使用内联样式
    isHexColor(state.color) ? { color: state.color } : undefined
  }
>
  {state.icon}
</span>
```

---

## 8. 前端状态管理

### 8.1 Jotai 原子定义

```typescript
// apps/electron/src/renderer/atoms/sessions.ts

export interface SessionMeta {
  id: string
  title: string
  // ... 其他字段
  todoState?: string  // 会话状态
}

// 提取会话元数据
export function extractSessionMeta(session: Session): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    // ...
    todoState: session.todoState,
  }
}

// 更新会话元数据的原子
export const updateSessionMetaAtom = atom(
  null,
  (get, set, sessionId: string, updates: Partial<SessionMeta>) => {
    const metaMap = get(sessionMetaMapAtom)
    const existing = metaMap.get(sessionId)
    if (existing) {
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, { ...existing, ...updates })
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)
```

### 8.2 状态加载 Hook

```typescript
// apps/electron/src/renderer/hooks/useStatuses.ts

export function useStatuses(workspaceId: string | null): UseStatusesResult {
  const [statuses, setStatuses] = useState<StatusConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setStatuses([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const configs = await window.electronAPI.listStatuses(workspaceId)
      setStatuses(configs)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load statuses')
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  // 订阅状态配置变化
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onStatusesChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        clearIconCache()  // 清除图标缓存
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  return { statuses, isLoading, error, refresh }
}
```

### 8.3 状态转换

```typescript
// StatusConfig → TodoState（带解析的图标）

export async function statusConfigToTodoState(
  config: StatusConfig,
  workspaceId: string
): Promise<TodoState> {
  const resolvedIcon = await resolveStatusIcon(config.id, config.icon, workspaceId)

  return {
    id: config.id,
    label: config.label,
    color: config.color ?? getDefaultStatusColor(config.id),
    icon: resolvedIcon.node,
    iconColorable: resolvedIcon.colorable,
    category: config.category,
    isFixed: config.isFixed,
    isDefault: config.isDefault,
  }
}
```

---

## 9. IPC 通信流程

### 9.1 设置会话状态流程

```
用户操作                           渲染进程                        主进程
   │                                  │                              │
   │  点击状态菜单项                   │                              │
   ├─────────────────────────────────>│                              │
   │                                  │                              │
   │                                  │  updateSessionById()         │
   │                                  │  (Jotai 立即更新)            │
   │                                  │                              │
   │                                  │  sessionCommand(sessionId,   │
   │                                  │    { type: 'setTodoState',   │
   │                                  │      state: newState })      │
   │                                  ├─────────────────────────────>│
   │                                  │                              │
   │                                  │                              │ setTodoState()
   │                                  │                              │ ├─ 更新内存
   │                                  │                              │ ├─ 持久化到磁盘
   │                                  │                              │ └─ 广播事件
   │                                  │                              │
   │                                  │  onSessionEvent()            │
   │                                  │  { type: 'todo_state_changed'│
   │                                  │<─────────────────────────────┤
   │                                  │                              │
   │  UI 更新                         │                              │
   │<─────────────────────────────────│                              │
```

### 9.2 主进程处理

```typescript
// apps/electron/src/main/sessions.ts

async setTodoState(sessionId: string, todoState: TodoState): Promise<void> {
  const managed = this.sessions.get(sessionId)
  if (managed) {
    // 1. 更新内存中的会话对象
    managed.todoState = todoState

    // 2. 持久化到磁盘
    const workspaceRootPath = managed.workspace.rootPath
    setStoredSessionTodoState(workspaceRootPath, sessionId, todoState)

    // 3. 广播事件到所有窗口
    this.sendEvent(
      { type: 'todo_state_changed', sessionId, todoState },
      managed.workspace.id
    )
  }
}
```

### 9.3 IPC 命令处理

```typescript
// apps/electron/src/main/ipc.ts

case 'setTodoState':
  return sessionManager.setTodoState(sessionId, command.state)
```

---

## 10. 侧边栏过滤逻辑

### 10.1 ChatFilter 类型

```typescript
// 过滤器类型
type ChatFilter =
  | { kind: 'allChats' }           // 所有聊天
  | { kind: 'flagged' }            // 已标记
  | { kind: 'state'; stateId: string }  // 按状态过滤
```

### 10.2 过滤实现

```typescript
// apps/electron/src/renderer/contexts/NavigationContext.tsx

const filterSessionsByFilter = useCallback(
  (filter: ChatFilter): SessionMeta[] => {
    return sessionMetas.filter((session) => {
      switch (filter.kind) {
        case 'allChats':
          return true  // 显示所有会话

        case 'flagged':
          return session.isFlagged === true  // 只显示已标记的

        case 'state':
          return session.todoState === filter.stateId  // 按状态 ID 过滤

        default:
          return false
      }
    })
  },
  [sessionMetas]
)
```

### 10.3 完成状态判断

```typescript
// 判断会话是否"已完成"
const isSessionDone = useCallback((session: SessionMeta): boolean => {
  return session.todoState === 'done' || session.todoState === 'cancelled'
}, [])
```

### 10.4 侧边栏导航结构

```
侧边栏导航
├── All Chats          (kind: 'allChats')
├── Flagged            (kind: 'flagged')
├── ─────────          (分隔符)
├── Backlog            (kind: 'state', stateId: 'backlog')
├── Todo               (kind: 'state', stateId: 'todo')
├── Needs Review       (kind: 'state', stateId: 'needs-review')
├── ─────────          (分隔符)
├── Done               (kind: 'state', stateId: 'done')
└── Cancelled          (kind: 'state', stateId: 'cancelled')
```

---

## 11. 自定义状态指南

### 11.1 通过 UI 创建自定义状态

1. 右键点击侧边栏中的任意状态
2. 选择 "Configure Statuses"
3. 在弹出的对话框中添加新状态

### 11.2 手动编辑 config.json

```json
// ~/.craft-agent/workspaces/{workspaceId}/statuses/config.json

{
  "version": 1,
  "statuses": [
    // ... 默认状态 ...
    {
      "id": "urgent",
      "label": "Urgent",
      "color": "#FF0000",
      "icon": "🔥",
      "category": "open",
      "isFixed": false,
      "isDefault": false,
      "order": 10
    },
    {
      "id": "blocked",
      "label": "Blocked",
      "color": "text-destructive",
      "category": "open",
      "isFixed": false,
      "isDefault": false,
      "order": 11
    }
  ],
  "defaultStatusId": "todo"
}
```

### 11.3 自定义图标

**方法 1: 使用 Emoji**
```json
{
  "id": "urgent",
  "icon": "🔥"
}
```

**方法 2: 使用自定义 SVG**
```bash
# 将 SVG 文件放入图标目录
cp my-icon.svg ~/.craft-agent/workspaces/{workspaceId}/statuses/icons/urgent.svg
```

SVG 文件应使用 `currentColor` 以支持主题颜色：
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="..." />
</svg>
```

**方法 3: 使用 URL（自动下载）**
```json
{
  "id": "urgent",
  "icon": "https://example.com/icon.svg"
}
```

### 11.4 自定义颜色

```json
// 使用 Tailwind 类
{ "color": "text-success" }
{ "color": "text-info" }
{ "color": "text-destructive" }
{ "color": "text-foreground/50" }

// 使用 Hex 颜色
{ "color": "#FF0000" }
{ "color": "#00FF00" }
```

---

## 12. 架构设计亮点

### 12.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                         UI Layer                            │
│  (React Components, Hooks, Jotai Atoms)                     │
├─────────────────────────────────────────────────────────────┤
│                        IPC Layer                            │
│  (electronAPI, preload, ipcMain)                            │
├─────────────────────────────────────────────────────────────┤
│                     Business Layer                          │
│  (statuses/crud.ts, statuses/storage.ts)                    │
├─────────────────────────────────────────────────────────────┤
│                     Storage Layer                           │
│  (File System: config.json, icons/, session.jsonl)          │
└─────────────────────────────────────────────────────────────┘
```

### 12.2 乐观更新模式

```typescript
// 前端立即更新（乐观）
updateSessionById(sessionId, { todoState: state })

// 后台持久化（异步）
window.electronAPI.sessionCommand(sessionId, { type: 'setTodoState', state })
```

**优势**：
- 即时用户反馈
- 减少感知延迟
- 后台同步不阻塞 UI

### 12.3 自愈设计

```typescript
// 加载时自动创建缺失的默认图标
ensureDefaultIconFiles(workspaceRootPath);

// 无效配置回退到默认
if (!validateStatusConfig(config)) {
  return getDefaultStatusConfig();
}

// 删除状态时自动迁移会话
const migrated = migrateSessionsFromDeletedStatus(workspaceRootPath, statusId);
```

### 12.4 事件驱动同步

```typescript
// 状态变更 → 广播事件 → 所有窗口更新
this.sendEvent(
  { type: 'todo_state_changed', sessionId, todoState },
  managed.workspace.id
)

// 配置变更 → 文件监听 → 刷新状态列表
window.electronAPI.onStatusesChanged((changedWorkspaceId) => {
  if (changedWorkspaceId === workspaceId) {
    clearIconCache()
    refresh()
  }
})
```

### 12.5 扩展性设计

| 扩展点 | 描述 |
|--------|------|
| **自定义状态** | 用户可创建任意数量的自定义状态 |
| **自定义图标** | 支持 emoji、SVG、PNG/JPG |
| **自定义颜色** | 支持 Tailwind 类和 Hex 颜色 |
| **工作空间隔离** | 每个工作空间独立配置 |
| **版本迁移** | `version` 字段支持未来架构升级 |

---

## 总结

Craft Agents 的 Session Status 系统是一个**完整的工作流管理解决方案**，其设计特点包括：

1. **简单但灵活** - 预设合理的默认状态，同时支持完全自定义
2. **保护核心功能** - 固定状态机制防止用户意外破坏基本工作流
3. **视觉一致性** - 统一的图标和颜色系统
4. **性能优化** - 乐观更新、图标缓存、事件驱动同步
5. **健壮性** - 自愈机制、回退默认值、迁移保护
6. **可扩展性** - 版本控制、工作空间隔离、多种自定义选项

这种设计模式可以应用于任何需要工作流状态管理的应用场景。
