// 共享类型定义（可导出）

// MCP 服务器配置类型
export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

// MCP 服务器状态
export interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'pending';
  error?: string;
}

// Client -> Server 事件
export type ClientEvent =
  | { type: 'session.list' }
  | { type: 'session.start'; payload: SessionStartPayload }
  | { type: 'session.continue'; payload: SessionContinuePayload }
  | { type: 'session.history'; payload: { sessionId: string } }
  | { type: 'session.stop'; payload: { sessionId: string } }
  | { type: 'session.delete'; payload: { sessionId: string } }
  | { type: 'permission.response'; payload: PermissionResponsePayload }
  // MCP 事件
  | { type: 'mcp.get-config'; payload?: { projectPath?: string } }
  | { type: 'mcp.save-config'; payload: {
      servers?: Record<string, McpServerConfig>;
      globalServers?: Record<string, McpServerConfig>;
      projectServers?: Record<string, McpServerConfig>;
      projectPath?: string;
    } };

// Server -> Client 事件
export type ServerEvent =
  | { type: 'session.list'; payload: { sessions: SessionInfo[] } }
  | { type: 'session.status'; payload: SessionStatusPayload }
  | { type: 'session.history'; payload: SessionHistoryPayload }
  | { type: 'session.deleted'; payload: { sessionId: string } }
  | { type: 'stream.user_prompt'; payload: { sessionId: string; prompt: string } }
  | { type: 'stream.message'; payload: { sessionId: string; message: StreamMessage } }
  | { type: 'permission.request'; payload: PermissionRequestPayload }
  | { type: 'runner.error'; payload: { message: string; sessionId?: string } }
  // MCP 事件
  | { type: 'mcp.config'; payload: {
      servers: Record<string, McpServerConfig>;
      globalServers?: Record<string, McpServerConfig>;
      projectServers?: Record<string, McpServerConfig>;
    } }
  | { type: 'mcp.status'; payload: { servers: McpServerStatus[] } };

// Payload 类型
export interface SessionStartPayload {
  title: string;
  prompt: string;
  cwd?: string;
  allowedTools?: string;
}

export interface SessionContinuePayload {
  sessionId: string;
  prompt: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  cwd?: string;
  claudeSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

export interface SessionStatusPayload {
  sessionId: string;
  status: SessionStatus;
  title?: string;
  cwd?: string;
  error?: string;
}

export interface SessionHistoryPayload {
  sessionId: string;
  status: SessionStatus;
  messages: StreamMessage[];
}

export interface PermissionRequestPayload {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: AskUserQuestionInput;
}

export interface PermissionResponsePayload {
  sessionId: string;
  toolUseId: string;
  result: PermissionResult;
}

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

// AskUserQuestion 输入结构
export interface AskUserQuestionInput {
  questions: AskUserQuestion[];
  answers?: Record<string, string>;
}

export interface AskUserQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

// StreamMessage 类型（SDK 消息或内部消息）
export type StreamMessage =
  | { type: 'user_prompt'; prompt: string }
  | {
      type: 'system';
      subtype: 'init';
      session_id: string;
      model: string;
      permissionMode: string;
      cwd: string;
      tools: string[];
      mcp_servers?: McpServerStatus[];
    }
  | { type: 'assistant'; uuid: string; message: AssistantMessage }
  | { type: 'user'; uuid: string; message: UserMessage }
  | {
      type: 'result';
      subtype: 'success' | string;
      duration_ms: number;
      total_cost_usd: number;
      usage: Usage;
    }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'mcp_status'; servers: McpServerStatus[] };

// 简化的 Anthropic API 类型
export interface AssistantMessage {
  content: ContentBlock[];
}

export interface UserMessage {
  content: ContentBlock[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface StreamEvent {
  type: 'content_block_start' | 'content_block_delta' | 'content_block_stop';
  index?: number;
  delta?: { type: string; text?: string; thinking?: string };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

// 系统监控类型（预留）
export interface StatisticsData {
  cpuUsage: number;
  memoryUsage: number;
}

export interface StaticData {
  cpuModel: string;
  totalMemory: number;
}
