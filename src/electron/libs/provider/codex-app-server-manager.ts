import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { homedir } from 'os';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import type {
  StreamMessage,
  Attachment,
  CodexExecutionMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  PermissionResult,
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  ProviderPluginAppSummary,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderPluginInterface,
  ProviderPluginSource,
  ProviderInputReference,
  ProviderReadPluginResult,
  CodexCreditsSnapshot,
  CodexRateLimitReport,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  ProviderSkillDescriptor,
  McpServerStatus,
} from '../../../shared/types';
import { isDev } from '../../util';

// ── Types ──────────────────────────────────────────────────────────────────

// Codex app-server RequestId is `string | number` (generated schema, 0.144.3).
type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** JSON-RPC error response from the codex app-server, with code/data preserved. */
export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    readonly data: unknown,
    message: string
  ) {
    super(`${method}: ${message}`);
    this.name = 'CodexRpcError';
  }
}

export type CodexTransportFailureReason =
  | 'process_exit'
  | 'process_error'
  | 'spawn_failed'
  | 'stopped'
  | 'timeout'
  | 'stale_generation';

/** Transport-level failure (process death, timeout, stale generation). */
export class CodexRpcTransportError extends Error {
  constructor(readonly reason: CodexTransportFailureReason, readonly method?: string) {
    super(
      reason === 'timeout' && method
        ? `Timed out waiting for ${method}`
        : `Codex app-server transport failure (${reason})${method ? ` during ${method}` : ''}`
    );
    this.name = 'CodexRpcTransportError';
  }
}

/** The provider thread is already bound to another Aegis session. */
export class CodexThreadBindingError extends Error {
  constructor(readonly providerThreadId: string, readonly boundThreadId: string) {
    super('This Codex thread is already attached to another session');
    this.name = 'CodexThreadBindingError';
  }
}

interface CodexSession {
  threadId: string;
  providerThreadId: string;
  /** Process generation this session was created on (stale ops are rejected). */
  generation: number;
  cwd: string;
  activeTurnId?: string;
  status: 'connecting' | 'ready' | 'running' | 'interrupting' | 'error';
  lastError?: string;
  model?: string;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  /** Session+model keys that already produced a fast-unavailable notice. */
  fastModeNoticeKeys?: Set<string>;
}

interface PendingRequest {
  method: string;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingApproval {
  jsonRpcId: JsonRpcId;
  method: string;
  threadId: string;
  params?: Record<string, unknown>;
}

/** In-flight stop confirmation, keyed by providerThreadId (P0-6). */
interface PendingInterrupt {
  turnId: string;
  aegisThreadId: string;
  generation: number;
  timer: NodeJS.Timeout;
}

export interface CodexModelServiceTier {
  id: string;
  name: string;
  description: string;
}

/** `review/start` target — internally tagged enum in the 0.144 protocol. */
export type CodexReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string }
  | { type: 'custom'; instructions: string };

export interface CodexModelCatalogEntry {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  serviceTiers: CodexModelServiceTier[];
  defaultServiceTier: string | null;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

/**
 * Resolve the service tier a "fast mode" toggle maps to: exactly one
 * non-default tier → that tier; zero or multiple → null (fast unavailable).
 * Provisional heuristic — `ModelServiceTier` carries no speed semantics in
 * the 0.144.3 protocol, so surface the resolved tier's name in logs/UI.
 */
export function resolveFastTier(
  entry: Pick<CodexModelCatalogEntry, 'serviceTiers' | 'defaultServiceTier'>
): CodexModelServiceTier | null {
  const nonDefault = entry.serviceTiers.filter((tier) => tier.id !== entry.defaultServiceTier);
  return nonDefault.length === 1 ? nonDefault[0] : null;
}

interface CodexRunOptions {
  model?: string;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

// Env overrides exist for the test harness only (verify:codex-app-server) —
// production always runs the defaults.
function envTimeout(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const INITIALIZE_TIMEOUT_MS = envTimeout('AEGIS_CODEX_INITIALIZE_TIMEOUT_MS', 20_000);
const REQUEST_TIMEOUT_MS = envTimeout('AEGIS_CODEX_REQUEST_TIMEOUT_MS', 30_000);
// plugin/install may download plugin content (git clone / remote fetch).
const PLUGIN_INSTALL_TIMEOUT_MS = envTimeout('AEGIS_CODEX_PLUGIN_INSTALL_TIMEOUT_MS', 120_000);
const TURN_TIMEOUT_MS = envTimeout('AEGIS_CODEX_TURN_TIMEOUT_MS', 300_000);
// How long a stop waits for `turn/completed(interrupted)` before settling
// unconfirmed (P0-6).
const STOP_CONFIRM_TIMEOUT_MS = envTimeout('AEGIS_CODEX_STOP_CONFIRM_TIMEOUT_MS', 10_000);

function resolveSkillsDiscoveryCwd(cwd: string | undefined): string {
  const trimmed = cwd?.trim();
  return trimmed || homedir();
}

// Codex app-server emits these as housekeeping signal — we don't act on them yet,
// so swallow them silently instead of cluttering dev logs as "unhandled".
const IGNORED_NOTIFICATIONS = new Set<string>([
  'thread/status/changed',
  'fs/changed',
  'hook/started',
  'hook/completed',
  'warning',
  'deprecationNotice',
  'configWarning',
  'remoteControl/status/changed',
]);

function isTransientConnectionMessage(message: string): boolean {
  return /^Reconnecting\.\.\. \d+\/\d+$/i.test(message.trim());
}

// ── CodexAppServerManager ──────────────────────────────────────────────────

export class CodexAppServerManager extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextRequestId = 1;
  // Keyed by String(id): JSON-RPC ids may be string or number on the wire.
  private pending = new Map<string, PendingRequest>();
  private sessions = new Map<string, CodexSession>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private initialized = false;
  // Single-flight spawn barrier: concurrent ensureSpawned() calls await the
  // same in-flight promise; nothing proceeds before initialize completes.
  private spawnPromise: Promise<void> | null = null;
  // Monotonic process generation. Sessions/handlers capture it so events from
  // a dead child and operations on stale sessions can be rejected.
  private generation = 0;
  // Stop confirmations awaiting the interrupted turn's terminal (P0-6).
  private pendingInterrupts = new Map<string, PendingInterrupt>();
  // providerThreadId of a sub-agent thread → root Aegis threadId (P0-7).
  private descendantThreadMap = new Map<string, string>();
  private modelCatalog: { generation: number; models: CodexModelCatalogEntry[] } | null = null;
  private modelCatalogPromise: Promise<CodexModelCatalogEntry[]> | null = null;
  private skillsCache = new Map<string, ProviderListSkillsResult>();
  private pluginsCache = new Map<string, ProviderListPluginsResult>();
  private pluginDetailCache = new Map<string, ProviderReadPluginResult>();
  private lastActiveThreadId: string | null = null;
  // One compaction reaches us twice (deprecated `thread/compacted` notification
  // + `contextCompaction` item) with no shared id, so dedupe by time instead.
  private static readonly COMPACTION_DEDUPE_MS = 5000;
  private lastCompactionEmitAt = new Map<string, number>();

  constructor(
    private readonly binaryPath = 'codex',
    private readonly clientVersion = '0.0.0'
  ) {
    super();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async spawn(cwd: string): Promise<void> {
    return this.ensureSpawned(cwd);
  }

  private async doSpawn(cwd: string): Promise<void> {
    if (this.child) {
      return;
    }

    this.generation += 1;
    const gen = this.generation;

    const child = spawn(this.binaryPath, ['app-server'], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    this.child = child;

    const rl = readline.createInterface({ input: child.stdout });
    this.rl = rl;

    rl.on('line', (line) => this.handleStdoutLine(line));

    child.on('exit', (code, signal) => {
      // Stale exit from a replaced child must not tear down the new one.
      if (this.child !== child) return;
      if (isDev()) {
        console.log('[Codex AppServer] process exited', { code, signal });
      }
      this.emit('process_exit', { code, signal });
      this.cleanupGeneration(gen, 'process_exit');
    });

    child.on('error', (error) => {
      console.error('[Codex AppServer] process error', error);
      this.emit('process_error', error);
      if (this.child !== child) return;
      this.cleanupGeneration(gen, 'process_error');
    });

    child.stderr?.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) {
        if (isDev()) {
          console.warn('[Codex AppServer stderr]', line);
        }
        // Check for auth errors
        if (
          /(refresh_token_reused|refresh token has already been used|sign in again)/i.test(line)
        ) {
          this.emit(
            'auth_error',
            new Error(
              'Codex authentication failed. Please sign out and sign in again.'
            )
          );
        }
      }
    });

    // Initialize handshake. On failure, tear the child down completely so the
    // next ensureSpawned() retries with a fresh process instead of short-
    // circuiting on a half-initialized child.
    try {
      await this.sendRequest('initialize', {
        clientInfo: {
          name: 'aegis',
          title: 'Aegis',
          version: this.clientVersion,
        },
        capabilities: {
          experimentalApi: true,
        },
      }, INITIALIZE_TIMEOUT_MS);
    } catch (error) {
      this.cleanupGeneration(gen, 'spawn_failed');
      throw error;
    }

    this.writeMessage({ method: 'initialized' });
    this.initialized = true;

    if (isDev()) {
      console.log('[Codex AppServer] initialized');
    }
  }

  async stop(): Promise<void> {
    this.cleanupGeneration(this.generation, 'stopped');
  }

  /**
   * Tear down the given generation: reject in-flight RPCs, settle pending
   * stop confirmations, dismiss pending approvals, kill the child. No-ops on
   * stale generations so a late exit can't clobber a replacement process.
   */
  private cleanupGeneration(gen: number, reason: CodexTransportFailureReason): void {
    if (gen !== this.generation) return;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexRpcTransportError(reason, pending.method));
    }
    this.pending.clear();

    // Settle stop confirmations immediately — the UI shouldn't sit in
    // "stopping" for the remaining timeout after the process is gone.
    for (const [providerThreadId, interrupt] of this.pendingInterrupts) {
      clearTimeout(interrupt.timer);
      this.emit('stop_settled', {
        aegisThreadId: interrupt.aegisThreadId,
        providerThreadId,
        generation: interrupt.generation,
        confirmed: false,
      });
    }
    this.pendingInterrupts.clear();

    // The JSON-RPC ids of these approvals can never be answered now; tell the
    // UI to drop the cards instead of leaving them pointing at dead requests.
    for (const [requestId, approval] of this.pendingApprovals) {
      this.emit('approval_dismissed', { requestId, threadId: approval.threadId });
    }
    this.pendingApprovals.clear();

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
    }
    this.initialized = false;
    this.sessions.clear();
    this.descendantThreadMap.clear();
    this.modelCatalog = null;
    this.modelCatalogPromise = null;
    this.lastActiveThreadId = null;
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  async listSkills(input: {
    cwd?: string;
    threadId?: string;
    forceReload?: boolean;
  }): Promise<ProviderListSkillsResult> {
    const cwd = resolveSkillsDiscoveryCwd(input.cwd);

    const cacheKey = JSON.stringify({ cwd, threadId: input.threadId?.trim() || null });
    if (!input.forceReload) {
      const cached = this.skillsCache.get(cacheKey);
      if (cached) return { ...cached, cached: true };
    }

    await this.ensureSpawned(cwd);
    const response = (await this.sendRequest<Record<string, unknown>>(
      'skills/list',
      {
        cwds: [cwd],
        ...(input.forceReload ? { forceReload: true } : {}),
      },
      REQUEST_TIMEOUT_MS
    )) as Record<string, unknown>;

    const result: ProviderListSkillsResult = {
      skills: this.parseSkillsListResponse(response, cwd),
      source: 'codex-app-server',
      cached: false,
    };
    this.skillsCache.set(cacheKey, result);
    return result;
  }

  async listPlugins(input: {
    cwd?: string;
    threadId?: string;
    forceReload?: boolean;
  }): Promise<ProviderListPluginsResult> {
    const cwd = input.cwd?.trim() || null;
    const cacheKey = JSON.stringify({ cwd, threadId: input.threadId?.trim() || null });
    if (!input.forceReload) {
      const cached = this.pluginsCache.get(cacheKey);
      if (cached) return { ...cached, cached: true };
    }

    await this.ensureSpawned(cwd || process.cwd());
    const response = (await this.sendRequest<Record<string, unknown>>(
      'plugin/list',
      cwd ? { cwds: [cwd] } : {},
      REQUEST_TIMEOUT_MS
    )) as Record<string, unknown>;

    const result: ProviderListPluginsResult = {
      ...this.parsePluginListResponse(response),
      source: 'codex-app-server',
      cached: false,
    };
    this.pluginsCache.set(cacheKey, result);
    return result;
  }

  async readPlugin(input: {
    marketplacePath?: string | null;
    remoteMarketplaceName?: string | null;
    pluginName: string;
  }): Promise<ProviderReadPluginResult> {
    const marketplacePath = input.marketplacePath?.trim() || null;
    const remoteMarketplaceName = input.remoteMarketplaceName?.trim() || null;
    const pluginName = input.pluginName.trim();
    const cacheKey = JSON.stringify({ marketplacePath, remoteMarketplaceName, pluginName });
    const cached = this.pluginDetailCache.get(cacheKey);
    if (cached) return { ...cached, cached: true };

    await this.ensureSpawned(process.cwd());
    const response = (await this.sendRequest<Record<string, unknown>>(
      'plugin/read',
      {
        ...(marketplacePath ? { marketplacePath } : {}),
        ...(remoteMarketplaceName ? { remoteMarketplaceName } : {}),
        pluginName,
      },
      REQUEST_TIMEOUT_MS
    )) as Record<string, unknown>;

    const result: ProviderReadPluginResult = {
      plugin: this.parsePluginReadResponse(response),
      source: 'codex-app-server',
      cached: false,
    };
    this.pluginDetailCache.set(cacheKey, result);
    return result;
  }

  async installPlugin(input: {
    marketplacePath?: string | null;
    remoteMarketplaceName?: string | null;
    pluginName: string;
  }): Promise<void> {
    const marketplacePath = input.marketplacePath?.trim() || null;
    const remoteMarketplaceName = input.remoteMarketplaceName?.trim() || null;
    await this.ensureSpawned(process.cwd());
    await this.sendRequest(
      'plugin/install',
      {
        ...(marketplacePath ? { marketplacePath } : {}),
        ...(remoteMarketplaceName ? { remoteMarketplaceName } : {}),
        pluginName: input.pluginName.trim(),
      },
      PLUGIN_INSTALL_TIMEOUT_MS
    );
    this.invalidatePluginCaches();
  }

  async uninstallPlugin(input: { pluginId: string }): Promise<void> {
    await this.ensureSpawned(process.cwd());
    await this.sendRequest(
      'plugin/uninstall',
      { pluginId: input.pluginId.trim() },
      REQUEST_TIMEOUT_MS
    );
    this.invalidatePluginCaches();
  }

  /** Install state changed — cached plugin lists/details are stale. */
  private invalidatePluginCaches(): void {
    this.pluginsCache.clear();
    this.pluginDetailCache.clear();
  }

  async readAccountRateLimits(cwd = process.cwd()): Promise<CodexRateLimitReport> {
    await this.ensureSpawned(cwd);
    const response = await this.sendRequest<Record<string, unknown>>(
      'account/rateLimits/read',
      undefined,
      REQUEST_TIMEOUT_MS
    );

    return this.parseRateLimitReport(response);
  }

  /**
   * Authoritative model catalog from `model/list` (cursor-drained), cached
   * per process generation. Never spawns the app-server on its own — callers
   * on the send/resume path are guaranteed a live process; UI enrichment
   * simply stays empty until one exists.
   */
  async listModels(forceReload = false): Promise<CodexModelCatalogEntry[]> {
    if (!this.initialized) return [];
    if (!forceReload && this.modelCatalog && this.modelCatalog.generation === this.generation) {
      return this.modelCatalog.models;
    }
    if (!this.modelCatalogPromise) {
      this.modelCatalogPromise = this.drainModelList()
        .then((models) => {
          this.modelCatalog = { generation: this.generation, models };
          this.emit('model_catalog_updated', { models });
          return models;
        })
        .finally(() => {
          this.modelCatalogPromise = null;
        });
    }
    return this.modelCatalogPromise;
  }

  private async drainModelList(): Promise<CodexModelCatalogEntry[]> {
    const models: CodexModelCatalogEntry[] = [];
    let cursor: string | null = null;
    // Bounded page drain — defensive cap so a server bug can't loop forever.
    for (let page = 0; page < 20; page++) {
      const response = (await this.sendRequest<Record<string, unknown>>(
        'model/list',
        cursor ? { cursor } : {},
        REQUEST_TIMEOUT_MS
      )) as Record<string, unknown>;
      const items = this.readArray(response, 'items') ?? this.readArray(response, 'models') ?? [];
      for (const raw of items) {
        const obj = this.asObject(raw);
        if (!obj) continue;
        const id = this.readString(obj, 'id') || this.readString(obj, 'model');
        const model = this.readString(obj, 'model') || id;
        if (!id || !model) continue;
        const tiers = (this.readArray(obj, 'serviceTiers') ?? [])
          .map((tier) => {
            const tierObj = this.asObject(tier);
            const tierId = this.readString(tierObj, 'id');
            if (!tierId) return null;
            return {
              id: tierId,
              name: this.readString(tierObj, 'name') || tierId,
              description: this.readString(tierObj, 'description') || '',
            };
          })
          .filter((tier): tier is CodexModelServiceTier => tier !== null);
        models.push({
          id,
          model,
          displayName: this.readString(obj, 'displayName') || model,
          hidden: obj.hidden === true,
          serviceTiers: tiers,
          defaultServiceTier: this.readString(obj, 'defaultServiceTier'),
          supportedReasoningEfforts: (this.readArray(obj, 'supportedReasoningEfforts') ?? [])
            .map((effort) => {
              const effortObj = this.asObject(effort);
              return (
                this.readString(effortObj, 'effort') ??
                this.readString(effortObj, 'id') ??
                (typeof effort === 'string' ? effort : null)
              );
            })
            .filter((effort): effort is string => Boolean(effort)),
          defaultReasoningEffort: this.readString(obj, 'defaultReasoningEffort'),
        });
      }
      cursor = this.readString(response, 'nextCursor');
      if (!cursor) break;
    }
    return models;
  }

  /**
   * Fast-mode → serviceTier param (P0-3). serviceTier is a STICKY double-
   * Option override: omitted = inherit current, explicit null = clear back to
   * the default tier. So fast-off must SEND `serviceTier: null` on
   * turn/start and thread/resume, otherwise a previously-fast thread keeps
   * running on the fast tier. thread/start callers simply don't call this.
   */
  private async resolveServiceTierParam(
    threadId: string,
    model: string | undefined,
    fastMode: boolean | undefined
  ): Promise<Record<string, unknown>> {
    if (!fastMode) {
      return { serviceTier: null };
    }

    let tier: CodexModelServiceTier | null = null;
    let entry: CodexModelCatalogEntry | undefined;
    try {
      const catalog = await this.listModels();
      const target = model?.trim();
      entry = target
        ? catalog.find((candidate) => candidate.model === target || candidate.id === target)
        : catalog.find((candidate) => !candidate.hidden);
      tier = entry ? resolveFastTier(entry) : null;
    } catch (error) {
      if (isDev()) {
        console.log('[Codex AppServer] model/list failed while resolving fast tier', error);
      }
    }

    if (!tier) {
      this.emitFastModeUnavailable(threadId, model);
      return {};
    }

    if (isDev()) {
      console.log('[Codex AppServer] fast mode resolved to tier', {
        model: entry?.model,
        tier: tier.id,
        tierName: tier.name,
      });
    }
    return { serviceTier: tier.id };
  }

  /** Once per session+model: tell the user fast mode has no resolvable tier. */
  private emitFastModeUnavailable(threadId: string, model: string | undefined): void {
    const session = this.sessions.get(threadId);
    const key = model?.trim() || '(default)';
    if (session) {
      session.fastModeNoticeKeys = session.fastModeNoticeKeys ?? new Set();
      if (session.fastModeNoticeKeys.has(key)) return;
      session.fastModeNoticeKeys.add(key);
    }
    this.emit('fast_mode_unavailable', { threadId, model: key });
  }

  private invalidateDiscoveryCaches(kind: 'skills' | 'plugins' | 'all'): void {
    if (kind === 'skills' || kind === 'all') {
      this.skillsCache.clear();
    }
    if (kind === 'plugins' || kind === 'all') {
      this.pluginsCache.clear();
      this.pluginDetailCache.clear();
    }
  }

  // ── Session Management ───────────────────────────────────────────────────

  async createSession(
    threadId: string,
    cwd: string,
    resumeCursor?: string,
    options: CodexRunOptions = {}
  ): Promise<{
    providerThreadId: string;
    model?: string;
    generation: number;
    resumeFallback?: { reason: string };
  }> {
    await this.ensureSpawned(cwd);

    let response: Record<string, unknown>;
    let resumeFallback: { reason: string } | undefined;

    if (resumeCursor) {
      // Double-binding guard: a provider thread may be attached to at most
      // one Aegis session — silently sharing it would interleave contexts.
      const boundThreadId = this.findThreadByProviderThreadId(resumeCursor);
      if (boundThreadId && boundThreadId !== threadId) {
        throw new CodexThreadBindingError(resumeCursor, boundThreadId);
      }

      // `thread/load` does not exist in 0.144.x — resume is the only path.
      // On failure we do NOT silently continue: the caller surfaces a
      // persistent notice before we fall back to a fresh thread, so the user
      // sees the context break instead of an agent that quietly forgot
      // everything. Auth errors are rethrown (auth recovery owns them).
      try {
        response = (await this.sendRequest(
          'thread/resume',
          {
            threadId: resumeCursor,
            cwd,
            ...(options.model ? { model: options.model } : {}),
            ...this.buildThreadPermissionOptions(cwd, options.codexPermissionMode, options.codexExecutionMode),
            ...(await this.resolveServiceTierParam(threadId, options.model, options.codexFastMode)),
          },
          REQUEST_TIMEOUT_MS
        )) as Record<string, unknown>;
      } catch (error) {
        if (!this.isResumeFallbackEligible(error)) {
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        if (isDev()) {
          console.log('[Codex AppServer] thread/resume failed, starting fresh thread:', reason);
        }
        resumeFallback = { reason };
        response = await this.createNewThread(cwd, options);
      }
    } else {
      response = await this.createNewThread(cwd, options);
    }

    const providerThreadId = String(
      (response.thread as Record<string, unknown>)?.id ||
      response.threadId ||
      response.id ||
      ''
    );

    if (!providerThreadId) {
      throw new Error('thread/start did not return a thread id');
    }

    // Guard the fresh binding too (covers fresh-start collisions).
    const existingOwner = this.findThreadByProviderThreadId(providerThreadId);
    if (existingOwner && existingOwner !== threadId) {
      throw new CodexThreadBindingError(providerThreadId, existingOwner);
    }

    const model = String((response.thread as Record<string, unknown>)?.model || response.model || '');

    // The server's effective cwd wins — sandbox writableRoots must match the
    // directory codex actually executes in (worktree moves, resume rejoins).
    const effectiveCwd = this.readString(response, 'cwd') || cwd;
    if (effectiveCwd !== cwd) {
      console.warn('[Codex AppServer] effective cwd differs from requested', {
        requested: cwd,
        effective: effectiveCwd,
      });
    }

    this.sessions.set(threadId, {
      threadId,
      providerThreadId,
      generation: this.generation,
      cwd: effectiveCwd,
      status: 'ready',
      model: model || options.model,
      codexExecutionMode: options.codexExecutionMode,
      codexPermissionMode: options.codexPermissionMode,
      codexReasoningEffort: options.codexReasoningEffort,
      codexFastMode: options.codexFastMode,
    });
    this.lastActiveThreadId = threadId;

    return {
      providerThreadId,
      model: model || undefined,
      generation: this.generation,
      ...(resumeFallback ? { resumeFallback } : {}),
    };
  }

  /**
   * Resume failures that fall back to a fresh thread: RPC-level errors (thread
   * gone, method missing) and timeouts. Auth failures and binding conflicts
   * are rethrown — they need their own handling, not a silent new thread.
   */
  private isResumeFallbackEligible(error: unknown): boolean {
    if (error instanceof CodexThreadBindingError) return false;
    const message = error instanceof Error ? error.message : '';
    if (/refresh_token_reused|refresh token has already been used|sign in again|401|unauthorized/i.test(message)) {
      return false;
    }
    return error instanceof CodexRpcError || error instanceof CodexRpcTransportError;
  }

  /**
   * Fork a recorded thread into a new independent one via `thread/fork`.
   * The source rollout is left untouched; returns the forked thread id.
   */
  async forkThread(cwd: string, sourceProviderThreadId: string): Promise<string> {
    await this.ensureSpawned(cwd);
    const response = (await this.sendRequest(
      'thread/fork',
      { threadId: sourceProviderThreadId },
      REQUEST_TIMEOUT_MS
    )) as Record<string, unknown>;
    const forkedId = String(
      (response.thread as Record<string, unknown>)?.id || response.threadId || response.id || ''
    );
    if (!forkedId) {
      throw new Error('thread/fork did not return a thread id');
    }
    return forkedId;
  }

  private async createNewThread(
    cwd: string,
    options: CodexRunOptions = {}
  ): Promise<Record<string, unknown>> {
    return (await this.sendRequest(
      'thread/start',
      {
        cwd,
        ...(options.model ? { model: options.model } : {}),
        ...this.buildThreadPermissionOptions(cwd, options.codexPermissionMode, options.codexExecutionMode),
      },
      REQUEST_TIMEOUT_MS
    )) as Record<string, unknown>;
  }

  /** True while the thread has a live turn we could steer instead of starting a new one. */
  hasActiveTurn(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    return Boolean(session && session.status === 'running' && session.activeTurnId);
  }

  async sendTurn(
    threadId: string,
    prompt: string,
    attachments?: Attachment[],
    codexSkills?: ProviderInputReference[],
    codexMentions?: ProviderInputReference[],
    options: CodexRunOptions = {}
  ): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`No session found for thread "${threadId}"`);
    }
    if (session.generation !== this.generation) {
      throw new CodexRpcTransportError('stale_generation', 'turn/start');
    }
    // Captured before the status mutation below: a send that lands while a
    // turn is still streaming becomes a `turn/steer` into that turn.
    // `interrupting` intentionally does NOT satisfy this gate — steering into
    // a turn that is being killed loses the message (P0-6).
    const steerTurnId =
      session.status === 'running' && session.activeTurnId ? session.activeTurnId : null;
    this.lastActiveThreadId = threadId;
    session.status = 'running';
    session.model = options.model || session.model;
    session.codexExecutionMode = options.codexExecutionMode || session.codexExecutionMode;
    session.codexPermissionMode = options.codexPermissionMode || session.codexPermissionMode;
    session.codexReasoningEffort = options.codexReasoningEffort || session.codexReasoningEffort;
    session.codexFastMode = options.codexFastMode ?? session.codexFastMode;

    // Build prompt content per Codex UserInput schema:
    //   { type: 'text', text }            → plain text
    //   { type: 'skill', name, path }      → Codex skill activation
    //   { type: 'mention', name, path }    → Codex plugin/app mention
    //   { type: 'localImage', path }      → image file (agent receives the actual image)
    //   anything else → fall back to a text description
    type UserInput =
      | { type: 'text'; text: string }
      | { type: 'skill'; name: string; path: string }
      | { type: 'mention'; name: string; path: string }
      | { type: 'localImage'; path: string };
    const content: UserInput[] = [];
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt) {
      content.push({ type: 'text', text: prompt });
    }

    for (const skill of codexSkills || []) {
      if (!skill.name.trim() || !skill.path.trim()) continue;
      content.push({ type: 'skill', name: skill.name.trim(), path: skill.path.trim() });
    }

    for (const mention of codexMentions || []) {
      if (!mention.name.trim() || !mention.path.trim()) continue;
      content.push({ type: 'mention', name: mention.name.trim(), path: mention.path.trim() });
    }

    if (attachments?.length) {
      const fileLines: string[] = [];
      for (const a of attachments) {
        if (!a || !a.path) continue;
        if (a.kind === 'image') {
          content.push({ type: 'localImage', path: a.path });
        } else {
          fileLines.push(`- ${a.name}: ${a.path}`);
        }
      }
      if (fileLines.length > 0) {
        content.push({
          type: 'text',
          text: 'Attachments:\n' + fileLines.join('\n'),
        });
      }
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    // Steer the in-flight turn instead of starting a new one. `expectedTurnId`
    // is a server-side precondition: if the turn finished in the race window
    // the request fails and we fall through to a normal turn/start.
    if (steerTurnId) {
      try {
        await this.sendRequest(
          'turn/steer',
          {
            threadId: session.providerThreadId,
            expectedTurnId: steerTurnId,
            input: content,
          },
          REQUEST_TIMEOUT_MS
        );
        if (isDev()) {
          console.log('[Codex AppServer] steered active turn', {
            threadId,
            turnId: steerTurnId,
          });
        }
        return;
      } catch (error) {
        if (isDev()) {
          console.log('[Codex AppServer] turn/steer fell back to turn/start:', error);
        }
      }
    }

    const response = (await this.sendRequest(
      'turn/start',
      {
        threadId: session.providerThreadId,
        input: content,
        // Sticky cwd override: keeps codex executing in the session's current
        // checkout after worktree moves (runner replacement updates cwd).
        cwd: session.cwd,
        ...(options.model || session.model ? { model: options.model || session.model } : {}),
        ...(options.codexReasoningEffort || session.codexReasoningEffort
          ? { effort: options.codexReasoningEffort || session.codexReasoningEffort }
          : {}),
        ...this.buildCollaborationModeOptions(
          options.codexExecutionMode || session.codexExecutionMode,
          options.model || session.model,
          options.codexReasoningEffort || session.codexReasoningEffort
        ),
        ...this.buildTurnPermissionOptions(
          session.cwd,
          options.codexPermissionMode || session.codexPermissionMode,
          options.codexExecutionMode || session.codexExecutionMode
        ),
        ...(await this.resolveServiceTierParam(
          threadId,
          options.model || session.model,
          options.codexFastMode ?? session.codexFastMode
        )),
      },
      TURN_TIMEOUT_MS
    )) as Record<string, unknown>;

    const turnId = String((response.turn as Record<string, unknown>)?.id || response.turnId || '');
    if (turnId) {
      session.activeTurnId = turnId;
      session.status = 'running';
    }
  }

  /**
   * Built-in slash commands (`/compact`, `/review`) map to dedicated RPCs
   * rather than `turn/start`. The RPC acks immediately and the server then
   * runs a regular turn — `turn/started`/`turn/completed` notifications flow
   * through the normal lifecycle handlers, so no extra turn registration is
   * needed here.
   */
  async compactThread(threadId: string): Promise<void> {
    const session = this.requireCommandSession(threadId, 'thread/compact/start');
    this.lastActiveThreadId = threadId;
    session.status = 'running';
    await this.sendRequest(
      'thread/compact/start',
      { threadId: session.providerThreadId },
      REQUEST_TIMEOUT_MS
    );
  }

  async startReview(threadId: string, target: CodexReviewTarget): Promise<void> {
    const session = this.requireCommandSession(threadId, 'review/start');
    this.lastActiveThreadId = threadId;
    session.status = 'running';
    await this.sendRequest(
      'review/start',
      { threadId: session.providerThreadId, target },
      REQUEST_TIMEOUT_MS
    );
  }

  private requireCommandSession(threadId: string, method: string): CodexSession {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`No session found for thread "${threadId}"`);
    }
    if (session.generation !== this.generation) {
      throw new CodexRpcTransportError('stale_generation', method);
    }
    return session;
  }

  /**
   * Two-phase stop (P0-6). `turn/interrupt` is ack-only — the real terminal
   * is `turn/completed(status=interrupted)`. The session is retained in
   * `interrupting` state until that terminal (or timeout) so late events can
   * still be attributed; `stop_settled` fires on every branch.
   */
  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      // Nothing to stop, but the settle event still fires so waiters (two-
      // phase stop) resolve immediately instead of timing out.
      this.emit('stop_settled', {
        aegisThreadId: threadId,
        providerThreadId: '',
        generation: this.generation,
        confirmed: true,
        noTurn: true,
      });
      return;
    }

    // No live turn → nothing to confirm; clean up and settle immediately so
    // adapter-side state is always released by the same signal.
    if (!session.activeTurnId || session.generation !== this.generation) {
      const { providerThreadId, generation } = session;
      this.sessions.delete(threadId);
      if (this.lastActiveThreadId === threadId) {
        this.lastActiveThreadId = this.findMostRecentFallbackThreadId();
      }
      this.declineApprovalsForThread(threadId);
      this.emit('stop_settled', {
        aegisThreadId: threadId,
        providerThreadId,
        generation,
        confirmed: true,
        noTurn: true,
      });
      return;
    }

    const turnId = session.activeTurnId;
    session.status = 'interrupting';

    if (!this.pendingInterrupts.has(session.providerThreadId)) {
      const timer = setTimeout(() => {
        const pendingInterrupt = this.pendingInterrupts.get(session.providerThreadId);
        if (pendingInterrupt) {
          this.pendingInterrupts.delete(session.providerThreadId);
          this.finishPendingInterrupt(
            { providerThreadId: session.providerThreadId, ...pendingInterrupt },
            false
          );
        }
      }, STOP_CONFIRM_TIMEOUT_MS);
      this.pendingInterrupts.set(session.providerThreadId, {
        turnId,
        aegisThreadId: threadId,
        generation: session.generation,
        timer,
      });
    }

    try {
      await this.sendRequest(
        'turn/interrupt',
        {
          threadId: session.providerThreadId,
          turnId,
        },
        REQUEST_TIMEOUT_MS
      );
    } catch (error) {
      // RPC rejected (stale turnId, transport death): treat as confirmation
      // failure right away instead of waiting out the timer.
      if (isDev()) {
        console.log('[Codex AppServer] turn/interrupt failed', error);
      }
      const pendingInterrupt = this.pendingInterrupts.get(session.providerThreadId);
      if (pendingInterrupt) {
        clearTimeout(pendingInterrupt.timer);
        this.pendingInterrupts.delete(session.providerThreadId);
        this.finishPendingInterrupt(
          { providerThreadId: session.providerThreadId, ...pendingInterrupt },
          false
        );
      }
    }
  }

  /**
   * Claim the pending interrupt for a terminal `turn/completed`, clearing its
   * timer. Returns null when there is nothing to settle or the terminal
   * belongs to a different turn.
   */
  private takePendingInterrupt(
    providerThreadId: string | null,
    turnId: string | null
  ): (PendingInterrupt & { providerThreadId: string }) | null {
    if (!providerThreadId) return null;
    const pendingInterrupt = this.pendingInterrupts.get(providerThreadId);
    if (!pendingInterrupt) return null;
    if (pendingInterrupt.turnId && turnId && pendingInterrupt.turnId !== turnId) {
      return null;
    }
    clearTimeout(pendingInterrupt.timer);
    this.pendingInterrupts.delete(providerThreadId);
    return { providerThreadId, ...pendingInterrupt };
  }

  /**
   * Deferred stop-flow session deletion + settle event. The deletion is
   * staleness-guarded: a replacement runner may have rebuilt the same Aegis
   * threadId on a new provider thread/generation — never delete that.
   */
  private finishPendingInterrupt(
    settle: PendingInterrupt & { providerThreadId: string },
    confirmed: boolean
  ): void {
    const session = this.sessions.get(settle.aegisThreadId);
    if (
      session &&
      session.providerThreadId === settle.providerThreadId &&
      session.generation === settle.generation &&
      (!session.activeTurnId || session.activeTurnId === settle.turnId)
    ) {
      this.sessions.delete(settle.aegisThreadId);
      if (this.lastActiveThreadId === settle.aegisThreadId) {
        this.lastActiveThreadId = this.findMostRecentFallbackThreadId();
      }
      this.declineApprovalsForThread(settle.aegisThreadId);
    }
    this.emit('stop_settled', {
      aegisThreadId: settle.aegisThreadId,
      providerThreadId: settle.providerThreadId,
      generation: settle.generation,
      confirmed,
    });
  }

  private normalizeCodexPermissionMode(
    mode: CodexPermissionMode | undefined
  ): CodexPermissionMode {
    if (mode === 'fullAccess') return 'fullAccess';
    if (mode === 'auto') return 'auto';
    return 'defaultPermissions';
  }

  private normalizeCodexExecutionMode(
    mode: CodexExecutionMode | undefined
  ): CodexExecutionMode {
    return mode === 'plan' ? 'plan' : 'execute';
  }

  private buildThreadPermissionOptions(
    _cwd: string,
    mode: CodexPermissionMode | undefined,
    executionMode: CodexExecutionMode | undefined
  ): Record<string, unknown> {
    if (this.normalizeCodexExecutionMode(executionMode) === 'plan') {
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
      };
    }

    if (this.normalizeCodexPermissionMode(mode) === 'fullAccess') {
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
      };
    }

    if (this.normalizeCodexPermissionMode(mode) === 'auto') {
      // Protocol-correct Auto: approvals are reviewed by codex's auto reviewer
      // (may approve or deny). `permissionMode` does not exist in the
      // protocol, and `approvalPolicy: 'never'` would hard-fail escalations
      // instead of routing them to the reviewer.
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
      };
    }

    return {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    };
  }

  private buildTurnPermissionOptions(
    cwd: string,
    mode: CodexPermissionMode | undefined,
    executionMode: CodexExecutionMode | undefined
  ): Record<string, unknown> {
    if (this.normalizeCodexExecutionMode(executionMode) === 'plan') {
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'readOnly',
          access: { type: 'fullAccess' },
          networkAccess: false,
        },
      };
    }

    if (this.normalizeCodexPermissionMode(mode) === 'fullAccess') {
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
    }

    if (this.normalizeCodexPermissionMode(mode) === 'auto') {
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [cwd || process.cwd()],
          readOnlyAccess: { type: 'fullAccess' },
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    }

    return {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [cwd || process.cwd()],
        readOnlyAccess: { type: 'fullAccess' },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    };
  }

  private buildCollaborationModeOptions(
    executionMode: CodexExecutionMode | undefined,
    model: string | undefined,
    reasoningEffort: CodexReasoningEffort | undefined
  ): Record<string, unknown> {
    const normalizedMode = this.normalizeCodexExecutionMode(executionMode);
    const selectedModel = model?.trim();

    // A client-supplied collaborationMode whose settings lack reasoning_effort
    // makes codex run the turn with NO effort — it does not fall back to the
    // config.toml `model_reasoning_effort` default (verified against
    // codex-cli 0.143.0 via rollout turn_context). The top-level `model`
    // param alone is enough for model override, so in default mode only send
    // collaborationMode when we have an explicit effort to convey; plan mode
    // always needs the envelope for its mode switch.
    if (normalizedMode !== 'plan' && !reasoningEffort) {
      return {};
    }

    return {
      collaborationMode: {
        mode: normalizedMode === 'plan' ? 'plan' : 'default',
        settings: {
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          developer_instructions: null,
        },
      },
    };
  }

  // ── Approval Responses ───────────────────────────────────────────────────

  async respondToApproval(
    requestId: string,
    result: PermissionResult,
    expectedThreadId?: string
  ): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    // A decision may only be written back by the session the request belongs
    // to — defends against UI-level misattribution (P0-7).
    if (expectedThreadId && pending.threadId && pending.threadId !== expectedThreadId) {
      console.warn(
        '[Codex AppServer] rejected approval response from wrong session',
        { requestId, owner: pending.threadId, caller: expectedThreadId }
      );
      return;
    }

    this.writeMessage({
      jsonrpc: '2.0',
      id: pending.jsonRpcId,
      result: this.buildApprovalResponse(pending, result),
    });

    this.pendingApprovals.delete(requestId);
  }

  /** Decline + dismiss every pending approval owned by the given session. */
  private declineApprovalsForThread(threadId: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.threadId !== threadId) continue;
      this.writeMessage({
        jsonrpc: '2.0',
        id: pending.jsonRpcId,
        result: this.buildApprovalResponse(pending, { behavior: 'deny' }),
      });
      this.pendingApprovals.delete(requestId);
      this.emit('approval_dismissed', { requestId, threadId });
    }
  }

  private buildApprovalResponse(
    pending: PendingApproval,
    result: PermissionResult
  ): Record<string, unknown> {
    const method = pending.method;
    const lower = method.toLowerCase();

    if (lower === 'item/commandexecution/requestapproval') {
      return {
        decision: this.selectModernApprovalDecision(pending.params, result, [
          'acceptForSession',
          'accept',
        ]),
      };
    }

    if (lower === 'item/filechange/requestapproval') {
      return {
        decision: this.selectModernApprovalDecision(pending.params, result, [
          'acceptForSession',
          'accept',
        ]),
      };
    }

    if (lower === 'item/permissions/requestapproval') {
      return this.buildPermissionsApprovalResponse(pending.params, result);
    }

    if (lower === 'item/tool/requestuserinput') {
      return this.buildToolUserInputResponse(pending.params, result);
    }

    if (lower === 'applypatchapproval' || lower === 'execcommandapproval') {
      return {
        decision:
          result.behavior === 'allow'
            ? result.scope === 'session'
              ? 'approved_for_session'
              : 'approved'
            : 'denied',
      };
    }

    // MCP elicitation: decline/cancel responses carry no content.
    if (lower.includes('elicitation')) {
      if (result.behavior !== 'allow') {
        return { action: 'decline', content: null, _meta: null };
      }
      const updatedInput = this.asObject(result.updatedInput);
      return {
        action: 'accept',
        content: updatedInput ?? {},
        _meta: null,
      };
    }

    return {
      decision: result.behavior === 'allow' ? 'accept' : 'decline',
      approved: result.behavior === 'allow',
      ...(result.message ? { message: result.message } : {}),
    };
  }

  private selectModernApprovalDecision(
    params: Record<string, unknown> | undefined,
    result: PermissionResult,
    allowPreference: string[]
  ): string {
    if (result.behavior !== 'allow') {
      return this.pickAvailableDecision(params, ['decline', 'cancel']);
    }

    const preferences =
      result.scope === 'session' ? allowPreference : allowPreference.filter((item) => item !== 'acceptForSession');
    return this.pickAvailableDecision(params, preferences.length > 0 ? preferences : ['accept']);
  }

  private pickAvailableDecision(
    params: Record<string, unknown> | undefined,
    preferred: string[]
  ): string {
    const available = this.readArray(params, 'availableDecisions')
      ?.filter((item): item is string => typeof item === 'string');

    if (!available || available.length === 0) {
      return preferred[0] || 'decline';
    }

    return preferred.find((decision) => available.includes(decision)) || available[0] || preferred[0] || 'decline';
  }

  private buildPermissionsApprovalResponse(
    params: Record<string, unknown> | undefined,
    result: PermissionResult
  ): Record<string, unknown> {
    if (result.behavior !== 'allow') {
      return {
        permissions: {},
        scope: 'turn',
        strictAutoReview: false,
      };
    }

    const requested = this.readObject(params, 'permissions');
    const granted: Record<string, unknown> = {};
    const network = this.readObject(requested, 'network');
    const fileSystem = this.readObject(requested, 'fileSystem');
    if (network) granted.network = network;
    if (fileSystem) granted.fileSystem = fileSystem;

    return {
      permissions: granted,
      scope: result.scope === 'session' ? 'session' : 'turn',
      strictAutoReview: false,
    };
  }

  private buildToolUserInputResponse(
    params: Record<string, unknown> | undefined,
    result: PermissionResult
  ): Record<string, unknown> {
    if (result.behavior !== 'allow') {
      return { answers: {} };
    }

    const updatedInput = this.asObject(result.updatedInput);
    const rawAnswers = this.asObject(updatedInput?.answers);
    const questions = this.readArray(params, 'questions') || [];
    const answers: Record<string, { answers: string[] }> = {};

    for (const question of questions) {
      const record = this.asObject(question);
      if (!record) continue;
      const id = this.optionalString(record.id);
      const text = this.optionalString(record.question);
      if (!id) continue;

      const value = (id && rawAnswers?.[id]) ?? (text && rawAnswers?.[text]);
      if (typeof value !== 'string') continue;
      const splitAnswers = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (splitAnswers.length > 0) {
        answers[id] = { answers: splitAnswers };
      }
    }

    return { answers };
  }

  // ── JSON-RPC Communication ───────────────────────────────────────────────

  private async sendRequest<T>(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<T> {
    if (!this.child?.stdin?.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }

    const id = this.nextRequestId++;
    const pendingKey = String(id);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new CodexRpcTransportError('timeout', method));
      }, timeoutMs);

      this.pending.set(pendingKey, {
        method,
        timeout,
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      this.writeMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  private writeMessage(message: unknown): void {
    const encoded = JSON.stringify(message);
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(`${encoded}\n`);
    }
  }

  // ── Stdout Handling ──────────────────────────────────────────────────────

  private handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    // Ignore non-JSON lines (e.g., startup logs)
    if (!line.startsWith('{')) {
      if (isDev()) {
        console.log('[Codex AppServer stdout]', line);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit('protocol_error', new Error('Invalid JSON from codex app-server'));
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      this.emit('protocol_error', new Error('Non-object protocol message'));
      return;
    }

    const msg = parsed as Record<string, unknown>;

    // JSON-RPC ids are `string | number` on the wire; accept both.
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';

    // Response (has id + result/error)
    if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
      this.handleResponse(msg as unknown as JsonRpcResponse);
      return;
    }

    // Request from server (has id + method)
    if (hasId && typeof msg.method === 'string') {
      this.handleServerRequest(msg as unknown as JsonRpcRequest);
      return;
    }

    // Notification (has method, no id)
    if (typeof msg.method === 'string') {
      this.handleNotification(msg as unknown as JsonRpcNotification);
      return;
    }

    this.emit('protocol_error', new Error('Unrecognized protocol message'));
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pendingKey = String(response.id);
    const pending = this.pending.get(pendingKey);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(pendingKey);

    if (response.error) {
      const message = response.error.message || 'JSON-RPC error';
      // Preserve code/data so callers can classify (-32601 = method missing)
      // instead of regexing the message text.
      pending.reject(
        new CodexRpcError(pending.method, response.error.code, response.error.data, message)
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    const method = request.method.toLowerCase();

    // Process-scoped time request: answering is harmless regardless of
    // routing, and erroring it can stall the requesting turn.
    if (method === 'currenttime/read') {
      this.writeMessage({
        jsonrpc: '2.0',
        id: request.id,
        result: { currentTimeAt: Math.floor(Date.now() / 1000) },
      });
      return;
    }

    const isApproval =
      method.includes('approval') ||
      method.includes('requestpermission') ||
      method.includes('confirm');
    const isUserInput = method.includes('requestuserinput') || method.includes('askuser');
    const isElicitation = method.includes('elicitation');

    if (isApproval || isUserInput || isElicitation) {
      // Fail-closed routing (P0-7): resolve the owner by exact provider
      // threadId (modern) or conversationId (legacy), then the descendant map
      // for sub-agent threads. NO most-recent/first-session fallback — an
      // unroutable request is auto-answered with the protocol-legal minimal
      // response instead of being shown in the wrong session.
      const providerThreadId =
        this.readString(request.params, 'threadId') ||
        this.readString(request.params, 'conversationId');
      const threadId = this.resolveOwnerThreadId(providerThreadId);

      if (!threadId) {
        console.warn(
          '[Codex AppServer] declining unroutable server request',
          request.method,
          isDev() ? JSON.stringify(request.params) : `providerThreadId=${providerThreadId}`
        );
        this.writeMessage({
          jsonrpc: '2.0',
          id: request.id,
          result: this.buildApprovalResponse(
            { jsonRpcId: request.id, method: request.method, threadId: '', params: request.params },
            { behavior: 'deny' }
          ),
        });
        return;
      }

      const requestId = uuidv4();
      this.pendingApprovals.set(requestId, {
        jsonRpcId: request.id,
        method: request.method,
        threadId,
        params: request.params,
      });

      this.emit(isApproval ? 'approval_request' : 'user_input_request', {
        requestId,
        jsonRpcId: request.id,
        method: request.method,
        threadId,
        params: request.params,
      });
      return;
    }

    // Everything else (account/chatgptAuthTokens/refresh, attestation/generate,
    // item/tool/call, unknown methods): a -32601 error response also resolves
    // the server-side pending request, so nothing hangs. Token refresh gets a
    // distinct log because failing it can break in-flight turns for
    // ChatGPT-auth users — wiring it up is a tracked follow-up.
    if (method === 'account/chatgptauthtokens/refresh') {
      console.warn('[Codex AppServer] rejecting chatgptAuthTokens/refresh (not implemented)');
    }
    this.writeMessage({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const method = notification.method;
    const params = notification.params || {};

    switch (method) {
      case 'turn/started': {
        const turnObj = params.turn as Record<string, unknown> | undefined;
        const turnId = this.readString(turnObj, 'id');
        const threadId = this.findThreadByProviderThreadId(
          this.readString(params, 'threadId') || this.readString(turnObj, 'threadId')
        );
        if (threadId && turnId) {
          const session = this.sessions.get(threadId);
          if (session) {
            session.activeTurnId = turnId;
            session.status = 'running';
          }
        }
        break;
      }

      case 'turn/completed': {
        // 0.144.3 has no `turn/aborted` notification — every terminal arrives
        // here with turn.status ∈ completed | interrupted | failed.
        const providerThreadId = this.readString(params, 'threadId');
        const turn = this.asObject(params.turn);
        const status = this.readString(turn, 'status');
        // Stop confirmations settle by providerThreadId BEFORE the aegis
        // mapping guard: a replacement runner may have rebuilt this aegis
        // thread on a new provider thread, in which case the old thread has
        // no mapping but the pending stop must still settle (P0-6). Session
        // deletion is deferred until after the turn_completed emit so the
        // adapter still finalizes the interrupted turn's partial output.
        const pendingSettle =
          status === 'completed' || status === 'interrupted' || status === 'failed'
            ? this.takePendingInterrupt(providerThreadId, this.readString(turn, 'id'))
            : null;

        const threadId = this.findThreadByProviderThreadId(providerThreadId);
        if (threadId && status !== 'inProgress') {
          const session = this.sessions.get(threadId);
          if (session) {
            session.status = 'ready';
            session.activeTurnId = undefined;
          }
          this.emit('turn_completed', {
            threadId,
            turnId: this.readString(turn, 'id'),
            status: status === 'failed' || status === 'interrupted' ? status : 'completed',
            error: status === 'failed' ? this.parseTurnError(this.asObject(turn?.error)) : undefined,
            params,
          });
        }

        if (pendingSettle) {
          this.finishPendingInterrupt(pendingSettle, true);
        }
        break;
      }

      case 'item/agentMessage/delta': {
        const text = this.readString(params, 'delta');
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId && text) {
          this.emit('text_delta', { threadId, text });
        }
        break;
      }

      // Reasoning stream channels — present in the protocol but typically empty
      // for current OpenAI reasoning models (o-series / gpt-5-codex hide the
      // chain-of-thought from clients). Wired up here so that when a model
      // does emit reasoning content (raw or summary), the UI gets it as a
      // separate channel without further code changes.
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const text = this.readString(params, 'delta');
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId && text) {
          const kind = method === 'item/reasoning/summaryTextDelta' ? 'summary' : 'raw';
          this.emit('reasoning_delta', { threadId, text, kind });
        }
        break;
      }
      case 'item/reasoning/summaryPartAdded':
        // Lifecycle marker only; no text payload to forward.
        break;

      case 'turn/plan/updated': {
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId) {
          this.emit('plan_updated', { threadId, params });
        }
        break;
      }

      case 'item/plan/delta': {
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId) {
          this.emit('plan_delta', { threadId, params });
        }
        break;
      }

      // Note: codex app-server delivers final agent_message text via
      // `item/completed` (handled below), and per-token chunks via
      // `item/agentMessage/delta`. This `item/agentMessage` notification is
      // a legacy shape we don't expect in current versions; ignore it to
      // avoid double-emission that would corrupt the streaming accumulator.
      case 'item/agentMessage':
        break;

      case 'item/toolCall': {
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId) {
          this.emit('tool_call', { threadId, params });
        }
        break;
      }

      case 'item/toolResult': {
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId) {
          this.emit('tool_result', { threadId, params });
        }
        break;
      }

      case 'thread/started': {
        const threadObj = params.thread as Record<string, unknown> | undefined;
        const providerThreadId = this.readString(params, 'threadId') || this.readString(threadObj, 'id');
        const threadId = this.findThreadByProviderThreadId(providerThreadId);
        const model = this.readString(threadObj, 'model') || this.readString(params, 'model');
        if (threadId) {
          this.emit('thread_started', { threadId, model, params });
        }
        break;
      }

      case 'thread/status/changed': {
        const providerThreadId = this.readString(params, 'threadId');
        const threadId = this.findThreadByProviderThreadId(providerThreadId);
        const status = this.readString(params, 'status');
        if (threadId && status) {
          const session = this.sessions.get(threadId);
          if (session) {
            if (status === 'running') session.status = 'running';
            else if (status === 'ready') session.status = 'ready';
          }
          this.emit('thread_status_changed', { threadId, status });
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        const providerThreadId = this.readString(params, 'threadId');
        const threadId = this.findThreadByProviderThreadId(providerThreadId);
        const tokenUsage = this.readObject(params, 'tokenUsage');
        // `total` accumulates the whole thread (cache re-reads included) and
        // quickly exceeds the window; `last` is the current context occupancy,
        // which is what the ring/banner and compaction preTokens need.
        const current =
          this.readObject(tokenUsage, 'last') ?? this.readObject(tokenUsage, 'total');
        const contextWindow = this.readNumber(tokenUsage, 'modelContextWindow') || 0;
        if (threadId && current && contextWindow > 0) {
          this.emit('token_usage_updated', {
            threadId,
            usage: {
              inputTokens: this.readNumber(current, 'inputTokens') || 0,
              cachedInputTokens: this.readNumber(current, 'cachedInputTokens') || 0,
              outputTokens: this.readNumber(current, 'outputTokens') || 0,
              reasoningOutputTokens: this.readNumber(current, 'reasoningOutputTokens') || 0,
              totalTokens: this.readNumber(current, 'totalTokens') || 0,
              contextWindow,
            },
          });
        }
        break;
      }

      // Deprecated in favor of the `contextCompaction` item type, but still
      // emitted by current codex builds; emitContextCompacted dedupes the pair.
      case 'thread/compacted': {
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId) {
          this.emitContextCompacted(threadId);
        }
        break;
      }

      case 'account/rateLimits/updated': {
        this.emit('rate_limits_updated', this.parseRateLimitReport(params));
        break;
      }

      case 'item/started': {
        const item = (params.item as Record<string, unknown>) || params;
        const itemType = this.normalizeItemType(item);
        const providerThreadId = this.readString(params, 'threadId');
        const threadId = this.findThreadByProviderThreadId(providerThreadId);
        if (!threadId) break;
        this.registerDescendantsFromItem(threadId, item);

        switch (itemType) {
          case 'agentMessage': {
            const text = this.extractTextContent(item);
            if (text) {
              this.emit('text_delta', { threadId, text });
            }
            break;
          }
          case 'toolCall': {
            this.emit('tool_call', { threadId, params: item });
            break;
          }
          case 'toolResult': {
            this.emit('tool_result', { threadId, params: item });
            break;
          }
        }
        break;
      }

      case 'item/completed': {
        const providerThreadId = this.readString(params, 'threadId');
        const threadId = this.findThreadByProviderThreadId(providerThreadId);
        if (!threadId) break;

        const item = (params.item as Record<string, unknown>) || params;
        this.registerDescendantsFromItem(threadId, item);
        const itemType = this.normalizeItemType(item);
        switch (itemType) {
          case 'agentMessage': {
            const text = this.extractTextContent(item);
            this.emit('agent_message_done', { threadId, text: text ?? '' });
            break;
          }
          case 'toolCall': {
            this.emit('tool_call', { threadId, params: item });
            this.emit('tool_result', { threadId, params: item });
            break;
          }
          case 'toolResult': {
            this.emit('tool_result', { threadId, params: item });
            break;
          }
          case 'plan': {
            const text = this.extractTextContent(item);
            const itemId = this.readString(item, 'id');
            const turnId = this.readString(params, 'turnId') || this.readString(item, 'turnId');
            this.emit('plan_item_completed', { threadId, text: text ?? '', itemId, turnId, params });
            break;
          }
          case 'contextCompaction': {
            this.emitContextCompacted(threadId);
            break;
          }
        }

        this.emit('item_completed', { threadId, params });
        break;
      }

      case 'error': {
        const message = this.readString(this.readObject(params, 'error'), 'message');
        const willRetry = params.willRetry === true;
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId && message) {
          if (isTransientConnectionMessage(message)) {
            this.emit('connection_reconnecting', { threadId, message });
            break;
          }
          const session = this.sessions.get(threadId);
          // willRetry means codex is retrying the same turn itself — the
          // session must stay `running` (flipping to error would break the
          // steer gate and fork the retried turn on the next send).
          if (session && !willRetry) {
            session.status = 'error';
            session.lastError = message;
          }
          this.emit('error_notification', {
            threadId,
            message,
            willRetry,
            turnId: this.readString(params, 'turnId'),
          });
        }
        break;
      }

      case 'skills/changed': {
        this.invalidateDiscoveryCaches('skills');
        this.emit('skills_changed', { params });
        break;
      }

      case 'app/list/updated': {
        this.invalidateDiscoveryCaches('plugins');
        this.emit('app_list_updated', { params });
        break;
      }

      case 'mcpServer/startupStatus/updated': {
        const servers = this.parseMcpStartupStatus(params);
        if (isDev()) {
          console.log(
            '[Codex AppServer] mcp status updated',
            'raw=', JSON.stringify(params),
            'decoded=', JSON.stringify(servers)
          );
        }
        if (servers.length === 0) break;
        // Per-thread routing: exact match → descendant map → drop.
        // threadId === null means process-scoped → broadcast (threadId: null).
        const providerThreadId = this.readString(params, 'threadId');
        if (providerThreadId) {
          const threadId = this.resolveOwnerThreadId(providerThreadId);
          if (!threadId) {
            if (isDev()) {
              console.log('[Codex AppServer] dropping MCP status for unknown thread', providerThreadId);
            }
            break;
          }
          this.emit('mcp_status_updated', { servers, threadId });
        } else {
          this.emit('mcp_status_updated', { servers, threadId: null });
        }
        break;
      }

      case 'serverRequest/resolved': {
        // The server resolved one of its own requests (autoResolution timeout,
        // another client, etc.) — drop the matching pending approval card.
        const resolvedId = params.requestId;
        if (typeof resolvedId === 'number' || typeof resolvedId === 'string') {
          for (const [requestId, approval] of this.pendingApprovals) {
            if (String(approval.jsonRpcId) === String(resolvedId)) {
              this.pendingApprovals.delete(requestId);
              this.emit('approval_dismissed', { requestId, threadId: approval.threadId });
              break;
            }
          }
        }
        break;
      }

      default:
        if (IGNORED_NOTIFICATIONS.has(method)) break;
        if (isDev()) {
          console.log('[Codex AppServer] unhandled notification', method);
        }
    }
  }

  private emitContextCompacted(threadId: string): void {
    const now = Date.now();
    const last = this.lastCompactionEmitAt.get(threadId) || 0;
    if (now - last < CodexAppServerManager.COMPACTION_DEDUPE_MS) {
      return;
    }
    this.lastCompactionEmitAt.set(threadId, now);
    this.emit('context_compacted', { threadId });
  }

  /**
   * Decode the `mcpServer/startupStatus/updated` notification params.
   * 0.144.3 sends a FLAT SINGLE OBJECT (generated schema):
   *   { threadId: string | null, name, status: "starting"|"ready"|"failed"|"cancelled",
   *     error: string | null, failureReason: "reauthenticationRequired" | null }
   * The array shapes are kept as a fallback for older binaries.
   */
  private parseMcpStartupStatus(params: Record<string, unknown>): McpServerStatus[] {
    // Flat single-object shape (0.144.3): top-level string `name` is the marker.
    const flatName = this.readString(params, 'name');
    if (flatName) {
      const entry = this.parseMcpStatusEntry(params, flatName);
      return entry ? [entry] : [];
    }

    const candidates: unknown[] =
      this.readArray(params, 'servers') ??
      this.readArray(params, 'mcpServers') ??
      this.readArray(params, 'mcp_servers') ??
      (Array.isArray(params) ? params : []);

    const result: McpServerStatus[] = [];
    for (const entry of candidates) {
      const obj = this.asObject(entry);
      if (!obj) continue;
      const name =
        this.readString(obj, 'name') ??
        this.readString(obj, 'serverName') ??
        this.readString(obj, 'id');
      if (!name) continue;
      const parsed = this.parseMcpStatusEntry(obj, name);
      if (parsed) result.push(parsed);
    }
    return result;
  }

  private parseMcpStatusEntry(
    obj: Record<string, unknown>,
    name: string
  ): McpServerStatus | null {
    const rawStatus = (
      this.readString(obj, 'status') ??
      this.readString(obj, 'state') ??
      ''
    ).toLowerCase();
    const status: McpServerStatus['status'] =
      rawStatus === 'connected' ||
      rawStatus === 'ready' ||
      rawStatus === 'running' ||
      rawStatus === 'started' ||
      rawStatus === 'ok'
        ? 'connected'
        : rawStatus === 'failed' ||
            rawStatus === 'error' ||
            rawStatus === 'crashed' ||
            rawStatus === 'cancelled'
          ? 'failed'
          : 'pending';
    const errorStr = this.readString(obj, 'error');
    const errorObj = this.asObject(obj.error);
    const error = errorStr ?? this.readString(errorObj, 'message') ?? undefined;
    const failureReason = this.readString(obj, 'failureReason');
    return {
      name,
      status,
      ...(error ? { error } : {}),
      ...(failureReason === 'reauthenticationRequired'
        ? { failureReason: 'reauthenticationRequired' as const }
        : {}),
    };
  }

  /** Extract a displayable message from a protocol TurnError. */
  private parseTurnError(error: Record<string, unknown> | undefined): string {
    const message = this.readString(error, 'message');
    const details = this.readString(error, 'additionalDetails');
    if (message && details) return `${message} (${details})`;
    return message || details || 'Codex turn failed';
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async ensureSpawned(cwd: string): Promise<void> {
    if (this.initialized) return;
    if (!this.spawnPromise) {
      this.spawnPromise = this.doSpawn(cwd).finally(() => {
        this.spawnPromise = null;
      });
    }
    return this.spawnPromise;
  }

  /**
   * Exact-match routing only (P0-7): an event without a resolvable
   * providerThreadId is dropped by the caller, never attributed to the
   * most-recent/first session.
   */
  private findThreadByProviderThreadId(providerThreadId: string | null): string | null {
    if (!providerThreadId) {
      return null;
    }
    for (const [threadId, session] of this.sessions) {
      if (session.providerThreadId === providerThreadId) {
        return threadId;
      }
    }
    return null;
  }

  /** Exact match, then the sub-agent descendant map (P0-7). */
  private resolveOwnerThreadId(providerThreadId: string | null): string | null {
    if (!providerThreadId) return null;
    return (
      this.findThreadByProviderThreadId(providerThreadId) ||
      this.descendantThreadMap.get(providerThreadId) ||
      null
    );
  }

  /**
   * Register sub-agent provider threads spawned by this session's items so
   * their approvals/notifications route to the root session
   * (collabAgentToolCall.receiverThreadIds / subAgentActivity.agentThreadId).
   */
  private registerDescendantsFromItem(
    rootThreadId: string,
    item: Record<string, unknown> | undefined
  ): void {
    if (!item) return;
    const collab = this.asObject(item.collabAgentToolCall) ?? this.asObject(item);
    const receivers = this.readArray(collab, 'receiverThreadIds');
    if (receivers) {
      for (const receiver of receivers) {
        if (typeof receiver === 'string' && receiver) {
          this.descendantThreadMap.set(receiver, rootThreadId);
        }
      }
    }
    const subAgent = this.asObject(item.subAgentActivity);
    const agentThreadId =
      this.readString(subAgent, 'agentThreadId') ?? this.readString(item, 'agentThreadId');
    if (agentThreadId) {
      this.descendantThreadMap.set(agentThreadId, rootThreadId);
    }
  }

  // Non-routing internal use only (stop-time cursor reset); never used to
  // attribute events, approvals, or notifications to a session.
  private findMostRecentFallbackThreadId(): string | null {
    if (this.lastActiveThreadId && this.sessions.has(this.lastActiveThreadId)) {
      return this.lastActiveThreadId;
    }

    for (const [threadId, session] of Array.from(this.sessions.entries()).reverse()) {
      if (session.status === 'running') {
        return threadId;
      }
    }

    return Array.from(this.sessions.keys()).pop() || null;
  }

  private readObject(
    obj: Record<string, unknown> | undefined,
    key: string
  ): Record<string, unknown> | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const value = obj[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private readString(
    obj: Record<string, unknown> | undefined,
    key: string
  ): string | null {
    if (!obj || typeof obj !== 'object') return null;
    const value = obj[key];
    return typeof value === 'string' ? value : null;
  }

  private readNumber(
    obj: Record<string, unknown> | undefined,
    key: string
  ): number | null {
    if (!obj || typeof obj !== 'object') return null;
    const value = obj[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private asObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private readArray(
    obj: Record<string, unknown> | undefined,
    key: string
  ): unknown[] | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const value = obj[key];
    return Array.isArray(value) ? value : undefined;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  private parseRateLimitReport(response: unknown): CodexRateLimitReport {
    const record = this.asObject(response);
    const result = this.asObject(record?.result) ?? record;
    const rateLimits = this.parseRateLimitSnapshot(this.asObject(result?.rateLimits));
    const rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> = {};
    const rawByLimitId = this.asObject(result?.rateLimitsByLimitId);

    if (rawByLimitId) {
      for (const [limitId, rawSnapshot] of Object.entries(rawByLimitId)) {
        const snapshot = this.parseRateLimitSnapshot(this.asObject(rawSnapshot));
        if (snapshot) {
          rateLimitsByLimitId[limitId] = snapshot;
        }
      }
    }

    return {
      source: 'codex-app-server',
      fetchedAt: Date.now(),
      rateLimits,
      rateLimitsByLimitId,
    };
  }

  private parseRateLimitSnapshot(
    value: Record<string, unknown> | undefined
  ): CodexRateLimitSnapshot | null {
    if (!value) return null;

    return {
      limitId: this.readString(value, 'limitId'),
      limitName: this.readString(value, 'limitName'),
      primary: this.parseRateLimitWindow(this.asObject(value.primary)),
      secondary: this.parseRateLimitWindow(this.asObject(value.secondary)),
      credits: this.parseCreditsSnapshot(this.asObject(value.credits)),
      planType: this.readString(value, 'planType'),
      rateLimitReachedType: this.parseRateLimitReachedType(this.readString(value, 'rateLimitReachedType')),
    };
  }

  private parseRateLimitWindow(value: Record<string, unknown> | undefined): CodexRateLimitWindow | null {
    if (!value) return null;

    const usedPercent = Math.min(100, Math.max(0, this.readNumber(value, 'usedPercent') || 0));
    return {
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      windowDurationMins: this.readNumber(value, 'windowDurationMins'),
      resetsAt: this.readNumber(value, 'resetsAt'),
    };
  }

  private parseCreditsSnapshot(value: Record<string, unknown> | undefined): CodexCreditsSnapshot | null {
    if (!value) return null;

    return {
      hasCredits: value.hasCredits === true,
      unlimited: value.unlimited === true,
      balance: this.readString(value, 'balance'),
    };
  }

  private parseRateLimitReachedType(value: string | null): CodexRateLimitSnapshot['rateLimitReachedType'] {
    switch (value) {
      case 'rate_limit_reached':
      case 'workspace_owner_credits_depleted':
      case 'workspace_member_credits_depleted':
      case 'workspace_owner_usage_limit_reached':
      case 'workspace_member_usage_limit_reached':
        return value;
      default:
        return null;
    }
  }

  private parseSkillsListResponse(response: unknown, requestedCwd: string): ProviderSkillDescriptor[] {
    const record = this.asObject(response);
    const result = this.asObject(record?.result) ?? record;
    if (!result) return [];

    const entries = this.readArray(result, 'data');
    if (entries) {
      const skills = entries.flatMap((entry) => {
        const entryRecord = this.asObject(entry);
        if (!entryRecord) return [];
        const entryCwd = this.optionalString(entryRecord.cwd);
        if (entryCwd && requestedCwd && entryCwd !== requestedCwd) {
          return [];
        }
        return (this.readArray(entryRecord, 'skills') ?? []).flatMap((skill) => {
          const parsed = this.parseSkillDescriptor(skill);
          return parsed ? [parsed] : [];
        });
      });
      return skills.sort((a, b) => a.name.localeCompare(b.name));
    }

    const skills = (this.readArray(result, 'skills') ?? []).flatMap((skill) => {
      const parsed = this.parseSkillDescriptor(skill);
      return parsed ? [parsed] : [];
    });
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  private parseSkillDescriptor(value: unknown): ProviderSkillDescriptor | undefined {
    const record = this.asObject(value);
    if (!record) return undefined;
    const name = this.optionalString(record.name);
    if (!name) return undefined;

    const skillInterface = this.parseSkillInterface(this.asObject(record.interface));
    const description =
      this.optionalString(record.description) ??
      this.optionalString(record.shortDescription) ??
      skillInterface?.shortDescription;
    const path = this.optionalString(record.path) ?? name;
    const scope = this.optionalString(record.scope);

    return {
      name,
      ...(description ? { description } : {}),
      path,
      enabled: record.enabled !== false,
      ...(scope ? { scope } : {}),
      ...(skillInterface ? { interface: skillInterface } : {}),
      ...(record.dependencies !== undefined ? { dependencies: record.dependencies } : {}),
    };
  }

  private parseSkillInterface(value: Record<string, unknown> | undefined): ProviderSkillDescriptor['interface'] | undefined {
    if (!value) return undefined;
    const displayName = this.optionalString(value.displayName);
    const shortDescription = this.optionalString(value.shortDescription);
    const iconSmall = this.optionalString(value.iconSmall);
    const iconLarge = this.optionalString(value.iconLarge);
    const brandColor = this.optionalString(value.brandColor);
    const defaultPrompt = this.optionalString(value.defaultPrompt);
    if (!displayName && !shortDescription && !iconSmall && !iconLarge) return undefined;
    return {
      ...(displayName ? { displayName } : {}),
      ...(shortDescription ? { shortDescription } : {}),
      ...(iconSmall ? { iconSmall } : {}),
      ...(iconLarge ? { iconLarge } : {}),
      ...(brandColor ? { brandColor } : {}),
      ...(defaultPrompt ? { defaultPrompt } : {}),
    };
  }

  private parsePluginListResponse(
    response: unknown
  ): Omit<ProviderListPluginsResult, 'source' | 'cached'> {
    const record = this.asObject(response);
    const result = this.asObject(record?.result) ?? record;
    if (!result) {
      return {
        marketplaces: [],
        marketplaceLoadErrors: [],
        remoteSyncError: null,
        featuredPluginIds: [],
      };
    }

    const marketplaces = (this.readArray(result, 'marketplaces') ?? []).flatMap((marketplace) => {
      const marketplaceRecord = this.asObject(marketplace);
      if (!marketplaceRecord) return [];
      const name = this.optionalString(marketplaceRecord.name);
      if (!name) return [];
      const path = this.optionalString(marketplaceRecord.path) ?? null;
      const marketplaceInterfaceRecord = this.asObject(marketplaceRecord.interface);
      const marketplaceDisplayName = this.optionalString(marketplaceInterfaceRecord?.displayName);
      const plugins = (this.readArray(marketplaceRecord, 'plugins') ?? []).flatMap((plugin) => {
        const parsed = this.parsePluginSummary(plugin);
        return parsed ? [parsed] : [];
      });

      return [{
        name,
        path,
        ...(marketplaceDisplayName
          ? { interface: { displayName: marketplaceDisplayName } }
          : {}),
        plugins,
      }];
    });

    const marketplaceLoadErrors = (this.readArray(result, 'marketplaceLoadErrors') ?? [])
      .flatMap((error) => {
        const errorRecord = this.asObject(error);
        const marketplacePath = this.optionalString(errorRecord?.marketplacePath);
        const message = this.optionalString(errorRecord?.message);
        return marketplacePath && message ? [{ marketplacePath, message }] : [];
      });
    const featuredPluginIds = (this.readArray(result, 'featuredPluginIds') ?? [])
      .flatMap((value) => {
        const id = this.optionalString(value);
        return id ? [id] : [];
      });
    const remoteSyncError = this.optionalString(result.remoteSyncError) ?? null;

    return {
      marketplaces,
      marketplaceLoadErrors,
      remoteSyncError,
      featuredPluginIds,
    };
  }

  private parsePluginSummary(value: unknown): ProviderPluginDescriptor | undefined {
    const record = this.asObject(value);
    if (!record) return undefined;
    const id = this.optionalString(record.id);
    const name = this.optionalString(record.name);
    const installPolicy = this.optionalString(record.installPolicy);
    const authPolicy = this.optionalString(record.authPolicy);
    if (
      !id ||
      !name ||
      (installPolicy !== 'NOT_AVAILABLE' &&
        installPolicy !== 'AVAILABLE' &&
        installPolicy !== 'INSTALLED_BY_DEFAULT') ||
      (authPolicy !== 'ON_INSTALL' && authPolicy !== 'ON_USE')
    ) {
      return undefined;
    }

    return {
      id,
      name,
      remotePluginId: this.optionalString(record.remotePluginId) ?? null,
      version: this.optionalString(record.version) ?? null,
      source: this.parsePluginSource(record.source),
      installed: record.installed === true,
      enabled: record.enabled === true,
      installPolicy,
      authPolicy,
      ...(this.parsePluginInterface(this.asObject(record.interface))
        ? { interface: this.parsePluginInterface(this.asObject(record.interface)) }
        : {}),
    };
  }

  private parsePluginSource(value: unknown): ProviderPluginSource {
    const record = this.asObject(value);
    const type = this.optionalString(record?.type);
    if (type === 'local') {
      return { type: 'local', path: this.optionalString(record?.path) ?? '' };
    }
    if (type === 'git') {
      return {
        type: 'git',
        url: this.optionalString(record?.url) ?? '',
        path: this.optionalString(record?.path) ?? null,
        refName: this.optionalString(record?.refName) ?? null,
        sha: this.optionalString(record?.sha) ?? null,
      };
    }
    return { type: 'remote' };
  }

  private parsePluginInterface(value: Record<string, unknown> | undefined): ProviderPluginInterface | undefined {
    if (!value) return undefined;
    const stringArray = (key: string): string[] | undefined => {
      const items = (this.readArray(value, key) ?? []).flatMap((entry) => {
        const text = this.optionalString(entry);
        return text ? [text] : [];
      });
      return items.length > 0 ? items : undefined;
    };

    const pluginInterface: ProviderPluginInterface = {
      ...(this.optionalString(value.displayName) ? { displayName: this.optionalString(value.displayName) } : {}),
      ...(this.optionalString(value.shortDescription) ? { shortDescription: this.optionalString(value.shortDescription) } : {}),
      ...(this.optionalString(value.longDescription) ? { longDescription: this.optionalString(value.longDescription) } : {}),
      ...(this.optionalString(value.developerName) ? { developerName: this.optionalString(value.developerName) } : {}),
      ...(this.optionalString(value.category) ? { category: this.optionalString(value.category) } : {}),
      ...(stringArray('capabilities') ? { capabilities: stringArray('capabilities') } : {}),
      ...(this.optionalString(value.websiteUrl) ? { websiteUrl: this.optionalString(value.websiteUrl) } : {}),
      ...(this.optionalString(value.privacyPolicyUrl) ? { privacyPolicyUrl: this.optionalString(value.privacyPolicyUrl) } : {}),
      ...(this.optionalString(value.termsOfServiceUrl) ? { termsOfServiceUrl: this.optionalString(value.termsOfServiceUrl) } : {}),
      ...(stringArray('defaultPrompt') ? { defaultPrompt: stringArray('defaultPrompt') } : {}),
      ...(this.optionalString(value.brandColor) ? { brandColor: this.optionalString(value.brandColor) } : {}),
      ...(this.optionalString(value.composerIcon) ? { composerIcon: this.optionalString(value.composerIcon) } : {}),
      ...(this.optionalString(value.composerIconUrl) ? { composerIconUrl: this.optionalString(value.composerIconUrl) } : {}),
      ...(this.optionalString(value.logo) ? { logo: this.optionalString(value.logo) } : {}),
      ...(this.optionalString(value.logoUrl) ? { logoUrl: this.optionalString(value.logoUrl) } : {}),
      ...(stringArray('screenshots') ? { screenshots: stringArray('screenshots') } : {}),
      ...(stringArray('screenshotUrls') ? { screenshotUrls: stringArray('screenshotUrls') } : {}),
    };

    return Object.keys(pluginInterface).length > 0 ? pluginInterface : undefined;
  }

  private parsePluginReadResponse(response: unknown): ProviderPluginDetail {
    const record = this.asObject(response);
    const result = this.asObject(record?.result) ?? record;
    const pluginRecord = this.asObject(result?.plugin) ?? result;
    if (!pluginRecord) {
      throw new Error('plugin/read response did not include a plugin payload.');
    }

    const marketplaceName = this.optionalString(pluginRecord.marketplaceName);
    const marketplacePath = this.optionalString(pluginRecord.marketplacePath) ?? null;
    const summary = this.parsePluginSummary(pluginRecord.summary);
    if (!marketplaceName || !summary) {
      throw new Error('plugin/read response did not include a valid plugin summary.');
    }

    return {
      marketplaceName,
      marketplacePath,
      summary,
      ...(this.optionalString(pluginRecord.description)
        ? { description: this.optionalString(pluginRecord.description) }
        : {}),
      skills: (this.readArray(pluginRecord, 'skills') ?? []).flatMap((skill) => {
        const parsed = this.parseSkillDescriptor(skill);
        return parsed ? [parsed] : [];
      }),
      apps: (this.readArray(pluginRecord, 'apps') ?? []).flatMap((app) => {
        const parsed = this.parsePluginAppSummary(app);
        return parsed ? [parsed] : [];
      }),
      mcpServers: (this.readArray(pluginRecord, 'mcpServers') ?? []).flatMap((server) => {
        const name = this.optionalString(server);
        return name ? [name] : [];
      }),
    };
  }

  private parsePluginAppSummary(value: unknown): ProviderPluginAppSummary | undefined {
    const record = this.asObject(value);
    if (!record) return undefined;
    const id = this.optionalString(record.id);
    const name = this.optionalString(record.name);
    if (!id || !name) return undefined;
    return {
      id,
      name,
      ...(this.optionalString(record.description)
        ? { description: this.optionalString(record.description) }
        : {}),
      ...(this.optionalString(record.installUrl)
        ? { installUrl: this.optionalString(record.installUrl) }
        : {}),
      needsAuth: record.needsAuth === true,
    };
  }

  private extractTextContent(params: Record<string, unknown>): string | null {
    if (typeof params.text === 'string') return params.text;
    const content = params.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c): c is { type?: string; text?: string } =>
          typeof c === 'object' && c !== null && 'text' in c
        )
        .map((c) => c.text)
        .filter((t): t is string => typeof t === 'string')
        .join('');
    }
    return null;
  }

  private normalizeItemType(
    item: Record<string, unknown>
  ): 'agentMessage' | 'toolCall' | 'toolResult' | 'plan' | 'contextCompaction' | null {
    const raw =
      this.readString(item, 'type') ||
      this.readString(item, 'itemType') ||
      this.readString(item, 'kind') ||
      '';
    const normalized = raw.replace(/[_\-\s]/g, '').toLowerCase();

    if (
      normalized === 'agentmessage' ||
      normalized === 'assistantmessage' ||
      normalized === 'message'
    ) {
      return 'agentMessage';
    }

    if (normalized === 'plan') {
      return 'plan';
    }

    if (normalized === 'contextcompaction' || normalized === 'compaction') {
      return 'contextCompaction';
    }

    if (
      normalized === 'toolcall' ||
      normalized === 'tooluse' ||
      normalized === 'functioncall' ||
      normalized === 'commandexecution' ||
      normalized === 'fileread' ||
      normalized === 'filechange' ||
      normalized === 'filewrite' ||
      normalized === 'fileedit'
    ) {
      return 'toolCall';
    }

    if (
      normalized === 'toolresult' ||
      normalized === 'tooloutput' ||
      normalized === 'functioncalloutput' ||
      normalized === 'commandresult'
    ) {
      return 'toolResult';
    }

    if (
      this.readObject(item, 'toolCall') ||
      this.readObject(item, 'tool_call') ||
      this.readObject(item, 'functionCall') ||
      this.readObject(item, 'function')
    ) {
      return 'toolCall';
    }

    if (
      this.readString(item, 'name') ||
      this.readString(item, 'toolName') ||
      this.readObject(item, 'input') ||
      this.readObject(item, 'params') ||
      this.readObject(item, 'arguments')
    ) {
      return 'toolCall';
    }

    if (
      this.readString(item, 'toolUseId') ||
      this.readString(item, 'toolCallId') ||
      this.readString(item, 'callId')
    ) {
      return 'toolResult';
    }

    return null;
  }
}
