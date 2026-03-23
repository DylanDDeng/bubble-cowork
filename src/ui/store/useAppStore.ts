import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { toast } from 'sonner';
import type {
  ActiveWorkspace,
  AppState,
  AppActions,
  ChatSidebarView,
  PodcastAudioFormat,
  PodcastConfigView,
  PodcastDraftView,
  PodcastTranscriptSource,
  PodcastSourceView,
  PodcastTtsProvider,
  PodcastTtsVoice,
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
  FontSettingsPayload,
  PromptLibraryInsertMode,
} from '../types';
import { DEFAULT_COLOR_THEME_ID, applyThemePreferences } from '../theme/themes';
import { applyFontPreferences, getDefaultFontSelections } from '../theme/fonts';

function applyAppearance({
  theme,
  colorThemeId,
  customThemeCss,
  fontSelections,
  importedFonts,
}: {
  theme: Theme;
  colorThemeId: ColorThemeId;
  customThemeCss: string;
  fontSelections: FontSettingsPayload['selections'];
  importedFonts: FontSettingsPayload['importedFonts'];
}) {
  applyThemePreferences({ themeMode: theme, colorThemeId, customThemeCss });
  applyFontPreferences({ fontSelections, importedFonts });
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

function createDefaultPodcastConfig(): PodcastConfigView {
  return {
    pacing: 'balanced',
    style: 'conversational',
    tone: 'professional',
    structure: 'duo',
    duration: '10m',
    voice: 'warm',
    ttsProvider: 'minimax',
    ttsVoice: 'male-qn-jingying',
    ttsHostBVoice: 'female-yujie',
    ttsDelivery: 'natural',
    ttsSpeed: 1,
    ttsVolume: 1,
    ttsPitch: 0,
    audioFormat: 'mp3',
  };
}

function getDefaultPodcastTtsVoice(provider: PodcastTtsProvider): PodcastTtsVoice {
  switch (provider) {
    case 'minimax':
      return 'male-qn-jingying';
    case 'elevenlabs':
      return 'rachel';
    case 'cartesia':
      return 'sonic';
    case 'openai':
    default:
      return 'alloy';
  }
}

function normalizePodcastAudioFormat(value: unknown): PodcastAudioFormat {
  return 'mp3';
}

function normalizePodcastTtsProvider(value: unknown): PodcastTtsProvider {
  return value === 'minimax' ? 'minimax' : 'minimax';
}

function clampPodcastNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function normalizePodcastStyle(value: unknown): PodcastConfigView['style'] {
  return value === 'deep_dive' ||
    value === 'news_brief' ||
    value === 'storytelling' ||
    value === 'debate' ||
    value === 'xiangsheng'
    ? value
    : 'conversational';
}

function normalizePodcastConfig(config?: Partial<PodcastConfigView> | null): PodcastConfigView {
  const defaults = createDefaultPodcastConfig();
  const merged = {
    ...defaults,
    ...(config || {}),
  };
  const normalizedProvider = normalizePodcastTtsProvider(merged.ttsProvider);

  return {
    ...merged,
    structure: 'duo',
    style: normalizePodcastStyle(merged.style),
    ttsProvider: normalizedProvider,
    ttsVoice:
      typeof merged.ttsVoice === 'string' && merged.ttsVoice.trim()
        ? merged.ttsVoice
        : getDefaultPodcastTtsVoice(normalizedProvider),
    ttsHostBVoice:
      typeof merged.ttsHostBVoice === 'string' && merged.ttsHostBVoice.trim()
        ? merged.ttsHostBVoice
        : defaults.ttsHostBVoice,
    ttsSpeed: clampPodcastNumber(merged.ttsSpeed, defaults.ttsSpeed, 0.5, 2),
    ttsVolume: clampPodcastNumber(merged.ttsVolume, defaults.ttsVolume, 0.1, 10),
    ttsPitch: clampPodcastNumber(merged.ttsPitch, defaults.ttsPitch, -12, 12),
    audioFormat: normalizePodcastAudioFormat(merged.audioFormat),
  };
}

function normalizePodcastDrafts(
  drafts?: Record<string, PodcastDraftView>
): Record<string, PodcastDraftView> {
  if (!drafts) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(drafts).map(([draftId, draft]) => [
      draftId,
      (() => {
        const normalizedScriptStatus =
          draft.scriptStatus === 'ready' || draft.scriptStatus === 'error'
            ? draft.scriptStatus
            : 'idle';
        const normalizedAudioStatus =
          draft.audioStatus === 'ready' || draft.audioStatus === 'error'
            ? draft.audioStatus
            : 'idle';
        const scriptWasInterrupted = draft.scriptStatus === 'generating';
        const audioWasInterrupted = draft.audioStatus === 'generating';

        return {
          ...draft,
          config: normalizePodcastConfig(draft.config),
          transcript: draft.transcript || '',
          transcriptSource:
            draft.transcriptSource === 'manual' || draft.transcriptSource === 'youtube'
              ? draft.transcriptSource
              : 'none',
          script: draft.script || '',
          scriptStatus: normalizedScriptStatus,
          scriptError: scriptWasInterrupted
            ? '口播稿生成在应用重启后已中断，请重新生成。'
            : draft.scriptError || undefined,
          scriptSessionId: scriptWasInterrupted ? null : draft.scriptSessionId || null,
          audioStatus: normalizedAudioStatus,
          audioError: audioWasInterrupted
            ? '音频生成在应用重启后已中断，请重新生成。'
            : draft.audioError || undefined,
          audioOutputPath: draft.audioOutputPath || undefined,
          status:
            normalizedAudioStatus === 'ready'
              ? 'audio_ready'
              : (draft.script || '').trim()
                ? 'script_ready'
                : 'draft',
        };
      })(),
    ])
  );
}

function buildPodcastDraft(title?: string, existingCount = 0): PodcastDraftView {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: title?.trim() || `Podcast Episode ${existingCount + 1}`,
    status: 'draft',
    sources: [],
    config: createDefaultPodcastConfig(),
    transcript: '',
    transcriptSource: 'none',
    script: '',
    scriptStatus: 'idle',
    scriptError: undefined,
    scriptSessionId: null,
    audioStatus: 'idle',
    audioError: undefined,
    audioOutputPath: undefined,
    updatedAt: now,
  };
}

function createPodcastSource(
  source: Omit<PodcastSourceView, 'id' | 'addedAt'>
): PodcastSourceView {
  return {
    ...source,
    id: crypto.randomUUID(),
    addedAt: Date.now(),
  };
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
      activeSessionId: null,
      activeWorkspace: 'chat' as ActiveWorkspace,
      chatSidebarView: 'threads' as ChatSidebarView,
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
      activeSettingsTab: 'general' as SettingsTab,
      promptLibraryInsertRequest: null,
      podcastDrafts: {},
      activePodcastDraftId: null,
      // 状态配置
      statusConfigs: [],
      statusFilter: 'all',
      // 文件夹
      folderConfigs: [],
      // 主题
      theme: 'system' as const,
      colorThemeId: DEFAULT_COLOR_THEME_ID,
      customThemeCss: '',
      fontSelections: getDefaultFontSelections(),
      importedFonts: [],
      systemFonts: [],
      systemFontsLoaded: false,

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
        set({ globalError: event.payload.message, pendingStart: false });
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

      return { activeSessionId: sessionId, activeWorkspace: 'chat' };
    });

    if (sessionId && get().sessions[sessionId]?.runtimeNotice) {
      scheduleRuntimeNoticeClear(sessionId, set);
    }
  },

  setActiveWorkspace: (activeWorkspace) =>
    set((state) => {
      if (activeWorkspace !== 'podcast') {
        return { activeWorkspace };
      }

      const fallbackDraftId = state.activePodcastDraftId || Object.keys(state.podcastDrafts)[0] || null;

      return {
        activeWorkspace,
        activePodcastDraftId: fallbackDraftId,
        showNewSession: false,
      };
    }),

  setChatSidebarView: (chatSidebarView) => set({ chatSidebarView }),

  setShowNewSession: (show) => set({ showNewSession: show, activeWorkspace: show ? 'chat' : get().activeWorkspace }),

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
  createPodcastDraft: (title) => {
    const draft = buildPodcastDraft(title, Object.keys(get().podcastDrafts).length);

    set((state) => ({
      podcastDrafts: {
        [draft.id]: draft,
        ...state.podcastDrafts,
      },
      activePodcastDraftId: draft.id,
      activeWorkspace: 'podcast',
      showNewSession: false,
      showSettings: false,
    }));

    return draft.id;
  },
  setActivePodcastDraft: (activePodcastDraftId) =>
    set({
      activePodcastDraftId,
      activeWorkspace: 'podcast',
      showNewSession: false,
    }),
  renamePodcastDraft: (draftId, title) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      const nextTitle = title.trim();
      if (!draft || !nextTitle) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            title: nextTitle,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  deletePodcastDraft: (draftId) =>
    set((state) => {
      if (!state.podcastDrafts[draftId]) {
        return state;
      }

      const { [draftId]: _deleted, ...rest } = state.podcastDrafts;
      const remainingDraftIds = Object.keys(rest);

      return {
        podcastDrafts: rest,
        activePodcastDraftId:
          state.activePodcastDraftId === draftId ? remainingDraftIds[0] || null : state.activePodcastDraftId,
      };
    }),
  updatePodcastDraftConfig: (draftId, patch) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            config: normalizePodcastConfig({
              ...draft.config,
              ...patch,
            }),
            updatedAt: Date.now(),
          },
        },
      };
    }),
  updatePodcastDraftTranscript: (draftId, transcript, source: PodcastTranscriptSource = 'manual') =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            transcript,
            transcriptSource: transcript.trim() ? source : 'none',
            updatedAt: Date.now(),
          },
        },
      };
    }),
  setPodcastScriptGeneration: (draftId, sessionId) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            scriptStatus: 'generating',
            scriptError: undefined,
            scriptSessionId: sessionId,
            audioStatus: 'idle',
            audioError: undefined,
            audioOutputPath: undefined,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  setPodcastScriptContent: (draftId, script) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            script,
            scriptStatus: script.trim() ? 'ready' : 'idle',
            scriptError: undefined,
            status: script.trim() ? 'script_ready' : draft.status,
            audioStatus: 'idle',
            audioError: undefined,
            audioOutputPath: undefined,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  setPodcastScriptError: (draftId, error) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            scriptStatus: 'error',
            scriptError: error,
            audioStatus: 'idle',
            audioError: undefined,
            audioOutputPath: undefined,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  setPodcastAudioGeneration: (draftId) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            audioStatus: 'generating',
            audioError: undefined,
            audioOutputPath: undefined,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  setPodcastAudioReady: (draftId, outputPath) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            status: 'audio_ready',
            audioStatus: outputPath.trim() ? 'ready' : 'idle',
            audioError: undefined,
            audioOutputPath: outputPath.trim() || undefined,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  setPodcastAudioError: (draftId, error) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            audioStatus: 'error',
            audioError: error,
            audioOutputPath: undefined,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  addPodcastSource: (draftId, source) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            sources: [createPodcastSource(source), ...draft.sources],
            updatedAt: Date.now(),
          },
        },
      };
    }),
  removePodcastSource: (draftId, sourceId) =>
    set((state) => {
      const draft = state.podcastDrafts[draftId];
      if (!draft) {
        return state;
      }

      return {
        podcastDrafts: {
          ...state.podcastDrafts,
          [draftId]: {
            ...draft,
            sources: draft.sources.filter((source) => source.id !== sourceId),
            updatedAt: Date.now(),
          },
        },
      };
    }),

  // 状态配置 Actions
  setStatusConfigs: (configs) => set({ statusConfigs: configs }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),

  // 文件夹 Actions
  setFolderConfigs: (configs) => set({ folderConfigs: configs }),

  // 主题
  setTheme: (theme) => {
    set({ theme });
    const { colorThemeId, customThemeCss, fontSelections, importedFonts } = get();
    applyAppearance({ theme, colorThemeId, customThemeCss, fontSelections, importedFonts });
  },

  setColorThemeId: (colorThemeId) => {
    set({ colorThemeId });
    const { theme, customThemeCss, fontSelections, importedFonts } = get();
    applyAppearance({ theme, colorThemeId, customThemeCss, fontSelections, importedFonts });
  },

  setCustomThemeCss: (customThemeCss) => {
    set({ customThemeCss });
    const { theme, colorThemeId, fontSelections, importedFonts } = get();
    applyAppearance({ theme, colorThemeId, customThemeCss, fontSelections, importedFonts });
  },
  setFontSettings: (settings) => {
    set({
      fontSelections: settings.selections,
      importedFonts: settings.importedFonts,
    });
    const { theme, colorThemeId, customThemeCss } = get();
    applyAppearance({
      theme,
      colorThemeId,
      customThemeCss,
      fontSelections: settings.selections,
      importedFonts: settings.importedFonts,
    });
  },

  setSystemFonts: (systemFonts) => {
    set({ systemFonts, systemFontsLoaded: true });
  },
    }),
    {
      name: 'cowork-app-storage',
      partialize: (state) => ({
        activeWorkspace: state.activeWorkspace,
        chatSidebarView: state.chatSidebarView,
        podcastDrafts: state.podcastDrafts,
        activePodcastDraftId: state.activePodcastDraftId,
        sidebarWidth: state.sidebarWidth,
        theme: state.theme,
        colorThemeId: state.colorThemeId,
        customThemeCss: state.customThemeCss,
      }),
      merge: (persistedState: unknown, currentState: Store) => {
        const persisted = persistedState as {
          activeWorkspace?: ActiveWorkspace;
          chatSidebarView?: ChatSidebarView;
          podcastDrafts?: Record<string, PodcastDraftView>;
          activePodcastDraftId?: string | null;
          sidebarWidth?: number;
          theme?: Theme;
          colorThemeId?: ColorThemeId;
          customThemeCss?: string;
        } | undefined;
        const theme = persisted?.theme || currentState.theme;
        const colorThemeId = persisted?.colorThemeId || currentState.colorThemeId;
        const customThemeCss = persisted?.customThemeCss || currentState.customThemeCss;
        applyAppearance({
          theme,
          colorThemeId,
          customThemeCss,
          fontSelections: currentState.fontSelections,
          importedFonts: currentState.importedFonts,
        });
        return {
          ...currentState,
          activeWorkspace: persisted?.activeWorkspace || currentState.activeWorkspace,
          chatSidebarView: persisted?.chatSidebarView || currentState.chatSidebarView,
          podcastDrafts: Object.keys(normalizePodcastDrafts(persisted?.podcastDrafts)).length > 0
            ? normalizePodcastDrafts(persisted?.podcastDrafts)
            : currentState.podcastDrafts,
          activePodcastDraftId:
            persisted?.activePodcastDraftId !== undefined
              ? persisted.activePodcastDraftId
              : currentState.activePodcastDraftId,
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
    const { theme, colorThemeId, customThemeCss, fontSelections, importedFonts } = useAppStore.getState();
    if (theme === 'system') {
      applyAppearance({
        theme: 'system',
        colorThemeId,
        customThemeCss,
        fontSelections,
        importedFonts,
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
      cwd: session.cwd,
      claudeSessionId: session.claudeSessionId,
      provider: session.provider || 'claude',
      model: session.model,
      compatibleProviderId: session.compatibleProviderId,
      betas: session.betas,
      claudeAccessMode: session.claudeAccessMode,
      codexPermissionMode: session.codexPermissionMode,
      todoState: session.todoState || 'todo',
      pinned: session.pinned || false,
      folderPath: session.folderPath || null,
      hiddenFromThreads: session.hiddenFromThreads === true,
      latestClaudeModelUsage: session.latestClaudeModelUsage,
      messages: existing?.messages || [],
      hydrated: existing?.hydrated || false,
      permissionRequests: existing?.permissionRequests || [],
      streaming: existing?.streaming || createEmptyStreamingState(),
      runtimeNotice: existing?.runtimeNotice,
      updatedAt: session.updatedAt,
    };
  }

  for (const existing of Object.values(get().sessions)) {
    if (existing.hiddenFromThreads && !sessionsMap[existing.id]) {
      sessionsMap[existing.id] = existing;
    }
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
    compatibleProviderId?: SessionInfo['compatibleProviderId'];
    betas?: SessionInfo['betas'];
    claudeAccessMode?: SessionInfo['claudeAccessMode'];
    codexPermissionMode?: SessionInfo['codexPermissionMode'];
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
    codexPermissionMode,
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
          claudeAccessMode: claudeAccessMode !== undefined ? claudeAccessMode : session.claudeAccessMode,
          codexPermissionMode:
            codexPermissionMode !== undefined ? codexPermissionMode : session.codexPermissionMode,
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
    // 新建会话（来自 session.start）
    const newSession: SessionView = {
      id: sessionId,
      title: title || 'New Session',
      status,
      cwd,
      provider: provider || 'claude',
      model,
      compatibleProviderId,
      betas,
      claudeAccessMode,
      codexPermissionMode,
      hiddenFromThreads: hiddenFromThreads === true,
      latestClaudeModelUsage: undefined,
      messages: [],
      hydrated: true, // 新会话不需要 hydration
      permissionRequests: [],
      streaming: createEmptyStreamingState(),
      runtimeNotice: undefined,
      updatedAt: Date.now(),
    };

    const shouldFocusNewSession = state.activeWorkspace === 'chat' && hiddenFromThreads !== true;

    set({
      sessions: {
        ...state.sessions,
        [sessionId]: newSession,
      },
      activeSessionId: shouldFocusNewSession ? sessionId : state.activeSessionId,
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
          latestClaudeModelUsage: extractLatestClaudeModelUsage(sanitizedMessages, session.model),
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

    // Claude Agent SDK may emit partial updates for the same message UUID.
    // Replace existing messages instead of appending duplicates.
    const maybeUuid = (message as { uuid?: unknown }).uuid;
    if (typeof maybeUuid === 'string' && maybeUuid.length > 0) {
      const existingIndex = currentSession.messages.findIndex(
        (m) => (m as { uuid?: unknown }).uuid === maybeUuid
      );
      if (existingIndex >= 0) {
        const nextMessages = currentSession.messages.slice();
        nextMessages[existingIndex] = message;
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...currentSession,
              latestClaudeModelUsage:
                message.type === 'result' && currentSession.provider === 'claude' && message.modelUsage
                  ? extractLatestClaudeModelUsage([message], currentSession.model) || currentSession.latestClaudeModelUsage
                  : currentSession.latestClaudeModelUsage,
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
          ...currentSession,
          latestClaudeModelUsage:
            message.type === 'result' && currentSession.provider === 'claude' && message.modelUsage
              ? extractLatestClaudeModelUsage([message], currentSession.model) || currentSession.latestClaudeModelUsage
              : currentSession.latestClaudeModelUsage,
          messages: [...currentSession.messages, message],
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
