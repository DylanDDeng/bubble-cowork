// UI 层类型定义

// 从共享类型导入
import type { AgentProvider, ProjectTreeNode, TodoState, StatusConfig } from '../shared/types';

export type {
  SessionInfo,
  SessionStatus,
  StreamMessage,
  Attachment,
  ProjectTreeNode,
  AskUserQuestionInput,
  AskUserQuestion,
  ContentBlock,
  PermissionRequestPayload,
  PermissionResult,
  ClientEvent,
  ServerEvent,
  McpServerConfig,
  McpServerStatus,
  AgentProvider,
  TodoState,
  StatusConfig,
  StatusCategory,
  CreateStatusInput,
  UpdateStatusInput,
} from '../shared/types';

// UI 会话视图状态
export interface SessionView {
  id: string;
  title: string;
  status: import('../shared/types').SessionStatus;
  cwd?: string;
  claudeSessionId?: string;
  provider?: AgentProvider;
  todoState?: TodoState;
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
  sidebarCollapsed: boolean;
  globalError: string | null;
  pendingStart: boolean;
  projectCwd: string | null;
  projectTreeCwd: string | null;
  projectTree: ProjectTreeNode | null;
  projectTreeCollapsed: boolean;
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
  // 状态配置
  statusConfigs: StatusConfig[];
  statusFilter: TodoState | 'all' | 'open' | 'closed';
}

// Store Actions
export interface AppActions {
  setConnected: (connected: boolean) => void;
  handleServerEvent: (event: import('../shared/types').ServerEvent) => void;
  setActiveSession: (sessionId: string | null) => void;
  setShowNewSession: (show: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setProjectCwd: (cwd: string | null) => void;
  setProjectTree: (cwd: string | null, tree: ProjectTreeNode | null) => void;
  setProjectTreeCollapsed: (collapsed: boolean) => void;
  clearGlobalError: () => void;
  setPendingStart: (pending: boolean) => void;
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
  // MCP Actions
  setMcpServers: (servers: Record<string, import('../shared/types').McpServerConfig>) => void;
  setMcpServerStatus: (status: import('../shared/types').McpServerStatus[]) => void;
  setShowMcpSettings: (show: boolean) => void;
  // 状态配置 Actions
  setStatusConfigs: (configs: StatusConfig[]) => void;
  setStatusFilter: (filter: TodoState | 'all' | 'open' | 'closed') => void;
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
