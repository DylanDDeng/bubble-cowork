import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type {
  Attachment,
  ClaudeModelUsage,
  ContentBlock,
  PermissionResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillDescriptor,
  QoderModelConfig,
  QoderModelOption,
  QoderPermissionMode,
  QoderPlanQuotaBucket,
  QoderPlanUsageReport,
  StreamMessage,
  Usage,
} from '../../../shared/types';
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
  findMachineQoderCli,
  loadQoderSdk,
  type QoderAssistantMessage,
  type QoderCanUseToolOptions,
  type QoderContentBlock,
  type QoderInitializationResult,
  type QoderModelInfo,
  type QoderModelUsage,
  type QoderPermissionDecision,
  type QoderPermissionUpdate,
  type QoderQuery,
  type QoderQueryOptions,
  type QoderResultMessage,
  type QoderSDKMessage,
  type QoderSDKUserMessage,
  type QoderSdkModule,
  type QoderSdkPermissionMode,
  type QoderStreamEventMessage,
  type QoderSystemInitMessage,
  type QoderSystemMessage,
  type QoderUsageInfo,
  type QoderUsageQuotaBucket,
  type QoderUserMessage,
} from './qoder-sdk-loader';

/**
 * QoderSdkAdapter — ProviderAdapter over `@qoder-ai/qoder-agent-sdk` (1.0.15).
 * Pure SDK wrap (pi-adapter structure): the SDK spawns qodercli itself, one
 * Query per thread fed by a never-returning queue-backed AsyncIterable
 * prompt (for the SDK a returning prompt iterator is stdin EOF = session
 * death, P9). Behavior verified live in docs/qoder-sdk-adapter-plan.md's
 * appendix (P1–P12); the load-bearing facts:
 *
 * - streamInput-mode interrupt() settles in ~140ms with
 *   result(error_during_execution, "Operation aborted") (P9b) → the stopped
 *   result, never a failure.
 * - setModel / a queued mid-turn injection is followed by a duplicate
 *   system.init (re-init, same session id, P9c/P10) → refresh caches only.
 * - Token usage fields are 0 on every message type; only
 *   usage.context_usage_ratio carries data (P12) → no token_usage messages.
 * - canUseTool fires only for classifier-blocked commands (P6c); benign
 *   commands are auto-approved without a callback (P6).
 */

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: true, // warm setModel between turns verified (P10)
  skillDiscovery: true, // initializationResult() skills catalog (see listSkills)
  pluginDiscovery: false,
  mcpServers: true,
  imageAttachments: true,
  forkThread: true,
  compactThread: false,
  planMode: true, // start-time options.permissionMode only (P11: runtime 'plan' is broken)
};

/** P9b: ~140ms typical in streamInput mode; 2s is the safety bound. */
const STOP_SETTLE_TIMEOUT_MS = 2_000;
const INIT_TIMEOUT_MS = 30_000;

/** Plan-usage cache TTL — same cadence as the Claude/Grok plan probes. */
const PLAN_USAGE_TTL_MS = 45_000;
const PLAN_USAGE_TIMEOUT_MS = 20_000;

/**
 * Skill catalog cache TTL. Listing without a live session spawns a
 * throwaway qodercli (~7s), so this is deliberately longer than kimi's 30s.
 */
const SKILLS_CACHE_TTL_MS =
  Number(process.env.AEGIS_QODER_SKILLS_CACHE_MS) > 0
    ? Number(process.env.AEGIS_QODER_SKILLS_CACHE_MS)
    : 5 * 60_000;

/** A qoder session id is already bound to another live Aegis thread. */
export class QoderThreadBindingError extends Error {
  constructor(qoderSessionId: string, boundThreadId: string) {
    super(
      `Qoder session "${qoderSessionId}" is already bound to thread "${boundThreadId}". ` +
        'A qoder session can only drive one Aegis thread at a time.'
    );
    this.name = 'QoderThreadBindingError';
  }
}

/**
 * Auth failure (startup `auth_required` / CLI exit 41, or mid-session
 * `onAuthExpired`) — the recognizable login_required error class. The
 * runtime-directory probe renders the "Run `qodercli login`" state from it.
 */
export class QoderLoginRequiredError extends Error {
  constructor(detail?: string) {
    super(
      detail
        ? `Qoder login required (${detail}). Run \`qodercli login\` and try again.`
        : 'Qoder login required. Run `qodercli login` and try again.'
    );
    this.name = 'QoderLoginRequiredError';
  }
}

type ActiveTurn = {
  seq: number;
  startedAtMs: number;
  /** Turn-terminal invariant: exactly one result per dispatched turn. */
  resultEmitted: boolean;
  settle: () => void;
  settlePromise: Promise<void>;
};

type PendingPermission = {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: QoderPermissionUpdate[];
  resolve: (decision: QoderPermissionDecision) => void;
};

type ActiveQoderSession = {
  threadId: string;
  providerSessionId: string | null;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  query: QoderQuery;
  promptQueue: QoderPromptQueue;
  /** stopSession ran (or the iterator died) — the session is terminal. */
  closed: boolean;
  initSeen: boolean;
  initResolve: (sessionId: string) => void;
  initReject: (error: Error) => void;
  initPromise: Promise<string>;
  turn: ActiveTurn | null;
  turnSeq: number;
  pendingPermissions: Map<string, PendingPermission>;
};

/**
 * Queue-backed AsyncIterable prompt. It NEVER returns on its own — for the
 * SDK a returning prompt iterator is stdin EOF = CLI exit = session death
 * (P9). It only ends when close() runs (the q.close() teardown path).
 */
class QoderPromptQueue implements AsyncIterable<QoderSDKUserMessage> {
  private queued: QoderSDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<QoderSDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: QoderSDKUserMessage): void {
    if (this.closed) {
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: message, done: false });
      return;
    }
    this.queued.push(message);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: undefined as unknown as QoderSDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<QoderSDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<QoderSDKUserMessage>> => {
        const value = this.queued.shift();
        if (value) {
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as QoderSDKUserMessage, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  const text = typeof error === 'string' ? error.trim() : '';
  return new Error(text || fallback);
}

function buildPromptText(prompt: string, attachments: Attachment[] | undefined): string {
  const lines = prompt ? [prompt] : [];
  const fileAttachments = attachments?.filter((attachment) => attachment.kind !== 'image') || [];
  if (fileAttachments.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Attachments:');
    for (const attachment of fileAttachments) {
      lines.push(`- ${attachment.name}: ${attachment.path}`);
    }
  }
  return lines.join('\n');
}

async function buildPromptImages(attachments: Attachment[] | undefined): Promise<QoderContentBlock[]> {
  const images: QoderContentBlock[] = [];
  const imageAttachments = attachments?.filter((attachment) => attachment.kind === 'image') || [];
  for (const attachment of imageAttachments) {
    const buffer = await readFile(attachment.path);
    // Anthropic-shaped base64 image block — understood by the VL catalog (P8).
    images.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mimeType || 'image/png',
        data: buffer.toString('base64'),
      },
    });
  }
  return images;
}

function mapAssistantContentBlocks(content: string | QoderContentBlock[] | undefined): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (typeof content === 'string') {
    if (content.trim()) {
      blocks.push({ type: 'text', text: content });
    }
    return blocks;
  }
  if (!Array.isArray(content)) {
    return blocks;
  }
  for (const block of content) {
    if (block.type === 'text' && getString(block.text)) {
      blocks.push({ type: 'text', text: getString(block.text) });
    } else if (block.type === 'thinking' && getString(block.thinking)) {
      blocks.push({
        type: 'thinking',
        thinking: getString(block.thinking),
        ...(getString(block.signature) ? { signature: getString(block.signature) } : {}),
      });
    } else if (block.type === 'tool_use' && getString(block.id) && getString(block.name)) {
      blocks.push({
        type: 'tool_use',
        id: getString(block.id),
        name: getString(block.name),
        input: isRecord(block.input) ? block.input : {},
      });
    }
  }
  return blocks;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => (isRecord(block) && block.type === 'text' ? getString(block.text) : ''))
      .filter(Boolean)
      .join('\n');
    if (text) {
      return text;
    }
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** tool_result user messages pass through; prompt echoes/replays do not. */
function mapToolResultBlocks(content: string | QoderContentBlock[] | undefined): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (!Array.isArray(content)) {
    return blocks;
  }
  for (const block of content) {
    if (block.type !== 'tool_result') {
      continue;
    }
    blocks.push({
      type: 'tool_result',
      tool_use_id: getString(block.tool_use_id),
      content: stringifyToolResultContent(block.content),
      ...(block.is_error === true ? { is_error: true } : {}),
    });
  }
  return blocks;
}

function extractText(content: string | QoderContentBlock[] | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block) => block.type === 'text')
    .map((block) => getString(block.text))
    .filter(Boolean)
    .join('\n');
}

function modelOptionFromQoder(info: QoderModelInfo): QoderModelOption {
  const availableContextWindows = Array.isArray(info.availableContextWindows)
    ? info.availableContextWindows.filter((w): w is number => typeof w === 'number' && w > 0)
    : undefined;
  const contextWindow =
    getNumber(info.defaultContextWindow) || availableContextWindows?.[0] || getNumber(info.maxInputTokens) || null;
  const efforts = Array.isArray(info.efforts)
    ? info.efforts.filter((effort): effort is string => typeof effort === 'string' && Boolean(effort))
    : undefined;
  return {
    value: info.value.trim(),
    displayName: getString(info.displayName).trim() || info.value.trim(),
    ...(getString(info.description).trim() ? { description: getString(info.description).trim() } : {}),
    ...(typeof info.isVl === 'boolean' ? { isVl: info.isVl } : {}),
    ...(typeof info.isEnabled === 'boolean' ? { isEnabled: info.isEnabled } : {}),
    ...(typeof info.isDefault === 'boolean' ? { isDefault: info.isDefault } : {}),
    contextWindow,
    ...(availableContextWindows?.length ? { availableContextWindows } : {}),
    ...(getNumber(info.maxInputTokens) ? { maxInputTokens: getNumber(info.maxInputTokens) } : {}),
    ...(getNumber(info.maxOutputTokens) ? { maxOutputTokens: getNumber(info.maxOutputTokens) } : {}),
    ...(efforts?.length ? { efforts } : {}),
    ...(getString(info.defaultEffort).trim() ? { defaultEffort: getString(info.defaultEffort).trim() } : {}),
    ...(getNumber(info.priceFactor) ? { priceFactor: getNumber(info.priceFactor) } : {}),
    ...(info.source ? { source: info.source } : {}),
  };
}

/**
 * initializationResult() skill entries are `{name, description, source}` —
 * no file path (the CLI resolves skills internally, ~/.agents/skills etc.),
 * so descriptors carry a virtual qoder:// path (kimi's builtin:// pattern).
 */
function parseQoderSkills(init: QoderInitializationResult | null | undefined): ProviderSkillDescriptor[] {
  const raw = Array.isArray(init?.skills) ? init.skills : [];
  return raw
    .map((entry): ProviderSkillDescriptor | null => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const name = getString(record.name).trim();
      if (!name) {
        return null;
      }
      return {
        name,
        description: getString(record.description) || undefined,
        path: `qoder://skill/${name}`,
        enabled: true,
        scope: getString(record.source) || undefined,
      };
    })
    .filter((skill): skill is ProviderSkillDescriptor => Boolean(skill));
}

function buildModelCatalog(
  init: QoderInitializationResult | null | undefined,
  currentModel?: string
): QoderModelConfig {
  const models = (init?.models || [])
    .filter((info) => info && getString(info.value).trim())
    .map(modelOptionFromQoder);
  const defaultModel = models.find((model) => model.isDefault)?.value || currentModel || null;
  return { defaultModel, options: models.map((model) => model.value), models };
}

function parsePlanQuotaBucket(bucket: QoderUsageQuotaBucket | undefined): QoderPlanQuotaBucket | null {
  if (!bucket || typeof bucket !== 'object') {
    return null;
  }
  const total = asFiniteNumber(bucket.total) ?? asFiniteNumber(bucket.cap);
  const used = asFiniteNumber(bucket.used);
  const remaining = asFiniteNumber(bucket.remaining);
  let percentage = clampPercent(asFiniteNumber(bucket.percentage));
  if (percentage === null && total !== null && total > 0 && used !== null) {
    percentage = clampPercent((used / total) * 100);
  }
  if (total === null && used === null && remaining === null && percentage === null) {
    return null;
  }
  const unit = typeof bucket.unit === 'string' && bucket.unit.trim() ? bucket.unit.trim() : null;
  return { total, used, remaining, percentage, unit };
}

function buildPlanUsageReport(info: QoderUsageInfo): QoderPlanUsageReport {
  const expires = asFiniteNumber(info.expiresAt);
  return {
    source: 'qoder-sdk',
    fetchedAt: Date.now(),
    userType: typeof info.userType === 'string' && info.userType.trim() ? info.userType.trim() : null,
    totalUsagePercentage: clampPercent(asFiniteNumber(info.totalUsagePercentage)),
    isHighestTier: Boolean(info.isHighestTier),
    isQuotaExceeded: Boolean(info.isQuotaExceeded),
    // Second-resolution epochs are normalized to ms (1e12 ms ≈ 2001-09).
    expiresAt: expires === null || expires <= 0 ? null : expires < 1e12 ? expires * 1000 : expires,
    upgradeUrl:
      typeof info.upgradeUrl === 'string' && info.upgradeUrl.trim() ? info.upgradeUrl.trim() : null,
    userQuota: parsePlanQuotaBucket(info.userQuota),
    addOnQuota: parsePlanQuotaBucket(info.addOnQuota),
    orgResourcePackage: parsePlanQuotaBucket(info.orgResourcePackage),
  };
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

export class QoderSdkAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'qoder';
  readonly displayName = 'Qoder';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActiveQoderSession>();
  /** qoder session id → owning threadId (one-owner guard, kimi pattern). */
  private sessionOwners = new Map<string, string>();
  private modelCatalog: QoderModelConfig | null = null;
  /** Process-wide: qoder skills are global (no cwd axis in the catalog). */
  private skillsCatalog: { skills: ProviderSkillDescriptor[]; fetchedAt: number } | null = null;
  /** Account plan-usage cache, served by the get-qoder-plan-usage IPC. */
  private planUsage: QoderPlanUsageReport | null = null;

  // ── Session lifecycle ──────────────────────────────────────────────────

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const cwd = input.cwd || process.cwd();
    const sdk = await loadQoderSdk();

    const resumeId = input.resumeSessionId?.trim() || undefined;
    if (resumeId) {
      this.assertSessionUnbound(resumeId, input.threadId);
    }

    const promptQueue = new QoderPromptQueue();
    const query = sdk.query({
      prompt: promptQueue,
      options: this.buildQueryOptions(sdk, input, cwd),
    });

    let initResolve!: (sessionId: string) => void;
    let initReject!: (error: Error) => void;
    const initPromise = new Promise<string>((resolve, reject) => {
      initResolve = resolve;
      initReject = reject;
    });

    const session: ActiveQoderSession = {
      threadId: input.threadId,
      providerSessionId: null,
      status: 'connecting',
      cwd,
      model: input.model?.trim() || undefined,
      query,
      promptQueue,
      closed: false,
      initSeen: false,
      initResolve,
      initReject,
      initPromise,
      turn: null,
      turnSeq: 0,
      pendingPermissions: new Map(),
    };
    // Never orphan a previous session for the same thread — an undisposed
    // predecessor would leak its qodercli child process.
    this.disposeSession(input.threadId);
    this.sessions.set(input.threadId, session);

    // The pump consumes the message stream for the Query's whole life; it
    // routes its own failures, so the floating promise never rejects.
    void this.pump(session);

    // Dispatch the first turn BEFORE awaiting init: the SDK initializes the
    // CLI lazily on the first user message — an idle AsyncIterable produces
    // no system.init at all (verified live), so awaiting init first would
    // deadlock.
    if (input.prompt || input.attachments?.length) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model,
        qoderPermissionMode: input.qoderPermissionMode,
      });
    }

    let sessionId: string;
    let initTimer: NodeJS.Timeout | undefined;
    try {
      sessionId = await Promise.race([
        initPromise,
        new Promise<never>((_resolve, reject) => {
          initTimer = setTimeout(
            () => reject(new Error('Qoder session initialization timed out.')),
            INIT_TIMEOUT_MS
          );
          initTimer.unref?.();
        }),
      ]);
    } catch (error) {
      // Startup failed (auth exit 41, spawn failure, protocol mismatch,
      // double-bind): no binding survives.
      session.closed = true;
      this.sessions.delete(input.threadId);
      promptQueue.close();
      try {
        await query.close();
      } catch {
        // Already dead.
      }
      throw this.mapTerminalError(toError(error, 'Qoder session failed to start.'));
    } finally {
      if (initTimer) {
        clearTimeout(initTimer);
      }
    }

    // Model catalog: pull once per session start (P7r) into the process-wide
    // cache the get-qoder-model-config IPC will serve.
    void this.refreshModelCatalog(session);

    return {
      threadId: input.threadId,
      provider: 'qoder',
      providerSessionId: sessionId,
      status: session.status,
      model: session.model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session || session.closed) {
      throw new Error(`No Qoder session found for thread "${input.threadId}"`);
    }

    session.status = 'running';
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    if (input.model?.trim() && input.model.trim() !== session.model) {
      await this.setModel(input.threadId, input.model);
    }

    const text = buildPromptText(input.prompt, input.attachments);
    const images = await buildPromptImages(input.attachments);
    if (!text.trim() && images.length === 0) {
      return;
    }

    const content: QoderContentBlock[] = [];
    if (text.trim()) {
      content.push({ type: 'text', text });
    }
    content.push(...images);

    session.turn = this.createTurn(session);
    session.promptQueue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
    // codex-style ack: the terminal result arrives on the pump. The queue is
    // ≤1 deep by construction — priority:'now' cannot steer (P9c), so qoder
    // is not in canSteerWhileRunning and the UI serializes sends.
  }

  /**
   * Pi-style single-phase stop; stopSession IS the binding-release point
   * (no stop_settled — streamInput interrupt settles fast enough, P9b).
   */
  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    session.closed = true;
    session.status = 'stopped';

    // 1. interrupt(); the turn settles with the abort result (~140ms, P9b).
    try {
      await session.query.interrupt();
    } catch {
      // The CLI may already be idle or dead.
    }

    // 2. Bounded wait for the in-flight turn's terminal result (translated as
    //    the stopped result) so the IPC FIFO stays aligned; synthesize on
    //    timeout.
    const turn = session.turn;
    if (turn && !turn.resultEmitted) {
      const settled = await this.waitForTurnSettle(turn, STOP_SETTLE_TIMEOUT_MS);
      if (!settled && !turn.resultEmitted) {
        this.emitTurnResult(session, 'stopped', {});
      }
    }

    // 3. A stopped CLI must never strand an approval card.
    this.dismissAllPermissions(session, 'Session stopped.');

    // 4. Close the transport, release the binding, report stopped.
    session.promptQueue.close();
    try {
      await session.query.close();
    } catch {
      // Already closed.
    }
    this.releaseSession(session);
    this.emit({ type: 'status_change', threadId, status: 'stopped' });
  }

  disposeSession(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session) {
      return false;
    }
    try {
      session.closed = true;
      // Neutralize the in-flight turn BEFORE closing: handleIteratorEnded
      // would otherwise synthesize a stale 'stopped' result when the pump
      // ends (reachable via the auth-expired error path, which terminates
      // with no result). Pair the flag with settle() like emitTurnResult
      // does, so a concurrent stopSession's waitForTurnSettle never strands.
      const turn = session.turn;
      if (turn && !turn.resultEmitted) {
        turn.resultEmitted = true;
        turn.settle();
      }
      // Emits per-requestId permission_dismissed — the one emission dispose
      // allows (clears stranded cards; cannot be misread by stop gates).
      this.dismissAllPermissions(session, 'Session was replaced.');
      session.promptQueue.close();
      void session.query.close().catch(() => {});
      this.releaseSession(session);
    } catch (error) {
      console.warn('[QoderSdkAdapter] disposeSession cleanup failed:', error);
    }
    return true;
  }

  async stopAll(): Promise<void> {
    const threadIds = Array.from(this.sessions.keys());
    await Promise.all(threadIds.map((threadId) => this.stopSession(threadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      threadId: session.threadId,
      provider: 'qoder',
      providerSessionId: session.providerSessionId || '',
      status: session.status,
      model: session.model,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  // ── Permissions ────────────────────────────────────────────────────────

  private handleCanUseTool(
    threadId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: QoderCanUseToolOptions
  ): Promise<QoderPermissionDecision> {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) {
      return Promise.resolve({ behavior: 'deny', message: 'Session is no longer active.' });
    }
    if (options.signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: 'Session stopped.' });
    }

    const requestId = options.toolUseID || uuidv4();
    return new Promise<QoderPermissionDecision>((resolve) => {
      session.pendingPermissions.set(requestId, {
        requestId,
        toolName,
        input,
        suggestions: options.suggestions,
        resolve,
      });

      // The SDK aborts the signal when the prompt dies — never strand an
      // approval card against a dead CLI.
      options.signal.addEventListener(
        'abort',
        () => {
          if (session.pendingPermissions.delete(requestId)) {
            this.emit({ type: 'permission_dismissed', threadId, requestId });
            resolve({ behavior: 'deny', message: 'Session stopped.' });
          }
        },
        { once: true }
      );

      this.emit({ type: 'permission_request', threadId, requestId, toolName, input });
    });
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: PermissionResult
  ): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`No Qoder session found for thread "${threadId}"`);
    }
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) {
      // Stale card (already dismissed by stop/close/abort) — race-safe no-op.
      return;
    }
    session.pendingPermissions.delete(requestId);

    if (decision.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
        // "Always allow this session" → hand the CLI's own suggestions back.
        ...(decision.scope === 'session' && pending.suggestions?.length
          ? { updatedPermissions: pending.suggestions }
          : {}),
      });
      return;
    }

    pending.resolve({
      behavior: 'deny',
      // The SDK requires a message on deny.
      message: decision.message?.trim() || 'Denied by user',
      ...(typeof (decision as { interrupt?: unknown }).interrupt === 'boolean'
        ? { interrupt: (decision as { interrupt?: boolean }).interrupt }
        : {}),
    });
  }

  private dismissAllPermissions(session: ActiveQoderSession, message: string): void {
    for (const [requestId, pending] of session.pendingPermissions) {
      this.emit({ type: 'permission_dismissed', threadId: session.threadId, requestId });
      pending.resolve({ behavior: 'deny', message });
    }
    session.pendingPermissions.clear();
  }

  // ── Model catalog & switching ──────────────────────────────────────────

  /** Process-wide catalog cache, served by the get-qoder-model-config IPC. */
  getModelCatalog(): QoderModelConfig | null {
    return this.modelCatalog;
  }

  /**
   * Warm model switch between turns (P10: session id stable; a re-init
   * follows, which the pump absorbs per the translation table). Mid-turn
   * setModel is untested — callers must only invoke between turns.
   */
  async setModel(threadId: string, model: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) {
      throw new Error(`No Qoder session found for thread "${threadId}"`);
    }
    const normalized = model.trim();
    if (!normalized) {
      return;
    }
    await session.query.setModel(normalized);
    session.model = normalized;
  }

  private async refreshModelCatalog(session: ActiveQoderSession): Promise<void> {
    try {
      const init = await session.query.initializationResult();
      // Session starts warm the skill cache for free — same payload.
      this.skillsCatalog = { skills: parseQoderSkills(init), fetchedAt: Date.now() };
      const catalog = buildModelCatalog(init, session.model);
      const changed = JSON.stringify(catalog.models) !== JSON.stringify(this.modelCatalog?.models ?? null);
      this.modelCatalog = catalog;
      if (changed && catalog.models.length > 0) {
        // The IPC layer persists this to disk and rebroadcasts to the UI
        // (qoder.modelConfigUpdated → useQoderModelConfig refetch).
        this.emit({
          type: 'model_catalog_updated',
          threadId: null,
          provider: 'qoder',
          models: catalog.models,
          defaultModel: catalog.defaultModel,
        });
      }
    } catch (error) {
      console.warn('[QoderSdkAdapter] initializationResult() failed:', error);
    }
  }

  // ── Skill discovery ────────────────────────────────────────────────────

  /**
   * Session-independent skill listing for the composer. Serves the cache,
   * then a live session's initializationResult() (already settled inside
   * the SDK — instant), then a message-free throwaway Query (~7s; verified
   * live: initializationResult() resolves without any user turn and spends
   * no model tokens).
   */
  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    const cached = this.skillsCatalog;
    if (!input.forceReload && cached && Date.now() - cached.fetchedAt < SKILLS_CACHE_TTL_MS) {
      return { skills: cached.skills, source: 'qoder-sdk', cached: true };
    }

    let init: QoderInitializationResult | null = null;
    const live = [...this.sessions.values()].find((session) => !session.closed);
    if (live) {
      try {
        init = await live.query.initializationResult();
      } catch (error) {
        console.warn('[QoderSdkAdapter] live initializationResult() failed:', error);
      }
    }
    if (!init) {
      init = await this.fetchInitializationResultDetached(input.cwd);
    }
    if (!init) {
      // Keep any stale cache over an empty flash when the probe fails.
      if (cached) {
        return { skills: cached.skills, source: 'qoder-sdk', cached: true };
      }
      return { skills: [], source: 'qoder-sdk', cached: false };
    }

    const skills = parseQoderSkills(init);
    this.skillsCatalog = { skills, fetchedAt: Date.now() };
    return { skills, source: 'qoder-sdk', cached: false };
  }

  private async fetchInitializationResultDetached(
    cwd?: string
  ): Promise<QoderInitializationResult | null> {
    try {
      const sdk = await loadQoderSdk();
      const promptQueue = new QoderPromptQueue();
      const query = sdk.query({
        prompt: promptQueue,
        options: {
          cwd: cwd?.trim() || process.cwd(),
          auth: sdk.qodercliAuth(),
        },
      });
      try {
        return await Promise.race([
          query.initializationResult(),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Qoder skill listing timed out.')),
              INIT_TIMEOUT_MS
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        promptQueue.close();
        void query.close().catch(() => {});
      }
    } catch (error) {
      console.warn('[QoderSdkAdapter] detached initializationResult() failed:', error);
      return null;
    }
  }

  // ── Plan usage (account quota) ─────────────────────────────────────────

  /**
   * Account quota behind qodercli's /usage. Prefers a live session's control
   * channel (no CLI spawn), else a message-free throwaway Query. Cached
   * briefly so the polling Usage page does not respawn the CLI on every tick.
   */
  async getPlanUsage(): Promise<QoderPlanUsageReport> {
    const cached = this.planUsage;
    if (cached && Date.now() - cached.fetchedAt < PLAN_USAGE_TTL_MS) {
      return cached;
    }

    let info: QoderUsageInfo | null = null;
    const live = [...this.sessions.values()].find((session) => !session.closed);
    if (live?.query.getUsageInfo) {
      try {
        info = await live.query.getUsageInfo();
      } catch (error) {
        console.warn('[QoderSdkAdapter] live getUsageInfo() failed:', error);
      }
    }
    if (!info) {
      info = await this.fetchUsageInfoDetached();
    }
    if (!info) {
      if (cached) {
        return cached;
      }
      throw new Error('Qoder usage info is unavailable. Make sure qodercli is signed in.');
    }
    const report = buildPlanUsageReport(info);
    this.planUsage = report;
    return report;
  }

  private async fetchUsageInfoDetached(): Promise<QoderUsageInfo | null> {
    try {
      const sdk = await loadQoderSdk();
      const promptQueue = new QoderPromptQueue();
      const query = sdk.query({
        prompt: promptQueue,
        options: {
          cwd: process.cwd(),
          auth: sdk.qodercliAuth(),
        },
      });
      try {
        if (!query.getUsageInfo) {
          return null;
        }
        return await Promise.race([
          query.getUsageInfo(),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Qoder usage probe timed out.')),
              PLAN_USAGE_TIMEOUT_MS
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        promptQueue.close();
        void query.close().catch(() => {});
      }
    } catch (error) {
      console.warn('[QoderSdkAdapter] detached getUsageInfo() failed:', error);
      return null;
    }
  }

  // ── Fork / one-shot ────────────────────────────────────────────────────

  async forkThread(input: { cwd: string; providerThreadId: string }): Promise<string> {
    const sdk = await loadQoderSdk();
    const cwd = input.cwd?.trim();
    const result = await sdk.forkSession(input.providerThreadId, cwd ? { dir: cwd } : undefined);
    const forkedId = getString(result?.sessionId).trim();
    if (!forkedId) {
      throw new Error('Qoder SDK did not return a forked session id.');
    }
    return forkedId;
  }

  async runOneShot(input: ProviderSessionStartInput): Promise<{ text: string; sessionId?: string; model?: string }> {
    // Title generation prefers the thread's live Query — no extra CLI spawn.
    const live = this.sessions.get(input.threadId);
    if (live && !live.closed && input.prompt.trim()) {
      try {
        const title = getString(await live.query.generateSessionTitle(input.prompt)).trim();
        if (title) {
          return { text: title, sessionId: live.providerSessionId || undefined, model: live.model };
        }
      } catch {
        // Fall through to the string-mode one-shot.
      }
    }

    // String-mode one-shot fallback. String mode is never used for sessions
    // (its interrupt is broken on 1.0.15, P5-fix) but is fine for a bounded
    // single prompt. Not registered in the sessions map: no UI thread exists
    // for it, so isolation from the real thread (pi's `:oneshot:` suffix
    // concern) holds trivially — it shares no state at all.
    const sdk = await loadQoderSdk();
    const machineCli = findMachineQoderCli();
    const options: QoderQueryOptions = {
      cwd: input.cwd || process.cwd(),
      auth: sdk.qodercliAuth(),
      // No UI exists for a one-shot: deny rather than strand a permission.
      canUseTool: () =>
        Promise.resolve({ behavior: 'deny', message: 'One-shot prompts cannot request permissions.' }),
    };
    if (input.model?.trim()) {
      options.model = input.model.trim();
    }
    if (input.qoderPermissionMode) {
      options.permissionMode = input.qoderPermissionMode as QoderSdkPermissionMode;
    }
    if (machineCli) {
      options.pathToQoderCLIExecutable = machineCli;
    }

    const query = sdk.query({ prompt: input.prompt, options });
    let text = '';
    let sessionId: string | undefined;
    try {
      for await (const message of query) {
        if (message.type === 'system' && (message as QoderSystemMessage).subtype === 'init') {
          sessionId = getString((message as QoderSystemInitMessage).session_id).trim() || sessionId;
          continue;
        }
        if (message.type === 'assistant') {
          text += extractText((message as QoderAssistantMessage).message?.content);
          continue;
        }
        if (message.type === 'result') {
          const result = message as QoderResultMessage;
          if (result.subtype === 'success') {
            if (!text.trim() && getString(result.result).trim()) {
              text = getString(result.result);
            }
          } else {
            const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean).join('; ') : '';
            throw this.mapTerminalError(
              new Error(errors || `Qoder one-shot failed (${getString(result.subtype) || 'unknown error'}).`)
            );
          }
        }
      }
    } finally {
      try {
        await query.close();
      } catch {
        // Already closed.
      }
    }
    return { text: text.trim(), sessionId, model: input.model };
  }

  // ── Pump: SDK message stream → StreamMessage translation ───────────────

  private async pump(session: ActiveQoderSession): Promise<void> {
    try {
      for await (const message of session.query) {
        this.handleSdkMessage(session, message);
      }
      this.handleIteratorEnded(session, null);
    } catch (error) {
      this.handleIteratorEnded(session, toError(error, 'Qoder session failed.'));
    }
  }

  private handleSdkMessage(session: ActiveQoderSession, message: QoderSDKMessage): void {
    switch (message.type) {
      case 'assistant':
        this.handleAssistantMessage(session, message as QoderAssistantMessage);
        return;
      case 'user':
        this.handleUserMessage(session, message as QoderUserMessage);
        return;
      case 'result':
        this.handleResultMessage(session, message as QoderResultMessage);
        return;
      case 'stream_event':
        this.handleStreamEvent(session, message as QoderStreamEventMessage);
        return;
      case 'system':
        this.handleSystemMessage(session, message as QoderSystemMessage);
        return;
      default:
        // prompt_suggestion, cloud_agent_event, future variants: drop.
        console.debug('[QoderSdkAdapter] dropping message type:', (message as { type?: string }).type);
    }
  }

  private handleAssistantMessage(session: ActiveQoderSession, message: QoderAssistantMessage): void {
    // SDKAssistantMessage.error never terminates a turn (turn-terminal
    // invariant): the CLI retries (api_retry) or the result carries it.
    if (message.error) {
      console.debug('[QoderSdkAdapter] non-terminal assistant error:', message.error);
    }
    const blocks = mapAssistantContentBlocks(message.message?.content);
    if (blocks.length === 0) {
      return;
    }
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: message.uuid || uuidv4(),
        // Subagent rendering + IPC/store exemptions depend on this mapping.
        parentToolUseId: message.parent_tool_use_id || null,
        message: { content: blocks },
      },
    });
  }

  private handleUserMessage(session: ActiveQoderSession, message: QoderUserMessage): void {
    // Resume replays must not re-render the transcript.
    if (message.isReplay) {
      return;
    }
    const blocks = mapToolResultBlocks(message.message?.content);
    if (blocks.length === 0) {
      // User-prompt echo: Aegis synthesizes user_prompt at enqueue — drop.
      return;
    }
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'user',
        uuid: message.uuid || uuidv4(),
        parentToolUseId: message.parent_tool_use_id || null,
        message: { content: blocks },
      },
    });
  }

  private handleStreamEvent(session: ActiveQoderSession, message: QoderStreamEventMessage): void {
    const event = message.event || {};
    const type = getString(event.type);
    if (type !== 'content_block_start' && type !== 'content_block_delta' && type !== 'content_block_stop') {
      // message_start/message_delta/message_stop: the assistant/result
      // messages carry the durable data.
      return;
    }
    let delta: { type: string; text?: string; thinking?: string; signature?: string } | undefined;
    if (type === 'content_block_delta') {
      const raw = isRecord(event.delta) ? event.delta : {};
      const deltaType = getString(raw.type);
      // Narrowed to text/thinking/signature deltas per the translation table.
      if (deltaType === 'text_delta') {
        delta = { type: 'text_delta', text: getString(raw.text) };
      } else if (deltaType === 'thinking_delta') {
        delta = { type: 'thinking_delta', thinking: getString(raw.thinking) };
      } else if (deltaType === 'signature_delta') {
        delta = { type: 'signature_delta', signature: getString(raw.signature) };
      } else {
        return;
      }
    }
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'stream_event',
        ...(message.parent_tool_use_id ? { parentToolUseId: message.parent_tool_use_id } : {}),
        event: {
          type,
          ...(typeof event.index === 'number' ? { index: event.index } : {}),
          ...(delta ? { delta } : {}),
        },
      },
    });
  }

  private handleResultMessage(session: ActiveQoderSession, message: QoderResultMessage): void {
    const errors = Array.isArray(message.errors)
      ? message.errors.filter((error): error is string => typeof error === 'string' && Boolean(error))
      : [];
    const usage = this.buildResultUsage(session, message);
    const fields = {
      durationMs: getNumber(message.duration_ms),
      totalCostUsd: getNumber(message.total_cost_usd),
      usage,
      modelUsage: message.modelUsage,
    };

    // Startup auth failure baseline: terminal_reason auth_required (exit 41).
    if (message.terminal_reason === 'auth_required') {
      this.emitTurnResult(session, 'error', fields);
      session.status = 'error';
      this.emitLocalNotice(session.threadId, 'Qoder login required. Run `qodercli login`, then start a new session.');
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
      this.emit({
        type: 'error',
        threadId: session.threadId,
        error: new QoderLoginRequiredError(errors.join('; ') || 'authentication required'),
      });
      return;
    }

    // interrupt() lands as error_during_execution("Operation aborted") (P9b)
    // — the turn's stopped result, not a failure.
    if (message.subtype === 'error_during_execution' && errors.some((error) => /aborted/i.test(error))) {
      this.emitTurnResult(session, 'stopped', fields);
      if (session.status !== 'stopped') {
        session.status = 'stopped';
        this.emit({ type: 'status_change', threadId: session.threadId, status: 'stopped' });
      }
      return;
    }

    if (message.subtype === 'success') {
      this.emitTurnResult(session, 'success', fields);
      if (session.status !== 'stopped') {
        session.status = 'completed';
        this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
      }
      return;
    }

    // error_max_turns / error_max_budget_usd / non-abort error_during_execution.
    this.emitTurnResult(session, 'error', fields);
    if (session.status !== 'stopped') {
      session.status = 'error';
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
      this.emit({
        type: 'error',
        threadId: session.threadId,
        error: new Error(errors.join('; ') || `Qoder turn failed (${message.subtype}).`),
      });
    }
  }

  private handleSystemMessage(session: ActiveQoderSession, message: QoderSystemMessage): void {
    switch (getString(message.subtype)) {
      case 'init':
        this.handleSystemInit(session, message as unknown as QoderSystemInitMessage);
        return;
      case 'status':
        if (message.status === 'compacting') {
          this.emitLocalNotice(session.threadId, 'Qoder is compacting the conversation context…');
        }
        return;
      case 'compact_boundary': {
        const metadata = message.compact_metadata || {};
        this.emit({
          type: 'message',
          threadId: session.threadId,
          message: {
            type: 'system',
            subtype: 'compact_boundary',
            uuid: message.uuid || uuidv4(),
            session_id: session.providerSessionId || '',
            compactMetadata: {
              trigger: metadata.trigger === 'auto' ? 'auto' : 'manual',
              preTokens: getNumber(metadata.pre_tokens) || 0,
            },
          },
        });
        return;
      }
      case 'permission_denied': {
        const toolName = getString(message.tool_name) || 'tool';
        const detail = getString(message.message) || getString(message.decision_reason);
        this.emitLocalNotice(session.threadId, `Qoder denied ${toolName}${detail ? `: ${detail}` : '.'}`);
        return;
      }
      case 'api_retry': {
        const attempt = getNumber(message.attempt);
        const maxRetries = getNumber(message.max_retries);
        const detail = getString(message.error);
        this.emitLocalNotice(
          session.threadId,
          `Qoder is retrying after a transient error${
            attempt ? ` (attempt ${attempt}${maxRetries ? `/${maxRetries}` : ''})` : ''
          }${detail ? `: ${detail}` : '.'}`
        );
        return;
      }
      default:
        // hook_*, task_*, session_state_changed, local_command_output,
        // files_persisted, elicitation_complete, …: drop at launch.
        console.debug('[QoderSdkAdapter] dropping system subtype:', message.subtype);
    }
  }

  private handleSystemInit(session: ActiveQoderSession, message: QoderSystemInitMessage): void {
    const sessionId = getString(message.session_id).trim();
    const model = getString(message.model).trim();

    if (!session.initSeen) {
      session.initSeen = true;
      // One-owner guard: a qoder session id drives exactly one live thread.
      if (sessionId) {
        this.assertSessionUnbound(sessionId, session.threadId);
        session.providerSessionId = sessionId;
        this.sessionOwners.set(sessionId, session.threadId);
      }
      if (model) {
        session.model = model;
      }
      session.initResolve(sessionId);
      this.emit({
        type: 'system_init',
        threadId: session.threadId,
        sessionId,
        model: session.model,
      });
      return;
    }

    // Re-init (same session id — after setModel or a queued mid-turn
    // injection, P9c/P10): refresh caches only. NOT a new session; emit no
    // transcript message.
    if (model) {
      session.model = model;
    }
    void this.refreshModelCatalog(session);
  }

  // ── Iterator end / crash path ──────────────────────────────────────────

  private handleIteratorEnded(session: ActiveQoderSession, error: Error | null): void {
    // The iterator ending (or throwing) means the CLI is gone either way.
    const expected = session.closed;
    session.closed = true;

    if (!session.initSeen) {
      session.initSeen = true;
      session.initReject(
        this.mapTerminalError(error || new Error('Qoder CLI exited before initialization.'))
      );
    }

    // Turn-terminal invariant: iterator end/throw without a result →
    // synthesize the in-flight turn's result (stopped during a stopSession,
    // error on a crash). Never leave the IPC FIFO skewed.
    const turn = session.turn;
    if (turn && !turn.resultEmitted) {
      this.emitTurnResult(session, expected ? 'stopped' : 'error', {});
    }

    // A dead CLI must never strand an approval card.
    this.dismissAllPermissions(session, 'Qoder session ended.');

    if (expected) {
      // Teardown path (stopSession): stopSession reports the status.
      return;
    }

    // Unexpected death: release the binding so the next send rebuilds via
    // resume, and make the failure visible.
    this.releaseSession(session);
    const mapped = this.mapTerminalError(error || new Error('Qoder CLI exited unexpectedly.'));
    session.status = 'error';
    this.emitLocalNotice(session.threadId, `Qoder session ended unexpectedly: ${mapped.message}`);
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
    this.emit({ type: 'error', threadId: session.threadId, error: mapped });
  }

  // ── Turn-terminal invariant ────────────────────────────────────────────

  private createTurn(session: ActiveQoderSession): ActiveTurn {
    session.turnSeq += 1;
    let settle!: () => void;
    const settlePromise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { seq: session.turnSeq, startedAtMs: Date.now(), resultEmitted: false, settle, settlePromise };
  }

  private emitTurnResult(
    session: ActiveQoderSession,
    subtype: 'success' | 'error' | 'stopped',
    fields: {
      durationMs?: number;
      totalCostUsd?: number;
      usage?: Usage;
      modelUsage?: Record<string, QoderModelUsage>;
    }
  ): void {
    const turn = session.turn;
    if (!turn || turn.resultEmitted) {
      // Guard: exactly one result per dispatched turn; a late SDK result
      // (after stopSession's bounded wait) is swallowed here.
      return;
    }
    turn.resultEmitted = true;
    turn.settle();
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'result',
        subtype,
        duration_ms: Math.max(0, Math.round(fields.durationMs ?? Date.now() - turn.startedAtMs)),
        total_cost_usd: fields.totalCostUsd ?? 0,
        usage: fields.usage ?? { input_tokens: 0, output_tokens: 0 },
        ...(session.model ? { model: session.model } : {}),
        ...(fields.modelUsage
          ? { modelUsage: fields.modelUsage as unknown as Record<string, ClaudeModelUsage> }
          : {}),
      },
    });
  }

  private buildResultUsage(session: ActiveQoderSession, message: QoderResultMessage): Usage {
    const contextWindow = this.resolveContextWindow(session, message);
    const ratio = getNumber(message.usage?.context_usage_ratio);
    // P12: token fields are 0 on every message type — only
    // context_usage_ratio carries data. Context ring = ratio × the current
    // model's window; absolute tokens land in total_tokens (the
    // OpenCode-style context snapshot reads it). No token_usage messages.
    const usedTokens = ratio !== undefined && contextWindow ? Math.round(ratio * contextWindow) : null;
    return {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: usedTokens,
      context_window: contextWindow,
    };
  }

  private resolveContextWindow(session: ActiveQoderSession, message?: QoderResultMessage): number | null {
    const model = session.model?.trim();
    if (model) {
      const fromCatalog = this.modelCatalog?.models.find((option) => option.value === model)?.contextWindow;
      if (fromCatalog && fromCatalog > 0) {
        return fromCatalog;
      }
      const fromUsage = message?.modelUsage?.[model]?.contextWindow;
      if (typeof fromUsage === 'number' && fromUsage > 0) {
        return fromUsage;
      }
    }
    const firstUsage = message?.modelUsage ? Object.values(message.modelUsage)[0] : undefined;
    if (typeof firstUsage?.contextWindow === 'number' && firstUsage.contextWindow > 0) {
      return firstUsage.contextWindow;
    }
    return null;
  }

  private waitForTurnSettle(turn: ActiveTurn, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      turn.settlePromise.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  // ── Options / auth / binding helpers ───────────────────────────────────

  private buildQueryOptions(
    sdk: QoderSdkModule,
    input: ProviderSessionStartInput,
    cwd: string
  ): QoderQueryOptions {
    const machineCli = findMachineQoderCli();
    const options: QoderQueryOptions = {
      cwd,
      includePartialMessages: true,
      // Reuse the machine's `qodercli login` state (~/.qoder);
      // QODER_PERSONAL_ACCESS_TOKEN is honored by the SDK when set.
      auth: sdk.qodercliAuth(),
      canUseTool: (toolName, toolInput, toolOptions) =>
        this.handleCanUseTool(input.threadId, toolName, toolInput, toolOptions),
      onAuthExpired: () => this.handleAuthExpired(input.threadId),
    };
    if (input.model?.trim()) {
      options.model = input.model.trim();
    }
    if (input.qoderPermissionMode) {
      // Start-time permissionMode only: runtime setPermissionMode('plan') is
      // broken on 1.0.15 (P11), so sendTurn deliberately does not re-apply it.
      options.permissionMode = input.qoderPermissionMode as QoderSdkPermissionMode;
    }
    if (input.resumeSessionId?.trim()) {
      options.resume = input.resumeSessionId.trim();
    }
    if (machineCli) {
      // Production resolves the machine's qodercli; the bundled binary stays
      // a dev-only fallback reached only when this is absent.
      options.pathToQoderCLIExecutable = machineCli;
    }
    return options;
  }

  private handleAuthExpired(threadId: string): void {
    // onAuthExpired fires at most once per session; same UX as the startup
    // auth_required path.
    if (this.sessions.has(threadId)) {
      this.emitLocalNotice(threadId, 'Qoder login expired. Run `qodercli login`, then start a new session.');
    }
    this.emit({ type: 'error', threadId, error: new QoderLoginRequiredError('authentication expired') });
  }

  private assertSessionUnbound(qoderSessionId: string, threadId: string): void {
    const owner = this.sessionOwners.get(qoderSessionId);
    if (owner && owner !== threadId && this.sessions.get(owner)?.closed === false) {
      throw new QoderThreadBindingError(qoderSessionId, owner);
    }
  }

  private releaseSession(session: ActiveQoderSession): void {
    if (this.sessions.get(session.threadId) === session) {
      this.sessions.delete(session.threadId);
    }
    if (session.providerSessionId && this.sessionOwners.get(session.providerSessionId) === session.threadId) {
      this.sessionOwners.delete(session.providerSessionId);
    }
  }

  /** Map CLI-death errors onto recognizable classes (login / protocol drift). */
  private mapTerminalError(error: Error): Error {
    const message = error.message || '';
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    if (
      exitCode === 41 ||
      /\bexit(?:ed)?\s+(?:with\s+)?(?:code\s+)?41\b/i.test(message) ||
      /auth_required|authentication[_ ]failed/i.test(message)
    ) {
      return new QoderLoginRequiredError(message);
    }
    if (error.name === 'ProtocolVersionMismatchError' || /protocol[_ ]version/i.test(message)) {
      return new Error(`Qoder CLI protocol mismatch: ${message}. Upgrade qodercli and try again.`);
    }
    return error;
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

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }
}
