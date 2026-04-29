/**
 * Provider Adapter Architecture
 *
 * Inspired by T3Code/dpcode's ProviderAdapter pattern, adapted for Aegis's
 * Electron architecture without Effect-TS.
 *
 * Core concepts:
 * - ProviderKind: identifies agent type (claude | codex | opencode)
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
  OpenCodePermissionMode,
  ClaudeAccessMode,
  ClaudeExecutionMode,
  ClaudeCompatibleProviderId,
  ProviderComposerCapabilities,
  ProviderInputReference,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
} from '../../../shared/types';
import type { SessionRow } from '../../types';

// ── Provider Identity ──────────────────────────────────────────────────────

export type ProviderKind = 'claude' | 'codex' | 'opencode';

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
  codexSkills?: ProviderInputReference[];
  codexMentions?: ProviderInputReference[];
  opencodePermissionMode?: OpenCodePermissionMode;
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
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
  | { type: 'permission_request'; threadId: string; requestId: string; toolName: string; input: unknown }
  | { type: 'status_change'; threadId: string; status: ProviderSessionStatus }
  | { type: 'error'; threadId: string; error: Error }
  | { type: 'system_init'; threadId: string; sessionId: string; model?: string };

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

  // Permission responses
  respondToRequest(threadId: string, requestId: string, decision: PermissionResult): Promise<void>;

  // Optional provider discovery APIs
  getComposerCapabilities?(): ProviderComposerCapabilities;
  listSkills?(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult>;
  listPlugins?(input: ProviderListPluginsInput): Promise<ProviderListPluginsResult>;
  readPlugin?(input: ProviderReadPluginInput): Promise<ProviderReadPluginResult>;

  // Event stream (all events from this provider)
  readonly events: EventEmitter;
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

  // Permission
  respondToRequest(threadId: string, requestId: string, decision: PermissionResult): Promise<void>;

  // Discovery
  getComposerCapabilities(provider: ProviderKind): ProviderComposerCapabilities;
  listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult>;
  listPlugins(input: ProviderListPluginsInput): Promise<ProviderListPluginsResult>;
  readPlugin(input: ProviderReadPluginInput): Promise<ProviderReadPluginResult>;

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
