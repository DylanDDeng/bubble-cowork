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
  SettingsTab,
  FolderConfig,
  Theme,
  ColorThemeId,
} from '../types';
import { DEFAULT_COLOR_THEME_ID, applyThemePreferences } from '../theme/themes';

function applyTheme(theme: Theme, colorThemeId: ColorThemeId, customThemeCss: string) {
  applyThemePreferences({ themeMode: theme, colorThemeId, customThemeCss });
}

type Store = AppState & AppActions;
type SetState = (
  partial: Store | Partial<Store> | ((state: Store) => Store | Partial<Store>)
) => void;
const runtimeNoticeClearTimers = new Map<string, number>();

function clearRuntimeNoticeTimer(sessionId: string): void {
  const timer = runtimeNoticeClearTimers.get(sessionId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    runtimeNoticeClearTimers.delete(sessionId);
  }
}

function scheduleRuntimeNoticeClear(sessionId: string, set: SetState): void {
  clearRuntimeNoticeTimer(sessionId);
  const timer = window.setTimeout(() => {
    runtimeNoticeClearTimers.delete(sessionId);
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session || state.activeSessionId !== sessionId || !session.runtimeNotice) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            runtimeNotice: undefined,
          },
        },
      };
    });
  }, 2000);

  runtimeNoticeClearTimers.set(sessionId, timer);
}

function sanitizeSidebarWidth(width: number | undefined, fallback: number): number {
  if (typeof width !== 'number' || Number.isNaN(width)) return fallback;
  return Math.min(420, Math.max(220, Math.round(width)));
}

function createEmptyStreamingState() {
  return {
    isStreaming: false,
    text: '',
    thinking: '',
  };
}

function sanitizeHistoryMessages(messages: StreamMessage[]): StreamMessage[] {
  return messages.filter((message) => message.type !== 'stream_event');
}

export const useAppStore = create<Store>()(
  persist(
    (set, get) => ({
      // 状态
      connected: false,
      sessions: {},
      activeSessionId: null,
      showNewSession: false,
      sidebarCollapsed: false,
      sidebarWidth: 256,
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
      claudeUserSkills: [],
      claudeProjectSkills: [],
      claudeSkillsUserRoot: '',
      claudeSkillsProjectRoot: undefined,
      // Settings 状态
      showSettings: false,
      activeSettingsTab: 'mcp' as SettingsTab,
      // 状态配置
      statusConfigs: [],
      statusFilter: 'all',
      // 文件夹
      folderConfigs: [],
      // 主题
      theme: 'system' as const,
      colorThemeId: DEFAULT_COLOR_THEME_ID,
      customThemeCss: '',

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

      case 'skills.list':
        set({
          claudeUserSkills: event.payload.userSkills,
          claudeProjectSkills: event.payload.projectSkills,
          claudeSkillsUserRoot: event.payload.userRoot,
          claudeSkillsProjectRoot: event.payload.projectRoot,
        });
        break;

      case 'status.list':
      case 'status.changed':
        set({ statusConfigs: event.payload.statuses });
        break;

      case 'session.todoStateChanged':
        handleTodoStateChanged(event.payload, set, get);
        break;

      case 'session.pinned':
        handleSessionPinned(event.payload, set, get);
        break;

      case 'folder.list':
      case 'folder.changed':
        set({ folderConfigs: event.payload.folders });
        break;

      case 'session.folderChanged':
        handleSessionFolderChanged(event.payload, set, get);
        break;
    }
  },

  setActiveSession: (sessionId) => {
    set((state) => {
      if (!sessionId) {
        return { activeSessionId: null };
      }

      const session = state.sessions[sessionId];
      if (!session) {
        return { activeSessionId: sessionId };
      }

      return { activeSessionId: sessionId };
    });

    if (sessionId && get().sessions[sessionId]?.runtimeNotice) {
      scheduleRuntimeNoticeClear(sessionId, set);
    }
  },

  setShowNewSession: (show) => set({ showNewSession: show }),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setSidebarWidth: (width) => set((state) => ({
    sidebarWidth: sanitizeSidebarWidth(width, state.sidebarWidth),
  })),

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
  // Settings Actions
  setShowSettings: (show) => set({ showSettings: show }),
  setActiveSettingsTab: (tab) => set({ activeSettingsTab: tab }),

  // 状态配置 Actions
  setStatusConfigs: (configs) => set({ statusConfigs: configs }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),

  // 文件夹 Actions
  setFolderConfigs: (configs) => set({ folderConfigs: configs }),

  // 主题
  setTheme: (theme) => {
    set({ theme });
    // 同步应用到 DOM
    const { colorThemeId, customThemeCss } = get();
    applyTheme(theme, colorThemeId, customThemeCss);
  },

  setColorThemeId: (colorThemeId) => {
    set({ colorThemeId });
    const { theme, customThemeCss } = get();
    applyTheme(theme, colorThemeId, customThemeCss);
  },

  setCustomThemeCss: (customThemeCss) => {
    set({ customThemeCss });
    const { theme, colorThemeId } = get();
    applyTheme(theme, colorThemeId, customThemeCss);
  },
    }),
    {
      name: 'cowork-app-storage',
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        theme: state.theme,
        colorThemeId: state.colorThemeId,
        customThemeCss: state.customThemeCss,
      }),
      merge: (persistedState: unknown, currentState: Store) => {
        const persisted = persistedState as {
          sidebarWidth?: number;
          theme?: Theme;
          colorThemeId?: ColorThemeId;
          customThemeCss?: string;
        } | undefined;
        const theme = persisted?.theme || currentState.theme;
        const colorThemeId = persisted?.colorThemeId || currentState.colorThemeId;
        const customThemeCss = persisted?.customThemeCss || currentState.customThemeCss;
        // 初始化时应用主题
        applyTheme(theme, colorThemeId, customThemeCss);
        return {
          ...currentState,
          sidebarWidth: sanitizeSidebarWidth(persisted?.sidebarWidth, currentState.sidebarWidth),
          theme,
          colorThemeId,
          customThemeCss,
        };
      },
    }
  )
);

// 监听系统主题变化
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { theme, colorThemeId, customThemeCss } = useAppStore.getState();
    if (theme === 'system') {
      applyTheme('system', colorThemeId, customThemeCss);
    }
  });
}

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
      model: session.model,
      betas: session.betas,
      todoState: session.todoState || 'todo',
      pinned: session.pinned || false,
      folderPath: session.folderPath || null,
      messages: existing?.messages || [],
      hydrated: existing?.hydrated || false,
      permissionRequests: existing?.permissionRequests || [],
      streaming: existing?.streaming || createEmptyStreamingState(),
      runtimeNotice: existing?.runtimeNotice,
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
    model?: SessionInfo['model'];
    betas?: SessionInfo['betas'];
  },
  set: SetState,
  get: () => Store
) {
  const { sessionId, status, title, cwd, provider, model, betas } = payload;
  const state = get();
  const session = state.sessions[sessionId];

  if (session) {
    const nextRuntimeNotice =
      sessionId === state.activeSessionId
        ? undefined
        : status === 'running'
          ? session.runtimeNotice
          : session.status === 'running' && status === 'completed'
            ? 'completed'
            : session.status === 'running' && status === 'error'
              ? 'error'
              : session.runtimeNotice;

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
          model: model !== undefined ? (model || undefined) : session.model,
          betas: betas !== undefined ? betas : session.betas,
          streaming:
            status === 'running'
              ? session.streaming
              : createEmptyStreamingState(),
          runtimeNotice: nextRuntimeNotice,
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
      model,
      betas,
      messages: [],
      hydrated: true, // 新会话不需要 hydration
      permissionRequests: [],
      streaming: createEmptyStreamingState(),
      runtimeNotice: undefined,
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
  const sanitizedMessages = sanitizeHistoryMessages(messages);

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
          messages: sanitizedMessages,
          hydrated: true,
          streaming: createEmptyStreamingState(),
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
          streaming: createEmptyStreamingState(),
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

    if (message.type === 'stream_event') {
      const event = message.event;
      const currentStreaming = session.streaming || createEmptyStreamingState();

      if (event.type === 'content_block_delta' && event.delta) {
        if (event.delta.type === 'text_delta') {
          const nextText = currentStreaming.text + (typeof event.delta.text === 'string' ? event.delta.text : '');
          if (nextText === currentStreaming.text && currentStreaming.isStreaming) {
            return state;
          }
          return {
            ...state,
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...session,
                streaming: {
                  ...currentStreaming,
                  isStreaming: true,
                  text: nextText,
                },
              },
            },
          };
        }

        if (event.delta.type === 'thinking_delta') {
          const nextThinking =
            currentStreaming.thinking + (typeof event.delta.thinking === 'string' ? event.delta.thinking : '');
          if (nextThinking === currentStreaming.thinking && currentStreaming.isStreaming) {
            return state;
          }
          return {
            ...state,
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...session,
                streaming: {
                  ...currentStreaming,
                  isStreaming: true,
                  thinking: nextThinking,
                },
              },
            },
          };
        }
      }

      if (event.type === 'content_block_stop' && currentStreaming.isStreaming) {
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...session,
              streaming: createEmptyStreamingState(),
            },
          },
        };
      }

      return state;
    }

    // Claude Agent SDK may emit partial updates for the same message UUID.
    // Replace existing messages instead of appending duplicates.
    const maybeUuid = (message as { uuid?: unknown }).uuid;
    if (
      (message.type === 'assistant' || message.type === 'user') &&
      typeof maybeUuid === 'string' &&
      maybeUuid.length > 0
    ) {
      const existingIndex = session.messages.findIndex(
        (m) => (m as { uuid?: unknown }).uuid === maybeUuid
      );
      if (existingIndex >= 0) {
        const nextMessages = session.messages.slice();
        nextMessages[existingIndex] = message;
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...session,
              messages: nextMessages,
              streaming: createEmptyStreamingState(),
            },
          },
        };
      }
    }

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messages: [...session.messages, message],
          streaming: createEmptyStreamingState(),
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

// 处理置顶状态变更
function handleSessionPinned(
  payload: { sessionId: string; pinned: boolean },
  set: SetState,
  get: () => Store
) {
  const { sessionId, pinned } = payload;
  const session = get().sessions[sessionId];
  if (!session) return;

  set({
    sessions: {
      ...get().sessions,
      [sessionId]: {
        ...session,
        pinned,
        updatedAt: Date.now(),
      },
    },
  });
}

// 处理 Session 文件夹变更
function handleSessionFolderChanged(
  payload: { sessionId: string; folderPath: string | null },
  set: SetState,
  get: () => Store
) {
  const { sessionId, folderPath } = payload;
  const session = get().sessions[sessionId];
  if (!session) return;

  set({
    sessions: {
      ...get().sessions,
      [sessionId]: {
        ...session,
        folderPath,
        updatedAt: Date.now(),
      },
    },
  });
}
