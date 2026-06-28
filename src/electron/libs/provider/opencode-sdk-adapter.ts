import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import type {
  AcpPermissionInput,
  Attachment,
  AvailableCommand,
  ContentBlock,
  McpServerStatus,
  OpenCodePermissionMode,
  PermissionResult,
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
import { OpenCodeServeManager, type OpenCodeClient } from './opencode-serve-manager';

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: false,
  skillDiscovery: false,
  pluginDiscovery: false,
  mcpServers: true,
  imageAttachments: true,
  forkThread: true,
  compactThread: true,
  planMode: false,
};

type OpenCodeModelSelection = {
  providerID: string;
  modelID: string;
};

type ActiveOpenCodeSession = {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  client: OpenCodeClient;
  model?: string;
  permissionMode: OpenCodePermissionMode;
  eventAbortController: AbortController;
  eventTask: Promise<void>;
  assistantMessages: Map<string, OpenCodeAssistantAccumulator>;
  messageRoles: Map<string, OpenCodeMessageRole>;
  pendingPartUpdates: Map<string, PendingOpenCodePartUpdate[]>;
  availableCommands: Map<string, OpenCodeCommandDescriptor>;
  finalizedAssistantMessageIds: Set<string>;
  emittedToolCallIds: Set<string>;
  emittedToolResultIds: Set<string>;
  emittedPermissionIds: Set<string>;
  eventReady: Promise<void>;
};

type OpenCodeMessageRole = 'user' | 'assistant';

type OpenCodeCommandDescriptor = {
  name: string;
  description: string;
  agent?: string;
  model?: string;
};

type PendingOpenCodePartUpdate = {
  part: Record<string, unknown>;
  delta: string;
  emitDeltas: boolean;
};

type OpenCodeAssistantAccumulator = {
  messageId: string;
  uuid: string;
  text: string;
  reasoning: string;
  model?: string;
  usage?: Usage;
  cost?: number;
  contextWindow?: number;
  outputLimit?: number;
  createdAt?: number;
  completedAt?: number;
};

const FALLBACK_OPENCODE_COMMANDS: AvailableCommand[] = [
  { name: 'help', description: 'Show OpenCode help' },
  { name: 'connect', description: 'Add a provider to OpenCode' },
  { name: 'compact', description: 'Compact the current session' },
  { name: 'details', description: 'Toggle tool execution details' },
  { name: 'editor', description: 'Open an external editor for composing messages' },
  { name: 'exit', description: 'Exit OpenCode' },
  { name: 'export', description: 'Export the current conversation' },
  { name: 'init', description: 'Create or update AGENTS.md' },
  { name: 'models', description: 'List available models' },
  { name: 'new', description: 'Start a new session' },
  { name: 'sessions', description: 'List and switch between sessions' },
  { name: 'share', description: 'Share the current session' },
  { name: 'themes', description: 'List available themes' },
  { name: 'thinking', description: 'Toggle visibility of thinking blocks' },
  { name: 'unshare', description: 'Unshare the current session' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unwrapOpenCodeResult<T>(result: unknown): T {
  const record = getRecord(result);
  if (!record) {
    return result as T;
  }

  if ('error' in record && record.error !== undefined) {
    const errorRecord = getRecord(record.error);
    const message =
      getString(errorRecord?.message) ||
      getString(getRecord(errorRecord?.data)?.message) ||
      JSON.stringify(record.error);
    throw new Error(message || 'OpenCode SDK request failed.');
  }

  if ('data' in record) {
    return record.data as T;
  }

  return result as T;
}

async function requestOpenCode<T>(request: Promise<unknown>): Promise<T> {
  return unwrapOpenCodeResult<T>(await request);
}

function normalizeOpenCodePermissionMode(
  mode: OpenCodePermissionMode | undefined
): OpenCodePermissionMode {
  return mode === 'fullAccess' ? 'fullAccess' : 'defaultPermissions';
}

function parseOpenCodeModel(model: string | undefined): OpenCodeModelSelection | undefined {
  const normalized = model?.trim();
  if (!normalized) {
    return undefined;
  }
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
    return undefined;
  }
  return {
    providerID: normalized.slice(0, slashIndex),
    modelID: normalized.slice(slashIndex + 1),
  };
}

function parseOpenCodeSlashCommand(prompt: string): { name: string; args: string } | null {
  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  return {
    name: match[1].toLowerCase(),
    args: match[2]?.trim() || '',
  };
}

function formatOpenCodeModel(providerID: unknown, modelID: unknown): string | undefined {
  const provider = getString(providerID).trim();
  const model = getString(modelID).trim();
  if (!provider || !model) {
    return undefined;
  }
  return `${provider}/${model}`;
}

function extractMessageModel(info: Record<string, unknown>): string | undefined {
  return formatOpenCodeModel(info.providerID, info.modelID);
}

function extractMessageUsage(info: Record<string, unknown>): Usage | undefined {
  const tokens = getRecord(info.tokens);
  if (!tokens) {
    return undefined;
  }
  const cache = getRecord(tokens.cache);
  return {
    input_tokens: getNumber(tokens.input) || 0,
    output_tokens: getNumber(tokens.output) || 0,
    reasoning_output_tokens: getNumber(tokens.reasoning) || 0,
    cache_read_input_tokens: getNumber(cache?.read) || 0,
    cache_creation_input_tokens: getNumber(cache?.write) || 0,
  };
}

function extractDurationMs(info: Record<string, unknown>): number {
  const time = getRecord(info.time);
  const created = getNumber(time?.created);
  const completed = getNumber(time?.completed);
  if (created !== undefined && completed !== undefined && completed >= created) {
    return Math.max(0, Math.round(completed - created));
  }
  return 0;
}

function inferToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (!normalized) return 'Tool';
  const compact = normalized.replace(/[_\-\s]/g, '').toLowerCase();
  if (compact === 'bash' || compact === 'shell' || compact === 'shellcommand') return 'Bash';
  if (compact === 'edit' || compact === 'write' || compact === 'patch') return 'Edit';
  if (compact === 'read' || compact === 'fileread') return 'Read';
  if (compact === 'grep' || compact === 'search') return 'Grep';
  if (compact === 'webfetch') return 'WebFetch';
  return normalized;
}

function buildPermissionOptions(): AcpPermissionInput['options'] {
  return [
    {
      optionId: 'once',
      name: 'Approve once',
      kind: 'allow_once',
      description: 'Allow this OpenCode action one time.',
    },
    {
      optionId: 'always',
      name: 'Always allow this session',
      kind: 'allow_always',
      description: 'Allow matching OpenCode actions for this session.',
    },
    {
      optionId: 'reject',
      name: 'Reject',
      kind: 'reject',
      description: 'Reject this OpenCode action.',
    },
  ];
}

function mapPermissionDecision(decision: PermissionResult): 'once' | 'always' | 'reject' {
  if (decision.behavior === 'deny') {
    return 'reject';
  }
  const optionId = getString(decision.updatedInput?.optionId);
  if (optionId === 'always') {
    return 'always';
  }
  if (optionId === 'reject') {
    return 'reject';
  }
  return decision.scope === 'session' ? 'always' : 'once';
}

function mapMcpStatus(status: unknown): McpServerStatus['status'] {
  const raw = getString(getRecord(status)?.status);
  if (raw === 'connected') return 'connected';
  if (raw === 'failed' || raw === 'needs_auth' || raw === 'needs_client_registration') return 'failed';
  return 'pending';
}

function buildPromptText(prompt: string, attachments: Attachment[] | undefined): string {
  const allAttachments = attachments?.filter((attachment) => attachment?.path) || [];
  const lines: string[] = prompt ? [prompt] : [];
  if (allAttachments.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Attachments:');
    for (const attachment of allAttachments) {
      lines.push(`- ${attachment.name}: ${attachment.path}`);
    }
  }
  return lines.join('\n');
}

async function buildPromptParts(
  prompt: string,
  attachments: Attachment[] | undefined
): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = [];
  const text = buildPromptText(prompt, attachments);
  if (text.trim()) {
    parts.push({ type: 'text', text });
  }

  const imageAttachments = attachments?.filter((attachment) => attachment?.kind === 'image') || [];
  for (const attachment of imageAttachments) {
    try {
      const buffer = await readFile(attachment.path);
      parts.push({
        type: 'file',
        mime: attachment.mimeType || 'application/octet-stream',
        filename: attachment.name,
        url: `data:${attachment.mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}`,
      });
    } catch {
      parts.push({
        type: 'file',
        mime: attachment.mimeType || 'application/octet-stream',
        filename: attachment.name,
        url: pathToFileURL(attachment.path).toString(),
      });
    }
  }

  return parts;
}

export class OpenCodeSdkAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'opencode';
  readonly displayName = 'OpenCode';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private manager: OpenCodeServeManager;
  private sessions = new Map<string, ActiveOpenCodeSession>();
  private modelLimits = new Map<string, { contextWindow: number; outputLimit: number }>();

  constructor(manager = new OpenCodeServeManager()) {
    this.manager = manager;
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const cwd = input.cwd || process.cwd();
    const client = await this.manager.getClient(cwd);
    await this.refreshModelLimits(client, cwd);
    const providerSessionId = await this.resolveProviderSessionId(client, cwd, input.resumeSessionId);
    const permissionMode = normalizeOpenCodePermissionMode(input.opencodePermissionMode);
    let markEventReady!: () => void;
    const eventReady = new Promise<void>((resolve) => {
      markEventReady = resolve;
    });
    const session: ActiveOpenCodeSession = {
      threadId: input.threadId,
      providerSessionId,
      status: 'running',
      cwd,
      client,
      model: input.model,
      permissionMode,
      eventAbortController: new AbortController(),
      eventTask: Promise.resolve(),
      assistantMessages: new Map(),
      messageRoles: new Map(),
      pendingPartUpdates: new Map(),
      availableCommands: new Map(
        FALLBACK_OPENCODE_COMMANDS.map((command) => [
          command.name,
          { name: command.name, description: command.description },
        ])
      ),
      finalizedAssistantMessageIds: new Set(),
      emittedToolCallIds: new Set(),
      emittedToolResultIds: new Set(),
      emittedPermissionIds: new Set(),
      eventReady,
    };
    session.eventTask = this.consumeEvents(session, markEventReady);
    this.sessions.set(input.threadId, session);
    await eventReady;

    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: providerSessionId,
      model: input.model,
    });
    await this.emitMcpStatus(session);
    await this.emitAvailableCommands(session);

    if (input.prompt || input.attachments?.length) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model,
        opencodePermissionMode: permissionMode,
      });
    }

    return {
      threadId: input.threadId,
      provider: 'opencode',
      providerSessionId,
      status: session.status,
      model: session.model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No OpenCode session found for thread "${input.threadId}"`);
    }

    session.permissionMode = normalizeOpenCodePermissionMode(
      input.opencodePermissionMode || session.permissionMode
    );
    session.status = 'running';
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    const slashCommand = parseOpenCodeSlashCommand(input.prompt);
    const shouldRunCommand =
      slashCommand &&
      !input.attachments?.length &&
      session.availableCommands.has(slashCommand.name);
    const response = shouldRunCommand
      ? await this.executeSlashCommand(session, slashCommand, input.model || session.model)
      : await this.executePrompt(session, input);
    if (!response) {
      return;
    }

    this.ingestPromptResponse(session, response);
    this.emitTurnResult(session, getRecord(response.info));
  }

  private async executePrompt(
    session: ActiveOpenCodeSession,
    input: ProviderSendTurnInput
  ): Promise<Record<string, unknown> | null> {
    const parts = await buildPromptParts(input.prompt, input.attachments);
    if (parts.length === 0) {
      return null;
    }
    const model = parseOpenCodeModel(input.model || session.model);
    return requestOpenCode<Record<string, unknown>>(
      session.client.session.prompt({
        path: { id: session.providerSessionId },
        query: { directory: session.cwd },
        body: {
          ...(model ? { model } : {}),
          parts,
        },
      })
    );
  }

  private async executeSlashCommand(
    session: ActiveOpenCodeSession,
    command: { name: string; args: string },
    model: string | undefined
  ): Promise<Record<string, unknown>> {
    const descriptor = session.availableCommands.get(command.name);
    return requestOpenCode<Record<string, unknown>>(
      session.client.session.command({
        path: { id: session.providerSessionId },
        query: { directory: session.cwd },
        body: {
          command: command.name,
          arguments: command.args,
          ...(descriptor?.agent ? { agent: descriptor.agent } : {}),
          ...(descriptor?.model || model ? { model: descriptor?.model || model } : {}),
        },
      })
    );
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    session.status = 'stopped';
    session.eventAbortController.abort();
    try {
      await session.client.session.abort({
        path: { id: session.providerSessionId },
        query: { directory: session.cwd },
      });
    } catch {
      // The session may already be idle or the server may be shutting down.
    }
    this.sessions.delete(threadId);
    this.emit({ type: 'status_change', threadId, status: 'stopped' });
  }

  async stopAll(): Promise<void> {
    const threadIds = Array.from(this.sessions.keys());
    await Promise.all(threadIds.map((threadId) => this.stopSession(threadId)));
    await this.manager.close();
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      threadId: session.threadId,
      provider: 'opencode',
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
      throw new Error(`No OpenCode session found for thread "${threadId}"`);
    }
    await this.respondToOpenCodePermission(session, requestId, mapPermissionDecision(decision));
  }

  private async resolveProviderSessionId(
    client: OpenCodeClient,
    cwd: string,
    resumeSessionId: string | undefined
  ): Promise<string> {
    if (resumeSessionId?.trim()) {
      try {
        const existing = await requestOpenCode<Record<string, unknown>>(
          client.session.get({
            path: { id: resumeSessionId.trim() },
            query: { directory: cwd },
          })
        );
        const existingId = getString(existing.id).trim();
        if (existingId) {
          return existingId;
        }
      } catch (error) {
        console.warn('[OpenCodeSdkAdapter] failed to resume session, creating a new one:', error);
      }
    }

    const created = await requestOpenCode<Record<string, unknown>>(
      client.session.create({
        query: { directory: cwd },
      })
    );
    const id = getString(created.id).trim();
    if (!id) {
      throw new Error('OpenCode SDK did not return a session id.');
    }
    return id;
  }

  private async consumeEvents(
    session: ActiveOpenCodeSession,
    markEventReady: () => void
  ): Promise<void> {
    try {
      const subscription = await session.client.event.subscribe({
        query: { directory: session.cwd },
        signal: session.eventAbortController.signal,
        sseMaxRetryAttempts: 3,
        onSseError: (error: unknown) => {
          if (!session.eventAbortController.signal.aborted) {
            console.warn('[OpenCodeSdkAdapter] event stream error:', error);
          }
        },
      });

      const iterator = subscription.stream[Symbol.asyncIterator]();
      let nextEvent = iterator.next();
      markEventReady();
      while (true) {
        const { value, done } = await nextEvent;
        if (done) {
          break;
        }
        if (session.eventAbortController.signal.aborted) {
          break;
        }
        this.handleSdkEvent(session, value);
        nextEvent = iterator.next();
      }
    } catch (error) {
      markEventReady();
      if (!session.eventAbortController.signal.aborted) {
        this.emit({
          type: 'error',
          threadId: session.threadId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  private handleSdkEvent(session: ActiveOpenCodeSession, event: unknown): void {
    const record = getRecord(event);
    if (!record) {
      return;
    }
    const type = getString(record.type);
    const properties = getRecord(record.properties);
    if (!properties) {
      return;
    }

    switch (type) {
      case 'message.updated':
        this.handleMessageUpdated(session, getRecord(properties.info));
        break;
      case 'message.part.updated':
        this.handlePartUpdated(session, getRecord(properties.part), getString(properties.delta), true);
        break;
      case 'permission.updated':
        this.handlePermissionUpdated(session, properties);
        break;
      case 'session.status':
        this.handleSessionStatus(session, getString(properties.sessionID), getRecord(properties.status));
        break;
      case 'session.idle':
        if (getString(properties.sessionID) === session.providerSessionId) {
          session.status = 'completed';
          this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
        }
        break;
      case 'session.error':
        if (getString(properties.sessionID) === session.providerSessionId) {
          const errorRecord = getRecord(properties.error);
          const message =
            getString(errorRecord?.message) ||
            getString(getRecord(errorRecord?.data)?.message) ||
            'OpenCode session error.';
          this.emit({ type: 'error', threadId: session.threadId, error: new Error(message) });
        }
        break;
    }
  }

  private handleMessageUpdated(
    session: ActiveOpenCodeSession,
    info: Record<string, unknown> | null
  ): void {
    if (!info || getString(info.sessionID) !== session.providerSessionId) {
      return;
    }

    const messageId = getString(info.id);
    if (!messageId) {
      return;
    }

    const role = getString(info.role);
    if (role !== 'assistant' && role !== 'user') {
      return;
    }
    session.messageRoles.set(messageId, role);

    if (role !== 'assistant') {
      session.pendingPartUpdates.delete(messageId);
      return;
    }

    const accumulator = this.ensureAssistantAccumulator(session, messageId);
    accumulator.model = extractMessageModel(info) || accumulator.model;
    accumulator.usage = extractMessageUsage(info) || accumulator.usage;
    accumulator.cost = getNumber(info.cost) ?? accumulator.cost;
    if (accumulator.model) {
      const limits = this.modelLimits.get(accumulator.model) || this.readModelLimits(info);
      accumulator.contextWindow = limits?.contextWindow || accumulator.contextWindow;
      accumulator.outputLimit = limits?.outputLimit || accumulator.outputLimit;
    }
    const time = getRecord(info.time);
    accumulator.createdAt = getNumber(time?.created) ?? accumulator.createdAt;
    accumulator.completedAt = getNumber(time?.completed) ?? accumulator.completedAt;
    session.model = accumulator.model || session.model;

    const error = getRecord(info.error);
    if (error) {
      const message =
        getString(getRecord(error.data)?.message) ||
        getString(error.message) ||
        getString(error.name) ||
        'OpenCode message failed.';
      this.emit({ type: 'error', threadId: session.threadId, error: new Error(message) });
    }

    this.flushPendingPartUpdates(session, messageId);
  }

  private handlePartUpdated(
    session: ActiveOpenCodeSession,
    part: Record<string, unknown> | null,
    delta: string,
    emitDeltas: boolean
  ): void {
    if (!part || getString(part.sessionID) !== session.providerSessionId) {
      return;
    }

    const messageId = getString(part.messageID);
    if (!messageId) {
      return;
    }
    const role = session.messageRoles.get(messageId);
    if (role === 'user') {
      return;
    }
    if (role !== 'assistant') {
      this.queuePendingPartUpdate(session, messageId, part, delta, emitDeltas);
      return;
    }

    this.processAssistantPartUpdate(session, part, delta, emitDeltas);
  }

  private processAssistantPartUpdate(
    session: ActiveOpenCodeSession,
    part: Record<string, unknown>,
    delta: string,
    emitDeltas: boolean
  ): void {
    const partType = getString(part.type);
    if (partType === 'text') {
      this.updateAssistantTextPart(session, part, delta, emitDeltas);
      return;
    }
    if (partType === 'reasoning') {
      this.updateAssistantReasoningPart(session, part, delta, emitDeltas);
      return;
    }
    if (partType === 'tool') {
      this.handleToolPart(session, part);
    }
  }

  private queuePendingPartUpdate(
    session: ActiveOpenCodeSession,
    messageId: string,
    part: Record<string, unknown>,
    delta: string,
    emitDeltas: boolean
  ): void {
    const pending = session.pendingPartUpdates.get(messageId) || [];
    pending.push({ part, delta, emitDeltas });
    session.pendingPartUpdates.set(messageId, pending.slice(-50));
  }

  private flushPendingPartUpdates(session: ActiveOpenCodeSession, messageId: string): void {
    const pending = session.pendingPartUpdates.get(messageId);
    if (!pending?.length) {
      return;
    }
    session.pendingPartUpdates.delete(messageId);
    for (const update of pending) {
      this.processAssistantPartUpdate(session, update.part, update.delta, update.emitDeltas);
    }
  }

  private updateAssistantTextPart(
    session: ActiveOpenCodeSession,
    part: Record<string, unknown>,
    delta: string,
    emitDeltas: boolean
  ): void {
    const messageId = getString(part.messageID);
    if (!messageId) {
      return;
    }
    const accumulator = this.ensureAssistantAccumulator(session, messageId);
    const nextText = getString(part.text);
    const textDelta =
      delta || (nextText.startsWith(accumulator.text) ? nextText.slice(accumulator.text.length) : '');
    accumulator.text = nextText || accumulator.text + textDelta;
    if (emitDeltas && textDelta) {
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: textDelta },
          },
        },
      });
    }
  }

  private updateAssistantReasoningPart(
    session: ActiveOpenCodeSession,
    part: Record<string, unknown>,
    delta: string,
    emitDeltas: boolean
  ): void {
    const messageId = getString(part.messageID);
    if (!messageId) {
      return;
    }
    const accumulator = this.ensureAssistantAccumulator(session, messageId);
    const nextReasoning = getString(part.text);
    const reasoningDelta =
      delta ||
      (nextReasoning.startsWith(accumulator.reasoning)
        ? nextReasoning.slice(accumulator.reasoning.length)
        : '');
    accumulator.reasoning = nextReasoning || accumulator.reasoning + reasoningDelta;
    if (emitDeltas && reasoningDelta) {
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: reasoningDelta },
          },
        },
      });
    }
  }

  private handleToolPart(session: ActiveOpenCodeSession, part: Record<string, unknown>): void {
    const toolId = getString(part.callID) || getString(part.id);
    if (!toolId) {
      return;
    }
    const state = getRecord(part.state);
    const input = getRecord(state?.input) || {};
    const toolName = inferToolName(getString(part.tool));

    if (!session.emittedToolCallIds.has(toolId)) {
      session.emittedToolCallIds.add(toolId);
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'assistant',
          uuid: uuidv4(),
          message: {
            content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
          },
        },
      });
    }

    const status = getString(state?.status);
    if (
      (status === 'completed' || status === 'error') &&
      !session.emittedToolResultIds.has(toolId)
    ) {
      session.emittedToolResultIds.add(toolId);
      const output =
        status === 'error'
          ? getString(state?.error) || 'OpenCode tool failed.'
          : getString(state?.output);
      this.emit({
        type: 'message',
        threadId: session.threadId,
        message: {
          type: 'user',
          uuid: uuidv4(),
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolId,
                content: output,
                is_error: status === 'error',
              },
            ],
          },
        },
      });
    }
  }

  private handlePermissionUpdated(
    session: ActiveOpenCodeSession,
    properties: Record<string, unknown>
  ): void {
    const permission = getRecord(properties);
    if (!permission || getString(permission.sessionID) !== session.providerSessionId) {
      return;
    }
    const permissionId = getString(permission.id);
    if (!permissionId || session.emittedPermissionIds.has(permissionId)) {
      return;
    }
    session.emittedPermissionIds.add(permissionId);

    if (session.permissionMode === 'fullAccess') {
      void this.respondToOpenCodePermission(session, permissionId, 'always');
      return;
    }

    const title = getString(permission.title) || 'OpenCode is requesting permission';
    const toolName = inferToolName(getString(permission.type) || title);
    const input: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'opencode',
      question: title,
      title,
      toolName,
      options: buildPermissionOptions(),
      toolCall: {
        type: permission.type,
        pattern: permission.pattern,
        callID: permission.callID,
        metadata: permission.metadata,
      },
    };

    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId: permissionId,
      toolName,
      input,
    });
  }

  private handleSessionStatus(
    session: ActiveOpenCodeSession,
    sessionId: string,
    status: Record<string, unknown> | null
  ): void {
    if (sessionId !== session.providerSessionId || !status) {
      return;
    }
    const type = getString(status.type);
    if (type === 'busy' || type === 'retry') {
      session.status = 'running';
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'running' });
      return;
    }
    if (type === 'idle') {
      session.status = 'completed';
      this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
    }
  }

  private ingestPromptResponse(
    session: ActiveOpenCodeSession,
    response: Record<string, unknown>
  ): void {
    const info = getRecord(response.info);
    this.handleMessageUpdated(session, info);
    const parts = Array.isArray(response.parts) ? response.parts : [];
    for (const part of parts) {
      this.handlePartUpdated(session, getRecord(part), '', false);
    }
    if (info) {
      const model = extractMessageModel(info);
      if (model) {
        const limits = this.readModelLimits(info);
        if (limits) {
          this.modelLimits.set(model, limits);
        }
      }
      this.finalizeAssistantMessage(session, getString(info.id));
    }
  }

  private emitTurnResult(
    session: ActiveOpenCodeSession,
    info: Record<string, unknown> | null
  ): void {
    const usage = info ? extractMessageUsage(info) : undefined;
    const model = info ? extractMessageModel(info) : session.model;
    const limits =
      (model ? this.modelLimits.get(model) : undefined) ||
      (info ? this.readModelLimits(info) : undefined);
    if (usage && limits?.contextWindow) {
      usage.context_window = limits.contextWindow;
      usage.total_tokens =
        (usage.input_tokens || 0) +
        (usage.output_tokens || 0) +
        (usage.reasoning_output_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
    }
    const message: StreamMessage = {
      type: 'result',
      subtype: info?.error ? 'error' : 'success',
      duration_ms: info ? extractDurationMs(info) : 0,
      total_cost_usd: getNumber(info?.cost) || 0,
      usage: usage || { input_tokens: 0, output_tokens: 0 },
      ...(model ? { model } : {}),
    };
    session.status = 'completed';
    this.emit({ type: 'message', threadId: session.threadId, message });
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
  }

  private finalizeAssistantMessage(session: ActiveOpenCodeSession, messageId: string): void {
    if (!messageId || session.finalizedAssistantMessageIds.has(messageId)) {
      return;
    }
    const accumulator = session.assistantMessages.get(messageId);
    if (!accumulator || (!accumulator.text && !accumulator.reasoning)) {
      return;
    }
    session.finalizedAssistantMessageIds.add(messageId);

    const content: ContentBlock[] = [];
    if (accumulator.reasoning) {
      content.push({ type: 'thinking', thinking: accumulator.reasoning });
    }
    if (accumulator.text) {
      content.push({ type: 'text', text: accumulator.text });
    }

    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      },
    });
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: accumulator.uuid,
        message: { content },
      },
    });
  }

  private ensureAssistantAccumulator(
    session: ActiveOpenCodeSession,
    messageId: string
  ): OpenCodeAssistantAccumulator {
    let accumulator = session.assistantMessages.get(messageId);
    if (!accumulator) {
      accumulator = {
        messageId,
        uuid: uuidv4(),
        text: '',
        reasoning: '',
      };
      session.assistantMessages.set(messageId, accumulator);
    }
    return accumulator;
  }

  private async emitMcpStatus(session: ActiveOpenCodeSession): Promise<void> {
    if (!session.client.mcp?.status) {
      return;
    }
    try {
      const statusMap = await requestOpenCode<Record<string, unknown>>(
        session.client.mcp.status({ query: { directory: session.cwd } })
      );
      const servers = Object.entries(statusMap).map(([name, status]) => {
        const record = getRecord(status);
        const error = getString(record?.error);
        return {
          name,
          status: mapMcpStatus(status),
          ...(error ? { error } : {}),
          tool: 'opencode' as const,
        };
      });
      if (servers.length > 0) {
        this.emit({
          type: 'message',
          threadId: session.threadId,
          message: { type: 'mcp_status', servers },
        });
      }
    } catch (error) {
      console.warn('[OpenCodeSdkAdapter] failed to read MCP status:', error);
    }
  }

  private async emitAvailableCommands(session: ActiveOpenCodeSession): Promise<void> {
    let commands = FALLBACK_OPENCODE_COMMANDS;
    if (session.client.command?.list) {
      try {
        const result = await requestOpenCode<unknown[]>(
          session.client.command.list({ query: { directory: session.cwd } })
        );
        const sdkCommands = result
          .map((value) => this.normalizeOpenCodeCommand(value))
          .filter((command): command is AvailableCommand & OpenCodeCommandDescriptor => Boolean(command));
        if (sdkCommands.length > 0) {
          commands = sdkCommands;
        }
      } catch (error) {
        console.warn('[OpenCodeSdkAdapter] failed to list commands:', error);
      }
    }

    session.availableCommands = new Map(
      commands.map((command) => [
        command.name,
        {
          name: command.name,
          description: command.description,
          agent: (command as OpenCodeCommandDescriptor).agent,
          model: (command as OpenCodeCommandDescriptor).model,
        },
      ])
    );
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'available_commands_update',
        session_id: session.providerSessionId,
        availableCommands: commands,
      },
    });
  }

  private normalizeOpenCodeCommand(value: unknown): (AvailableCommand & OpenCodeCommandDescriptor) | null {
    const record = getRecord(value);
    if (!record) {
      return null;
    }
    const name = getString(record.name).replace(/^\//, '').trim().toLowerCase();
    if (!name) {
      return null;
    }
    const description =
      getString(record.description) ||
      getString(record.template) ||
      'OpenCode slash command';
    const agent = getString(record.agent).trim();
    const model = getString(record.model).trim();
    return {
      name,
      description,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
    };
  }

  private async refreshModelLimits(client: OpenCodeClient, cwd: string): Promise<void> {
    if (!client.config?.providers) {
      return;
    }
    try {
      const result = await requestOpenCode<Record<string, unknown>>(
        client.config.providers({ query: { directory: cwd } })
      );
      const providers = Array.isArray(result.providers) ? result.providers : [];
      for (const providerValue of providers) {
        const provider = getRecord(providerValue);
        if (!provider) continue;
        const providerId = getString(provider.id);
        const models = getRecord(provider.models);
        if (!providerId || !models) continue;
        for (const [modelId, modelValue] of Object.entries(models)) {
          const model = getRecord(modelValue);
          const limit = getRecord(model?.limit);
          const contextWindow = getNumber(limit?.context) || 0;
          if (contextWindow <= 0) continue;
          this.modelLimits.set(`${providerId}/${modelId}`, {
            contextWindow,
            outputLimit: getNumber(limit?.output) || 0,
          });
        }
      }
    } catch (error) {
      console.warn('[OpenCodeSdkAdapter] failed to read model limits:', error);
    }
  }

  private readModelLimits(info: Record<string, unknown>): { contextWindow: number; outputLimit: number } | null {
    const directLimit = getRecord(info.limit);
    const directContext = getNumber(directLimit?.context) || getNumber(info.contextWindow);
    const directOutput = getNumber(directLimit?.output) || getNumber(info.maxOutputTokens);
    if (directContext && directContext > 0) {
      return {
        contextWindow: directContext,
        outputLimit: directOutput || 0,
      };
    }

    const model = extractMessageModel(info);
    if (model) {
      return this.modelLimits.get(model) || null;
    }
    return null;
  }

  private async respondToOpenCodePermission(
    session: ActiveOpenCodeSession,
    permissionId: string,
    response: 'once' | 'always' | 'reject'
  ): Promise<void> {
    await requestOpenCode<boolean>(
      session.client.postSessionIdPermissionsPermissionId({
        path: {
          id: session.providerSessionId,
          permissionID: permissionId,
        },
        query: { directory: session.cwd },
        body: { response },
      })
    );
  }

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }
}
