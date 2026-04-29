import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { toast } from 'sonner';
import type {
  ActiveWorkspace,
  AppState,
  AppActions,
  ChatLayoutMode,
  ChatPaneId,
  ChatPaneState,
  ChatSidebarView,
  WorkspaceSurface,
  SessionView,
  ServerEvent,
  SessionInfo,
  StreamMessage,
  ContentBlock,
  Attachment,
  SearchFilters,
  SearchMatch,
  StatusConfig,
  TodoState,
  SettingsTab,
  FolderConfig,
  Theme,
  ThemeFonts,
  ThemeState,
  ThemeVariant,
  ChromeTheme,
  PromptLibraryInsertMode,
} from '../types';
import {
  DEFAULT_THEME_STATE,
  applyThemePreferences,
  normalizeThemeState,
  resetThemeVariant as resetThemeVariantState,
  setThemeCodeThemeId,
  setThemePackFonts,
  updateThemePack,
} from '../theme/themes';
import { loadPreferredProvider } from '../utils/provider';

function applyAppearance({
  theme,
  themeState,
  uiFontFamily,
  chatCodeFontFamily,
}: {
  theme: Theme;
  themeState: ThemeState;
  uiFontFamily: string;
  chatCodeFontFamily: string;
}) {
  applyThemePreferences({ themeMode: theme, themeState, uiFontFamily, chatCodeFontFamily });
}

type Store = AppState & AppActions;
type SetState = (
  partial: Store | Partial<Store> | ((state: Store) => Store | Partial<Store>)
) => void;
const runtimeNoticeClearTimers = new Map<string, number>();

type AssistantStreamMessage = StreamMessage & { type: 'assistant' };

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

function isAssistantStreamMessage(message: StreamMessage): message is AssistantStreamMessage {
  return message.type === 'assistant';
}

function getAssistantText(message: AssistantStreamMessage): string {
  return message.message.content
    .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
    .map((block) => block.text || '')
    .join('');
}

function mergeAssistantText(existingText: string, incomingText: string, incomingStreaming: boolean): string {
  if (incomingStreaming || incomingText.length === 0) {
    return `${existingText}${incomingText}`;
  }
  if (incomingText.startsWith(existingText)) {
    return incomingText;
  }
  if (existingText.startsWith(incomingText)) {
    return existingText;
  }
  return `${existingText}${incomingText}`;
}

function mergeCodexAssistantMessage(
  existing: AssistantStreamMessage,
  incoming: AssistantStreamMessage
): AssistantStreamMessage {
  const existingText = getAssistantText(existing);
  const incomingText = getAssistantText(incoming);
  const nextText = mergeAssistantText(existingText, incomingText, incoming.streaming === true);
  const existingNonText = existing.message.content.filter((block) => block.type !== 'text');
  const incomingNonText = incoming.message.content.filter((block) => block.type !== 'text');
  const nextNonText = incomingNonText.length > 0 ? incomingNonText : existingNonText;
  const nextContent: ContentBlock[] = [
    ...nextNonText,
    ...(nextText ? [{ type: 'text' as const, text: nextText }] : []),
  ];

  return {
    ...incoming,
    createdAt: existing.createdAt,
    message: {
      ...incoming.message,
      content: nextContent,
    },
  };
}

function shouldPreserveStreamingStateForMessage(
  provider: SessionInfo['provider'],
  message: StreamMessage
): boolean {
  return provider === 'codex' && message.type === 'assistant' && message.streaming === true;
}

function sanitizeSidebarWidth(width: number | undefined, fallback: number): number {
  if (typeof width !== 'number' || Number.isNaN(width)) return fallback;
  return Math.min(420, Math.max(220, Math.round(width)));
}

function sanitizeTerminalDrawerHeight(height: number | undefined, fallback = 280): number {
  if (typeof height !== 'number' || Number.isNaN(height)) return fallback;
  return Math.min(640, Math.max(180, Math.round(height)));
}

function sanitizeChatSplitRatio(ratio: number | undefined, fallback = 0.5): number {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) return fallback;
  return Math.min(0.65, Math.max(0.35, ratio));
}

function createDefaultChatPanes(activeSessionId: string | null): Record<ChatPaneId, ChatPaneState> {
  return {
    primary: { id: 'primary', sessionId: activeSessionId, surface: 'chat' },
    secondary: { id: 'secondary', sessionId: null, surface: 'chat' },
  };
}

function normalizeActivePaneId(value: unknown): ChatPaneId {
  return value === 'secondary' ? 'secondary' : 'primary';
}

function normalizeChatLayoutMode(value: unknown): ChatLayoutMode {
  return value === 'split' ? 'split' : 'single';
}

function normalizeChatPanes(
  panes: import('../shared/types').UiResumeState['chatPanes'] | undefined,
  fallbackSessionId: string | null
): Record<ChatPaneId, ChatPaneState> {
  return {
    primary: {
      id: 'primary',
      sessionId: panes?.primary?.sessionId ?? fallbackSessionId,
      surface: 'chat',
    },
    secondary: {
      id: 'secondary',
      sessionId: panes?.secondary?.sessionId ?? null,
      surface: 'chat',
    },
  };
}

function persistUiResumeStateSnapshot(state: Pick<
  AppState,
  | 'activeSessionId'
  | 'showNewSession'
  | 'projectCwd'
  | 'projectTreeCollapsed'
  | 'projectPanelView'
  | 'terminalDrawerOpen'
  | 'terminalDrawerHeight'
  | 'chatLayoutMode'
  | 'savedSplitVisible'
  | 'activePaneId'
  | 'chatPanes'
  | 'chatSplitRatio'
>): void {
  if (typeof window === 'undefined' || !window.electron?.saveUiResumeState) {
    return;
  }

  void window.electron.saveUiResumeState({
    activeSessionId: state.activeSessionId,
    showNewSession: state.showNewSession,
    projectCwd: state.projectCwd,
    projectTreeCollapsed: state.projectTreeCollapsed,
    projectPanelView: state.projectPanelView,
    terminalDrawerOpen: state.terminalDrawerOpen,
    terminalDrawerHeight: state.terminalDrawerHeight,
    chatLayoutMode: state.chatLayoutMode,
    savedSplitVisible: state.savedSplitVisible,
    activePaneId: state.activePaneId,
    chatPanes: state.chatPanes,
    chatSplitRatio: state.chatSplitRatio,
  });
}

function getInitialUiResumeState(): import('../shared/types').UiResumeState | null {
  if (typeof window === 'undefined' || !window.electron?.getUiResumeStateSync) {
    return null;
  }

  try {
    return window.electron.getUiResumeStateSync();
  } catch {
    return null;
  }
}

const initialUiResumeState = getInitialUiResumeState();
const initialChatPanes = normalizeChatPanes(
  initialUiResumeState?.chatPanes,
  initialUiResumeState?.activeSessionId ?? null
);

function createEmptyStreamingState() {
  return {
    isStreaming: false,
    text: '',
    thinking: '',
  };
}

function createDraftSessionView(cwd?: string | null): SessionView {
  const now = Date.now();
  const id = `draft-${now}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    title: 'New Chat',
    status: 'idle',
    source: 'aegis',
    readOnly: false,
    isDraft: true,
    cwd: cwd || undefined,
    provider: loadPreferredProvider(),
    claudeExecutionMode: 'execute',
    todoState: 'todo',
    hiddenFromThreads: false,
    messages: [],
    hydrated: true,
    historyCursor: null,
    hasMoreHistory: false,
    loadingMoreHistory: false,
    permissionRequests: [],
    streaming: createEmptyStreamingState(),
    runtimeNotice: undefined,
    updatedAt: now,
  };
}

function normalizeProjectPanelView(
  value: import('../shared/types').UiResumeState['projectPanelView'] | 'git' | null | undefined
): import('../types').ProjectPanelView {
  if (value === 'changes') {
    return value;
  }
  return 'files';
}

function resolveInitialTerminalDrawerOpen(
  resumeState: import('../shared/types').UiResumeState | null
): boolean {
  if (!resumeState) {
    return false;
  }

  if (resumeState.projectPanelView === 'terminal') {
    return true;
  }

  return resumeState.terminalDrawerOpen === true;
}

function normalizeClaudeAccessMode(value: unknown): import('../types').ClaudeAccessMode {
  return value === 'fullAccess' ? 'fullAccess' : 'default';
}

function normalizeClaudeExecutionMode(value: unknown): import('../types').ClaudeExecutionMode {
  return value === 'plan' ? 'plan' : 'execute';
}

function sanitizeHistoryMessages(messages: StreamMessage[]): StreamMessage[] {
  return messages.filter((message) => message.type !== 'stream_event');
}

function extractLatestClaudeModelUsage(
  messages: StreamMessage[],
  preferredModel?: string | null
): import('../shared/types').LatestClaudeModelUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== 'result' || !message.modelUsage) {
      continue;
    }

    const entries = Object.entries(message.modelUsage);
    if (entries.length === 0) {
      continue;
    }

    const preferred = preferredModel?.trim().toLowerCase();
    const chosen =
      (preferred
        ? entries.find(([model]) => model.trim().toLowerCase() === preferred)
        : undefined) ||
      entries.sort((left, right) => {
        const leftTokens = (left[1].inputTokens || 0) + (left[1].outputTokens || 0);
        const rightTokens = (right[1].inputTokens || 0) + (right[1].outputTokens || 0);
        return rightTokens - leftTokens;
      })[0];

    if (!chosen || !chosen[1].contextWindow) {
      continue;
    }

    return {
      model: chosen[0],
      usage: chosen[1],
    };
  }

  return undefined;
}

export const useAppStore = create<Store>()(
  persist(
    (set, get) => ({
      // 状态
      connected: false,
      sessions: {},
      activeSessionId: initialUiResumeState?.activeSessionId ?? null,
      activeWorkspace: 'chat' as ActiveWorkspace,
      chatSidebarView: 'threads' as ChatSidebarView,
      chatLayoutMode: normalizeChatLayoutMode(initialUiResumeState?.chatLayoutMode),
      savedSplitVisible: initialUiResumeState?.savedSplitVisible ?? false,
      activePaneId: normalizeActivePaneId(initialUiResumeState?.activePaneId),
      chatPanes: initialChatPanes,
      chatSplitRatio: sanitizeChatSplitRatio(initialUiResumeState?.chatSplitRatio),
      showNewSession: initialUiResumeState?.showNewSession ?? true,
      newSessionKey: 0,
      sidebarCollapsed: false,
      sidebarWidth: 256,
      globalError: null,
      pendingStart: false,
      pendingDraftSessionId: null,
      loadOlderSessionHistory: (sessionId) => {
        const session = get().sessions[sessionId];
        if (!session?.historyCursor || session.loadingMoreHistory) {
          return;
        }

        set((state) => {
          const current = state.sessions[sessionId];
          if (!current) return state;
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...current,
                loadingMoreHistory: true,
              },
            },
          };
        });

        window.electron
          .loadOlderSessionHistory(sessionId, session.historyCursor, 100)
          .then((payload) => {
            set((state) => {
              const current = state.sessions[sessionId];
              if (!current) return state;
              const sanitizedMessages = sanitizeHistoryMessages(payload.messages);
              return {
                sessions: {
                  ...state.sessions,
                  [sessionId]: {
                    ...current,
                    messages: [...sanitizedMessages, ...current.messages],
                    historyCursor: payload.cursor ?? null,
                    hasMoreHistory: payload.hasMore === true,
                    loadingMoreHistory: false,
                    latestClaudeModelUsage:
                      extractLatestClaudeModelUsage([...sanitizedMessages, ...current.messages], current.model),
                  },
                },
              };
            });
          })
          .catch((error) => {
            console.error('Failed to load older session history:', error);
            set((state) => {
              const current = state.sessions[sessionId];
              if (!current) return state;
              return {
                sessions: {
                  ...state.sessions,
                  [sessionId]: {
                    ...current,
                    loadingMoreHistory: false,
                  },
                },
              };
            });
          });
      },
      projectCwd: initialUiResumeState?.projectCwd ?? null,
      projectTreeCwd: null,
      projectTree: null,
      projectTreeCollapsed: initialUiResumeState?.projectTreeCollapsed ?? false,
      projectPanelView: normalizeProjectPanelView(initialUiResumeState?.projectPanelView),
      terminalDrawerOpen: resolveInitialTerminalDrawerOpen(initialUiResumeState),
      terminalDrawerHeight: sanitizeTerminalDrawerHeight(initialUiResumeState?.terminalDrawerHeight),
      browserPanelOpen: false,
      browserPanelWidth: 480,
      rightPanelFullscreen: null,
      sessionsLoaded: false,
      // 搜索状态
      sidebarSearchQuery: '',
      activeFilters: { timeRange: 'all' },
      inSessionSearchOpen: false,
      inSessionSearchQuery: '',
      inSessionSearchResults: [],
      inSessionSearchCurrentIndex: 0,
      searchPaletteOpen: false,
      historyNavigationTarget: null,
      // MCP 状态
      mcpServers: {},
      mcpGlobalServers: {},
      mcpProjectServers: {},
      mcpCodexGlobalServers: {},
      mcpServerStatus: [],
      claudeUserSkills: [],
      claudeProjectSkills: [],
      claudeSkillsUserRoot: '',
      claudeSkillsProjectRoot: undefined,
      // Settings 状态
      showSettings: false,
      activeSettingsTab: 'general' as SettingsTab,
      updateStatus: {
        available: false,
        version: null,
        autoDetected: false,
      },
      promptLibraryInsertRequest: null,
      pendingChatInjection: null,
      // 状态配置
      statusConfigs: [],
      statusFilter: 'all',
      // 文件夹
      folderConfigs: [],
      // 主题
      theme: 'system' as const,
      themeState: DEFAULT_THEME_STATE,
      uiFontFamily: '',
      chatCodeFontFamily: '',

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
        handleStreamMessage(event.payload, set, get);
        break;

      case 'permission.request':
        handlePermissionRequest(event.payload, set);
        break;

      case 'runner.error':
        set({ globalError: event.payload.message, pendingStart: false, pendingDraftSessionId: null });
        break;

      case 'project.tree':
        set({
          projectTreeCwd: event.payload.cwd,
          projectTree: event.payload.tree,
        });
        break;

      case 'app.update':
        set({
          updateStatus: {
            available: event.payload.available,
            version: event.payload.version || null,
            autoDetected: event.payload.autoDetected,
          },
        });
        break;

      case 'mcp.config':
        set({
          mcpServers: event.payload.servers,
          mcpGlobalServers: event.payload.globalServers || event.payload.servers,
          mcpProjectServers: event.payload.projectServers || {},
          mcpCodexGlobalServers: event.payload.codexGlobalServers || {},
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
      if (state.chatLayoutMode === 'single') {
        if (!sessionId) {
          return {
            activeSessionId: null,
            activeWorkspace: 'chat',
          };
        }

        const session = state.sessions[sessionId];
        if (!session) {
          return {
            activeSessionId: sessionId,
            activeWorkspace: 'chat',
          };
        }

        return {
          activeSessionId: sessionId,
          activeWorkspace: 'chat',
          showNewSession: false,
        };
      }

      const nextPaneId = state.activePaneId;
      const nextPanes = {
        ...state.chatPanes,
        [nextPaneId]: {
          ...state.chatPanes[nextPaneId],
          sessionId,
          surface: 'chat',
        },
      };

      if (!sessionId) {
        return {
          activeSessionId: null,
          chatPanes: nextPanes,
        };
      }

      const session = state.sessions[sessionId];
      if (!session) {
        return {
          activeSessionId: sessionId,
          chatPanes: nextPanes,
        };
      }

      return {
        activeSessionId: sessionId,
        chatPanes: nextPanes,
        activeWorkspace: 'chat',
        showNewSession: false,
      };
    });

    persistUiResumeStateSnapshot(get());

    if (sessionId && get().sessions[sessionId]?.runtimeNotice) {
      scheduleRuntimeNoticeClear(sessionId, set);
    }
  },

  setActiveWorkspace: (activeWorkspace) =>
    set((state) => {
      const visibleSessionIds = Object.values(state.sessions)
        .filter((session) => !session.hiddenFromThreads)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((session) => session.id);
      const nextActiveSessionId =
        state.activeSessionId && state.sessions[state.activeSessionId] && !state.sessions[state.activeSessionId].hiddenFromThreads
          ? state.activeSessionId
          : visibleSessionIds[0] || null;

      return {
        activeWorkspace,
        activeSessionId: nextActiveSessionId,
        chatPanes: {
          ...state.chatPanes,
        [state.activePaneId]: {
          ...state.chatPanes[state.activePaneId],
          sessionId: nextActiveSessionId,
          surface: 'chat',
        },
      },
      };
    }),

  setChatSidebarView: (chatSidebarView) => set({ chatSidebarView }),

  setActivePane: (activePaneId) =>
    {
      set((state) => ({
        activePaneId,
        activeSessionId: state.chatPanes[activePaneId].sessionId,
        activeWorkspace: 'chat',
        showNewSession: state.chatPanes[activePaneId].sessionId === null,
      }));
      persistUiResumeStateSnapshot(get());
    },

  setChatLayoutMode: (chatLayoutMode) => {
    set({ chatLayoutMode });
    persistUiResumeStateSnapshot(get());
  },

  setSavedSplitVisible: (savedSplitVisible) => {
    set({ savedSplitVisible });
    persistUiResumeStateSnapshot(get());
  },

  setChatPaneSession: (paneId, sessionId) => {
    set((state) => ({
      chatPanes: {
        ...state.chatPanes,
        [paneId]: {
          ...state.chatPanes[paneId],
          sessionId,
          surface: 'chat',
        },
      },
      activePaneId: paneId,
      activeSessionId: sessionId,
      activeWorkspace: 'chat',
      showNewSession: sessionId === null,
    }));
    persistUiResumeStateSnapshot(get());
  },

  setChatPaneSurface: (paneId, surface) => {
    set((state) => {
      const pane = state.chatPanes[paneId];
      return {
        chatPanes: {
          ...state.chatPanes,
          [paneId]: {
            ...pane,
            surface,
          },
        },
        activePaneId: paneId,
        activeSessionId: pane.sessionId,
        activeWorkspace: 'chat',
        showNewSession: surface === 'chat' && pane.sessionId === null,
      };
    });
    persistUiResumeStateSnapshot(get());
  },

  setChatSplitRatio: (chatSplitRatio) => {
    set({ chatSplitRatio: sanitizeChatSplitRatio(chatSplitRatio) });
    persistUiResumeStateSnapshot(get());
  },

  openSplitChat: (paneId, sessionId) => {
    set((state) => ({
      chatLayoutMode: 'split',
      savedSplitVisible: true,
      activePaneId: paneId,
      activeSessionId: sessionId,
      activeWorkspace: 'chat',
      showNewSession: false,
      chatPanes: {
        ...state.chatPanes,
        [paneId]: {
          ...state.chatPanes[paneId],
          sessionId,
          surface: 'chat',
        },
      },
    }));
    persistUiResumeStateSnapshot(get());
  },

  closeSplitChat: () => {
    set((state) => {
      const focusedSessionId =
        state.chatPanes[state.activePaneId].sessionId ??
        state.chatPanes.primary.sessionId ??
        state.chatPanes.secondary.sessionId ??
        state.activeSessionId;
      return {
        chatLayoutMode: 'single',
        savedSplitVisible: false,
        activePaneId: 'primary',
        activeSessionId: focusedSessionId,
        showNewSession: focusedSessionId === null,
      };
    });
    persistUiResumeStateSnapshot(get());
  },

  swapChatPanes: () => {
    set((state) => {
      if (state.chatLayoutMode !== 'split') {
        return state;
      }

      const nextActivePaneId = state.activePaneId === 'primary' ? 'secondary' : 'primary';
      return {
        chatPanes: {
          primary: {
            ...state.chatPanes.secondary,
            id: 'primary',
          },
          secondary: {
            ...state.chatPanes.primary,
            id: 'secondary',
          },
        },
        activePaneId: nextActivePaneId,
        activeSessionId: state.chatPanes[nextActivePaneId].sessionId,
      };
    });
    persistUiResumeStateSnapshot(get());
  },

  setShowNewSession: (show) => {
    set((state) => ({
      showNewSession: show,
      activeWorkspace: 'chat',
      newSessionKey: show ? state.newSessionKey + 1 : state.newSessionKey,
      chatPanes: show
        ? {
            ...state.chatPanes,
            [state.activePaneId]: {
              ...state.chatPanes[state.activePaneId],
              sessionId: null,
            },
          }
        : state.chatPanes,
      activeSessionId: show ? null : state.activeSessionId,
    }));
    persistUiResumeStateSnapshot(get());
  },

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setSidebarWidth: (width) => set((state) => ({
    sidebarWidth: sanitizeSidebarWidth(width, state.sidebarWidth),
  })),

  setProjectCwd: (cwd) => {
    set({ projectCwd: cwd });
    persistUiResumeStateSnapshot(get());
  },

  setProjectTree: (cwd, tree) => set({ projectTreeCwd: cwd, projectTree: tree }),

  setProjectTreeCollapsed: (collapsed) => {
    set((state) => ({
      projectTreeCollapsed: collapsed,
      rightPanelFullscreen:
        collapsed && state.rightPanelFullscreen === 'files' ? null : state.rightPanelFullscreen,
    }));
    persistUiResumeStateSnapshot(get());
  },

  setProjectPanelView: (projectPanelView) => {
    set({ projectPanelView });
    persistUiResumeStateSnapshot(get());
  },

  setTerminalDrawerOpen: (terminalDrawerOpen) => {
    set({ terminalDrawerOpen });
    persistUiResumeStateSnapshot(get());
  },

  setTerminalDrawerHeight: (terminalDrawerHeight) => {
    set({ terminalDrawerHeight: sanitizeTerminalDrawerHeight(terminalDrawerHeight) });
    persistUiResumeStateSnapshot(get());
  },

  setBrowserPanelOpen: (browserPanelOpen) => {
    set((state) => ({
      browserPanelOpen,
      rightPanelFullscreen:
        !browserPanelOpen && state.rightPanelFullscreen === 'browser'
          ? null
          : state.rightPanelFullscreen,
    }));
  },

  setBrowserPanelWidth: (width) => {
    const clamped = Math.min(960, Math.max(360, Math.round(width)));
    set({ browserPanelWidth: clamped });
  },

  setRightPanelFullscreen: (target) => {
    if (target === 'browser') {
      set({
        rightPanelFullscreen: 'browser',
        browserPanelOpen: true,
        projectTreeCollapsed: true,
      });
      return;
    }
    if (target === 'files') {
      set({
        rightPanelFullscreen: 'files',
        projectTreeCollapsed: false,
        browserPanelOpen: false,
      });
      return;
    }
    set({ rightPanelFullscreen: null });
  },

  applyUiResumeState: (resumeState) =>
    set((state) => {
      if (!resumeState) {
        return { sessionsLoaded: false };
      }

      const chatLayoutMode = normalizeChatLayoutMode(resumeState.chatLayoutMode);
      const savedSplitVisible = resumeState.savedSplitVisible ?? state.savedSplitVisible;
      const activePaneId = normalizeActivePaneId(resumeState.activePaneId);
      const chatPanes = normalizeChatPanes(resumeState.chatPanes, resumeState.activeSessionId);
      const activeSessionId = chatPanes[activePaneId].sessionId ?? resumeState.activeSessionId;

      return {
        activeSessionId,
        showNewSession: resumeState.showNewSession,
        projectCwd: resumeState.projectCwd ?? null,
        projectTreeCollapsed: resumeState.projectTreeCollapsed,
        projectPanelView: normalizeProjectPanelView(resumeState.projectPanelView),
        terminalDrawerOpen: resolveInitialTerminalDrawerOpen(resumeState),
        terminalDrawerHeight: sanitizeTerminalDrawerHeight(resumeState.terminalDrawerHeight),
        chatLayoutMode,
        savedSplitVisible,
        activePaneId,
        chatPanes,
        chatSplitRatio: sanitizeChatSplitRatio(resumeState.chatSplitRatio, state.chatSplitRatio),
        activeWorkspace: 'chat',
        sessionsLoaded: false,
      };
    }),


  clearGlobalError: () => set({ globalError: null }),

  setPendingStart: (pending) => set({ pendingStart: pending }),

  createDraftSession: (cwd) => {
    const draft = createDraftSessionView(cwd ?? get().projectCwd);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [draft.id]: draft,
      },
      activeSessionId: draft.id,
      chatPanes: {
        ...state.chatPanes,
        [state.activePaneId]: {
          ...state.chatPanes[state.activePaneId],
          sessionId: draft.id,
          surface: 'chat',
        },
      },
      activeWorkspace: 'chat',
      showNewSession: false,
    }));
    persistUiResumeStateSnapshot(get());
    return draft.id;
  },

  removeDraftSession: (sessionId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session?.isDraft) {
        return state;
      }

      const { [sessionId]: removed, ...rest } = state.sessions;
      const visibleSessionIds = Object.values(rest)
        .filter((item) => !item.hiddenFromThreads)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((item) => item.id);
      const nextActiveSessionId =
        state.activeSessionId === sessionId ? visibleSessionIds[0] || null : state.activeSessionId;
      const nextPanes = {
        primary: {
          id: 'primary' as const,
          sessionId: state.chatPanes.primary.sessionId === sessionId ? (nextActiveSessionId ?? null) : state.chatPanes.primary.sessionId,
          surface: 'chat',
        },
        secondary: {
          id: 'secondary' as const,
          sessionId: state.chatPanes.secondary.sessionId === sessionId ? null : state.chatPanes.secondary.sessionId,
          surface: 'chat',
        },
      };

      return {
        ...state,
        sessions: rest,
        activeSessionId: nextActiveSessionId,
        chatPanes: nextPanes,
        chatLayoutMode:
          state.chatLayoutMode === 'split' && !nextPanes.secondary.sessionId ? 'single' : state.chatLayoutMode,
        activePaneId:
          state.chatLayoutMode === 'split' && !nextPanes.secondary.sessionId ? 'primary' : state.activePaneId,
        showNewSession: nextActiveSessionId === null,
        pendingDraftSessionId:
          state.pendingDraftSessionId === sessionId ? null : state.pendingDraftSessionId,
      };
    });
    persistUiResumeStateSnapshot(get());
  },

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

  setSearchPaletteOpen: (open) => set({ searchPaletteOpen: open }),

  toggleSearchPalette: () =>
    set((state) => ({ searchPaletteOpen: !state.searchPaletteOpen })),

  setHistoryNavigationTarget: (historyNavigationTarget) => set({ historyNavigationTarget }),

  // MCP Actions
  setMcpServers: (servers) => set({ mcpServers: servers }),
  setMcpServerStatus: (status) => set({ mcpServerStatus: status }),
  // Settings Actions
  setShowSettings: (show) => set({ showSettings: show }),
  setActiveSettingsTab: (tab) => set({ activeSettingsTab: tab }),
  requestPromptLibraryInsert: (content, mode: PromptLibraryInsertMode = 'append') =>
    set({
      promptLibraryInsertRequest: {
        content,
        mode,
        nonce: Date.now(),
      },
    }),
  consumePromptLibraryInsert: (nonce) =>
    set((state) => {
      if (!state.promptLibraryInsertRequest || state.promptLibraryInsertRequest.nonce !== nonce) {
        return state;
      }

      return { promptLibraryInsertRequest: null };
    }),

  requestChatInjection: (request) =>
    set({
      pendingChatInjection: {
        sessionId: request.sessionId ?? null,
        text: request.text,
        attachments: request.attachments,
        mode: request.mode ?? 'append',
        source: request.source,
        nonce: Date.now(),
      },
    }),

  consumeChatInjection: (nonce) =>
    set((state) => {
      if (!state.pendingChatInjection || state.pendingChatInjection.nonce !== nonce) {
        return state;
      }
      return { pendingChatInjection: null };
    }),

  // 状态配置 Actions
  setStatusConfigs: (configs) => set({ statusConfigs: configs }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),

  // 文件夹 Actions
  setFolderConfigs: (configs) => set({ folderConfigs: configs }),

  // 主题
  setTheme: (theme) => {
    set({ theme });
    const { themeState, uiFontFamily, chatCodeFontFamily } = get();
    applyAppearance({ theme, themeState, uiFontFamily, chatCodeFontFamily });
  },

  setThemeState: (themeState) => {
    const normalized = normalizeThemeState(themeState);
    set({ themeState: normalized });
    const { theme, uiFontFamily, chatCodeFontFamily } = get();
    applyAppearance({ theme, themeState: normalized, uiFontFamily, chatCodeFontFamily });
  },

  updateThemeVariant: (variant, patch) => {
    const nextThemeState = updateThemePack(get().themeState, variant, patch);
    set({ themeState: nextThemeState });
    const { theme, uiFontFamily, chatCodeFontFamily } = get();
    applyAppearance({ theme, themeState: nextThemeState, uiFontFamily, chatCodeFontFamily });
  },

  setThemeVariantCodeThemeId: (variant, codeThemeId) => {
    const nextThemeState = setThemeCodeThemeId(get().themeState, variant, codeThemeId);
    set({ themeState: nextThemeState });
    const { theme, uiFontFamily, chatCodeFontFamily } = get();
    applyAppearance({ theme, themeState: nextThemeState, uiFontFamily, chatCodeFontFamily });
  },

  setThemeVariantFonts: (variant, patch) => {
    const nextThemeState = setThemePackFonts(get().themeState, variant, patch);
    set({ themeState: nextThemeState });
    const { theme, uiFontFamily, chatCodeFontFamily } = get();
    applyAppearance({ theme, themeState: nextThemeState, uiFontFamily, chatCodeFontFamily });
  },

  resetThemeVariant: (variant) => {
    const nextThemeState = resetThemeVariantState(get().themeState, variant);
    set({ themeState: nextThemeState });
    const { theme, uiFontFamily, chatCodeFontFamily } = get();
    applyAppearance({ theme, themeState: nextThemeState, uiFontFamily, chatCodeFontFamily });
  },

  setUiFontFamily: (uiFontFamily) => {
    set({ uiFontFamily });
    const { theme, themeState, chatCodeFontFamily } = get();
    applyAppearance({ theme, themeState, uiFontFamily, chatCodeFontFamily });
  },

  setChatCodeFontFamily: (chatCodeFontFamily) => {
    set({ chatCodeFontFamily });
    const { theme, themeState, uiFontFamily } = get();
    applyAppearance({ theme, themeState, uiFontFamily, chatCodeFontFamily });
  },
    }),
    {
      name: 'cowork-app-storage',
      partialize: (state) => ({
        activeWorkspace: state.activeWorkspace,
        chatSidebarView: state.chatSidebarView,
        chatLayoutMode: state.chatLayoutMode,
        savedSplitVisible: state.savedSplitVisible,
        activePaneId: state.activePaneId,
        chatPanes: state.chatPanes,
        chatSplitRatio: state.chatSplitRatio,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        projectTreeCollapsed: state.projectTreeCollapsed,
        projectPanelView: state.projectPanelView,
        terminalDrawerOpen: state.terminalDrawerOpen,
        terminalDrawerHeight: state.terminalDrawerHeight,
        theme: state.theme,
        themeState: state.themeState,
        uiFontFamily: state.uiFontFamily,
        chatCodeFontFamily: state.chatCodeFontFamily,
        draftSessions: Object.fromEntries(
          Object.entries(state.sessions).filter(([, session]) => session.isDraft)
        ),
      }),
      merge: (persistedState: unknown, currentState: Store) => {
        const persisted = persistedState as {
          activeWorkspace?: ActiveWorkspace;
          chatSidebarView?: ChatSidebarView;
          chatLayoutMode?: ChatLayoutMode;
          savedSplitVisible?: boolean;
          activePaneId?: ChatPaneId;
          chatPanes?: Record<ChatPaneId, ChatPaneState>;
          chatSplitRatio?: number;
          sidebarCollapsed?: boolean;
          sidebarWidth?: number;
          projectTreeCollapsed?: boolean;
          projectPanelView?: import('../types').ProjectPanelView;
          terminalDrawerOpen?: boolean;
          terminalDrawerHeight?: number;
          theme?: Theme;
          themeState?: ThemeState;
          uiFontFamily?: string;
          chatCodeFontFamily?: string;
          draftSessions?: Record<string, SessionView>;
        } | undefined;
        const theme = persisted?.theme || currentState.theme;
        const themeState = normalizeThemeState(persisted?.themeState || currentState.themeState);
        const uiFontFamily = persisted?.uiFontFamily ?? currentState.uiFontFamily;
        const chatCodeFontFamily = persisted?.chatCodeFontFamily ?? currentState.chatCodeFontFamily;
        const chatLayoutMode = normalizeChatLayoutMode(persisted?.chatLayoutMode);
        const savedSplitVisible = persisted?.savedSplitVisible ?? currentState.savedSplitVisible;
        const activePaneId = normalizeActivePaneId(persisted?.activePaneId);
        const chatPanes = normalizeChatPanes(
          persisted?.chatPanes as import('../shared/types').UiResumeState['chatPanes'],
          currentState.activeSessionId
        );
        const draftSessions = Object.fromEntries(
          Object.entries(persisted?.draftSessions || {}).filter(([, session]) => session?.isDraft)
        ) as Record<string, SessionView>;
        applyAppearance({
          theme,
          themeState,
          uiFontFamily,
          chatCodeFontFamily,
        });
        const sidebarView =
          persisted?.chatSidebarView === 'prompts' ||
          persisted?.activeWorkspace === 'prompts'
            ? 'prompts'
            : persisted?.chatSidebarView === 'skills' ||
                persisted?.activeWorkspace === 'skills'
              ? 'skills'
              : 'threads';

        return {
          ...currentState,
          sessions: {
            ...currentState.sessions,
            ...draftSessions,
          },
          activeWorkspace: 'chat',
          chatSidebarView: sidebarView,
          chatLayoutMode,
          savedSplitVisible,
          activePaneId,
          chatPanes,
          chatSplitRatio: sanitizeChatSplitRatio(persisted?.chatSplitRatio, currentState.chatSplitRatio),
          sidebarCollapsed: persisted?.sidebarCollapsed ?? currentState.sidebarCollapsed,
          sidebarWidth: sanitizeSidebarWidth(persisted?.sidebarWidth, currentState.sidebarWidth),
          projectTreeCollapsed: persisted?.projectTreeCollapsed ?? currentState.projectTreeCollapsed,
          projectPanelView: normalizeProjectPanelView(
            (persisted?.projectPanelView as import('../types').ProjectPanelView | 'git' | undefined) ||
              currentState.projectPanelView
          ),
          terminalDrawerOpen: persisted?.terminalDrawerOpen ?? currentState.terminalDrawerOpen,
          terminalDrawerHeight: sanitizeTerminalDrawerHeight(
            persisted?.terminalDrawerHeight,
            currentState.terminalDrawerHeight
          ),
          theme,
          themeState,
          uiFontFamily,
          chatCodeFontFamily,
        };
      },
    }
  )
);

// 监听系统主题变化
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { theme, themeState, uiFontFamily, chatCodeFontFamily } = useAppStore.getState();
    if (theme === 'system') {
      applyAppearance({
        theme: 'system',
        themeState,
        uiFontFamily,
        chatCodeFontFamily,
      });
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
      source: session.source || 'aegis',
      readOnly: session.readOnly === true,
      cwd: session.cwd,
      claudeSessionId: session.claudeSessionId,
      provider: session.provider || 'claude',
      model: session.model,
      compatibleProviderId: session.compatibleProviderId,
      betas: session.betas,
      claudeAccessMode: normalizeClaudeAccessMode(session.claudeAccessMode),
      claudeExecutionMode: normalizeClaudeExecutionMode(session.claudeExecutionMode),
      codexPermissionMode: session.codexPermissionMode,
      codexReasoningEffort: session.codexReasoningEffort,
      codexFastMode: session.codexFastMode,
      opencodePermissionMode: session.opencodePermissionMode,
      todoState: session.todoState || 'todo',
      pinned: session.pinned || false,
      folderPath: session.folderPath || null,
      hiddenFromThreads: session.hiddenFromThreads === true,
      latestClaudeModelUsage: session.latestClaudeModelUsage,
      messages: existing?.messages || [],
      hydrated: existing?.hydrated || false,
      historyCursor: existing?.historyCursor ?? null,
      hasMoreHistory: existing?.hasMoreHistory ?? false,
      loadingMoreHistory: false,
      permissionRequests: existing?.permissionRequests || [],
      streaming: existing?.streaming || createEmptyStreamingState(),
      runtimeNotice: existing?.runtimeNotice,
      updatedAt: session.updatedAt,
    };
  }

  for (const existing of Object.values(get().sessions)) {
    if ((existing.hiddenFromThreads || existing.isDraft) && !sessionsMap[existing.id]) {
      sessionsMap[existing.id] = existing;
    }
  }

  const visibleSessionIds = Object.values(sessionsMap)
    .filter((session) => !session.hiddenFromThreads)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((session) => session.id);
  const hasVisibleSessions = visibleSessionIds.length > 0;

  // 如果当前 UI 明确恢复到新建页，则不要在会话列表返回时把它覆盖回旧会话
  const showNewSession = get().showNewSession && !hasVisibleSessions;

  const keepNewSessionOpen = get().showNewSession;
  const currentPanes = get().chatPanes;

  // 默认选中最新更新的会话，但如果当前明确停留在 New Thread，就不要偷偷回填旧会话
  let activeSessionId = keepNewSessionOpen ? null : get().activeSessionId;
  if (
    !keepNewSessionOpen &&
    hasVisibleSessions &&
    (!activeSessionId || !sessionsMap[activeSessionId] || sessionsMap[activeSessionId].hiddenFromThreads)
  ) {
    activeSessionId = visibleSessionIds[0] || null;
  }

  const normalizePaneSessionId = (sessionId: string | null): string | null => {
    if (!sessionId) {
      return null;
    }

    return sessionsMap[sessionId] && !sessionsMap[sessionId].hiddenFromThreads ? sessionId : null;
  };

  const nextPanes: Record<ChatPaneId, ChatPaneState> = {
    primary: {
      id: 'primary',
      sessionId:
        normalizePaneSessionId(currentPanes.primary.sessionId) ??
        activeSessionId,
      surface: 'chat',
    },
    secondary: {
      id: 'secondary',
      sessionId: normalizePaneSessionId(currentPanes.secondary.sessionId),
      surface: 'chat',
    },
  };

  set({
    sessions: sessionsMap,
    showNewSession,
    activeSessionId,
    chatPanes: nextPanes,
    chatLayoutMode:
      get().chatLayoutMode === 'split' && nextPanes.secondary.sessionId ? 'split' : 'single',
    activePaneId:
      get().chatLayoutMode === 'split' && nextPanes.secondary.sessionId
        ? get().activePaneId
        : 'primary',
    sessionsLoaded: true,
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
    compatibleProviderId?: SessionInfo['compatibleProviderId'];
    betas?: SessionInfo['betas'];
    claudeAccessMode?: SessionInfo['claudeAccessMode'];
    claudeExecutionMode?: SessionInfo['claudeExecutionMode'];
    codexPermissionMode?: SessionInfo['codexPermissionMode'];
    codexReasoningEffort?: SessionInfo['codexReasoningEffort'];
    codexFastMode?: SessionInfo['codexFastMode'];
    opencodePermissionMode?: SessionInfo['opencodePermissionMode'];
    todoState?: SessionInfo['todoState'];
    hiddenFromThreads?: boolean;
  },
  set: SetState,
  get: () => Store
) {
  const {
    sessionId,
    status,
    title,
    cwd,
    provider,
    model,
    compatibleProviderId,
    betas,
    claudeAccessMode,
    claudeExecutionMode,
    codexPermissionMode,
    codexReasoningEffort,
    codexFastMode,
    opencodePermissionMode,
    todoState,
    hiddenFromThreads,
  } = payload;
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
          compatibleProviderId:
            compatibleProviderId !== undefined ? compatibleProviderId || undefined : session.compatibleProviderId,
          betas: betas !== undefined ? betas : session.betas,
          claudeAccessMode:
            claudeAccessMode !== undefined
              ? normalizeClaudeAccessMode(claudeAccessMode)
              : normalizeClaudeAccessMode(session.claudeAccessMode),
          claudeExecutionMode:
            claudeExecutionMode !== undefined
              ? normalizeClaudeExecutionMode(claudeExecutionMode)
              : normalizeClaudeExecutionMode(session.claudeExecutionMode),
          codexPermissionMode:
            codexPermissionMode !== undefined ? codexPermissionMode : session.codexPermissionMode,
          codexReasoningEffort:
            codexReasoningEffort !== undefined
              ? codexReasoningEffort
              : session.codexReasoningEffort,
          codexFastMode:
            codexFastMode !== undefined ? codexFastMode : session.codexFastMode,
          opencodePermissionMode:
            opencodePermissionMode !== undefined
              ? opencodePermissionMode
              : session.opencodePermissionMode,
          todoState: todoState !== undefined ? todoState : session.todoState,
          hiddenFromThreads:
            hiddenFromThreads !== undefined ? hiddenFromThreads : session.hiddenFromThreads,
          latestClaudeModelUsage: session.latestClaudeModelUsage,
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
    const pendingDraftSessionId = state.pendingDraftSessionId;
    const nextSessions = { ...state.sessions };
    if (pendingDraftSessionId && nextSessions[pendingDraftSessionId]?.isDraft) {
      delete nextSessions[pendingDraftSessionId];
    }

    // 新建会话（来自 session.start）
    const newSession: SessionView = {
      id: sessionId,
      title: title || 'New Session',
      status,
      source: 'aegis',
      readOnly: false,
      cwd,
      provider: provider || 'claude',
      model,
      compatibleProviderId,
      betas,
      claudeAccessMode: normalizeClaudeAccessMode(claudeAccessMode),
      claudeExecutionMode: normalizeClaudeExecutionMode(claudeExecutionMode),
      codexPermissionMode,
      codexReasoningEffort,
      codexFastMode,
      opencodePermissionMode,
      todoState: todoState || 'todo',
      hiddenFromThreads: hiddenFromThreads === true,
      latestClaudeModelUsage: undefined,
      messages: [],
      hydrated: true, // 新会话不需要 hydration
      historyCursor: null,
      hasMoreHistory: false,
      loadingMoreHistory: false,
      permissionRequests: [],
      streaming: createEmptyStreamingState(),
      runtimeNotice: undefined,
      updatedAt: Date.now(),
    };

    const shouldFocusNewSession = state.activeWorkspace === 'chat' && hiddenFromThreads !== true;

    set({
      sessions: {
        ...nextSessions,
        [sessionId]: newSession,
      },
      activeSessionId: shouldFocusNewSession ? sessionId : state.activeSessionId,
      chatPanes: shouldFocusNewSession
        ? {
            ...state.chatPanes,
            [state.activePaneId]: {
              ...state.chatPanes[state.activePaneId],
              sessionId,
            },
          }
        : state.chatPanes,
      showNewSession: false,
      pendingStart: false,
      pendingDraftSessionId: null,
    });
  }
}

// 处理会话历史
function handleSessionHistory(
  payload: {
    sessionId: string;
    status: SessionInfo['status'];
    messages: StreamMessage[];
    cursor?: string | null;
    hasMore?: boolean;
  },
  set: SetState
) {
  const { sessionId, status, messages, cursor, hasMore } = payload;
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
          latestClaudeModelUsage: extractLatestClaudeModelUsage(sanitizedMessages, session.model),
          hydrated: true,
          historyCursor: cursor ?? null,
          hasMoreHistory: hasMore === true,
          loadingMoreHistory: false,
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

  const nextPanes: Record<ChatPaneId, ChatPaneState> = {
    primary: {
      id: 'primary',
      sessionId: state.chatPanes.primary.sessionId === sessionId ? (newActiveId ?? null) : state.chatPanes.primary.sessionId,
      surface: 'chat',
    },
    secondary: {
      id: 'secondary',
      sessionId: state.chatPanes.secondary.sessionId === sessionId ? null : state.chatPanes.secondary.sessionId,
      surface: 'chat',
    },
  };

  set({
    sessions: rest,
    activeSessionId: newActiveId,
    chatPanes: nextPanes,
    chatLayoutMode: state.chatLayoutMode === 'split' && nextPanes.secondary.sessionId ? 'split' : 'single',
    activePaneId: state.chatLayoutMode === 'split' && nextPanes.secondary.sessionId ? state.activePaneId : 'primary',
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
  set: SetState,
  get: () => Store
) {
  const { sessionId, message } = payload;
  const session = get().sessions[sessionId];
  const activeSessionId = get().activeSessionId;

  if (
    message.type === 'system' &&
    message.subtype === 'compact_boundary' &&
    session?.provider === 'claude' &&
    activeSessionId === sessionId &&
    message.compactMetadata.trigger === 'auto'
  ) {
    toast.success('Claude auto-compacted the conversation context.');
  }

  set((state) => {
    const currentSession = state.sessions[sessionId];
    if (!currentSession) return state;

    if (message.type === 'stream_event') {
      const event = message.event;
      const currentStreaming = currentSession.streaming || createEmptyStreamingState();

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
              ...currentSession,
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
              ...currentSession,
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
              ...currentSession,
              streaming: createEmptyStreamingState(),
            },
          },
        };
      }

      return state;
    }

    const incomingCreatedAt = (message as { createdAt?: unknown }).createdAt;
    const stampedMessage: StreamMessage =
      typeof incomingCreatedAt === 'number' && Number.isFinite(incomingCreatedAt)
        ? message
        : ({ ...(message as object), createdAt: Date.now() } as StreamMessage);

    // Claude Agent SDK may emit partial updates for the same message UUID.
    // Replace existing messages instead of appending duplicates.
    const maybeUuid = (stampedMessage as { uuid?: unknown }).uuid;
    if (typeof maybeUuid === 'string' && maybeUuid.length > 0) {
      const existingIndex = currentSession.messages.findIndex(
        (m) => (m as { uuid?: unknown }).uuid === maybeUuid
      );
      if (existingIndex >= 0) {
        const existingMessage = currentSession.messages[existingIndex];
        const existing = existingMessage as { createdAt?: number };
        const mergedMessage: StreamMessage =
          currentSession.provider === 'codex' &&
          existingMessage &&
          isAssistantStreamMessage(existingMessage) &&
          isAssistantStreamMessage(stampedMessage)
            ? mergeCodexAssistantMessage(existingMessage, stampedMessage)
            : typeof existing.createdAt === 'number' && Number.isFinite(existing.createdAt)
              ? ({ ...(stampedMessage as object), createdAt: existing.createdAt } as StreamMessage)
              : stampedMessage;
        const nextMessages = currentSession.messages.slice();
        nextMessages[existingIndex] = mergedMessage;
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...currentSession,
              latestClaudeModelUsage:
                mergedMessage.type === 'result' && currentSession.provider === 'claude' && mergedMessage.modelUsage
                  ? extractLatestClaudeModelUsage([mergedMessage], currentSession.model) || currentSession.latestClaudeModelUsage
                  : currentSession.latestClaudeModelUsage,
              messages: nextMessages,
              streaming: shouldPreserveStreamingStateForMessage(currentSession.provider, mergedMessage)
                ? currentSession.streaming
                : createEmptyStreamingState(),
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
          ...currentSession,
          latestClaudeModelUsage:
            stampedMessage.type === 'result' && currentSession.provider === 'claude' && stampedMessage.modelUsage
              ? extractLatestClaudeModelUsage([stampedMessage], currentSession.model) || currentSession.latestClaudeModelUsage
              : currentSession.latestClaudeModelUsage,
          messages: [...currentSession.messages, stampedMessage],
          streaming: shouldPreserveStreamingStateForMessage(currentSession.provider, stampedMessage)
            ? currentSession.streaming
            : createEmptyStreamingState(),
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
