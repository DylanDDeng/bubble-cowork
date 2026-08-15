/**
 * Provider Adapter Architecture
 *
 * Adapted from Synara's (formerly dpcode) ProviderAdapter pattern for Aegis's
 * Electron architecture without Effect-TS.
 *
 * Core concepts:
 * - ProviderKind: identifies agent type (claude | codex | opencode | kimi | grok | pi)
 * - ProviderAdapter: encapsulates provider-specific process management and protocol
 * - ProviderSessionDirectory: maps threadId -> provider binding + resume cursor
 * - ProviderService: orchestrates multiple adapters, routes by threadId
 */

import type { EventEmitter } from 'events';
import type {
  StreamMessage,
  Attachment,
  PermissionResult,
  CodexPermissionMode,
  CodexExecutionMode,
  CodexReasoningEffort,
  KimiPermissionMode,
  KimiThinking,
  GrokPermissionMode,
  GrokReasoningEffort,
  DeepseekAgentPreset,
  DeepseekPermissionMode,
  DeepseekReasoningEffort,
  OpenCodePermissionMode,
  QoderPermissionMode,
  BubblePermissionMode,
  ClaudeAccessMode,
  ClaudeExecutionMode,
  ClaudeReasoningEffort,
  ClaudeCompatibleProviderId,
  CodexRateLimitReport,
  QoderPlanUsageReport,
  ProviderComposerCapabilities,
  ProviderInputReference,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderInstallPluginInput,
  ProviderReadPluginInput,
  ProviderUninstallPluginInput,
  ProviderReadPluginResult,
} from '../../../shared/types';
import type { SessionRow } from '../../types';

// ── Provider Identity ──────────────────────────────────────────────────────

export type ProviderKind = 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'pi' | 'qoder' | 'bubble' | 'deepseek';

export interface ProviderAdapterCapabilities {
  /** Supports switching model mid-session */
  sessionModelSwitch: boolean;
  /** Supports skill discovery */
  skillDiscovery: boolean;
  /** Supports plugin discovery */
  pluginDiscovery?: boolean;
  /** Supports MCP servers */
  mcpServers: boolean;
  /** Supports image attachments */
  imageAttachments: boolean;
  /** Supports thread forking */
  forkThread: boolean;
  /** Supports thread compaction */
  compactThread: boolean;
  /** Supports plan mode */
  planMode: boolean;
}

// ── Session Lifecycle Input ────────────────────────────────────────────────

export interface ProviderSessionStartInput {
  provider: ProviderKind;
  threadId: string;
  cwd: string;
  prompt: string;
  attachments?: Attachment[];
  model?: string;
  resumeSessionId?: string;

  // Provider-specific config
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  kimiPermissionMode?: KimiPermissionMode;
  kimiThinking?: KimiThinking;
  grokPermissionMode?: GrokPermissionMode;
  grokReasoningEffort?: GrokReasoningEffort;
  deepseekPermissionMode?: DeepseekPermissionMode;
  deepseekAgentPreset?: DeepseekAgentPreset;
  deepseekReasoningEffort?: DeepseekReasoningEffort;
  codexSkills?: ProviderInputReference[];
  codexMentions?: ProviderInputReference[];
  opencodePermissionMode?: OpenCodePermissionMode;
  qoderPermissionMode?: QoderPermissionMode;
  bubblePermissionMode?: BubblePermissionMode;
  /** Bubble thinking level (per-model open set). Absent = SDK/model default. */
  bubbleThinkingLevel?: string;
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
}

export interface ProviderSendTurnInput {
  threadId: string;
  prompt: string;
  attachments?: Attachment[];
  model?: string;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  kimiPermissionMode?: KimiPermissionMode;
  kimiThinking?: KimiThinking;
  grokPermissionMode?: GrokPermissionMode;
  grokReasoningEffort?: GrokReasoningEffort;
  deepseekPermissionMode?: DeepseekPermissionMode;
  deepseekReasoningEffort?: DeepseekReasoningEffort;
  opencodePermissionMode?: OpenCodePermissionMode;
  qoderPermissionMode?: QoderPermissionMode;
  bubblePermissionMode?: BubblePermissionMode;
  /** Bubble thinking level (per-model open set). Absent = SDK/model default. */
  bubbleThinkingLevel?: string;
  codexSkills?: ProviderInputReference[];
  codexMentions?: ProviderInputReference[];
}

export interface ProviderSession {
  threadId: string;
  provider: ProviderKind;
  providerSessionId: string;
  status: ProviderSessionStatus;
  model?: string;
}

export type ProviderSessionStatus = 'connecting' | 'running' | 'completed' | 'error' | 'stopped';

// ── Runtime Events ─────────────────────────────────────────────────────────

export type ProviderRuntimeEvent =
  | { type: 'message'; threadId: string; message: StreamMessage }
  // Incremental stdout/stderr from a running tool call. Transient display
  // data for the live tool card — never enters the transcript.
  | { type: 'tool_output_delta'; threadId: string; toolUseId: string; delta: string }
  | { type: 'permission_request'; threadId: string; requestId: string; toolName: string; input: unknown }
  // The provider resolved/abandoned a pending permission request itself
  // (process death, stop, serverRequest/resolved) — UI should drop the card.
  | { type: 'permission_dismissed'; threadId: string; requestId: string }
  | { type: 'status_change'; threadId: string; status: ProviderSessionStatus }
  // Two-phase stop settled (codex): confirmed=false means the provider never
  // acknowledged the interrupt within the timeout.
  | {
      type: 'stop_settled';
      threadId: string;
      providerThreadId: string;
      generation: number;
      confirmed: boolean;
      noTurn?: boolean;
    }
  // Provider-authoritative model catalog refresh. Process-scoped: threadId is
  // always null (present so per-thread event filters type-check and skip it).
  // `provider` discriminates the consumer (codex emits without it — legacy
  // default; qoder emits 'qoder' + defaultModel so the IPC layer can persist
  // and rebroadcast without touching codex settings).
  | {
      type: 'model_catalog_updated';
      threadId: null;
      provider?: ProviderKind;
      models: unknown[];
      defaultModel?: string | null;
    }
  // An MCP OAuth flow started via mcpServer/oauth/login finished. Process-
  // scoped (threadId null): consumed by the settings panel, not sessions.
  | {
      type: 'mcp_oauth_login_completed';
      threadId: null;
      serverName: string;
      success: boolean;
      error: string | null;
    }
  | { type: 'error'; threadId: string; error: Error }
  | { type: 'system_init'; threadId: string; sessionId: string; model?: string }
  // The agent switched its own permission mode mid-turn (e.g. Bubble's plan
  // approval calls setMode('default')) — lets the composer pill follow the
  // runtime instead of staying stuck on the mode it last sent.
  | { type: 'permission_mode_changed'; threadId: string; provider: ProviderKind; mode: string };

// ── Adapter Contract ───────────────────────────────────────────────────────

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly displayName: string;
  readonly capabilities: ProviderAdapterCapabilities;

  // Session lifecycle
  startSession(input: ProviderSessionStartInput): Promise<ProviderSession>;
  sendTurn(input: ProviderSendTurnInput): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  stopAll(): Promise<void>;
  listSessions(): ProviderSession[];
  hasSession(threadId: string): boolean;

  /**
   * Quiet, synchronous, idempotent teardown of this thread's local resources
   * (event loops, child processes, SDK handles) WITHOUT the protocol side
   * effects of stopSession — never emits status_change / stop_settled /
   * synthesized turn results (per-requestId permission_dismissed IS allowed:
   * it clears stranded approval cards and cannot be misread by stop gates),
   * and never throws. Returns true iff resources were actually released —
   * false means either "nothing to release" (unknown/already-clean thread)
   * or "policy no-op" (codex/kimi sessions are not locally owned), and the
   * caller must then leave the directory binding alone. Used when retiring
   * an errored runner and defensively before a same-thread startSession
   * overwrite ("never orphan" enforced at the owning layer).
   */
  disposeSession(threadId: string): boolean;

  // Permission responses
  respondToRequest(threadId: string, requestId: string, decision: PermissionResult): Promise<void>;
  runOneShot?(input: ProviderSessionStartInput): Promise<{ text: string; sessionId?: string; model?: string }>;

  /**
   * Fork a recorded provider thread into a new independent one. Present only
   * on adapters with capabilities.forkThread; returns the forked thread id.
   */
  forkThread?(input: { cwd: string; providerThreadId: string }): Promise<string>;

  /**
   * Manual `/rewind` (bubble): restore files and/or truncate the provider
   * session to just before the given anchor (a user-turn entry id). `dryRun`
   * reports the file outcome without executing.
   */
  rewind?(
    threadId: string,
    anchorId: string,
    scope: 'conversation' | 'files' | 'both',
    dryRun?: boolean
  ): Promise<ProviderRewindResult>;
  /** User turns the provider can rewind to (oldest first). */
  listRewindAnchors?(threadId: string): Promise<ProviderRewindAnchor[]>;

  // Optional provider discovery APIs
  getComposerCapabilities?(): ProviderComposerCapabilities;
  getRateLimits?(): Promise<CodexRateLimitReport>;
  getPlanUsage?(): Promise<QoderPlanUsageReport>;
  /** Runtime status of provider-managed MCP servers (codex). */
  listMcpServerStatus?(): Promise<import('../../../shared/types').CodexMcpServerRuntimeStatus[]>;
  /** Start an MCP OAuth flow (codex); outcome arrives as mcp_oauth_login_completed. */
  startMcpOauthLogin?(serverName: string): Promise<{ authorizationUrl: string }>;
  listSkills?(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult>;
  listPlugins?(input: ProviderListPluginsInput): Promise<ProviderListPluginsResult>;
  readPlugin?(input: ProviderReadPluginInput): Promise<ProviderReadPluginResult>;
  installPlugin?(input: ProviderInstallPluginInput): Promise<void>;
  uninstallPlugin?(input: ProviderUninstallPluginInput): Promise<void>;

  // Event stream (all events from this provider)
  readonly events: EventEmitter;
}

export interface ProviderRewindAnchor {
  id: string;
  preview: string;
  text: string;
}

export interface ProviderRewindFilesOutcome {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
}

export interface ProviderRewindResult {
  ok: boolean;
  message?: string;
  filesAvailable: boolean;
  files?: ProviderRewindFilesOutcome | null;
  removedPrompt?: string | null;
}

// ── Session Directory ──────────────────────────────────────────────────────

export interface ProviderRuntimeBinding {
  threadId: string;
  provider: ProviderKind;
  status: ProviderSessionStatus;
  /** Opaque resume token owned by the adapter */
  resumeCursor?: string | null;
  /** Adapter-specific runtime payload */
  runtimePayload?: unknown;
}

export interface ProviderSessionDirectory {
  upsert(binding: ProviderRuntimeBinding): void;
  getProvider(threadId: string): ProviderKind | null;
  getBinding(threadId: string): ProviderRuntimeBinding | null;
  remove(threadId: string): void;
  listThreadIds(): string[];
}

// ── Service Orchestrator ───────────────────────────────────────────────────

export interface ProviderService {
  // Adapter management
  registerAdapter(adapter: ProviderAdapter): void;
  getAdapter(provider: ProviderKind): ProviderAdapter | null;
  listAdapters(): ProviderAdapter[];

  // Session lifecycle (routes by threadId via directory)
  startSession(input: ProviderSessionStartInput): Promise<ProviderSession>;
  sendTurn(input: ProviderSendTurnInput): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  stopAll(): Promise<void>;
  listSessions(): ProviderSession[];
  /** Quiet teardown (see ProviderAdapter.disposeSession); removes the
   * directory binding only when the adapter actually released resources. */
  disposeSession(threadId: string): boolean;

  // Permission
  respondToRequest(threadId: string, requestId: string, decision: PermissionResult): Promise<void>;

  // Discovery
  getComposerCapabilities(provider: ProviderKind): ProviderComposerCapabilities;
  getRateLimits(provider: ProviderKind): Promise<CodexRateLimitReport | null>;
  getPlanUsage(provider: ProviderKind): Promise<QoderPlanUsageReport | null>;
  listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult>;
  rewind(
    threadId: string,
    anchorId: string,
    scope: 'conversation' | 'files' | 'both',
    dryRun?: boolean
  ): Promise<ProviderRewindResult>;
  listRewindAnchors(threadId: string): Promise<ProviderRewindAnchor[]>;
  listPlugins(input: ProviderListPluginsInput): Promise<ProviderListPluginsResult>;
  readPlugin(input: ProviderReadPluginInput): Promise<ProviderReadPluginResult>;
  installPlugin(input: ProviderInstallPluginInput): Promise<void>;
  uninstallPlugin(input: ProviderUninstallPluginInput): Promise<void>;

  // Events (merged from all adapters)
  readonly events: EventEmitter;

  // Directory access
  readonly directory: ProviderSessionDirectory;

  // One-shot prompt (for title generation, bootstrapping)
  runOneShot(input: ProviderSessionStartInput): Promise<{ text: string; sessionId?: string; model?: string }>;
}

// ── Convenience: convert provider -> runtime event ─────────────────────────

export function createMessageEvent(
  threadId: string,
  message: StreamMessage
): ProviderRuntimeEvent {
  return { type: 'message', threadId, message };
}

export function createPermissionRequestEvent(
  threadId: string,
  requestId: string,
  toolName: string,
  input: unknown
): ProviderRuntimeEvent {
  return { type: 'permission_request', threadId, requestId, toolName, input };
}

export function createStatusChangeEvent(
  threadId: string,
  status: ProviderSessionStatus
): ProviderRuntimeEvent {
  return { type: 'status_change', threadId, status };
}

export function createErrorEvent(threadId: string, error: Error): ProviderRuntimeEvent {
  return { type: 'error', threadId, error };
}

export function createSystemInitEvent(
  threadId: string,
  sessionId: string,
  model?: string
): ProviderRuntimeEvent {
  return { type: 'system_init', threadId, sessionId, model };
}
