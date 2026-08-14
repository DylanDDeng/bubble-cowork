import { EventEmitter } from 'events';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  buildDeepseekEnv,
  buildDeepseekSetupCommand,
  getDeepseekModelConfig,
  resolveDeepseekProfileDir,
  resolveDeepseekRuntimeEntry,
} from '../deepseek-cli';
import {
  loadDeepseekSdk,
  type DshContentBlock,
  type DshHarness,
  type DshHarnessNotification,
  type DshHarnessSession,
  type DshNotificationSubscription,
  type DshSessionEvent,
} from './deepseek-sdk-loader';
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
import type {
  Attachment,
  DeepseekPermissionMode,
  PermissionResult,
  StreamMessage,
} from '../../../shared/types';

/**
 * DeepSeek Harness SDK adapter.
 *
 * Drives a per-thread dsh SDK runtime (dev-fixtures/deepseek-harness profile)
 * through @deepseek-ai/dsh-sdk-client. Unlike the trimmed ACP surface, the
 * SDK wire streams the FULL session log — reasoning/text deltas, tool calls
 * and results, per-request usage and context window — which this adapter maps
 * onto the same stream shapes the Grok adapter emits.
 *
 * Contract notes (pre-release wire, pinned 0.1.0-rc.6):
 * - No mid-turn cancel on the wire: stop = close the runtime (EOF → SIGTERM →
 *   SIGKILL ladder inside the SDK client). The rc.6 JSON-RPC server omits its
 *   core agents.resume() path, so the Aegis runtime bin installs a narrow
 *   create-or-resume shim before boot. Same-cwd restarts restore the complete
 *   persisted DSH log; missing or wrong-cwd logs fail loudly instead of
 *   silently creating a context-disconnected replacement.
 * - No approval channel: sandbox escalations fail closed (profile pins
 *   approval policy `never`); no permission_request events are ever emitted.
 * - Model and sandbox mode are fixed per spawned runtime (initialize + env);
 *   a switch respawns via the ipc config-drift path.
 */

interface TurnState {
  /** Block-index counter for the renderer's delta coalescer. */
  nextBlockIndex: number;
  currentThinking?: { blockIndex: number };
  currentText?: { blockIndex: number };
  usage: { input: number; output: number; cacheRead: number; reasoning: number };
  endReason?: { kind: string; message?: string };
  startedAt: number;
}

interface ActiveDeepseekSession {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  permissionMode: DeepseekPermissionMode;
  harness: DshHarness;
  session: DshHarnessSession;
  /**
   * Persistent session-tree subscription — the ONE event source for this
   * thread. Events must not ride the per-run onNotification observer: a
   * steer enqueued at the idle boundary can start a turn AFTER the primary
   * run settled, and only a run-independent subscription still sees it.
   */
  subscription: DshNotificationSubscription;
  contextWindow?: number;
  turn?: TurnState;
  /** True while a primary run() owns the activity — steers enqueue instead. */
  turnInFlight?: boolean;
  /** Set by stopSession/disposeSession so a rejected in-flight run stays silent. */
  closed?: boolean;
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: false,
  skillDiscovery: false,
  pluginDiscovery: false,
  mcpServers: false,
  imageAttachments: false,
  forkThread: false,
  compactThread: false,
  planMode: false,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeDeepseekPermissionMode(value: unknown): DeepseekPermissionMode {
  return value === 'danger-full-access' ? 'danger-full-access' : 'workspace-write';
}

/**
 * The runtime takes text content blocks; images are not part of the dsh
 * prompt vocabulary, so attachments flatten to text: previews inline,
 * binaries as path references the agent can open with its sandboxed tools.
 */
function buildPromptBlocks(prompt: string, attachments?: Attachment[]): DshContentBlock[] {
  const blocks: DshContentBlock[] = [];
  if (prompt.trim()) {
    blocks.push({ type: 'text', text: prompt });
  }
  for (const attachment of attachments || []) {
    if (attachment.kind === 'image') {
      blocks.push({
        type: 'text',
        text: `Image attachment available on disk (this agent cannot view images): ${attachment.path}`,
      });
    } else if (attachment.previewText?.trim()) {
      blocks.push({
        type: 'text',
        text: `Attachment: ${attachment.name}\nPath: ${attachment.path}\n\n${attachment.previewText}`,
      });
    } else {
      blocks.push({
        type: 'text',
        text: `Attachment available on disk: ${attachment.path}`,
      });
    }
  }
  return blocks;
}

/** Concatenate the text leaves of a tool-result content tree. */
function extractToolResultText(content: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    for (const item of getArray(value)) {
      const record = getRecord(item);
      if (!record) continue;
      if (typeof record.text === 'string') {
        parts.push(record.text);
      } else if (record.content !== undefined) {
        walk(record.content);
      }
    }
  };
  walk(content);
  return parts.join('\n');
}

export class DeepseekSdkAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'deepseek';
  readonly displayName = 'DeepSeek';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActiveDeepseekSession>();

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const permissionMode = normalizeDeepseekPermissionMode(input.deepseekPermissionMode);
    const model = input.model?.trim() || getDeepseekModelConfig().defaultModel || undefined;
    const harness = await this.spawnHarness(
      input.cwd,
      model,
      permissionMode,
      input.resumeSessionId
    );

    // session(id) is only a client-side handle; the Aegis runtime shim decides
    // on the first prompt whether that durable identity must be resumed or a
    // new identity created. Without a stored id the SDK mints a fresh session.
    const session = harness.session(input.resumeSessionId);
    const subscription = harness.client.subscribeSessionTree(session.id);

    const active: ActiveDeepseekSession = {
      threadId: input.threadId,
      providerSessionId: session.id,
      status: 'running',
      cwd: input.cwd,
      model,
      permissionMode,
      harness,
      session,
      subscription,
    };
    // Never orphan a previous session for the same thread — an undisposed
    // predecessor would leak its runtime subprocess.
    this.disposeSession(input.threadId);
    this.sessions.set(input.threadId, active);
    this.pumpSubscription(active);

    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: session.id,
      model,
    });

    if (input.prompt || input.attachments?.length) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model,
      });
    }

    return {
      threadId: input.threadId,
      provider: 'deepseek',
      providerSessionId: active.providerSessionId,
      status: 'running',
      model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const active = this.sessions.get(input.threadId);
    if (!active) {
      throw new Error(`No DeepSeek session found for thread "${input.threadId}"`);
    }

    // Steer: while the primary run owns the activity, a follow-up send rides
    // the runtime's inbox instead of a second run(). The spine splices it and
    // consumes it before going idle (verified live: the queued instruction
    // shaped the same activity's final answer), so the in-flight run's
    // settlement covers it and emits the single turn-terminal result.
    if (active.turnInFlight) {
      try {
        await active.harness.client.prompt(
          active.providerSessionId,
          buildPromptBlocks(input.prompt, input.attachments)
        );
      } catch (error) {
        if (this.sessions.get(input.threadId) !== active || active.closed) {
          return;
        }
        this.emit({
          type: 'error',
          threadId: input.threadId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      return;
    }

    active.status = 'running';
    active.turnInFlight = true;
    active.turn = {
      nextBlockIndex: 0,
      usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
      startedAt: Date.now(),
    };
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    try {
      await active.session.run(buildPromptBlocks(input.prompt, input.attachments));
      if (this.sessions.get(input.threadId) !== active) {
        return;
      }
      const turn = active.turn;
      const failed = turn?.endReason?.kind === 'error';
      this.emitTokenUsage(active);
      active.status = failed ? 'error' : 'completed';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: failed ? 'error' : 'success',
          duration_ms: turn ? Date.now() - turn.startedAt : 0,
          total_cost_usd: 0,
          usage: {
            input_tokens: turn?.usage.input ?? 0,
            output_tokens: turn?.usage.output ?? 0,
            cache_read_input_tokens: turn?.usage.cacheRead ?? 0,
            reasoning_output_tokens: turn?.usage.reasoning ?? 0,
          },
          model: active.model,
        },
      });
      if (failed) {
        this.emit({
          type: 'error',
          threadId: input.threadId,
          error: new Error(turn?.endReason?.message || 'DeepSeek turn ended with an error.'),
        });
      }
      this.emit({
        type: 'status_change',
        threadId: input.threadId,
        status: failed ? 'error' : 'completed',
      });
    } catch (error) {
      // A stop/dispose closes the runtime, which rejects this turn's run() —
      // that rejection must stay silent: the thread was stopped on purpose,
      // or a replacement session now owns it.
      if (this.sessions.get(input.threadId) !== active || active.closed) {
        return;
      }
      active.status = 'error';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: 'error',
          duration_ms: active.turn ? Date.now() - active.turn.startedAt : 0,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      this.emit({
        type: 'error',
        threadId: input.threadId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.emit({ type: 'status_change', threadId: input.threadId, status: 'error' });
    } finally {
      active.turnInFlight = false;
    }
  }

  /**
   * Drain the session-tree subscription for this thread's lifetime. The
   * iterator rejects on subscription close or runtime death — both are
   * ordinary teardown here.
   */
  private pumpSubscription(active: ActiveDeepseekSession): void {
    void (async () => {
      try {
        for await (const notification of active.subscription) {
          this.handleNotification(active, notification);
        }
      } catch {
        // closed subscription / reaped runtime — nothing left to drain
      }
    })();
  }

  async stopSession(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId);
    if (!active) return;
    active.status = 'stopped';
    active.closed = true;
    this.sessions.delete(threadId);
    try {
      active.subscription.close();
    } catch {
      // already detached
    }
    // No wire-level cancel exists: closing the runtime IS the interrupt
    // (shutdown request, then EOF → SIGTERM → SIGKILL inside the client).
    try {
      await active.harness.close();
    } catch {
      // The process may already be gone.
    }
  }

  disposeSession(threadId: string): boolean {
    const active = this.sessions.get(threadId);
    if (!active) {
      return false;
    }
    try {
      active.closed = true;
      this.sessions.delete(threadId);
      active.subscription.close();
      // Quiet, synchronous contract: fire and forget the async close ladder.
      void active.harness.close().catch(() => {});
    } catch (error) {
      console.warn('[DeepseekSdkAdapter] disposeSession cleanup failed:', error);
    }
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((threadId) => this.stopSession(threadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((active) => ({
      threadId: active.threadId,
      provider: 'deepseek',
      providerSessionId: active.providerSessionId,
      status: active.status,
      model: active.model,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async respondToRequest(
    _threadId: string,
    _requestId: string,
    _decision: PermissionResult
  ): Promise<void> {
    // The SDK wire has no approval channel (dead capability upstream), so no
    // permission_request is ever emitted and there is nothing to answer.
  }

  /** One-shot text round trip: boot a runtime, run once, reap it. */
  async runOneShot(
    input: ProviderSessionStartInput
  ): Promise<{ text: string; sessionId?: string; model?: string }> {
    const permissionMode = normalizeDeepseekPermissionMode(input.deepseekPermissionMode);
    const model = input.model?.trim() || getDeepseekModelConfig().defaultModel || undefined;
    const harness = await this.spawnHarness(input.cwd, model, permissionMode);
    try {
      const result = await harness.run(buildPromptBlocks(input.prompt, input.attachments));
      return { text: result.finalResponse, sessionId: result.sessionId, model };
    } finally {
      void harness.close().catch(() => {});
    }
  }

  // ── Runtime management ─────────────────────────────────────────────────────

  private async spawnHarness(
    cwd: string,
    model: string | undefined,
    permissionMode: DeepseekPermissionMode,
    resumeSessionId?: string
  ): Promise<DshHarness> {
    const profileDir = resolveDeepseekProfileDir();
    if (!profileDir) {
      throw new Error(
        `DeepSeek Harness launch profile was not found. Run \`${buildDeepseekSetupCommand()}\` or set AEGIS_DSH_PROFILE_DIR.`
      );
    }
    const entry = resolveDeepseekRuntimeEntry(profileDir);
    const sdk = await loadDeepseekSdk();
    const harness = new sdk.DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: [entry.binPath, entry.configPath],
        cwd: profileDir,
        // Stop rides the close ladder (shutdown -> EOF -> SIGTERM -> SIGKILL);
        // the SDK defaults sum to ~10s worst case, far too slow for the stop
        // button. A mid-turn runtime holds no state worth a long quiesce —
        // sessions persist per event — so cut each rung short (~3.5s worst).
        shutdownTimeoutMs: 500,
        disposeEofGraceMs: 1500,
        disposeGraceMs: 1500,
        env: {
          ...buildDeepseekEnv({ cwd, permissionMode }),
          // Electron's process.execPath is Electron itself; run as plain node.
          ELECTRON_RUN_AS_NODE: '1',
          DSH_SESSION_ROOT: path.join(profileDir, '.sessions'),
          ...(resumeSessionId ? { AEGIS_DSH_RESUME_SESSION_ID: resumeSessionId } : {}),
        },
      },
      cwd,
      provider: 'deepseek-official',
      ...(model ? { model } : {}),
    });
    await harness.start();
    return harness;
  }

  // ── Notification routing ───────────────────────────────────────────────────

  private handleNotification(
    active: ActiveDeepseekSession,
    notification: DshHarnessNotification
  ): void {
    if (this.sessions.get(active.threadId) !== active) {
      return;
    }
    if (notification.method !== 'session.event') {
      return;
    }
    // Descendant (subagent) sessions stream here too; only the root session
    // renders into the thread. The subagent's own tool/call row already
    // surfaces the delegation.
    if (getString(notification.params.sessionId) !== active.providerSessionId) {
      return;
    }
    const event = getRecord(notification.params.event) as DshSessionEvent | null;
    if (!event || typeof event.type !== 'string') {
      return;
    }
    const data = getRecord(event.data) || {};
    switch (event.type) {
      case 'assistant/chunk':
        this.handleAssistantChunk(active, getRecord(data.chunk) || {});
        break;
      case 'assistant/message':
        this.handleAssistantMessage(active, data);
        break;
      case 'tool/call':
        this.handleToolCall(active, data);
        break;
      case 'tool/result':
        this.handleToolResult(active, data);
        break;
      case 'request/context':
        active.contextWindow = getNumber(data.contextWindow) || active.contextWindow;
        break;
      case 'turn/end': {
        const reason = getRecord(data.reason);
        const error = getRecord(reason?.error);
        if (active.turn && reason) {
          active.turn.endReason = {
            kind: getString(reason.kind) || 'completed',
            message: getString(error?.message) || undefined,
          };
        }
        break;
      }
      default:
        // step/*, session/title, agent/inbox/*, user/message: no render.
        break;
    }
  }

  // ── Streaming deltas ───────────────────────────────────────────────────────

  private handleAssistantChunk(
    active: ActiveDeepseekSession,
    chunk: Record<string, unknown>
  ): void {
    const turn = active.turn;
    if (!turn) return;
    switch (chunk.type) {
      case 'reasoning-delta': {
        const text = getString(chunk.text) || getString(chunk.delta);
        if (!text) return;
        if (!turn.currentThinking) {
          turn.currentThinking = { blockIndex: turn.nextBlockIndex++ };
        }
        this.emitStreamDelta(active, turn.currentThinking.blockIndex, {
          type: 'thinking_delta',
          thinking: text,
        });
        break;
      }
      case 'text-delta': {
        const text = getString(chunk.text) || getString(chunk.delta);
        if (!text) return;
        if (!turn.currentText) {
          turn.currentText = { blockIndex: turn.nextBlockIndex++ };
        }
        this.emitStreamDelta(active, turn.currentText.blockIndex, {
          type: 'text_delta',
          text,
        });
        break;
      }
      case 'usage':
        this.accumulateUsage(active, getRecord(chunk.usage) || chunk);
        break;
      default:
        // block-start/block-end/tool-call-delta/finish: the committed
        // assistant/message and tool/call events carry the durable content.
        break;
    }
  }

  private emitStreamDelta(
    active: ActiveDeepseekSession,
    index: number,
    delta: { type: string; text?: string; thinking?: string }
  ): void {
    this.emit({
      type: 'message',
      threadId: active.threadId,
      message: {
        type: 'stream_event',
        parentToolUseId: null,
        event: { type: 'content_block_delta', index, delta },
      },
    });
  }

  // ── Committed messages / tools ─────────────────────────────────────────────

  private handleAssistantMessage(
    active: ActiveDeepseekSession,
    data: Record<string, unknown>
  ): void {
    const message = getRecord(data.message);
    if (!message) return;
    this.accumulateUsage(active, getRecord(data.usage));

    const content: Array<{ type: 'thinking'; thinking: string } | { type: 'text'; text: string }> = [];
    for (const block of getArray(message.content)) {
      const record = getRecord(block);
      if (!record) continue;
      if (record.type === 'reasoning' && getString(record.text)) {
        content.push({ type: 'thinking', thinking: getString(record.text) });
      } else if (record.type === 'text' && getString(record.text)) {
        content.push({ type: 'text', text: getString(record.text) });
      }
      // tool-call blocks are rendered from the tool/call event instead.
    }
    if (content.length === 0) return;

    // A committed message closes the streaming buffers: the next delta opens
    // a fresh block so it never appends onto committed content.
    if (active.turn) {
      active.turn.currentThinking = undefined;
      active.turn.currentText = undefined;
    }

    const uuid = `deepseek-assistant:${active.threadId}:${getString(message.id) || uuidv4()}`;
    const streamMessage: StreamMessage = {
      type: 'assistant',
      uuid,
      createdAt: Date.now(),
      message: { content },
    };
    this.emit({ type: 'message', threadId: active.threadId, message: streamMessage });
  }

  private handleToolCall(active: ActiveDeepseekSession, data: Record<string, unknown>): void {
    const callId = getString(data.callId);
    if (!callId) return;
    const name = getString(data.name) || 'Tool';
    let parsedInput: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(getString(data.arguments) || '{}') as unknown;
      parsedInput = getRecord(parsed) || {};
    } catch {
      parsedInput = { arguments: getString(data.arguments) };
    }
    const message: StreamMessage = {
      type: 'assistant',
      uuid: `deepseek-tool-use:${active.threadId}:${callId}`,
      createdAt: Date.now(),
      message: {
        content: [{ type: 'tool_use', id: callId, name, input: parsedInput }],
      },
    };
    this.emit({ type: 'message', threadId: active.threadId, message });
  }

  private handleToolResult(active: ActiveDeepseekSession, data: Record<string, unknown>): void {
    const message = getRecord(data.message);
    const source = getRecord(message?.source);
    const callId = getString(source?.callId);
    if (!callId) return;
    const blocks = getArray(message?.content);
    const isError = blocks.some((block) => getRecord(block)?.isError === true);
    const text = extractToolResultText(blocks) || 'Done';
    const streamMessage: StreamMessage = {
      type: 'assistant',
      uuid: `deepseek-tool-result:${active.threadId}:${callId}:${uuidv4()}`,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: callId,
            content: text,
            is_error: isError,
          },
        ],
      },
    };
    this.emit({ type: 'message', threadId: active.threadId, message: streamMessage });
  }

  // ── Usage / context ring ───────────────────────────────────────────────────

  private accumulateUsage(
    active: ActiveDeepseekSession,
    usage: Record<string, unknown> | null
  ): void {
    const turn = active.turn;
    if (!turn || !usage) return;
    turn.usage.input += getNumber(usage.inputTokens);
    turn.usage.output += getNumber(usage.outputTokens);
    turn.usage.cacheRead += getNumber(usage.cacheReadTokens);
    turn.usage.reasoning += getNumber(usage.reasoningTokens);
  }

  /**
   * Codex-style context ring. Occupancy approximates the last request's
   * prompt footprint (fresh input + cache hits); the window comes from the
   * runtime's request/context event for the routed model.
   */
  private emitTokenUsage(active: ActiveDeepseekSession): void {
    const turn = active.turn;
    if (!turn || !active.contextWindow || active.contextWindow <= 0) {
      return;
    }
    const contextTokens =
      turn.usage.input + turn.usage.cacheRead + turn.usage.output + turn.usage.reasoning;
    this.emit({
      type: 'message',
      threadId: active.threadId,
      message: {
        type: 'system',
        subtype: 'token_usage',
        uuid: 'deepseek-token-usage:' + active.threadId + ':' + Date.now(),
        session_id: active.threadId,
        provider: 'deepseek',
        usage: {
          inputTokens: turn.usage.input,
          cachedInputTokens: turn.usage.cacheRead,
          outputTokens: turn.usage.output,
          reasoningOutputTokens: turn.usage.reasoning,
          totalTokens: contextTokens,
          contextWindow: active.contextWindow,
        },
      },
    });
  }

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }
}
