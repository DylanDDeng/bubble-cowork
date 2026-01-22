// 共享类型定义（可导出）

// ===== 状态分类 =====
export type StatusCategory = 'open' | 'closed';

// ===== 状态配置 =====
export interface StatusConfig {
  id: string;              // 唯一标识 slug: 'todo', 'my-status'
  label: string;           // 显示名称
  color?: string;          // 颜色 (hex 或 Tailwind class)
  icon?: string;           // 图标 (emoji 或 SVG 标识)
  category: StatusCategory;
  isFixed: boolean;        // 固定状态，不可删除/改分类
  isDefault: boolean;      // 默认状态，不可删除但可修改
  order: number;           // 显示顺序
}

// ===== 状态配置文件结构 =====
export interface StatusConfigFile {
  version: number;
  statuses: StatusConfig[];
  defaultStatusId: string;
}

// ===== 会话的工作流状态 =====
export type TodoState = string;  // 动态引用 StatusConfig.id

// ===== 状态输入类型 =====
export interface CreateStatusInput {
  label: string;
  color?: string;
  icon?: string;
  category: StatusCategory;
}

export interface UpdateStatusInput {
  label?: string;
  color?: string;
  icon?: string;
  category?: StatusCategory;
}

// ===== 文件夹配置 =====
export interface FolderConfig {
  path: string;           // "Work/ProjectA"
  displayName?: string;
  color?: string;
  collapsed?: boolean;
  order: number;
}

export interface FolderConfigFile {
  version: number;
  folders: FolderConfig[];
}

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

// 附件类型（文件/图片）
export type AttachmentKind = 'file' | 'image';

export interface Attachment {
  id: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  kind: AttachmentKind;
}

// Agent 提供商
export type AgentProvider = 'claude' | 'codex';

// 项目文件树节点
export interface ProjectTreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: ProjectTreeNode[];
}

// Client -> Server 事件
export type ClientEvent =
  | { type: 'session.list' }
  | { type: 'session.start'; payload: SessionStartPayload }
  | { type: 'session.continue'; payload: SessionContinuePayload }
  | { type: 'session.history'; payload: { sessionId: string } }
  | { type: 'session.stop'; payload: { sessionId: string } }
  | { type: 'session.delete'; payload: { sessionId: string } }
  | { type: 'session.setTodoState'; payload: { sessionId: string; todoState: TodoState } }
  | { type: 'session.togglePin'; payload: { sessionId: string } }
  | { type: 'permission.response'; payload: PermissionResponsePayload }
  // MCP 事件
  | { type: 'mcp.get-config'; payload?: { projectPath?: string } }
  | { type: 'mcp.save-config'; payload: {
      servers?: Record<string, McpServerConfig>;
      globalServers?: Record<string, McpServerConfig>;
      projectServers?: Record<string, McpServerConfig>;
      projectPath?: string;
    } }
  // 状态配置事件
  | { type: 'status.list' }
  | { type: 'status.create'; payload: CreateStatusInput }
  | { type: 'status.update'; payload: { id: string; updates: UpdateStatusInput } }
  | { type: 'status.delete'; payload: { id: string } }
  | { type: 'status.reorder'; payload: { orderedIds: string[] } }
  // 文件夹事件
  | { type: 'folder.list' }
  | { type: 'folder.create'; payload: { path: string; displayName?: string } }
  | { type: 'folder.update'; payload: { path: string; updates: Partial<FolderConfig> } }
  | { type: 'folder.delete'; payload: { path: string } }
  | { type: 'folder.move'; payload: { oldPath: string; newPath: string } }
  | { type: 'session.setFolder'; payload: { sessionId: string; folderPath: string | null } };

// Server -> Client 事件
export type ServerEvent =
  | { type: 'session.list'; payload: { sessions: SessionInfo[] } }
  | { type: 'session.status'; payload: SessionStatusPayload }
  | { type: 'session.history'; payload: SessionHistoryPayload }
  | { type: 'session.deleted'; payload: { sessionId: string } }
  | { type: 'session.todoStateChanged'; payload: { sessionId: string; todoState: TodoState } }
  | { type: 'session.pinned'; payload: { sessionId: string; pinned: boolean } }
  | {
      type: 'stream.user_prompt';
      payload: { sessionId: string; prompt: string; attachments?: Attachment[]; createdAt?: number };
    }
  | { type: 'stream.message'; payload: { sessionId: string; message: StreamMessage } }
  | { type: 'permission.request'; payload: PermissionRequestPayload }
  | { type: 'runner.error'; payload: { message: string; sessionId?: string } }
  | { type: 'project.tree'; payload: { cwd: string; tree: ProjectTreeNode } }
  // MCP 事件
  | { type: 'mcp.config'; payload: {
      servers: Record<string, McpServerConfig>;
      globalServers?: Record<string, McpServerConfig>;
      projectServers?: Record<string, McpServerConfig>;
    } }
  | { type: 'mcp.status'; payload: { servers: McpServerStatus[] } }
  // 状态配置事件
  | { type: 'status.list'; payload: { statuses: StatusConfig[] } }
  | { type: 'status.changed'; payload: { statuses: StatusConfig[] } }
  // 文件夹事件
  | { type: 'folder.list'; payload: { folders: FolderConfig[] } }
  | { type: 'folder.changed'; payload: { folders: FolderConfig[] } }
  | { type: 'session.folderChanged'; payload: { sessionId: string; folderPath: string | null } };

// Payload 类型
export interface SessionStartPayload {
  title: string;
  prompt: string;
  cwd?: string;
  allowedTools?: string;
  attachments?: Attachment[];
  provider?: AgentProvider;
}

export interface SessionContinuePayload {
  sessionId: string;
  prompt: string;
  attachments?: Attachment[];
  provider?: AgentProvider;
}

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  cwd?: string;
  claudeSessionId?: string;
  provider?: AgentProvider;
  todoState?: TodoState;
  pinned?: boolean;
  folderPath?: string | null;
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
  provider?: AgentProvider;
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
export type StreamMessageBase = {
  createdAt?: number;
};

export type StreamMessage =
  | (StreamMessageBase & { type: 'user_prompt'; prompt: string; attachments?: Attachment[] })
  | (StreamMessageBase & {
      type: 'system';
      subtype: 'init';
      session_id: string;
      model: string;
      permissionMode: string;
      cwd: string;
      tools: string[];
      mcp_servers?: McpServerStatus[];
    })
  | (StreamMessageBase & { type: 'assistant'; uuid: string; message: AssistantMessage })
  | (StreamMessageBase & { type: 'user'; uuid: string; message: UserMessage })
  | (StreamMessageBase & {
      type: 'result';
      subtype: 'success' | string;
      duration_ms: number;
      total_cost_usd: number;
      usage: Usage;
    })
  | (StreamMessageBase & { type: 'stream_event'; event: StreamEvent })
  | (StreamMessageBase & { type: 'mcp_status'; servers: McpServerStatus[] });

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
