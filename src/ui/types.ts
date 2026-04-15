// UI 层类型定义

// Settings 标签类型
export type SettingsTab = 'mcp' | 'general' | 'providers' | 'usage' | 'bridge' | 'memory';

// 从共享类型导入
import type { AgentProvider, ProjectTreeNode, TodoState, StatusConfig, FolderConfig } from '../shared/types';

export type {
  SessionInfo,
  SessionStatus,
  StreamMessage,
  Attachment,
  ProjectTreeNode,
  AskUserQuestionInput,
  AskUserQuestion,
  ExternalFilePermissionInput,
  PermissionRequestInput,
  ContentBlock,
  PermissionRequestPayload,
  PermissionResult,
  ClientEvent,
  ServerEvent,
  UiResumeState,
  McpServerConfig,
  McpServerStatus,
  AvailableCommand,
  ClaudeSkillSummary,
  ClaudeModelConfig,
  ClaudeCompatibleProviderId,
  ClaudeAccessMode,
  ClaudeExecutionMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexReasoningLevelOption,
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
  SessionSource,
  PromptLibraryItem,
  UpsertPromptLibraryItemInput,
  PromptLibraryImportResult,
  PromptLibraryExportResult,
  TodoState,
  StatusConfig,
  StatusCategory,
  CreateStatusInput,
  UpdateStatusInput,
  FolderConfig,
} from '../shared/types';

// 主题类型
export type Theme = 'light' | 'dark' | 'system';
export type ColorThemeId = 'paper' | 'graphite' | 'sepia' | 'rose' | 'forest' | 'amber' | 'studio';
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

export type ActiveWorkspace = 'chat' | 'board' | 'skills' | 'prompts';
export type ChatSidebarView = 'threads';
export type ProjectPanelView = 'files' | 'changes';

// UI 会话视图状态
export interface SessionView {
  id: string;
  title: string;
  status: import('../shared/types').SessionStatus;
  cwd?: string;
  claudeSessionId?: string;
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: import('../shared/types').ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: import('../shared/types').ClaudeAccessMode;
  claudeExecutionMode?: import('../shared/types').ClaudeExecutionMode;
  codexPermissionMode?: import('../shared/types').CodexPermissionMode;
  codexReasoningEffort?: import('../shared/types').CodexReasoningEffort;
  codexFastMode?: boolean;
  opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode;
  todoState?: TodoState;
  pinned?: boolean;
  folderPath?: string | null;
  hiddenFromThreads?: boolean;
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
  sessionsLoaded: boolean;
  // 搜索状态
  sidebarSearchQuery: string;
  activeFilters: SearchFilters;
  inSessionSearchOpen: boolean;
  inSessionSearchQuery: string;
  inSessionSearchResults: SearchMatch[];
  inSessionSearchCurrentIndex: number;
  historyNavigationTarget: {
    sessionId: string;
    messageCreatedAt: number;
    nonce: number;
  } | null;
  // MCP 状态
  mcpServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpGlobalServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpProjectServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpServerStatus: import('../shared/types').McpServerStatus[];
  claudeUserSkills: import('../shared/types').ClaudeSkillSummary[];
  claudeProjectSkills: import('../shared/types').ClaudeSkillSummary[];
  claudeSkillsUserRoot: string;
  claudeSkillsProjectRoot?: string;
  // Settings 状态
  showSettings: boolean;
  activeSettingsTab: SettingsTab;
  updateStatus: {
    available: boolean;
    version: string | null;
  };
  promptLibraryInsertRequest: PromptLibraryInsertRequest | null;
  // 状态配置
  statusConfigs: StatusConfig[];
  statusFilter: TodoState | 'all' | 'open' | 'closed';
  // 文件夹
  folderConfigs: FolderConfig[];
  // 主题
  theme: Theme;
  colorThemeId: ColorThemeId;
  customThemeCss: string;
  fontSelections: import('../shared/types').FontSettingsPayload['selections'];
  importedFonts: import('../shared/types').ImportedFontFace[];
  systemFonts: import('../shared/types').SystemFontOption[];
  systemFontsLoaded: boolean;
}

// Store Actions
export interface AppActions {
  setConnected: (connected: boolean) => void;
  handleServerEvent: (event: import('../shared/types').ServerEvent) => void;
  setActiveSession: (sessionId: string | null) => void;
  setActiveWorkspace: (workspace: ActiveWorkspace) => void;
  setChatSidebarView: (view: ChatSidebarView) => void;
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
  applyUiResumeState: (state: import('../shared/types').UiResumeState | null) => void;
  clearGlobalError: () => void;
  setPendingStart: (pending: boolean) => void;
  createDraftSession: (cwd?: string | null) => string;
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
  setHistoryNavigationTarget: (target: AppState['historyNavigationTarget']) => void;
  // MCP Actions
  setMcpServers: (servers: Record<string, import('../shared/types').McpServerConfig>) => void;
  setMcpServerStatus: (status: import('../shared/types').McpServerStatus[]) => void;
  // Settings Actions
  setShowSettings: (show: boolean) => void;
  setActiveSettingsTab: (tab: SettingsTab) => void;
  requestPromptLibraryInsert: (content: string, mode?: PromptLibraryInsertMode) => void;
  consumePromptLibraryInsert: (nonce: number) => void;
  // 状态配置 Actions
  setStatusConfigs: (configs: StatusConfig[]) => void;
  setStatusFilter: (filter: TodoState | 'all' | 'open' | 'closed') => void;
  // 文件夹 Actions
  setFolderConfigs: (configs: FolderConfig[]) => void;
  // 主题 Actions
  setTheme: (theme: Theme) => void;
  setColorThemeId: (colorThemeId: ColorThemeId) => void;
  setCustomThemeCss: (customThemeCss: string) => void;
  setFontSettings: (settings: import('../shared/types').FontSettingsPayload) => void;
  setSystemFonts: (fonts: import('../shared/types').SystemFontOption[]) => void;
}

export type PromptLibraryInsertMode = 'append' | 'replace';

export interface PromptLibraryInsertRequest {
  content: string;
  mode: PromptLibraryInsertMode;
  nonce: number;
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
