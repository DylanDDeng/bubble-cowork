import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AppState,
  AppActions,
  SessionView,
  ServerEvent,
  SessionInfo,
  StreamMessage,
  Attachment,
  SearchFilters,
  SearchMatch,
  StatusConfig,
  TodoState,
} from '../types';

type Store = AppState & AppActions;
type SetState = (
  partial: Store | Partial<Store> | ((state: Store) => Store | Partial<Store>)
) => void;

export const useAppStore = create<Store>()(
  persist(
    (set, get) => ({
      // 状态
      connected: false,
      sessions: {},
      activeSessionId: null,
      showNewSession: false,
      sidebarCollapsed: false,
      globalError: null,
      pendingStart: false,
      projectCwd: null,
      projectTreeCwd: null,
      projectTree: null,
      projectTreeCollapsed: false,
      // 搜索状态
      sidebarSearchQuery: '',
      activeFilters: { timeRange: 'all' },
      inSessionSearchOpen: false,
      inSessionSearchQuery: '',
      inSessionSearchResults: [],
      inSessionSearchCurrentIndex: 0,
      // MCP 状态
      mcpServers: {},
      mcpGlobalServers: {},
      mcpProjectServers: {},
      mcpServerStatus: [],
      showMcpSettings: false,
      // 状态配置
      statusConfigs: [],
      statusFilter: 'all',

  // Actions
  setConnected: (connected) => set({ connected }),

  handleServerEvent: (event: ServerEvent) => {
    switch (event.type) {
      case 'session.list':
        handleSessionList(event.payload.sessions, set, get);
        break;

      case 'session.status':
        handleSessionStatus(event.payload, set, get);
        break;

      case 'session.history':
        handleSessionHistory(event.payload, set);
        break;

      case 'session.deleted':
        handleSessionDeleted(event.payload.sessionId, set, get);
        break;

      case 'stream.user_prompt':
        handleUserPrompt(event.payload, set);
        break;

      case 'stream.message':
        handleStreamMessage(event.payload, set);
        break;

      case 'permission.request':
        handlePermissionRequest(event.payload, set);
        break;

      case 'runner.error':
        set({ globalError: event.payload.message });
        break;

      case 'project.tree':
        set({
          projectTreeCwd: event.payload.cwd,
          projectTree: event.payload.tree,
        });
        break;

      case 'mcp.config':
        set({
          mcpServers: event.payload.servers,
          mcpGlobalServers: event.payload.globalServers || event.payload.servers,
          mcpProjectServers: event.payload.projectServers || {},
        });
        break;

      case 'mcp.status':
        set({ mcpServerStatus: event.payload.servers });
        break;

      case 'status.list':
      case 'status.changed':
        set({ statusConfigs: event.payload.statuses });
        break;

      case 'session.todoStateChanged':
        handleTodoStateChanged(event.payload, set, get);
        break;
    }
  },

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  setShowNewSession: (show) => set({ showNewSession: show }),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setProjectCwd: (cwd) => set({ projectCwd: cwd }),

  setProjectTree: (cwd, tree) => set({ projectTreeCwd: cwd, projectTree: tree }),

  setProjectTreeCollapsed: (collapsed) => set({ projectTreeCollapsed: collapsed }),


  clearGlobalError: () => set({ globalError: null }),

  setPendingStart: (pending) => set({ pendingStart: pending }),

  removePermissionRequest: (sessionId, toolUseId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      return {
        ...state,
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            permissionRequests: session.permissionRequests.filter(
              (r) => r.toolUseId !== toolUseId
            ),
          },
        },
      };
    });
  },

  // 搜索 Actions
  setSidebarSearchQuery: (query) => set({ sidebarSearchQuery: query }),

  setActiveFilters: (filters) =>
    set((state) => ({
      activeFilters: { ...state.activeFilters, ...filters },
    })),

  clearFilters: () => set({ activeFilters: { timeRange: 'all' } }),

  openInSessionSearch: () => set({ inSessionSearchOpen: true }),

  closeInSessionSearch: () =>
    set({
      inSessionSearchOpen: false,
      inSessionSearchQuery: '',
      inSessionSearchResults: [],
      inSessionSearchCurrentIndex: 0,
    }),

  setInSessionSearchQuery: (query) => set({ inSessionSearchQuery: query }),

  setInSessionSearchResults: (results) =>
    set({ inSessionSearchResults: results, inSessionSearchCurrentIndex: 0 }),

  navigateSearchResult: (direction) =>
    set((state) => {
      const total = state.inSessionSearchResults.length;
      if (total === 0) return state;

      let newIndex = state.inSessionSearchCurrentIndex;
      if (direction === 'next') {
        newIndex = (newIndex + 1) % total;
      } else {
        newIndex = (newIndex - 1 + total) % total;
      }
      return { inSessionSearchCurrentIndex: newIndex };
    }),

  // MCP Actions
  setMcpServers: (servers) => set({ mcpServers: servers }),
  setMcpServerStatus: (status) => set({ mcpServerStatus: status }),
  setShowMcpSettings: (show) => set({ showMcpSettings: show }),

  // 状态配置 Actions
  setStatusConfigs: (configs) => set({ statusConfigs: configs }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),
    }),
    {
      name: 'cowork-app-storage',
      partialize: () => ({}),
    }
  )
);

// 处理会话列表
function handleSessionList(
  sessions: SessionInfo[],
  set: SetState,
  get: () => Store
) {
  const sessionsMap: Record<string, SessionView> = {};

  for (const session of sessions) {
    const existing = get().sessions[session.id];
    sessionsMap[session.id] = {
      id: session.id,
      title: session.title,
      status: session.status,
      cwd: session.cwd,
      claudeSessionId: session.claudeSessionId,
      provider: session.provider || 'claude',
      todoState: session.todoState || 'todo',
      messages: existing?.messages || [],
      hydrated: existing?.hydrated || false,
      permissionRequests: existing?.permissionRequests || [],
      updatedAt: session.updatedAt,
    };
  }

  // 如果没有会话，显示新建弹窗
  const showNewSession = sessions.length === 0;

  // 默认选中最新更新的会话
  let activeSessionId = get().activeSessionId;
  if (!activeSessionId && sessions.length > 0) {
    activeSessionId = sessions[0].id; // 已按 updated_at 降序排列
  }

  set({
    sessions: sessionsMap,
    showNewSession,
    activeSessionId,
  });
}

// 处理会话状态更新
function handleSessionStatus(
  payload: {
    sessionId: string;
    status: SessionInfo['status'];
    title?: string;
    cwd?: string;
    provider?: SessionInfo['provider'];
  },
  set: SetState,
  get: () => Store
) {
  const { sessionId, status, title, cwd, provider } = payload;
  const state = get();
  const session = state.sessions[sessionId];

  if (session) {
    // 更新现有会话
    set({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          status,
          title: title || session.title,
          cwd: cwd || session.cwd,
          provider: provider || session.provider,
          updatedAt: Date.now(),
        },
      },
    });
  } else {
    // 新建会话（来自 session.start）
    const newSession: SessionView = {
      id: sessionId,
      title: title || 'New Session',
      status,
      cwd,
      provider: provider || 'claude',
      messages: [],
      hydrated: true, // 新会话不需要 hydration
      permissionRequests: [],
      updatedAt: Date.now(),
    };

    set({
      sessions: {
        ...state.sessions,
        [sessionId]: newSession,
      },
      activeSessionId: sessionId,
      showNewSession: false,
      pendingStart: false,
    });
  }
}

// 处理会话历史
function handleSessionHistory(
  payload: {
    sessionId: string;
    status: SessionInfo['status'];
    messages: StreamMessage[];
  },
  set: SetState
) {
  const { sessionId, status, messages } = payload;

  set((state) => {
    const session = state.sessions[sessionId];
    if (!session) return state;

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          status,
          messages,
          hydrated: true,
        },
      },
    };
  });
}

// 处理会话删除
function handleSessionDeleted(
  sessionId: string,
  set: SetState,
  get: () => Store
) {
  const state = get();
  const { [sessionId]: deleted, ...rest } = state.sessions;

  // 如果删除的是当前活动会话，选择另一个
  let newActiveId = state.activeSessionId;
  if (state.activeSessionId === sessionId) {
    const remaining = Object.keys(rest);
    newActiveId = remaining.length > 0 ? remaining[0] : null;
  }

  set({
    sessions: rest,
    activeSessionId: newActiveId,
    showNewSession: Object.keys(rest).length === 0,
  });
}

// 处理用户 prompt
function handleUserPrompt(
  payload: { sessionId: string; prompt: string; attachments?: Attachment[]; createdAt?: number },
  set: SetState
) {
  const { sessionId, prompt, attachments, createdAt } = payload;

  set((state) => {
    const session = state.sessions[sessionId];
    if (!session) return state;

    const userMessage: StreamMessage = {
      type: 'user_prompt',
      prompt,
      attachments,
      createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
    };

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messages: [...session.messages, userMessage],
        },
      },
    };
  });
}

// 处理流式消息
function handleStreamMessage(
  payload: { sessionId: string; message: StreamMessage },
  set: SetState
) {
  const { sessionId, message } = payload;

  set((state) => {
    const session = state.sessions[sessionId];
    if (!session) return state;

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messages: [...session.messages, message],
        },
      },
    };
  });
}

// 处理权限请求
function handlePermissionRequest(
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: unknown;
  },
  set: SetState
) {
  set((state) => {
    const session = state.sessions[payload.sessionId];
    if (!session) return state;

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [payload.sessionId]: {
          ...session,
          permissionRequests: [
            ...session.permissionRequests,
            payload as typeof session.permissionRequests[0],
          ],
        },
      },
    };
  });
}

// 处理 TodoState 变更
function handleTodoStateChanged(
  payload: { sessionId: string; todoState: TodoState },
  set: SetState,
  get: () => Store
) {
  const { sessionId, todoState } = payload;
  const session = get().sessions[sessionId];
  if (!session) return;

  set({
    sessions: {
      ...get().sessions,
      [sessionId]: {
        ...session,
        todoState,
        updatedAt: Date.now(),
      },
    },
  });
}
