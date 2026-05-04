import type { ContentBlock, PermissionResult, Usage } from '../../../shared/types';

export type BuiltinChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface BuiltinToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface BuiltinChatMessage {
  role: BuiltinChatRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: BuiltinToolCall[];
  reasoning_content?: string;
}

export interface BuiltinModelTurn {
  content: string;
  reasoning: string;
  toolCalls: BuiltinToolCall[];
  usage?: Usage;
}

export interface BuiltinToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type BuiltinToolResultStatus =
  | 'success'
  | 'no_match'
  | 'partial'
  | 'timeout'
  | 'blocked'
  | 'command_error';

export interface BuiltinToolResultMetadata {
  kind?: 'search' | 'read' | 'write' | 'edit' | 'shell' | 'web' | 'security' | 'lsp' | 'question' | 'memory' | 'subagent';
  path?: string;
  pattern?: string;
  matches?: number;
  truncated?: boolean;
  reason?: string;
  searchSignature?: string;
  searchFamily?: string;
  [key: string]: unknown;
}

export interface BuiltinToolResult {
  content: string;
  isError?: boolean;
  status?: BuiltinToolResultStatus;
  metadata?: BuiltinToolResultMetadata;
}

export interface BuiltinToolContext {
  cwd: string;
  abortSignal: AbortSignal;
  toolCall: {
    id: string;
    name: string;
  };
  agent?: {
    runSubtask: (
      input: string,
      cwd: string,
      options?: { subtaskType?: string; description?: string }
    ) => Promise<BuiltinToolResult>;
  };
}

export type BuiltinToolExecutor = (
  args: Record<string, unknown>,
  ctx: BuiltinToolContext
) => Promise<BuiltinToolResult>;

export interface BuiltinToolRegistryEntry extends BuiltinToolDefinition {
  execute: BuiltinToolExecutor;
  readOnly?: boolean;
  deferred?: boolean;
}

export type BuiltinPermissionMode = 'default' | 'plan' | 'bypassPermissions';

export type BuiltinTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface BuiltinTodoItem {
  content: string;
  activeForm: string;
  status: BuiltinTodoStatus;
}

export interface BuiltinTodoStore {
  getTodos: () => BuiltinTodoItem[];
  setTodos: (todos: BuiltinTodoItem[]) => void;
}

export interface BuiltinPlanController {
  getMode: () => BuiltinPermissionMode;
  approvePlan: (plan: string) => Promise<PermissionResult>;
  setMode: (mode: BuiltinPermissionMode) => void;
}

export interface BuiltinQuestionController {
  ask: (input: {
    questions: Array<{
      header: string;
      question: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  }) => Promise<PermissionResult>;
}

export interface BuiltinApprovalController {
  requestCommand: (input: { id: string; command: string; cwd: string }) => Promise<PermissionResult>;
  requestFileChange: (input: {
    id: string;
    toolName: string;
    title: string;
    question: string;
    filePath: string;
    summary: string[];
  }) => Promise<PermissionResult>;
  requestRead?: (input: { id: string; toolName: string; path: string }) => Promise<PermissionResult>;
}

export interface BuiltinMemoryAdapter {
  readSummary: () => Promise<string>;
  search: (query: string, limit?: number) => Promise<string>;
}

export interface BuiltinSkillAdapter {
  list: () => Array<{ name: string; title?: string; description?: string; path: string }>;
  load: (name: string) => Promise<string | null>;
}

export interface BuiltinLspAdapter {
  run: (input: {
    operation: string;
    filePath: string;
    line?: number;
    character?: number;
    query?: string;
    cwd: string;
  }) => Promise<BuiltinToolResult>;
}

export interface BuiltinToolSearchController {
  listDeferred: () => BuiltinToolRegistryEntry[];
  unlock: (names: string[]) => void;
}

export interface BuiltinAgentCallbacks {
  onText: (text: string) => void;
  onReasoning?: (text: string) => void;
  onStreamStop: () => void;
  onAssistantMessage: (blocks: ContentBlock[]) => void;
  onToolResult: (toolCallId: string, content: string, isError?: boolean) => void;
}

export type BuiltinModelComplete = (input: {
  messages: BuiltinChatMessage[];
  tools: BuiltinToolDefinition[];
  signal: AbortSignal;
  onText: (text: string) => void;
  onReasoning?: (text: string) => void;
}) => Promise<BuiltinModelTurn>;
