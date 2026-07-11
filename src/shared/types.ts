// 共享类型定义（可导出）

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
  // Recursive tiling workspace layout (source of truth). Serialized PaneNode
  // tree + active leaf id; see src/ui/store/layout-tree.ts. Opaque here to keep
  // the shared types renderer-agnostic.
  schemaVersion?: number;
  workspaceLayout?: unknown;
  // Legacy two-pane fields (compat shadow; derived from workspaceLayout).
  chatLayoutMode?: 'single' | 'split';
  savedSplitVisible?: boolean;
  activePaneId?: 'primary' | 'secondary' | string;
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
  /** Which agent reported this status. Used to avoid cross-agent name collisions. */
  tool?: 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'pi';
}

// Claude Skills 摘要
export interface ClaudeSkillSummary {
  name: string;
  title: string;
  description?: string;
  path: string;
  source: 'user' | 'project' | 'plugin';
}

export interface ClaudeModelConfig {
  defaultModel: string | null;
  options: string[];
}

export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';
export type ClaudeAccessMode = ClaudePermissionMode | 'fullAccess';
export type ClaudeExecutionMode = 'execute' | 'plan';
export type ClaudeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CodexExecutionMode = 'execute' | 'plan';
export type CodexPermissionMode = 'defaultPermissions' | 'auto' | 'fullAccess';
export type KimiPermissionMode = 'default' | 'plan' | 'auto' | 'yolo';
export type GrokPermissionMode = 'default' | 'plan' | 'auto' | 'yolo';
export type GrokReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenCodePermissionMode = 'defaultPermissions' | 'plan' | 'fullAccess';
/**
 * Codex reasoning effort slug (e.g. "low", "medium", "high", "xhigh", "max",
 * "ultra"). Deliberately an open string: the valid set is model-specific and
 * comes from Codex's models_cache `supported_reasoning_levels`, so Aegis must
 * not maintain its own whitelist — new levels should work without code changes.
 */
export type CodexReasoningEffort = string;
export type PlanStepStatus = 'pending' | 'inProgress' | 'completed';

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface ClaudeReasoningLevelOption {
  effort: ClaudeReasoningEffort;
  description: string;
}

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
    /** Human label from Codex cache (e.g. "GPT-5.6-Sol"); falls back to formatted slug. */
    label?: string;
    enabled: boolean;
    isDefault: boolean;
    defaultReasoningEffort?: CodexReasoningEffort | null;
    supportedReasoningLevels?: CodexReasoningLevelOption[];
    supportsFastMode?: boolean;
    /** Lower numbers are higher priority in Codex's own listing. */
    priority?: number | null;
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

export interface KimiModelConfig {
  defaultModel: string | null;
  options: string[];
  availableModels: Array<{
    name: string;
    label?: string;
    provider?: string | null;
    enabled: boolean;
    isDefault: boolean;
    maxContextSize?: number | null;
    capabilities?: string[];
  }>;
}

export interface GrokModelConfig {
  defaultModel: string | null;
  options: string[];
  availableModels: Array<{
    name: string;
    label?: string;
    provider?: string | null;
    enabled: boolean;
    isDefault: boolean;
    maxContextSize?: number | null;
    capabilities?: string[];
  }>;
}

export interface PiModelConfig {
  defaultModel: string | null;
  options: string[];
  availableModels: Array<{
    name: string;
    label?: string;
    provider?: string | null;
    enabled: boolean;
    isDefault: boolean;
    maxContextSize?: number | null;
    capabilities?: string[];
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

export type KimiRuntimeAuthState = 'unknown' | 'ready' | 'login_required' | 'error';
export type GrokRuntimeAuthState = 'unknown' | 'ready' | 'login_required' | 'error';

export interface KimiRuntimeStatus {
  ready: boolean;
  cliAvailable: boolean;
  cliPath: string | null;
  cliVersion: string | null;
  acpAvailable: boolean;
  authState: KimiRuntimeAuthState;
  loginCommand: string | null;
  summary: string;
  detail: string;
  checkedAt: number;
}

export interface GrokRuntimeStatus {
  ready: boolean;
  cliAvailable: boolean;
  cliPath: string | null;
  cliVersion: string | null;
  acpAvailable: boolean;
  authState: GrokRuntimeAuthState;
  loginCommand: string | null;
  summary: string;
  detail: string;
  checkedAt: number;
}

export type ClaudeRuntimeStatusKind = 'ready' | 'login_required' | 'install_required' | 'error';
export type ClaudeRuntimeSource = 'global' | 'unknown';

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

export type WechatMarkdownHtmlThemeId = 'black-red-imprint' | 'black-orange-imprint';
export type WechatMarkdownHtmlGeneratorRuntime = AgentProvider;

export interface WechatMarkdownHtmlGeneratorConfig {
  runtime: WechatMarkdownHtmlGeneratorRuntime;
  providerId: string;
  model: string;
  temperature: number;
  maxOutputTokens?: number;
}

export interface WechatMarkdownHtmlGenerationInput {
  markdown: string;
  themeId: WechatMarkdownHtmlThemeId;
  filePath?: string;
}

export interface WechatMarkdownHtmlGenerationResult {
  html: string;
  model: string;
  providerId: string;
  runtime: WechatMarkdownHtmlGeneratorRuntime;
  themeId: WechatMarkdownHtmlThemeId;
}

export interface WechatClipboardHtmlWriteInput {
  html: string;
}

export interface WechatClipboardHtmlWriteResult {
  ok: boolean;
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

export const DEFAULT_WORKSPACE_CHANNEL_ID = 'all';

export interface WorkspaceChannel {
  id: string;
  projectCwd: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

// Agent 提供商 / runtime
export type AgentProvider = 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'pi';
export type SessionSource =
  | 'aegis'
  | 'claude_remote'
  | 'codex_local'
  | 'opencode_local'
  | 'kimi_local'
  | 'grok_local'
  | 'pi_local';

export interface ProviderComposerCapabilities {
  provider: AgentProvider;
  supportsSkillMentions: boolean;
  supportsSkillDiscovery: boolean;
  supportsNativeSlashCommandDiscovery: boolean;
  supportsPluginMentions: boolean;
  supportsPluginDiscovery: boolean;
  supportsRuntimeModelList: boolean;
  supportsThreadCompaction?: boolean;
  supportsThreadImport?: boolean;
}

export interface ProviderSkillInterface {
  displayName?: string;
  shortDescription?: string;
}

export interface ProviderSkillDescriptor {
  name: string;
  description?: string;
  path: string;
  enabled: boolean;
  scope?: string;
  interface?: ProviderSkillInterface;
  dependencies?: unknown;
}

export interface ProviderInputReference {
  name: string;
  path: string;
}

export interface ProviderListSkillsInput {
  provider: AgentProvider;
  cwd?: string;
  threadId?: string;
  forceReload?: boolean;
}

export interface ProviderListSkillsResult {
  skills: ProviderSkillDescriptor[];
  source?: string;
  cached?: boolean;
}

export type ProviderPluginInstallPolicy =
  | 'NOT_AVAILABLE'
  | 'AVAILABLE'
  | 'INSTALLED_BY_DEFAULT';
export type ProviderPluginAuthPolicy = 'ON_INSTALL' | 'ON_USE';

export type ProviderPluginSource =
  | { type: 'local'; path: string }
  | { type: 'git'; url: string; path?: string | null; refName?: string | null; sha?: string | null }
  | { type: 'remote' };

export interface ProviderPluginInterface {
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  developerName?: string;
  category?: string;
  capabilities?: string[];
  websiteUrl?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  defaultPrompt?: string[];
  brandColor?: string;
  composerIcon?: string;
  composerIconUrl?: string;
  logo?: string;
  logoUrl?: string;
  screenshots?: string[];
  screenshotUrls?: string[];
}

export interface ProviderPluginDescriptor {
  id: string;
  name: string;
  source: ProviderPluginSource;
  installed: boolean;
  enabled: boolean;
  installPolicy: ProviderPluginInstallPolicy;
  authPolicy: ProviderPluginAuthPolicy;
  interface?: ProviderPluginInterface;
}

export interface ProviderPluginMarketplaceInterface {
  displayName?: string;
}

export interface ProviderPluginMarketplaceDescriptor {
  name: string;
  path: string | null;
  interface?: ProviderPluginMarketplaceInterface;
  plugins: ProviderPluginDescriptor[];
}

export interface ProviderPluginMarketplaceLoadError {
  marketplacePath: string;
  message: string;
}

export interface ProviderListPluginsInput {
  provider: AgentProvider;
  cwd?: string;
  threadId?: string;
  forceRemoteSync?: boolean;
  forceReload?: boolean;
}

export interface ProviderListPluginsResult {
  marketplaces: ProviderPluginMarketplaceDescriptor[];
  marketplaceLoadErrors: ProviderPluginMarketplaceLoadError[];
  remoteSyncError: string | null;
  featuredPluginIds: string[];
  source?: string;
  cached?: boolean;
}

export interface ProviderPluginAppSummary {
  id: string;
  name: string;
  description?: string;
  installUrl?: string;
  needsAuth: boolean;
}

export interface ProviderPluginDetail {
  marketplaceName: string;
  marketplacePath: string | null;
  summary: ProviderPluginDescriptor;
  description?: string;
  skills: ProviderSkillDescriptor[];
  apps: ProviderPluginAppSummary[];
  mcpServers: string[];
}

export interface ProviderReadPluginInput {
  provider: AgentProvider;
  marketplacePath?: string | null;
  remoteMarketplaceName?: string | null;
  pluginName: string;
}

export interface ProviderReadPluginResult {
  plugin: ProviderPluginDetail;
  source?: string;
  cached?: boolean;
}

export type AutomationScheduleKind = 'once' | 'daily' | 'weekly' | 'interval';

export interface AutomationSchedule {
  kind: AutomationScheduleKind;
  timeOfDay?: string | null;
  dayOfWeek?: number | null;
  intervalMinutes?: number | null;
  runAt?: number | null;
}

export interface AutomationRuntimeConfig {
  provider: AgentProvider;
  model?: string | null;
  compatibleProviderId?: ClaudeCompatibleProviderId | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  codexFastMode?: boolean;
}

export type AutomationRunStatus = 'running' | 'completed' | 'failed';

export interface AutomationDefinition {
  id: string;
  name: string;
  projectCwd: string;
  prompt: string;
  schedule: AutomationSchedule;
  runtime: AutomationRuntimeConfig;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: AutomationRunStatus | null;
  lastRunSessionId: string | null;
  runCount: number;
  failureCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  sessionId: string | null;
  status: AutomationRunStatus;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface UpsertAutomationInput {
  id?: string;
  name: string;
  projectCwd: string;
  prompt: string;
  schedule: AutomationSchedule;
  runtime: AutomationRuntimeConfig;
  enabled?: boolean;
}

export interface AutomationSnapshot {
  automations: AutomationDefinition[];
  recentRuns: AutomationRunRecord[];
}

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
  | { type: 'runner.prewarm'; payload: RunnerPrewarmPayload }
  | { type: 'session.delete'; payload: { sessionId: string } }
  | { type: 'session.togglePin'; payload: { sessionId: string } }
  | { type: 'permission.response'; payload: PermissionResponsePayload }
  // MCP 事件
  | { type: 'mcp.get-config'; payload?: { projectPath?: string } }
  | { type: 'mcp.save-config'; payload: {
      servers?: Record<string, McpServerConfig>;
      globalServers?: Record<string, McpServerConfig>;
      projectServers?: Record<string, McpServerConfig>;
      codexGlobalServers?: Record<string, McpServerConfig>;
      opencodeGlobalServers?: Record<string, McpServerConfig>;
      opencodeProjectServers?: Record<string, McpServerConfig>;
      kimiGlobalServers?: Record<string, McpServerConfig>;
      kimiProjectServers?: Record<string, McpServerConfig>;
      projectPath?: string;
  } }
  // Skills 事件
  | { type: 'skills.list'; payload?: { projectPath?: string } }
  // 文件夹事件
  | { type: 'folder.list' }
  | { type: 'folder.create'; payload: { path: string; displayName?: string } }
  | { type: 'folder.update'; payload: { path: string; updates: Partial<FolderConfig> } }
  | { type: 'folder.delete'; payload: { path: string } }
  | { type: 'folder.move'; payload: { oldPath: string; newPath: string } }
  | { type: 'session.setFolder'; payload: { sessionId: string; folderPath: string | null } }
  | { type: 'session.setChannel'; payload: { sessionId: string; channelId: string } }
  | { type: 'session.setTeam'; payload: { sessionId: string; teamMode: SessionTeamMode; teamId?: string | null } };

export interface AppUpdateStatus {
  available: boolean;
  version: string | null;
  autoDetected: boolean;
}

// Server -> Client 事件
export type ServerEvent =
  | { type: 'session.list'; payload: { sessions: SessionInfo[] } }
  | { type: 'session.status'; payload: SessionStatusPayload }
  | { type: 'session.history'; payload: SessionHistoryPayload }
  | { type: 'session.deleted'; payload: { sessionId: string } }
  | { type: 'session.pinned'; payload: { sessionId: string; pinned: boolean } }
  | {
      type: 'stream.user_prompt';
      payload: { sessionId: string; prompt: string; attachments?: Attachment[]; createdAt?: number };
    }
  | { type: 'stream.message'; payload: { sessionId: string; message: StreamMessage } }
  | { type: 'permission.request'; payload: PermissionRequestPayload }
  | { type: 'runner.error'; payload: { message: string; sessionId?: string } }
  | { type: 'project.tree'; payload: { cwd: string; tree: ProjectTreeNode | null } }
  | {
      type: 'project.file';
      payload: {
        cwd: string;
        filePath: string;
        text: string;
        mtimeMs: number;
        size: number;
        exists: boolean;
      };
    }
  | { type: 'app.update'; payload: AppUpdateStatus }
  // MCP 事件
  | { type: 'mcp.config'; payload: {
      servers: Record<string, McpServerConfig>;
      globalServers?: Record<string, McpServerConfig>;
      projectServers?: Record<string, McpServerConfig>;
      codexGlobalServers?: Record<string, McpServerConfig>;
      opencodeGlobalServers?: Record<string, McpServerConfig>;
      opencodeProjectServers?: Record<string, McpServerConfig>;
      kimiGlobalServers?: Record<string, McpServerConfig>;
      kimiProjectServers?: Record<string, McpServerConfig>;
    } }
  | { type: 'mcp.status'; payload: { servers: McpServerStatus[] } }
  | { type: 'skills.list'; payload: {
      userRoot: string;
      projectRoot?: string;
      userSkills: ClaudeSkillSummary[];
      projectSkills: ClaudeSkillSummary[];
    } }
  // 文件夹事件
  | { type: 'folder.list'; payload: { folders: FolderConfig[] } }
  | { type: 'folder.changed'; payload: { folders: FolderConfig[] } }
  | { type: 'session.folderChanged'; payload: { sessionId: string; folderPath: string | null } }
  | { type: 'session.channelChanged'; payload: { sessionId: string; channelId: string } }
  | { type: 'session.teamChanged'; payload: { sessionId: string; teamMode: SessionTeamMode; teamId: string | null } }
  | { type: 'automation.changed'; payload: AutomationSnapshot }
  // 系统通知点击后的回位事件（主进程 → 聚焦窗口后广播）
  | { type: 'app.focusSession'; payload: { sessionId: string } };

// Payload 类型
export interface SessionStartPayload {
  title: string;
  prompt: string;
  effectivePrompt?: string;
  automationRunId?: string;
  skipTitleGeneration?: boolean;
  cwd?: string;
  projectCwd?: string | null;
  envMode?: ThreadEnvironmentMode;
  worktreePath?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  scope?: SessionScope;
  agentId?: string | null;
  allowedTools?: string;
  attachments?: Attachment[];
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  kimiPermissionMode?: KimiPermissionMode;
  grokPermissionMode?: GrokPermissionMode;
  grokReasoningEffort?: GrokReasoningEffort;
  codexSkills?: ProviderInputReference[];
  codexMentions?: ProviderInputReference[];
  opencodePermissionMode?: OpenCodePermissionMode;
  teamMode?: SessionTeamMode;
  teamId?: string | null;
  hiddenFromThreads?: boolean;
  channelId?: string;
  // "在隔离副本中运行"：开跑前在项目里建一个 worktree，session 全程活在里面
  createIsolatedWorkspace?: boolean;
}

// ── Claude rewind (conversation/files checkpoint restore) ───────────────────

export type ClaudeRewindScope = 'conversation' | 'files' | 'both';

export interface ClaudeRewindInput {
  sessionId: string;
  /** UUID of the SDK user message that anchors the checkpoint. */
  anchorMessageId: string;
  scope: ClaudeRewindScope;
  /** Preview only: report what a files rewind would change without executing. */
  dryRun?: boolean;
}

export interface ClaudeRewindFilesOutcome {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

export interface ClaudeRewindResult {
  ok: boolean;
  message?: string;
  /** Whether a live query exists so files can be rewound at all. */
  filesAvailable: boolean;
  files?: ClaudeRewindFilesOutcome | null;
  /** Prompt text of the rewound-away user message, for composer restore. */
  removedPrompt?: string | null;
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
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  kimiPermissionMode?: KimiPermissionMode;
  grokPermissionMode?: GrokPermissionMode;
  grokReasoningEffort?: GrokReasoningEffort;
  codexSkills?: ProviderInputReference[];
  codexMentions?: ProviderInputReference[];
  opencodePermissionMode?: OpenCodePermissionMode;
  teamMode?: SessionTeamMode;
  teamId?: string | null;
}

/**
 * Composer snapshot for speculative runner prewarm (P3). Carries the SAME
 * fields the composer would send on `session.continue` — the prewarm entry's
 * config must normalize identically to the eventual send, or the send-path
 * reuse check aborts the prewarmed runner and pays a second cold start.
 */
export interface RunnerPrewarmPayload {
  sessionId: string;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  claudeReasoningEffort?: ClaudeReasoningEffort;
}

export type SessionScope = 'project' | 'dm';
export type ThreadEnvironmentMode = 'local' | 'worktree';

export interface SessionWorkspaceState {
  envMode?: ThreadEnvironmentMode;
  projectCwd?: string | null;
  worktreePath?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  current: boolean;
}

export interface GitBranchInfo {
  name: string;
  fullRef: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  shortHash: string;
  worktreePath?: string | null;
}

export type GitPullRequestLookupStatus = 'found' | 'not_found' | 'unknown';

export interface GitPullRequestSummary {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  url: string;
}

export interface GitRepositoryInfo {
  root: string | null;
  originUrl: string | null;
  owner: string | null;
  name: string | null;
  fullName: string | null;
  webUrl: string | null;
  defaultBranch: string | null;
}

export interface GitOverviewResult {
  ok: boolean;
  error: string | null;
  hasRepo: boolean;
  repoRoot: string | null;
  repository: GitRepositoryInfo | null;
  branch: string | null;
  upstream: string | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  hasOriginRemote: boolean;
  isGitHubRemote: boolean;
  isDefaultBranch: boolean;
  totalChanges: number;
  insertions: number;
  deletions: number;
  prStatus: GitPullRequestLookupStatus;
  pr: GitPullRequestSummary | null;
}

export interface GitChangeEntry {
  filePath: string;
  status: string;
  staged: boolean;
}

export type GitPatchScope = 'working-tree' | 'unstaged' | 'staged' | 'branch';

export interface GitPatchResult {
  ok: boolean;
  error: string | null;
  scope: GitPatchScope;
  patch: string;
  repoRoot: string | null;
  baseRef?: string | null;
  truncated: boolean;
}

export type EnvironmentEditorId =
  | 'finder'
  | 'system'
  | 'cursor'
  | 'vscode'
  | 'windsurf'
  | 'zed'
  | 'trae'
  | 'intellij'
  | 'webstorm'
  | 'sublime';

export interface EnvironmentEditorLauncher {
  id: EnvironmentEditorId;
  label: string;
  available: boolean;
  appName?: string;
  appPath?: string;
  command?: string;
  iconDataUrl?: string;
}

export interface OpenInEditorInput {
  cwd: string;
  editorId: EnvironmentEditorId;
}

export interface SessionEnvironmentNote {
  sessionId: string;
  note: string;
  updatedAt: number | null;
}

export interface SessionEnvironmentRecap {
  sessionId: string;
  summary: string;
  updatedAt: number | null;
  source: 'derived' | 'generated' | 'empty';
}

export interface SessionEnvironmentContext {
  sessionId: string;
  note: SessionEnvironmentNote;
  recap: SessionEnvironmentRecap;
}

export interface GitCheckoutBranchInput {
  cwd: string;
  branch: string;
  sessionId?: string | null;
}

export interface GitCreateBranchInput {
  cwd: string;
  branch: string;
  sessionId?: string | null;
}

export interface GitCreateWorktreeInput {
  cwd: string;
  branch: string;
  newBranch?: string | null;
  path?: string | null;
}

export interface GitSessionHandoffInput {
  sessionId: string;
  targetMode: ThreadEnvironmentMode;
  branch?: string | null;
  newBranch?: string | null;
  worktreePath?: string | null;
  includeChanges?: boolean;
}

export type SessionTeamMode = 'channel_default' | 'solo' | 'team' | 'manual';

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  scope?: SessionScope;
  agentId?: string | null;
  source?: SessionSource;
  readOnly?: boolean;
  cwd?: string;
  projectCwd?: string | null;
  envMode?: ThreadEnvironmentMode;
  worktreePath?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  claudeSessionId?: string;
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  kimiPermissionMode?: KimiPermissionMode;
  grokPermissionMode?: GrokPermissionMode;
  grokReasoningEffort?: GrokReasoningEffort;
  opencodePermissionMode?: OpenCodePermissionMode;
  pinned?: boolean;
  folderPath?: string | null;
  hiddenFromThreads?: boolean;
  channelId?: string;
  teamMode?: SessionTeamMode;
  teamId?: string | null;
  /** Set when this session was created by handing off from another agent. */
  handoffSourceProvider?: AgentProvider | null;
  latestClaudeModelUsage?: LatestClaudeModelUsage;
  createdAt: number;
  updatedAt: number;
}

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

export interface SessionStatusPayload {
  sessionId: string;
  status: SessionStatus;
  scope?: SessionScope;
  agentId?: string | null;
  source?: SessionSource;
  readOnly?: boolean;
  title?: string;
  cwd?: string;
  projectCwd?: string | null;
  envMode?: ThreadEnvironmentMode;
  worktreePath?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  error?: string;
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  kimiPermissionMode?: KimiPermissionMode;
  grokPermissionMode?: GrokPermissionMode;
  grokReasoningEffort?: GrokReasoningEffort;
  opencodePermissionMode?: OpenCodePermissionMode;
  hiddenFromThreads?: boolean;
  channelId?: string;
  teamMode?: SessionTeamMode;
  teamId?: string | null;
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

export type CodexApprovalKind = 'command' | 'file-change' | 'permissions' | 'tool';

export interface CodexApprovalPermissionInput {
  kind: 'codex-approval';
  approvalKind: CodexApprovalKind;
  method: string;
  question: string;
  title: string;
  toolName: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  filePath?: string | null;
  files?: string[];
  grantRoot?: string | null;
  permissionSummary?: string[];
  canAllowForSession?: boolean;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind?: string;
  description?: string;
}

export interface AcpPermissionInput {
  kind: 'acp-permission';
  provider: 'kimi' | 'grok' | 'opencode';
  question: string;
  title: string;
  toolName: string;
  options: AcpPermissionOption[];
  toolCall?: Record<string, unknown> | null;
}

export type PermissionRequestInput =
  | AskUserQuestionInput
  | ExternalFilePermissionInput
  | CodexApprovalPermissionInput
  | AcpPermissionInput;

// StreamMessage 类型（SDK 消息或内部消息）
export type StreamMessageBase = {
  createdAt?: number;
  agentId?: string | null;
  agentRunId?: string | null;
  parentTurnId?: string | null;
  /**
   * Claude Agent SDK subagent attribution. Messages emitted while a Task
   * (subagent) tool call runs carry that Task's tool_use id here; top-level
   * messages leave it null/undefined. The transcript nests parented messages
   * under their Task row instead of rendering them inline.
   */
  parentToolUseId?: string | null;
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
  | (StreamMessageBase & {
      type: 'system';
      subtype: 'token_usage';
      uuid: string;
      session_id: string;
      provider: 'codex';
      usage: CodexContextUsage;
    })
  | (StreamMessageBase & { type: 'assistant'; uuid: string; message: AssistantMessage; streaming?: boolean })
  | (StreamMessageBase & { type: 'user'; uuid: string; message: UserMessage })
  | (StreamMessageBase & {
      type: 'result';
      subtype: 'success' | string;
      duration_ms: number;
      total_cost_usd: number;
      usage: Usage;
      model?: string;
      modelUsage?: Record<string, ClaudeModelUsage>;
    })
  | (StreamMessageBase & {
      type: 'plan_update';
      uuid: string;
      turnId: string;
      explanation?: string | null;
      steps: PlanStep[];
    })
  | (StreamMessageBase & {
      type: 'proposed_plan';
      uuid: string;
      planMarkdown: string;
      turnId?: string;
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
  | { type: 'thinking'; thinking: string; signature?: string; durationMs?: number }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'memory_citations'; citations: MemoryCitation[] };

export interface MemoryCitation {
  source: string;
  lineStart?: number;
  lineEnd?: number;
  note?: string;
}

// ===== Canonical tool kinds =====
// Provider-agnostic taxonomy used by the UI to drive icons, copy, and grouping
// without leaking specific tool names from any single provider (Claude / Codex
// / OpenCode). Adapters can map their native tool concepts onto this vocabulary;
// new providers slot in by adding entries to the classifier rather than UI code.
export type CanonicalToolKind =
  | 'reasoning'
  | 'file_read'
  | 'file_change'
  | 'command_execution'
  | 'pattern_search'
  | 'web_search'
  | 'mcp_tool_call'
  | 'subagent'
  | 'todo_update'
  | 'memory'
  | 'image_view'
  | 'approval'
  | 'unknown';

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
  reasoning_output_tokens?: number | null;
  context_window?: number | null;
  total_tokens?: number | null;
}

export interface CodexContextUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  contextWindow: number;
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

export type AgentRuntimeState = 'ready' | 'login_required' | 'not_installed' | 'error';

export interface AgentRuntimeEntry {
  provider: AgentProvider;
  title: string;
  state: AgentRuntimeState;
  version: string | null;
  summary: string;
  detail: string | null;
  installCommand: string | null;
  loginCommand: string | null;
  docsUrl: string | null;
  checkedAt: number;
}

export interface AgentRuntimeDirectoryReport {
  entries: AgentRuntimeEntry[];
  readyCount: number;
  checkedAt: number;
}

export interface UserProfile {
  displayName: string;
  handle: string;
  /** True when the user set the name themselves (vs. git/OS defaults). */
  customized: boolean;
}

export interface UserProfileUpdate {
  displayName: string | null;
  handle: string | null;
}

export type ClaudeUsageRangeDays = 7 | 30 | 90 | 365;

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

export type CodexRateLimitReachedType =
  | 'rate_limit_reached'
  | 'workspace_owner_credits_depleted'
  | 'workspace_member_credits_depleted'
  | 'workspace_owner_usage_limit_reached'
  | 'workspace_member_usage_limit_reached';

export interface CodexRateLimitWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsSnapshot | null;
  planType: string | null;
  rateLimitReachedType: CodexRateLimitReachedType | null;
}

export interface CodexRateLimitReport {
  source: 'codex-app-server';
  fetchedAt: number;
  rateLimits: CodexRateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot>;
}

export interface ClaudePlanUsageWindow {
  /** Percentage of the window used, 0-100. */
  utilization: number | null;
  /** Epoch ms when the window resets. */
  resetsAt: number | null;
}

export interface ClaudePlanModelWindow extends ClaudePlanUsageWindow {
  /** Server-supplied label for the model bucket (e.g. "Opus"). */
  displayName: string;
}

export interface ClaudePlanExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface ClaudePlanUsageReport {
  source: 'claude-agent-sdk';
  fetchedAt: number;
  /** claude.ai subscription type ('pro', 'max', ...) or null for API key / 3P sessions. */
  subscriptionType: string | null;
  /** False when plan rate limits do not apply (API key, Bedrock, Vertex, ...). */
  rateLimitsAvailable: boolean;
  fiveHour: ClaudePlanUsageWindow | null;
  sevenDay: ClaudePlanUsageWindow | null;
  sevenDayOpus: ClaudePlanUsageWindow | null;
  sevenDaySonnet: ClaudePlanUsageWindow | null;
  modelScoped: ClaudePlanModelWindow[];
  extraUsage: ClaudePlanExtraUsage | null;
}

export interface GrokPlanUsagePeriod {
  /** Server period kind, e.g. 'USAGE_PERIOD_TYPE_WEEKLY'. */
  type: string | null;
  /** Epoch ms when the current period started. */
  startsAt: number | null;
  /** Epoch ms when the current period ends (usage resets). */
  endsAt: number | null;
}

export interface GrokPlanUsageReport {
  source: 'grok-acp';
  fetchedAt: number;
  /** grok.com subscription tier (e.g. 'X Premium+') or null when unknown. */
  subscriptionTier: string | null;
  /** Percentage of the current period's included credits used, 0-100. */
  creditUsagePercent: number | null;
  currentPeriod: GrokPlanUsagePeriod | null;
  onDemandCap: number | null;
  onDemandUsed: number | null;
  prepaidBalance: number | null;
}

/** Lightweight index entry for the chat outline rail: one per user prompt. */
export interface SessionUserPromptSummary {
  /** Epoch ms; matches the message's createdAt for history navigation. */
  createdAt: number;
  /** Prompt text truncated for preview display. */
  text: string;
  attachmentNames: string[];
  /** The turn's last top-level assistant text, truncated ('' while pending). */
  replyText: string;
  /** File names touched by the turn's mutating tool calls, in first-touch order. */
  changedFiles: string[];
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
