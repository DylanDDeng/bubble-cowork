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

export interface PromptLibraryItem {
  id: string;
  title: string;
  content: string;
  tags: string[];
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PromptLibraryFile {
  version: number;
  prompts: PromptLibraryItem[];
}

export interface UpsertPromptLibraryItemInput {
  id?: string;
  title: string;
  content: string;
  tags?: string[];
  description?: string;
}

export interface PromptLibraryImportResult {
  items: PromptLibraryItem[];
  importedCount: number;
  skippedCount: number;
  filePath: string | null;
}

export interface PromptLibraryExportResult {
  canceled: boolean;
  filePath: string | null;
  count: number;
}

export interface UiResumeState {
  activeSessionId: string | null;
  showNewSession: boolean;
  projectCwd: string | null;
  projectTreeCollapsed: boolean;
  projectPanelView: 'files' | 'changes';
  terminalDrawerOpen?: boolean;
  terminalDrawerHeight?: number;
  chatLayoutMode?: 'single' | 'split';
  activePaneId?: 'primary' | 'secondary';
  chatPanes?: {
    primary: { id: 'primary'; sessionId: string | null; surface?: 'chat' | 'terminal' };
    secondary: { id: 'secondary'; sessionId: string | null; surface?: 'chat' | 'terminal' };
  };
  chatSplitRatio?: number;
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

// Claude Skills 摘要
export interface ClaudeSkillSummary {
  name: string;
  title: string;
  description?: string;
  path: string;
  source: 'user' | 'project';
}

export interface ClaudeModelConfig {
  defaultModel: string | null;
  options: string[];
}

export type ClaudeAccessMode = 'default' | 'fullAccess';
export type ClaudeExecutionMode = 'execute' | 'plan';
export type CodexPermissionMode = 'defaultPermissions' | 'fullAccess';
export type OpenCodePermissionMode = 'defaultPermissions' | 'fullAccess';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexReasoningLevelOption {
  effort: CodexReasoningEffort;
  description: string;
}

export interface CodexModelConfig {
  defaultModel: string | null;
  defaultReasoningEffort: CodexReasoningEffort | null;
  options: string[];
  availableModels: Array<{
    name: string;
    enabled: boolean;
    isDefault: boolean;
    defaultReasoningEffort?: CodexReasoningEffort | null;
    supportedReasoningLevels?: CodexReasoningLevelOption[];
    supportsFastMode?: boolean;
  }>;
}

export interface OpenCodeModelConfig {
  defaultModel: string | null;
  options: string[];
  availableModels: Array<{
    name: string;
    enabled: boolean;
    isDefault: boolean;
  }>;
}

export interface CodexRuntimeStatus {
  ready: boolean;
  cliAvailable: boolean;
  configExists: boolean;
  hasModelConfig: boolean;
  checkedAt: number;
}

export interface OpenCodeRuntimeStatus {
  ready: boolean;
  cliAvailable: boolean;
  configExists: boolean;
  hasModelConfig: boolean;
  checkedAt: number;
}

export type ClaudeRuntimeStatusKind = 'ready' | 'login_required' | 'install_required' | 'error';
export type ClaudeRuntimeSource = 'global' | 'bundled' | 'workspace' | 'unknown';

export interface ClaudeRuntimeStatus {
  kind: ClaudeRuntimeStatusKind;
  ready: boolean;
  runtimeInstalled: boolean;
  runtimeSource: ClaudeRuntimeSource;
  requiresAnthropicAuth: boolean;
  authSatisfied: boolean;
  hasApiKey: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  cliPath: string | null;
  cliVersion: string | null;
  requestedModel: string | null;
  summary: string;
  detail: string;
  installCommand: string | null;
  loginCommand: string | null;
  setupTokenCommand: string | null;
  checkedAt: number;
}

export type FontSlot = 'ui' | 'display' | 'mono';
export type FontSelectionSource = 'builtin' | 'system' | 'imported';
export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2';

export interface FontSelection {
  source: FontSelectionSource;
  id: string;
}

export interface ImportedFontFace {
  id: string;
  label: string;
  cssFamily: string;
  format: FontFormat;
  mimeType: string;
  dataBase64: string;
}

export interface FontSettingsPayload {
  selections: Record<FontSlot, FontSelection>;
  importedFonts: ImportedFontFace[];
}

export interface SystemFontOption {
  id: string;
  label: string;
  cssFamily: string;
}

export interface FeishuBridgeConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  defaultCwd: string;
  provider: AgentProvider;
  model: string;
  allowedUserIds: string;
  autoStart: boolean;
}

export interface FeishuBridgeStatus {
  running: boolean;
  connected: boolean;
  botOpenId?: string;
  lastError?: string;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  activeBindings: number;
}

export type ClaudeCompatibleAuthType = 'api_key' | 'auth_token';
export type ClaudeCompatibleProviderId =
  | 'minimaxCn'
  | 'minimax'
  | 'mimo'
  | 'zhipu'
  | 'moonshot'
  | 'deepseek';

export interface ClaudeCompatibleProviderConfig {
  enabled: boolean;
  baseUrl: string;
  authType: ClaudeCompatibleAuthType;
  secret: string;
  model: string;
  smallFastModel?: string;
  maxOutputTokens?: number;
}

export interface ClaudeCompatibleProvidersConfig {
  providers: Record<ClaudeCompatibleProviderId, ClaudeCompatibleProviderConfig>;
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
  uiType?: 'pasted_text';
  previewText?: string;
}

export type MemoryDocumentKind = 'assistant' | 'user' | 'project';
export type MemoryScope = 'personal' | 'project';

export interface MemoryDocument {
  kind: MemoryDocumentKind;
  scope: MemoryScope;
  title: string;
  description: string;
  path: string;
  content: string;
  exists: boolean;
  updatedAt: number;
  projectCwd?: string | null;
}

export interface MemoryWorkspace {
  rootPath: string;
  assistantRoot: string;
  projectRoot: string | null;
  projectCwd: string | null;
  assistantDocument: MemoryDocument;
  userDocument: MemoryDocument;
  projectDocument: MemoryDocument | null;
}

// Agent 提供商
export type AgentProvider = 'claude' | 'codex' | 'opencode';
export type SessionSource =
  | 'aegis'
  | 'claude_code'
  | 'claude_remote'
  | 'codex_local'
  | 'opencode_local';

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
  | { type: 'session.editLatestPrompt'; payload: SessionContinuePayload }
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
  // Skills 事件
  | { type: 'skills.list'; payload?: { projectPath?: string } }
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
  | { type: 'app.update'; payload: { available: boolean; version: string | null } }
  // MCP 事件
  | { type: 'mcp.config'; payload: {
      servers: Record<string, McpServerConfig>;
      globalServers?: Record<string, McpServerConfig>;
      projectServers?: Record<string, McpServerConfig>;
    } }
  | { type: 'mcp.status'; payload: { servers: McpServerStatus[] } }
  | { type: 'skills.list'; payload: {
      userRoot: string;
      projectRoot?: string;
      userSkills: ClaudeSkillSummary[];
      projectSkills: ClaudeSkillSummary[];
    } }
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
  effectivePrompt?: string;
  cwd?: string;
  todoState?: TodoState;
  allowedTools?: string;
  attachments?: Attachment[];
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  opencodePermissionMode?: OpenCodePermissionMode;
  hiddenFromThreads?: boolean;
}

export interface SessionContinuePayload {
  sessionId: string;
  prompt: string;
  effectivePrompt?: string;
  attachments?: Attachment[];
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  opencodePermissionMode?: OpenCodePermissionMode;
}

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  source?: SessionSource;
  readOnly?: boolean;
  cwd?: string;
  claudeSessionId?: string;
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  opencodePermissionMode?: OpenCodePermissionMode;
  todoState?: TodoState;
  pinned?: boolean;
  folderPath?: string | null;
  hiddenFromThreads?: boolean;
  latestClaudeModelUsage?: LatestClaudeModelUsage;
  createdAt: number;
  updatedAt: number;
}

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

export interface SessionStatusPayload {
  sessionId: string;
  status: SessionStatus;
  todoState?: TodoState;
  source?: SessionSource;
  readOnly?: boolean;
  title?: string;
  cwd?: string;
  error?: string;
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  opencodePermissionMode?: OpenCodePermissionMode;
  hiddenFromThreads?: boolean;
}

export interface SessionHistoryPayload {
  sessionId: string;
  status: SessionStatus;
  messages: StreamMessage[];
  cursor?: string | null;
  hasMore?: boolean;
}

export interface PermissionRequestPayload {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: PermissionRequestInput;
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
  scope?: 'once' | 'session';
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

export interface ExternalFilePermissionInput {
  kind: 'external-file-access';
  question: string;
  filePath: string;
  cwd: string;
  toolName: string;
}

export type PermissionRequestInput =
  | AskUserQuestionInput
  | ExternalFilePermissionInput;

// StreamMessage 类型（SDK 消息或内部消息）
export type StreamMessageBase = {
  createdAt?: number;
};

export interface CompactMetadata {
  trigger: 'manual' | 'auto';
  preTokens: number;
}

export interface AvailableCommandInput {
  hint: string;
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: AvailableCommandInput;
}

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
      slash_commands?: string[];
      skills?: string[];
      mcp_servers?: McpServerStatus[];
    })
  | (StreamMessageBase & {
      type: 'system';
      subtype: 'available_commands_update';
      session_id: string;
      availableCommands: AvailableCommand[];
    })
  | (StreamMessageBase & {
      type: 'system';
      subtype: 'compact_boundary';
      uuid: string;
      session_id: string;
      compactMetadata: CompactMetadata;
    })
  | (StreamMessageBase & { type: 'assistant'; uuid: string; message: AssistantMessage })
  | (StreamMessageBase & { type: 'user'; uuid: string; message: UserMessage })
  | (StreamMessageBase & {
      type: 'result';
      subtype: 'success' | string;
      duration_ms: number;
      total_cost_usd: number;
      usage: Usage;
      modelUsage?: Record<string, ClaudeModelUsage>;
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
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface StreamEvent {
  type: 'content_block_start' | 'content_block_delta' | 'content_block_stop';
  index?: number;
  delta?: { type: string; text?: string; thinking?: string; signature?: string };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  webSearchRequests?: number;
}

export interface LatestClaudeModelUsage {
  model: string;
  usage: ClaudeModelUsage;
}

export type ClaudeUsageRangeDays = 7 | 30 | 90;

export interface ClaudeUsageModelSummary {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  sessionCount: number;
  cacheReadTokens: number;
}

export interface ClaudeUsageDailyPoint {
  date: string;
  totalTokens: number;
  byModel: Record<string, number>;
  byModelCostUsd?: Record<string, number>;
}

export interface ClaudeUsageReport {
  rangeDays: ClaudeUsageRangeDays;
  costMode?: 'actual' | 'estimated' | 'unavailable';
  note?: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCostUsd: number;
    sessionCount: number;
    cacheReadTokens: number;
    cacheHitRate: number;
  };
  models: ClaudeUsageModelSummary[];
  daily: ClaudeUsageDailyPoint[];
}

export interface ChatMessageSearchMatch {
  snippet: string;
  messageType: 'user_prompt' | 'assistant' | 'user';
  createdAt: number;
}

export interface ChatSessionSearchResult {
  sessionId: string;
  sessionTitle: string;
  sessionSource?: SessionSource;
  sessionCwd?: string;
  sessionUpdatedAt: number;
  matchCount: number;
  matches: ChatMessageSearchMatch[];
}

export interface SkillMarketItem {
  id: string;
  owner: string;
  repo: string;
  skillId: string;
  name: string;
  source: string;
  installs: number;
  installsYesterday?: number;
  change?: number;
  detailUrl: string;
}

export interface SkillMarketDetail extends SkillMarketItem {
  repoUrl: string;
  installCommand: string;
  description: string;
  originalSource?: string;
  weeklyInstallsLabel?: string;
  securityAudits?: Array<{ name: string; status: string }>;
}

export interface SkillMarketInstallResult {
  ok: boolean;
  command: string;
  output: string;
  message?: string;
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
