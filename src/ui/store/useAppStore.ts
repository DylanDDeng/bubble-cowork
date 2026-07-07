import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';
import { toast } from 'sonner';
import * as tree from './layout-tree';
import type { PaneId, SplitEdge, WorkspaceLayout } from './layout-tree';
import {
  deriveLegacyFields,
  legacyPaneToLeafId,
  repairLayout,
  resolveWorkspaceLayout,
  WORKSPACE_LAYOUT_SCHEMA_VERSION,
} from './layout-adapter';
import type {
  ActiveWorkspace,
  AppState,
  AppActions,
  ChatLayoutMode,
  ChatPaneId,
  ChatPaneState,
  ChatSidebarView,
  WorkspaceSurface,
  ProjectUtilityPanelKind,
  ProjectUtilityPanelTarget,
  ReviewDiffSelection,
  ReviewDiffSelectionInput,
  SessionView,
  ServerEvent,
  SessionInfo,
  StreamMessage,
  ContentBlock,
  Attachment,
  SearchFilters,
  SearchMatch,
  SettingsTab,
  FolderConfig,
  Theme,
  ThemeFonts,
  ThemeState,
  ThemeVariant,
  ChromeTheme,
  PromptLibraryInsertMode,
  WorkspaceChannel,
  SessionTeamMode,
  McpServerStatus,
} from '../types';
import {
  DEFAULT_THEME_STATE,
  DEFAULT_UI_FONT_FAMILY,
  applyThemePreferences,
  normalizeThemeState,
  resetThemeVariant as resetThemeVariantState,
  setThemeCodeThemeId,
  setThemePackFonts,
  updateThemePack,
} from '../theme/themes';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
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

function normalizeReviewDiffSelection(selection: ReviewDiffSelectionInput): ReviewDiffSelection {
  return {
    ...selection,
    records: selection.records ? selection.records.map((record) => ({ ...record })) : undefined,
    requestedAt: selection.requestedAt ?? Date.now(),
  };
}

function getProjectChannelKey(cwd?: string | null): string {
  return cwd?.trim() || '__no_project__';
}

function normalizeWorkspaceChannelId(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_WORKSPACE_CHANNEL_ID;
}

function normalizeWorkspaceChannelName(value: string): string {
  return value
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase();
}

function createDefaultWorkspaceChannel(projectCwd?: string | null): WorkspaceChannel {
  const now = Date.now();
  return {
    id: DEFAULT_WORKSPACE_CHANNEL_ID,
    projectCwd: projectCwd?.trim() || '',
    name: 'all',
    createdAt: now,
    updatedAt: now,
  };
}

function ensureDefaultWorkspaceChannel(
  channels: WorkspaceChannel[] | undefined,
  projectCwd?: string | null
): WorkspaceChannel[] {
  const existing = channels || [];
  if (existing.some((channel) => channel.id === DEFAULT_WORKSPACE_CHANNEL_ID)) {
    return existing;
  }
  return [createDefaultWorkspaceChannel(projectCwd), ...existing];
}

function resolveActiveChannelIdForProject(
  activeChannelByProject: Record<string, string>,
  cwd?: string | null
): string {
  return normalizeWorkspaceChannelId(activeChannelByProject[getProjectChannelKey(cwd)]);
}

function applyActiveProjectChannel(
  activeChannelByProject: Record<string, string>,
  session?: Pick<SessionView, 'scope' | 'cwd' | 'channelId'> | null
): Record<string, string> {
  if (!session || session.scope === 'dm') {
    return activeChannelByProject;
  }

  return {
    ...activeChannelByProject,
    [getProjectChannelKey(session.cwd)]: normalizeWorkspaceChannelId(session.channelId),
  };
}

function normalizeSessionTeamMode(value: unknown): SessionTeamMode {
  return value === 'solo' || value === 'team' || value === 'manual'
    ? value
    : 'channel_default';
}

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
  // Subagent (Task) messages commit while the top-level agent may still be
  // streaming its own partial — they must not reset that buffer.
  if (message.parentToolUseId) {
    return true;
  }
  return (
    provider === 'codex' &&
    ((message.type === 'assistant' && message.streaming === true) ||
      (message.type === 'system' && message.subtype === 'token_usage'))
  );
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
  fallbackSessionId: string | null,
  layoutMode: ChatLayoutMode
): Record<ChatPaneId, ChatPaneState> {
  return {
    primary: {
      id: 'primary',
      sessionId: panes?.primary?.sessionId ?? fallbackSessionId,
      surface: 'chat',
    },
    secondary: {
      id: 'secondary',
      // The secondary pane (Side Chat) only holds a session while the split is
      // active. Persisted state can carry a stale secondary sessionId from
      // before this invariant was enforced; drop it unless we're in split mode
      // so the Side Chat restores to its empty "Drop a conversation here" state.
      sessionId: layoutMode === 'split' ? panes?.secondary?.sessionId ?? null : null,
      surface: 'chat',
    },
  };
}

let rightUtilityFileTabCounter = 0;
let rightUtilityBrowserTabCounter = 0;

function isRightUtilityFileTab(target: ProjectUtilityPanelTarget | null | undefined): boolean {
  return target === 'files' || Boolean(target?.startsWith('files:'));
}

function isRightUtilityBrowserTab(target: ProjectUtilityPanelTarget | null | undefined): boolean {
  return target === 'browser' || Boolean(target?.startsWith('browser:'));
}

function isRightUtilitySubagentTab(target: ProjectUtilityPanelTarget | null | undefined): boolean {
  return target === 'subagent' || Boolean(target?.startsWith('subagent:'));
}

function getRightUtilityTabKind(
  target: ProjectUtilityPanelTarget
): ProjectUtilityPanelKind {
  if (isRightUtilityFileTab(target)) return 'files';
  if (isRightUtilityBrowserTab(target)) return 'browser';
  if (isRightUtilitySubagentTab(target)) return 'subagent';
  return target;
}

function createRightUtilityFileTabId(): ProjectUtilityPanelTarget {
  rightUtilityFileTabCounter += 1;
  return `files:${Date.now().toString(36)}-${rightUtilityFileTabCounter}`;
}

function createRightUtilityBrowserTabId(): ProjectUtilityPanelTarget {
  rightUtilityBrowserTabCounter += 1;
  return `browser:${Date.now().toString(36)}-${rightUtilityBrowserTabCounter}`;
}

function resolveRightUtilityTabOpen(
  tabs: ProjectUtilityPanelTarget[],
  target: ProjectUtilityPanelKind,
  options?: { newTab?: boolean }
): { tabs: ProjectUtilityPanelTarget[]; activeTab: ProjectUtilityPanelTarget } {
  if (target === 'files') {
    const existing = tabs.find(isRightUtilityFileTab);
    const activeTab = options?.newTab || !existing
      ? createRightUtilityFileTabId()
      : existing;
    return {
      tabs: tabs.includes(activeTab) ? tabs : [...tabs, activeTab],
      activeTab,
    };
  }

  if (target === 'browser') {
    const activeTab = options?.newTab ? createRightUtilityBrowserTabId() : 'browser';
    return {
      tabs: tabs.includes(activeTab) ? tabs : [...tabs, activeTab],
      activeTab,
    };
  }

  return {
    tabs: tabs.includes(target) ? tabs : [...tabs, target],
    activeTab: target,
  };
}

function resolveRightUtilityTabOpenPreservingActive(
  tabs: ProjectUtilityPanelTarget[],
  target: ProjectUtilityPanelKind,
  activeTab: ProjectUtilityPanelTarget | null
): { tabs: ProjectUtilityPanelTarget[]; activeTab: ProjectUtilityPanelTarget } {
  if (target === 'files' && isRightUtilityFileTab(activeTab)) {
    return {
      tabs: addRightUtilityTab(tabs, activeTab),
      activeTab,
    };
  }
  if (target === 'browser' && isRightUtilityBrowserTab(activeTab)) {
    return {
      tabs: addRightUtilityTab(tabs, activeTab),
      activeTab,
    };
  }
  if (target !== 'files' && activeTab === target) {
    return {
      tabs: addRightUtilityTab(tabs, activeTab),
      activeTab,
    };
  }
  return resolveRightUtilityTabOpen(tabs, target);
}

function addRightUtilityTab(
  tabs: ProjectUtilityPanelTarget[],
  target: ProjectUtilityPanelTarget
): ProjectUtilityPanelTarget[] {
  return tabs.includes(target) ? tabs : [...tabs, target];
}

function getInitialRightUtilityTab(
  resumeState: import('../shared/types').UiResumeState | null
): ProjectUtilityPanelTarget | null {
  if (resumeState?.projectTreeCollapsed === false) {
    return normalizeProjectPanelView(resumeState.projectPanelView) === 'changes'
      ? 'review'
      : 'files';
  }
  if (normalizeChatLayoutMode(resumeState?.chatLayoutMode) === 'split') {
    return 'side-chat';
  }
  return null;
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
  | 'workspaceLayout'
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
    schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
    workspaceLayout: state.workspaceLayout,
    activeSessionId: state.activeSessionId,
    showNewSession: state.showNewSession,
    projectCwd: state.projectCwd,
    projectTreeCollapsed: state.projectTreeCollapsed,
    projectPanelView: state.projectPanelView,
    terminalDrawerOpen: state.terminalDrawerOpen,
    terminalDrawerHeight: state.terminalDrawerHeight,
    // Legacy two-pane fields kept in the blob as a compat shadow so an older
    // app version can still restore a (collapsed) layout after a downgrade.
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
const initialRightUtilityTab = getInitialRightUtilityTab(initialUiResumeState);
const initialWorkspaceLayout = repairLayout(
  resolveWorkspaceLayout(initialUiResumeState as Parameters<typeof resolveWorkspaceLayout>[0])
);
const initialLegacyPaneFields = deriveLegacyFields(initialWorkspaceLayout);

// Build the legacy pane patch (chatPanes/chatLayoutMode/activePaneId/...) from a
// layout tree. workspaceLayout is the source of truth; these fields are derived
// after every layout mutation so existing two-pane consumers keep working.
function layoutPatch(layout: WorkspaceLayout) {
  const legacy = deriveLegacyFields(layout);
  return {
    workspaceLayout: layout,
    chatLayoutMode: legacy.chatLayoutMode,
    savedSplitVisible: legacy.savedSplitVisible,
    activePaneId: legacy.activePaneId,
    chatPanes: {
      primary: {
        id: 'primary' as const,
        sessionId: legacy.chatPanes.primary.sessionId,
        surface: legacy.chatPanes.primary.surface ?? ('chat' as const),
      },
      secondary: {
        id: 'secondary' as const,
        sessionId: legacy.chatPanes.secondary.sessionId,
        surface: legacy.chatPanes.secondary.surface ?? ('chat' as const),
      },
    },
    chatSplitRatio: legacy.chatSplitRatio,
    activeSessionId: tree.activeSessionId(layout),
  };
}

// Build a fresh (unhydrated) SessionView from a server SessionInfo — used when a
// session appears outside the normal session.list flow (e.g. forking). History
// is loaded lazily by ChatPane once the pane mounts.
function freshSessionViewFromInfo(info: import('../shared/types').SessionInfo): SessionView {
  return {
    id: info.id,
    title: info.title,
    status: info.status,
    scope: info.scope,
    agentId: info.agentId || null,
    source: info.source || 'aegis',
    readOnly: info.readOnly === true,
    cwd: info.cwd,
    projectCwd: info.projectCwd ?? info.cwd ?? null,
    envMode: info.envMode ?? (info.worktreePath ? 'worktree' : 'local'),
    worktreePath: info.worktreePath ?? null,
    associatedWorktreePath: info.associatedWorktreePath ?? null,
    associatedWorktreeBranch: info.associatedWorktreeBranch ?? null,
    associatedWorktreeRef: info.associatedWorktreeRef ?? null,
    claudeSessionId: info.claudeSessionId,
    provider: info.provider || 'claude',
    model: info.model,
    compatibleProviderId: info.compatibleProviderId,
    betas: info.betas,
    claudeAccessMode: normalizeClaudeAccessMode(info.claudeAccessMode),
    claudeExecutionMode: normalizeClaudeExecutionMode(info.claudeExecutionMode, info.claudeAccessMode),
    claudeReasoningEffort: normalizeClaudeReasoningEffort(info.claudeReasoningEffort),
    codexExecutionMode: normalizeCodexExecutionMode(info.codexExecutionMode),
    codexPermissionMode: info.codexPermissionMode,
    codexReasoningEffort: info.codexReasoningEffort,
    codexFastMode: info.codexFastMode,
    opencodePermissionMode: info.opencodePermissionMode,
    pinned: info.pinned || false,
    folderPath: info.folderPath || null,
    hiddenFromThreads: info.hiddenFromThreads === true,
    channelId: normalizeWorkspaceChannelId(info.channelId),
    teamMode: normalizeSessionTeamMode(info.teamMode),
    teamId: info.teamId || null,
    handoffSourceProvider: info.handoffSourceProvider || null,
    latestClaudeModelUsage: info.latestClaudeModelUsage,
    messages: [],
    hydrated: false,
    historyCursor: null,
    hasMoreHistory: false,
    loadingMoreHistory: false,
    permissionRequests: [],
    streaming: createEmptyStreamingState(),
    updatedAt: info.updatedAt,
  };
}

function createEmptyStreamingState() {
  return {
    isStreaming: false,
    text: '',
    thinking: '',
  };
}

function createDraftSessionView(
  cwd?: string | null,
  channelId?: string | null,
  options?: Partial<Pick<
    SessionView,
    | 'title'
    | 'scope'
    | 'agentId'
    | 'provider'
    | 'model'
    | 'compatibleProviderId'
    | 'claudeAccessMode'
    | 'claudeExecutionMode'
    | 'claudeReasoningEffort'
    | 'codexExecutionMode'
    | 'codexPermissionMode'
    | 'codexReasoningEffort'
    | 'codexFastMode'
    | 'kimiPermissionMode'
    | 'opencodePermissionMode'
    | 'teamMode'
    | 'teamId'
    | 'projectCwd'
    | 'envMode'
    | 'worktreePath'
    | 'associatedWorktreePath'
    | 'associatedWorktreeBranch'
    | 'associatedWorktreeRef'
  >>
): SessionView {
  const now = Date.now();
  const id = `draft-${now}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    title: options?.title || 'New Chat',
    status: 'idle',
    scope: options?.scope || 'project',
    agentId: options?.agentId || null,
    source: 'aegis',
    readOnly: false,
    isDraft: true,
    cwd: cwd || undefined,
    projectCwd: options?.projectCwd !== undefined ? options.projectCwd : cwd || null,
    envMode: options?.envMode || 'local',
    worktreePath: options?.worktreePath ?? null,
    associatedWorktreePath: options?.associatedWorktreePath ?? null,
    associatedWorktreeBranch: options?.associatedWorktreeBranch ?? null,
    associatedWorktreeRef: options?.associatedWorktreeRef ?? null,
    channelId: normalizeWorkspaceChannelId(channelId),
    teamMode: options?.teamMode || 'channel_default',
    teamId: options?.teamId || null,
    provider: options?.provider || loadPreferredProvider(),
    model: options?.model,
    compatibleProviderId: options?.compatibleProviderId,
    claudeAccessMode: options?.claudeAccessMode,
    claudeExecutionMode: options?.claudeExecutionMode || 'execute',
    claudeReasoningEffort: options?.claudeReasoningEffort || 'high',
    codexExecutionMode: options?.codexExecutionMode,
    codexPermissionMode: options?.codexPermissionMode,
    codexReasoningEffort: options?.codexReasoningEffort,
    codexFastMode: options?.codexFastMode,
    kimiPermissionMode: options?.kimiPermissionMode,
    opencodePermissionMode: options?.opencodePermissionMode,
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
  switch (typeof value === 'string' ? value.trim() : '') {
    case 'fullAccess':
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'acceptEdits':
    case 'plan':
    case 'dontAsk':
    case 'auto':
      return value as import('../types').ClaudeAccessMode;
    default:
      return 'default';
  }
}

function normalizeClaudeExecutionMode(
  value: unknown,
  accessMode?: unknown
): import('../types').ClaudeExecutionMode {
  if (normalizeClaudeAccessMode(accessMode) === 'plan') {
    return 'plan';
  }
  return value === 'plan' ? 'plan' : 'execute';
}

function normalizeClaudeReasoningEffort(value: unknown): import('../types').ClaudeReasoningEffort {
  if (typeof value !== 'string') {
    return 'high';
  }
  switch (value.trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value.trim().toLowerCase() as import('../types').ClaudeReasoningEffort;
    default:
      return 'high';
  }
}

function normalizeCodexExecutionMode(value: unknown): import('../types').CodexExecutionMode {
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
      workspaceChannelsByProject: {},
      activeChannelByProject: {},
      activeSessionId: initialUiResumeState?.activeSessionId ?? null,
      activeWorkspace: 'chat' as ActiveWorkspace,
      chatSidebarView: 'threads' as ChatSidebarView,
      workspaceLayout: initialWorkspaceLayout,
      chatLayoutMode: initialLegacyPaneFields.chatLayoutMode,
      savedSplitVisible: initialLegacyPaneFields.savedSplitVisible,
      activePaneId: initialLegacyPaneFields.activePaneId,
      chatPanes: {
        primary: {
          id: 'primary',
          sessionId: initialLegacyPaneFields.chatPanes.primary.sessionId,
          surface: initialLegacyPaneFields.chatPanes.primary.surface ?? 'chat',
        },
        secondary: {
          id: 'secondary',
          sessionId: initialLegacyPaneFields.chatPanes.secondary.sessionId,
          surface: initialLegacyPaneFields.chatPanes.secondary.surface ?? 'chat',
        },
      },
      chatSplitRatio: initialLegacyPaneFields.chatSplitRatio,
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
      rightUtilityTabs: initialRightUtilityTab ? [initialRightUtilityTab] : [],
      activeRightUtilityTab: initialRightUtilityTab,
      rightUtilityPanelHidden: false,
      reviewDiffSelection: null,
      terminalDrawerOpen: resolveInitialTerminalDrawerOpen(initialUiResumeState),
      terminalDrawerHeight: sanitizeTerminalDrawerHeight(initialUiResumeState?.terminalDrawerHeight),
      browserPanelOpen: false,
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
      mcpOpencodeGlobalServers: {},
      mcpOpencodeProjectServers: {},
      mcpKimiGlobalServers: {},
      mcpKimiProjectServers: {},
      mcpServerStatus: [],
      claudeUserSkills: [],
      claudeProjectSkills: [],
      claudeSkillsUserRoot: '',
      claudeSkillsProjectRoot: undefined,
      // Settings 状态
      showSettings: false,
      draftStartMode: {},
      activeSettingsTab: 'general' as SettingsTab,
      agentSetupOpen: false,
      agentSetupDismissedAt: null,
      agentSetupCompletedAt: null,
      updateStatus: {
        available: false,
        version: null,
        autoDetected: false,
      },
      promptLibraryInsertRequest: null,
      pendingChatInjection: null,
      // 文件夹
      folderConfigs: [],
      // 主题
      theme: 'system' as const,
      themeState: DEFAULT_THEME_STATE,
      uiFontFamily: DEFAULT_UI_FONT_FAMILY,
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

      case 'project.file':
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('aegis:project-file-changed', { detail: event.payload })
          );
        }
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
          mcpOpencodeGlobalServers: event.payload.opencodeGlobalServers || {},
          mcpOpencodeProjectServers: event.payload.opencodeProjectServers || {},
          mcpKimiGlobalServers: event.payload.kimiGlobalServers || {},
          mcpKimiProjectServers: event.payload.kimiProjectServers || {},
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

      case 'session.channelChanged':
        handleSessionChannelChanged(event.payload, set, get);
        break;

      case 'session.teamChanged':
        handleSessionTeamChanged(event.payload, set, get);
        break;

      // 系统通知点击回位
      case 'app.focusSession':
        get().setActiveSession(event.payload.sessionId);
        set({ showSettings: false });
        break;
    }
  },

  setActiveSession: (sessionId) => {
    // Load the session into the focused leaf (works for single or N-pane).
    set((state) => {
      const active = tree.getActiveLeaf(state.workspaceLayout);
      const layout = tree.placeSession(state.workspaceLayout, active.id, sessionId);
      const session = sessionId ? state.sessions[sessionId] : null;
      return {
        ...layoutPatch(layout),
        activeWorkspace: 'chat',
        // Forcing a session shows it; clearing leaves the new-session flag as-is.
        showNewSession: sessionId ? false : state.showNewSession,
        activeChannelByProject: session
          ? applyActiveProjectChannel(state.activeChannelByProject, session)
          : state.activeChannelByProject,
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
        ...layoutPatch(
          tree.placeSession(
            state.workspaceLayout,
            tree.getActiveLeaf(state.workspaceLayout).id,
            nextActiveSessionId
          )
        ),
        activeChannelByProject: nextActiveSessionId && state.sessions[nextActiveSessionId]
          ? applyActiveProjectChannel(state.activeChannelByProject, state.sessions[nextActiveSessionId])
          : state.activeChannelByProject,
      };
    }),

  setChatSidebarView: (chatSidebarView) => set({ chatSidebarView }),

  createWorkspaceChannel: (projectCwd, name) => {
    const projectKey = getProjectChannelKey(projectCwd);
    const channelId = normalizeWorkspaceChannelName(name);
    if (!channelId || channelId === DEFAULT_WORKSPACE_CHANNEL_ID) {
      return null;
    }

    const now = Date.now();
    set((state) => {
      const currentChannels = ensureDefaultWorkspaceChannel(
        state.workspaceChannelsByProject[projectKey],
        projectCwd
      );
      if (currentChannels.some((channel) => channel.id === channelId)) {
        return {
          activeChannelByProject: {
            ...state.activeChannelByProject,
            [projectKey]: channelId,
          },
        };
      }

      return {
        workspaceChannelsByProject: {
          ...state.workspaceChannelsByProject,
          [projectKey]: [
            ...currentChannels,
            {
              id: channelId,
              projectCwd,
              name: channelId,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
        activeChannelByProject: {
          ...state.activeChannelByProject,
          [projectKey]: channelId,
        },
      };
    });

    return channelId;
  },

  renameWorkspaceChannel: (projectCwd, channelId, newName) => {
    if (channelId === DEFAULT_WORKSPACE_CHANNEL_ID) return false;

    const projectKey = getProjectChannelKey(projectCwd);
    const normalizedName = normalizeWorkspaceChannelName(newName);
    if (!normalizedName || normalizedName === DEFAULT_WORKSPACE_CHANNEL_ID) {
      return false;
    }

    const now = Date.now();
    let renamed = false;
    set((state) => {
      const currentChannels = state.workspaceChannelsByProject[projectKey];
      if (!currentChannels) return {};

      const nextChannels = currentChannels.map((channel) => {
        if (channel.id === channelId) {
          renamed = true;
          return { ...channel, name: normalizedName, updatedAt: now };
        }
        return channel;
      });

      if (!renamed) return {};

      return {
        workspaceChannelsByProject: {
          ...state.workspaceChannelsByProject,
          [projectKey]: nextChannels,
        },
      };
    });

    return renamed;
  },

  setActiveChannelForProject: (projectCwd, channelId) =>
    set((state) => ({
      activeChannelByProject: {
        ...state.activeChannelByProject,
        [getProjectChannelKey(projectCwd)]: normalizeWorkspaceChannelId(channelId),
      },
    })),

  setSessionChannel: (sessionId, channelId) =>
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) {
        return state;
      }

      const normalizedChannelId = normalizeWorkspaceChannelId(channelId);
      if (session.scope === 'dm') {
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...session,
              channelId: normalizedChannelId,
              updatedAt: Date.now(),
            },
          },
        };
      }

      const projectKey = getProjectChannelKey(session.cwd);
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            channelId: normalizedChannelId,
            updatedAt: Date.now(),
          },
        },
        activeChannelByProject: {
          ...state.activeChannelByProject,
          [projectKey]: normalizedChannelId,
        },
      };
    }),

  setSessionTeam: (sessionId, teamMode, teamId) =>
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      const normalizedMode = normalizeSessionTeamMode(teamMode);
      const normalizedTeamId =
        normalizedMode === 'team' || normalizedMode === 'manual'
          ? teamId?.trim() || null
          : null;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            teamMode: normalizedMode,
            teamId: normalizedTeamId,
            updatedAt: Date.now(),
          },
        },
      };
    }),

  setActivePane: (activePaneId) => {
    set((state) => ({
      ...layoutPatch(
        tree.setActivePane(state.workspaceLayout, legacyPaneToLeafId(state.workspaceLayout, activePaneId))
      ),
      activeWorkspace: 'chat',
    }));
    persistUiResumeStateSnapshot(get());
  },

  setActivePaneById: (leafId) => {
    set((state) => ({
      ...layoutPatch(tree.setActivePane(state.workspaceLayout, leafId)),
      activeWorkspace: 'chat',
    }));
    persistUiResumeStateSnapshot(get());
  },

  setChatLayoutMode: (chatLayoutMode) => {
    set((state) => {
      if (chatLayoutMode === 'single') {
        const active = tree.getActiveLeaf(state.workspaceLayout);
        return layoutPatch(
          tree.singleLayout(tree.makeLeaf(active.id, active.sessionId, active.surface))
        );
      }
      if (tree.isSplit(state.workspaceLayout)) return {};
      const active = tree.getActiveLeaf(state.workspaceLayout);
      return layoutPatch(tree.splitPane(state.workspaceLayout, active.id, 'right', null));
    });
    persistUiResumeStateSnapshot(get());
  },

  // savedSplitVisible is derived from workspaceLayout; retained as a no-op.
  setSavedSplitVisible: () => {},

  setChatPaneSession: (paneId, sessionId) => {
    set((state) => ({
      ...layoutPatch(
        tree.placeSession(state.workspaceLayout, legacyPaneToLeafId(state.workspaceLayout, paneId), sessionId)
      ),
      activeWorkspace: 'chat',
      showNewSession: sessionId === null,
    }));
    persistUiResumeStateSnapshot(get());
  },

  setChatPaneSurface: (paneId, surface) => {
    set((state) => ({
      ...layoutPatch(
        tree.setPaneSurface(state.workspaceLayout, legacyPaneToLeafId(state.workspaceLayout, paneId), surface)
      ),
      activeWorkspace: 'chat',
    }));
    persistUiResumeStateSnapshot(get());
  },

  setChatSplitRatio: (chatSplitRatio) => {
    set((state) => {
      const ratio = sanitizeChatSplitRatio(chatSplitRatio);
      const root = state.workspaceLayout.root;
      if (root.type !== 'split' || root.children.length !== 2) {
        return { chatSplitRatio: ratio };
      }
      return layoutPatch(tree.resizeSplit(state.workspaceLayout, root.id, [ratio, 1 - ratio]));
    });
    persistUiResumeStateSnapshot(get());
  },

  resizeSplitById: (splitId, sizes) => {
    set((state) => layoutPatch(tree.resizeSplit(state.workspaceLayout, splitId, sizes)));
    persistUiResumeStateSnapshot(get());
  },

  splitPaneAt: (leafId, edge, sessionId) => {
    set((state) => {
      const targetSession = sessionId ? state.sessions[sessionId] : null;
      return {
        ...layoutPatch(tree.splitPane(state.workspaceLayout, leafId, edge, sessionId)),
        activeChannelByProject: applyActiveProjectChannel(state.activeChannelByProject, targetSession),
        activeWorkspace: 'chat',
        showNewSession: sessionId === null,
      };
    });
    persistUiResumeStateSnapshot(get());
  },

  placeSessionInPane: (leafId, sessionId) => {
    set((state) => {
      const targetSession = sessionId ? state.sessions[sessionId] : null;
      return {
        ...layoutPatch(tree.placeSession(state.workspaceLayout, leafId, sessionId)),
        activeChannelByProject: applyActiveProjectChannel(state.activeChannelByProject, targetSession),
        activeWorkspace: 'chat',
        showNewSession: sessionId === null,
      };
    });
    persistUiResumeStateSnapshot(get());
  },

  closePaneById: (leafId) => {
    set((state) => layoutPatch(tree.closePane(state.workspaceLayout, leafId)));
    persistUiResumeStateSnapshot(get());
  },

  movePaneTo: (leafId, targetLeafId, edge) => {
    set((state) => layoutPatch(tree.movePane(state.workspaceLayout, leafId, targetLeafId, edge)));
    persistUiResumeStateSnapshot(get());
  },

  forkSessionToPane: async (sessionId) => {
    const result = await window.electron.forkSession(sessionId);
    if (!result?.ok || !result.session) {
      if (result?.message) toast.error(result.message);
      return;
    }
    const view = freshSessionViewFromInfo(result.session);
    set((state) => ({ sessions: { ...state.sessions, [view.id]: view } }));
    // Open the fork beside the focused pane (or fill it if the pane is empty).
    const active = tree.getActiveLeaf(get().workspaceLayout);
    if (active.sessionId === null) {
      get().placeSessionInPane(active.id, view.id);
    } else {
      get().splitPaneAt(active.id, 'right', view.id);
    }
    toast.success('Forked into a new pane');
  },

  handoffSessionToProvider: async (sessionId, targetProvider) => {
    const result = await window.electron.sessionHandoff({ sessionId, targetProvider });
    if (!result?.ok || !result.session) {
      if (result?.message) toast.error(result.message);
      return;
    }
    const view = freshSessionViewFromInfo(result.session);
    set((state) => ({ sessions: { ...state.sessions, [view.id]: view } }));
    // Handoff continues the same work — take over the focused pane.
    const active = tree.getActiveLeaf(get().workspaceLayout);
    get().placeSessionInPane(active.id, view.id);
    toast.success('Handed off to a new session — context carries over on your next message.');
  },


  openSplitChat: (paneId, sessionId) => {
    set((state) => {
      const layout = state.workspaceLayout;
      const targetSession = sessionId ? state.sessions[sessionId] : null;
      if (sessionId) {
        const holder = tree.allLeaves(layout.root).find((leaf) => leaf.sessionId === sessionId);
        if (holder) {
          return {
            ...layoutPatch(tree.setActivePane(layout, holder.id)),
            activeChannelByProject: applyActiveProjectChannel(state.activeChannelByProject, targetSession),
            activeWorkspace: 'chat',
            showNewSession: false,
          };
        }
      }
      const active = tree.getActiveLeaf(layout);
      const edge: SplitEdge = paneId === 'primary' ? 'left' : 'right';
      return {
        ...layoutPatch(tree.splitPane(layout, active.id, edge, sessionId)),
        activeChannelByProject: applyActiveProjectChannel(state.activeChannelByProject, targetSession),
        activeWorkspace: 'chat',
        showNewSession: sessionId === null,
      };
    });
    persistUiResumeStateSnapshot(get());
  },

  closeSplitChat: () => {
    // Collapse the whole tree down to a single pane showing the focused session.
    set((state) => {
      const active = tree.getActiveLeaf(state.workspaceLayout);
      const collapsed = tree.singleLayout(tree.makeLeaf(active.id, active.sessionId, active.surface));
      return { ...layoutPatch(collapsed), showNewSession: active.sessionId === null };
    });
    persistUiResumeStateSnapshot(get());
  },

  swapChatPanes: () => {
    set((state) => {
      const leaves = tree.allLeaves(state.workspaceLayout.root);
      if (leaves.length < 2) return {};
      return layoutPatch(tree.swapLeaves(state.workspaceLayout, leaves[0].id, leaves[1].id));
    });
    persistUiResumeStateSnapshot(get());
  },

  setShowNewSession: (show) => {
    set((state) => {
      if (!show) {
        return { showNewSession: false, activeWorkspace: 'chat' };
      }
      const active = tree.getActiveLeaf(state.workspaceLayout);
      return {
        ...layoutPatch(tree.placeSession(state.workspaceLayout, active.id, null)),
        activeWorkspace: 'chat',
        newSessionKey: state.newSessionKey + 1,
        showNewSession: true,
      };
    });
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
    set((state) => {
      if (collapsed) {
        return {
          projectTreeCollapsed: true,
          rightPanelFullscreen:
            state.rightPanelFullscreen === 'files' || state.rightPanelFullscreen === 'review'
              ? null
              : state.rightPanelFullscreen,
        };
      }

      const target = state.projectPanelView === 'changes' ? 'review' : 'files';
      const opened = resolveRightUtilityTabOpenPreservingActive(
        state.rightUtilityTabs,
        target,
        state.activeRightUtilityTab
      );
      return {
        projectTreeCollapsed: false,
        rightUtilityTabs: opened.tabs,
        activeRightUtilityTab: opened.activeTab,
        rightUtilityPanelHidden: false,
        rightPanelFullscreen: state.rightPanelFullscreen,
      };
    });
    persistUiResumeStateSnapshot(get());
  },

  setProjectPanelView: (projectPanelView) => {
    set((state) => {
      const target = projectPanelView === 'changes' ? 'review' : 'files';
      const opened = state.projectTreeCollapsed
        ? null
        : resolveRightUtilityTabOpenPreservingActive(
            state.rightUtilityTabs,
            target,
            state.activeRightUtilityTab
          );
      return {
        projectPanelView,
        rightUtilityTabs: opened ? opened.tabs : state.rightUtilityTabs,
        activeRightUtilityTab: opened ? opened.activeTab : state.activeRightUtilityTab,
        rightUtilityPanelHidden: opened ? false : state.rightUtilityPanelHidden,
      };
    });
    persistUiResumeStateSnapshot(get());
  },

  setActiveRightUtilityTab: (target) => {
    set((state) => ({
      activeRightUtilityTab: target,
      rightUtilityTabs: target ? addRightUtilityTab(state.rightUtilityTabs, target) : state.rightUtilityTabs,
      rightUtilityPanelHidden: target ? false : state.rightUtilityPanelHidden,
    }));
  },

  openRightUtilityTab: (target, options) => {
    set((state) => {
      const opened = resolveRightUtilityTabOpen(state.rightUtilityTabs, target, options);
      const activeKind = getRightUtilityTabKind(opened.activeTab);
      const patch: Partial<Store> = {
        rightUtilityTabs: opened.tabs,
        activeRightUtilityTab: opened.activeTab,
        rightUtilityPanelHidden: false,
      };

      if (activeKind === 'files' || activeKind === 'review') {
        patch.projectPanelView = activeKind === 'review' ? 'changes' : 'files';
        patch.projectTreeCollapsed = false;
        patch.browserPanelOpen = false;
        patch.rightPanelFullscreen =
          state.rightPanelFullscreen === 'browser'
            ? null
            : state.rightPanelFullscreen === 'files' && activeKind === 'review'
              ? 'review'
              : state.rightPanelFullscreen === 'review' && activeKind === 'files'
                ? 'files'
                : state.rightPanelFullscreen;
      } else if (activeKind === 'browser') {
        patch.browserPanelOpen = true;
        patch.projectTreeCollapsed = true;
      } else {
        patch.browserPanelOpen = false;
        patch.projectTreeCollapsed = true;
        patch.rightPanelFullscreen = null;
      }

      return patch;
    });
  },

  setReviewDiffSelection: (selection) => {
    set({
      reviewDiffSelection: selection ? normalizeReviewDiffSelection(selection) : null,
    });
  },

  openReviewDiff: (selection) => {
    set((state) => {
      const opened = resolveRightUtilityTabOpen(state.rightUtilityTabs, 'review');
      return {
        reviewDiffSelection: normalizeReviewDiffSelection(selection),
        rightUtilityTabs: opened.tabs,
        activeRightUtilityTab: opened.activeTab,
        rightUtilityPanelHidden: false,
        projectPanelView: 'changes',
        projectTreeCollapsed: false,
        browserPanelOpen: false,
        rightPanelFullscreen:
          state.rightPanelFullscreen === 'browser'
            ? null
            : state.rightPanelFullscreen === 'files'
              ? 'review'
              : state.rightPanelFullscreen,
      };
    });
  },

  openSubagentPanel: (subagentId) => {
    // User-initiated (clicking a subagent in the inline board or env list):
    // open/focus that subagent's OWN top-level tab (`subagent:<id>` — there is
    // no wrapper tab). This is NOT the auto-steal-on-launch behavior the
    // review rejected — it only fires on an explicit click.
    set((state) => {
      const target: ProjectUtilityPanelTarget = `subagent:${subagentId}`;
      return {
        rightUtilityTabs: addRightUtilityTab(state.rightUtilityTabs, target),
        activeRightUtilityTab: target,
        rightUtilityPanelHidden: false,
        projectTreeCollapsed: true,
        browserPanelOpen: false,
      };
    });
  },

  closeRightUtilityTab: (target) => {
    set((state) => {
      const targetIndex = state.rightUtilityTabs.indexOf(target);
      const nextTabs = state.rightUtilityTabs.filter((tab) => tab !== target);
      const nextActiveTab =
        state.activeRightUtilityTab === target
          ? nextTabs[Math.max(0, targetIndex - 1)] ?? nextTabs[0] ?? null
          : state.activeRightUtilityTab;
      const patch: Partial<Store> = {
        rightUtilityTabs: nextTabs,
        activeRightUtilityTab: nextActiveTab,
      };

      if (state.activeRightUtilityTab === target && nextActiveTab) {
        const nextActiveKind = getRightUtilityTabKind(nextActiveTab);
        if (nextActiveKind === 'files' || nextActiveKind === 'review') {
          patch.projectPanelView = nextActiveKind === 'review' ? 'changes' : 'files';
          patch.projectTreeCollapsed = false;
          patch.browserPanelOpen = false;
        } else if (nextActiveKind === 'browser') {
          patch.projectTreeCollapsed = true;
          patch.browserPanelOpen = true;
        } else {
          patch.projectTreeCollapsed = true;
          patch.browserPanelOpen = false;
          patch.rightPanelFullscreen = null;
        }
      } else if (!nextActiveTab) {
        patch.projectTreeCollapsed = true;
        patch.browserPanelOpen = false;
        patch.rightPanelFullscreen = null;
        patch.rightUtilityPanelHidden = false;
      }
      const targetKind = getRightUtilityTabKind(target);
      if (targetKind === 'browser' && state.rightPanelFullscreen === 'browser') {
        patch.rightPanelFullscreen = null;
      }
      if (targetKind === 'files' && state.rightPanelFullscreen === 'files') {
        patch.rightPanelFullscreen = null;
      }
      if (targetKind === 'review' && state.rightPanelFullscreen === 'review') {
        patch.rightPanelFullscreen = null;
      }

      return patch;
    });
  },

  closeRightUtilityPanels: () => {
    // Keep the tab list and active tab so re-opening the panel restores the
    // previous layout; only the visibility flag flips.
    set({
      rightUtilityPanelHidden: true,
      projectTreeCollapsed: true,
      browserPanelOpen: false,
      rightPanelFullscreen: null,
    });
    persistUiResumeStateSnapshot(get());
  },

  showRightUtilityPanels: () => {
    set((state) => {
      if (state.rightUtilityTabs.length === 0) {
        return { rightUtilityPanelHidden: false };
      }
      const activeTab = state.activeRightUtilityTab ?? state.rightUtilityTabs[0];
      const activeKind = getRightUtilityTabKind(activeTab);
      return {
        rightUtilityPanelHidden: false,
        activeRightUtilityTab: activeTab,
        projectTreeCollapsed: !(activeKind === 'files' || activeKind === 'review'),
        projectPanelView:
          activeKind === 'review' ? 'changes' : activeKind === 'files' ? 'files' : state.projectPanelView,
        browserPanelOpen: activeKind === 'browser',
      };
    });
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
    set((state) => {
      const activeBrowserTab = isRightUtilityBrowserTab(state.activeRightUtilityTab)
        ? state.activeRightUtilityTab
        : null;
      const browserTab = activeBrowserTab ?? 'browser';
      return {
        browserPanelOpen,
        rightUtilityTabs: browserPanelOpen
          ? addRightUtilityTab(state.rightUtilityTabs, browserTab)
          : state.rightUtilityTabs,
        activeRightUtilityTab: browserPanelOpen ? browserTab : state.activeRightUtilityTab,
        rightUtilityPanelHidden: browserPanelOpen ? false : state.rightUtilityPanelHidden,
        rightPanelFullscreen:
          !browserPanelOpen && state.rightPanelFullscreen === 'browser'
            ? null
            : state.rightPanelFullscreen,
      };
    });
  },

  setRightPanelFullscreen: (target) => {
    if (target === 'browser') {
      set((state) => ({
        rightPanelFullscreen: 'browser',
        browserPanelOpen: true,
        projectTreeCollapsed: true,
        rightUtilityTabs: addRightUtilityTab(
          state.rightUtilityTabs,
          isRightUtilityBrowserTab(state.activeRightUtilityTab)
            ? state.activeRightUtilityTab
            : 'browser'
        ),
        activeRightUtilityTab: isRightUtilityBrowserTab(state.activeRightUtilityTab)
          ? state.activeRightUtilityTab
          : 'browser',
        rightUtilityPanelHidden: false,
      }));
      return;
    }
    if (target === 'files') {
      set((state) => {
        const opened = resolveRightUtilityTabOpen(state.rightUtilityTabs, 'files');
        return {
          rightPanelFullscreen: 'files',
          projectTreeCollapsed: false,
          browserPanelOpen: false,
          rightUtilityTabs: opened.tabs,
          activeRightUtilityTab: opened.activeTab,
          rightUtilityPanelHidden: false,
        };
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
      const chatPanes = normalizeChatPanes(resumeState.chatPanes, resumeState.activeSessionId, chatLayoutMode);
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

  createDraftSession: (cwd, channelId, workspace) => {
    const draftCwd = cwd ?? get().projectCwd;
    const draftProjectCwd = workspace?.projectCwd ?? draftCwd;
    const draftChannelId =
      channelId ?? resolveActiveChannelIdForProject(get().activeChannelByProject, draftProjectCwd);
    const draft = createDraftSessionView(draftCwd, draftChannelId, workspace);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [draft.id]: draft,
      },
      activeChannelByProject: {
        ...state.activeChannelByProject,
        [getProjectChannelKey(draftProjectCwd)]: normalizeWorkspaceChannelId(draftChannelId),
      },
      ...layoutPatch(
        tree.placeSession(state.workspaceLayout, tree.getActiveLeaf(state.workspaceLayout).id, draft.id)
      ),
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

      const { [sessionId]: _removed, ...rest } = state.sessions;
      // Vacate every leaf holding the removed draft (it stays as an empty pane).
      let layout = tree.clearMissingSessions(state.workspaceLayout, (sid) => sid in rest);
      // If the focused pane is now empty because it held the removed-and-active
      // draft, backfill it with the most recent remaining session.
      const activeLeaf = tree.getActiveLeaf(layout);
      if (activeLeaf.sessionId === null && state.activeSessionId === sessionId) {
        const fallback = Object.values(rest)
          .filter((item) => !item.hiddenFromThreads)
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .map((item) => item.id)[0];
        if (fallback) {
          layout = tree.placeSession(layout, activeLeaf.id, fallback);
        }
      }

      return {
        ...state,
        sessions: rest,
        ...layoutPatch(layout),
        showNewSession: tree.activeSessionId(layout) === null,
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

  setDraftStartMode: (sessionId, mode) =>
    set((state) => ({ draftStartMode: { ...state.draftStartMode, [sessionId]: mode } })),

  setActiveSettingsTab: (tab) => set({ activeSettingsTab: tab }),
  setAgentSetupOpen: (open) => set({ agentSetupOpen: open }),
  dismissAgentSetup: () =>
    set({
      agentSetupOpen: false,
      agentSetupDismissedAt: Date.now(),
    }),
  completeAgentSetup: () =>
    set({
      agentSetupOpen: false,
      agentSetupCompletedAt: Date.now(),
    }),
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
      // Origin-independent storage: localStorage is per-origin, and the dev
      // server ↔ file:// fallback origin flip silently reset drafts/flags.
      storage: createJSONStorage(() => rendererStateStorage),
      partialize: (state) => ({
        activeWorkspace: state.activeWorkspace,
        workspaceChannelsByProject: state.workspaceChannelsByProject,
        activeChannelByProject: state.activeChannelByProject,
        agentSetupDismissedAt: state.agentSetupDismissedAt,
        agentSetupCompletedAt: state.agentSetupCompletedAt,
        chatSidebarView: state.chatSidebarView,
        schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
        workspaceLayout: state.workspaceLayout,
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
          workspaceChannelsByProject?: Record<string, WorkspaceChannel[]>;
          activeChannelByProject?: Record<string, string>;
          agentSetupDismissedAt?: number | null;
          agentSetupCompletedAt?: number | null;
          chatSidebarView?: ChatSidebarView;
          schemaVersion?: number;
          workspaceLayout?: unknown;
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
        const uiFontFamily = persisted?.uiFontFamily?.trim()
          ? persisted.uiFontFamily
          : DEFAULT_UI_FONT_FAMILY;
        const chatCodeFontFamily = persisted?.chatCodeFontFamily ?? currentState.chatCodeFontFamily;
        // workspaceLayout is the source of truth; derive the legacy pane fields.
        const workspaceLayout = repairLayout(
          resolveWorkspaceLayout(persisted as Parameters<typeof resolveWorkspaceLayout>[0])
        );
        const derivedPaneFields = deriveLegacyFields(workspaceLayout);
        const chatLayoutMode = derivedPaneFields.chatLayoutMode;
        const savedSplitVisible = derivedPaneFields.savedSplitVisible;
        const activePaneId = derivedPaneFields.activePaneId;
        const chatPanes: Record<ChatPaneId, ChatPaneState> = {
          primary: {
            id: 'primary',
            sessionId: derivedPaneFields.chatPanes.primary.sessionId,
            surface: derivedPaneFields.chatPanes.primary.surface ?? 'chat',
          },
          secondary: {
            id: 'secondary',
            sessionId: derivedPaneFields.chatPanes.secondary.sessionId,
            surface: derivedPaneFields.chatPanes.secondary.surface ?? 'chat',
          },
        };
        const draftSessions = Object.fromEntries(
          Object.entries(persisted?.draftSessions || {}).filter(([, session]) => session?.isDraft)
        ) as Record<string, SessionView>;
        applyAppearance({
          theme,
          themeState,
          uiFontFamily,
          chatCodeFontFamily,
        });
        const activeWorkspace =
          persisted?.activeWorkspace === 'prompts' ||
          persisted?.activeWorkspace === 'skills' ||
          persisted?.activeWorkspace === 'automations'
            ? persisted.activeWorkspace
            : 'chat';
        const sidebarView = persisted?.chatSidebarView === 'skills' ? 'skills' : 'threads';

        return {
          ...currentState,
          sessions: {
            ...currentState.sessions,
            ...draftSessions,
          },
          activeWorkspace,
          workspaceChannelsByProject:
            persisted?.workspaceChannelsByProject || currentState.workspaceChannelsByProject,
          activeChannelByProject: persisted?.activeChannelByProject || currentState.activeChannelByProject,
          agentSetupOpen: false,
          agentSetupDismissedAt: persisted?.agentSetupDismissedAt ?? currentState.agentSetupDismissedAt,
          agentSetupCompletedAt: persisted?.agentSetupCompletedAt ?? currentState.agentSetupCompletedAt,
          chatSidebarView: sidebarView,
          workspaceLayout,
          chatLayoutMode,
          savedSplitVisible,
          activePaneId,
          chatPanes,
          chatSplitRatio: derivedPaneFields.chatSplitRatio,
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
  const nextActiveChannelByProject = { ...get().activeChannelByProject };
  const nextWorkspaceChannelsByProject = { ...get().workspaceChannelsByProject };

  for (const session of sessions) {
    const existing = get().sessions[session.id];
    const channelId = normalizeWorkspaceChannelId(session.channelId);
    const sessionScope = session.scope || 'project';
    if (sessionScope !== 'dm') {
      const projectKey = getProjectChannelKey(session.cwd);
      const projectChannels = ensureDefaultWorkspaceChannel(
        nextWorkspaceChannelsByProject[projectKey],
        session.cwd
      );
      if (!projectChannels.some((channel) => channel.id === channelId)) {
        const now = Date.now();
        nextWorkspaceChannelsByProject[projectKey] = [
          ...projectChannels,
          {
            id: channelId,
            projectCwd: session.cwd || '',
            name: channelId,
            createdAt: now,
            updatedAt: now,
          },
        ];
      } else {
        nextWorkspaceChannelsByProject[projectKey] = projectChannels;
      }
      if (!nextActiveChannelByProject[projectKey]) {
        nextActiveChannelByProject[projectKey] = channelId;
      }
    }
    sessionsMap[session.id] = {
      id: session.id,
      title: session.title,
      status: session.status,
      scope: sessionScope,
      agentId: session.agentId || null,
      source: session.source || 'aegis',
      readOnly: session.readOnly === true,
      cwd: session.cwd,
      projectCwd: session.projectCwd ?? session.cwd ?? null,
      envMode: session.envMode ?? (session.worktreePath ? 'worktree' : 'local'),
      worktreePath: session.worktreePath ?? null,
      associatedWorktreePath: session.associatedWorktreePath ?? null,
      associatedWorktreeBranch: session.associatedWorktreeBranch ?? null,
      associatedWorktreeRef: session.associatedWorktreeRef ?? null,
      claudeSessionId: session.claudeSessionId,
      provider: session.provider || 'claude',
      model: session.model,
      compatibleProviderId: session.compatibleProviderId,
      betas: session.betas,
      claudeAccessMode: normalizeClaudeAccessMode(session.claudeAccessMode),
      claudeExecutionMode: normalizeClaudeExecutionMode(session.claudeExecutionMode, session.claudeAccessMode),
      claudeReasoningEffort: normalizeClaudeReasoningEffort(session.claudeReasoningEffort),
      codexExecutionMode: normalizeCodexExecutionMode(session.codexExecutionMode),
      codexPermissionMode: session.codexPermissionMode,
      codexReasoningEffort: session.codexReasoningEffort,
      codexFastMode: session.codexFastMode,
      kimiPermissionMode: session.kimiPermissionMode,
      opencodePermissionMode: session.opencodePermissionMode,
      pinned: session.pinned || false,
      folderPath: session.folderPath || null,
      hiddenFromThreads: session.hiddenFromThreads === true,
      channelId,
      teamMode: normalizeSessionTeamMode(session.teamMode),
      teamId: session.teamId || null,
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

  // 默认选中最新更新的会话，但如果当前明确停留在 New Thread，就不要偷偷回填旧会话
  let activeSessionId = keepNewSessionOpen ? null : get().activeSessionId;
  if (
    !keepNewSessionOpen &&
    hasVisibleSessions &&
    (!activeSessionId || !sessionsMap[activeSessionId] || sessionsMap[activeSessionId].hiddenFromThreads)
  ) {
    activeSessionId = visibleSessionIds[0] || null;
  }

  // Reconcile every pane in the tree: drop sessions that no longer exist or are
  // hidden, then backfill the focused pane with the resolved active session.
  let layout = tree.clearMissingSessions(
    get().workspaceLayout,
    (sid) => Boolean(sessionsMap[sid]) && !sessionsMap[sid].hiddenFromThreads
  );
  if (!keepNewSessionOpen && activeSessionId) {
    const activeLeaf = tree.getActiveLeaf(layout);
    if (activeLeaf.sessionId === null) {
      layout = tree.placeSession(layout, activeLeaf.id, activeSessionId);
    }
  }

  set({
    sessions: sessionsMap,
    workspaceChannelsByProject: nextWorkspaceChannelsByProject,
    activeChannelByProject: nextActiveChannelByProject,
    ...layoutPatch(layout),
    // Honor an explicit "stay on New Thread" even if a pane still holds a session.
    activeSessionId: keepNewSessionOpen ? null : tree.activeSessionId(layout),
    showNewSession,
    sessionsLoaded: true,
  });
}

// 处理会话状态更新
function handleSessionStatus(
  payload: {
    sessionId: string;
    status: SessionInfo['status'];
    title?: string;
    scope?: SessionInfo['scope'];
    agentId?: SessionInfo['agentId'];
    cwd?: string;
    projectCwd?: SessionInfo['projectCwd'];
    envMode?: SessionInfo['envMode'];
    worktreePath?: SessionInfo['worktreePath'];
    associatedWorktreePath?: SessionInfo['associatedWorktreePath'];
    associatedWorktreeBranch?: SessionInfo['associatedWorktreeBranch'];
    associatedWorktreeRef?: SessionInfo['associatedWorktreeRef'];
    provider?: SessionInfo['provider'];
    model?: SessionInfo['model'];
    compatibleProviderId?: SessionInfo['compatibleProviderId'];
    betas?: SessionInfo['betas'];
    claudeAccessMode?: SessionInfo['claudeAccessMode'];
    claudeExecutionMode?: SessionInfo['claudeExecutionMode'];
    claudeReasoningEffort?: SessionInfo['claudeReasoningEffort'];
    codexExecutionMode?: SessionInfo['codexExecutionMode'];
    codexPermissionMode?: SessionInfo['codexPermissionMode'];
    codexReasoningEffort?: SessionInfo['codexReasoningEffort'];
    codexFastMode?: SessionInfo['codexFastMode'];
    kimiPermissionMode?: SessionInfo['kimiPermissionMode'];
    opencodePermissionMode?: SessionInfo['opencodePermissionMode'];
    hiddenFromThreads?: boolean;
    channelId?: string;
    teamMode?: SessionInfo['teamMode'];
    teamId?: SessionInfo['teamId'];
  },
  set: SetState,
  get: () => Store
) {
  const {
    sessionId,
    status,
    title,
    scope,
    agentId,
    cwd,
    projectCwd,
    envMode,
    worktreePath,
    associatedWorktreePath,
    associatedWorktreeBranch,
    associatedWorktreeRef,
    provider,
    model,
    compatibleProviderId,
    betas,
    claudeAccessMode,
    claudeExecutionMode,
    claudeReasoningEffort,
    codexExecutionMode,
    codexPermissionMode,
    codexReasoningEffort,
    codexFastMode,
    kimiPermissionMode,
    opencodePermissionMode,
    hiddenFromThreads,
    channelId,
    teamMode,
    teamId,
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
          scope: scope || session.scope || 'project',
          agentId:
            agentId !== undefined
              ? agentId || null
              : session.agentId ?? null,
          cwd: cwd || session.cwd,
          projectCwd:
            projectCwd !== undefined ? projectCwd : session.projectCwd ?? cwd ?? session.cwd ?? null,
          envMode: envMode ?? session.envMode ?? (worktreePath || session.worktreePath ? 'worktree' : 'local'),
          worktreePath: worktreePath !== undefined ? worktreePath : session.worktreePath ?? null,
          associatedWorktreePath:
            associatedWorktreePath !== undefined
              ? associatedWorktreePath
              : session.associatedWorktreePath ?? null,
          associatedWorktreeBranch:
            associatedWorktreeBranch !== undefined
              ? associatedWorktreeBranch
              : session.associatedWorktreeBranch ?? null,
          associatedWorktreeRef:
            associatedWorktreeRef !== undefined
              ? associatedWorktreeRef
              : session.associatedWorktreeRef ?? null,
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
              ? normalizeClaudeExecutionMode(claudeExecutionMode, claudeAccessMode)
              : normalizeClaudeExecutionMode(session.claudeExecutionMode, session.claudeAccessMode),
          claudeReasoningEffort:
            claudeReasoningEffort !== undefined
              ? normalizeClaudeReasoningEffort(claudeReasoningEffort)
              : normalizeClaudeReasoningEffort(session.claudeReasoningEffort),
          codexExecutionMode:
            codexExecutionMode !== undefined
              ? normalizeCodexExecutionMode(codexExecutionMode)
              : normalizeCodexExecutionMode(session.codexExecutionMode),
          codexPermissionMode:
            codexPermissionMode !== undefined ? codexPermissionMode : session.codexPermissionMode,
          codexReasoningEffort:
            codexReasoningEffort !== undefined
              ? codexReasoningEffort
              : session.codexReasoningEffort,
          codexFastMode:
            codexFastMode !== undefined ? codexFastMode : session.codexFastMode,
          kimiPermissionMode:
            kimiPermissionMode !== undefined ? kimiPermissionMode : session.kimiPermissionMode,
          opencodePermissionMode:
            opencodePermissionMode !== undefined
              ? opencodePermissionMode
              : session.opencodePermissionMode,
          hiddenFromThreads:
            hiddenFromThreads !== undefined ? hiddenFromThreads : session.hiddenFromThreads,
          channelId:
            channelId !== undefined
              ? normalizeWorkspaceChannelId(channelId)
              : normalizeWorkspaceChannelId(session.channelId),
          teamMode: teamMode !== undefined ? normalizeSessionTeamMode(teamMode) : session.teamMode || 'channel_default',
          teamId:
            teamId !== undefined
              ? teamId || null
              : session.teamId || null,
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
      scope: scope || 'project',
      agentId: agentId || null,
      source: 'aegis',
      readOnly: false,
      cwd,
      projectCwd: projectCwd ?? cwd ?? null,
      envMode: envMode ?? (worktreePath ? 'worktree' : 'local'),
      worktreePath: worktreePath ?? null,
      associatedWorktreePath: associatedWorktreePath ?? null,
      associatedWorktreeBranch: associatedWorktreeBranch ?? null,
      associatedWorktreeRef: associatedWorktreeRef ?? null,
      provider: provider || 'claude',
      model,
      compatibleProviderId,
      betas,
      claudeAccessMode: normalizeClaudeAccessMode(claudeAccessMode),
      claudeExecutionMode: normalizeClaudeExecutionMode(claudeExecutionMode, claudeAccessMode),
      claudeReasoningEffort: normalizeClaudeReasoningEffort(claudeReasoningEffort),
      codexExecutionMode: normalizeCodexExecutionMode(codexExecutionMode),
      codexPermissionMode,
      codexReasoningEffort,
      codexFastMode,
      kimiPermissionMode,
      opencodePermissionMode,
      hiddenFromThreads: hiddenFromThreads === true,
      channelId: normalizeWorkspaceChannelId(channelId),
      teamMode: teamMode !== undefined ? normalizeSessionTeamMode(teamMode) : 'channel_default',
      teamId: teamId || null,
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
    const sessionsAfter = {
      ...nextSessions,
      [sessionId]: newSession,
    };

    // Update the workspace layout tree (source of truth), not just legacy
    // chatPanes. The pending draft was just removed from sessions, so vacate any
    // leaf still holding it; then place the new real session into the focused
    // pane. Without this the active leaf keeps the dead draft id and renders the
    // empty "Drop a conversation here" state even though the session exists.
    let layout = state.workspaceLayout;
    if (pendingDraftSessionId) {
      layout = tree.clearMissingSessions(layout, (sid) => sid in sessionsAfter);
    }
    if (shouldFocusNewSession) {
      layout = tree.placeSession(layout, tree.getActiveLeaf(layout).id, sessionId);
    }

    set({
      sessions: sessionsAfter,
      activeChannelByProject: applyActiveProjectChannel(state.activeChannelByProject, newSession),
      ...layoutPatch(layout),
      activeSessionId: shouldFocusNewSession ? sessionId : state.activeSessionId,
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
  const { [sessionId]: _deleted, ...rest } = state.sessions;

  // Vacate every pane holding the deleted session; backfill the focused pane if
  // it was showing the deleted (active) session.
  let layout = tree.clearMissingSessions(state.workspaceLayout, (sid) => sid in rest);
  if (state.activeSessionId === sessionId) {
    const activeLeaf = tree.getActiveLeaf(layout);
    if (activeLeaf.sessionId === null) {
      const fallback = Object.keys(rest)[0];
      if (fallback) layout = tree.placeSession(layout, activeLeaf.id, fallback);
    }
  }

  set({
    sessions: rest,
    ...layoutPatch(layout),
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
function mergeMcpServerStatus(
  current: McpServerStatus[],
  incoming: McpServerStatus[],
  tool?: McpServerStatus['tool']
): McpServerStatus[] {
  if (!tool) {
    // No tool tag: replace by name only (legacy behavior).
    const byName = new Map(incoming.map((s) => [s.name, s]));
    return [...current.filter((s) => !byName.has(s.name)), ...incoming];
  }
  // Replace only this tool's entries; keep other tools' entries intact so
  // Claude and Codex statuses coexist without cross-agent name collisions.
  const incomingNames = new Set(incoming.map((s) => s.name));
  return [
    ...current.filter((s) => s.tool !== tool || !incomingNames.has(s.name)),
    ...incoming,
  ];
}

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
    (session?.provider === 'claude' || session?.provider === 'codex') &&
    activeSessionId === sessionId &&
    message.compactMetadata.trigger === 'auto'
  ) {
    const providerName = session.provider === 'codex' ? 'Codex' : 'Claude';
    toast.success(`${providerName} auto-compacted the conversation context.`);
  }

  // Update global MCP server status from init/mcp_status stream messages.
  // Claude reports status via system/init.mcp_servers; Codex via mcp_status.
  // OpenCode SDK and Codex can report MCP status; Kimi/Grok protocols stay Unknown.
  if (
    message.type === 'mcp_status' ||
    (message.type === 'system' &&
      message.subtype === 'init' &&
      Array.isArray(message.mcp_servers) &&
      message.mcp_servers.length > 0)
  ) {
    const provider = session?.provider;
    const tool: McpServerStatus['tool'] | undefined =
      provider === 'claude' ||
      provider === 'codex' ||
      provider === 'opencode' ||
      provider === 'kimi' ||
      provider === 'grok' ||
      provider === 'pi'
        ? provider
        : undefined;
    const incoming: McpServerStatus[] =
      message.type === 'mcp_status'
        ? message.servers
        : message.mcp_servers.map((s) => ({
            name: s.name,
            status: s.status,
            ...(s.error ? { error: s.error } : {}),
          }));
    const tagged = incoming.map((s) => ({ ...s, tool: tool ?? s.tool }));
    set((state) => ({
      mcpServerStatus: mergeMcpServerStatus(state.mcpServerStatus, tagged, tool),
    }));
    // mcp_status is a status-only update, not a transcript message.
    if (message.type === 'mcp_status') return;
  }

  set((state) => {
    const currentSession = state.sessions[sessionId];
    if (!currentSession) return state;

    // Subagent (Task) stream events must never touch the top-level streaming
    // buffer — otherwise subagent text/thinking deltas splice into the main
    // assistant bubble, and a subagent content_block_stop wipes an in-flight
    // top-level partial.
    if (message.type === 'stream_event' && message.parentToolUseId) {
      return state;
    }

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

// 处理 Session channel 变更
function handleSessionChannelChanged(
  payload: { sessionId: string; channelId: string },
  set: SetState,
  get: () => Store
) {
  const { sessionId, channelId } = payload;
  const session = get().sessions[sessionId];
  if (!session) return;

  const normalizedChannelId = normalizeWorkspaceChannelId(channelId);
  set({
    sessions: {
      ...get().sessions,
      [sessionId]: {
        ...session,
        channelId: normalizedChannelId,
        updatedAt: Date.now(),
      },
    },
    activeChannelByProject: {
      ...get().activeChannelByProject,
      [getProjectChannelKey(session.cwd)]: normalizedChannelId,
    },
  });
}

function handleSessionTeamChanged(
  payload: { sessionId: string; teamMode: SessionTeamMode; teamId: string | null },
  set: SetState,
  get: () => Store
) {
  const { sessionId, teamMode, teamId } = payload;
  const session = get().sessions[sessionId];
  if (!session) return;

  set({
    sessions: {
      ...get().sessions,
      [sessionId]: {
        ...session,
        teamMode: normalizeSessionTeamMode(teamMode),
        teamId: teamId || null,
        updatedAt: Date.now(),
      },
    },
  });
}
