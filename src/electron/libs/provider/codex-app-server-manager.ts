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
  ProviderSkillDescriptor,
} from '../../../shared/types';
import { isDev } from '../../util';

// ── Types ──────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
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
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface CodexSession {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  activeTurnId?: string;
  status: 'connecting' | 'ready' | 'running' | 'error';
  lastError?: string;
  model?: string;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
}

interface PendingRequest {
  method: string;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingApproval {
  jsonRpcId: number;
  method: string;
  threadId: string;
  params?: Record<string, unknown>;
}

interface CodexRunOptions {
  model?: string;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const INITIALIZE_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 300_000;

function resolveSkillsDiscoveryCwd(cwd: string | undefined): string {
  const trimmed = cwd?.trim();
  return trimmed || homedir();
}

// Codex app-server emits these as housekeeping signal — we don't act on them yet,
// so swallow them silently instead of cluttering dev logs as "unhandled".
const IGNORED_NOTIFICATIONS = new Set<string>([
  'account/rateLimits/updated',
  'thread/tokenUsage/updated',
  'thread/status/changed',
  'fs/changed',
  'hook/started',
  'hook/completed',
  'warning',
  'deprecationNotice',
  'configWarning',
]);

function isTransientConnectionMessage(message: string): boolean {
  return /^Reconnecting\.\.\. \d+\/\d+$/i.test(message.trim());
}

// ── CodexAppServerManager ──────────────────────────────────────────────────

export class CodexAppServerManager extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private sessions = new Map<string, CodexSession>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private initialized = false;
  private skillsCache = new Map<string, ProviderListSkillsResult>();
  private pluginsCache = new Map<string, ProviderListPluginsResult>();
  private pluginDetailCache = new Map<string, ProviderReadPluginResult>();
  private lastActiveThreadId: string | null = null;

  constructor(private readonly binaryPath = 'codex') {
    super();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async spawn(cwd: string): Promise<void> {
    if (this.child) {
      return;
    }

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
      if (isDev()) {
        console.log('[Codex AppServer] process exited', { code, signal });
      }
      this.emit('process_exit', { code, signal });
      this.cleanup();
    });

    child.on('error', (error) => {
      console.error('[Codex AppServer] process error', error);
      this.emit('process_error', error);
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

    // Initialize handshake
    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'aegis',
        title: 'Aegis',
        version: '0.0.20',
      },
      capabilities: {
        experimentalApi: true,
      },
    }, INITIALIZE_TIMEOUT_MS);

    this.writeMessage({ method: 'initialized' });
    this.initialized = true;

    if (isDev()) {
      console.log('[Codex AppServer] initialized');
    }
  }

  async stop(): Promise<void> {
    // Cancel all pending requests
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('App server stopped'));
    }
    this.pending.clear();

    this.cleanup();
  }

  private cleanup(): void {
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
    this.pendingApprovals.clear();
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
  ): Promise<{ providerThreadId: string; model?: string }> {
    await this.ensureSpawned(cwd);

    let response: Record<string, unknown>;

    if (resumeCursor) {
      try {
        response = (await this.sendRequest(
          'thread/load',
          { threadId: resumeCursor },
          REQUEST_TIMEOUT_MS
        )) as Record<string, unknown>;
      } catch {
        // Fall through to create new
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

    const model = String((response.thread as Record<string, unknown>)?.model || response.model || '');

    this.sessions.set(threadId, {
      threadId,
      providerThreadId,
      cwd,
      status: 'ready',
      model: model || options.model,
      codexExecutionMode: options.codexExecutionMode,
      codexPermissionMode: options.codexPermissionMode,
      codexReasoningEffort: options.codexReasoningEffort,
      codexFastMode: options.codexFastMode,
    });
    this.lastActiveThreadId = threadId;

    return { providerThreadId, model: model || undefined };
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

    const response = (await this.sendRequest(
      'turn/start',
      {
        threadId: session.providerThreadId,
        input: content,
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
      },
      TURN_TIMEOUT_MS
    )) as Record<string, unknown>;

    const turnId = String((response.turn as Record<string, unknown>)?.id || response.turnId || '');
    if (turnId) {
      session.activeTurnId = turnId;
      session.status = 'running';
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }

    // Try to abort active turn
    if (session.activeTurnId) {
      try {
        await this.sendRequest(
          'turn/abort',
          {
            threadId: session.providerThreadId,
            turnId: session.activeTurnId,
          },
          REQUEST_TIMEOUT_MS
        );
      } catch {
        // ignore
      }
    }

    this.sessions.delete(threadId);
    if (this.lastActiveThreadId === threadId) {
      this.lastActiveThreadId = this.findMostRecentFallbackThreadId();
    }
  }

  private normalizeCodexPermissionMode(
    mode: CodexPermissionMode | undefined
  ): CodexPermissionMode {
    return mode === 'fullAccess' ? 'fullAccess' : 'defaultPermissions';
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
    if (!selectedModel && normalizedMode !== 'plan') {
      return {};
    }

    return {
      collaborationMode: {
        mode: normalizedMode === 'plan' ? 'plan' : 'default',
        settings: {
          model: selectedModel || model || '',
          reasoning_effort: normalizedMode === 'plan' ? reasoningEffort || 'medium' : reasoningEffort || null,
          developer_instructions: null,
        },
      },
    };
  }

  // ── Approval Responses ───────────────────────────────────────────────────

  async respondToApproval(
    requestId: string,
    result: PermissionResult
  ): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    this.writeMessage({
      jsonrpc: '2.0',
      id: pending.jsonRpcId,
      result: this.buildApprovalResponse(pending, result),
    });

    this.pendingApprovals.delete(requestId);
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
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

    // Response (has id + result/error)
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      this.handleResponse(msg as unknown as JsonRpcResponse);
      return;
    }

    // Request from server (has id + method)
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
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
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.error) {
      const message = response.error.message || 'JSON-RPC error';
      pending.reject(new Error(`${pending.method}: ${message}`));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    const method = request.method.toLowerCase();

    // Approval requests
    if (
      method.includes('approval') ||
      method.includes('requestpermission') ||
      method.includes('confirm')
    ) {
      const requestId = uuidv4();
      this.pendingApprovals.set(requestId, {
        jsonRpcId: request.id,
        method: request.method,
        threadId: this.inferThreadId(request.params),
        params: request.params,
      });

      this.emit('approval_request', {
        requestId,
        jsonRpcId: request.id,
        method: request.method,
        params: request.params,
      });
      return;
    }

    // User input requests
    if (method.includes('requestuserinput') || method.includes('askuser')) {
      const requestId = uuidv4();
      this.pendingApprovals.set(requestId, {
        jsonRpcId: request.id,
        method: request.method,
        threadId: this.inferThreadId(request.params),
        params: request.params,
      });

      this.emit('user_input_request', {
        requestId,
        jsonRpcId: request.id,
        method: request.method,
        params: request.params,
      });
      return;
    }

    // Unsupported request
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
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId) {
          const session = this.sessions.get(threadId);
          if (session) {
            session.status = 'ready';
            session.activeTurnId = undefined;
          }
          this.emit('turn_completed', { threadId, params });
        }
        break;
      }

      case 'turn/aborted': {
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId) {
          const session = this.sessions.get(threadId);
          if (session) {
            session.status = 'ready';
            session.activeTurnId = undefined;
          }
          this.emit('turn_aborted', { threadId });
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

      case 'item/started': {
        const item = (params.item as Record<string, unknown>) || params;
        const itemType = this.normalizeItemType(item);
        const providerThreadId = this.readString(params, 'threadId');
        const threadId = this.findThreadByProviderThreadId(providerThreadId);
        if (!threadId) break;

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
        }

        this.emit('item_completed', { threadId, params });
        break;
      }

      case 'error': {
        const message = this.readString(this.readObject(params, 'error'), 'message');
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId && message) {
          if (isTransientConnectionMessage(message)) {
            this.emit('connection_reconnecting', { threadId, message });
            break;
          }
          const session = this.sessions.get(threadId);
          if (session) {
            session.status = 'error';
            session.lastError = message;
          }
          this.emit('error_notification', { threadId, message });
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
        this.emit('mcp_status_updated', { params });
        break;
      }

      default:
        if (IGNORED_NOTIFICATIONS.has(method)) break;
        if (isDev()) {
          console.log('[Codex AppServer] unhandled notification', method);
        }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async ensureSpawned(cwd: string): Promise<void> {
    if (!this.initialized) {
      await this.spawn(cwd);
    }
  }

  private findThreadByProviderThreadId(providerThreadId: string | null): string | null {
    if (!providerThreadId) {
      return this.findMostRecentFallbackThreadId();
    }
    for (const [threadId, session] of this.sessions) {
      if (session.providerThreadId === providerThreadId) {
        return threadId;
      }
    }
    return null;
  }

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

  private inferThreadId(params?: Record<string, unknown>): string {
    const providerThreadId = this.readString(params, 'threadId');
    return this.findThreadByProviderThreadId(providerThreadId) || 'unknown';
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
    if (!displayName && !shortDescription) return undefined;
    return {
      ...(displayName ? { displayName } : {}),
      ...(shortDescription ? { shortDescription } : {}),
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
  ): 'agentMessage' | 'toolCall' | 'toolResult' | 'plan' | null {
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
