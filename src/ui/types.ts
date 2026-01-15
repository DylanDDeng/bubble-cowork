// UI 层类型定义

// 从共享类型导入
export type {
  SessionInfo,
  SessionStatus,
  StreamMessage,
  AskUserQuestionInput,
  AskUserQuestion,
  ContentBlock,
  PermissionRequestPayload,
  PermissionResult,
  ClientEvent,
  ServerEvent,
  ModelId,
  ModelOption,
  McpServerConfig,
  McpServerStatus,
} from '../shared/types';

export { AVAILABLE_MODELS, DEFAULT_MODEL } from '../shared/types';

// UI 会话视图状态
export interface SessionView {
  id: string;
  title: string;
  status: import('../shared/types').SessionStatus;
  cwd?: string;
  claudeSessionId?: string;
  messages: import('../shared/types').StreamMessage[];
  hydrated: boolean;
  permissionRequests: import('../shared/types').PermissionRequestPayload[];
  updatedAt: number;
}

// Store 状态
export interface AppState {
  connected: boolean;
  sessions: Record<string, SessionView>;
  activeSessionId: string | null;
  showNewSession: boolean;
  globalError: string | null;
  pendingStart: boolean;
  selectedModel: import('../shared/types').ModelId;
  // 搜索状态
  sidebarSearchQuery: string;
  activeFilters: SearchFilters;
  inSessionSearchOpen: boolean;
  inSessionSearchQuery: string;
  inSessionSearchResults: SearchMatch[];
  inSessionSearchCurrentIndex: number;
  // MCP 状态
  mcpServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpGlobalServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpProjectServers: Record<string, import('../shared/types').McpServerConfig>;
  mcpServerStatus: import('../shared/types').McpServerStatus[];
  showMcpSettings: boolean;
}

// Store Actions
export interface AppActions {
  setConnected: (connected: boolean) => void;
  handleServerEvent: (event: import('../shared/types').ServerEvent) => void;
  setActiveSession: (sessionId: string | null) => void;
  setShowNewSession: (show: boolean) => void;
  clearGlobalError: () => void;
  setPendingStart: (pending: boolean) => void;
  removePermissionRequest: (sessionId: string, toolUseId: string) => void;
  setSelectedModel: (model: import('../shared/types').ModelId) => void;
  // 搜索 Actions
  setSidebarSearchQuery: (query: string) => void;
  setActiveFilters: (filters: Partial<SearchFilters>) => void;
  clearFilters: () => void;
  openInSessionSearch: () => void;
  closeInSessionSearch: () => void;
  setInSessionSearchQuery: (query: string) => void;
  setInSessionSearchResults: (results: SearchMatch[]) => void;
  navigateSearchResult: (direction: 'next' | 'prev') => void;
  // MCP Actions
  setMcpServers: (servers: Record<string, import('../shared/types').McpServerConfig>) => void;
  setMcpServerStatus: (status: import('../shared/types').McpServerStatus[]) => void;
  setShowMcpSettings: (show: boolean) => void;
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
}
