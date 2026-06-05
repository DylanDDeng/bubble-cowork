import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { buildKimiEnv, resolveKimiBinary } from '../kimi-cli';
import { AcpJsonRpcClient, type AcpJsonRpcIncomingRequest } from './acp-json-rpc-client';
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
  PermissionResult,
  PlanStepStatus,
  ProviderComposerCapabilities,
  StreamMessage,
} from '../../../shared/types';

type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

type KimiSessionUpdate = Record<string, unknown> & { sessionUpdate?: unknown };

interface ActiveKimiSession {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  proc: ChildProcessWithoutNullStreams;
  rpc: AcpJsonRpcClient;
  currentAssistant?: { uuid: string; text: string; createdAt: number };
  currentThinking?: { uuid: string; thinking: string; createdAt: number };
  toolCalls: Map<string, { name: string; input: Record<string, unknown>; createdAt: number }>;
  permissionMode?: KimiPermissionMode;
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: true,
  skillDiscovery: false,
  pluginDiscovery: false,
  mcpServers: true,
  imageAttachments: true,
  forkThread: false,
  compactThread: false,
  planMode: true,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const record = getRecord(content);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  const nested = getRecord(record.content);
  return typeof nested?.text === 'string' ? nested.text : '';
}

function extractModelFromConfigOptions(value: unknown): string | undefined {
  for (const option of getArray(value)) {
    const record = getRecord(option);
    if (!record) continue;
    const id = getString(record.configId || record.id || record.name);
    if (id !== 'model') continue;
    const current = getString(record.currentValue || record.value || record.selectedValue);
    if (current) return current;
  }
  return undefined;
}

function extractModelConfigId(value: unknown): string {
  for (const option of getArray(value)) {
    const record = getRecord(option);
    if (!record) continue;
    const id = getString(record.configId || record.id || record.name);
    const category = getString(record.category);
    if (id === 'model' || category === 'model') {
      return id || 'model';
    }
  }
  return 'model';
}

function extractConfigId(value: unknown, targetId: string, fallback: string): string {
  for (const option of getArray(value)) {
    const record = getRecord(option);
    if (!record) continue;
    const id = getString(record.configId || record.id || record.name);
    const category = getString(record.category);
    if (id === targetId || category === targetId) {
      return id || fallback;
    }
  }
  return fallback;
}

function normalizeKimiPermissionMode(value: unknown): KimiPermissionMode | undefined {
  return value === 'default' || value === 'plan' || value === 'auto' || value === 'yolo'
    ? value
    : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return getRecord(parsed);
  } catch {
    return null;
  }
}

function buildPromptBlocks(prompt: string, attachments?: Attachment[]): PromptBlock[] {
  const blocks: PromptBlock[] = [];
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
        blocks.push({
          type: 'text',
          text: `Image attachment could not be read: ${attachment.path}`,
        });
      }
      continue;
    }

    if (attachment.previewText?.trim()) {
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

export class KimiAcpAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActiveKimiSession>();
  private pendingPermissions = new Map<
    string,
    {
      threadId: string;
      rpc: AcpJsonRpcClient;
      request: AcpJsonRpcIncomingRequest;
      options: AcpPermissionOption[];
    }
  >();

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const binary = await resolveKimiBinary();
    if (!binary) {
      throw new Error('Kimi Code CLI was not found. Install Kimi Code or set KIMI_CODE_PATH.');
    }

    const proc = spawn(binary, ['acp'], {
      cwd: input.cwd,
      env: buildKimiEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        console.warn('[Kimi ACP]', text);
      }
    });

    let rpc!: AcpJsonRpcClient;
    rpc = new AcpJsonRpcClient(
      proc,
      (method, params) => this.handleNotification(input.threadId, method, params),
      (request) => this.handleRequest(input.threadId, rpc, request),
      (line, error) => {
        console.warn('[Kimi ACP] failed to parse stdout line', { line, error: error.message });
      }
    );

    await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.32' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });

    const sessionResult = await rpc.request(input.resumeSessionId ? 'session/resume' : 'session/new', {
      ...(input.resumeSessionId ? { sessionId: input.resumeSessionId } : {}),
      cwd: input.cwd,
      mcpServers: [],
    });
    let sessionRecord = getRecord(sessionResult);
    const providerSessionId = getString(sessionRecord?.sessionId || sessionRecord?.id || input.resumeSessionId);
    if (!providerSessionId) {
      throw new Error('Kimi ACP did not return a sessionId.');
    }
    let model = extractModelFromConfigOptions(sessionRecord?.configOptions);
    if (input.model?.trim()) {
      const configId = extractModelConfigId(sessionRecord?.configOptions);
      const configResult = await rpc.request('session/set_config_option', {
        sessionId: providerSessionId,
        configId,
        value: input.model.trim(),
      });
      sessionRecord = getRecord(configResult) || sessionRecord;
      model = extractModelFromConfigOptions(sessionRecord?.configOptions) || input.model.trim();
    }
    const permissionMode = normalizeKimiPermissionMode(input.kimiPermissionMode);
    if (permissionMode) {
      const configId = extractConfigId(sessionRecord?.configOptions, 'mode', 'mode');
      const configResult = await rpc.request('session/set_config_option', {
        sessionId: providerSessionId,
        configId,
        value: permissionMode,
      });
      sessionRecord = getRecord(configResult) || sessionRecord;
    }

    const active: ActiveKimiSession = {
      threadId: input.threadId,
      providerSessionId,
      status: 'running',
      cwd: input.cwd,
      model,
      proc,
      rpc,
      toolCalls: new Map(),
      permissionMode,
    };
    this.sessions.set(input.threadId, active);

    proc.on('exit', () => {
      const current = this.sessions.get(input.threadId);
      if (current?.proc === proc) {
        current.status = current.status === 'stopped' ? 'stopped' : 'completed';
        this.emit({ type: 'status_change', threadId: input.threadId, status: current.status });
      }
    });

    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: providerSessionId,
      model,
    });

    if (input.prompt || input.attachments?.length) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model || model,
        kimiPermissionMode: permissionMode,
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
      throw new Error(`No Kimi session found for thread "${input.threadId}"`);
    }

    session.status = 'running';
    session.currentAssistant = undefined;
    session.currentThinking = undefined;
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    try {
      await this.applyPermissionMode(session, input.kimiPermissionMode);
      await session.rpc.request('session/prompt', {
        sessionId: session.providerSessionId,
        prompt: buildPromptBlocks(input.prompt, input.attachments),
      });
      this.finalizeStreaming(session);
      session.status = 'completed';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: 'success',
          duration_ms: 0,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      this.emit({ type: 'status_change', threadId: input.threadId, status: 'completed' });
    } catch (error) {
      this.finalizeStreaming(session);
      session.status = 'error';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: 'error',
          duration_ms: 0,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      this.emit({
        type: 'error',
        threadId: input.threadId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.status = 'stopped';
    try {
      session.rpc.notify('session/cancel', { sessionId: session.providerSessionId });
    } catch {
      // ignore shutdown cancellation errors
    }
    session.proc.kill('SIGTERM');
    this.sessions.delete(threadId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((threadId) => this.stopSession(threadId)));
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

  private async applyPermissionMode(
    session: ActiveKimiSession,
    mode: KimiPermissionMode | undefined
  ): Promise<void> {
    const permissionMode = normalizeKimiPermissionMode(mode);
    if (!permissionMode || session.permissionMode === permissionMode) {
      return;
    }
    await session.rpc.request('session/set_config_option', {
      sessionId: session.providerSessionId,
      configId: 'mode',
      value: permissionMode,
    });
    session.permissionMode = permissionMode;
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: PermissionResult
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.threadId !== threadId) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    const optionId = this.resolveOptionId(decision, pending.options);
    pending.rpc.respond(pending.request.id, {
      outcome: optionId
        ? { outcome: 'selected', optionId }
        : { outcome: 'cancelled' },
    });
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: 'kimi',
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: false,
    };
  }

  private handleNotification(
    threadId: string,
    method: string,
    params?: Record<string, unknown>
  ): void {
    if (method !== 'session/update') {
      return;
    }
    const update = getRecord(params?.update) as KimiSessionUpdate | null;
    if (!update) return;
    this.handleSessionUpdate(threadId, update);
  }

  private handleRequest(
    threadId: string,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    if (request.method === 'session/request_permission') {
      this.handlePermissionRequest(threadId, rpc, request);
      return;
    }
    if (request.method.includes('read_text_file') || request.method.includes('write_text_file')) {
      rpc.respond(request.id, undefined, {
        code: -32601,
        message: 'Aegis does not enable Kimi ACP file bridge yet.',
      });
      return;
    }
    rpc.respond(request.id, undefined, {
      code: -32601,
      message: `Unsupported Kimi ACP reverse request: ${request.method}`,
    });
  }

  private handlePermissionRequest(
    threadId: string,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    const params = getRecord(request.params);
    const toolCall = getRecord(params?.toolCall);
    const options = getArray(params?.options)
      .map((option): AcpPermissionOption | null => {
        const record = getRecord(option);
        const optionId = getString(record?.optionId);
        if (!optionId) return null;
        return {
          optionId,
          name: getString(record?.name) || optionId,
          kind: getString(record?.kind) || undefined,
          description: getString(record?.description) || undefined,
        };
      })
      .filter((option): option is AcpPermissionOption => Boolean(option));
    const requestId = `kimi-permission:${threadId}:${request.id}`;
    this.pendingPermissions.set(requestId, { threadId, rpc, request, options });
    const title = getString(toolCall?.title) || 'Kimi permission request';
    const input: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'kimi',
      question: title,
      title,
      toolName: title,
      options,
      toolCall,
    };
    this.emit({
      type: 'permission_request',
      threadId,
      requestId,
      toolName: title,
      input,
    });
  }

  private handleSessionUpdate(threadId: string, update: KimiSessionUpdate): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.emitAssistantDelta(session, extractTextContent(update.content));
        break;
      case 'agent_thought_chunk':
        this.emitThinkingDelta(session, extractTextContent(update.content));
        break;
      case 'tool_call':
        this.emitToolUse(threadId, update);
        break;
      case 'tool_call_update':
        this.handleToolCallUpdate(session, update);
        break;
      case 'plan':
        this.emitPlan(threadId, update);
        break;
      case 'available_commands_update':
        this.emitAvailableCommands(threadId, session.providerSessionId, update);
        break;
      case 'config_option_update':
        session.model = extractModelFromConfigOptions(update.configOptions) || session.model;
        break;
      default:
        break;
    }
  }

  private emitAssistantDelta(session: ActiveKimiSession, text: string): void {
    if (!text) return;
    const current = session.currentAssistant || {
      uuid: `kimi-assistant:${session.threadId}:${uuidv4()}`,
      text: '',
      createdAt: Date.now(),
    };
    current.text += text;
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

  private emitThinkingDelta(session: ActiveKimiSession, thinking: string): void {
    if (!thinking) return;
    const current = session.currentThinking || {
      uuid: `kimi-thinking:${session.threadId}:${uuidv4()}`,
      thinking: '',
      createdAt: Date.now(),
    };
    current.thinking += thinking;
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

  private finalizeStreaming(session: ActiveKimiSession): void {
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

  private emitToolUse(threadId: string, update: KimiSessionUpdate): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    const id = getString(update.toolCallId) || uuidv4();
    const name = getString(update.title) || 'KimiTool';
    const rawInput = getRecord(update.rawInput) || {};
    const existing = session.toolCalls.get(id);
    const createdAt = existing?.createdAt || Date.now();
    session.toolCalls.set(id, {
      name,
      input: rawInput,
      createdAt,
    });
    const message: StreamMessage = {
      type: 'assistant',
      uuid: `kimi-tool-use:${threadId}:${id}`,
      createdAt,
      message: {
        content: [{ type: 'tool_use', id, name, input: rawInput }],
      },
    };
    this.emit({ type: 'message', threadId, message });
  }

  private handleToolCallUpdate(session: ActiveKimiSession, update: KimiSessionUpdate): void {
    const id = getString(update.toolCallId);
    if (!id) return;
    const status = getString(update.status);
    if (status === 'in_progress') {
      this.emitToolInputUpdate(session, update);
      return;
    }
    this.emitToolResult(session.threadId, update);
  }

  private emitToolInputUpdate(session: ActiveKimiSession, update: KimiSessionUpdate): void {
    const id = getString(update.toolCallId);
    if (!id) return;
    const text = this.extractToolOutput(update);
    const parsedInput = text ? parseJsonRecord(text) : null;
    if (!parsedInput) return;
    const existing = session.toolCalls.get(id);
    const name = existing?.name || getString(update.title) || 'KimiTool';
    const createdAt = existing?.createdAt || Date.now();
    session.toolCalls.set(id, {
      name,
      input: parsedInput,
      createdAt,
    });
    const message: StreamMessage = {
      type: 'assistant',
      uuid: `kimi-tool-use:${session.threadId}:${id}`,
      createdAt,
      message: {
        content: [{ type: 'tool_use', id, name, input: parsedInput }],
      },
    };
    this.emit({ type: 'message', threadId: session.threadId, message });
  }

  private emitToolResult(threadId: string, update: KimiSessionUpdate): void {
    const id = getString(update.toolCallId);
    if (!id) return;
    const status = getString(update.status);
    const text = this.extractToolOutput(update);
    if (!text) return;
    const message: StreamMessage = {
      type: 'assistant',
      uuid: `kimi-tool-result:${threadId}:${id}:${uuidv4()}`,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: text || status || 'Updated',
            is_error: status === 'failed',
          },
        ],
      },
    };
    this.emit({ type: 'message', threadId, message });
  }

  private extractToolOutput(update: KimiSessionUpdate): string {
    if (typeof update.rawOutput === 'string') return update.rawOutput;
    const content = getArray(update.content)
      .map((item) => {
        const record = getRecord(item);
        const nested = getRecord(record?.content);
        return extractTextContent(nested || record);
      })
      .filter(Boolean)
      .join('\n');
    if (content) return content;
    if (update.rawOutput !== undefined) {
      try {
        return JSON.stringify(update.rawOutput);
      } catch {
        return String(update.rawOutput);
      }
    }
    return '';
  }

  private emitPlan(threadId: string, update: KimiSessionUpdate): void {
    const steps = getArray(update.entries)
      .map((entry) => {
        const record = getRecord(entry);
        const status = getString(record?.status);
        const planStatus: PlanStepStatus =
          status === 'completed'
            ? 'completed'
            : status === 'in_progress'
              ? 'inProgress'
              : 'pending';
        return {
          step: getString(record?.content || record?.title || record?.step),
          status: planStatus,
        };
      })
      .filter((step) => step.step);
    if (steps.length === 0) return;
    this.emit({
      type: 'message',
      threadId,
      message: {
        type: 'plan_update',
        uuid: `kimi-plan:${threadId}:${uuidv4()}`,
        turnId: `kimi:${threadId}`,
        steps,
      },
    });
  }

  private emitAvailableCommands(
    threadId: string,
    sessionId: string,
    update: KimiSessionUpdate
  ): void {
    const availableCommands = getArray(update.availableCommands)
      .map((command) => {
        const record = getRecord(command);
        const name = getString(record?.name);
        if (!name) return null;
        return {
          name,
          description: getString(record?.description),
        };
      })
      .filter((command): command is { name: string; description: string } => Boolean(command));
    this.emit({
      type: 'message',
      threadId,
      message: {
        type: 'system',
        subtype: 'available_commands_update',
        session_id: sessionId,
        availableCommands,
      },
    });
  }

  private resolveOptionId(decision: PermissionResult, options: AcpPermissionOption[]): string | null {
    const explicit = decision.updatedInput?.optionId;
    if (typeof explicit === 'string' && options.some((option) => option.optionId === explicit)) {
      return explicit;
    }
    const lowerKind = (option: AcpPermissionOption) => `${option.kind || ''} ${option.optionId}`.toLowerCase();
    if (decision.behavior === 'allow') {
      return options.find((option) => !lowerKind(option).includes('reject'))?.optionId || options[0]?.optionId || null;
    }
    return options.find((option) => lowerKind(option).includes('reject'))?.optionId || null;
  }

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }
}
