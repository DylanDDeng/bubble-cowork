// UI 层类型定义

// Settings 标签类型
export type SettingsTab = 'mcp' | 'general' | 'agents' | 'providers' | 'usage' | 'bridge' | 'memory';

import type { ChromeTheme, ThemeFonts, ThemeMode, ThemePack, ThemeState, ThemeVariant } from './theme/theme-types';
// 从共享类型导入
import type {
  AgentProvider,
  AppUpdateStatus,
  ClaudeCompatibleProviderId,
  ClaudeReasoningEffort,
  CodexReasoningEffort,
  ProjectTreeNode,
  FolderConfig,
  SessionScope,
} from '../shared/types';

export type {
  SessionInfo,
  SessionStatus,
  StreamMessage,
  Attachment,
  ProjectTreeNode,
  AskUserQuestionInput,
  AskUserQuestion,
  CodexApprovalPermissionInput,
  ExternalFilePermissionInput,
  PermissionRequestInput,
  ContentBlock,
  PermissionRequestPayload,
  PermissionResult,
  ClientEvent,
  ServerEvent,
  AppUpdateStatus,
  UiResumeState,
  McpServerConfig,
  McpServerStatus,
  AvailableCommand,
  ClaudeSkillSummary,
  ClaudeModelConfig,
  ClaudeCompatibleProviderId,
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
  ChatSessionSearchResult,
  SessionHistoryPayload,
  ClaudeModelUsage,
  LatestClaudeModelUsage,
  CodexModelConfig,
  CodexRuntimeStatus,
  OpenCodeModelConfig,
  OpenCodeRuntimeStatus,
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
  SessionSource,
  SessionScope,
  PromptLibraryItem,
  UpsertPromptLibraryItemInput,
  PromptLibraryImportResult,
  PromptLibraryExportResult,
  FolderConfig,
  CanonicalToolKind,
  WorkspaceChannel,
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

export type ActiveWorkspace = 'chat' | 'skills' | 'prompts';
export type ChatSidebarView = 'threads' | 'prompts' | 'skills';
export type ProjectPanelView = 'files' | 'changes';
export type AgentProfileColor = 'amber' | 'sky' | 'emerald' | 'violet' | 'rose' | 'slate';
export type AgentPermissionPolicy = 'ask' | 'readOnly' | 'fullAccess';
export type AgentReasoningEffort = ClaudeReasoningEffort | CodexReasoningEffort;
export type AgentAvatarAssetKey =
  | 'notion-avatar-01'
  | 'notion-avatar-02'
  | 'notion-avatar-03'
  | 'notion-avatar-04'
  | 'notion-avatar-05';

export interface AgentProfileAvatar {
  type: 'asset';
  key: AgentAvatarAssetKey;
}

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  description: string;
  instructions: string;
  avatar: AgentProfileAvatar;
  provider: AgentProvider;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  reasoningEffort?: AgentReasoningEffort;
  permissionPolicy: AgentPermissionPolicy;
  canDelegate?: boolean;
  color: AgentProfileColor;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// UI 会话视图状态
export interface SessionView {
  id: string;
  title: string;
  status: import('../shared/types').SessionStatus;
  scope?: SessionScope;
  agentId?: string | null;
  cwd?: string;
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
  opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode;
  pinned?: boolean;
  folderPath?: string | null;
  hiddenFromThreads?: boolean;
  channelId?: string;
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
  agentProfiles: Record<string, AgentProfile>;
  projectAgentRostersByProject: Record<string, string[]>;
  activeSessionId: string | null;
  activeWorkspace: ActiveWorkspace;
  chatSidebarView: ChatSidebarView;
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
  terminalDrawerOpen: boolean;
  terminalDrawerHeight: number;
  browserPanelOpen: boolean;
  browserPanelWidth: number;
  rightPanelFullscreen: 'browser' | 'files' | null;
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
  mcpServerStatus: import('../shared/types').McpServerStatus[];
  claudeUserSkills: import('../shared/types').ClaudeSkillSummary[];
  claudeProjectSkills: import('../shared/types').ClaudeSkillSummary[];
  claudeSkillsUserRoot: string;
  claudeSkillsProjectRoot?: string;
  // Settings 状态
  showSettings: boolean;
  activeSettingsTab: SettingsTab;
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
  setActiveWorkspace: (workspace: ActiveWorkspace) => void;
  setChatSidebarView: (view: ChatSidebarView) => void;
  createWorkspaceChannel: (projectCwd: string, name: string) => string | null;
  setActiveChannelForProject: (projectCwd: string, channelId: string) => void;
  setSessionChannel: (sessionId: string, channelId: string) => void;
  createAgentProfile: () => string;
  updateAgentProfile: (profileId: string, patch: Partial<Omit<AgentProfile, 'id' | 'createdAt'>>) => void;
  deleteAgentProfile: (profileId: string) => void;
  setProjectAgentRoster: (projectCwd: string, profileIds: string[]) => void;
  openAgentDirectMessage: (profileId: string) => string | null;
  setActivePane: (paneId: ChatPaneId) => void;
  setChatLayoutMode: (mode: ChatLayoutMode) => void;
  setSavedSplitVisible: (visible: boolean) => void;
  setChatPaneSession: (paneId: ChatPaneId, sessionId: string | null) => void;
  setChatPaneSurface: (paneId: ChatPaneId, surface: WorkspaceSurface) => void;
  setChatSplitRatio: (ratio: number) => void;
  openSplitChat: (paneId: ChatPaneId, sessionId: string) => void;
  closeSplitChat: () => void;
  swapChatPanes: () => void;
  setShowNewSession: (show: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setProjectCwd: (cwd: string | null) => void;
  setProjectTree: (cwd: string | null, tree: ProjectTreeNode | null) => void;
  setProjectTreeCollapsed: (collapsed: boolean) => void;
  setProjectPanelView: (view: ProjectPanelView) => void;
  setTerminalDrawerOpen: (open: boolean) => void;
  setTerminalDrawerHeight: (height: number) => void;
  setBrowserPanelOpen: (open: boolean) => void;
  setBrowserPanelWidth: (width: number) => void;
  setRightPanelFullscreen: (target: 'browser' | 'files' | null) => void;
  applyUiResumeState: (state: import('../shared/types').UiResumeState | null) => void;
  clearGlobalError: () => void;
  setPendingStart: (pending: boolean) => void;
  createDraftSession: (cwd?: string | null, channelId?: string | null) => string;
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
