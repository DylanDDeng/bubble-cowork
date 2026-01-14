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
} from '../shared/types';

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
}

// Store 状态
export interface AppState {
  connected: boolean;
  sessions: Record<string, SessionView>;
  activeSessionId: string | null;
  showStartModal: boolean;
  globalError: string | null;
  pendingStart: boolean;
}

// Store Actions
export interface AppActions {
  setConnected: (connected: boolean) => void;
  handleServerEvent: (event: import('../shared/types').ServerEvent) => void;
  setActiveSession: (sessionId: string | null) => void;
  setShowStartModal: (show: boolean) => void;
  clearGlobalError: () => void;
  setPendingStart: (pending: boolean) => void;
  removePermissionRequest: (sessionId: string, toolUseId: string) => void;
}

// 工具状态映射（用于显示 pending/success/error）
export type ToolStatus = 'pending' | 'success' | 'error';
