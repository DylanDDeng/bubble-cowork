import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type {
  AcpPermissionInput,
  AskUserQuestionInput,
  Attachment,
  BubblePermissionMode,
  ContentBlock,
  PermissionResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
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
  getBubbleSdk,
  type BubbleAgentEvent,
  type BubbleApprovalDecision,
  type BubbleApprovalRequest,
  type BubbleContentPart,
  type BubbleQuestionPrompt,
  type BubbleQuestionRequest,
  type BubbleSdkInstance,
  type BubbleTokenUsage,
} from './bubble-sdk-loader';

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: true,
  skillDiscovery: true,
  pluginDiscovery: false,
  mcpServers: true,
  imageAttachments: true,
  forkThread: false,
  compactThread: false,
  planMode: true,
};

type PendingBubbleRequest =
  | { kind: 'approval'; resolve: (decision: BubbleApprovalDecision) => void }
  | {
      kind: 'question';
      questions: BubbleQuestionPrompt[];
      resolve: (answers: string[][] | null) => void;
    }
  | { kind: 'plan'; resolve: (approved: boolean) => void };

type BubbleAssistantAccumulator = {
  uuid: string;
  text: string;
  thinking: string;
  createdAt: number;
};

type ActiveBubbleSession = {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  permissionMode?: BubblePermissionMode;
  /** Model context window from the provider registry (Bubble's turn usage carries none). */
  contextWindow?: number | null;
  turnActive: boolean;
  abortController: AbortController | null;
  pendingRequests: Map<string, PendingBubbleRequest>;
  currentAssistant: BubbleAssistantAccumulator | null;
  emittedToolCallIds: Set<string>;
  emittedToolResultIds: Set<string>;
  usage: Usage;
  durationStartMs: number;
  durationEndMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (!normalized) {
    return 'Tool';
  }
  const compact = normalized.replace(/[_\-\s]/g, '').toLowerCase();
  if (compact === 'bash' || compact === 'shell') return 'Bash';
  if (compact === 'read') return 'Read';
  if (compact === 'write') return 'Write';
  if (compact === 'edit') return 'Edit';
  if (compact === 'grep') return 'Grep';
  if (compact === 'glob') return 'Glob';
  if (compact === 'ls') return 'LS';
  if (compact === 'todowrite') return 'TodoWrite';
  if (compact === 'webfetch') return 'WebFetch';
  if (compact === 'websearch') return 'WebSearch';
  if (compact === 'question') return 'AskUserQuestion';
  if (compact === 'exitplanmode') return 'ExitPlanMode';
  return normalized;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

function usageFromBubble(
  usage: BubbleTokenUsage | undefined,
  contextWindow?: number | null
): Usage | null {
  if (!usage) {
    return null;
  }
  const input = Math.max(0, Math.round(getNumber(usage.promptTokens) || 0));
  const output = Math.max(0, Math.round(getNumber(usage.completionTokens) || 0));
  const cacheRead = Math.max(0, Math.round(getNumber(usage.promptCacheHitTokens) || 0));
  const cacheWrite = Math.max(0, Math.round(getNumber(usage.cacheCreationTokens) || 0));
  const total = getNumber(usage.totalTokens);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    total_tokens: total !== undefined ? Math.round(total) : input + output + cacheRead + cacheWrite,
    context_window: contextWindow || null,
  };
}

function addUsage(target: Usage, usage: Usage | null): void {
  if (!usage) {
    return;
  }
  target.input_tokens += usage.input_tokens || 0;
  target.output_tokens += usage.output_tokens || 0;
  target.cache_read_input_tokens =
    (target.cache_read_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  target.cache_creation_input_tokens =
    (target.cache_creation_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  target.total_tokens = (target.total_tokens || 0) + (usage.total_tokens || 0);
  if (usage.context_window) {
    target.context_window = usage.context_window;
  }
}

function createEmptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    context_window: null,
  };
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

// Bubble's ContentPart uses OpenAI-style image_url parts, so attachments are
// inlined as base64 data URLs.
async function buildPromptParts(
  text: string,
  attachments: Attachment[] | undefined
): Promise<string | BubbleContentPart[]> {
  const imageAttachments = attachments?.filter((attachment) => attachment.kind === 'image') || [];
  if (imageAttachments.length === 0) {
    return text;
  }
  const parts: BubbleContentPart[] = [];
  if (text.trim()) {
    parts.push({ type: 'text', text });
  }
  for (const attachment of imageAttachments) {
    const buffer = await readFile(attachment.path);
    const mimeType = attachment.mimeType || 'image/png';
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` },
    });
  }
  return parts;
}

function describeApproval(request: BubbleApprovalRequest): { toolName: string; question: string } {
  const type = getString(request.type);
  const path = getString(request.path);
  switch (type) {
    case 'bash': {
      const command = getString(request.command);
      return { toolName: 'Bash', question: command ? `Run command: ${command}` : 'Run a command' };
    }
    case 'edit':
      return { toolName: 'Edit', question: path ? `Edit ${path}` : 'Edit a file' };
    case 'write':
      return { toolName: 'Write', question: path ? `Write ${path}` : 'Write a file' };
    case 'patch': {
      const paths = Array.isArray(request.paths)
        ? request.paths.map((value) => getString(value)).filter(Boolean)
        : [];
      return {
        toolName: 'Edit',
        question: paths.length > 0 ? `Apply patch to ${paths.join(', ')}` : 'Apply a patch',
      };
    }
    case 'lsp':
      return {
        toolName: 'LSP',
        question: `Run LSP ${getString(request.operation) || 'operation'}${path ? ` on ${path}` : ''}`,
      };
    case 'agent_profile':
      return {
        toolName: 'AgentProfile',
        question: `Trust project agent profile "${getString(request.name) || 'unknown'}"`,
      };
    case 'external_tool':
      return {
        toolName: getString(request.title) || 'Tool',
        question: getString(request.title) || 'Run an external tool',
      };
    default:
      return { toolName: type || 'Tool', question: 'Bubble is requesting permission' };
  }
}

function buildApprovalInput(request: BubbleApprovalRequest): AcpPermissionInput {
  const { toolName, question } = describeApproval(request);
  return {
    kind: 'acp-permission',
    provider: 'bubble',
    question,
    title: question,
    toolName,
    options: [
      { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    toolCall: request,
  };
}

function buildQuestionInput(request: BubbleQuestionRequest): AskUserQuestionInput {
  return {
    questions: request.questions.map((question) => ({
      question: question.question,
      ...(question.header?.trim() ? { header: question.header.trim() } : {}),
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      })),
      ...(question.multiple === true ? { multiSelect: true } : {}),
    })),
  };
}

function splitQuestionAnswer(value: string): string[] {
  return value
    .split(',')
    .map((answer) => answer.trim())
    .filter(Boolean);
}

function buildQuestionAnswers(
  questions: BubbleQuestionPrompt[],
  decision: PermissionResult
): string[][] {
  const answers = isRecord(decision.updatedInput?.answers)
    ? (decision.updatedInput.answers as Record<string, unknown>)
    : null;
  return questions.map((question) => splitQuestionAnswer(getString(answers?.[question.question])));
}

export class BubbleSdkAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'bubble';
  readonly displayName = 'Bubble';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActiveBubbleSession>();

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const cwd = input.cwd || process.cwd();
    const sdk = await getBubbleSdk(cwd);
    this.assertConfigured(sdk);
    const providerSessionId = this.resolveSessionId(sdk, input.resumeSessionId, cwd);

    const session: ActiveBubbleSession = {
      threadId: input.threadId,
      providerSessionId,
      status: 'running',
      cwd,
      model: input.model?.trim() || undefined,
      permissionMode: input.bubblePermissionMode,
      turnActive: false,
      abortController: null,
      pendingRequests: new Map(),
      currentAssistant: null,
      emittedToolCallIds: new Set(),
      emittedToolResultIds: new Set(),
      usage: createEmptyUsage(),
      durationStartMs: Date.now(),
    };
    // Never orphan a previous session for the same thread — an undisposed
    // predecessor would leak its abort handle and pending approval cards.
    this.disposeSession(input.threadId);
    this.sessions.set(input.threadId, session);

    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: providerSessionId,
      model: session.model,
    });

    if (input.prompt || input.attachments?.length) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model,
        bubblePermissionMode: input.bubblePermissionMode,
      });
    }

    return {
      threadId: input.threadId,
      provider: 'bubble',
      providerSessionId,
      status: session.status,
      model: session.model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No Bubble session found for thread "${input.threadId}"`);
    }
    if (session.turnActive) {
      throw new Error(`Bubble is already running a turn for thread "${input.threadId}"`);
    }

    const text = buildPromptText(input.prompt, input.attachments);
    const prompt = await buildPromptParts(text, input.attachments);
    if (typeof prompt === 'string' && !prompt.trim()) {
      return;
    }

    if (input.model?.trim()) {
      session.model = input.model.trim();
    }
    if (input.bubblePermissionMode) {
      session.permissionMode = input.bubblePermissionMode;
    }
    session.status = 'running';
    session.turnActive = true;
    session.durationStartMs = Date.now();
    session.durationEndMs = undefined;
    session.usage = createEmptyUsage();
    session.currentAssistant = null;
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    // The turn loop consumes the runTurn generator for the whole turn; it
    // routes its own failures, so the floating promise never rejects.
    void this.runTurnLoop(session, prompt, session.model);
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    session.status = 'stopped';
    try {
      const sdk = await getBubbleSdk(session.cwd);
      // Aborting is safe: the SDK auto-rejects pending approvals/questions of
      // the aborted turn, so no adapter-side settlement is required beyond
      // clearing the UI cards below.
      sdk.stop(session.providerSessionId);
    } catch {
      // The SDK may not be loaded yet or the turn already idle.
    }
    session.abortController?.abort();
    this.dismissAllRequests(session);
    this.sessions.delete(threadId);
    this.emit({ type: 'status_change', threadId, status: 'stopped' });
  }

  disposeSession(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session) {
      return false;
    }
    // Map entry first so dispose stays idempotent even if teardown throws.
    this.sessions.delete(threadId);
    try {
      session.status = 'stopped';
      session.abortController?.abort();
      // Emits per-requestId permission_dismissed — the one emission dispose
      // allows (clears stranded cards; cannot be misread by stop gates).
      this.dismissAllRequests(session);
    } catch (error) {
      console.warn('[BubbleSdkAdapter] disposeSession cleanup failed:', error);
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
      provider: 'bubble',
      providerSessionId: session.providerSessionId,
      status: session.status,
      model: session.model,
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
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`No Bubble session found for thread "${threadId}"`);
    }
    const pending = session.pendingRequests.get(requestId);
    if (!pending) {
      // Stale card (already dismissed by stop/abort) — race-safe no-op.
      return;
    }
    session.pendingRequests.delete(requestId);

    if (pending.kind === 'approval') {
      pending.resolve(
        decision.behavior === 'allow'
          ? { action: 'approve', ...(decision.message ? { feedback: decision.message } : {}) }
          : { action: 'reject', feedback: decision.message?.trim() || 'Denied by user' }
      );
      return;
    }
    if (pending.kind === 'question') {
      pending.resolve(
        decision.behavior === 'allow' ? buildQuestionAnswers(pending.questions, decision) : null
      );
      return;
    }
    // Plan approval renders as a question card, so "Stay in plan mode" also
    // arrives as behavior:'allow' — only the explicit approve answer may exit
    // plan mode (mirrors the Claude runner's ExitPlanMode check).
    if (decision.behavior !== 'allow') {
      pending.resolve(false);
      return;
    }
    const answers = isRecord(decision.updatedInput?.answers)
      ? (decision.updatedInput.answers as Record<string, unknown>)
      : null;
    const selectedAnswer = answers
      ? Object.values(answers).find(
          (value): value is string => typeof value === 'string' && value.trim().length > 0
        ) || ''
      : '';
    pending.resolve(selectedAnswer === 'Approve and execute');
  }

  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    const sdk = await getBubbleSdk(input.cwd);
    const skills = sdk.listSkills(input.cwd);
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description || undefined,
        path: skill.name,
        enabled: true,
        scope: skill.source || undefined,
      })),
      source: 'bubble-sdk',
    };
  }

  // ── Turn loop ──────────────────────────────────────────────────────────

  private async runTurnLoop(
    session: ActiveBubbleSession,
    prompt: string | BubbleContentPart[],
    model: string | undefined
  ): Promise<void> {
    const abortController = new AbortController();
    session.abortController = abortController;
    try {
      const sdk = await getBubbleSdk(session.cwd);
      const stream = sdk.runTurn(session.providerSessionId, {
        prompt,
        ...(model ? { model } : {}),
        ...(session.permissionMode ? { mode: session.permissionMode } : {}),
        signal: abortController.signal,
        onStart: (info) => {
          session.model = info.model || session.model;
          // Bubble's TokenUsage has no context window; resolve it from the
          // registry catalog so the composer context indicator has a ceiling.
          void this.resolveContextWindow(session, info.providerId, info.model);
          this.emit({
            type: 'system_init',
            threadId: session.threadId,
            sessionId: session.providerSessionId,
            model: session.model,
          });
        },
        onApproval: (request) => this.requestApproval(session, request),
        onQuestion: (request) => this.requestQuestion(session, request),
        onPlanApproval: (planMarkdown) => this.requestPlanApproval(session, planMarkdown),
      });
      for await (const event of stream) {
        this.handleBubbleEvent(session, event);
      }
      this.finishTurn(session, null);
    } catch (error) {
      this.finishTurn(session, error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (session.abortController === abortController) {
        session.abortController = null;
      }
      session.turnActive = false;
      this.dismissAllRequests(session);
    }
  }

  private handleBubbleEvent(session: ActiveBubbleSession, event: BubbleAgentEvent): void {
    switch (event.type) {
      case 'text_delta':
      case 'reasoning_delta': {
        const delta = getString((event as { content?: unknown }).content);
        if (!delta) {
          return;
        }
        const accumulator = this.ensureCurrentAssistant(session);
        if (event.type === 'reasoning_delta') {
          accumulator.thinking += delta;
        } else {
          accumulator.text += delta;
        }
        this.emitMessage(session, {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta:
              event.type === 'reasoning_delta'
                ? { type: 'thinking_delta', thinking: delta }
                : { type: 'text_delta', text: delta },
          },
        });
        return;
      }
      case 'tool_call_end': {
        const toolEvent = event as Extract<BubbleAgentEvent, { type: 'tool_call_end' }>;
        this.handleToolUse(
          session,
          toolEvent.id,
          toolEvent.name,
          parseToolArguments(toolEvent.arguments)
        );
        return;
      }
      case 'tool_start': {
        const toolEvent = event as Extract<BubbleAgentEvent, { type: 'tool_start' }>;
        this.handleToolUse(session, toolEvent.id, toolEvent.name, toolEvent.args);
        return;
      }
      case 'tool_end': {
        const toolEvent = event as Extract<BubbleAgentEvent, { type: 'tool_end' }>;
        this.handleToolResult(session, toolEvent.id, toolEvent.result);
        return;
      }
      case 'turn_end': {
        const turnEvent = event as Extract<BubbleAgentEvent, { type: 'turn_end' }>;
        this.flushAssistant(session);
        addUsage(session.usage, usageFromBubble(turnEvent.usage, session.contextWindow));
        return;
      }
      case 'mode_changed': {
        // Plan approval makes the SDK setMode('default') mid-turn; report it
        // so the composer's plan pill exits like Claude's does.
        const mode = getString((event as { mode?: unknown }).mode);
        if (mode === 'default' || mode === 'plan' || mode === 'bypassPermissions') {
          session.permissionMode = mode;
          this.emit({
            type: 'permission_mode_changed',
            threadId: session.threadId,
            provider: 'bubble',
            mode,
          });
        }
        return;
      }
      // todos_updated is a snapshot of the todo_write tool the transcript
      // already renders; hooks / retries have no UI mapping.
      default:
        return;
    }
  }

  private handleToolUse(
    session: ActiveBubbleSession,
    toolCallId: string,
    toolName: string,
    args: unknown
  ): void {
    if (!toolCallId || session.emittedToolCallIds.has(toolCallId)) {
      return;
    }
    // Ordering: the transcript expects the assistant text that preceded the
    // tool call to land before the tool_use card.
    this.flushAssistant(session);
    session.emittedToolCallIds.add(toolCallId);
    this.emitMessage(session, {
      type: 'assistant',
      uuid: `bubble-tool-use:${session.threadId}:${toolCallId}`,
      message: {
        content: [
          {
            type: 'tool_use',
            id: toolCallId,
            name: normalizeToolName(toolName),
            input: isRecord(args) ? args : { value: args },
          },
        ],
      },
    });
  }

  private handleToolResult(
    session: ActiveBubbleSession,
    toolCallId: string,
    result: { content?: string; isError?: boolean }
  ): void {
    if (!toolCallId || session.emittedToolResultIds.has(toolCallId)) {
      return;
    }
    session.emittedToolResultIds.add(toolCallId);
    this.emitMessage(session, {
      type: 'user',
      uuid: `bubble-tool-result:${session.threadId}:${toolCallId}:${uuidv4()}`,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: getString(result?.content),
            is_error: result?.isError === true,
          },
        ],
      },
    });
  }

  private flushAssistant(session: ActiveBubbleSession): void {
    const accumulator = session.currentAssistant;
    if (!accumulator) {
      return;
    }
    session.currentAssistant = null;
    const blocks: ContentBlock[] = [];
    if (accumulator.thinking) {
      blocks.push({ type: 'thinking', thinking: accumulator.thinking });
    }
    if (accumulator.text) {
      blocks.push({ type: 'text', text: accumulator.text });
    }
    if (blocks.length === 0) {
      return;
    }
    this.emitMessage(session, {
      type: 'assistant',
      uuid: accumulator.uuid,
      createdAt: accumulator.createdAt,
      message: { content: blocks },
    });
  }

  private finishTurn(session: ActiveBubbleSession, error: Error | null): void {
    this.flushAssistant(session);
    if (session.status === 'stopped') {
      return;
    }
    session.durationEndMs = Date.now();
    if (error) {
      session.status = 'error';
      this.emitResult(session, 'error');
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
      this.emit({ type: 'error', threadId: session.threadId, error });
      return;
    }
    session.status = 'completed';
    this.emitResult(session);
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
  }

  private emitResult(session: ActiveBubbleSession, subtype = 'success'): void {
    this.emitMessage(session, {
      type: 'result',
      subtype,
      duration_ms: Math.max(0, (session.durationEndMs || Date.now()) - session.durationStartMs),
      total_cost_usd: 0,
      usage: session.usage,
      model: session.model,
    });
  }

  private ensureCurrentAssistant(session: ActiveBubbleSession): BubbleAssistantAccumulator {
    if (session.currentAssistant) {
      return session.currentAssistant;
    }
    session.currentAssistant = {
      uuid: `bubble-assistant:${session.threadId}:${uuidv4()}`,
      text: '',
      thinking: '',
      createdAt: Date.now(),
    };
    return session.currentAssistant;
  }

  // ── Approvals / questions / plan mode ──────────────────────────────────

  private requestApproval(
    session: ActiveBubbleSession,
    request: BubbleApprovalRequest
  ): Promise<BubbleApprovalDecision> {
    if (session.status === 'stopped' || this.sessions.get(session.threadId) !== session) {
      return Promise.resolve({ action: 'reject', feedback: 'Session is no longer active.' });
    }
    const requestId = uuidv4();
    const input = buildApprovalInput(request);
    return new Promise<BubbleApprovalDecision>((resolve) => {
      session.pendingRequests.set(requestId, { kind: 'approval', resolve });
      this.emit({
        type: 'permission_request',
        threadId: session.threadId,
        requestId,
        toolName: input.toolName,
        input,
      });
    });
  }

  private requestQuestion(
    session: ActiveBubbleSession,
    request: BubbleQuestionRequest
  ): Promise<string[][] | null> {
    if (session.status === 'stopped' || this.sessions.get(session.threadId) !== session) {
      return Promise.resolve(null);
    }
    const requestId = request.id || uuidv4();
    const input = buildQuestionInput(request);
    if (input.questions.length === 0) {
      return Promise.resolve(null);
    }
    return new Promise<string[][] | null>((resolve) => {
      session.pendingRequests.set(requestId, {
        kind: 'question',
        questions: request.questions,
        resolve,
      });
      this.emit({
        type: 'permission_request',
        threadId: session.threadId,
        requestId,
        toolName: 'AskUserQuestion',
        input,
      });
    });
  }

  private requestPlanApproval(session: ActiveBubbleSession, planMarkdown: string): Promise<boolean> {
    if (session.status === 'stopped' || this.sessions.get(session.threadId) !== session) {
      return Promise.resolve(false);
    }
    const requestId = uuidv4();
    return new Promise<boolean>((resolve) => {
      session.pendingRequests.set(requestId, { kind: 'plan', resolve });
      this.emit({
        type: 'permission_request',
        threadId: session.threadId,
        requestId,
        toolName: 'ExitPlanMode',
        input: {
          plan: planMarkdown,
          questions: [
            {
              header: 'Plan approval',
              question: 'Approve this plan and let Bubble start implementing it?',
              options: [
                {
                  label: 'Approve and execute',
                  description: 'Exit plan mode and continue with implementation.',
                },
                {
                  label: 'Stay in plan mode',
                  description: 'Keep planning without executing tools yet.',
                },
              ],
            },
          ],
        },
      });
    });
  }

  private dismissAllRequests(session: ActiveBubbleSession): void {
    for (const [requestId, pending] of session.pendingRequests) {
      this.emit({ type: 'permission_dismissed', threadId: session.threadId, requestId });
      if (pending.kind === 'approval') {
        pending.resolve({ action: 'reject', feedback: 'Session stopped.' });
      } else if (pending.kind === 'question') {
        pending.resolve(null);
      } else {
        pending.resolve(false);
      }
    }
    session.pendingRequests.clear();
  }

  // ── Context window resolution ──────────────────────────────────────────

  /** modelString → contextWindow (null = looked up, catalog has none). */
  private static contextWindowCache = new Map<string, number | null>();

  private async resolveContextWindow(
    session: ActiveBubbleSession,
    providerId: string,
    model: string
  ): Promise<void> {
    const key = `${providerId}:${model}`;
    const cached = BubbleSdkAdapter.contextWindowCache.get(key);
    if (cached !== undefined) {
      session.contextWindow = cached;
      return;
    }
    let contextWindow: number | null = null;
    try {
      const sdk = await getBubbleSdk(session.cwd);
      const profile = sdk.registry.getEnabled().find((entry) => entry.id === providerId);
      if (profile) {
        const models = (await sdk.registry.listModels(profile)) || [];
        const bareModel = model.startsWith(`${providerId}:`)
          ? model.slice(providerId.length + 1)
          : model;
        const match = models.find(
          (entry) => entry.id === model || entry.id === bareModel
        );
        contextWindow =
          typeof match?.contextWindow === 'number' && match.contextWindow > 0
            ? match.contextWindow
            : null;
      }
    } catch (error) {
      console.warn('[BubbleSdkAdapter] failed to resolve model context window:', error);
      return; // Leave uncached so a later turn can retry.
    }
    BubbleSdkAdapter.contextWindowCache.set(key, contextWindow);
    session.contextWindow = contextWindow;
  }

  // ── Session resolution ─────────────────────────────────────────────────

  /**
   * Bubble sessions persist lazily (nothing on disk before the first
   * message), so an unknown resume id just means "start fresh". A known id
   * resolves through the SDK's on-disk index regardless of host restarts.
   */
  private resolveSessionId(
    sdk: BubbleSdkInstance,
    resumeSessionId: string | undefined,
    cwd: string
  ): string {
    const normalized = resumeSessionId?.trim();
    if (normalized) {
      try {
        const match = sdk.listSessions().find((summary) => summary.name === normalized);
        if (match) {
          return normalized;
        }
        console.warn('[BubbleSdkAdapter] Bubble session not found on disk, creating a new one:', normalized);
      } catch (error) {
        console.warn('[BubbleSdkAdapter] failed to list Bubble sessions for resume:', error);
      }
    }
    return sdk.createSession({ cwd }).id;
  }

  private assertConfigured(sdk: BubbleSdkInstance): void {
    let configured = false;
    try {
      const config = sdk.getModelConfig();
      configured = config.providers.some((provider) => provider.hasApiKey);
    } catch (error) {
      throw new Error(
        `Bubble configuration could not be read: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!configured) {
      throw new Error(
        'Bubble has no configured provider credentials. Run `bubble` in a terminal once to configure a provider/API key.'
      );
    }
  }

  private emitMessage(session: ActiveBubbleSession, message: StreamMessage): void {
    this.emit({ type: 'message', threadId: session.threadId, message });
  }

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }
}
