// UI 层类型定义

// Settings 标签类型
export type SettingsTab = 'mcp' | 'general' | 'providers' | 'usage' | 'bridge';

import type { ChromeTheme, ThemeFonts, ThemeMode, ThemePack, ThemeState, ThemeVariant } from './theme/theme-types';
// 从共享类型导入
import type {
  AgentProvider,
  AppUpdateStatus,
  ClaudeCompatibleProviderId,
  ClaudeCompatibleProviderConfig,
  ClaudeCompatibleProvidersConfig,
  ClaudeReasoningEffort,
  CodexReasoningEffort,
  ProjectTreeNode,
  FolderConfig,
  GitPatchScope,
  SessionScope,
  WorkspaceChannel,
} from '../shared/types';

export type {
  SessionInfo,
  SessionStatus,
  StreamMessage,
  Attachment,
  ProjectTreeNode,
  AskUserQuestionInput,
  AskUserQuestion,
  AcpPermissionInput,
  AcpPermissionOption,
  CodexApprovalPermissionInput,
  ExternalFilePermissionInput,
  PermissionRequestInput,
  ContentBlock,
  PermissionRequestPayload,
  PermissionResult,
  ClientEvent,
  ServerEvent,
  AppUpdateStatus,
  AutomationDefinition,
  AutomationRunRecord,
  AutomationSchedule,
  AutomationSnapshot,
  UiResumeState,
  McpServerConfig,
  McpServerStatus,
  AvailableCommand,
  ClaudeSkillSummary,
  ClaudeModelConfig,
  ClaudeCompatibleProviderId,
  ClaudePermissionMode,
  ClaudeAccessMode,
  ClaudeExecutionMode,
  ClaudeReasoningEffort,
  ClaudeReasoningLevelOption,
  CodexExecutionMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexReasoningLevelOption,
  PlanStep,
  PlanStepStatus,
  OpenCodePermissionMode,
  ClaudeUsageDailyPoint,
  ClaudeUsageModelSummary,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
  CodexRateLimitReport,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  ChatSessionSearchResult,
  SessionHistoryPayload,
  ClaudeModelUsage,
  LatestClaudeModelUsage,
  CodexModelConfig,
  CodexRuntimeStatus,
  OpenCodeModelConfig,
  OpenCodeRuntimeStatus,
  KimiModelConfig,
  GrokModelConfig,
  PiModelConfig,
  KimiPermissionMode,
  KimiRuntimeStatus,
  GrokRuntimeStatus,
  ClaudeRuntimeStatus,
  SkillMarketDetail,
  SkillMarketInstallResult,
  SkillMarketItem,
  FontFormat,
  FontSelection,
  FontSelectionSource,
  FontSettingsPayload,
  FontSlot,
  ImportedFontFace,
  SystemFontOption,
  FeishuBridgeConfig,
  FeishuBridgeStatus,
  MemoryDocument,
  MemoryWorkspace,
  AgentProvider,
  UpsertAutomationInput,
  WechatMarkdownHtmlGeneratorConfig,
  ProviderComposerCapabilities,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderPluginMarketplaceDescriptor,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
  ProviderInputReference,
  ProviderSkillDescriptor,
  AgentRuntimeDirectoryReport,
  AgentRuntimeEntry,
  AgentRuntimeState,
  SessionSource,
  SessionScope,
  PromptLibraryItem,
  UpsertPromptLibraryItemInput,
  PromptLibraryImportResult,
  PromptLibraryExportResult,
  FolderConfig,
  GitPatchScope,
  GitPatchResult,
  CanonicalToolKind,
  WorkspaceChannel,
  SessionTeamMode,
} from '../shared/types';

// 主题类型
export type Theme = ThemeMode;
export type { ChromeTheme, ThemeFonts, ThemePack, ThemeState, ThemeVariant };
export type ChatLayoutMode = 'single' | 'split';
export type ChatPaneId = 'primary' | 'secondary';
export type WorkspaceSurface = 'chat' | 'terminal';

export interface ChatPaneState {
  id: ChatPaneId;
  sessionId: string | null;
  surface: WorkspaceSurface;
}

export interface SessionStreamingState {
  isStreaming: boolean;
  text: string;
  thinking: string;
}

export type ActiveWorkspace = 'chat' | 'skills' | 'prompts' | 'automations';
export type ChatSidebarView = 'threads' | 'prompts' | 'skills';
export type ProjectPanelView = 'files' | 'changes';
export type ProjectUtilityPanelKind = 'files' | 'side-chat' | 'browser' | 'review' | 'terminal';
export type ProjectUtilityPanelTarget =
  | ProjectUtilityPanelKind
  | `files:${string}`
  | `browser:${string}`;
export type ProjectUtilityTabDescriptor = {
  id: ProjectUtilityPanelTarget;
  kind: ProjectUtilityPanelKind;
  label: string;
};

export type ReviewDiffSource =
  | {
      kind: 'turn';
      turnKey: string;
      label: string;
      sessionId?: string | null;
    }
  | {
      kind: 'workspace';
      scope: GitPatchScope;
      label?: string | null;
    };

export interface ReviewDiffSelection {
  source: ReviewDiffSource;
  records?: import('./utils/change-records').ChangeRecord[];
  selectedRecordId?: string | null;
  selectedFilePath?: string | null;
  requestedAt: number;
}

export type ReviewDiffSelectionInput = Omit<ReviewDiffSelection, 'requestedAt'> & {
  requestedAt?: number;
};

// Fan-out 布局条目：chat 成员是 session，custom 成员是 PTY 终端
export type RunGroupPaneEntry =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'terminal'; threadId: string; cwd: string; title?: string };

// UI 会话视图状态
export interface SessionView {
  id: string;
  title: string;
  status: import('../shared/types').SessionStatus;
  scope?: SessionScope;
  agentId?: string | null;
  cwd?: string;
  projectCwd?: string | null;
  envMode?: import('../shared/types').ThreadEnvironmentMode;
  worktreePath?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  claudeSessionId?: string;
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: import('../shared/types').ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: import('../shared/types').ClaudeAccessMode;
  claudeExecutionMode?: import('../shared/types').ClaudeExecutionMode;
  claudeReasoningEffort?: import('../shared/types').ClaudeReasoningEffort;
  codexExecutionMode?: import('../shared/types').CodexExecutionMode;
  codexPermissionMode?: import('../shared/types').CodexPermissionMode;
  codexReasoningEffort?: import('../shared/types').CodexReasoningEffort;
  codexFastMode?: boolean;
  kimiPermissionMode?: import('../shared/types').KimiPermissionMode;
  opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode;
  pinned?: boolean;
  folderPath?: string | null;
  hiddenFromThreads?: boolean;
  channelId?: string;
  teamMode?: import('../shared/types').SessionTeamMode;
  teamId?: string | null;
  runGroupId?: string | null;
  source?: import('../shared/types').SessionSource;
  readOnly?: boolean;
  isDraft?: boolean;
  latestClaudeModelUsage?: import('../shared/types').LatestClaudeModelUsage;
  messages: import('../shared/types').StreamMessage[];
  hydrated: boolean;
  historyCursor?: string | null;
  hasMoreHistory?: boolean;
  loadingMoreHistory?: boolean;
  permissionRequests: import('../shared/types').PermissionRequestPayload[];
  streaming: SessionStreamingState;
  runtimeNotice?: 'completed' | 'error';
  updatedAt: number;
}

// Store 状态
export interface AppState {
  connected: boolean;
  sessions: Record<string, SessionView>;
  workspaceChannelsByProject: Record<string, WorkspaceChannel[]>;
  activeChannelByProject: Record<string, string>;
  activeSessionId: string | null;
  activeWorkspace: ActiveWorkspace;
  chatSidebarView: ChatSidebarView;
  // Source of truth for the chat workspace layout (recursive tiling tree).
  workspaceLayout: import('./store/layout-tree').WorkspaceLayout;
  // Legacy two-pane fields, DERIVED from workspaceLayout after every change so
  // existing consumers keep working. Do not write these directly.
  chatLayoutMode: ChatLayoutMode;
  savedSplitVisible: boolean;
  activePaneId: ChatPaneId;
  chatPanes: Record<ChatPaneId, ChatPaneState>;
  chatSplitRatio: number;
  showNewSession: boolean;
  newSessionKey: number;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  globalError: string | null;
  pendingStart: boolean;
  pendingDraftSessionId: string | null;
  projectCwd: string | null;
  projectTreeCwd: string | null;
  projectTree: ProjectTreeNode | null;
  projectTreeCollapsed: boolean;
  projectPanelView: ProjectPanelView;
  rightUtilityTabs: ProjectUtilityPanelTarget[];
  activeRightUtilityTab: ProjectUtilityPanelTarget | null;
  rightUtilityPanelHidden: boolean;
  reviewDiffSelection: ReviewDiffSelection | null;
  terminalDrawerOpen: boolean;
  terminalDrawerHeight: number;
  browserPanelOpen: boolean;
  rightPanelFullscreen: 'browser' | 'files' | 'review' | null;
  sessionsLoaded: boolean;
  // 搜索状态
  sidebarSearchQuery: string;
  activeFilters: SearchFilters;
  inSessionSearchOpen: boolean;
  inSessionSearchQuery: string;
  inSessionSearchResults: SearchMatch[];
  inSessionSearchCurrentIndex: number;
  searchPaletteOpen: boolean;
  historyNavigationTarget: {
    sessionId: string;
    messageCreatedAt: number;
    nonce: number;
  } | null;
  // MCP 状态
  mcpServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpGlobalServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpProjectServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpCodexGlobalServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpOpencodeGlobalServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpOpencodeProjectServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpKimiGlobalServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpKimiProjectServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpServerStatus: import('../shared/types').McpServerStatus[];
  claudeUserSkills: import('../shared/types').ClaudeSkillSummary[];
  claudeProjectSkills: import('../shared/types').ClaudeSkillSummary[];
  claudeSkillsUserRoot: string;
  claudeSkillsProjectRoot?: string;
  // Settings 状态
  showSettings: boolean;
  // 打开中的 fan-out 比较视图（overlay）；null = 关闭
  runGroupViewId: string | null;
  // custom（终端）成员的 pane 附着信息：key = PTY threadId（terminal leaf 的 sessionId）
  runGroupTerminalPanes: Record<string, { threadId: string; cwd: string; title?: string }>;
  activeSettingsTab: SettingsTab;
  agentSetupOpen: boolean;
  agentSetupDismissedAt: number | null;
  agentSetupCompletedAt: number | null;
  updateStatus: AppUpdateStatus;
  promptLibraryInsertRequest: PromptLibraryInsertRequest | null;
  pendingChatInjection: ChatInjectionRequest | null;
  // 文件夹
  folderConfigs: FolderConfig[];
  // 主题
  theme: Theme;
  themeState: ThemeState;
  uiFontFamily: string;
  chatCodeFontFamily: string;
}

// Store Actions
export interface AppActions {
  setConnected: (connected: boolean) => void;
  handleServerEvent: (event: import('../shared/types').ServerEvent) => void;
  setActiveSession: (sessionId: string | null) => void;
  // Fan-out 成员的一次性平铺布局：首个装入聚焦 leaf，其余按右/下分裂（最多 4 个平铺）。
  // chat 成员放 session；custom 成员放 terminal leaf（sessionId = PTY threadId）。
  layoutRunGroupPanes: (entries: RunGroupPaneEntry[]) => void;
  // 单独打开一个 custom 成员的终端 pane（从 Fan-outs 列表/比较视图进入）
  openRunGroupTerminal: (entry: { threadId: string; cwd: string; title?: string }) => void;
  setRunGroupViewId: (groupId: string | null) => void;
  setActiveWorkspace: (workspace: ActiveWorkspace) => void;
  setChatSidebarView: (view: ChatSidebarView) => void;
  createWorkspaceChannel: (projectCwd: string, name: string) => string | null;
  renameWorkspaceChannel: (projectCwd: string, channelId: string, newName: string) => boolean;
  setActiveChannelForProject: (projectCwd: string, channelId: string) => void;
  setSessionChannel: (sessionId: string, channelId: string) => void;
  setSessionTeam: (
    sessionId: string,
    teamMode: import('../shared/types').SessionTeamMode,
    teamId?: string | null
  ) => void;
  setActivePane: (paneId: ChatPaneId) => void;
  setChatLayoutMode: (mode: ChatLayoutMode) => void;
  setSavedSplitVisible: (visible: boolean) => void;
  setChatPaneSession: (paneId: ChatPaneId, sessionId: string | null) => void;
  setChatPaneSurface: (paneId: ChatPaneId, surface: WorkspaceSurface) => void;
  setChatSplitRatio: (ratio: number) => void;
  openSplitChat: (paneId: ChatPaneId, sessionId: string | null) => void;
  closeSplitChat: () => void;
  swapChatPanes: () => void;
  // Recursive tiling actions (operate on workspaceLayout by leaf id).
  splitPaneAt: (
    leafId: string,
    edge: import('./store/layout-tree').SplitEdge,
    sessionId: string | null
  ) => void;
  closePaneById: (leafId: string) => void;
  resizeSplitById: (splitId: string, sizes: number[]) => void;
  setActivePaneById: (leafId: string) => void;
  placeSessionInPane: (leafId: string, sessionId: string | null) => void;
  movePaneTo: (
    leafId: string,
    targetLeafId: string,
    edge: import('./store/layout-tree').SplitEdge
  ) => void;
  // Fork a session's conversation and open the fork in a new pane.
  forkSessionToPane: (sessionId: string) => Promise<void>;
  setShowNewSession: (show: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setProjectCwd: (cwd: string | null) => void;
  setProjectTree: (cwd: string | null, tree: ProjectTreeNode | null) => void;
  setProjectTreeCollapsed: (collapsed: boolean) => void;
  setProjectPanelView: (view: ProjectPanelView) => void;
  setActiveRightUtilityTab: (target: ProjectUtilityPanelTarget | null) => void;
  openRightUtilityTab: (
    target: ProjectUtilityPanelKind,
    options?: { newTab?: boolean }
  ) => void;
  setReviewDiffSelection: (selection: ReviewDiffSelectionInput | null) => void;
  openReviewDiff: (selection: ReviewDiffSelectionInput) => void;
  closeRightUtilityTab: (target: ProjectUtilityPanelTarget) => void;
  closeRightUtilityPanels: () => void;
  showRightUtilityPanels: () => void;
  setTerminalDrawerOpen: (open: boolean) => void;
  setTerminalDrawerHeight: (height: number) => void;
  setBrowserPanelOpen: (open: boolean) => void;
  setRightPanelFullscreen: (target: 'browser' | 'files' | 'review' | null) => void;
  applyUiResumeState: (state: import('../shared/types').UiResumeState | null) => void;
  clearGlobalError: () => void;
  setPendingStart: (pending: boolean) => void;
  createDraftSession: (
    cwd?: string | null,
    channelId?: string | null,
    workspace?: Partial<Pick<
      SessionView,
      | 'projectCwd'
      | 'envMode'
      | 'worktreePath'
      | 'associatedWorktreePath'
      | 'associatedWorktreeBranch'
      | 'associatedWorktreeRef'
      | 'title'
    >>
  ) => string;
  removeDraftSession: (sessionId: string) => void;
  loadOlderSessionHistory: (sessionId: string) => void;
  removePermissionRequest: (sessionId: string, toolUseId: string) => void;
  // 搜索 Actions
  setSidebarSearchQuery: (query: string) => void;
  setActiveFilters: (filters: Partial<SearchFilters>) => void;
  clearFilters: () => void;
  openInSessionSearch: () => void;
  closeInSessionSearch: () => void;
  setInSessionSearchQuery: (query: string) => void;
  setInSessionSearchResults: (results: SearchMatch[]) => void;
  navigateSearchResult: (direction: 'next' | 'prev') => void;
  setSearchPaletteOpen: (open: boolean) => void;
  toggleSearchPalette: () => void;
  setHistoryNavigationTarget: (target: AppState['historyNavigationTarget']) => void;
  // MCP Actions
  setMcpServers: (servers: Record<string, import('../shared/types').McpServerConfig>) => void;
  setMcpServerStatus: (status: import('../shared/types').McpServerStatus[]) => void;
  // Settings Actions
  setShowSettings: (show: boolean) => void;
  setActiveSettingsTab: (tab: SettingsTab) => void;
  setAgentSetupOpen: (open: boolean) => void;
  dismissAgentSetup: () => void;
  completeAgentSetup: () => void;
  requestPromptLibraryInsert: (content: string, mode?: PromptLibraryInsertMode) => void;
  consumePromptLibraryInsert: (nonce: number) => void;
  requestChatInjection: (request: Omit<ChatInjectionRequest, 'nonce'>) => void;
  consumeChatInjection: (nonce: number) => void;
  // 文件夹 Actions
  setFolderConfigs: (configs: FolderConfig[]) => void;
  // 主题 Actions
  setTheme: (theme: Theme) => void;
  setThemeState: (themeState: ThemeState) => void;
  updateThemeVariant: (variant: ThemeVariant, patch: Partial<ChromeTheme>) => void;
  setThemeVariantCodeThemeId: (variant: ThemeVariant, codeThemeId: string) => void;
  setThemeVariantFonts: (variant: ThemeVariant, patch: Partial<ThemeFonts>) => void;
  resetThemeVariant: (variant: ThemeVariant) => void;
  setUiFontFamily: (value: string) => void;
  setChatCodeFontFamily: (value: string) => void;
}

export type PromptLibraryInsertMode = 'append' | 'replace';

export interface PromptLibraryInsertRequest {
  content: string;
  mode: PromptLibraryInsertMode;
  nonce: number;
}

// Request to inject text/attachments into the active chat composer from
// elsewhere in the app (e.g. browser panel screenshot or readout).
export interface ChatInjectionRequest {
  sessionId: string | null; // null => any active chat
  text?: string;
  attachments?: import('../shared/types').Attachment[];
  mode: 'append' | 'replace';
  nonce: number;
  source?: string;
}

// 工具状态映射（用于显示 pending/success/error）
export type ToolStatus = 'pending' | 'success' | 'error';

// 搜索匹配结果
export interface SearchMatch {
  messageIndex: number;
  snippet: string;
  createdAt?: number;
}

// 搜索过滤器
export interface SearchFilters {
  timeRange: 'all' | 'today' | 'week' | 'month';
  cwd?: string;
}

// 搜索状态
export interface SearchState {
  sidebarSearchQuery: string;
  activeFilters: SearchFilters;
  inSessionSearchOpen: boolean;
  inSessionSearchQuery: string;
  inSessionSearchResults: SearchMatch[];
  inSessionSearchCurrentIndex: number;
  searchPaletteOpen: boolean;
  historyNavigationTarget: AppState['historyNavigationTarget'];
}

// 搜索 Actions
export interface SearchActions {
  setSidebarSearchQuery: (query: string) => void;
  setActiveFilters: (filters: Partial<SearchFilters>) => void;
  clearFilters: () => void;
  openInSessionSearch: () => void;
  closeInSessionSearch: () => void;
  setInSessionSearchQuery: (query: string) => void;
  setInSessionSearchResults: (results: SearchMatch[]) => void;
  navigateSearchResult: (direction: 'next' | 'prev') => void;
  setSearchPaletteOpen: (open: boolean) => void;
  toggleSearchPalette: () => void;
  setHistoryNavigationTarget: (target: AppState['historyNavigationTarget']) => void;
}

// Turn Phase 状态机类型
export type TurnPhase =
  | 'pending'      // 刚开始，无任何输出
  | 'awaiting'     // 工具完成，等待下一步
  | 'tool_active'  // 工具正在执行
  | 'streaming'    // 最终回复正在流式输出
  | 'complete';    // 回合完成

// 缓冲配置
export interface BufferConfig {
  MIN_BUFFER_MS: number;
  MAX_BUFFER_MS: number;
  MIN_WORDS_STANDARD: number;
  MIN_WORDS_STRUCTURED: number;
}

// 默认缓冲配置
export const DEFAULT_BUFFER_CONFIG: BufferConfig = {
  MIN_BUFFER_MS: 500,
  MAX_BUFFER_MS: 2500,
  MIN_WORDS_STANDARD: 15,
  MIN_WORDS_STRUCTURED: 8,
};
