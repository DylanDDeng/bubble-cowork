import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { buildGrokEnv, resolveGrokBinary } from '../grok-cli';
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
  GrokPermissionMode,
  GrokReasoningEffort,
  PermissionResult,
  PlanStepStatus,
  ProviderComposerCapabilities,
  StreamMessage,
} from '../../../shared/types';

type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

type GrokSessionUpdate = Record<string, unknown> & { sessionUpdate?: unknown };

interface ManagedTerminal {
  id: string;
  proc: ChildProcessWithoutNullStreams;
  exitCode: number | null;
  exited: boolean;
  exitResolvers: Array<(code: number) => void>;
}

interface ActiveGrokSession {
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
  permissionMode?: GrokPermissionMode;
  reasoningEffort?: GrokReasoningEffort;
  terminals: Map<string, ManagedTerminal>;
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

// ── Helpers ────────────────────────────────────────────────────────────────

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

/**
 * Extract the current model from a Grok CLI session result.
 *
 * The Grok CLI (unlike Kimi CLI) does not return standard ACP `configOptions`.
 * Instead it returns `models.currentModelId` at the top level of the
 * `session/new` / `session/resume` response.  We fall back to
 * `configOptions` for compatibility with the standard ACP format.
 */
function extractModelFromSessionResult(value: unknown): string | undefined {
  const record = getRecord(value);
  if (!record) return undefined;
  const models = getRecord(record.models);
  const currentModelId = getString(models?.currentModelId);
  if (currentModelId) return currentModelId;
  return extractModelFromConfigOptions(record.configOptions);
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

function normalizeGrokPermissionMode(value: unknown): GrokPermissionMode | undefined {
  return value === 'default' || value === 'plan' || value === 'auto' || value === 'yolo'
    ? value
    : undefined;
}

function normalizeGrokReasoningEffort(value: unknown): GrokReasoningEffort | undefined {
  const allowed: GrokReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  return typeof value === 'string' && allowed.includes(value as GrokReasoningEffort)
    ? (value as GrokReasoningEffort)
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

function buildGrokAgentArgs(effort?: GrokReasoningEffort): string[] {
  // `--reasoning-effort` is an `agent`-level flag that must precede the
  // `stdio` subcommand. After `stdio` the CLI rejects extra flags.
  return effort
    ? ['agent', '--reasoning-effort', effort, 'stdio']
    : ['agent', 'stdio'];
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class GrokAcpAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'grok';
  readonly displayName = 'Grok Build';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActiveGrokSession>();
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
    const binary = await resolveGrokBinary();
    if (!binary) {
      throw new Error('Grok Build CLI was not found. Install Grok Build or set GROK_CODE_PATH.');
    }

    const reasoningEffort = normalizeGrokReasoningEffort(input.grokReasoningEffort);
    const args = buildGrokAgentArgs(reasoningEffort);

    const proc = spawn(binary, args, {
      cwd: input.cwd,
      env: buildGrokEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        console.warn('[Grok ACP]', text);
      }
    });

    let rpc!: AcpJsonRpcClient;
    rpc = new AcpJsonRpcClient(
      proc,
      (method, params) => this.handleNotification(input.threadId, method, params),
      (request) => this.handleRequest(input.threadId, rpc, request),
      (line, error) => {
        console.warn('[Grok ACP] failed to parse stdout line', { line, error: error.message });
      }
    );

    await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.32' },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    const permissionMode = normalizeGrokPermissionMode(input.grokPermissionMode);
    const sessionResult = await rpc.request(input.resumeSessionId ? 'session/resume' : 'session/new', {
      ...(input.resumeSessionId ? { sessionId: input.resumeSessionId } : {}),
      cwd: input.cwd,
      mcpServers: [],
      ...(permissionMode ? { permissionMode } : {}),
    });
    let sessionRecord = getRecord(sessionResult);
    const providerSessionId = getString(sessionRecord?.sessionId || sessionRecord?.id || input.resumeSessionId);
    if (!providerSessionId) {
      throw new Error('Grok ACP did not return a sessionId.');
    }
    let model = extractModelFromSessionResult(sessionRecord);
    if (input.model?.trim() && input.model.trim() !== model) {
      try {
        const configId = extractModelConfigId(sessionRecord?.configOptions);
        const configResult = await rpc.request('session/set_config_option', {
          sessionId: providerSessionId,
          configId,
          value: input.model.trim(),
        });
        sessionRecord = getRecord(configResult) || sessionRecord;
        model = extractModelFromSessionResult(sessionRecord) || input.model.trim();
      } catch {
        // Grok CLI may not support session/set_config_option; keep the default model.
      }
    }
    // If permission mode wasn't accepted in session/new, try set_config_option
    if (permissionMode && !sessionRecord?.permissionMode) {
      try {
        const configId = extractConfigId(sessionRecord?.configOptions, 'mode', 'mode');
        const configResult = await rpc.request('session/set_config_option', {
          sessionId: providerSessionId,
          configId,
          value: permissionMode,
        });
        sessionRecord = getRecord(configResult) || sessionRecord;
      } catch {
        // Grok CLI may not support session/set_config_option; keep the default mode.
      }
    }

    const active: ActiveGrokSession = {
      threadId: input.threadId,
      providerSessionId,
      status: 'running',
      cwd: input.cwd,
      model,
      proc,
      rpc,
      toolCalls: new Map(),
      permissionMode,
      reasoningEffort,
      terminals: new Map(),
    };
    this.sessions.set(input.threadId, active);

    proc.on('exit', () => {
      const current = this.sessions.get(input.threadId);
      if (current?.proc === proc) {
        current.status = current.status === 'stopped' ? 'stopped' : 'completed';
        this.cleanupTerminals(current);
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
        grokPermissionMode: permissionMode,
      });
    }

    return {
      threadId: input.threadId,
      provider: 'grok',
      providerSessionId,
      status: 'running',
      model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No Grok session found for thread "${input.threadId}"`);
    }

    session.status = 'running';
    session.currentAssistant = undefined;
    session.currentThinking = undefined;
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    try {
      await this.applyPermissionMode(session, input.grokPermissionMode);
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
    this.cleanupTerminals(session);
    session.proc.kill('SIGTERM');
    this.sessions.delete(threadId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((threadId) => this.stopSession(threadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      threadId: session.threadId,
      provider: 'grok',
      providerSessionId: session.providerSessionId,
      status: session.status,
      model: session.model,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  private async applyPermissionMode(
    session: ActiveGrokSession,
    mode: GrokPermissionMode | undefined
  ): Promise<void> {
    const permissionMode = normalizeGrokPermissionMode(mode);
    if (!permissionMode || session.permissionMode === permissionMode) {
      return;
    }
    try {
      await session.rpc.request('session/set_config_option', {
        sessionId: session.providerSessionId,
        configId: 'mode',
        value: permissionMode,
      });
      session.permissionMode = permissionMode;
    } catch {
      // Some Grok versions may not support mid-session mode changes; ignore.
    }
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
      provider: 'grok',
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      // Grok ACP pushes available_commands_update (builtins + skills) after session/new.
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: false,
    };
  }

  // ── ACP notification / request routing ───────────────────────────────────

  private handleNotification(
    threadId: string,
    method: string,
    params?: Record<string, unknown>
  ): void {
    if (method !== 'session/update') {
      return;
    }
    const update = getRecord(params?.update) as GrokSessionUpdate | null;
    if (!update) return;
    this.handleSessionUpdate(threadId, update);
  }

  private handleRequest(
    threadId: string,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    const session = this.sessions.get(threadId);
    if (!session) {
      rpc.respond(request.id, undefined, {
        code: -32603,
        message: `No active Grok session for thread "${threadId}".`,
      });
      return;
    }

    switch (request.method) {
      case 'session/request_permission':
        this.handlePermissionRequest(threadId, rpc, request);
        return;

      case 'fs/read_text_file':
        this.handleReadTextFile(rpc, request, session);
        return;

      case 'fs/write_text_file':
        this.handleWriteTextFile(rpc, request, session);
        return;

      case 'terminal/create':
        this.handleTerminalCreate(session, rpc, request);
        return;

      case 'terminal/wait_for_exit':
        this.handleTerminalWaitForExit(session, rpc, request);
        return;

      case 'terminal/kill':
        this.handleTerminalKill(session, rpc, request);
        return;

      case 'terminal/release':
        this.handleTerminalRelease(session, rpc, request);
        return;

      default:
        rpc.respond(request.id, undefined, {
          code: -32601,
          message: `Unsupported Grok ACP reverse request: ${request.method}`,
        });
    }
  }

  // ── Permission handling ──────────────────────────────────────────────────

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
    const requestId = `grok-permission:${threadId}:${request.id}`;
    this.pendingPermissions.set(requestId, { threadId, rpc, request, options });
    const title = getString(toolCall?.title) || 'Grok permission request';
    const input: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'grok',
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

  // ── File system bridge ───────────────────────────────────────────────────

  private handleReadTextFile(
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest,
    _session: ActiveGrokSession
  ): void {
    const params = getRecord(request.params);
    const filePath = getString(params?.path);
    if (!filePath) {
      rpc.respond(request.id, undefined, {
        code: -32602,
        message: 'fs/read_text_file requires a "path" parameter.',
      });
      return;
    }
    try {
      const content = readFileSync(filePath, 'utf8');
      rpc.respond(request.id, { content });
    } catch (error) {
      rpc.respond(request.id, undefined, {
        code: -32000,
        message: `Failed to read file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private handleWriteTextFile(
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest,
    _session: ActiveGrokSession
  ): void {
    const params = getRecord(request.params);
    const filePath = getString(params?.path);
    const content = typeof params?.content === 'string' ? params.content : '';
    if (!filePath) {
      rpc.respond(request.id, undefined, {
        code: -32602,
        message: 'fs/write_text_file requires a "path" parameter.',
      });
      return;
    }
    try {
      writeFileSync(filePath, content, 'utf8');
      rpc.respond(request.id, {});
    } catch (error) {
      rpc.respond(request.id, undefined, {
        code: -32000,
        message: `Failed to write file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ── Terminal bridge ──────────────────────────────────────────────────────

  private handleTerminalCreate(
    session: ActiveGrokSession,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    const params = getRecord(request.params);
    const command = params?.command;
    const cwd = getString(params?.cwd) || session.cwd;
    const env = getRecord(params?.env);

    // command can be a string or string[]
    let cmd: string;
    let cmdArgs: string[];
    if (Array.isArray(command) && command.length > 0) {
      cmd = String(command[0]);
      cmdArgs = command.slice(1).map(String);
    } else if (typeof command === 'string' && command.trim()) {
      cmd = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      cmdArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];
    } else {
      rpc.respond(request.id, undefined, {
        code: -32602,
        message: 'terminal/create requires a "command" parameter.',
      });
      return;
    }

    const terminalId = `grok-term:${session.threadId}:${uuidv4()}`;
    try {
      const termEnv: NodeJS.ProcessEnv = { ...process.env };
      if (env) {
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === 'string') {
            termEnv[key] = value;
          }
        }
      }
      const termProc = spawn(cmd, cmdArgs, {
        cwd,
        env: termEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const managed: ManagedTerminal = {
        id: terminalId,
        proc: termProc,
        exitCode: null,
        exited: false,
        exitResolvers: [],
      };

      termProc.stdout.setEncoding('utf8');
      termProc.stderr.setEncoding('utf8');
      termProc.stdout.on('data', (chunk) => {
        const output = String(chunk);
        if (output) {
          rpc.notify('terminal/output', { terminalId, output, stream: 'stdout' });
        }
      });
      termProc.stderr.on('data', (chunk) => {
        const output = String(chunk);
        if (output) {
          rpc.notify('terminal/output', { terminalId, output, stream: 'stderr' });
        }
      });
      termProc.on('exit', (code) => {
        managed.exitCode = code ?? 0;
        managed.exited = true;
        for (const resolve of managed.exitResolvers) {
          resolve(managed.exitCode);
        }
        managed.exitResolvers = [];
      });
      termProc.on('error', (err) => {
        console.warn('[Grok ACP] terminal process error', { terminalId, error: err.message });
        if (!managed.exited) {
          managed.exitCode = 1;
          managed.exited = true;
          for (const resolve of managed.exitResolvers) {
            resolve(managed.exitCode);
          }
          managed.exitResolvers = [];
        }
      });

      session.terminals.set(terminalId, managed);
      rpc.respond(request.id, { terminalId });
    } catch (error) {
      rpc.respond(request.id, undefined, {
        code: -32000,
        message: `Failed to create terminal: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private handleTerminalWaitForExit(
    session: ActiveGrokSession,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    const params = getRecord(request.params);
    const terminalId = getString(params?.terminalId);
    const managed = terminalId ? session.terminals.get(terminalId) : undefined;
    if (!managed) {
      rpc.respond(request.id, undefined, {
        code: -32602,
        message: `Unknown terminalId: ${terminalId}`,
      });
      return;
    }
    if (managed.exited) {
      rpc.respond(request.id, { exitCode: managed.exitCode ?? 0 });
      return;
    }
    managed.exitResolvers.push((code) => {
      rpc.respond(request.id, { exitCode: code });
    });
  }

  private handleTerminalKill(
    session: ActiveGrokSession,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    const params = getRecord(request.params);
    const terminalId = getString(params?.terminalId);
    const managed = terminalId ? session.terminals.get(terminalId) : undefined;
    if (!managed) {
      rpc.respond(request.id, undefined, {
        code: -32602,
        message: `Unknown terminalId: ${terminalId}`,
      });
      return;
    }
    try {
      if (!managed.exited) {
        managed.proc.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
    rpc.respond(request.id, {});
  }

  private handleTerminalRelease(
    session: ActiveGrokSession,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    const params = getRecord(request.params);
    const terminalId = getString(params?.terminalId);
    const managed = terminalId ? session.terminals.get(terminalId) : undefined;
    if (managed) {
      try {
        if (!managed.exited) {
          managed.proc.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
      session.terminals.delete(terminalId);
    }
    rpc.respond(request.id, {});
  }

  private cleanupTerminals(session: ActiveGrokSession): void {
    for (const managed of session.terminals.values()) {
      try {
        if (!managed.exited) {
          managed.proc.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
    }
    session.terminals.clear();
  }

  // ── Session update handling (shared with Kimi pattern) ───────────────────

  private handleSessionUpdate(threadId: string, update: GrokSessionUpdate): void {
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

  private emitAssistantDelta(session: ActiveGrokSession, text: string): void {
    if (!text) return;
    const current = session.currentAssistant || {
      uuid: `grok-assistant:${session.threadId}:${uuidv4()}`,
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

  private emitThinkingDelta(session: ActiveGrokSession, thinking: string): void {
    if (!thinking) return;
    const current = session.currentThinking || {
      uuid: `grok-thinking:${session.threadId}:${uuidv4()}`,
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

  private finalizeStreaming(session: ActiveGrokSession): void {
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

  private emitToolUse(threadId: string, update: GrokSessionUpdate): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    const id = getString(update.toolCallId) || uuidv4();
    const name = getString(update.title) || 'GrokTool';
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
      uuid: `grok-tool-use:${threadId}:${id}`,
      createdAt,
      message: {
        content: [{ type: 'tool_use', id, name, input: rawInput }],
      },
    };
    this.emit({ type: 'message', threadId, message });
  }

  private handleToolCallUpdate(session: ActiveGrokSession, update: GrokSessionUpdate): void {
    const id = getString(update.toolCallId);
    if (!id) return;
    const status = getString(update.status);
    if (status === 'in_progress') {
      this.emitToolInputUpdate(session, update);
      return;
    }
    this.emitToolResult(session.threadId, update);
  }

  private emitToolInputUpdate(session: ActiveGrokSession, update: GrokSessionUpdate): void {
    const id = getString(update.toolCallId);
    if (!id) return;
    const text = this.extractToolOutput(update);
    const parsedInput = text ? parseJsonRecord(text) : null;
    if (!parsedInput) return;
    const existing = session.toolCalls.get(id);
    const name = existing?.name || getString(update.title) || 'GrokTool';
    const createdAt = existing?.createdAt || Date.now();
    session.toolCalls.set(id, {
      name,
      input: parsedInput,
      createdAt,
    });
    const message: StreamMessage = {
      type: 'assistant',
      uuid: `grok-tool-use:${session.threadId}:${id}`,
      createdAt,
      message: {
        content: [{ type: 'tool_use', id, name, input: parsedInput }],
      },
    };
    this.emit({ type: 'message', threadId: session.threadId, message });
  }

  private emitToolResult(threadId: string, update: GrokSessionUpdate): void {
    const id = getString(update.toolCallId);
    if (!id) return;
    const status = getString(update.status);
    const text = this.extractToolOutput(update);
    if (!text) return;
    const message: StreamMessage = {
      type: 'assistant',
      uuid: `grok-tool-result:${threadId}:${id}:${uuidv4()}`,
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

  private extractToolOutput(update: GrokSessionUpdate): string {
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

  private emitPlan(threadId: string, update: GrokSessionUpdate): void {
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
        uuid: `grok-plan:${threadId}:${uuidv4()}`,
        turnId: `grok:${threadId}`,
        steps,
      },
    });
  }

  private emitAvailableCommands(
    threadId: string,
    sessionId: string,
    update: GrokSessionUpdate
  ): void {
    const availableCommands = getArray(update.availableCommands)
      .map((command) => {
        const record = getRecord(command);
        const name = getString(record?.name).replace(/^\//, '').trim();
        if (!name) return null;
        const description = getString(record?.description) || 'Grok Build slash command';
        const inputRecord = getRecord(record?.input);
        const hint = getString(inputRecord?.hint);
        return {
          name,
          description,
          ...(hint ? { input: { hint } } : {}),
        };
      })
      .filter(
        (
          command
        ): command is {
          name: string;
          description: string;
          input?: { hint: string };
        } => Boolean(command)
      );
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
