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
  kimi_session_id: string | null;
  grok_session_id: string | null;
  pi_session_id: string | null;
  provider: 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'pi';
  model: string | null;
  conversation_scope: import('../shared/types').SessionScope | null;
  agent_id: string | null;
  compatible_provider_id: import('../shared/types').ClaudeCompatibleProviderId | null;
  betas: string | null;
  claude_access_mode: import('../shared/types').ClaudeAccessMode | null;
  claude_execution_mode: import('../shared/types').ClaudeExecutionMode | null;
  claude_reasoning_effort: import('../shared/types').ClaudeReasoningEffort | null;
  codex_execution_mode: import('../shared/types').CodexExecutionMode | null;
  codex_permission_mode: import('../shared/types').CodexPermissionMode | null;
  codex_reasoning_effort: import('../shared/types').CodexReasoningEffort | null;
  codex_fast_mode: number | null;
  opencode_permission_mode: import('../shared/types').OpenCodePermissionMode | null;
  status: string;
  cwd: string | null;
  project_cwd: string | null;
  env_mode: import('../shared/types').ThreadEnvironmentMode | null;
  worktree_path: string | null;
  associated_worktree_path: string | null;
  associated_worktree_branch: string | null;
  associated_worktree_ref: string | null;
  handoff_source_provider: string | null;
  handoff_pending: number | null;
  allowed_tools: string | null;
  last_prompt: string | null;
  todo_state: string | null;
  pinned: number | null;
  folder_path: string | null;
  hidden_from_threads: number | null;
  workspace_channel_id: string | null;
  team_mode: import('../shared/types').SessionTeamMode | null;
  team_id: string | null;
  session_origin: import('../shared/types').SessionSource | null;
  external_file_path: string | null;
  external_file_mtime: number | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  message_type: string | null;
  source_origin: import('../shared/types').SessionSource | null;
  search_text: string | null;
  sort_key: number | null;
  parent_turn_id: string | null;
  delegate_call_id: string | null;
  delegate_run_id: string | null;
  data: string; // JSON string of StreamMessage
  created_at: number;
}

export interface ArtifactRow {
  id: string;
  session_id: string;
  message_id: string | null;
  kind: string;
  file_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  created_at: number;
}

export interface DerivedSummaryRow {
  id: string;
  session_id: string;
  message_id: string | null;
  scope: string;
  source_ids: string | null;
  summary: string;
  model: string | null;
  created_at: number;
  updated_at: number;
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
  claudeExecutionMode?: import('../shared/types').ClaudeExecutionMode;
  claudeReasoningEffort?: import('../shared/types').ClaudeReasoningEffort;
  codexExecutionMode?: import('../shared/types').CodexExecutionMode;
  codexPermissionMode?: import('../shared/types').CodexPermissionMode;
  codexReasoningEffort?: import('../shared/types').CodexReasoningEffort;
  codexFastMode?: boolean;
  kimiPermissionMode?: import('../shared/types').KimiPermissionMode;
  kimiThinking?: import('../shared/types').KimiThinking;
  grokPermissionMode?: import('../shared/types').GrokPermissionMode;
  grokReasoningEffort?: import('../shared/types').GrokReasoningEffort;
  codexSkills?: import('../shared/types').ProviderInputReference[];
  codexMentions?: import('../shared/types').ProviderInputReference[];
  opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode;
  onMessage: (message: import('../shared/types').StreamMessage) => void;
  onError?: (error: Error) => void;
  onPermissionRequest: (
    toolUseId: string,
    toolName: string,
    input: unknown
  ) => Promise<import('../shared/types').PermissionResult>;
  /**
   * The provider resolved/abandoned a pending permission request itself
   * (process death, stop, server-side resolution) — clear the pending UI.
   */
  onPermissionDismissed?: (toolUseId: string) => void;
  onClaudeExecutionModeChange?: (
    mode: import('../shared/types').ClaudeExecutionMode,
    permissionMode: import('../shared/types').ClaudePermissionMode
  ) => void;
}

export interface RewindFilesResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

export interface RunnerHandle {
  abort: () => void;
  /**
   * Softly interrupt the in-flight turn while keeping the underlying process
   * and its context alive, so the next send reuses the warm session instead
   * of paying a cold respawn. Only the Claude runner provides this (SDK
   * streaming-input mode); absent on other providers.
   */
  interrupt?: () => Promise<void>;
  /**
   * Two-phase stop (codex): request `turn/interrupt` and resolve once the
   * provider confirms the turn terminal (`turn/completed(interrupted)`) or
   * the confirmation window times out. `confirmed: false` means the stop was
   * never acknowledged — the turn may still be finishing server-side. Keeps
   * the event subscription alive for the duration; absent on other providers.
   */
  interruptAndSettle?: () => Promise<{ confirmed: boolean }>;
  /**
   * Drop every prompt handed to send() that has not reached the input queue
   * yet (preparing a prompt is async — attachments are read from disk).
   * Returns how many prompts were dropped so the caller can remove them from
   * its turn accounting: a cancelled prompt never starts a turn and never
   * produces a result. Only the Claude runner provides this.
   */
  cancelPendingPrompts?: () => number;
  /**
   * Rewind checkpointed files to their state at a specific SDK user message.
   * Only available while the underlying SDK query is alive (Claude runner with
   * file checkpointing enabled); absent on other providers.
   */
  rewindFiles?: (
    userMessageId: string,
    options?: { dryRun?: boolean }
  ) => Promise<RewindFilesResult>;
  send: (
    prompt: string,
    attachments?: import('../shared/types').Attachment[],
    model?: string,
    codexSkills?: import('../shared/types').ProviderInputReference[],
    codexMentions?: import('../shared/types').ProviderInputReference[],
    options?: {
      codexExecutionMode?: import('../shared/types').CodexExecutionMode;
      codexPermissionMode?: import('../shared/types').CodexPermissionMode;
      codexReasoningEffort?: import('../shared/types').CodexReasoningEffort;
      codexFastMode?: boolean;
      kimiPermissionMode?: import('../shared/types').KimiPermissionMode;
      kimiThinking?: import('../shared/types').KimiThinking;
      grokPermissionMode?: import('../shared/types').GrokPermissionMode;
      grokReasoningEffort?: import('../shared/types').GrokReasoningEffort;
      opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode;
    }
  ) => void;
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
