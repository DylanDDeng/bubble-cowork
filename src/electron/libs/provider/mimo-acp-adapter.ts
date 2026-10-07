import { getWorkflowSessionPolicy } from '../workflow/session-hooks';
import { getSessionReaderHttpConfig, SESSION_MCP_SERVER_NAME } from '../session-http-server';
import { createGrokAcpHttpMcpServer } from './grok-acp-mcp';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { buildMimoEnv, listMimoSkills, readMimoLastTurnError, readMimoTurnUsage, resolveMimoBinary } from '../mimo-cli';
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
  MimoPermissionMode,
  PermissionResult,
  ProviderComposerCapabilities,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillDescriptor,
} from '../../../shared/types';

/**
 * MiMo Code over ACP (`mimo acp`, JSON-RPC on stdio). MiMo is an OpenCode
 * fork; verified against mimo 0.1.14:
 * - The client advertises no fs/terminal capabilities; MiMo runs its own
 *   tools and reports them as tool_call updates (OpenCode tool ids as the
 *   title, camelCase arguments).
 * - Reasoning levels are model variants: the `model` select lists
 *   `provider/model` and `provider/model/variant`.
 * - Modes are MiMo's primary agents. `build` allows every tool, so Aegis
 *   injects an `ask` agent with approval rules through MIMOCODE_CONFIG_CONTENT.
 * - The `question` tool is not bridged to ACP (it would wait forever), so it
 *   is denied in the injected config.
 * - A failed model call (bad key, quota, content filter) ends the turn with
 *   a plain end_turn and no error notification (a filtered reply may still
 *   stream a refusal); the error is read from MiMo's database.
 * - ACP's prompt usage covers only the last model step; per-turn totals are
 *   summed from MiMo's database, one stored message per step.
 * - session/load replays the conversation before it returns; dropped.
 * - After an approved edit, MiMo sends fs/write_text_file (meant for editor
 *   buffers) although fs is not advertised; its edit tool writes the file
 *   itself, so Aegis acknowledges without writing.
 */

type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

type MimoSessionUpdate = Record<string, unknown> & { sessionUpdate?: unknown };

interface MimoToolCall {
  name: string;
  title: string;
  input: Record<string, unknown>;
  createdAt: number;
  /** Latest output snapshot; MiMo streams bash output cumulatively. */
  output: string;
  settled: boolean;
}

interface ActiveMimoSession {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  /** Current value of the `model` select, variant included. */
  modelValue?: string;
  /** Values the `model` select accepts (base ids and `id/variant`). */
  modelValues: Set<string>;
  /** Last requested value the session rejected; not retried every turn. */
  rejectedModelValue?: string;
  /** Composer choices, reconciled before every turn. */
  requestedModel?: string;
  requestedEffort?: string;
  currentMode?: string;
  permissionMode?: MimoPermissionMode;
  /** Cumulative session cost from the latest usage_update. */
  sessionCostUsd: number;
  proc: ChildProcessWithoutNullStreams;
  rpc: AcpJsonRpcClient;
  currentAssistant?: { uuid: string; text: string; createdAt: number; blockIndex: number };
  currentThinking?: { uuid: string; thinking: string; createdAt: number; blockIndex: number };
  nextBlockIndex: number;
  lastCommandsSignature?: string;
  toolCalls: Map<string, MimoToolCall>;
  /** Anything streamed this turn; a silent turn may be a swallowed error. */
  turnHadOutput: boolean;
}

/** See DevinAcpAdapter: pre-bind notifications are startup state or load replay. */
interface SessionBinding {
  session?: ActiveMimoSession;
  commands?: MimoSessionUpdate;
  usage?: MimoSessionUpdate;
  currentMode?: string;
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: true,
  skillDiscovery: false,
  pluginDiscovery: false,
  mcpServers: false,
  imageAttachments: true,
  forkThread: false,
  compactThread: false,
  planMode: true,
};

const SKILLS_CACHE_TTL_MS = 5 * 60 * 1000;

const MIMO_PERMISSION_MODES: ReadonlyArray<MimoPermissionMode> = ['ask', 'build', 'plan'];

/**
 * Injected for Aegis's processes only. Top-level `permission` merges into
 * every agent last, so `question: deny` holds in build and plan too.
 */
export const MIMO_AEGIS_CONFIG = {
  permission: { question: 'deny' },
  agent: {
    ask: {
      mode: 'primary',
      description: 'Asks before edits, shell commands and web fetches.',
      permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
    },
  },
} as const;

/** OpenCode tool ids → the Claude-shaped names the transcript renders richly. */
const MIMO_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  grep: 'Grep',
  glob: 'Glob',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  task: 'Task',
};

const ACP_KIND_TOOL_NAMES: Record<string, string> = {
  execute: 'Bash',
  read: 'Read',
  edit: 'Edit',
  search: 'Grep',
  fetch: 'WebFetch',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Open set: variants differ per model and come from MiMo itself. */
export function normalizeMimoReasoningEffort(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value.trim()) ? value.trim() : undefined;
}

export function normalizeMimoPermissionMode(value: unknown): MimoPermissionMode | undefined {
  return typeof value === 'string' && MIMO_PERMISSION_MODES.includes(value as MimoPermissionMode)
    ? (value as MimoPermissionMode)
    : undefined;
}

function extractConfigValue(configOptions: unknown, id: string): string | undefined {
  for (const option of getArray(configOptions)) {
    const record = getRecord(option);
    if (!record) continue;
    if (getString(record.id) !== id && getString(record.category) !== id) continue;
    const value = getString(record.currentValue);
    if (value) return value;
  }
  return undefined;
}

function extractModelValues(configOptions: unknown): Set<string> {
  const values = new Set<string>();
  const visit = (entries: unknown): void => {
    for (const entry of getArray(entries)) {
      const record = getRecord(entry);
      if (!record) continue;
      if (Array.isArray(record.options)) visit(record.options);
      else if (getString(record.value)) values.add(getString(record.value));
    }
  };
  for (const option of getArray(configOptions)) {
    const record = getRecord(option);
    if (record && (getString(record.id) === 'model' || getString(record.category) === 'model')) {
      visit(record.options);
    }
  }
  return values;
}

/**
 * `provider/model/variant` → base model + variant. Model ids may contain
 * slashes themselves, so the split counts only when the prefix is a model the
 * select also offers on its own.
 */
export function splitMimoModelValue(
  value: string | undefined,
  modelValues: Set<string>
): { model?: string; effort?: string } {
  if (!value) return {};
  const slash = value.lastIndexOf('/');
  if (slash > 0) {
    const base = value.slice(0, slash);
    if (modelValues.has(base) && base.includes('/')) {
      return { model: base, effort: value.slice(slash + 1) };
    }
  }
  return { model: value };
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const record = getRecord(content);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  const nested = getRecord(record.content);
  return typeof nested?.text === 'string' ? nested.text : '';
}

/** Text output of a tool_call(_update) content list; diffs are not output. */
function extractToolOutput(update: MimoSessionUpdate): string {
  return getArray(update.content)
    .map((item) => {
      const record = getRecord(item);
      return record?.type === 'content' ? extractTextContent(record.content) : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function mimoToolName(update: MimoSessionUpdate): string {
  const tool = getString(update.title).trim();
  if (tool && MIMO_TOOL_NAMES[tool.toLowerCase()]) {
    return MIMO_TOOL_NAMES[tool.toLowerCase()];
  }
  return tool || ACP_KIND_TOOL_NAMES[getString(update.kind)] || 'MimoTool';
}

/** OpenCode's camelCase arguments → the Claude argument names the cards read. */
export function mimoToolInput(name: string, rawInput: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...rawInput };
  const rename = (from: string, to: string) => {
    if (input[from] !== undefined && input[to] === undefined) {
      input[to] = input[from];
      delete input[from];
    }
  };
  rename('filePath', 'file_path');
  rename('oldString', 'old_string');
  rename('newString', 'new_string');
  rename('replaceAll', 'replace_all');
  if (name === 'Grep') rename('include', 'glob');
  if (name === 'Task') rename('subagentType', 'subagent_type');
  return input;
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
        blocks.push({ type: 'text', text: `Image attachment could not be read: ${attachment.path}` });
      }
      continue;
    }
    blocks.push({
      type: 'text',
      text: attachment.previewText?.trim()
        ? `Attachment: ${attachment.name}\nPath: ${attachment.path}\n\n${attachment.previewText}`
        : `Attachment available on disk: ${attachment.path}`,
    });
  }
  return blocks;
}

function terminateProcess(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }, 500);
  killTimer.unref?.();
  proc.once('exit', () => clearTimeout(killTimer));
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class MimoAcpAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'mimo';
  readonly displayName = 'MiMo Code';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActiveMimoSession>();
  private skillsCache = new Map<string, { skills: ProviderSkillDescriptor[]; fetchedAt: number }>();
  private skillsProbes = new Map<string, Promise<ProviderSkillDescriptor[]>>();
  private pendingPermissions = new Map<
    string,
    { threadId: string; rpc: AcpJsonRpcClient; request: AcpJsonRpcIncomingRequest; options: AcpPermissionOption[] }
  >();

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const binary = await resolveMimoBinary();
    if (!binary) {
      throw new Error('MiMo Code CLI was not found. Install MiMo Code or set MIMO_CLI_PATH.');
    }

    const proc = spawn(binary, ['acp'], {
      cwd: input.cwd,
      env: buildMimoEnv({ MIMOCODE_CONFIG_CONTENT: JSON.stringify(MIMO_AEGIS_CONFIG) }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (/\bERROR\b/.test(line)) console.warn('[MiMo ACP]', line.trim());
      }
    });

    const binding: SessionBinding = {};
    let rpc!: AcpJsonRpcClient;
    rpc = new AcpJsonRpcClient(
      proc,
      (method, params) => this.handleNotification(binding, method, params),
      (request) => this.handleRequest(binding, rpc, request),
      (line, error) => {
        console.warn('[MiMo ACP] failed to parse stdout line', { line, error: error.message });
      }
    );

    const fail = (error: unknown): never => {
      terminateProcess(proc);
      throw error instanceof Error ? error : new Error(String(error));
    };

    await rpc
      .request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.32' },
        // No fs/terminal: MiMo then runs its own file and shell tools.
        clientCapabilities: {},
      })
      .catch(fail);

    // Aegis's session tools for chat sessions (MiMo's ACP accepts http MCP
    // servers); workflow members get none.
    const mcpServers = getWorkflowSessionPolicy(input.threadId)
      ? []
      : [createGrokAcpHttpMcpServer(SESSION_MCP_SERVER_NAME, await getSessionReaderHttpConfig())];

    let sessionRecord: Record<string, unknown> | null = null;
    let providerSessionId = '';
    if (input.resumeSessionId) {
      try {
        sessionRecord = getRecord(
          await rpc.request('session/load', {
            sessionId: input.resumeSessionId,
            cwd: input.cwd,
            mcpServers,
          })
        );
        providerSessionId = input.resumeSessionId;
      } catch (error) {
        // A session MiMo no longer has must not brick the thread.
        console.warn('[MiMo ACP] session/load failed; starting a new session:', error instanceof Error ? error.message : error);
        binding.commands = undefined;
        binding.usage = undefined;
        binding.currentMode = undefined;
      }
    }
    if (!providerSessionId) {
      sessionRecord = getRecord(await rpc.request('session/new', { cwd: input.cwd, mcpServers }).catch(fail));
      providerSessionId = getString(sessionRecord?.sessionId);
      if (!providerSessionId) {
        fail(new Error('MiMo ACP did not return a sessionId.'));
      }
    }

    const active: ActiveMimoSession = {
      threadId: input.threadId,
      providerSessionId,
      status: 'running',
      cwd: input.cwd,
      modelValue: extractConfigValue(sessionRecord?.configOptions, 'model'),
      modelValues: extractModelValues(sessionRecord?.configOptions),
      requestedModel: input.model?.trim() || undefined,
      requestedEffort: normalizeMimoReasoningEffort(input.mimoReasoningEffort),
      currentMode:
        extractConfigValue(sessionRecord?.configOptions, 'mode') ||
        getString(getRecord(sessionRecord?.modes)?.currentModeId) ||
        binding.currentMode ||
        undefined,
      permissionMode: normalizeMimoPermissionMode(input.mimoPermissionMode),
      sessionCostUsd: getNumber(getRecord(binding.usage?.cost)?.amount),
      proc,
      rpc,
      nextBlockIndex: 0,
      toolCalls: new Map(),
      turnHadOutput: false,
    };

    try {
      await this.applyModel(active, input.model, input.mimoReasoningEffort);
      await this.applyPermissionMode(active, active.permissionMode);
    } catch (error) {
      fail(error);
    }

    // Never orphan a predecessor for the same thread — it would leak its process.
    this.disposeSession(input.threadId);
    this.sessions.set(input.threadId, active);
    binding.session = active;

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
      model: this.currentModel(active),
    });
    if (binding.commands) {
      this.emitAvailableCommands(active, binding.commands);
    }
    if (binding.usage) {
      this.emitTokenUsage(active, binding.usage);
    }
    binding.commands = undefined;
    binding.usage = undefined;

    if (input.prompt || input.attachments?.length) {
      await this.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
        attachments: input.attachments,
        model: input.model,
        mimoPermissionMode: active.permissionMode,
        mimoReasoningEffort: active.requestedEffort,
      });
    }

    return {
      threadId: input.threadId,
      provider: 'mimo',
      providerSessionId,
      status: 'running',
      model: this.currentModel(active),
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No MiMo session found for thread "${input.threadId}"`);
    }

    session.status = 'running';
    session.currentAssistant = undefined;
    session.currentThinking = undefined;
    session.turnHadOutput = false;
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });
    const startedAt = Date.now();
    const costAtStart = session.sessionCostUsd;

    try {
      await this.applyModel(session, input.model, input.mimoReasoningEffort);
      await this.applyPermissionMode(session, input.mimoPermissionMode);
      const promptResult = getRecord(
        await session.rpc.request('session/prompt', {
          sessionId: session.providerSessionId,
          prompt: buildPromptBlocks(input.prompt, input.attachments),
        })
      );
      this.finalizeStreaming(session);
      this.settleOpenToolCalls(session);
      // ACP reports only the turn's last model step; MiMo's own records
      // hold every step, so they give the real totals when readable.
      const usage = getRecord(promptResult?.usage);
      const recorded = readMimoTurnUsage(session.providerSessionId, startedAt);
      const inputTokens = recorded ? recorded.inputTokens : getNumber(usage?.inputTokens);
      const outputTokens = recorded
        ? recorded.outputTokens + recorded.reasoningTokens
        : getNumber(usage?.outputTokens) + getNumber(usage?.thoughtTokens);
      const cacheReadTokens = recorded ? recorded.cacheReadTokens : getNumber(usage?.cachedReadTokens);
      const cacheWriteTokens = recorded ? recorded.cacheWriteTokens : getNumber(usage?.cachedWriteTokens);
      const totalTokens = recorded
        ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
        : getNumber(usage?.totalTokens) || inputTokens + outputTokens;

      // A failed model call (bad key, quota, the provider's content filter)
      // still ends with end_turn; the error lives only on the stored step.
      const swallowedError = readMimoLastTurnError(session.providerSessionId, startedAt);
      if (swallowedError) {
        throw new Error(`MiMo Code: ${swallowedError}`);
      }

      session.status = 'completed';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: getString(promptResult?.stopReason) === 'refusal' ? 'error' : 'success',
          duration_ms: Date.now() - startedAt,
          // usage_update carries the session's running cost; the turn is the delta.
          total_cost_usd: recorded ? recorded.costUsd : Math.max(0, session.sessionCostUsd - costAtStart),
          costSource: 'reported',
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: cacheWriteTokens,
            total_tokens: totalTokens,
          },
          model: this.currentModel(session),
        },
      });
      this.emit({ type: 'status_change', threadId: input.threadId, status: 'completed' });
    } catch (error) {
      // A stop/dispose kills the process, which rejects this turn's RPC — that
      // stale rejection must not land in whatever session now owns the thread.
      if (this.sessions.get(input.threadId) !== session) {
        return;
      }
      this.finalizeStreaming(session);
      this.settleOpenToolCalls(session);
      session.status = 'error';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: 'error',
          duration_ms: Date.now() - startedAt,
          total_cost_usd: 0,
          costSource: 'unavailable',
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
    this.dismissPermissions(threadId);
    this.sessions.delete(threadId);
    terminateProcess(session.proc);
  }

  disposeSession(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session) {
      return false;
    }
    try {
      this.dismissPermissions(threadId);
      this.sessions.delete(threadId);
      terminateProcess(session.proc);
    } catch (error) {
      console.warn('[MimoAcpAdapter] disposeSession cleanup failed:', error);
    }
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((threadId) => this.stopSession(threadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      threadId: session.threadId,
      provider: 'mimo',
      providerSessionId: session.providerSessionId,
      status: session.status,
      model: this.currentModel(session),
    }));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async respondToRequest(threadId: string, requestId: string, decision: PermissionResult): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.threadId !== threadId) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    const optionId = this.resolveOptionId(decision, pending.options);
    pending.rpc.respond(pending.request.id, {
      outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    });
  }

  /**
   * Skill library listing from MiMo's own resolver (`GET /skill` on a
   * short-lived server). Cached per cwd; Refresh (forceReload) bypasses it.
   */
  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    const cwd = input.cwd?.trim() || '';
    const cached = this.skillsCache.get(cwd);
    if (!input.forceReload && cached && Date.now() - cached.fetchedAt < SKILLS_CACHE_TTL_MS) {
      return { skills: cached.skills, source: 'mimo-cli', cached: true };
    }
    const pending = this.skillsProbes.get(cwd);
    if (pending && !input.forceReload) {
      return { skills: await pending, source: 'mimo-cli', cached: true };
    }
    const probe = listMimoSkills(cwd || undefined)
      .then((skills) => {
        this.skillsCache.set(cwd, { skills, fetchedAt: Date.now() });
        return skills;
      })
      .finally(() => {
        if (this.skillsProbes.get(cwd) === probe) this.skillsProbes.delete(cwd);
      });
    this.skillsProbes.set(cwd, probe);
    return { skills: await probe, source: 'mimo-cli', cached: false };
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: 'mimo',
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      // MiMo pushes available_commands_update (builtins + skills) after session/new.
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: false,
    };
  }

  // ── Session config ───────────────────────────────────────────────────────

  /** Base model id (variant stripped), as the composer names it. */
  private currentModel(session: ActiveMimoSession): string | undefined {
    return splitMimoModelValue(session.modelValue, session.modelValues).model;
  }

  /**
   * Model and reasoning level are one select value (`model/variant`), so both
   * are reconciled together. Without a requested model the session's own
   * model keeps the requested level when it offers it.
   */
  private async applyModel(
    session: ActiveMimoSession,
    model: string | undefined,
    effort: string | undefined
  ): Promise<void> {
    session.requestedModel = model?.trim() || session.requestedModel;
    session.requestedEffort = normalizeMimoReasoningEffort(effort) ?? session.requestedEffort;
    const base = session.requestedModel || this.currentModel(session);
    if (!base) return;
    const withEffort = session.requestedEffort ? `${base}/${session.requestedEffort}` : '';
    const target =
      withEffort && (session.modelValues.size === 0 || session.modelValues.has(withEffort)) ? withEffort : base;
    if (target === session.modelValue || target === session.rejectedModelValue) {
      return;
    }
    if (session.modelValues.size > 0 && !session.modelValues.has(target)) {
      session.rejectedModelValue = target;
      console.warn(`[MiMo ACP] model "${target}" is not offered by this session; keeping ${session.modelValue}.`);
      return;
    }
    try {
      const result = getRecord(
        await session.rpc.request('session/set_config_option', {
          sessionId: session.providerSessionId,
          configId: 'model',
          value: target,
        })
      );
      session.modelValue = extractConfigValue(result?.configOptions, 'model') || target;
      const values = extractModelValues(result?.configOptions);
      if (values.size > 0) session.modelValues = values;
      session.rejectedModelValue = undefined;
    } catch (error) {
      session.rejectedModelValue = target;
      console.warn('[MiMo ACP] could not switch model:', error instanceof Error ? error.message : error);
    }
  }

  /** Reconciled before every turn: a `/plan`-style switch inside MiMo moves the mode too. */
  private async applyPermissionMode(
    session: ActiveMimoSession,
    mode: MimoPermissionMode | undefined
  ): Promise<void> {
    const permissionMode = normalizeMimoPermissionMode(mode) ?? session.permissionMode;
    if (!permissionMode) {
      return;
    }
    session.permissionMode = permissionMode;
    if (session.currentMode === permissionMode) {
      return;
    }
    await session.rpc.request('session/set_mode', {
      sessionId: session.providerSessionId,
      modeId: permissionMode,
    });
    session.currentMode = permissionMode;
  }

  // ── ACP routing ──────────────────────────────────────────────────────────

  private handleNotification(binding: SessionBinding, method: string, params?: Record<string, unknown>): void {
    if (method !== 'session/update') {
      return;
    }
    const update = getRecord(params?.update) as MimoSessionUpdate | null;
    if (!update) return;

    const session = binding.session;
    if (!session || this.sessions.get(session.threadId) !== session) {
      if (session) return;
      // Pre-bind: startup state or session/load replay.
      switch (update.sessionUpdate) {
        case 'available_commands_update':
          binding.commands = update;
          break;
        case 'usage_update':
          binding.usage = update;
          break;
        case 'current_mode_update':
          binding.currentMode = getString(update.currentModeId) || binding.currentMode;
          break;
        default:
          break;
      }
      return;
    }
    this.handleSessionUpdate(session, update);
  }

  private handleRequest(binding: SessionBinding, rpc: AcpJsonRpcClient, request: AcpJsonRpcIncomingRequest): void {
    const session = binding.session;
    if (request.method === 'session/request_permission') {
      if (session && this.sessions.get(session.threadId) === session) {
        this.handlePermissionRequest(session, rpc, request);
      } else {
        rpc.respond(request.id, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    if (request.method === 'fs/write_text_file') {
      // Editor-buffer sync after an approved edit; MiMo's edit tool writes the
      // file itself, so acknowledging is enough.
      rpc.respond(request.id, {});
      return;
    }
    rpc.respond(request.id, undefined, {
      code: -32601,
      message: `Unsupported MiMo ACP reverse request: ${request.method}`,
    });
  }

  private handlePermissionRequest(
    session: ActiveMimoSession,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    const params = getRecord(request.params);
    const toolCall = getRecord(params?.toolCall) || {};
    const toolCallId = getString(toolCall.toolCallId);
    const known = toolCallId ? session.toolCalls.get(toolCallId) : undefined;
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
    // The request's title is the permission key (edit, bash, external_directory)
    // and rawInput its metadata; the tool call that preceded it names the tool.
    const permission = getString(toolCall.title);
    const metadata = getRecord(toolCall.rawInput) || {};
    const knownInput = known && Object.keys(known.input).length > 0 ? known.input : null;
    const command = getString(knownInput?.command) || getString(metadata.command);
    const filePath = getString(knownInput?.file_path) || getString(metadata.filepath) || getString(metadata.filePath);
    const toolName = known?.name || mimoToolName({ title: permission, kind: toolCall.kind });
    // A request that beats the call's arguments carries only the permission
    // key (`bash`); the tool's display name reads better than the raw key.
    const title = command
      ? `Run ${command}`
      : filePath
        ? `${toolName} ${filePath}`
        : known?.name || MIMO_TOOL_NAMES[permission.toLowerCase()] || permission || 'MiMo permission request';
    const requestId = `mimo-permission:${session.threadId}:${request.id}`;
    this.pendingPermissions.set(requestId, { threadId: session.threadId, rpc, request, options });
    const input: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'mimo',
      question: command || title,
      title,
      toolName,
      options,
      toolCall: {
        ...toolCall,
        title,
        rawInput: knownInput || metadata,
      },
    };
    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId,
      toolName,
      input,
    });
  }

  private dismissPermissions(threadId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.threadId !== threadId) continue;
      this.pendingPermissions.delete(requestId);
      this.emit({ type: 'permission_dismissed', threadId, requestId });
      try {
        pending.rpc.respond(pending.request.id, { outcome: { outcome: 'cancelled' } });
      } catch {
        // The process may already be gone.
      }
    }
  }

  private resolveOptionId(decision: PermissionResult, options: AcpPermissionOption[]): string | null {
    const explicit = decision.updatedInput?.optionId;
    if (typeof explicit === 'string' && options.some((option) => option.optionId === explicit)) {
      return explicit;
    }
    const signature = (option: AcpPermissionOption) => `${option.kind || ''} ${option.optionId}`.toLowerCase();
    if (decision.behavior === 'allow') {
      return (
        options.find((option) => option.kind === 'allow_once')?.optionId ||
        options.find((option) => !signature(option).includes('reject'))?.optionId ||
        null
      );
    }
    return options.find((option) => signature(option).includes('reject'))?.optionId || null;
  }

  // ── Session updates ──────────────────────────────────────────────────────

  private handleSessionUpdate(session: ActiveMimoSession, update: MimoSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.emitAssistantDelta(session, extractTextContent(update.content));
        break;
      case 'agent_thought_chunk':
        this.emitThinkingDelta(session, extractTextContent(update.content));
        break;
      case 'tool_call':
        session.turnHadOutput = true;
        this.handleToolCall(session, update);
        break;
      case 'tool_call_update':
        this.handleToolCallUpdate(session, update);
        break;
      case 'available_commands_update':
        this.emitAvailableCommands(session, update);
        break;
      case 'config_option_update': {
        session.modelValue = extractConfigValue(update.configOptions, 'model') || session.modelValue;
        const values = extractModelValues(update.configOptions);
        if (values.size > 0) session.modelValues = values;
        session.currentMode = extractConfigValue(update.configOptions, 'mode') || session.currentMode;
        break;
      }
      case 'current_mode_update':
        session.currentMode = getString(update.currentModeId) || session.currentMode;
        break;
      case 'usage_update':
        this.emitTokenUsage(session, update);
        break;
      default:
        // user_message_chunk (replay only), session_info_update.
        break;
    }
  }

  private emitAssistantDelta(session: ActiveMimoSession, text: string): void {
    if (!text) return;
    session.turnHadOutput = true;
    if (!session.currentAssistant) {
      session.currentAssistant = {
        uuid: `mimo-assistant:${session.threadId}:${uuidv4()}`,
        text: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    session.currentAssistant.text += text;
    this.emitStreamDelta(session, session.currentAssistant.blockIndex, { type: 'text_delta', text });
  }

  private emitThinkingDelta(session: ActiveMimoSession, thinking: string): void {
    if (!thinking) return;
    session.turnHadOutput = true;
    if (!session.currentThinking) {
      session.currentThinking = {
        uuid: `mimo-thinking:${session.threadId}:${uuidv4()}`,
        thinking: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    session.currentThinking.thinking += thinking;
    this.emitStreamDelta(session, session.currentThinking.blockIndex, { type: 'thinking_delta', thinking });
  }

  private emitStreamDelta(
    session: ActiveMimoSession,
    index: number,
    delta: { type: string; text?: string; thinking?: string }
  ): void {
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'stream_event',
        parentToolUseId: null,
        event: { type: 'content_block_delta', index, delta },
      },
    });
  }

  private finalizeStreaming(session: ActiveMimoSession): void {
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

  private emitToolUseMessage(session: ActiveMimoSession, id: string, call: MimoToolCall): void {
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `mimo-tool-use:${session.threadId}:${id}`,
        createdAt: call.createdAt,
        message: { content: [{ type: 'tool_use', id, name: call.name, input: call.input }] },
      },
    });
  }

  private handleToolCall(session: ActiveMimoSession, update: MimoSessionUpdate): void {
    const id = getString(update.toolCallId) || uuidv4();
    const existing = session.toolCalls.get(id);
    if (!existing) {
      this.finalizeStreaming(session);
    }
    const name = existing?.name || mimoToolName(update);
    const rawInput = getRecord(update.rawInput);
    const call: MimoToolCall = {
      name,
      title: getString(update.title) || existing?.title || '',
      input: rawInput && Object.keys(rawInput).length > 0 ? mimoToolInput(name, rawInput) : existing?.input || {},
      createdAt: existing?.createdAt || Date.now(),
      output: existing?.output || '',
      settled: existing?.settled || false,
    };
    session.toolCalls.set(id, call);
    this.emitToolUseMessage(session, id, call);
  }

  private handleToolCallUpdate(session: ActiveMimoSession, update: MimoSessionUpdate): void {
    const id = getString(update.toolCallId);
    const call = id ? session.toolCalls.get(id) : undefined;
    if (!id || !call) return;

    // Pending calls carry `{}`; the arguments arrive with in_progress.
    const rawInput = getRecord(update.rawInput);
    if (rawInput && Object.keys(rawInput).length > 0) {
      const input = mimoToolInput(call.name, rawInput);
      if (JSON.stringify(input) !== JSON.stringify(call.input)) {
        call.input = input;
        this.emitToolUseMessage(session, id, call);
      }
    }

    const status = getString(update.status);
    const output = extractToolOutput(update);
    if (output && output !== call.output) {
      // Bash output arrives as growing snapshots; forward the new suffix to
      // the live tool card. A settling update's output rides the result.
      if (status === 'in_progress' && output.startsWith(call.output)) {
        const delta = output.slice(call.output.length);
        if (delta) this.emit({ type: 'tool_output_delta', threadId: session.threadId, toolUseId: id, delta });
      }
      call.output = output;
    }
    // The completed update's title is a summary (often the path); keep it as
    // the fallback result text.
    if (status === 'completed') {
      call.title = getString(update.title) || call.title;
    }

    if (status === 'completed' || status === 'failed') {
      this.emitToolResult(session, id, call, status === 'failed');
    }
  }

  private emitToolResult(session: ActiveMimoSession, id: string, call: MimoToolCall, isError: boolean): void {
    if (call.settled) return;
    call.settled = true;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `mimo-tool-result:${session.threadId}:${id}`,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content: call.output || call.title || (isError ? 'Failed' : 'Done'),
              is_error: isError,
            },
          ],
        },
      },
    });
  }

  /** A turn that ends (or dies) with calls still open must not leave spinning cards. */
  private settleOpenToolCalls(session: ActiveMimoSession): void {
    for (const [id, call] of session.toolCalls) {
      if (!call.settled) this.emitToolResult(session, id, call, false);
    }
  }

  /**
   * Context ring: `used` is the last request's input + cache reads, `size`
   * the model window. `cost` is the session's running total, kept for the
   * per-turn cost delta.
   */
  private emitTokenUsage(session: ActiveMimoSession, update: MimoSessionUpdate): void {
    const cost = getRecord(update.cost);
    if (cost && typeof cost.amount === 'number' && Number.isFinite(cost.amount)) {
      session.sessionCostUsd = cost.amount;
    }
    const contextWindow = getNumber(update.size);
    if (contextWindow <= 0) return;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'token_usage',
        uuid: `mimo-token-usage:${session.threadId}:${Date.now()}`,
        session_id: session.threadId,
        provider: 'mimo',
        usage: {
          inputTokens: getNumber(update.used),
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: getNumber(update.used),
          contextWindow,
        },
      },
    });
  }

  private emitAvailableCommands(session: ActiveMimoSession, update: MimoSessionUpdate): void {
    const availableCommands = getArray(update.availableCommands)
      .map((command) => {
        const record = getRecord(command);
        const name = getString(record?.name).replace(/^\//, '').trim();
        if (!name) return null;
        const hint = getString(getRecord(record?.input)?.hint);
        return {
          name,
          description: getString(record?.description) || 'MiMo slash command',
          ...(hint ? { input: { hint } } : {}),
        };
      })
      .filter((command): command is { name: string; description: string; input?: { hint: string } } =>
        Boolean(command)
      );
    const signature = JSON.stringify(
      [...availableCommands].sort((left, right) => left.name.localeCompare(right.name))
    );
    if (session.lastCommandsSignature === signature) {
      return;
    }
    session.lastCommandsSignature = signature;
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

  private emit(event: ProviderRuntimeEvent): void {
    this.events.emit('event', event);
  }
}
