// 主进程内部类型

// 从共享类型导入
export type {
  ClientEvent,
  ServerEvent,
  SessionInfo,
  SessionStatus,
  StreamMessage,
  Attachment,
  ProjectTreeNode,
  PermissionResult,
  AskUserQuestionInput,
  ExternalFilePermissionInput,
  PermissionRequestInput,
  ContentBlock,
  SessionStartPayload,
  SessionContinuePayload,
  PermissionResponsePayload,
} from '../shared/types';

// 数据库行类型
export interface SessionRow {
  id: string;
  title: string;
  claude_session_id: string | null;
  codex_session_id: string | null;
  opencode_session_id: string | null;
  provider: 'claude' | 'codex' | 'opencode';
  model: string | null;
  compatible_provider_id: import('../shared/types').ClaudeCompatibleProviderId | null;
  betas: string | null;
  claude_access_mode: import('../shared/types').ClaudeAccessMode | null;
  codex_permission_mode: import('../shared/types').CodexPermissionMode | null;
  codex_reasoning_effort: import('../shared/types').CodexReasoningEffort | null;
  codex_fast_mode: number | null;
  opencode_permission_mode: import('../shared/types').OpenCodePermissionMode | null;
  status: string;
  cwd: string | null;
  allowed_tools: string | null;
  last_prompt: string | null;
  todo_state: string | null;
  pinned: number | null;
  folder_path: string | null;
  hidden_from_threads: number | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  data: string; // JSON string of StreamMessage
  created_at: number;
}

// Runner 相关类型
export interface RunnerOptions {
  prompt: string;
  attachments?: import('../shared/types').Attachment[];
  session: SessionRow;
  resumeSessionId?: string;
  model?: string;
  compatibleProviderId?: import('../shared/types').ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: import('../shared/types').ClaudeAccessMode;
  codexPermissionMode?: import('../shared/types').CodexPermissionMode;
  codexReasoningEffort?: import('../shared/types').CodexReasoningEffort;
  codexFastMode?: boolean;
  opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode;
  onMessage: (message: import('../shared/types').StreamMessage) => void;
  onError?: (error: Error) => void;
  onPermissionRequest: (
    toolUseId: string,
    toolName: string,
    input: unknown
  ) => Promise<import('../shared/types').PermissionResult>;
}

export interface RunnerHandle {
  abort: () => void;
  send: (prompt: string, attachments?: import('../shared/types').Attachment[], model?: string) => void;
}

// 内部会话状态
export interface SessionState {
  pendingPermissions: Map<
    string,
    {
      resolve: (result: import('../shared/types').PermissionResult) => void;
      reject: (error: Error) => void;
    }
  >;
}
