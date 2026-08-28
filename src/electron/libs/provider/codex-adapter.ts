import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type {
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSessionStatus,
} from './types';
import {
  CodexAppServerManager,
  CodexThreadBindingError,
  type CodexReviewTarget,
} from './codex-app-server-manager';
import { isDev } from '../../util';
import {
  AEGIS_BLOCKED_BROWSER_OPEN_MESSAGE,
  shouldBlockSystemBrowserPreviewOpen,
} from '../browser-preview-policy';
import { persistComputerUseMedia } from '../codex-computer-use';
import { computerUseGrants } from '../codex-computer-use-grants';
import {
  parseMcpToolApprovalElicitation,
  type McpToolApprovalElicitation,
} from '../codex-computer-use-elicitation';
import {
  classifyComputerUseAction,
  formatComputerUseLabel,
  isDeniedComputerUseTarget,
  type ComputerUseLiveFrame,
} from '../../../shared/computer-use';
import { homedir } from 'os';
import { join } from 'path';
import { withGeneratedMediaInput } from '../../../shared/generated-media';
import type {
  CodexApprovalKind,
  CodexApprovalPermissionInput,
  ComputerUsePermissionInput,
  ContentBlock,
  PermissionResult,
  PlanStepStatus,
  ProviderComposerCapabilities,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderInstallPluginInput,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
  ProviderUninstallPluginInput,
  StreamMessage,
  CodexRateLimitReport,
} from '../../../shared/types';

/**
 * Real app version for the initialize clientInfo (was hardcoded '0.0.20').
 * Falls back to npm's env in non-Electron contexts (tests, harness).
 */
function resolveClientVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    const version = app?.getVersion?.();
    if (version) return version;
  } catch {
    // not running under electron
  }
  return process.env.npm_package_version || '0.0.0';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function getString(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : '';
}

function resolveComputerUseUserDataDir(): string {
  const override = process.env.AEGIS_USER_DATA_DIR?.trim();
  if (override) return override;
  try {
    const electron = require('electron') as { app?: { getPath: (name: string) => string } };
    if (electron.app?.getPath) return electron.app.getPath('userData');
  } catch {
    // Tests and non-electron hosts fall back to the home directory.
  }
  return join(homedir(), '.aegis');
}

function persistCodexGeneratedImage(input: {
  userDataDir: string;
  result: string;
}): string | null {
  const encoded = input.result.replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
  const pngSignature = '89504e470d0a1a0a';
  if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== pngSignature) {
    return null;
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const root = join(input.userDataDir, 'codex-imagegen');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const filePath = join(root, `${sha256}.png`);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, bytes, { mode: 0o600 });
  }
  return filePath;
}

function formatImageGenerationResetTime(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function formatImageGenerationFailure(failure: Record<string, unknown> | null): string {
  if (failure?.type === 'usageLimitExceeded') {
    const limitId = getString(failure.limitId);
    const resetTime = formatImageGenerationResetTime(failure.resetsAt);
    return [
      'Image generation usage limit exceeded',
      limitId ? `(${limitId})` : '',
      resetTime ? `Resets at ${resetTime}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return 'Image generation failed.';
}

function getFirstString(...values: unknown[]): string {
  for (const value of values) {
    const str = getString(value);
    if (str) return str;
  }
  return '';
}

function getRecord(v: unknown): Record<string, unknown> | null {
  return isObject(v) ? v : null;
}

function getRecordField(
  obj: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  return obj && isObject(obj[key]) ? (obj[key] as Record<string, unknown>) : null;
}

function getArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (isObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const GENERIC_CODEX_TOOL_NAMES = new Set([
  'tool',
  'toolcall',
  'tooluse',
  'item',
  'functioncall',
]);

function normalizeCodexToolName(name: string): string {
  const trimmed = name.trim();
  const normalized = trimmed.replace(/[_\-\s]/g, '').toLowerCase();
  if (!trimmed || GENERIC_CODEX_TOOL_NAMES.has(normalized)) return '';
  if (normalized === 'commandexecution' || normalized === 'shellcommand') return 'Bash';
  if (normalized === 'fileread') return 'Read';
  if (normalized === 'filesearch' || normalized === 'patternsearch') return 'Grep';
  if (normalized === 'websearch') return 'WebSearch';
  if (normalized === 'webfetch') return 'WebFetch';
  if (
    normalized === 'filechange' ||
    normalized === 'filewrite' ||
    normalized === 'fileedit' ||
    normalized === 'applypatch'
  ) {
    return 'Edit';
  }
  return trimmed;
}

function inferCodexToolNameFromFields(params: {
  command: string;
  filePath: string;
  title: string;
}): string {
  if (params.command) return 'Bash';
  const title = params.title.trim().toLowerCase();
  if (title.startsWith('read ') || title.startsWith('readed ')) return 'Read';
  if (title.startsWith('listed ') || title.startsWith('list ')) return 'Bash';
  if (title.startsWith('searched ') || title.startsWith('search ')) return 'Grep';
  if (title.startsWith('fetched ') || title.startsWith('fetch ')) return 'WebFetch';
  if (
    title.startsWith('edited ') ||
    title.startsWith('updated ') ||
    title.startsWith('wrote ') ||
    title.startsWith('created ') ||
    title.startsWith('deleted ')
  ) {
    return 'Edit';
  }
  if (params.filePath) return 'Read';
  return '';
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: false,
  skillDiscovery: true,
  pluginDiscovery: true,
  mcpServers: true,
  imageAttachments: true,
  forkThread: true,
  compactThread: true,
  planMode: true,
};

export type CodexSlashCommand =
  | { name: 'compact' }
  | { name: 'review'; target: CodexReviewTarget };

/**
 * Codex has no server-side slash-command passthrough: the app-server treats
 * turn text literally, and builtins are separate RPCs. Recognize the builtins
 * Aegis advertises in the composer and route them to their RPCs.
 * `/review` maps its argument like the Codex CLI picker: bare → uncommitted
 * changes, `branch <name>` / `commit <sha>` → those targets, anything else →
 * custom review instructions.
 */
export function parseCodexSlashCommand(prompt: string): CodexSlashCommand | null {
  const match = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(prompt.trim());
  if (!match) return null;

  const name = match[1].toLowerCase();
  const args = (match[2] || '').trim();
  if (name === 'compact' && !args) {
    return { name: 'compact' };
  }
  if (name === 'review') {
    if (!args) return { name: 'review', target: { type: 'uncommittedChanges' } };
    const branch = /^branch\s+(\S+)$/i.exec(args);
    if (branch) return { name: 'review', target: { type: 'baseBranch', branch: branch[1] } };
    const commit = /^commit\s+(\S+)$/i.exec(args);
    if (commit) return { name: 'review', target: { type: 'commit', sha: commit[1] } };
    return { name: 'review', target: { type: 'custom', instructions: args } };
  }
  return null;
}

interface ActiveSession {
  threadId: string;
  providerThreadId: string;
  /** Manager process generation this session was created on (P0-6 staleness). */
  generation: number;
  status: ProviderSessionStatus;
  model?: string;
}

interface StreamingTextState {
  text: string;
  pendingText: string;
  blockIndex: number;
  uuid: string;
  createdAt: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  hasFlushed: boolean;
}

interface StreamingThinkingState {
  thinking: string;
  blockIndex: number;
}

export interface CodexAdapterOptions {
  /** Test seam; production creates one fresh manager for every active thread. */
  managerFactory?: () => CodexAppServerManager;
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'codex';
  readonly displayName = 'Codex';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  /** Process used only for provider-wide discovery/settings operations. */
  private manager: CodexAppServerManager;
  /** One app-server process owner per active Aegis thread. */
  private runtimeManagers = new Map<string, CodexAppServerManager>();
  private readonly managerFactory: () => CodexAppServerManager;
  private sessions = new Map<string, ActiveSession>();
  /** Resume cursors claimed while a per-thread app-server is still starting. */
  private providerThreadClaims = new Map<string, string>();
  /** Serializes start/replace/stop for one Aegis thread without blocking peers. */
  private threadLifecycleTails = new Map<string, Promise<void>>();
  /** Latest-operation-wins token; synchronous dispose also invalidates queued work. */
  private threadLifecycleEpochs = new Map<string, number>();
  /** Global monotonic source prevents ABA when an idle thread entry is reclaimed. */
  private nextThreadLifecycleEpoch = 0;
  /** Operations an adapter-wide shutdown must drain before it can finish. */
  private activeLifecycleOperations = new Set<Promise<void>>();
  /** Processes removed from ownership but not yet confirmed exited. */
  private retiringManagers = new Map<CodexAppServerManager, Promise<void>>();
  /** Invalidates in-flight thread operations when all runtimes are reset. */
  private adapterLifecycleEpoch = 0;
  /** Exclusive adapter-wide stop/auth-reset barrier; new starts wait behind it. */
  private shutdownInFlight: Promise<void> | null = null;
  /** Terminal shutdown outranks auth recovery and suppresses late rehydration. */
  private stopAllRequested = false;
  private stopAllInFlight: Promise<void> | null = null;
  private static readonly STREAMING_TEXT_COALESCE_MS = 100;
  // Per-thread streaming accumulator. Codex emits agent text as token-level
  // deltas; expose those deltas through one stable assistant message id so the
  // transcript grows in place like Synara instead of replacing full snapshots.
  private streamingText = new Map<string, StreamingTextState>();
  private streamingThinking = new Map<string, StreamingThinkingState>();
  // Latest context-window occupancy per thread, so a compaction event can
  // report roughly how many tokens it reclaimed.
  private lastKnownContextTokens = new Map<string, number>();
  private finalizedStreamingText = new Map<string, string>();
  /** Threads with an in-flight /compact — labels the next compact_boundary as manual. */
  private pendingManualCompacts = new Set<string>();
  private emittedToolCalls = new Map<string, Set<string>>();
  private emittedToolResults = new Map<string, Set<string>>();
  private pendingToolCallIds = new Map<string, string[]>();
  private imageGenerationItems = new Map<
    string,
    Map<string, { createdAt: number; prompt: string; completed: boolean }>
  >();
  private permissionResolvers = new Map<
    string,
    { resolve: (result: PermissionResult) => void }
  >();
  // Cache of the original session-start input keyed by threadId. Used to
  // transparently rebuild a codex session after an auth-recovery teardown so
  // the user can resend in the same chat without manually starting a new one.
  private lastStartInput = new Map<string, ProviderSessionStartInput>();
  private authRecoveryInFlight: Promise<void> | null = null;
  // Per-thread key of the last turn failure already surfaced as an error
  // event, so `error(willRetry=false)` + `turn/completed(failed)` for the
  // same turn report once (P0-1 dedupe).
  private reportedErrorTurnKeys = new Map<string, string>();
  // Live tool output buffered per thread → tool id, flushed on a shared
  // 100ms cadence so high-frequency command output can't flood IPC.
  private toolOutputBuffers = new Map<string, Map<string, string>>();
  private toolOutputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingComputerUseApprovals = new Map<string, McpToolApprovalElicitation>();
  private grantListener = (payload: {
    threadId: string;
    grants: import('../../../shared/computer-use').ComputerUseGrantView[];
    reason: string;
  }) => {
    this.emit({
      type: 'computer_use_grants',
      threadId: payload.threadId,
      grants: payload.grants,
      reason: payload.reason,
    });
  };

  constructor(binaryPath?: string, options: CodexAdapterOptions = {}) {
    this.managerFactory =
      options.managerFactory ??
      (() => new CodexAppServerManager(binaryPath, resolveClientVersion()));
    this.manager = new CodexAppServerManager(binaryPath, resolveClientVersion());
    this.setupEventForwarding(this.manager);
    computerUseGrants.on('change', this.grantListener);
  }

  private setupEventForwarding(
    manager: CodexAppServerManager,
    ownerThreadId?: string
  ): void {
    // A stopped/replaced process may still deliver a final queued event. Only
    // the manager currently registered for this thread is allowed to publish.
    const on = (
      event: string,
      listener: (payload: any) => void
    ): void => {
      manager.on(event, (payload: any) => {
        if (
          ownerThreadId &&
          this.runtimeManagers.get(ownerThreadId) !== manager
        ) {
          return;
        }
        listener(payload);
      });
    };
    // Forward manager events as ProviderRuntimeEvents
    on('text_delta', ({ threadId, text }) => {
      this.enqueueStreamingTextDelta(threadId, text);
    });

    on('tool_output_delta', ({ threadId, itemId, delta }) => {
      this.enqueueToolOutputDelta(threadId, itemId, delta);
    });

    on('reasoning_delta', ({ threadId, text }) => {
      let state = this.streamingThinking.get(threadId);
      if (!state) {
        state = { thinking: '', blockIndex: 0 };
        this.streamingThinking.set(threadId, state);
      }
      state.thinking += text;

      this.emit({
        type: 'message',
        threadId,
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: text },
          },
        } as StreamMessage,
      });
    });

    on('agent_message_done', ({ threadId, text }) => {
      this.finalizeStreamingAssistant(threadId, text);
      this.clearStreamingState(threadId);
    });

    on('token_usage_updated', ({ threadId, usage }) => {
      this.lastKnownContextTokens.set(threadId, usage.totalTokens || 0);
      const message: StreamMessage = {
        type: 'system',
        subtype: 'token_usage',
        uuid: `codex-token-usage-${threadId}`,
        session_id: threadId,
        provider: 'codex',
        usage,
      };
      this.emit({ type: 'message', threadId, message });
    });

    on('context_compacted', ({ threadId }) => {
      // Codex reports neither trigger nor pre-compaction size: a compaction is
      // manual iff this thread has a pending /compact command, and the latest
      // token_usage snapshot is the best preTokens approximation.
      const manual = this.pendingManualCompacts.delete(threadId);
      const message: StreamMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: uuidv4(),
        session_id: threadId,
        compactMetadata: {
          trigger: manual ? 'manual' : 'auto',
          preTokens: this.lastKnownContextTokens.get(threadId) || 0,
        },
      };
      this.emit({ type: 'message', threadId, message });
    });

    on('tool_call', ({ threadId, params }) => {
      const p = params as Record<string, unknown>;
      const { item, toolName, toolInput, toolId } = this.extractToolCallInfo(p);

      if (!this.markEmitted(this.emittedToolCalls, threadId, toolId)) {
        return;
      }
      this.rememberPendingToolCall(threadId, toolId);

      if (isDev()) {
        console.log('[CodexAdapter] tool_call', {
          toolName,
          toolId,
          inputKeys: Object.keys(toolInput),
          paramKeys: Object.keys(p),
          hasItem: isObject(p.item),
          itemKeys: isObject(p.item) ? Object.keys(p.item as object) : [],
        });
      }

      const message: StreamMessage = {
        type: 'assistant',
        uuid: uuidv4(),
        message: {
          content: [
            {
              type: 'tool_use',
              id: toolId,
              name: toolName,
              input: toolInput,
            },
          ],
        },
      };
      this.emit({ type: 'message', threadId, message });
      const action = classifyComputerUseAction({
        toolName,
        app: getString(toolInput.app),
        title: getString(toolInput.__aegisDisplayTitle) || getString(toolInput.title),
      });
      if (action) {
        this.emitComputerUseLive(threadId, {
          toolUseId: toolId,
          label: formatComputerUseLabel(action, 'pending'),
          app: action.app,
          tool: action.tool,
          mutating: action.mutating,
          media: null,
          hasFreshMedia: false,
        });
      }
    });

    on('tool_result', ({ threadId, params }) => {
      const p = params as Record<string, unknown>;
      const { item, toolUseId, rawContent } = this.extractToolResultInfo(threadId, p);
      const isError = Boolean(item.isError ?? item.error ?? p.isError);

      if (toolUseId && !this.markEmitted(this.emittedToolResults, threadId, toolUseId)) {
        return;
      }
      if (toolUseId) {
        this.forgetPendingToolCall(threadId, toolUseId);
        // The authoritative result supersedes any not-yet-flushed live output.
        this.dropToolOutputBuffer(threadId, toolUseId);
      }

      if (isDev()) {
        console.log('[CodexAdapter] tool_result', {
          toolUseId,
          isError,
          paramKeys: Object.keys(p),
          itemKeys: isObject(p.item) ? Object.keys(p.item as object) : [],
        });
      }

      const persisted = persistComputerUseMedia({
        userDataDir: resolveComputerUseUserDataDir(),
        sessionId: threadId,
        payload: rawContent,
      });
      const content =
        persisted.text ||
        (typeof rawContent === 'string' && !rawContent.includes('data:image/')
          ? rawContent
          : persisted.mediaRefs.length > 0
            ? ''
            : typeof rawContent === 'string'
              ? rawContent
              : JSON.stringify(rawContent ?? ''));

      const message: StreamMessage = {
        type: 'user',
        uuid: uuidv4(),
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content,
              is_error: isError,
              ...(persisted.mediaRefs.length > 0 ? { mediaRefs: persisted.mediaRefs } : {}),
            },
          ],
        },
      };
      this.emit({ type: 'message', threadId, message });
      if (persisted.mediaRefs[0]) {
        this.emitComputerUseLive(threadId, {
          toolUseId: toolUseId || '',
          label: 'Looked at the screen',
          app: null,
          tool: null,
          mutating: false,
          media: persisted.mediaRefs[0],
          hasFreshMedia: true,
        });
      }
    });

    on('image_generation', ({ threadId, phase, item }) => {
      this.handleImageGeneration(
        threadId,
        phase === 'completed' ? 'completed' : 'started',
        isObject(item) ? item : {}
      );
    });

    // 0.144.3 delivers every turn terminal via `turn/completed` with
    // turn.status ∈ completed | interrupted | failed (there is no
    // `turn/aborted` notification). Failed turns must surface as errors —
    // never as a success result (P0-1).
    on('turn_completed', ({ threadId, turnId, status, error }) => {
      this.finalizeStreamingAssistant(threadId);
      this.clearStreamingState(threadId);
      // The turn is over — every tool has its final result, so buffered live
      // output is stale noise.
      this.dropToolOutputBuffer(threadId);
      // A /compact whose turn ended without a context_compacted notification
      // (failure, interrupt) must not mislabel a later auto compaction.
      this.pendingManualCompacts.delete(threadId);

      if (status === 'failed') {
        this.updateSessionStatus(threadId, 'error');
        const errorText = typeof error === 'string' && error ? error : 'Codex turn failed';
        // The error event must precede the result: runOneShot settles on the
        // first result message and classifies by what arrived before it.
        // Dedupe: a willRetry=false error notification for the same turn has
        // usually reported this failure already.
        const errorKey = typeof turnId === 'string' && turnId ? turnId : errorText;
        if (this.reportedErrorTurnKeys.get(threadId) !== errorKey) {
          this.reportedErrorTurnKeys.set(threadId, errorKey);
          if (isAuthRefreshError(errorText)) {
            void this.handleAuthFailure(errorText);
          } else {
            this.emit({ type: 'error', threadId, error: new Error(errorText) });
          }
        }
        const message: StreamMessage = {
          type: 'result',
          subtype: 'error',
          duration_ms: 0,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
        this.emit({ type: 'message', threadId, message });
        return;
      }

      // completed & interrupted both end as a success result; the interrupted
      // case is the stop-confirmation terminal (settled manager-side).
      this.updateSessionStatus(threadId, 'completed');
      const message: StreamMessage = {
        type: 'result',
        subtype: 'success',
        duration_ms: 0,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      this.emit({ type: 'message', threadId, message });
    });

    on('error_notification', ({ threadId, message, willRetry, turnId }) => {
      // willRetry: codex is retrying the same turn itself. Keep the stream
      // and session state intact — finalizing here would corrupt the
      // continuation, and marking error would kill the steer gate (P0-1).
      if (willRetry) {
        this.emitLocalNotice(threadId, `Codex is retrying after a transient error: ${message}`);
        return;
      }

      this.finalizeStreamingAssistant(threadId);
      this.clearStreamingState(threadId);
      this.updateSessionStatus(threadId, 'error');
      if (typeof turnId === 'string' && turnId) {
        this.reportedErrorTurnKeys.set(threadId, turnId);
      }
      if (isAuthRefreshError(message)) {
        void this.handleAuthFailure(message);
        return;
      }
      this.emit({ type: 'error', threadId, error: new Error(message) });
    });

    // Two-phase stop settle (P0-6). Cleanup is staleness-guarded: a
    // replacement runner may have rebuilt this aegis threadId on a new
    // provider thread/generation — a late settle must not wipe its state.
    on('stop_settled', ({
      aegisThreadId,
      providerThreadId,
      generation,
      confirmed,
      noTurn,
      managerTerminating,
    }) => {
      const session = this.sessions.get(aegisThreadId);
      // Staleness guard, with one exception: a noTurn settle with an empty
      // providerThreadId means the manager had no session at all (e.g. after
      // a crash cleared it) — the adapter-side leftovers must go regardless.
      const orphanCleanup = noTurn === true && providerThreadId === '';
      let cleaned = false;
      if (
        session &&
        (orphanCleanup ||
          (session.providerThreadId === providerThreadId && session.generation === generation))
      ) {
        this.clearStreamingState(aegisThreadId);
        this.sessions.delete(aegisThreadId);
        this.lastStartInput.delete(aegisThreadId);
        this.lastKnownContextTokens.delete(aegisThreadId);
        this.reportedErrorTurnKeys.delete(aegisThreadId);
        this.imageGenerationItems.delete(aegisThreadId);
        cleaned = true;
      }
      this.emit({
        type: 'stop_settled',
        threadId: aegisThreadId,
        providerThreadId,
        generation,
        confirmed: confirmed === true,
        ...(noTurn === true ? { noTurn: true } : {}),
      });
      if (cleaned && ownerThreadId === aegisThreadId && managerTerminating !== true) {
        this.releaseRuntimeManager(aegisThreadId, manager);
      }
      this.releaseThreadLifecycleEpochIfIdle(aegisThreadId);
    });

    on('approval_dismissed', ({ requestId, threadId }) => {
      this.permissionResolvers.delete(requestId);
      this.emit({ type: 'permission_dismissed', threadId, requestId });
    });

    on('fast_mode_unavailable', ({ model }) => {
      if (isDev()) {
        console.log('[Codex] Fast mode has no resolvable service tier; continuing on the default tier', {
          model,
        });
      }
    });

    on('model_catalog_updated', ({ models }) => {
      this.emit({ type: 'model_catalog_updated', threadId: null, models });
    });

    on('process_exit', ({ code, signal }) => {
      // A per-thread process failure must not poison unrelated Codex threads.
      const affectedThreadIds = ownerThreadId ? [ownerThreadId] : [];
      for (const threadId of affectedThreadIds) {
        if (this.runtimeManagers.get(threadId) !== manager) continue;
        this.finalizeStreamingAssistant(threadId);
        this.clearStreamingState(threadId);
        this.updateSessionStatus(threadId, 'error');
        this.emit({
          type: 'error',
          threadId,
          error: new Error(`Codex process exited (code=${code}, signal=${signal})`),
        });
        this.runtimeManagers.delete(threadId);
        this.sessions.delete(threadId);
        this.imageGenerationItems.delete(threadId);
        this.releaseThreadLifecycleEpochIfIdle(threadId);
      }
    });

    on('process_error', (error: Error) => {
      const affectedThreadIds = ownerThreadId ? [ownerThreadId] : [];
      for (const threadId of affectedThreadIds) {
        if (this.runtimeManagers.get(threadId) !== manager) continue;
        this.finalizeStreamingAssistant(threadId);
        this.clearStreamingState(threadId);
        this.updateSessionStatus(threadId, 'error');
        this.emit({ type: 'error', threadId, error });
        this.runtimeManagers.delete(threadId);
        this.sessions.delete(threadId);
        this.imageGenerationItems.delete(threadId);
        this.releaseThreadLifecycleEpochIfIdle(threadId);
      }
    });

    on('auth_error', (error: Error) => {
      void this.handleAuthFailure(error.message);
    });

    // Routing happened once in the manager (exact match / descendant map,
    // fail-closed) — the event carries the resolved Aegis threadId. No
    // re-inference here (P0-7).
    on('approval_request', ({ requestId, method, threadId, params }) => {
      const elicitation = parseMcpToolApprovalElicitation(method, params);
      if (elicitation) {
        const app = elicitation.canonicalApp;
        if (elicitation.deniedTarget || isDeniedComputerUseTarget(app)) {
          void this.respondToRequest(threadId, requestId, {
            behavior: 'deny',
            message: 'Aegis blocked Computer Use from targeting the Aegis app itself.',
          });
          return;
        }
        const manager = this.runtimeManagers.get(threadId);
        const matchedGrant = computerUseGrants.match({
          threadId,
          generation: manager?.getGeneration() ?? 0,
          elicitation,
        });
        if (matchedGrant) {
          this.emitComputerUseAudit(threadId, 'used', matchedGrant.key, elicitation);
          void this.respondToRequest(threadId, requestId, { behavior: 'allow', scope: 'once' });
          return;
        }
        this.pendingComputerUseApprovals.set(requestId, elicitation);
        this.emit({
          type: 'permission_request',
          threadId,
          requestId,
          toolName: elicitation.toolName || 'Computer Use',
          input: this.buildComputerUsePermissionInput(elicitation),
        });
        return;
      }

      const { toolName, input } = this.buildCodexApprovalInput(method, params);

      if (
        input.approvalKind === 'command' &&
        input.command &&
        shouldBlockSystemBrowserPreviewOpen(input.command)
      ) {
        void this.respondToRequest(threadId, requestId, {
          behavior: 'deny',
          message: AEGIS_BLOCKED_BROWSER_OPEN_MESSAGE,
        });
        return;
      }

      this.emit({
        type: 'permission_request',
        threadId,
        requestId,
        toolName,
        input,
      });
    });

    on('user_input_request', ({ requestId, threadId, params }) => {
      this.emit({
        type: 'permission_request',
        threadId,
        requestId,
        toolName: 'AskUserQuestion',
        input: params,
      });
    });

    on('thread_started', ({ threadId, model }) => {
      const session = this.sessions.get(threadId);
      if (session && model) {
        session.model = model;
      }
    });

    // `thread/status/changed` is bookkeeping only. It must NOT emit a result:
    // it was a second success channel that overwrote failed-turn errors with
    // "completed" right after the real terminal (P0-1). Turn terminality has
    // exactly one source: `turn/completed`. (Wire status is a tagged union —
    // notLoaded | idle | systemError | active — "ready"/"running" are legacy
    // internal values kept only for older binaries.)
    on('thread_status_changed', () => {});

    on('turn_started', ({ threadId, turnId }) => {
      if (typeof turnId !== 'string' || !turnId) {
        return;
      }
      this.imageGenerationItems.delete(threadId);
      const message: StreamMessage = {
        type: 'turn_started',
        uuid: `codex-turn:${threadId}:${turnId}`,
        turnId,
      };
      this.emit({ type: 'message', threadId, message });
    });

    on('plan_updated', ({ threadId, params }) => {
      const p = params as Record<string, unknown>;
      const turnId = typeof p.turnId === 'string' ? p.turnId : '';
      const rawPlan = Array.isArray(p.plan) ? p.plan : [];
      const steps = rawPlan.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }
        const item = entry as Record<string, unknown>;
        const step = typeof item.step === 'string' ? item.step.trim() : '';
        if (!step) {
          return [];
        }
        const rawStatus = typeof item.status === 'string' ? item.status : '';
        const normalizedStatus = rawStatus.replace(/[-_\s]/g, '').toLowerCase();
        const status: PlanStepStatus =
          normalizedStatus === 'completed'
            ? 'completed'
            : normalizedStatus === 'inprogress'
              ? 'inProgress'
              : 'pending';
        return [{ step, status }];
      });

      const message: StreamMessage = {
        type: 'plan_update',
        uuid: `codex-plan:${threadId}:${turnId || 'active'}`,
        turnId,
        explanation: typeof p.explanation === 'string' ? p.explanation : null,
        steps,
      };
      this.emit({ type: 'message', threadId, message });
    });

    on('plan_item_completed', ({ threadId, text, itemId, turnId }) => {
      const planMarkdown = typeof text === 'string' ? text.trim() : '';
      if (!planMarkdown) {
        return;
      }
      const message: StreamMessage = {
        type: 'proposed_plan',
        uuid: `codex-proposed-plan:${threadId}:${itemId || turnId || uuidv4()}`,
        planMarkdown,
        ...(typeof turnId === 'string' && turnId ? { turnId } : {}),
      };
      this.emit({ type: 'message', threadId, message });
    });

    // MCP startup status routing (P0-4): the 0.144.3 notification is per-
    // thread ({threadId} non-null → the manager resolved the owning session)
    // or process-scoped (threadId null → broadcast to every session).
    on('mcp_status_updated', ({ servers, threadId }) => {
      if (!Array.isArray(servers) || servers.length === 0) return;
      const message: StreamMessage = { type: 'mcp_status', servers };
      if (typeof threadId === 'string' && threadId) {
        this.emit({ type: 'message', threadId, message });
        return;
      }
      for (const sessionThreadId of this.sessions.keys()) {
        this.emit({ type: 'message', threadId: sessionThreadId, message });
      }
    });

    // OAuth outcome for the settings panel — process-scoped, like
    // model_catalog_updated (threadId null so session filters skip it).
    on('mcp_oauth_login_completed', ({ name, success, error }) => {
      this.emit({
        type: 'mcp_oauth_login_completed',
        threadId: null,
        serverName: name,
        success,
        error,
      });
    });
  }

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }

  /**
   * Persistent, user-visible notice in the transcript (assistant text shape —
   * the reliable render/persist path for provider-side notices).
   */
  private emitLocalNotice(threadId: string, text: string): void {
    const message: StreamMessage = {
      type: 'assistant',
      uuid: uuidv4(),
      message: {
        content: [{ type: 'text', text }],
      },
    };
    this.emit({ type: 'message', threadId, message });
  }

  private finalizeStreamingAssistant(threadId: string, fallbackText = ''): void {
    const textState = this.streamingText.get(threadId);
    const thinkingState = this.streamingThinking.get(threadId);
    if (!textState && !thinkingState && !fallbackText.trim()) {
      return;
    }

    if (textState) {
      this.flushStreamingTextDelta(threadId);
    }

    // Close the reasoning stream overlay. Assistant text itself is represented
    // by the in-place assistant message delta stream.
    this.emit({
      type: 'message',
      threadId,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_stop',
          index: textState?.blockIndex ?? thinkingState?.blockIndex ?? 0,
        },
      } as StreamMessage,
    });

    const fallbackFullText = fallbackText || '';
    const finalTextState =
      textState ??
      (fallbackFullText
        ? ({
            text: fallbackFullText,
            pendingText: '',
            blockIndex: 1,
            uuid: uuidv4(),
            createdAt: Date.now(),
            flushTimer: null,
            hasFlushed: false,
          } satisfies StreamingTextState)
        : null);
    if (
      finalTextState &&
      fallbackFullText &&
      fallbackFullText.startsWith(finalTextState.text) &&
      fallbackFullText.length > finalTextState.text.length
    ) {
      const remaining = fallbackFullText.slice(finalTextState.text.length);
      finalTextState.text = fallbackFullText;
      this.emitAssistantTextDelta(threadId, finalTextState, remaining);
    }

    const finalText = finalTextState?.text || fallbackFullText;
    const finalThinking = (thinkingState?.thinking || '').trim();
    if (!finalText && !finalThinking) {
      return;
    }
    if (!textState && !thinkingState && finalText && this.finalizedStreamingText.get(threadId) === finalText) {
      return;
    }

    const finalState =
      finalTextState ??
      ({
        text: '',
        pendingText: '',
        blockIndex: 1,
        uuid: uuidv4(),
        createdAt: Date.now(),
        flushTimer: null,
        hasFlushed: false,
      } satisfies StreamingTextState);
    this.emitAssistantTextComplete(threadId, finalState, finalText, finalThinking);
    if (finalText) {
      this.finalizedStreamingText.set(threadId, finalText);
    }
  }

  private getOrCreateStreamingTextState(threadId: string): StreamingTextState {
    let state = this.streamingText.get(threadId);
    if (!state) {
      // Use index 1 so reasoning (index 0) and answer text are distinct when a
      // reasoning stream_event is also present.
      state = {
        text: '',
        pendingText: '',
        blockIndex: 1,
        uuid: uuidv4(),
        createdAt: Date.now(),
        flushTimer: null,
        hasFlushed: false,
      };
      this.streamingText.set(threadId, state);
    }
    return state;
  }

  private enqueueStreamingTextDelta(threadId: string, text: string): void {
    if (!text) {
      return;
    }

    const state = this.getOrCreateStreamingTextState(threadId);
    state.pendingText += text;

    if (!state.hasFlushed) {
      this.flushStreamingTextDelta(threadId);
      return;
    }

    if (state.flushTimer) {
      return;
    }

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flushStreamingTextDelta(threadId);
    }, CodexAdapter.STREAMING_TEXT_COALESCE_MS);
  }

  private flushStreamingTextDelta(threadId: string): void {
    const state = this.streamingText.get(threadId);
    if (!state) {
      return;
    }

    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    if (!state.pendingText) {
      return;
    }

    const delta = state.pendingText;
    state.pendingText = '';
    state.text += delta;
    state.hasFlushed = true;
    this.emitAssistantTextDelta(threadId, state, delta);
  }

  private emitAssistantTextDelta(
    threadId: string,
    state: StreamingTextState,
    delta: string
  ): void {
    if (!delta) {
      return;
    }

    this.emit({
      type: 'message',
      threadId,
      message: {
        type: 'assistant',
        uuid: state.uuid,
        createdAt: state.createdAt,
        streaming: true,
        message: { content: [{ type: 'text', text: delta }] },
      },
    });
  }

  private emitAssistantTextComplete(
    threadId: string,
    state: StreamingTextState,
    finalText: string,
    finalThinking = ''
  ): void {
    const content: ContentBlock[] = [];
    if (finalThinking) {
      content.push({ type: 'thinking', thinking: finalThinking });
    }
    if (finalText) {
      content.push({ type: 'text', text: finalText });
    }

    this.emit({
      type: 'message',
      threadId,
      message: {
        type: 'assistant',
        uuid: state.uuid,
        createdAt: state.createdAt,
        streaming: false,
        message: { content },
      },
    });
  }

  private clearStreamingState(threadId: string): void {
    const textState = this.streamingText.get(threadId);
    if (textState?.flushTimer) {
      clearTimeout(textState.flushTimer);
    }
    this.streamingText.delete(threadId);
    this.streamingThinking.delete(threadId);
    this.emittedToolCalls.delete(threadId);
    this.emittedToolResults.delete(threadId);
    this.pendingToolCallIds.delete(threadId);
  }

  private handleImageGeneration(
    threadId: string,
    phase: 'started' | 'completed',
    item: Record<string, unknown>
  ): void {
    const itemId = getString(item.id);
    if (!itemId) return;

    let items = this.imageGenerationItems.get(threadId);
    if (!items) {
      items = new Map();
      this.imageGenerationItems.set(threadId, items);
    }
    const existing = items.get(itemId);
    if (phase === 'started' && existing) return;
    if (phase === 'completed' && existing?.completed) return;

    const revisedPrompt = getString(item.revisedPrompt);
    const state = existing ?? {
      createdAt: Date.now(),
      prompt: revisedPrompt,
      completed: false,
    };
    if (revisedPrompt) state.prompt = revisedPrompt;
    items.set(itemId, state);

    const emitToolUse = (input: Record<string, unknown>) => {
      this.emit({
        type: 'message',
        threadId,
        message: {
          type: 'assistant',
          uuid: `codex-imagegen-tool-use:${threadId}:${itemId}`,
          createdAt: state.createdAt,
          message: {
            content: [{ type: 'tool_use', id: itemId, name: 'image_gen', input }],
          },
        },
      });
    };

    if (!existing) {
      emitToolUse({ prompt: state.prompt });
    }
    if (phase === 'started') return;

    state.completed = true;
    const failure = getRecord(item.failure);
    const failed = getString(item.status).toLowerCase() === 'failed' || Boolean(failure);
    let savedPath = getFirstString(item.savedPath, item.saved_path);
    if (!failed && !savedPath) {
      const result = getString(item.result);
      if (result) {
        savedPath = persistCodexGeneratedImage({
          userDataDir: resolveComputerUseUserDataDir(),
          result,
        }) ?? '';
      }
    }

    let content: string;
    let isError = failed;
    if (failed) {
      content = formatImageGenerationFailure(failure);
    } else if (!savedPath) {
      isError = true;
      content = 'Image generation completed, but no saved image was available.';
    } else {
      emitToolUse(
        withGeneratedMediaInput(
          { prompt: state.prompt },
          [{ path: savedPath, kind: 'image', toolUseId: itemId, prompt: state.prompt }]
        )
      );
      content = savedPath;
    }

    this.emit({
      type: 'message',
      threadId,
      message: {
        type: 'user',
        uuid: `codex-imagegen-tool-result:${threadId}:${itemId}`,
        createdAt: Date.now(),
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: itemId,
              content,
              is_error: isError,
            },
          ],
        },
      },
    });
  }

  // ── ProviderAdapter Implementation ───────────────────────────────────────

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: 'codex',
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: true,
      supportsPluginDiscovery: true,
      supportsRuntimeModelList: false,
      supportsThreadCompaction: false,
      supportsThreadImport: false,
    };
  }

  async getRateLimits(): Promise<CodexRateLimitReport> {
    return this.manager.readAccountRateLimits(process.cwd());
  }

  async listMcpServerStatus(): Promise<import('../../../shared/types').CodexMcpServerRuntimeStatus[]> {
    return this.manager.listMcpServerStatus();
  }

  async startMcpOauthLogin(serverName: string): Promise<{ authorizationUrl: string }> {
    return this.manager.startMcpOauthLogin(serverName);
  }

  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    return this.manager.listSkills({
      cwd: input.cwd,
      threadId: input.threadId,
      forceReload: input.forceReload,
    });
  }

  async listPlugins(input: ProviderListPluginsInput): Promise<ProviderListPluginsResult> {
    return this.manager.listPlugins({
      cwd: input.cwd,
      threadId: input.threadId,
      forceReload: input.forceReload,
    });
  }

  async readPlugin(input: ProviderReadPluginInput): Promise<ProviderReadPluginResult> {
    return this.manager.readPlugin({
      marketplacePath: input.marketplacePath,
      remoteMarketplaceName: input.remoteMarketplaceName,
      pluginName: input.pluginName,
    });
  }

  async installPlugin(input: ProviderInstallPluginInput): Promise<void> {
    await this.manager.installPlugin({
      marketplacePath: input.marketplacePath,
      remoteMarketplaceName: input.remoteMarketplaceName,
      pluginName: input.pluginName,
    });
  }

  async uninstallPlugin(input: ProviderUninstallPluginInput): Promise<void> {
    await this.manager.uninstallPlugin({ pluginId: input.pluginId });
  }

  private runtimeManagerForThread(threadId: string): CodexAppServerManager {
    const manager = this.runtimeManagers.get(threadId);
    if (!manager) {
      throw new Error(`No Codex app-server runtime found for thread "${threadId}"`);
    }
    return manager;
  }

  private bumpThreadLifecycleEpoch(threadId: string): number {
    const next = ++this.nextThreadLifecycleEpoch;
    this.threadLifecycleEpochs.set(threadId, next);
    return next;
  }

  private releaseThreadLifecycleEpochIfIdle(threadId: string): void {
    if (
      this.threadLifecycleTails.has(threadId) ||
      this.runtimeManagers.has(threadId) ||
      this.sessions.has(threadId)
    ) {
      return;
    }
    this.threadLifecycleEpochs.delete(threadId);
  }

  private assertLifecycleCurrent(
    threadId: string,
    threadEpoch: number,
    adapterEpoch: number,
    manager?: CodexAppServerManager
  ): void {
    if (
      this.threadLifecycleEpochs.get(threadId) !== threadEpoch ||
      this.adapterLifecycleEpoch !== adapterEpoch ||
      (manager !== undefined && this.runtimeManagers.get(threadId) !== manager)
    ) {
      throw new Error(`Codex lifecycle operation was superseded for thread "${threadId}"`);
    }
  }

  private runThreadLifecycle<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.threadLifecycleTails.get(threadId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.threadLifecycleTails.set(threadId, tail);
    this.activeLifecycleOperations.add(tail);
    void tail.then(() => {
      this.activeLifecycleOperations.delete(tail);
      if (this.threadLifecycleTails.get(threadId) === tail) {
        this.threadLifecycleTails.delete(threadId);
        this.releaseThreadLifecycleEpochIfIdle(threadId);
      }
    });
    return result;
  }

  /**
   * Stop a runtime without opening a stale-event window. manager.stop() emits
   * all synchronous cleanup events before its first await; ownership is
   * removed only after those events have crossed the adapter guard. The
   * returned promise stays tracked until the OS process is confirmed gone.
   */
  private retireRuntimeManager(
    threadId: string,
    manager: CodexAppServerManager
  ): Promise<void> {
    const existing = this.retiringManagers.get(manager);
    if (existing) return existing;

    let resolveRetirement!: () => void;
    let rejectRetirement!: (error: unknown) => void;
    const retirement = new Promise<void>((resolve, reject) => {
      resolveRetirement = resolve;
      rejectRetirement = reject;
    });
    this.retiringManagers.set(manager, retirement);

    let stopping: Promise<void>;
    try {
      stopping = manager.stop();
    } catch (error) {
      stopping = Promise.reject(error);
    }

    // cleanupGeneration() has now synchronously emitted dismiss/settle events.
    if (this.runtimeManagers.get(threadId) === manager) {
      this.runtimeManagers.delete(threadId);
    }
    this.releaseThreadLifecycleEpochIfIdle(threadId);

    void stopping.then(resolveRetirement, rejectRetirement);
    void retirement.then(
      () => this.retiringManagers.delete(manager),
      () => this.retiringManagers.delete(manager)
    );
    return retirement;
  }

  private releaseRuntimeManager(
    threadId: string,
    expectedManager?: CodexAppServerManager
  ): void {
    const manager = this.runtimeManagers.get(threadId);
    if (!manager || (expectedManager && manager !== expectedManager)) return;
    void this.retireRuntimeManager(threadId, manager).catch((error) => {
      console.warn('[CodexAdapter] failed to stop thread runtime:', threadId, error);
    });
  }

  private async replaceRuntimeManager(threadId: string): Promise<CodexAppServerManager> {
    computerUseGrants.revokeThread(threadId, 'runtime-replaced');
    const previous = this.runtimeManagers.get(threadId);
    if (previous) {
      await this.retireRuntimeManager(threadId, previous);
    }
    const manager = this.managerFactory();
    this.runtimeManagers.set(threadId, manager);
    this.setupEventForwarding(manager, threadId);
    return manager;
  }

  /** Runtime diagnostics used by the focused process-isolation E2E. */
  getRuntimeProcessId(threadId: string): number | null {
    return this.runtimeManagers.get(threadId)?.getProcessId() ?? null;
  }

  getRuntimeCount(): number {
    return this.runtimeManagers.size;
  }

  private assertProviderThreadAvailable(
    providerThreadId: string,
    threadId: string
  ): void {
    const claimedBy = this.providerThreadClaims.get(providerThreadId);
    if (claimedBy && claimedBy !== threadId) {
      throw new CodexThreadBindingError(providerThreadId, claimedBy);
    }
    const activeOwner = [...this.sessions.values()].find(
      (session) =>
        session.threadId !== threadId &&
        session.providerThreadId === providerThreadId
    );
    if (activeOwner) {
      throw new CodexThreadBindingError(providerThreadId, activeOwner.threadId);
    }
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const shutdown = this.shutdownInFlight;
    if (shutdown) await shutdown;
    const threadEpoch = this.bumpThreadLifecycleEpoch(input.threadId);
    const adapterEpoch = this.adapterLifecycleEpoch;
    return this.runThreadLifecycle(input.threadId, () =>
      this.startSessionLocked(input, threadEpoch, adapterEpoch)
    );
  }

  private async startSessionLocked(
    input: ProviderSessionStartInput,
    threadEpoch: number,
    adapterEpoch: number
  ): Promise<ProviderSession> {
    this.assertLifecycleCurrent(input.threadId, threadEpoch, adapterEpoch);
    const resumeCursor = input.resumeSessionId?.trim() || null;
    if (resumeCursor) {
      this.assertProviderThreadAvailable(resumeCursor, input.threadId);
      this.providerThreadClaims.set(resumeCursor, input.threadId);
    }
    let manager: CodexAppServerManager | null = null;
    let created: Awaited<ReturnType<CodexAppServerManager['createSession']>>;
    try {
      manager = await this.replaceRuntimeManager(input.threadId);
      created = await manager.createSession(
        input.threadId,
        input.cwd,
        input.resumeSessionId,
        {
          model: input.model,
          codexExecutionMode: input.codexExecutionMode,
          codexPermissionMode: input.codexPermissionMode,
          codexReasoningEffort: input.codexReasoningEffort,
          codexFastMode: input.codexFastMode,
        }
      );
      this.assertLifecycleCurrent(input.threadId, threadEpoch, adapterEpoch, manager);
      this.assertProviderThreadAvailable(created.providerThreadId, input.threadId);
    } catch (error) {
      if (manager) this.releaseRuntimeManager(input.threadId, manager);
      throw error;
    } finally {
      if (
        resumeCursor &&
        this.providerThreadClaims.get(resumeCursor) === input.threadId
      ) {
        this.providerThreadClaims.delete(resumeCursor);
      }
    }
    const { providerThreadId, model, generation, resumeFallback } = created;

    const session: ActiveSession = {
      threadId: input.threadId,
      providerThreadId,
      generation,
      status: 'running',
      model,
    };
    this.sessions.set(input.threadId, session);
    this.lastStartInput.set(input.threadId, input);

    // Emit system init
    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: providerThreadId,
      model,
    });

    // Resume degraded to a fresh thread: make the context break visible
    // instead of silently continuing without history (P0-5). The new
    // providerThreadId flows back via system_init, so the stale cursor is
    // replaced and later sends don't re-fail.
    if (resumeFallback) {
      this.emitLocalNotice(
        input.threadId,
        `Could not restore the previous Codex thread (${resumeFallback.reason}). Continuing in a new thread without prior context.`
      );
    }

    // Send initial prompt if provided. A Codex skill/plugin-only turn may have
    // an empty text prompt but still needs a structured input item.
	    if (input.prompt || input.codexSkills?.length || input.codexMentions?.length || input.attachments?.length) {
	      await this.sendTurn({
	        threadId: input.threadId,
	        prompt: input.prompt,
	        attachments: input.attachments,
	        model: input.model || model,
	        codexExecutionMode: input.codexExecutionMode,
	        codexPermissionMode: input.codexPermissionMode,
	        codexReasoningEffort: input.codexReasoningEffort,
	        codexFastMode: input.codexFastMode,
	        codexSkills: input.codexSkills,
	        codexMentions: input.codexMentions,
	      });
    }

    return {
      threadId: input.threadId,
      provider: 'codex',
      providerSessionId: providerThreadId,
      status: 'running',
      model,
    };
  }

  async forkThread(input: { cwd: string; providerThreadId: string }): Promise<string> {
    const source = [...this.sessions.values()].find(
      (session) => session.providerThreadId === input.providerThreadId
    );
    const manager = source
      ? this.runtimeManagerForThread(source.threadId)
      : this.manager;
    return manager.forkThread(input.cwd, input.providerThreadId);
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    let session = this.sessions.get(input.threadId);

    // Auto-rebuild after auth recovery: handleAuthFailure() clears sessions but
    // keeps lastStartInput, so a resend can transparently reattach to a fresh
    // codex process. The codex-side conversation history is lost, but Aegis's
    // chat history is intact and the user just continues the same thread.
    if (!session) {
      const cached = this.lastStartInput.get(input.threadId);
      if (!cached) {
        throw new Error(`No session found for thread "${input.threadId}"`);
      }
      await this.startSession({
        ...cached,
        provider: 'codex',
        prompt: '',
        // Drop any prior resume cursor — it's tied to the invalidated auth.
        resumeSessionId: undefined,
      });
      session = this.sessions.get(input.threadId);
      if (!session) {
        throw new Error(`Failed to recreate session for thread "${input.threadId}"`);
      }
    }

    session.status = 'running';
    // A send that lands mid-turn becomes a turn/steer: the assistant stream
    // and tool-call dedupe state belong to the still-running turn, so they
    // must survive. (If the steer races a just-finished turn, the completion
    // handlers have already cleared this state.)
    const manager = this.runtimeManagerForThread(input.threadId);
    const steering = manager.hasActiveTurn(input.threadId);
    if (!steering) {
      this.finalizedStreamingText.delete(input.threadId);
      this.clearStreamingState(input.threadId);
    }
    this.emit({
      type: 'status_change',
      threadId: input.threadId,
      status: 'running',
    });

    // Built-in slash commands route to their dedicated RPCs instead of a
    // turn/start. The RPC acks immediately and the server runs a normal turn,
    // so streaming/lifecycle events flow through the usual handlers.
    const slashCommand =
      input.attachments?.length || input.codexSkills?.length || input.codexMentions?.length
        ? null
        : parseCodexSlashCommand(input.prompt);
    if (slashCommand) {
      if (slashCommand.name === 'compact') {
        this.pendingManualCompacts.add(input.threadId);
        try {
          await manager.compactThread(input.threadId);
        } catch (error) {
          this.pendingManualCompacts.delete(input.threadId);
          throw error;
        }
      } else {
        await manager.startReview(input.threadId, slashCommand.target);
      }
      return;
    }

    await manager.sendTurn(
      input.threadId,
      input.prompt,
      input.attachments,
      input.codexSkills,
      input.codexMentions,
      {
	        model: input.model,
	        codexExecutionMode: input.codexExecutionMode,
	        codexPermissionMode: input.codexPermissionMode,
	        codexReasoningEffort: input.codexReasoningEffort,
	        codexFastMode: input.codexFastMode,
	      }
	    );
  }

  disposeSession(threadId: string): boolean {
    // Synchronously invalidate running and queued start/stop work. The
    // provider contract requires disposeSession itself to be synchronous.
    this.bumpThreadLifecycleEpoch(threadId);
    const manager = this.runtimeManagers.get(threadId);
    if (!manager) return false;
    // Dismiss approval cards while this manager still owns event routing, but
    // suppress stop_settled because quiet dispose must not satisfy a new
    // runner's interrupt gate.
    computerUseGrants.revokeThread(threadId, 'disposed');
    manager.disposeSessionResources(threadId);
    void this.retireRuntimeManager(threadId, manager).catch((error) => {
      console.warn('[CodexAdapter] failed to dispose thread runtime:', threadId, error);
    });
    this.sessions.delete(threadId);
    this.clearStreamingState(threadId);
    this.lastKnownContextTokens.delete(threadId);
    this.pendingManualCompacts.delete(threadId);
    this.reportedErrorTurnKeys.delete(threadId);
    this.imageGenerationItems.delete(threadId);
    this.releaseThreadLifecycleEpochIfIdle(threadId);
    return true;
  }

  async stopSession(threadId: string): Promise<void> {
    const shutdown = this.shutdownInFlight;
    if (shutdown) await shutdown;
    const threadEpoch = this.bumpThreadLifecycleEpoch(threadId);
    const adapterEpoch = this.adapterLifecycleEpoch;
    return this.runThreadLifecycle(threadId, async () => {
      this.assertLifecycleCurrent(threadId, threadEpoch, adapterEpoch);
      await this.stopSessionLocked(threadId);
    });
  }

  private async stopSessionLocked(threadId: string): Promise<void> {
    // Two-phase stop (P0-6): this only requests the interrupt. Adapter-side
    // state is released by the guarded `stop_settled` handler — deleting it
    // here would orphan the confirmation window and can wipe a replacement
    // session's state.
    const manager = this.runtimeManagers.get(threadId);
    if (!manager) {
      // Preserve the provider stop contract even if a prior crash already
      // removed the runtime: emit an immediate no-turn settlement.
      this.emit({
        type: 'stop_settled',
        threadId,
        providerThreadId: '',
        generation: 0,
        confirmed: true,
        noTurn: true,
      });
      return;
    }
    await manager.stopSession(threadId);
  }

  private enqueueExclusiveShutdown(operation: () => Promise<void>): Promise<void> {
    const previous = this.shutdownInFlight ?? Promise.resolve();
    // Invalidate admitted thread operations synchronously, before this
    // shutdown waits for any earlier exclusive reset. Otherwise a deferred
    // createSession can win the microtask race and publish a live session
    // after stopAll has already been requested.
    this.adapterLifecycleEpoch += 1;
    const run = previous
      .catch(() => undefined)
      .then(operation);
    const barrier = run.then(
      () => undefined,
      () => undefined
    );
    this.shutdownInFlight = barrier;
    void barrier.then(() => {
      if (this.shutdownInFlight === barrier) this.shutdownInFlight = null;
    });
    return run;
  }

  private async stopRuntimeProcesses(): Promise<void> {
    // Retire known owners first. cleanupGeneration rejects in-flight RPCs, so
    // lifecycle operations waiting on create/interrupt can drain promptly.
    const firstRetirements = [...this.runtimeManagers.entries()].map(
      ([threadId, manager]) => this.retireRuntimeManager(threadId, manager)
    );
    const discoveryStop = this.manager.stop();
    const activeOperations = [...this.activeLifecycleOperations];
    await Promise.allSettled([
      discoveryStop,
      ...firstRetirements,
      ...activeOperations,
    ]);

    // An operation already between queue admission and manager registration
    // can appear after the first snapshot. Its adapter epoch is stale, but a
    // second retirement pass makes process ownership explicit and awaitable.
    const lateRetirements = [...this.runtimeManagers.entries()].map(
      ([threadId, manager]) => this.retireRuntimeManager(threadId, manager)
    );
    await Promise.allSettled([
      ...lateRetirements,
      ...this.retiringManagers.values(),
    ]);
  }

  async stopAll(): Promise<void> {
    if (this.stopAllInFlight) return this.stopAllInFlight;
    this.stopAllRequested = true;
    const shutdown = this.enqueueExclusiveShutdown(async () => {
      computerUseGrants.revokeAll('stop-all');
      await this.stopRuntimeProcesses();
      for (const threadId of this.streamingText.keys()) {
        this.clearStreamingState(threadId);
      }
      this.sessions.clear();
      this.providerThreadClaims.clear();
      this.lastStartInput.clear();
      this.lastKnownContextTokens.clear();
      this.pendingManualCompacts.clear();
      this.imageGenerationItems.clear();
      this.threadLifecycleTails.clear();
      this.activeLifecycleOperations.clear();
      this.threadLifecycleEpochs.clear();
    });
    let tracked: Promise<void>;
    tracked = shutdown.finally(() => {
      if (this.stopAllInFlight === tracked) {
        this.stopAllInFlight = null;
        this.stopAllRequested = false;
      }
    });
    this.stopAllInFlight = tracked;
    return tracked;
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((s) => ({
      threadId: s.threadId,
      provider: 'codex',
      providerSessionId: s.providerThreadId,
      status: s.status,
      model: s.model,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: PermissionResult
  ): Promise<void> {
    const pending = this.pendingComputerUseApprovals.get(requestId);
    this.pendingComputerUseApprovals.delete(requestId);
    let nextDecision = decision;
    if (
      decision.behavior === 'allow' &&
      decision.computerUseGrant === 'until-revoked' &&
      pending
    ) {
      const manager = this.runtimeManagers.get(threadId);
      const grant = computerUseGrants.createFromElicitation({
        threadId,
        generation: manager?.getGeneration() ?? 0,
        elicitation: pending,
      });
      if (grant) {
        this.emitComputerUseAudit(threadId, 'granted', grant.key, pending);
      }
      nextDecision = { behavior: 'allow', scope: 'once' };
    }
    // threadId asserts the decision comes from the owning session (P0-7).
    await this.runtimeManagerForThread(threadId).respondToApproval(
      requestId,
      nextDecision,
      threadId
    );
  }

  revokeComputerUseGrants(threadId: string, grantKey?: string): void {
    computerUseGrants.revoke(threadId, grantKey);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private updateSessionStatus(
    threadId: string,
    status: ProviderSessionStatus
  ): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.status = status;
    }
    this.emit({ type: 'status_change', threadId, status });
  }

  private inferToolNameFromApproval(params: unknown): string {
    if (params && typeof params === 'object') {
      const p = params as Record<string, unknown>;
      const method = p.method;
      if (typeof method === 'string') {
        if (method.includes('commandExecution')) return 'Bash';
        if (method.includes('fileRead')) return 'Read';
        if (method.includes('fileChange')) return 'Edit';
        return method;
      }
      const name = p.name;
      if (typeof name === 'string') return name;
    }
    return 'approval';
  }

  private buildCodexApprovalInput(
    method: string,
    params: unknown
  ): { toolName: string; input: CodexApprovalPermissionInput } {
    const p = getRecord(params) || {};
    const lower = method.toLowerCase();
    const approvalKind: CodexApprovalKind = lower.includes('command')
      ? 'command'
      : lower.includes('filechange') || lower.includes('applypatch')
        ? 'file-change'
        : lower.includes('permissions')
          ? 'permissions'
          : 'tool';
    const toolName =
      approvalKind === 'command'
        ? 'Bash'
        : approvalKind === 'file-change'
          ? 'Edit'
          : approvalKind === 'permissions'
            ? 'Permission'
            : this.inferToolNameFromApproval(params);

    const command = this.extractApprovalCommand(p);
    const cwd = getFirstString(p.cwd);
    const files = this.extractApprovalFiles(p);
    const grantRoot = getFirstString(p.grantRoot);
    const reason = getFirstString(p.reason) || null;
    const permissionSummary = [
      ...this.summarizePermissionRequest(getRecord(p.permissions)),
      ...this.summarizePermissionRequest(getRecord(p.additionalPermissions)),
    ];

    const question =
      approvalKind === 'command'
        ? 'Codex wants to run a command'
        : approvalKind === 'file-change'
          ? 'Codex wants to modify files'
          : approvalKind === 'permissions'
            ? 'Codex is requesting additional permissions'
            : 'Codex is requesting approval';

    return {
      toolName,
      input: {
        kind: 'codex-approval',
        approvalKind,
        method,
        question,
        title: question,
        toolName,
        reason,
        command: command || null,
        cwd: cwd || null,
        filePath: grantRoot || files[0] || null,
        files,
        grantRoot: grantRoot || null,
        permissionSummary,
        canAllowForSession: this.canApproveForSession(p, approvalKind),
      },
    };
  }

  private buildComputerUsePermissionInput(
    elicitation: NonNullable<ReturnType<typeof parseMcpToolApprovalElicitation>>
  ): ComputerUsePermissionInput {
    const code =
      typeof elicitation.toolParams.code === 'string' ? elicitation.toolParams.code : null;
    const app = typeof elicitation.toolParams.app === 'string' ? elicitation.toolParams.app : null;
    const paramLines =
      elicitation.toolParamsDisplay.length > 0
        ? elicitation.toolParamsDisplay.map((item) => ({
            label: item.displayName,
            value: typeof item.value === 'string' ? item.value : JSON.stringify(item.value),
          }))
        : Object.entries(elicitation.toolParams)
            .filter(([key]) => key !== 'title')
            .map(([label, value]) => ({
              label,
              value: typeof value === 'string' ? value : JSON.stringify(value),
            }));
    const mutating = Boolean(elicitation.action?.mutating || elicitation.isNodeRepl);
    return {
      kind: 'computer-use',
      question: elicitation.message,
      title: elicitation.toolTitle || elicitation.message,
      server: elicitation.server,
      toolName: elicitation.toolName || 'Computer Use',
      toolTitle: elicitation.toolTitle,
      app,
      mutating,
      code,
      params: elicitation.toolParams,
      paramLines,
      canAllowForSession: !mutating && elicitation.persistOptions.includes('session'),
      canAllowUntilRevoked: elicitation.grantEligible,
    };
  }

  private emitComputerUseLive(
    threadId: string,
    frame: Omit<ComputerUseLiveFrame, 'threadId' | 'at'>
  ): void {
    this.emit({
      type: 'computer_use_live',
      threadId,
      frame: { ...frame, threadId, at: Date.now() },
    });
  }

  private emitComputerUseAudit(
    threadId: string,
    reason: string,
    grantKey: string,
    elicitation: McpToolApprovalElicitation
  ): void {
    if (isDev()) {
      console.log('[CodexAdapter] computer-use grant', {
        threadId,
        reason,
        grantKey,
        tool: elicitation.toolName,
        app: elicitation.canonicalApp,
        providerThreadId: elicitation.providerThreadId,
        turnId: elicitation.turnId,
        toolCallId: elicitation.toolCallId,
      });
    }
  }

  private extractApprovalCommand(params: Record<string, unknown>): string {
    const direct = getFirstString(params.command);
    if (direct) return direct;
    const commandArray = getArray(params.command)
      .map((part) => (typeof part === 'string' ? part : String(part)))
      .filter(Boolean);
    return commandArray.join(' ');
  }

  private extractApprovalFiles(params: Record<string, unknown>): string[] {
    const fileChanges = getRecord(params.fileChanges);
    if (fileChanges) {
      return Object.keys(fileChanges).filter(Boolean);
    }

    const files = getArray(params.files)
      .map((file) => (typeof file === 'string' ? file : ''))
      .filter(Boolean);
    return files;
  }

  private summarizePermissionRequest(value: Record<string, unknown> | null): string[] {
    if (!value) return [];
    const summary: string[] = [];
    const network = getRecord(value.network);
    if (network?.enabled === true) {
      summary.push('Network access');
    }

    const fileSystem = getRecord(value.fileSystem);
    if (fileSystem) {
      for (const pathValue of getArray(fileSystem.read)) {
        if (typeof pathValue === 'string') summary.push(`Read ${pathValue}`);
      }
      for (const pathValue of getArray(fileSystem.write)) {
        if (typeof pathValue === 'string') summary.push(`Write ${pathValue}`);
      }
      for (const entry of getArray(fileSystem.entries)) {
        const record = getRecord(entry);
        if (!record) continue;
        const access = getFirstString(record.access);
        const pathRecord = getRecord(record.path);
        const path = getFirstString(pathRecord?.path, pathRecord?.pattern, pathRecord?.value);
        if (access && path) {
          summary.push(`${access[0]?.toUpperCase() || ''}${access.slice(1)} ${path}`);
        }
      }
    }

    return Array.from(new Set(summary));
  }

  private canApproveForSession(
    params: Record<string, unknown>,
    approvalKind: CodexApprovalKind
  ): boolean {
    if (approvalKind === 'permissions') return true;
    const available = getArray(params.availableDecisions);
    if (available.length === 0) {
      return true;
    }
    return available.includes('acceptForSession');
  }

  /**
   * Auth refresh failed (typically because the user signed into another account
   * elsewhere, invalidating our cached refresh token). The codex app-server
   * loaded auth on startup and won't re-read ~/.codex/auth.json, so we tear it
   * down — the next sendTurn will respawn a fresh process via the cached start
   * input and the user just continues in the same chat. Idempotent across
   * concurrent error notifications.
   */
  private async handleAuthFailure(originalMessage: string): Promise<void> {
    if (this.stopAllRequested) {
      return this.stopAllInFlight ?? Promise.resolve();
    }
    if (this.authRecoveryInFlight) {
      return this.authRecoveryInFlight;
    }
    this.authRecoveryInFlight = this.runAuthRecovery(originalMessage).finally(() => {
      this.authRecoveryInFlight = null;
    });
    return this.authRecoveryInFlight;
  }

  private async runAuthRecovery(originalMessage: string): Promise<void> {
    const affectedThreads = Array.from(this.sessions.keys());
    const recoveryInputs = new Map<string, ProviderSessionStartInput>();
    for (const threadId of affectedThreads) {
      const input = this.lastStartInput.get(threadId);
      if (input) recoveryInputs.set(threadId, input);
    }

    await this.enqueueExclusiveShutdown(async () => {
      computerUseGrants.revokeAll('auth-recovery');
      await this.stopRuntimeProcesses();
      for (const threadId of this.streamingText.keys()) {
        this.clearStreamingState(threadId);
      }
      this.sessions.clear();
      this.providerThreadClaims.clear();
      this.emittedToolCalls.clear();
      this.emittedToolResults.clear();
      this.pendingToolCallIds.clear();
      this.imageGenerationItems.clear();
      this.permissionResolvers.clear();
      this.threadLifecycleTails.clear();
      this.activeLifecycleOperations.clear();
      this.threadLifecycleEpochs.clear();
      // Normal stop settlement deletes cached inputs. Auth recovery is the
      // one reset that intentionally retains them for a transparent resend.
      for (const [threadId, input] of recoveryInputs) {
        this.lastStartInput.set(threadId, input);
      }
    });

    // A terminal stop requested while auth recovery was ahead of it in the
    // exclusive queue owns the final state and must not be followed by stale
    // recovery UI or session rehydration semantics.
    if (this.stopAllRequested) return;

    const recoveryMessage =
      'Codex auth was invalidated (likely a sign-in elsewhere). ' +
      'The Codex runtime has been reloaded with the latest credentials — resend your message to continue. ' +
      `Original: ${originalMessage}`;

    if (affectedThreads.length === 0) {
      this.emit({ type: 'error', threadId: 'unknown', error: new Error(recoveryMessage) });
      return;
    }

    for (const threadId of affectedThreads) {
      this.emit({ type: 'status_change', threadId, status: 'error' });
      this.emit({ type: 'error', threadId, error: new Error(recoveryMessage) });
    }
  }

  private enqueueToolOutputDelta(threadId: string, toolUseId: string, delta: string): void {
    let buffers = this.toolOutputBuffers.get(threadId);
    if (!buffers) {
      buffers = new Map();
      this.toolOutputBuffers.set(threadId, buffers);
    }
    // Cap the pending buffer so a runaway command can't grow memory unbounded
    // between flushes; the UI only renders a tail of this stream anyway.
    const next = ((buffers.get(toolUseId) || '') + delta).slice(-32000);
    buffers.set(toolUseId, next);
    if (!this.toolOutputFlushTimer) {
      this.toolOutputFlushTimer = setTimeout(() => {
        this.toolOutputFlushTimer = null;
        this.flushToolOutputDeltas();
      }, CodexAdapter.STREAMING_TEXT_COALESCE_MS);
    }
  }

  private flushToolOutputDeltas(): void {
    for (const [threadId, buffers] of this.toolOutputBuffers) {
      for (const [toolUseId, delta] of buffers) {
        if (delta) {
          this.emit({ type: 'tool_output_delta', threadId, toolUseId, delta });
        }
      }
    }
    this.toolOutputBuffers.clear();
  }

  private dropToolOutputBuffer(threadId: string, toolUseId?: string): void {
    if (toolUseId === undefined) {
      this.toolOutputBuffers.delete(threadId);
      return;
    }
    this.toolOutputBuffers.get(threadId)?.delete(toolUseId);
  }

  private extractToolCallInfo(params: Record<string, unknown>): {
    item: Record<string, unknown>;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolId: string;
  } {
    // Codex notifications wrap the actual tool item under `params.item` for
    // some channels (item/started) and inline it for others (item/toolCall).
    // Some builds also nest the invocation under `toolCall`/`functionCall`.
    const item = getRecord(params.item) || params;
    const nested =
      getRecordField(item, 'toolCall') ||
      getRecordField(item, 'tool_call') ||
      getRecordField(item, 'functionCall') ||
      getRecordField(item, 'function') ||
      getRecordField(item, 'call') ||
      getRecordField(params, 'toolCall') ||
      getRecordField(params, 'functionCall') ||
      null;

    const toolInput: Record<string, unknown> = {};
    for (const candidate of [
      item.input,
      item.params,
      item.arguments,
      item.args,
      item.request,
      params.input,
      nested?.input,
      nested?.params,
      nested?.arguments,
      nested?.args,
    ]) {
      const parsed = parseRecord(candidate);
      if (parsed) {
        Object.assign(toolInput, parsed);
      }
    }

    const command = getFirstString(
      toolInput.command,
      toolInput.cmd,
      item.command,
      params.command,
      nested?.command
    );
    const filePath = getFirstString(
      toolInput.file_path,
      toolInput.filePath,
      toolInput.path,
      toolInput.filename,
      item.file_path,
      item.filePath,
      item.path,
      nested?.file_path,
      nested?.filePath,
      nested?.path
    );
    const title = getFirstString(
      item.toolTitle,
      item.title,
      item.label,
      item.displayName,
      params.toolTitle,
      params.title,
      params.label,
      nested?.toolTitle,
      nested?.title,
      nested?.label,
      nested?.displayName
    );

    if (command && !getString(toolInput.command)) {
      toolInput.command = command;
    }
    if (filePath && !getString(toolInput.file_path) && !getString(toolInput.path)) {
      toolInput.file_path = filePath;
    }
    if (title) {
      toolInput.__aegisDisplayTitle = title;
    } else if (typeof toolInput.title === 'string' && toolInput.title.trim()) {
      toolInput.__aegisDisplayTitle = toolInput.title.trim();
    }

    // Codex `mcpToolCall` items carry the identity in `server` + `tool`, not
    // `name` — without this branch they render as the literal item type
    // ("mcpToolCall"). Compose Claude-style `mcp__<server>__<tool>` so the
    // renderer's mcp_tool_call classification and the delegate attribution
    // matcher both work off the same name.
    const mcpTool = getFirstString(item.tool, nested?.tool);
    const mcpServer = getFirstString(item.server, nested?.server);
    const mcpToolName = mcpTool ? (mcpServer ? `mcp__${mcpServer}__${mcpTool}` : mcpTool) : null;

    const rawName = getFirstString(
      item.name,
      item.toolName,
      item.tool_name,
      params.name,
      params.toolName,
      nested?.name,
      nested?.toolName,
      nested?.tool_name,
      item.type
    );
    const toolName =
      mcpToolName ||
      normalizeCodexToolName(rawName) ||
      inferCodexToolNameFromFields({ command, filePath, title }) ||
      'unknown';

    const action = classifyComputerUseAction({
      toolName,
      server: mcpServer,
      tool: mcpTool,
      app: getString(toolInput.app),
      title: getString(toolInput.title) || getString(toolInput.__aegisDisplayTitle),
    });
    if (action) {
      toolInput.__aegisComputerUse = action;
      if (!getString(toolInput.__aegisDisplayTitle)) {
        toolInput.__aegisDisplayTitle = formatComputerUseLabel(action, 'pending');
      }
    }

    // Use Codex's own id so tool_result's `toolUseId` can find this entry.
    const codexId = getFirstString(
      item.id,
      item.toolUseId,
      item.toolCallId,
      item.callId,
      params.id,
      params.toolUseId,
      params.toolCallId,
      params.callId,
      nested?.id,
      nested?.toolUseId,
      nested?.toolCallId,
      nested?.callId
    );

    return {
      item,
      toolName,
      toolInput,
      toolId: codexId || uuidv4(),
    };
  }

  private markEmitted(
    store: Map<string, Set<string>>,
    threadId: string,
    id: string
  ): boolean {
    let seen = store.get(threadId);
    if (!seen) {
      seen = new Set();
      store.set(threadId, seen);
    }
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  }

  private extractToolResultInfo(
    threadId: string,
    params: Record<string, unknown>
  ): {
    item: Record<string, unknown>;
    toolUseId: string;
    rawContent: unknown;
  } {
    const item = getRecord(params.item) || params;
    const nested =
      getRecordField(item, 'toolResult') ||
      getRecordField(item, 'tool_result') ||
      getRecordField(item, 'result') ||
      getRecordField(params, 'toolResult') ||
      getRecordField(params, 'tool_result') ||
      null;

    const candidates = [
      item.toolUseId,
      item.tool_use_id,
      item.toolCallId,
      item.tool_call_id,
      item.callId,
      item.call_id,
      params.toolUseId,
      params.tool_use_id,
      params.toolCallId,
      params.tool_call_id,
      params.callId,
      params.call_id,
      nested?.toolUseId,
      nested?.tool_use_id,
      nested?.toolCallId,
      nested?.tool_call_id,
      nested?.callId,
      nested?.call_id,
      item.id,
      params.id,
      nested?.id,
    ]
      .map(getString)
      .filter(Boolean);

    const knownCalls = this.emittedToolCalls.get(threadId);
    const knownId = candidates.find((candidate) => knownCalls?.has(candidate));
    const toolUseId = knownId || this.latestPendingToolCallId(threadId) || candidates[0] || '';
    const rawContent =
      item.output ??
      item.rawOutput ??
      item.result ??
      item.message ??
      item.content ??
      nested?.output ??
      nested?.rawOutput ??
      nested?.result ??
      nested?.message ??
      nested?.content ??
      params.output ??
      params.result ??
      params.content ??
      'Done';

    return { item, toolUseId, rawContent };
  }

  private rememberPendingToolCall(threadId: string, toolId: string): void {
    const pending = this.pendingToolCallIds.get(threadId) || [];
    if (!pending.includes(toolId)) {
      pending.push(toolId);
      this.pendingToolCallIds.set(threadId, pending);
    }
  }

  private latestPendingToolCallId(threadId: string): string {
    const pending = this.pendingToolCallIds.get(threadId);
    return pending?.[pending.length - 1] || '';
  }

  private forgetPendingToolCall(threadId: string, toolId: string): void {
    const pending = this.pendingToolCallIds.get(threadId);
    if (!pending) return;
    const next = pending.filter((id) => id !== toolId);
    if (next.length > 0) {
      this.pendingToolCallIds.set(threadId, next);
    } else {
      this.pendingToolCallIds.delete(threadId);
    }
  }
}

const AUTH_REFRESH_HINTS = [
  'access token could not be refreshed',
  'logged out or signed in to another',
  'sign in again',
  'refresh_token_reused',
  'refresh token has already been used',
  'log out and sign in again',
];

function isAuthRefreshError(message: string | undefined | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return AUTH_REFRESH_HINTS.some((hint) => lower.includes(hint));
}
