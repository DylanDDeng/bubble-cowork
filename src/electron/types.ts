// 主进程内部类型

// 从共享类型导入
export type {
  ClientEvent,
  ServerEvent,
  SessionInfo,
  SessionStatus,
  StreamMessage,
  Attachment,
  PermissionResult,
  AskUserQuestionInput,
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
  status: string;
  cwd: string | null;
  allowed_tools: string | null;
  last_prompt: string | null;
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
  send: (prompt: string, attachments?: import('../shared/types').Attachment[]) => void;
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
