import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type {
  Attachment,
  ContentBlock,
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
  loadPiSdk,
  createPiAuthAndRegistry,
  type PiAgentMessage,
  type PiAgentSession,
  type PiAgentSessionEvent,
  type PiContentBlock,
  type PiImageContent,
  type PiModel,
  type PiModelRegistry,
  type PiSessionManager,
  type PiToolCallBlock,
  type PiUsage,
} from './pi-sdk-loader';

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: true,
  skillDiscovery: false,
  pluginDiscovery: false,
  mcpServers: false,
  imageAttachments: true,
  forkThread: false,
  compactThread: true,
  planMode: false,
};

type ActivePiSession = {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  session: PiAgentSession;
  unsubscribe?: () => void;
  currentAssistant: PiAssistantAccumulator | null;
  emittedAssistantKeys: Set<string>;
  emittedToolCallIds: Set<string>;
  emittedToolResultIds: Set<string>;
  ingestedUsageKeys: Set<string>;
  usage: Usage;
  totalCostUsd: number;
  durationStartMs: number;
  durationEndMs?: number;
};

type PiAssistantAccumulator = {
  uuid: string;
  text: string;
  thinking: string;
  createdAt: number;
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

function parsePiModel(model: string | undefined): { provider: string; modelId: string } | null {
  const normalized = model?.trim();
  if (!normalized) {
    return null;
  }
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
    return null;
  }
  return {
    provider: normalized.slice(0, slashIndex),
    modelId: normalized.slice(slashIndex + 1),
  };
}

function formatPiModel(model: PiModel | undefined, fallback?: string): string | undefined {
  if (!model) {
    return fallback;
  }
  const provider = getString(model.provider).trim();
  const id = getString(model.id).trim() || getString(model.name).trim();
  if (provider && id) {
    return `${provider}/${id}`;
  }
  return id || fallback;
}

function usageFromPi(usage: PiUsage | undefined, contextWindow?: number): Usage | null {
  if (!usage) {
    return null;
  }
  const input = Math.max(0, Math.round(getNumber(usage.input) || 0));
  const output = Math.max(0, Math.round(getNumber(usage.output) || 0));
  const cacheRead = Math.max(0, Math.round(getNumber(usage.cacheRead) || 0));
  const cacheWrite = Math.max(0, Math.round(getNumber(usage.cacheWrite) || 0));
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
  target.total_tokens =
    (target.total_tokens || 0) +
    (usage.total_tokens ||
      (usage.input_tokens || 0) +
        (usage.output_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0));
  if (usage.context_window) {
    target.context_window = usage.context_window;
  }
}

function createEmptyUsage(contextWindow?: number): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    context_window: contextWindow || null,
  };
}

function getUsageKey(message: PiAgentMessage): string {
  const usage = message.usage;
  return [
    getNumber(message.timestamp) || 0,
    getString(message.model),
    getNumber(usage?.input) || 0,
    getNumber(usage?.output) || 0,
    getNumber(usage?.cacheRead) || 0,
    getNumber(usage?.cacheWrite) || 0,
    getNumber(usage?.totalTokens) || 0,
  ].join(':');
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
  if (compact === 'find') return 'Find';
  if (compact === 'ls') return 'LS';
  return normalized;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) => {
          const record = isRecord(block) ? block : null;
          return record?.type === 'text' ? getString(record.text) : '';
        })
        .filter(Boolean)
        .join('\n');
      if (text) {
        return text;
      }
    }
    if (typeof result.details === 'string') {
      return result.details;
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
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

async function buildPromptImages(attachments: Attachment[] | undefined): Promise<PiImageContent[]> {
  const images: PiImageContent[] = [];
  const imageAttachments = attachments?.filter((attachment) => attachment.kind === 'image') || [];
  for (const attachment of imageAttachments) {
    const buffer = await readFile(attachment.path);
    images.push({
      type: 'image',
      data: buffer.toString('base64'),
      mimeType: attachment.mimeType || 'image/png',
    });
  }
  return images;
}

function extractContentBlocks(message: PiAgentMessage, fallback?: PiAssistantAccumulator | null): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const content = message.content;

  if (typeof content === 'string') {
    if (content.trim()) {
      blocks.push({ type: 'text', text: content });
    }
    return blocks;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        blocks.push({
          type: 'thinking',
          thinking: block.thinking,
          ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}),
        });
      }
    }
  }

  if (blocks.length === 0) {
    if (fallback?.thinking) {
      blocks.push({ type: 'thinking', thinking: fallback.thinking });
    }
    if (fallback?.text) {
      blocks.push({ type: 'text', text: fallback.text });
    }
  }

  return blocks;
}

function getAssistantKey(message: PiAgentMessage, blocks: ContentBlock[]): string {
  const timestamp = getNumber(message.timestamp) || 0;
  const model = getString(message.model);
  const text = blocks
    .map((block) => ('text' in block ? block.text : 'thinking' in block ? block.thinking : ''))
    .join('\n');
  return `${timestamp}:${model}:${text.length}:${text.slice(0, 64)}`;
}

function getToolCalls(message: PiAgentMessage): PiToolCallBlock[] {
  return Array.isArray(message.content)
    ? message.content.filter((block): block is PiToolCallBlock => block.type === 'toolCall')
    : [];
}

function getPiMessageError(message: PiAgentMessage): string | null {
  const stopReason = getString(message.stopReason);
  const errorMessage = getString(message.errorMessage).trim();
  if (errorMessage) {
    return errorMessage;
  }
  if (stopReason === 'error') {
    return 'Pi agent turn failed.';
  }
  if (stopReason === 'aborted') {
    return 'Pi agent turn was aborted.';
  }
  return null;
}

export class PiSdkAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'pi';
  readonly displayName = 'Pi';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActivePiSession>();

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const cwd = input.cwd || process.cwd();
    const sdk = await loadPiSdk();
    const { authStorage, modelRegistry } = createPiAuthAndRegistry(sdk);
    const selectedModel = this.resolveModel(modelRegistry, input.model);
    const sessionManager = await this.createSessionManager(input.resumeSessionId, cwd, sdk.SessionManager);

    const { session: piSession } = await sdk.createAgentSession({
      cwd,
      authStorage,
      modelRegistry,
      sessionManager,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      ...(selectedModel ? { model: selectedModel } : {}),
    });

    const activeSession: ActivePiSession = {
      threadId: input.threadId,
      providerSessionId: piSession.sessionId,
      status: 'running',
      cwd,
      model: formatPiModel(piSession.model, input.model),
      session: piSession,
      currentAssistant: null,
      emittedAssistantKeys: new Set(),
      emittedToolCallIds: new Set(),
      emittedToolResultIds: new Set(),
      ingestedUsageKeys: new Set(),
      usage: createEmptyUsage(piSession.model?.contextWindow),
      totalCostUsd: 0,
      durationStartMs: Date.now(),
    };
    activeSession.unsubscribe = piSession.subscribe((event) => this.handlePiEvent(activeSession, event));
    this.sessions.set(input.threadId, activeSession);

    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: piSession.sessionId,
      model: activeSession.model,
    });

    if (input.prompt || input.attachments?.length) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model,
      });
    }

    return {
      threadId: input.threadId,
      provider: 'pi',
      providerSessionId: piSession.sessionId,
      status: activeSession.status,
      model: activeSession.model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No Pi session found for thread "${input.threadId}"`);
    }

    session.status = 'running';
    session.durationStartMs = Date.now();
    session.durationEndMs = undefined;
    session.usage = createEmptyUsage(session.session.model?.contextWindow);
    session.totalCostUsd = 0;
    session.ingestedUsageKeys.clear();
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    if (input.model && input.model !== session.model) {
      await this.applyModel(session, input.model);
    }

    const text = buildPromptText(input.prompt, input.attachments);
    const images = await buildPromptImages(input.attachments);
    if (!text.trim() && images.length === 0) {
      return;
    }
    try {
      await session.session.prompt(text, images.length > 0 ? { images } : undefined);
    } catch (error) {
      this.handleSessionError(session, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    session.status = 'stopped';
    try {
      await session.session.abort();
    } catch {
      // Pi may already be idle.
    }
    session.unsubscribe?.();
    session.session.dispose();
    this.sessions.delete(threadId);
    this.emit({ type: 'status_change', threadId, status: 'stopped' });
  }

  async stopAll(): Promise<void> {
    const threadIds = Array.from(this.sessions.keys());
    await Promise.all(threadIds.map((threadId) => this.stopSession(threadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      threadId: session.threadId,
      provider: 'pi',
      providerSessionId: session.providerSessionId,
      status: session.status,
      model: session.model,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async respondToRequest(): Promise<void> {
    throw new Error('Pi SDK permission responses are not supported yet.');
  }

  async runOneShot(input: ProviderSessionStartInput): Promise<{ text: string; sessionId?: string; model?: string }> {
    const session = await this.startSession({
      ...input,
      threadId: `${input.threadId}:oneshot:${uuidv4()}`,
    });
    const active = this.sessions.get(session.threadId);
    if (!active) {
      return { text: '', sessionId: session.providerSessionId, model: session.model };
    }

    await this.waitForCompletion(active);
    const messages = active.session.messages || [];
    const text = messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => extractContentBlocks(message))
      .map((block) => ('text' in block ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    await this.stopSession(session.threadId);
    return { text, sessionId: session.providerSessionId, model: session.model };
  }

  private resolveModel(modelRegistry: PiModelRegistry, model: string | undefined): PiModel | undefined {
    const selection = parsePiModel(model);
    if (!selection) {
      return undefined;
    }
    return modelRegistry.find(selection.provider, selection.modelId);
  }

  private async createSessionManager(
    resumeSessionId: string | undefined,
    cwd: string,
    SessionManager: {
      create(cwd: string, sessionDir?: string, options?: { id?: string }): PiSessionManager;
      open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManager;
      list(cwd: string, sessionDir?: string): Promise<Array<{ id: string; path: string }>>;
    }
  ): Promise<PiSessionManager> {
    const normalizedResumeId = resumeSessionId?.trim();
    if (normalizedResumeId) {
      try {
        const sessions = await SessionManager.list(cwd);
        const match = sessions.find((session) => session.id === normalizedResumeId);
        if (match?.path) {
          return SessionManager.open(match.path, undefined, cwd);
        }
      } catch (error) {
        console.warn('[PiSdkAdapter] failed to resume Pi session, creating a new one:', error);
      }
    }
    return SessionManager.create(cwd);
  }

  private async applyModel(session: ActivePiSession, model: string): Promise<void> {
    if (!session.session.setModel) {
      session.model = model;
      return;
    }
    const sdk = await loadPiSdk();
    const { modelRegistry } = createPiAuthAndRegistry(sdk);
    const selectedModel = this.resolveModel(modelRegistry, model);
    if (!selectedModel) {
      session.model = model;
      return;
    }
    await session.session.setModel(selectedModel);
    session.model = formatPiModel(session.session.model, model);
  }

  private handlePiEvent(session: ActivePiSession, event: PiAgentSessionEvent): void {
    switch (event.type) {
      case 'message_update':
        this.handleMessageUpdate(
          session,
          event as Extract<PiAgentSessionEvent, { type: 'message_update' }>
        );
        break;
      case 'message_end':
        this.handleMessageEnd(
          session,
          (event as Extract<PiAgentSessionEvent, { type: 'message_end' }>).message
        );
        break;
      case 'tool_execution_start':
        {
          const toolEvent = event as Extract<PiAgentSessionEvent, { type: 'tool_execution_start' }>;
          this.handleToolStart(session, toolEvent.toolCallId, toolEvent.toolName, toolEvent.args);
        }
        break;
      case 'tool_execution_end':
        {
          const toolEvent = event as Extract<PiAgentSessionEvent, { type: 'tool_execution_end' }>;
          this.handleToolEnd(
            session,
            toolEvent.toolCallId,
            toolEvent.toolName,
            toolEvent.result,
            toolEvent.isError
          );
        }
        break;
      case 'turn_end':
        this.ingestUsage(
          session,
          (event as Extract<PiAgentSessionEvent, { type: 'turn_end' }>).message
        );
        break;
      case 'agent_end':
        {
          const agentEvent = event as Extract<PiAgentSessionEvent, { type: 'agent_end' }>;
          this.handleAgentEnd(session, agentEvent.messages, agentEvent.willRetry === true);
        }
        break;
      default:
        break;
    }
  }

  private handleMessageUpdate(
    session: ActivePiSession,
    event: Extract<PiAgentSessionEvent, { type: 'message_update' }>
  ): void {
    const streamEvent = event.assistantMessageEvent || {};
    const streamType = getString(streamEvent.type);
    if (streamType !== 'text_delta' && streamType !== 'thinking_delta') {
      return;
    }
    const delta = getString(streamEvent.delta);
    if (!delta) {
      return;
    }
    const accumulator = this.ensureCurrentAssistant(session, event.message);
    if (streamType === 'thinking_delta') {
      accumulator.thinking += delta;
    } else {
      accumulator.text += delta;
    }
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta:
            streamType === 'thinking_delta'
              ? { type: 'thinking_delta', thinking: delta }
              : { type: 'text_delta', text: delta },
        },
      },
    });
  }

  private handleMessageEnd(session: ActivePiSession, message: PiAgentMessage): void {
    if (message.role !== 'assistant') {
      return;
    }

    this.ingestUsage(session, message);
    for (const toolCall of getToolCalls(message)) {
      const id = getString(toolCall.id);
      if (id && !session.emittedToolCallIds.has(id)) {
        this.handleToolStart(session, id, getString(toolCall.name), toolCall.arguments || {});
      }
    }

    const blocks = extractContentBlocks(message, session.currentAssistant);
    if (blocks.length === 0) {
      session.currentAssistant = null;
      return;
    }
    const key = getAssistantKey(message, blocks);
    if (session.emittedAssistantKeys.has(key)) {
      session.currentAssistant = null;
      return;
    }
    session.emittedAssistantKeys.add(key);
    const createdAt = getNumber(message.timestamp) || session.currentAssistant?.createdAt;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: session.currentAssistant?.uuid || uuidv4(),
        ...(createdAt ? { createdAt } : {}),
        message: { content: blocks },
      },
    });
    session.currentAssistant = null;
  }

  private handleToolStart(
    session: ActivePiSession,
    toolCallId: string,
    toolName: string,
    args: unknown
  ): void {
    if (!toolCallId || session.emittedToolCallIds.has(toolCallId)) {
      return;
    }
    session.emittedToolCallIds.add(toolCallId);
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `pi-tool-use:${session.threadId}:${toolCallId}`,
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
      },
    });
  }

  private handleToolEnd(
    session: ActivePiSession,
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean
  ): void {
    if (!toolCallId || session.emittedToolResultIds.has(toolCallId)) {
      return;
    }
    session.emittedToolResultIds.add(toolCallId);
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'user',
        uuid: `pi-tool-result:${session.threadId}:${toolCallId}:${uuidv4()}`,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolCallId,
              content: stringifyToolResult(result),
              is_error: isError,
            },
          ],
        },
      },
    });
  }

  private handleAgentEnd(
    session: ActivePiSession,
    messages: PiAgentMessage[],
    willRetry: boolean
  ): void {
    if (session.status === 'stopped') {
      return;
    }
    for (const message of messages) {
      if (message.role === 'assistant') {
        this.handleMessageEnd(session, message);
      }
    }
    if (willRetry) {
      return;
    }
    const errorMessage = messages
      .filter((message) => message.role === 'assistant')
      .map((message) => getPiMessageError(message))
      .find((message): message is string => Boolean(message));
    session.durationEndMs = Date.now();
    if (errorMessage) {
      session.status = 'error';
      this.emitResult(session, 'error');
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
      this.emit({ type: 'error', threadId: session.threadId, error: new Error(errorMessage) });
      return;
    }
    session.status = 'completed';
    this.emitResult(session);
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
  }

  private ingestUsage(session: ActivePiSession, message: PiAgentMessage): void {
    if (message.role !== 'assistant') {
      return;
    }
    const usageKey = getUsageKey(message);
    if (session.ingestedUsageKeys.has(usageKey)) {
      return;
    }
    session.ingestedUsageKeys.add(usageKey);
    const contextWindow = session.session.model?.contextWindow;
    const usage = usageFromPi(message.usage, contextWindow);
    addUsage(session.usage, usage);
    session.totalCostUsd += getNumber(message.usage?.cost?.total) || 0;
    const formattedModel = formatPiModel(session.session.model, message.model);
    if (formattedModel) {
      session.model = formattedModel;
    }
  }

  private emitResult(session: ActivePiSession, subtype = 'success'): void {
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'result',
        subtype,
        duration_ms: Math.max(0, (session.durationEndMs || Date.now()) - session.durationStartMs),
        total_cost_usd: session.totalCostUsd,
        usage: session.usage,
        model: session.model,
      },
    });
  }

  private ensureCurrentAssistant(
    session: ActivePiSession,
    message: PiAgentMessage
  ): PiAssistantAccumulator {
    if (session.currentAssistant) {
      return session.currentAssistant;
    }
    session.currentAssistant = {
      uuid: `pi-assistant:${session.threadId}:${uuidv4()}`,
      text: '',
      thinking: '',
      createdAt: getNumber(message.timestamp) || Date.now(),
    };
    return session.currentAssistant;
  }

  private waitForCompletion(session: ActivePiSession): Promise<void> {
    if (session.status === 'completed' || session.status === 'error' || session.status === 'stopped') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const listener = (event: ProviderRuntimeEvent) => {
        if (event.threadId !== session.threadId || event.type !== 'status_change') {
          return;
        }
        if (event.status === 'completed' || event.status === 'error' || event.status === 'stopped') {
          this.events.off('event', listener);
          resolve();
        }
      };
      this.events.on('event', listener);
      setTimeout(() => {
        this.events.off('event', listener);
        resolve();
      }, 120_000).unref?.();
    });
  }

  private handleSessionError(session: ActivePiSession, error: Error): void {
    if (session.status === 'stopped') {
      return;
    }
    session.durationEndMs = Date.now();
    session.status = 'error';
    this.emitResult(session, 'error');
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'error' });
    this.emit({ type: 'error', threadId: session.threadId, error });
  }

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }
}
