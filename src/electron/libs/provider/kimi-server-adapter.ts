import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
  KimiServerManager,
  KimiServerTransportError,
  type KimiServerTransport,
  type KimiWsFrame,
} from './kimi-server-manager';
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
  AcpPermissionInput,
  AcpPermissionOption,
  Attachment,
  ContentBlock,
  KimiPermissionMode,
  KimiThinking,
  PermissionResult,
  ProviderComposerCapabilities,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillDescriptor,
  StreamMessage,
} from '../../../shared/types';

/**
 * KimiServerAdapter — ProviderAdapter over the `kimi server` REST+WS runtime.
 * Event shapes are pinned in docs/kimi-server-adapter-plan.md's appendix
 * (scripts/probe-kimi-server.mjs against 0.26.0).
 */

/** A server session id is already bound to another live Aegis thread. */
export class KimiThreadBindingError extends Error {
  constructor(serverSessionId: string, boundThreadId: string) {
    super(
      `Kimi session "${serverSessionId}" is already bound to thread "${boundThreadId}". ` +
        'A server session can only drive one Aegis thread at a time.'
    );
    this.name = 'KimiThreadBindingError';
  }
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: true,
  skillDiscovery: true,
  pluginDiscovery: false,
  mcpServers: true,
  imageAttachments: true,
  forkThread: true,
  compactThread: true,
  planMode: true,
};

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * UI mapping pinned by the plan: default→manual, plan→manual+plan_mode,
 * auto→auto, yolo→yolo. (Server modes are `manual | yolo | auto`.)
 */
export function mapKimiPermissionMode(mode: KimiPermissionMode | undefined): {
  permission_mode: 'manual' | 'auto' | 'yolo';
  plan_mode: boolean;
} {
  switch (mode) {
    case 'auto':
      return { permission_mode: 'auto', plan_mode: false };
    case 'yolo':
      return { permission_mode: 'yolo', plan_mode: false };
    case 'plan':
      return { permission_mode: 'manual', plan_mode: true };
    case 'default':
    default:
      return { permission_mode: 'manual', plan_mode: false };
  }
}

type ServerContentBlock = Record<string, unknown>;

function buildContentBlocks(prompt: string, attachments?: Attachment[]): ServerContentBlock[] {
  const blocks: ServerContentBlock[] = [];
  if (prompt.trim()) {
    blocks.push({ type: 'text', text: prompt });
  }
  for (const attachment of attachments || []) {
    if (attachment.kind === 'image') {
      try {
        blocks.push({
          type: 'image',
          mimeType: attachment.mimeType || 'image/png',
          data: readFileSync(attachment.path).toString('base64'),
        });
      } catch {
        blocks.push({ type: 'text', text: `Image attachment could not be read: ${attachment.path}` });
      }
      continue;
    }
    if (attachment.previewText?.trim()) {
      blocks.push({
        type: 'text',
        text: `Attachment: ${attachment.name}\nPath: ${attachment.path}\n\n${attachment.previewText}`,
      });
    } else {
      blocks.push({ type: 'text', text: `Attachment available on disk: ${attachment.path}` });
    }
  }
  return blocks;
}

interface StreamingText {
  uuid: string;
  text: string;
  createdAt: number;
}

interface PendingInteraction {
  requestId: string;
  kind: 'approval' | 'question';
  serverInteractionId: string;
  threadId: string;
}

interface ActiveServerSession {
  threadId: string;
  providerSessionId: string;
  generation: number;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  permissionMode?: KimiPermissionMode;
  thinking?: KimiThinking;
  activeTurn: boolean;
  currentAssistant?: StreamingText;
  currentThinking?: { uuid: string; thinking: string; createdAt: number };
  emittedToolCalls: Set<string>;
  /** approval_id/tool_call_id dedupe across the near-duplicate frame pair. */
  seenInteractionIds: Set<string>;
  pendingInteractions: Map<string, PendingInteraction>;
  lastContext: { contextTokens: number; maxContextTokens: number };
  /** Per-turn token accumulation from `turn.step.completed.usage` — the sole
   * usage source (REST session fields are stubbed). Feeds the result message
   * so the Settings usage report can aggregate kimi consumption. */
  turnUsage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  pendingManualCompact: boolean;
  /** The current turn already surfaced an error event (P0-1 dedupe). */
  reportedTurnError: boolean;
  stopRequest: { timer: ReturnType<typeof setTimeout> } | null;
}

export class KimiServerAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'kimi';
  readonly displayName = 'Kimi Code (server)';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  readonly manager: KimiServerManager;

  private sessions = new Map<string, ActiveServerSession>();
  private sessionsByServerId = new Map<string, string>();
  private defaultModel: string | null = null;
  private skillsCache = new Map<string, { skills: ProviderSkillDescriptor[]; fetchedAt: number }>();
  private readonly skillsCacheTtlMs = envInt('AEGIS_KIMI_SERVER_SKILLS_CACHE_MS', 30_000);
  private readonly stopConfirmTimeoutMs = envInt('AEGIS_KIMI_SERVER_STOP_CONFIRM_TIMEOUT_MS', 5_000);

  constructor(transport: KimiServerTransport = {}) {
    this.manager = new KimiServerManager(transport);
    this.manager.on('session_event', ({ sessionId, frame }: { sessionId: string; frame: KimiWsFrame }) => {
      this.handleSessionFrame(sessionId, frame);
    });
    this.manager.on('daemon_exit', ({ generation }: { generation: number }) => {
      this.handleDaemonExit(generation);
    });
    this.manager.on('session_gone', ({ sessionId }: { sessionId: string }) => {
      this.handleSessionGone(sessionId);
    });
    this.manager.on('resync_required', ({ sessionId }: { sessionId: string }) => {
      void this.handleResync(sessionId);
    });
  }

  // ── ProviderAdapter surface ───────────────────────────────────────────────

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: 'kimi',
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
    };
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    await this.manager.ensureDaemon();
    const generation = this.manager.getGeneration();

    let providerSessionId = '';
    let resumeFallbackReason: string | null = null;

    if (input.resumeSessionId) {
      // One-owner guard: durable multi-client sessions make double-binding
      // MORE likely — refuse to bind an id already driving a live thread.
      const boundThreadId = this.sessionsByServerId.get(input.resumeSessionId);
      if (boundThreadId && boundThreadId !== input.threadId) {
        throw new KimiThreadBindingError(input.resumeSessionId, boundThreadId);
      }
      const subscribed = await this.manager.subscribeSession(input.resumeSessionId);
      if (subscribed.accepted) {
        providerSessionId = input.resumeSessionId;
      } else {
        // Pinned: a not_found subscribe never yields events later. Recreate
        // and make the context break visible (codex P0-5 pattern).
        this.manager.unsubscribeSession(input.resumeSessionId);
        resumeFallbackReason = 'the server no longer has this session';
      }
    }

    if (!providerSessionId) {
      const created = await this.manager.createSession(input.cwd);
      providerSessionId = created.id;
      const subscribed = await this.manager.subscribeSession(providerSessionId);
      if (!subscribed.accepted) {
        throw new KimiServerTransportError(
          'daemon_unavailable',
          `freshly created session ${providerSessionId} was not accepted for subscription`
        );
      }
    }

    const model = input.model?.trim() || (await this.resolveDefaultModel()) || undefined;
    const session: ActiveServerSession = {
      threadId: input.threadId,
      providerSessionId,
      generation,
      status: 'running',
      cwd: input.cwd,
      model,
      permissionMode: input.kimiPermissionMode,
      thinking: input.kimiThinking,
      activeTurn: false,
      emittedToolCalls: new Set(),
      seenInteractionIds: new Set(),
      pendingInteractions: new Map(),
      lastContext: { contextTokens: 0, maxContextTokens: 0 },
      turnUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      pendingManualCompact: false,
      reportedTurnError: false,
      stopRequest: null,
    };
    this.sessions.set(input.threadId, session);
    this.sessionsByServerId.set(providerSessionId, input.threadId);

    this.emit({ type: 'system_init', threadId: input.threadId, sessionId: providerSessionId, model });

    // Composer slash catalog (non-blocking): the server has no commands
    // endpoint, so the list is /compact (adapter-routed) + the session's
    // skills, matching the ACP runtime's `skill:<name>` convention.
    void this.publishAvailableCommands(session);

    if (resumeFallbackReason) {
      this.emitLocalNotice(
        input.threadId,
        `Could not restore the previous Kimi session (${resumeFallbackReason}). Continuing in a new session without prior context.`
      );
    }

    if (input.prompt || input.attachments?.length) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model || model,
        kimiPermissionMode: input.kimiPermissionMode,
        kimiThinking: input.kimiThinking,
      });
    }

    return {
      threadId: input.threadId,
      provider: 'kimi',
      providerSessionId,
      status: 'running',
      model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No Kimi server session found for thread "${input.threadId}"`);
    }
    if (session.generation !== this.manager.getGeneration()) {
      throw new KimiServerTransportError('stale_generation', 'sendTurn');
    }

    if (input.kimiPermissionMode) {
      session.permissionMode = input.kimiPermissionMode;
    }
    if (input.kimiThinking) {
      session.thinking = input.kimiThinking;
    }

    session.status = 'running';
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    // `/compact` routes to the dedicated action; completion is signaled by
    // `event.session.history_compacted`, which settles the turn.
    if (input.prompt.trim() === '/compact' && !input.attachments?.length) {
      session.pendingManualCompact = true;
      try {
        await this.manager.compactSession(session.providerSessionId);
      } catch (error) {
        session.pendingManualCompact = false;
        this.failTurn(session, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // Per-turn model switch is one call: always pass `model` (a fresh server
    // session has none and does NOT inherit config default_model).
    const model = input.model?.trim() || session.model || (await this.resolveDefaultModel());
    if (!model) {
      this.failTurn(session, 'No Kimi model is configured. Pick a model and retry.');
      return;
    }
    session.model = model;

    const { permission_mode, plan_mode } = mapKimiPermissionMode(session.permissionMode);
    const wasActive = session.activeTurn;
    let submitted: { prompt_id: string; status: string };
    try {
      submitted = await this.manager.submitPrompt(session.providerSessionId, {
        content: buildContentBlocks(input.prompt, input.attachments),
        model,
        permission_mode,
        plan_mode,
        // Effort tier string, validated per-model server-side. Unset keeps
        // the server's per-model default (thinking models default to on).
        ...(session.thinking ? { thinking: session.thinking } : {}),
      });
    } catch (error) {
      this.failTurn(session, error instanceof Error ? error.message : String(error));
      return;
    }

    // Codex-style steer: a send landing mid-turn merges into the running turn
    // instead of waiting in the queue. The 40402 race (turn ended first) is
    // benign — the prompt auto-runs from the queue.
    if (submitted.status === 'queued' && wasActive && submitted.prompt_id) {
      try {
        await this.manager.steerPrompts(session.providerSessionId, [submitted.prompt_id]);
      } catch (error) {
        console.warn('[KimiServerAdapter] steer failed; prompt stays queued:', error);
      }
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      // Nothing to stop — settle immediately so the ipc gate can't hang.
      this.emit({
        type: 'stop_settled',
        threadId,
        providerThreadId: '',
        generation: this.manager.getGeneration(),
        confirmed: true,
        noTurn: true,
      });
      return;
    }

    if (!session.activeTurn || session.generation !== this.manager.getGeneration()) {
      this.settleStop(session, true, true);
      return;
    }

    if (session.stopRequest) return; // stop already in flight
    const timer = setTimeout(() => {
      // Safety net: the cancel confirmation never arrived.
      const current = this.sessions.get(threadId);
      if (current === session && session.stopRequest) {
        this.settleStop(session, false, false);
      }
    }, this.stopConfirmTimeoutMs);
    timer.unref?.();
    session.stopRequest = { timer };

    try {
      await this.manager.abortSession(session.providerSessionId);
    } catch (error) {
      // Abort failed (daemon dead / stale) — settle unconfirmed now.
      const current = this.sessions.get(threadId);
      if (current === session && session.stopRequest) {
        this.settleStop(session, false, false);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const session of Array.from(this.sessions.values())) {
      if (session.activeTurn) {
        try {
          await this.manager.abortSession(session.providerSessionId);
        } catch {
          // daemon may already be gone
        }
      }
      this.releaseSession(session);
    }
    await this.manager.stop();
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      threadId: session.threadId,
      provider: 'kimi',
      providerSessionId: session.providerSessionId,
      status: session.status,
      model: session.model,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async respondToRequest(threadId: string, requestId: string, decision: PermissionResult): Promise<void> {
    const session = this.sessions.get(threadId);
    const pending = session?.pendingInteractions.get(requestId);
    if (!session || !pending) {
      // Fail-closed routing (codex P0-7): unroutable decisions are dropped —
      // the server-side approval times out/expires rather than being granted
      // by the wrong thread.
      return;
    }
    session.pendingInteractions.delete(requestId);

    if (pending.kind === 'question') {
      const optionId = getString(decision.updatedInput?.optionId);
      try {
        if (decision.behavior === 'allow' && optionId) {
          await this.manager.resolveQuestion(session.providerSessionId, pending.serverInteractionId, {
            selected_label: optionId,
          });
        } else {
          await this.manager.request(
            'POST',
            `/sessions/${session.providerSessionId}/questions/${pending.serverInteractionId}:dismiss`
          );
        }
      } catch (error) {
        console.warn('[KimiServerAdapter] question resolution failed:', error);
      }
      return;
    }

    const optionId = getString(decision.updatedInput?.optionId);
    const approve = decision.behavior === 'allow';
    await this.manager.resolveApproval(session.providerSessionId, pending.serverInteractionId, {
      decision: approve ? 'approved' : 'rejected',
      ...(approve && optionId === 'approved_session' ? { scope: 'session' as const } : {}),
      ...(decision.message ? { feedback: decision.message } : {}),
    });
  }

  async forkThread(input: { cwd: string; providerThreadId: string }): Promise<string> {
    return this.manager.forkSession(input.providerThreadId);
  }

  /**
   * Session-independent skill listing for the composer (the NewSessionView
   * and pre-first-turn composers have no session catalog to read). Prefers
   * the workspace-scoped route matched by cwd; falls back to a throwaway
   * session (archived afterwards) when the cwd has no workspace yet.
   */
  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    const cwd = input.cwd?.trim() || process.cwd();
    const cached = this.skillsCache.get(cwd);
    if (!input.forceReload && cached && Date.now() - cached.fetchedAt < this.skillsCacheTtlMs) {
      return { skills: cached.skills, source: 'kimi-server', cached: true };
    }

    await this.manager.ensureDaemon();
    let raw: Array<Record<string, unknown>> = [];
    const workspaces = await this.manager.listWorkspaces();
    const workspace =
      workspaces.find((entry) => getString(entry.root) === cwd) ||
      // Skills are predominantly global (~/.kimi-code/skills + builtins);
      // any workspace lists them when this cwd has none yet.
      workspaces[0];
    if (workspace && getString(workspace.id)) {
      raw = await this.manager.listWorkspaceSkills(getString(workspace.id));
    } else {
      const { id } = await this.manager.createSession(cwd);
      try {
        raw = await this.manager.listSessionSkills(id);
      } finally {
        await this.manager.archiveSession(id).catch(() => {});
      }
    }

    const skills: ProviderSkillDescriptor[] = raw
      .map((skill): ProviderSkillDescriptor | null => {
        const name = getString(skill.name);
        if (!name) return null;
        return {
          name,
          description: getString(skill.description) || undefined,
          path: getString(skill.path),
          enabled: true,
          scope: getString(skill.source) || undefined,
        };
      })
      .filter((skill): skill is ProviderSkillDescriptor => Boolean(skill));

    this.skillsCache.set(cwd, { skills, fetchedAt: Date.now() });
    return { skills, source: 'kimi-server', cached: false };
  }

  async runOneShot(
    input: ProviderSessionStartInput
  ): Promise<{ text: string; sessionId?: string; model?: string }> {
    await this.manager.ensureDaemon();
    const { id } = await this.manager.createSession(input.cwd);
    const model = input.model?.trim() || (await this.resolveDefaultModel());
    if (!model) {
      throw new Error('No Kimi model is configured for one-shot prompts.');
    }
    try {
      const subscribed = await this.manager.subscribeSession(id);
      if (!subscribed.accepted) {
        throw new Error('Kimi server did not accept the one-shot session subscription.');
      }

      let text = '';
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Kimi one-shot prompt timed out.'));
        }, 300_000);
        timer.unref?.();
        const onFrame = ({ sessionId, frame }: { sessionId: string; frame: KimiWsFrame }) => {
          if (sessionId !== id) return;
          const payload = isRecord(frame.payload) ? frame.payload : {};
          if (frame.type === 'assistant.delta') {
            text += getString(payload.delta);
            return;
          }
          if (frame.type === 'turn.ended') {
            cleanup();
            if (getString(payload.reason) === 'completed') {
              resolve();
            } else {
              reject(new Error(`Kimi one-shot turn ended with reason "${getString(payload.reason)}".`));
            }
          }
        };
        const onExit = () => {
          cleanup();
          reject(new Error('Kimi server exited during the one-shot prompt.'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          this.manager.off('session_event', onFrame);
          this.manager.off('daemon_exit', onExit);
        };
        this.manager.on('session_event', onFrame);
        this.manager.on('daemon_exit', onExit);
      });

      await this.manager.submitPrompt(id, {
        content: buildContentBlocks(input.prompt, input.attachments),
        model,
        permission_mode: 'auto',
        plan_mode: false,
      });
      await done;
      return { text: text.trim(), sessionId: id, model };
    } finally {
      this.manager.unsubscribeSession(id);
      // The server session store is persistent — a one-shot per title
      // generation would litter it without this.
      await this.manager.archiveSession(id).catch(() => {});
    }
  }

  // ── Frame handling ────────────────────────────────────────────────────────

  private handleSessionFrame(serverSessionId: string, frame: KimiWsFrame): void {
    const threadId = this.sessionsByServerId.get(serverSessionId);
    if (!threadId) return;
    const session = this.sessions.get(threadId);
    if (!session || session.providerSessionId !== serverSessionId) return;

    const payload = isRecord(frame.payload) ? frame.payload : {};
    switch (frame.type) {
      case 'turn.started':
        session.activeTurn = true;
        session.reportedTurnError = false;
        session.turnUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        break;
      case 'assistant.delta':
        this.appendAssistantText(session, getString(payload.delta));
        break;
      case 'thinking.delta':
        this.appendThinking(session, getString(payload.delta) || getString(payload.thinking));
        break;
      case 'tool.call.started':
        this.emitToolCall(session, payload);
        break;
      case 'tool.result':
        this.emitToolResult(session, payload);
        break;
      case 'turn.step.completed':
        this.emitTokenUsage(session, payload);
        break;
      case 'agent.status.updated':
        this.absorbAgentStatus(session, payload);
        break;
      case 'turn.ended':
        this.handleTurnEnded(session, payload);
        break;
      case 'error':
        this.handleErrorFrame(session, payload);
        break;
      case 'event.approval.requested':
      case 'permission.approval.requested':
        this.handleApprovalRequested(session, frame.type, payload);
        break;
      case 'event.approval.resolved':
      case 'permission.approval.resolved':
        this.handleApprovalResolved(session, payload);
        break;
      case 'event.question.requested':
        this.handleQuestionRequested(session, payload);
        break;
      case 'event.question.resolved':
      case 'event.question.dismissed':
        this.handleQuestionResolved(session, payload);
        break;
      case 'event.session.history_compacted':
        this.handleHistoryCompacted(session, payload);
        break;
      default:
        // prompt.completed/aborted are queue bookkeeping; context.spliced,
        // session.meta.updated, work_changed and volatile phase frames carry
        // nothing the transcript needs.
        break;
    }
  }

  private appendAssistantText(session: ActiveServerSession, delta: string): void {
    if (!delta) return;
    const current = session.currentAssistant || {
      uuid: `kimi-assistant:${session.threadId}:${uuidv4()}`,
      text: '',
      createdAt: Date.now(),
    };
    current.text += delta;
    session.currentAssistant = current;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: current.uuid,
        createdAt: current.createdAt,
        streaming: true,
        message: { content: [{ type: 'text', text: current.text }] },
      },
    });
  }

  private appendThinking(session: ActiveServerSession, delta: string): void {
    if (!delta) return;
    const current = session.currentThinking || {
      uuid: `kimi-thinking:${session.threadId}:${uuidv4()}`,
      thinking: '',
      createdAt: Date.now(),
    };
    current.thinking += delta;
    session.currentThinking = current;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: current.uuid,
        createdAt: current.createdAt,
        streaming: true,
        message: { content: [{ type: 'thinking', thinking: current.thinking }] },
      },
    });
  }

  private finalizeStreaming(session: ActiveServerSession): void {
    if (session.currentThinking) {
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'assistant',
          uuid: session.currentThinking.uuid,
          createdAt: session.currentThinking.createdAt,
          message: { content: [{ type: 'thinking', thinking: session.currentThinking.thinking }] },
        },
      });
      session.currentThinking = undefined;
    }
    if (session.currentAssistant) {
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'assistant',
          uuid: session.currentAssistant.uuid,
          createdAt: session.currentAssistant.createdAt,
          message: { content: [{ type: 'text', text: session.currentAssistant.text }] },
        },
      });
      session.currentAssistant = undefined;
    }
  }

  private emitToolCall(session: ActiveServerSession, payload: Record<string, unknown>): void {
    const toolCallId = getString(payload.toolCallId);
    if (!toolCallId || session.emittedToolCalls.has(toolCallId)) return;
    session.emittedToolCalls.add(toolCallId);
    // A tool call closes the current text/thinking block in the stream.
    this.finalizeStreaming(session);
    const name = getString(payload.name) || 'KimiTool';
    const args = isRecord(payload.args) ? payload.args : {};
    const description = getString(payload.description);
    const input: Record<string, unknown> = { ...args };
    if (description) {
      input.__aegisDisplayTitle = description;
    }
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `kimi-tool-use:${session.threadId}:${toolCallId}`,
        message: { content: [{ type: 'tool_use', id: toolCallId, name, input }] },
      },
    });
  }

  private emitToolResult(session: ActiveServerSession, payload: Record<string, unknown>): void {
    const toolCallId = getString(payload.toolCallId);
    if (!toolCallId) return;
    const output = payload.output;
    const isError = payload.is_error === true || Boolean(payload.error);
    const content =
      typeof output === 'string'
        ? output
        : output !== undefined
          ? JSON.stringify(output)
          : getString(payload.error) || 'Done';
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'user',
        uuid: `kimi-tool-result:${session.threadId}:${toolCallId}`,
        message: {
          content: [{ type: 'tool_result', tool_use_id: toolCallId, content, is_error: isError }],
        },
      },
    });
  }

  /**
   * Usage/context flow ONLY from WS (`turn.step.completed.usage` + the
   * volatile `agent.status.updated` context ring) — the REST session-list
   * fields are stubbed in 0.26.0 (C1).
   *
   * The uuid is stable PER TURN (not per session): steps within a turn
   * overwrite one message (smooth ring, no row spam), and each finished
   * turn leaves exactly one persisted row carrying the turn's cumulative
   * tokens + the context watermark — an append-only per-turn usage
   * timeline instead of a single last-step snapshot.
   */
  private emitTokenUsage(session: ActiveServerSession, payload: Record<string, unknown>): void {
    const usage = isRecord(payload.usage) ? payload.usage : {};
    session.turnUsage.input += getNumber(usage.inputOther);
    session.turnUsage.output += getNumber(usage.output);
    session.turnUsage.cacheRead += getNumber(usage.inputCacheRead);
    session.turnUsage.cacheCreation += getNumber(usage.inputCacheCreation);
    const { contextTokens, maxContextTokens } = session.lastContext;
    const turnId = typeof payload.turnId === 'number' ? payload.turnId : 'active';
    const message: StreamMessage = {
      type: 'system',
      subtype: 'token_usage',
      uuid: `kimi-token-usage-${session.threadId}:${turnId}`,
      session_id: session.threadId,
      provider: 'kimi',
      usage: {
        inputTokens: session.turnUsage.input,
        cachedInputTokens: session.turnUsage.cacheRead,
        outputTokens: session.turnUsage.output,
        reasoningOutputTokens: 0,
        totalTokens: contextTokens,
        contextWindow: maxContextTokens,
      },
    };
    this.emit({ type: 'message', threadId: session.threadId, message });
  }

  private absorbAgentStatus(session: ActiveServerSession, payload: Record<string, unknown>): void {
    if (typeof payload.contextTokens === 'number') {
      session.lastContext.contextTokens = payload.contextTokens;
    }
    if (typeof payload.maxContextTokens === 'number') {
      session.lastContext.maxContextTokens = payload.maxContextTokens;
    }
    const model = getString(payload.model);
    if (model) {
      session.model = model;
    }
  }

  /**
   * Turn-terminal invariant: `turn.ended` is the SOLE terminal source —
   * exactly one result per turn; on `failed` the error event precedes the
   * error result; no second success channel may overwrite a failure (P0-1).
   */
  private handleTurnEnded(session: ActiveServerSession, payload: Record<string, unknown>): void {
    const reason = getString(payload.reason);
    session.activeTurn = false;
    this.finalizeStreaming(session);

    if (reason === 'failed') {
      session.status = 'error';
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
      const error = payload.error;
      const errorText = isRecord(error)
        ? getString(error.message) || getString(error.code) || 'Kimi turn failed'
        : getString(error) || 'Kimi turn failed';
      if (!session.reportedTurnError) {
        session.reportedTurnError = true;
        this.emit({ type: 'error', threadId: session.threadId, error: new Error(errorText) });
      }
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'result',
          subtype: 'error',
          duration_ms: getNumber(payload.durationMs),
          total_cost_usd: 0,
          usage: this.buildTurnUsage(session),
          model: session.model,
        },
      });
      this.settleStopIfPending(session, true);
      return;
    }

    // completed & cancelled both end as a success result; cancelled is the
    // stop-confirmation terminal.
    session.status = 'completed';
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'result',
        subtype: 'success',
        duration_ms: getNumber(payload.durationMs),
        total_cost_usd: 0,
        usage: this.buildTurnUsage(session),
        model: session.model,
      },
    });
    if (reason === 'cancelled') {
      this.settleStopIfPending(session, true);
    }
  }

  /**
   * The turn's accumulated tokens in the Claude result shape — this is what
   * the Settings usage report aggregates per provider (cost stays 0: the
   * server reports no per-turn cost, and the stubbed REST fields don't
   * either).
   */
  private buildTurnUsage(session: ActiveServerSession) {
    return {
      input_tokens: session.turnUsage.input,
      output_tokens: session.turnUsage.output,
      cache_read_input_tokens: session.turnUsage.cacheRead,
      cache_creation_input_tokens: session.turnUsage.cacheCreation,
    };
  }

  private handleErrorFrame(session: ActiveServerSession, payload: Record<string, unknown>): void {
    const message = getString(payload.message) || getString(payload.error) || 'Kimi server reported an error';
    session.reportedTurnError = true;
    this.emit({ type: 'error', threadId: session.threadId, error: new Error(message) });
  }

  private handleApprovalRequested(
    session: ActiveServerSession,
    frameType: string,
    payload: Record<string, unknown>
  ): void {
    // The server pushes TWO near-duplicate frames per request; dedupe on the
    // shared id (approval_id === tool_call_id).
    const approvalId =
      getString(payload.approval_id) || getString(payload.toolCallId) || getString(payload.tool_call_id);
    if (!approvalId || session.seenInteractionIds.has(approvalId)) return;
    session.seenInteractionIds.add(approvalId);

    const toolName = getString(payload.toolName) || getString(payload.tool_name) || 'KimiTool';
    const action = getString(payload.action) || `${toolName} approval request`;
    const display = isRecord(payload.display)
      ? payload.display
      : isRecord(payload.tool_input_display)
        ? payload.tool_input_display
        : {};
    const toolInput = isRecord(payload.toolInput) ? payload.toolInput : display;

    const options: AcpPermissionOption[] = [
      { optionId: 'approved', name: 'Allow', kind: 'allow_once' },
      { optionId: 'approved_session', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'rejected', name: 'Reject', kind: 'reject_once' },
    ];
    const requestId = `kimi-server-approval:${session.threadId}:${approvalId}`;
    session.pendingInteractions.set(requestId, {
      requestId,
      kind: 'approval',
      serverInteractionId: approvalId,
      threadId: session.threadId,
    });

    const input: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'kimi',
      question: action,
      title: action,
      toolName,
      options,
      toolCall: { title: action, toolCallId: approvalId, rawInput: toolInput, display },
    };
    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId,
      toolName,
      input,
    });
  }

  private handleApprovalResolved(session: ActiveServerSession, payload: Record<string, unknown>): void {
    const approvalId =
      getString(payload.approval_id) || getString(payload.toolCallId) || getString(payload.tool_call_id);
    if (!approvalId) return;
    session.seenInteractionIds.delete(approvalId);
    const requestId = `kimi-server-approval:${session.threadId}:${approvalId}`;
    if (session.pendingInteractions.delete(requestId)) {
      // Another client answered (sessions are multi-client) — drop the card.
      this.emit({ type: 'permission_dismissed', threadId: session.threadId, requestId });
    }
  }

  private handleQuestionRequested(session: ActiveServerSession, payload: Record<string, unknown>): void {
    const questionId = getString(payload.question_id) || getString(payload.id);
    if (!questionId || session.seenInteractionIds.has(`q:${questionId}`)) return;
    session.seenInteractionIds.add(`q:${questionId}`);

    const question = getString(payload.question) || getString(payload.title) || 'Kimi has a question';
    const rawOptions = Array.isArray(payload.options) ? payload.options : [];
    const options: AcpPermissionOption[] = rawOptions
      .map((option): AcpPermissionOption | null => {
        if (typeof option === 'string') {
          return { optionId: option, name: option };
        }
        if (isRecord(option)) {
          const label = getString(option.label) || getString(option.name) || getString(option.id);
          if (!label) return null;
          return { optionId: label, name: label, description: getString(option.description) || undefined };
        }
        return null;
      })
      .filter((option): option is AcpPermissionOption => Boolean(option));

    const requestId = `kimi-server-question:${session.threadId}:${questionId}`;
    session.pendingInteractions.set(requestId, {
      requestId,
      kind: 'question',
      serverInteractionId: questionId,
      threadId: session.threadId,
    });
    const input: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'kimi',
      question,
      title: question,
      toolName: 'Question',
      options,
      toolCall: payload,
    };
    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId,
      toolName: 'Question',
      input,
    });
  }

  private handleQuestionResolved(session: ActiveServerSession, payload: Record<string, unknown>): void {
    const questionId = getString(payload.question_id) || getString(payload.id);
    if (!questionId) return;
    session.seenInteractionIds.delete(`q:${questionId}`);
    const requestId = `kimi-server-question:${session.threadId}:${questionId}`;
    if (session.pendingInteractions.delete(requestId)) {
      this.emit({ type: 'permission_dismissed', threadId: session.threadId, requestId });
    }
  }

  private handleHistoryCompacted(session: ActiveServerSession, payload: Record<string, unknown>): void {
    const manual = session.pendingManualCompact;
    session.pendingManualCompact = false;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: uuidv4(),
        session_id: session.threadId,
        compactMetadata: {
          trigger: manual ? 'manual' : 'auto',
          preTokens: session.lastContext.contextTokens || 0,
        },
      },
    });
    if (manual) {
      // A manual /compact runs outside a model turn: settle the UI turn here.
      session.status = 'completed';
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'result',
          subtype: 'success',
          duration_ms: 0,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
  }

  // ── Failure domains ───────────────────────────────────────────────────────

  private handleDaemonExit(generation: number): void {
    for (const session of Array.from(this.sessions.values())) {
      if (session.generation !== generation) continue;
      this.finalizeStreaming(session);
      this.dismissPendingInteractions(session);
      this.settleStopIfPending(session, false);
      session.status = 'error';
      session.activeTurn = false;
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
      this.emit({
        type: 'error',
        threadId: session.threadId,
        error: new Error('The Kimi server exited. The session can be resumed once it restarts.'),
      });
      // Sessions recover only via server persistence + resubscribe: release
      // the binding so the next start goes down the resume path.
      this.releaseSession(session);
    }
  }

  private handleSessionGone(serverSessionId: string): void {
    const threadId = this.sessionsByServerId.get(serverSessionId);
    if (!threadId) return;
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.finalizeStreaming(session);
    this.dismissPendingInteractions(session);
    this.settleStopIfPending(session, false);
    this.emitLocalNotice(
      threadId,
      'The Kimi server no longer has this session. Start a new turn to continue in a fresh session.'
    );
    session.status = 'error';
    session.activeTurn = false;
    this.emit({ type: 'status_change', threadId, status: 'error' });
    this.releaseSession(session);
  }

  /**
   * The event buffer could not replay a gap: do NOT re-emit the transcript.
   * Finalize open accumulators, reconcile tool calls we never saw via
   * GET /messages (keyed by tool_call ids), and surface a visible notice.
   */
  private async handleResync(serverSessionId: string): Promise<void> {
    const threadId = this.sessionsByServerId.get(serverSessionId);
    if (!threadId) return;
    const session = this.sessions.get(threadId);
    if (!session) return;

    this.finalizeStreaming(session);
    let reconciled = true;
    try {
      const messages = await this.manager.getMessages(serverSessionId);
      for (const message of messages) {
        const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
        for (const call of toolCalls) {
          if (!isRecord(call)) continue;
          const toolCallId = getString(call.id) || getString(call.toolCallId);
          if (!toolCallId || session.emittedToolCalls.has(toolCallId)) continue;
          reconciled = false;
        }
      }
    } catch {
      reconciled = false;
    }
    if (!reconciled) {
      this.emitLocalNotice(
        threadId,
        'The Kimi event stream was resynchronized; some intermediate output may not be shown.'
      );
    }
  }

  // ── Stop plumbing ─────────────────────────────────────────────────────────

  private settleStopIfPending(session: ActiveServerSession, confirmed: boolean): void {
    if (!session.stopRequest) return;
    this.settleStop(session, confirmed, false);
  }

  private settleStop(session: ActiveServerSession, confirmed: boolean, noTurn: boolean): void {
    if (session.stopRequest) {
      clearTimeout(session.stopRequest.timer);
      session.stopRequest = null;
    }
    const { threadId, providerSessionId, generation } = session;
    this.dismissPendingInteractions(session);
    this.finalizeStreaming(session);
    this.releaseSession(session);
    this.emit({
      type: 'stop_settled',
      threadId,
      providerThreadId: providerSessionId,
      generation,
      confirmed,
      ...(noTurn ? { noTurn: true } : {}),
    });
  }

  private dismissPendingInteractions(session: ActiveServerSession): void {
    for (const pending of session.pendingInteractions.values()) {
      this.emit({
        type: 'permission_dismissed',
        threadId: session.threadId,
        requestId: pending.requestId,
      });
    }
    session.pendingInteractions.clear();
  }

  private releaseSession(session: ActiveServerSession): void {
    if (session.stopRequest) {
      clearTimeout(session.stopRequest.timer);
      session.stopRequest = null;
    }
    this.manager.unsubscribeSession(session.providerSessionId);
    if (this.sessionsByServerId.get(session.providerSessionId) === session.threadId) {
      this.sessionsByServerId.delete(session.providerSessionId);
    }
    this.sessions.delete(session.threadId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Emit the composer's slash-command catalog. NOT the ACP builtin list:
   * the server does not parse slash text in prompts (probed — `/help` goes
   * straight to the model), so only commands this adapter routes (`/compact`)
   * plus `skill:<name>` entries (KimiCore expands those inside the turn —
   * verified live) are advertised.
   */
  private async publishAvailableCommands(session: ActiveServerSession): Promise<void> {
    let skills: Array<Record<string, unknown>> = [];
    try {
      skills = await this.manager.listSessionSkills(session.providerSessionId);
    } catch (error) {
      console.warn('[KimiServerAdapter] skill listing failed; slash catalog stays minimal:', error);
    }
    // The session may have been released/replaced while we were fetching.
    if (this.sessions.get(session.threadId) !== session) return;

    const availableCommands = [
      { name: 'compact', description: 'Compact the conversation context' },
      ...skills
        .map((skill) => {
          const name = getString(skill.name);
          if (!name) return null;
          return {
            name: `skill:${name}`,
            description: getString(skill.description),
          };
        })
        .filter((command): command is { name: string; description: string } => Boolean(command)),
    ];
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'available_commands_update',
        session_id: session.providerSessionId,
        availableCommands,
      },
    });
  }

  private async resolveDefaultModel(): Promise<string | null> {
    if (this.defaultModel) return this.defaultModel;
    try {
      this.defaultModel = await this.manager.getDefaultModel();
    } catch {
      this.defaultModel = null;
    }
    return this.defaultModel;
  }

  private failTurn(session: ActiveServerSession, message: string): void {
    session.status = 'error';
    this.emit({ type: 'error', threadId: session.threadId, error: new Error(message) });
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'result',
        subtype: 'error',
        duration_ms: 0,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
  }

  private emitLocalNotice(threadId: string, text: string): void {
    this.emit({
      type: 'message',
      threadId,
      message: {
        type: 'assistant',
        uuid: uuidv4(),
        message: { content: [{ type: 'text', text }] },
      },
    });
  }

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }
}
