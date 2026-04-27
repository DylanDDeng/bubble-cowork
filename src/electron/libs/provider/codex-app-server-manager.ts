import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import type { StreamMessage, Attachment, PermissionResult } from '../../../shared/types';
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
  activeTurnId?: string;
  status: 'connecting' | 'ready' | 'running' | 'error';
  lastError?: string;
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
}

// ── Constants ──────────────────────────────────────────────────────────────

const INITIALIZE_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 300_000;

// Codex app-server emits these as housekeeping signal — we don't act on them yet,
// so swallow them silently instead of cluttering dev logs as "unhandled".
const IGNORED_NOTIFICATIONS = new Set<string>([
  'mcpServer/startupStatus/updated',
  'account/rateLimits/updated',
  'thread/tokenUsage/updated',
  'thread/status/changed',
  'skills/changed',
  'app/list/updated',
  'fs/changed',
  'warning',
  'deprecationNotice',
  'configWarning',
]);

// ── CodexAppServerManager ──────────────────────────────────────────────────

export class CodexAppServerManager extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private sessions = new Map<string, CodexSession>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private initialized = false;

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
  }

  // ── Session Management ───────────────────────────────────────────────────

  async createSession(
    threadId: string,
    cwd: string,
    resumeCursor?: string
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
        response = await this.createNewThread(cwd);
      }
    } else {
      response = await this.createNewThread(cwd);
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
      status: 'ready',
    });

    return { providerThreadId, model: model || undefined };
  }

  private async createNewThread(cwd: string): Promise<Record<string, unknown>> {
    return (await this.sendRequest(
      'thread/start',
      { cwd },
      REQUEST_TIMEOUT_MS
    )) as Record<string, unknown>;
  }

  async sendTurn(
    threadId: string,
    prompt: string,
    attachments?: Attachment[]
  ): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`No session found for thread "${threadId}"`);
    }

    // Build prompt content per Codex UserInput schema:
    //   { type: 'text', text }            → plain text
    //   { type: 'localImage', path }      → image file (agent receives the actual image)
    //   anything else → fall back to a text description
    type UserInput =
      | { type: 'text'; text: string }
      | { type: 'localImage'; path: string };
    const content: UserInput[] = [{ type: 'text', text: prompt }];

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

    const response = (await this.sendRequest(
      'turn/start',
      {
        threadId: session.providerThreadId,
        input: content,
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
  }

  // ── Approval Responses ───────────────────────────────────────────────────

  async respondToApproval(
    requestId: string,
    approved: boolean,
    message?: string
  ): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    this.writeMessage({
      id: pending.jsonRpcId,
      result: {
        approved,
        ...(message ? { message } : {}),
      },
    });

    this.pendingApprovals.delete(requestId);
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
        }

        this.emit('item_completed', { threadId, params });
        break;
      }

      case 'error': {
        const message = this.readString(this.readObject(params, 'error'), 'message');
        const threadId = this.findThreadByProviderThreadId(this.readString(params, 'threadId'));
        if (threadId && message) {
          const session = this.sessions.get(threadId);
          if (session) {
            session.status = 'error';
            session.lastError = message;
          }
          this.emit('error_notification', { threadId, message });
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

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async ensureSpawned(cwd: string): Promise<void> {
    if (!this.initialized) {
      await this.spawn(cwd);
    }
  }

  private findThreadByProviderThreadId(providerThreadId: string | null): string | null {
    if (!providerThreadId) {
      // Fallback: return first session (usually there's only one active)
      const first = this.sessions.values().next().value;
      return first?.threadId || null;
    }
    for (const [threadId, session] of this.sessions) {
      if (session.providerThreadId === providerThreadId) {
        return threadId;
      }
    }
    return null;
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

  private extractTextContent(params: Record<string, unknown>): string | null {
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
  ): 'agentMessage' | 'toolCall' | 'toolResult' | null {
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
