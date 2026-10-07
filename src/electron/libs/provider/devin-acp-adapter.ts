import { getWorkflowSessionPolicy } from '../workflow/session-hooks';
import { getSessionReaderHttpConfig, SESSION_MCP_SERVER_NAME } from '../session-http-server';
import { createGrokAcpHttpMcpServer } from './grok-acp-mcp';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { buildDevinEnv, listDevinSkills, resolveDevinBinary } from '../devin-cli';
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
  AskUserQuestionInput,
  Attachment,
  DevinPermissionMode,
  PermissionResult,
  PlanStepStatus,
  ProviderComposerCapabilities,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillDescriptor,
  StreamMessage,
} from '../../../shared/types';

/**
 * Devin CLI over ACP (`devin acp`, JSON-RPC on stdio). Verified against
 * devin 3000.6.14:
 * - The client advertises NO fs/terminal capabilities, so Devin reads, edits
 *   and runs commands itself (it still reports every call as tool_call
 *   updates, edits with ACP diff content).
 * - Models and modes are live session config: session/set_config_option and
 *   session/set_mode apply without a respawn.
 * - session/load replays the whole conversation as session/update
 *   notifications before it returns; Aegis already holds that history, so the
 *   replay is dropped (see SessionBinding).
 * - Reverse requests use string (UUID) JSON-RPC ids.
 * - Devin's session_info_update titles are derived from raw tool output and
 *   are not usable as thread titles; Aegis keeps its own.
 */

type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

type DevinSessionUpdate = Record<string, unknown> & { sessionUpdate?: unknown };

interface DevinToolCall {
  name: string;
  title: string;
  input: Record<string, unknown>;
  createdAt: number;
  /** Latest output snapshot; Devin streams exec output cumulatively. */
  output: string;
  settled: boolean;
}

interface ActiveDevinSession {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  /** Model ids this session's config select accepts (empty until known). */
  modelIds: Set<string>;
  /** Last requested model the session rejected; not retried every turn. */
  rejectedModel?: string;
  /** Current `thought_level` and the levels the current model offers. */
  thoughtLevel?: string;
  thoughtLevelIds: Set<string>;
  /** Thinking level the composer asked for; reconciled before every turn. */
  requestedThoughtLevel?: string;
  /** Mode the agent last reported (current_mode_update). */
  currentMode?: string;
  /** Mode the composer asked for; reconciled before every turn. */
  permissionMode?: DevinPermissionMode;
  proc: ChildProcessWithoutNullStreams;
  rpc: AcpJsonRpcClient;
  currentAssistant?: { uuid: string; text: string; createdAt: number; blockIndex: number };
  currentThinking?: { uuid: string; thinking: string; createdAt: number; blockIndex: number };
  nextBlockIndex: number;
  lastCommandsSignature?: string;
  toolCalls: Map<string, DevinToolCall>;
}

/**
 * Per-process routing. Notifications from a spawning process must never land
 * on a predecessor session for the same thread, and everything Devin emits
 * before the session is bound is either startup state or session/load replay.
 * Startup state that the UI needs (commands, mode, context usage) is kept and
 * applied once bound; the replayed transcript is dropped.
 */
interface SessionBinding {
  session?: ActiveDevinSession;
  commands?: DevinSessionUpdate;
  usage?: DevinSessionUpdate;
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

const DEVIN_PERMISSION_MODES: ReadonlyArray<DevinPermissionMode> = ['accept-edits', 'smart', 'ask', 'plan', 'bypass'];

/**
 * Devin's own tool ids (`_meta["cognition.ai/inferenceToolName"]`; the CLI's
 * hook matchers name read|notebook_read|find_file_by_name|grep,
 * edit|write|notebook_edit and exec) mapped to the Claude-shaped names the
 * transcript renders richly. Devin's rawInput already uses Claude's argument
 * names (command, file_path, old_string, new_string, content); the one
 * exception is adapted in devinToolInput.
 */
const DEVIN_TOOL_NAMES: Record<string, string> = {
  exec: 'Bash',
  read: 'Read',
  notebook_read: 'Read',
  write: 'Write',
  edit: 'Edit',
  notebook_edit: 'NotebookEdit',
  grep: 'Grep',
  find_file_by_name: 'Glob',
  web_search: 'WebSearch',
  todo_write: 'TodoWrite',
  ask_user_question: 'AskUserQuestion',
};

/** Fallback by ACP tool kind when Devin names no tool. */
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

/** Open set: valid levels differ per model and come from Devin itself. */
export function normalizeDevinThoughtLevel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value.trim()) ? value.trim() : undefined;
}

function extractThoughtLevels(configOptions: unknown): { found: boolean; current?: string; ids: Set<string> } {
  for (const option of getArray(configOptions)) {
    const record = getRecord(option);
    if (!record || (getString(record.id) !== 'thought_level' && getString(record.category) !== 'thought_level')) continue;
    const ids = new Set(getArray(record.options).map((entry) => getString(getRecord(entry)?.value)).filter(Boolean));
    return { found: true, current: getString(record.currentValue) || undefined, ids };
  }
  // In a full option list, no select means the model has no thinking control.
  return { found: false, ids: new Set() };
}

export function normalizeDevinPermissionMode(value: unknown): DevinPermissionMode | undefined {
  return typeof value === 'string' && DEVIN_PERMISSION_MODES.includes(value as DevinPermissionMode)
    ? (value as DevinPermissionMode)
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

function extractModelIds(configOptions: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (entries: unknown): void => {
    for (const entry of getArray(entries)) {
      const record = getRecord(entry);
      if (!record) continue;
      if (Array.isArray(record.options)) visit(record.options);
      else if (getString(record.value)) ids.add(getString(record.value));
    }
  };
  for (const option of getArray(configOptions)) {
    const record = getRecord(option);
    if (record && (getString(record.id) === 'model' || getString(record.category) === 'model')) {
      visit(record.options);
    }
  }
  return ids;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const record = getRecord(content);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  const nested = getRecord(record.content);
  return typeof nested?.text === 'string' ? nested.text : '';
}

/** Text output of a tool_call(_update) content list; diffs and previews are not output. */
function extractToolOutput(update: DevinSessionUpdate): string {
  return getArray(update.content)
    .map((item) => {
      const record = getRecord(item);
      return record?.type === 'content' ? extractTextContent(record.content) : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function devinToolName(update: DevinSessionUpdate): string {
  const meta = getRecord(update._meta);
  const inferenceName = getString(meta?.['cognition.ai/inferenceToolName']).trim();
  if (inferenceName) {
    return DEVIN_TOOL_NAMES[inferenceName] || inferenceName;
  }
  return ACP_KIND_TOOL_NAMES[getString(update.kind)] || getString(update.title) || 'DevinTool';
}

// ── Elicitation (ask_user_question) ────────────────────────────────────────

interface DevinElicitationQuestion {
  /** Property key in requestedSchema (q0, q1, …) — the reply's content key. */
  key: string;
  /** Unique within the request: the card returns answers keyed by it. */
  question: string;
  header?: string;
  /** label = the value sent back (schema const); description = its title. */
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  valueType: 'string' | 'boolean' | 'number';
}

export interface DevinElicitation {
  questions: DevinElicitationQuestion[];
  /** `_meta["cognition.ai/allowOther"]`: answers outside the options are accepted. */
  allowOther: boolean;
}

function schemaChoices(schema: Record<string, unknown> | null): Array<{ label: string; description?: string }> {
  const listed = getArray(schema?.oneOf).length ? getArray(schema?.oneOf) : getArray(schema?.anyOf);
  const choices = listed
    .map((entry) => {
      const record = getRecord(entry);
      const label = record && record.const !== undefined ? String(record.const) : '';
      const description = getString(record?.title).trim();
      return label ? { label, ...(description && description !== label ? { description } : {}) } : null;
    })
    .filter((choice): choice is { label: string; description?: string } => Boolean(choice));
  if (choices.length > 0) return choices;
  return getArray(schema?.enum).map((value) => ({ label: String(value) }));
}

/**
 * ACP form elicitation → card questions. Devin sends one property per
 * question: single choice as a string with oneOf, multi-select as an array
 * whose items list anyOf, free text as a bare string.
 */
export function parseDevinElicitation(params: unknown): DevinElicitation | null {
  const record = getRecord(params);
  if (!record || (record.mode !== undefined && record.mode !== 'form')) return null;
  const properties = getRecord(getRecord(record.requestedSchema)?.properties);
  if (!properties) return null;
  const message = getString(record.message).trim();
  const used = new Set<string>();
  const questions: DevinElicitationQuestion[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const schema = getRecord(value);
    if (!schema) continue;
    const type = getString(schema.type);
    const title = getString(schema.title).trim();
    let question = getString(schema.description).trim() || title || message || key;
    if (used.has(question)) question = `${question} (${title || key})`;
    used.add(question);
    const multiSelect = type === 'array';
    const options =
      type === 'boolean'
        ? [{ label: 'Yes' }, { label: 'No' }]
        : schemaChoices(multiSelect ? getRecord(schema.items) : schema);
    questions.push({
      key,
      question,
      ...(title && title !== question ? { header: title } : {}),
      options,
      multiSelect,
      valueType: type === 'boolean' ? 'boolean' : type === 'number' || type === 'integer' ? 'number' : 'string',
    });
  }
  if (questions.length === 0) return null;
  return { questions, allowOther: getRecord(record._meta)?.['cognition.ai/allowOther'] === true };
}

/**
 * Card answers (keyed by question text; multi-select and "Other" text
 * comma-joined) → the reply's typed content. Option labels are matched out
 * of the joined string; what remains is the user's own text, kept whole so a
 * custom answer may itself contain commas.
 */
export function buildDevinElicitationContent(
  elicitation: DevinElicitation,
  answers: Record<string, string>
): Record<string, string | string[] | boolean | number> {
  const content: Record<string, string | string[] | boolean | number> = {};
  for (const question of elicitation.questions) {
    const raw = (answers[question.question] || '').trim();
    if (!raw) continue;
    if (question.valueType === 'boolean') {
      content[question.key] = /^(yes|true)$/i.test(raw);
      continue;
    }
    if (question.options.length === 0) {
      const asNumber = Number(raw);
      content[question.key] = question.valueType === 'number' && Number.isFinite(asNumber) ? asNumber : raw;
      continue;
    }
    const labels = new Set(question.options.map((option) => option.label));
    const parts = raw.split(',').map((part) => part.trim());
    const selected = parts.filter((part) => labels.has(part));
    const custom = parts.filter((part) => part && !labels.has(part)).join(', ');
    if (question.multiSelect) {
      content[question.key] = [...selected, ...(custom && elicitation.allowOther ? [custom] : [])];
    } else {
      content[question.key] = custom && (elicitation.allowOther || selected.length === 0) ? custom : selected[0] ?? raw;
    }
  }
  return content;
}

/** find_file_by_name takes its glob as `query`; the Glob card reads `pattern`. */
export function devinToolInput(name: string, rawInput: Record<string, unknown>): Record<string, unknown> {
  if (name === 'Glob' && typeof rawInput.query === 'string' && rawInput.pattern === undefined) {
    return { ...rawInput, pattern: rawInput.query };
  }
  // ask_user_question spells Claude's multiSelect as multi_select.
  if (name === 'AskUserQuestion' && Array.isArray(rawInput.questions)) {
    return {
      ...rawInput,
      questions: rawInput.questions.map((question) => {
        const record = getRecord(question);
        if (!record || record.multi_select === undefined) return question;
        const { multi_select: multiSelect, ...rest } = record;
        return { ...rest, multiSelect: multiSelect === true };
      }),
    };
  }
  return rawInput;
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

export class DevinAcpAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'devin';
  readonly displayName = 'Devin';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private sessions = new Map<string, ActiveDevinSession>();
  private skillsCache = new Map<string, { skills: ProviderSkillDescriptor[]; fetchedAt: number }>();
  private skillsProbes = new Map<string, Promise<ProviderSkillDescriptor[]>>();
  /** Tool approvals and Devin's questions (elicitation/create) awaiting the UI. */
  private pendingPermissions = new Map<
    string,
    {
      threadId: string;
      rpc: AcpJsonRpcClient;
      request: AcpJsonRpcIncomingRequest;
    } & (
      | { kind: 'permission'; options: AcpPermissionOption[] }
      | { kind: 'elicitation'; elicitation: DevinElicitation }
    )
  >();

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const binary = await resolveDevinBinary();
    if (!binary) {
      throw new Error('Devin CLI was not found. Install the Devin CLI or set DEVIN_CLI_PATH.');
    }

    const proc = spawn(binary, ['acp'], {
      cwd: input.cwd,
      env: buildDevinEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Devin logs every tracing span at INFO on stderr; only errors are worth surfacing.
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.includes(' ERROR ')) console.warn('[Devin ACP]', line.trim());
      }
    });

    const binding: SessionBinding = {};
    let rpc!: AcpJsonRpcClient;
    rpc = new AcpJsonRpcClient(
      proc,
      (method, params) => this.handleNotification(binding, method, params),
      (request) => this.handleRequest(binding, rpc, request),
      (line, error) => {
        console.warn('[Devin ACP] failed to parse stdout line', { line, error: error.message });
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
        // No fs/terminal: Devin then runs its own file and shell tools.
        // Form elicitation lets its ask_user_question tool reach the user.
        clientCapabilities: { elicitation: { form: {} } },
      })
      .catch(fail);

    // Aegis's session tools (read_session, start_workflow) for chat sessions,
    // passed for this session only (Devin's ACP accepts http MCP servers);
    // workflow members get none.
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
        // A session Devin no longer has (deleted, other machine) must not
        // brick the thread: continue in a fresh Devin session.
        console.warn('[Devin ACP] session/load failed; starting a new session:', error instanceof Error ? error.message : error);
        binding.commands = undefined;
        binding.usage = undefined;
        binding.currentMode = undefined;
      }
    }
    if (!providerSessionId) {
      sessionRecord = getRecord(await rpc.request('session/new', { cwd: input.cwd, mcpServers }).catch(fail));
      providerSessionId = getString(sessionRecord?.sessionId);
      if (!providerSessionId) {
        fail(new Error('Devin ACP did not return a sessionId.'));
      }
    }

    const active: ActiveDevinSession = {
      threadId: input.threadId,
      providerSessionId,
      status: 'running',
      cwd: input.cwd,
      model: extractConfigValue(sessionRecord?.configOptions, 'model'),
      modelIds: extractModelIds(sessionRecord?.configOptions),
      thoughtLevel: extractThoughtLevels(sessionRecord?.configOptions).current,
      thoughtLevelIds: extractThoughtLevels(sessionRecord?.configOptions).ids,
      requestedThoughtLevel: normalizeDevinThoughtLevel(input.devinThoughtLevel),
      currentMode:
        getString(getRecord(sessionRecord?.modes)?.currentModeId) || binding.currentMode || undefined,
      permissionMode: normalizeDevinPermissionMode(input.devinPermissionMode),
      proc,
      rpc,
      nextBlockIndex: 0,
      toolCalls: new Map(),
    };

    try {
      await this.applyModel(active, input.model);
      await this.applyThoughtLevel(active, active.requestedThoughtLevel);
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
      model: active.model,
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
        devinPermissionMode: active.permissionMode,
        devinThoughtLevel: active.requestedThoughtLevel,
      });
    }

    return {
      threadId: input.threadId,
      provider: 'devin',
      providerSessionId,
      status: 'running',
      model: active.model,
    };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`No Devin session found for thread "${input.threadId}"`);
    }

    session.status = 'running';
    session.currentAssistant = undefined;
    session.currentThinking = undefined;
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });
    const startedAt = Date.now();

    try {
      await this.applyModel(session, input.model);
      await this.applyThoughtLevel(session, input.devinThoughtLevel);
      await this.applyPermissionMode(session, input.devinPermissionMode);
      const promptResult = getRecord(
        await session.rpc.request('session/prompt', {
          sessionId: session.providerSessionId,
          prompt: buildPromptBlocks(input.prompt, input.attachments),
        })
      );
      this.finalizeStreaming(session);
      this.settleOpenToolCalls(session);
      const usage = getRecord(promptResult?.usage);
      const inputTokens = getNumber(usage?.inputTokens);
      const outputTokens = getNumber(usage?.outputTokens);
      const cacheReadTokens = getNumber(usage?.cachedReadTokens);
      session.status = 'completed';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: getString(promptResult?.stopReason) === 'refusal' ? 'error' : 'success',
          duration_ms: Date.now() - startedAt,
          // Devin bills in account credits, not a USD amount per turn.
          total_cost_usd: 0,
          costSource: 'unavailable',
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            total_tokens: getNumber(usage?.totalTokens) || inputTokens + outputTokens,
          },
          model: session.model,
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
      // Map entry first: the exit handler is identity-guarded, so the async
      // exit then emits nothing.
      this.sessions.delete(threadId);
      terminateProcess(session.proc);
    } catch (error) {
      console.warn('[DevinAcpAdapter] disposeSession cleanup failed:', error);
    }
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((threadId) => this.stopSession(threadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      threadId: session.threadId,
      provider: 'devin',
      providerSessionId: session.providerSessionId,
      status: session.status,
      model: session.model,
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
    if (pending.kind === 'elicitation') {
      const answers = getRecord(decision.updatedInput?.answers);
      pending.rpc.respond(
        pending.request.id,
        decision.behavior === 'allow' && answers
          ? {
              action: 'accept',
              content: buildDevinElicitationContent(
                pending.elicitation,
                Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, getString(value)]))
              ),
            }
          : { action: 'decline' }
      );
      return;
    }
    const optionId = this.resolveOptionId(decision, pending.options);
    pending.rpc.respond(pending.request.id, {
      outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    });
  }

  /**
   * Skill library listing from Devin's own resolver (`devin skills list`),
   * which knows its user, project, imported and builtin roots. The ACP
   * command feed carries no SKILL.md paths, so it cannot back the library.
   * Cached per cwd; Refresh (forceReload) bypasses the cache.
   */
  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    const cwd = input.cwd?.trim() || '';
    const cached = this.skillsCache.get(cwd);
    if (!input.forceReload && cached && Date.now() - cached.fetchedAt < SKILLS_CACHE_TTL_MS) {
      return { skills: cached.skills, source: 'devin-cli', cached: true };
    }
    const pending = this.skillsProbes.get(cwd);
    if (pending && !input.forceReload) {
      return { skills: await pending, source: 'devin-cli', cached: true };
    }
    const probe = listDevinSkills(cwd || undefined)
      .then((skills) => {
        this.skillsCache.set(cwd, { skills, fetchedAt: Date.now() });
        return skills;
      })
      .finally(() => {
        if (this.skillsProbes.get(cwd) === probe) this.skillsProbes.delete(cwd);
      });
    this.skillsProbes.set(cwd, probe);
    return { skills: await probe, source: 'devin-cli', cached: false };
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: 'devin',
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      // Devin pushes available_commands_update (builtins + skills) after session/new.
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: false,
    };
  }

  // ── Session config ───────────────────────────────────────────────────────

  private async applyModel(session: ActiveDevinSession, model: string | undefined): Promise<void> {
    const requested = model?.trim();
    if (!requested || requested === session.model || requested === session.rejectedModel) {
      return;
    }
    if (session.modelIds.size > 0 && !session.modelIds.has(requested)) {
      session.rejectedModel = requested;
      console.warn(`[Devin ACP] model "${requested}" is not offered by this session; keeping ${session.model}.`);
      return;
    }
    try {
      const result = getRecord(
        await session.rpc.request('session/set_config_option', {
          sessionId: session.providerSessionId,
          configId: 'model',
          value: requested,
        })
      );
      session.model = extractConfigValue(result?.configOptions, 'model') || requested;
      const ids = extractModelIds(result?.configOptions);
      if (ids.size > 0) session.modelIds = ids;
      session.rejectedModel = undefined;
      // A model switch resets thought_level to that model's own default.
      const thought = extractThoughtLevels(result?.configOptions);
      session.thoughtLevel = thought.current;
      session.thoughtLevelIds = thought.ids;
    } catch (error) {
      // An id the account no longer offers: keep the session's current model.
      session.rejectedModel = requested;
      console.warn('[Devin ACP] could not switch model:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Runs after applyModel: a model switch resets the level, so the composer's
   * choice is re-applied whenever the model's levels include it. A level the
   * current model does not offer is left to Devin's per-model default.
   */
  private async applyThoughtLevel(session: ActiveDevinSession, level: string | undefined): Promise<void> {
    const requested = normalizeDevinThoughtLevel(level) ?? session.requestedThoughtLevel;
    session.requestedThoughtLevel = requested;
    if (!requested || requested === session.thoughtLevel || !session.thoughtLevelIds.has(requested)) {
      return;
    }
    const result = getRecord(
      await session.rpc.request('session/set_config_option', {
        sessionId: session.providerSessionId,
        configId: 'thought_level',
        value: requested,
      })
    );
    session.thoughtLevel = extractThoughtLevels(result?.configOptions).current || requested;
  }

  /**
   * Reconciled before every turn, even when the picker value is unchanged:
   * Devin can switch its own mode (an approval's "switch to bypass", /plan).
   */
  private async applyPermissionMode(
    session: ActiveDevinSession,
    mode: DevinPermissionMode | undefined
  ): Promise<void> {
    const permissionMode = normalizeDevinPermissionMode(mode) ?? session.permissionMode;
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
    // `_cognition.ai/*` extension notifications (MCP log lines, thinking
    // timers, agent_stopped stats) carry nothing the transcript needs.
    if (method !== 'session/update') {
      return;
    }
    const update = getRecord(params?.update) as DevinSessionUpdate | null;
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
    if (request.method === 'session/request_permission' && session && this.sessions.get(session.threadId) === session) {
      this.handlePermissionRequest(session, rpc, request);
      return;
    }
    if (request.method === 'session/request_permission') {
      rpc.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    if (request.method === 'elicitation/create') {
      if (session && this.sessions.get(session.threadId) === session) {
        this.handleElicitation(session, rpc, request);
      } else {
        rpc.respond(request.id, { action: 'cancel' });
      }
      return;
    }
    // fs/* and terminal/* are not advertised, so Devin should never ask.
    rpc.respond(request.id, undefined, {
      code: -32601,
      message: `Unsupported Devin ACP reverse request: ${request.method}`,
    });
  }

  private handlePermissionRequest(
    session: ActiveDevinSession,
    rpc: AcpJsonRpcClient,
    request: AcpJsonRpcIncomingRequest
  ): void {
    const params = getRecord(request.params);
    const toolCall = getRecord(params?.toolCall) || {};
    const toolCallId = getString(toolCall.toolCallId);
    const known = toolCallId ? session.toolCalls.get(toolCallId) : undefined;
    const editableCommand = getString(getRecord(toolCall._meta)?.['cognition.ai/editableCommand']);
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
    // Devin's request names only the tool call id; the title and arguments
    // come from the tool_call that preceded it.
    const title = getString(toolCall.title) || known?.title || (editableCommand ? `Run ${editableCommand}` : 'Devin permission request');
    const requestId = `devin-permission:${session.threadId}:${request.id}`;
    this.pendingPermissions.set(requestId, { kind: 'permission', threadId: session.threadId, rpc, request, options });
    const input: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'devin',
      question: editableCommand || title,
      title,
      toolName: known?.name || title,
      options,
      toolCall: {
        ...toolCall,
        title,
        ...(known ? { rawInput: known.input } : {}),
      },
    };
    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId,
      toolName: known?.name || title,
      input,
    });
  }

  /**
   * Devin's ask_user_question tool arrives as a form elicitation; it maps
   * onto the AskUserQuestion card (choices, multi-select, "Other" text).
   */
  private handleElicitation(session: ActiveDevinSession, rpc: AcpJsonRpcClient, request: AcpJsonRpcIncomingRequest): void {
    const elicitation = parseDevinElicitation(request.params);
    if (!elicitation) {
      // Only form mode is advertised; anything else has no UI to land in.
      rpc.respond(request.id, { action: 'decline' });
      return;
    }
    const requestId = `devin-elicitation:${session.threadId}:${request.id}`;
    this.pendingPermissions.set(requestId, { kind: 'elicitation', threadId: session.threadId, rpc, request, elicitation });
    const input: AskUserQuestionInput = {
      questions: elicitation.questions.map((question) => ({
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        options: question.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        ...(question.multiSelect ? { multiSelect: true } : {}),
      })),
    };
    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId,
      toolName: 'AskUserQuestion',
      input,
    });
  }

  private dismissPermissions(threadId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.threadId !== threadId) continue;
      this.pendingPermissions.delete(requestId);
      this.emit({ type: 'permission_dismissed', threadId, requestId });
      try {
        pending.rpc.respond(
          pending.request.id,
          pending.kind === 'elicitation' ? { action: 'cancel' } : { outcome: { outcome: 'cancelled' } }
        );
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

  private handleSessionUpdate(session: ActiveDevinSession, update: DevinSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.emitAssistantDelta(session, extractTextContent(update.content));
        break;
      case 'agent_thought_chunk':
        this.emitThinkingDelta(session, extractTextContent(update.content));
        break;
      case 'tool_call':
        this.handleToolCall(session, update);
        break;
      case 'tool_call_update':
        this.handleToolCallUpdate(session, update);
        break;
      case 'plan':
        this.emitPlan(session, update);
        break;
      case 'available_commands_update':
        this.emitAvailableCommands(session, update);
        break;
      case 'config_option_update': {
        session.model = extractConfigValue(update.configOptions, 'model') || session.model;
        const ids = extractModelIds(update.configOptions);
        if (ids.size > 0) session.modelIds = ids;
        const thought = extractThoughtLevels(update.configOptions);
        if (thought.found) {
          session.thoughtLevel = thought.current;
          session.thoughtLevelIds = thought.ids;
        }
        break;
      }
      case 'current_mode_update':
        session.currentMode = getString(update.currentModeId) || session.currentMode;
        break;
      case 'usage_update':
        this.emitTokenUsage(session, update);
        break;
      default:
        // session_info_update (unusable titles), user_message_chunk (replay only).
        break;
    }
  }

  /**
   * Mid-turn text and reasoning ride Claude-shaped stream events carrying only
   * the increment, which the renderer's delta coalescer batches; the committed
   * message lands in finalizeStreaming.
   */
  private emitAssistantDelta(session: ActiveDevinSession, text: string): void {
    if (!text) return;
    if (!session.currentAssistant) {
      session.currentAssistant = {
        uuid: `devin-assistant:${session.threadId}:${uuidv4()}`,
        text: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    session.currentAssistant.text += text;
    this.emitStreamDelta(session, session.currentAssistant.blockIndex, { type: 'text_delta', text });
  }

  private emitThinkingDelta(session: ActiveDevinSession, thinking: string): void {
    if (!thinking) return;
    if (!session.currentThinking) {
      session.currentThinking = {
        uuid: `devin-thinking:${session.threadId}:${uuidv4()}`,
        thinking: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    session.currentThinking.thinking += thinking;
    this.emitStreamDelta(session, session.currentThinking.blockIndex, { type: 'thinking_delta', thinking });
  }

  private emitStreamDelta(
    session: ActiveDevinSession,
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

  private finalizeStreaming(session: ActiveDevinSession): void {
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

  private emitToolUseMessage(session: ActiveDevinSession, id: string, call: DevinToolCall): void {
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `devin-tool-use:${session.threadId}:${id}`,
        createdAt: call.createdAt,
        message: { content: [{ type: 'tool_use', id, name: call.name, input: call.input }] },
      },
    });
  }

  private handleToolCall(session: ActiveDevinSession, update: DevinSessionUpdate): void {
    const id = getString(update.toolCallId) || uuidv4();
    const existing = session.toolCalls.get(id);
    // A first-seen call closes the current prose block so narration between
    // calls keeps its own position; a repeat must not split mid-sentence.
    if (!existing) {
      this.finalizeStreaming(session);
    }
    const name = existing?.name || devinToolName(update);
    const rawInput = getRecord(update.rawInput);
    const call: DevinToolCall = {
      name,
      title: getString(update.title) || existing?.title || '',
      input: rawInput ? devinToolInput(name, rawInput) : existing?.input || {},
      createdAt: existing?.createdAt || Date.now(),
      output: existing?.output || '',
      settled: existing?.settled || false,
    };
    session.toolCalls.set(id, call);
    this.emitToolUseMessage(session, id, call);
  }

  private handleToolCallUpdate(session: ActiveDevinSession, update: DevinSessionUpdate): void {
    const id = getString(update.toolCallId);
    const call = id ? session.toolCalls.get(id) : undefined;
    if (!id || !call) return;

    const rawInput = getRecord(update.rawInput);
    const title = getString(update.title);
    if (rawInput || (title && title !== call.title)) {
      call.input = rawInput ? devinToolInput(call.name, rawInput) : call.input;
      call.title = title || call.title;
      this.emitToolUseMessage(session, id, call);
    }

    const status = getString(update.status);
    const output = extractToolOutput(update);
    if (output && output !== call.output) {
      // Exec output arrives as growing snapshots; forward the new suffix to
      // the live tool card. A settling update's output rides the result.
      if (status === 'in_progress' && output.startsWith(call.output)) {
        const delta = output.slice(call.output.length);
        if (delta) this.emit({ type: 'tool_output_delta', threadId: session.threadId, toolUseId: id, delta });
      }
      call.output = output;
    }

    if (status === 'completed' || status === 'failed') {
      this.emitToolResult(session, id, call, status === 'failed');
    }
  }

  private emitToolResult(session: ActiveDevinSession, id: string, call: DevinToolCall, isError: boolean): void {
    if (call.settled) return;
    call.settled = true;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: `devin-tool-result:${session.threadId}:${id}`,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              // The final update of a successful edit/exec often carries no
              // content; the last snapshot (or the title) stands in.
              content: call.output || call.title || (isError ? 'Failed' : 'Done'),
              is_error: isError,
            },
          ],
        },
      },
    });
  }

  /** A turn that ends (or dies) with calls still open must not leave spinning cards. */
  private settleOpenToolCalls(session: ActiveDevinSession): void {
    for (const [id, call] of session.toolCalls) {
      if (!call.settled) this.emitToolResult(session, id, call, false);
    }
  }

  private emitPlan(session: ActiveDevinSession, update: DevinSessionUpdate): void {
    const steps = getArray(update.entries)
      .map((entry) => {
        const record = getRecord(entry);
        const status = getString(record?.status);
        const planStatus: PlanStepStatus =
          status === 'completed' ? 'completed' : status === 'in_progress' ? 'inProgress' : 'pending';
        return { step: getString(record?.content || record?.title), status: planStatus };
      })
      .filter((step) => step.step);
    if (steps.length === 0) return;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'plan_update',
        uuid: `devin-plan:${session.threadId}:${uuidv4()}`,
        turnId: `devin:${session.threadId}`,
        steps,
      },
    });
  }

  /** Context ring: Devin reports occupancy (`used`) and window (`size`) directly. */
  private emitTokenUsage(session: ActiveDevinSession, update: DevinSessionUpdate): void {
    const contextWindow = getNumber(update.size);
    if (contextWindow <= 0) return;
    const meta = getRecord(update._meta);
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'token_usage',
        uuid: `devin-token-usage:${session.threadId}:${Date.now()}`,
        session_id: session.threadId,
        provider: 'devin',
        usage: {
          inputTokens: getNumber(meta?.['cognition.ai/inputTokens']),
          cachedInputTokens: getNumber(meta?.['cognition.ai/cachedReadTokens']),
          outputTokens: getNumber(meta?.['cognition.ai/outputTokens']),
          reasoningOutputTokens: 0,
          totalTokens: getNumber(update.used),
          contextWindow,
        },
      },
    });
  }

  private emitAvailableCommands(session: ActiveDevinSession, update: DevinSessionUpdate): void {
    const availableCommands = getArray(update.availableCommands)
      .map((command) => {
        const record = getRecord(command);
        const name = getString(record?.name).replace(/^\//, '').trim();
        if (!name) return null;
        const hint = getString(getRecord(record?.input)?.hint);
        return {
          name,
          description: getString(record?.description) || 'Devin slash command',
          ...(hint ? { input: { hint } } : {}),
        };
      })
      .filter((command): command is { name: string; description: string; input?: { hint: string } } =>
        Boolean(command)
      );
    // Devin re-pushes the list (~140 entries with skills); skip identical repeats.
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
