import { EventEmitter } from 'events';
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
import { CodexAppServerManager } from './codex-app-server-manager';
import { isDev } from '../../util';
import type { ContentBlock, PermissionResult, StreamMessage } from '../../../shared/types';

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function getString(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : '';
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
  skillDiscovery: false,
  mcpServers: false,
  imageAttachments: true,
  forkThread: false,
  compactThread: false,
  planMode: false,
};

interface ActiveSession {
  threadId: string;
  providerThreadId: string;
  status: ProviderSessionStatus;
  model?: string;
}

interface StreamingTextState {
  text: string;
  blockIndex: number;
  uuid: string;
  createdAt: number;
}

interface StreamingThinkingState {
  thinking: string;
  blockIndex: number;
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'codex';
  readonly displayName = 'Codex';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private manager: CodexAppServerManager;
  private sessions = new Map<string, ActiveSession>();
  // Per-thread streaming accumulator. Codex emits agent text as token-level
  // deltas; expose them as updates to one assistant message so the transcript
  // grows in place instead of rendering a separate overlay or appending rows.
  private streamingText = new Map<string, StreamingTextState>();
  private streamingThinking = new Map<string, StreamingThinkingState>();
  private finalizedStreamingText = new Map<string, string>();
  private emittedToolCalls = new Map<string, Set<string>>();
  private emittedToolResults = new Map<string, Set<string>>();
  private pendingToolCallIds = new Map<string, string[]>();
  private permissionResolvers = new Map<
    string,
    { resolve: (result: PermissionResult) => void }
  >();
  // Cache of the original session-start input keyed by threadId. Used to
  // transparently rebuild a codex session after an auth-recovery teardown so
  // the user can resend in the same chat without manually starting a new one.
  private lastStartInput = new Map<string, ProviderSessionStartInput>();
  private authRecoveryInFlight: Promise<void> | null = null;

  constructor(binaryPath?: string) {
    this.manager = new CodexAppServerManager(binaryPath);
    this.setupEventForwarding();
  }

  private setupEventForwarding(): void {
    // Forward manager events as ProviderRuntimeEvents
    this.manager.on('text_delta', ({ threadId, text }) => {
      const state = this.getOrCreateStreamingTextState(threadId);
      state.text += text;
      this.emitAssistantTextSnapshot(threadId, state, true);
    });

    this.manager.on('reasoning_delta', ({ threadId, text }) => {
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

    this.manager.on('agent_message_done', ({ threadId, text }) => {
      this.finalizeStreamingAssistant(threadId, text);
      this.clearStreamingState(threadId);
    });

    this.manager.on('tool_call', ({ threadId, params }) => {
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
    });

    this.manager.on('tool_result', ({ threadId, params }) => {
      const p = params as Record<string, unknown>;
      const { item, toolUseId, rawContent } = this.extractToolResultInfo(threadId, p);
      const isError = Boolean(item.isError ?? item.error ?? p.isError);

      if (toolUseId && !this.markEmitted(this.emittedToolResults, threadId, toolUseId)) {
        return;
      }
      if (toolUseId) {
        this.forgetPendingToolCall(threadId, toolUseId);
      }

      if (isDev()) {
        console.log('[CodexAdapter] tool_result', {
          toolUseId,
          isError,
          paramKeys: Object.keys(p),
          itemKeys: isObject(p.item) ? Object.keys(p.item as object) : [],
        });
      }

      const message: StreamMessage = {
        type: 'user',
        uuid: uuidv4(),
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? ''),
              is_error: isError,
            },
          ],
        },
      };
      this.emit({ type: 'message', threadId, message });
    });

    this.manager.on('turn_completed', ({ threadId }) => {
      this.finalizeStreamingAssistant(threadId);
      this.clearStreamingState(threadId);
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

    this.manager.on('turn_aborted', ({ threadId }) => {
      this.finalizeStreamingAssistant(threadId);
      this.clearStreamingState(threadId);
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

    this.manager.on('error_notification', ({ threadId, message }) => {
      this.finalizeStreamingAssistant(threadId);
      this.clearStreamingState(threadId);
      this.updateSessionStatus(threadId, 'error');
      if (isAuthRefreshError(message)) {
        void this.handleAuthFailure(message);
        return;
      }
      this.emit({ type: 'error', threadId, error: new Error(message) });
    });

    this.manager.on('process_exit', ({ code, signal }) => {
      // Mark all sessions as error
      for (const [threadId] of this.sessions) {
        this.finalizeStreamingAssistant(threadId);
        this.clearStreamingState(threadId);
        this.updateSessionStatus(threadId, 'error');
        this.emit({
          type: 'error',
          threadId,
          error: new Error(`Codex process exited (code=${code}, signal=${signal})`),
        });
      }
    });

    this.manager.on('process_error', (error: Error) => {
      for (const [threadId] of this.sessions) {
        this.finalizeStreamingAssistant(threadId);
        this.clearStreamingState(threadId);
        this.updateSessionStatus(threadId, 'error');
        this.emit({ type: 'error', threadId, error });
      }
    });

    this.manager.on('auth_error', (error: Error) => {
      void this.handleAuthFailure(error.message);
    });

    this.manager.on('approval_request', ({ requestId, params }) => {
      const threadId = this.inferThreadIdFromParams(params);
      const toolName = this.inferToolNameFromApproval(params);
      this.emit({
        type: 'permission_request',
        threadId,
        requestId,
        toolName,
        input: params,
      });
    });

    this.manager.on('user_input_request', ({ requestId, params }) => {
      const threadId = this.inferThreadIdFromParams(params);
      this.emit({
        type: 'permission_request',
        threadId,
        requestId,
        toolName: 'AskUserQuestion',
        input: params,
      });
    });

    this.manager.on('thread_started', ({ threadId, model }) => {
      const session = this.sessions.get(threadId);
      if (session && model) {
        session.model = model;
      }
    });

    this.manager.on('thread_status_changed', ({ threadId, status }) => {
      if (status === 'ready') {
        this.updateSessionStatus(threadId, 'completed');
        const message: StreamMessage = {
          type: 'result',
          subtype: 'success',
          duration_ms: 0,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
        this.emit({ type: 'message', threadId, message });
      }
    });
  }

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }

  private finalizeStreamingAssistant(threadId: string, fallbackText = ''): void {
    const textState = this.streamingText.get(threadId);
    const thinkingState = this.streamingThinking.get(threadId);
    if (!textState && !thinkingState && !fallbackText.trim()) {
      return;
    }

    // Close the reasoning stream overlay. Assistant text itself is represented
    // by the in-place assistant message snapshot.
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

    const finalText = (textState?.text || fallbackText || '').trim();
    const finalThinking = (thinkingState?.thinking || '').trim();
    if (!finalText && !finalThinking) {
      return;
    }
    if (!textState && !thinkingState && finalText && this.finalizedStreamingText.get(threadId) === finalText) {
      return;
    }

    const finalState =
      textState ??
      ({
        text: finalText,
        blockIndex: 1,
        uuid: uuidv4(),
        createdAt: Date.now(),
      } satisfies StreamingTextState);
    finalState.text = finalText;
    this.emitAssistantTextSnapshot(threadId, finalState, false, finalThinking);
    if (finalText) {
      this.finalizedStreamingText.set(threadId, finalText);
    }
  }

  private getOrCreateStreamingTextState(threadId: string): StreamingTextState {
    let state = this.streamingText.get(threadId);
    if (!state) {
      // Use index 1 so reasoning (index 0) and answer text are distinct when a
      // reasoning stream_event is also present.
      state = { text: '', blockIndex: 1, uuid: uuidv4(), createdAt: Date.now() };
      this.streamingText.set(threadId, state);
    }
    return state;
  }

  private emitAssistantTextSnapshot(
    threadId: string,
    state: StreamingTextState,
    streaming: boolean,
    finalThinking = ''
  ): void {
    const content: ContentBlock[] = [];
    if (finalThinking) {
      content.push({ type: 'thinking', thinking: finalThinking });
    }
    if (state.text) {
      content.push({ type: 'text', text: state.text });
    }
    if (content.length === 0) {
      return;
    }

    this.emit({
      type: 'message',
      threadId,
      message: {
        type: 'assistant',
        uuid: state.uuid,
        createdAt: state.createdAt,
        streaming,
        message: { content },
      },
    });
  }

  private clearStreamingState(threadId: string): void {
    this.streamingText.delete(threadId);
    this.streamingThinking.delete(threadId);
    this.emittedToolCalls.delete(threadId);
    this.emittedToolResults.delete(threadId);
    this.pendingToolCallIds.delete(threadId);
  }

  // ── ProviderAdapter Implementation ───────────────────────────────────────

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const { providerThreadId, model } = await this.manager.createSession(
      input.threadId,
      input.cwd,
      input.resumeSessionId
    );

    const session: ActiveSession = {
      threadId: input.threadId,
      providerThreadId,
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

    // Send initial prompt if provided
    if (input.prompt) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model || model,
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
    this.finalizedStreamingText.delete(input.threadId);
    this.clearStreamingState(input.threadId);
    this.emit({
      type: 'status_change',
      threadId: input.threadId,
      status: 'running',
    });

    await this.manager.sendTurn(input.threadId, input.prompt, input.attachments);
  }

  async stopSession(threadId: string): Promise<void> {
    await this.manager.stopSession(threadId);
    this.sessions.delete(threadId);
    this.lastStartInput.delete(threadId);
  }

  async stopAll(): Promise<void> {
    await this.manager.stop();
    this.sessions.clear();
    this.lastStartInput.clear();
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
    const approved = decision.behavior === 'allow';
    await this.manager.respondToApproval(requestId, approved, decision.message);
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

  private inferThreadIdFromParams(params: unknown): string {
    if (params && typeof params === 'object') {
      const p = params as Record<string, unknown>;
      const threadId = p.threadId;
      if (typeof threadId === 'string') {
        // Try to find session by provider thread id
        for (const [id, session] of this.sessions) {
          if (session.providerThreadId === threadId) {
            return id;
          }
        }
      }
    }
    // Fallback to first session
    const first = this.sessions.keys().next().value;
    return first || 'unknown';
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

  /**
   * Auth refresh failed (typically because the user signed into another account
   * elsewhere, invalidating our cached refresh token). The codex app-server
   * loaded auth on startup and won't re-read ~/.codex/auth.json, so we tear it
   * down — the next sendTurn will respawn a fresh process via the cached start
   * input and the user just continues in the same chat. Idempotent across
   * concurrent error notifications.
   */
  private async handleAuthFailure(originalMessage: string): Promise<void> {
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

    try {
      await this.manager.stop();
    } catch (error) {
      console.warn('[CodexAdapter] failed to stop manager during auth recovery:', error);
    }

    this.sessions.clear();
    this.streamingText.clear();
    this.streamingThinking.clear();
    this.emittedToolCalls.clear();
    this.emittedToolResults.clear();
    this.pendingToolCallIds.clear();
    this.permissionResolvers.clear();

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
    }

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
      normalizeCodexToolName(rawName) ||
      inferCodexToolNameFromFields({ command, filePath, title }) ||
      'unknown';

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
