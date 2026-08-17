import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { buildGrokEnv, resolveGrokBinary } from '../grok-cli';
import { readGrokSessionSignals } from '../grok-session-files';
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
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillDescriptor,
  StreamMessage,
} from '../../../shared/types';
import {
  extractMediaPathsFromValue,
  isMediaGenerationTool,
  mediaKindFromToolName,
  withGeneratedMediaInput,
} from '../../../shared/generated-media';
import { getBrowserUseMcpDescriptor } from '../browser-use-http-server';
import { createGrokAcpHttpMcpServer } from './grok-acp-mcp';

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
  currentAssistant?: { uuid: string; text: string; createdAt: number; blockIndex: number };
  currentThinking?: { uuid: string; thinking: string; createdAt: number; blockIndex: number };
  /** Content-block counter for the stream events the renderer coalesces on. */
  nextBlockIndex: number;
  /** Serialized last command list, to skip re-broadcasting an identical one. */
  lastCommandsSignature?: string;
  /** Latest skills seen in available_commands_update; see listSkills. */
  skills?: ProviderSkillDescriptor[];
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

/**
 * Grok reports cost in USD ticks (bitcents): 1 USD = 1e10 ticks. The CLI's
 * `costUsdTicks` field divides by this to yield a dollar amount (verified
 * against xAI's cost-tracking docs, e.g. 37756000 ticks = $0.0037756).
 */
const GROK_COST_TICKS_PER_USD = 1e10;

function terminateSpawnedGrokProcess(proc: ChildProcessWithoutNullStreams): void {
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

interface GrokTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUSD: number;
}

/**
 * Extract per-turn usage from the session/prompt response. Grok returns it on
 * the result's `_meta.usage` (camelCase), alongside top-level `_meta` token
 * fields as a fallback. See the ACP probe payload: inputTokens/outputTokens/
 * cachedReadTokens/cacheCreationTokens/reasoningTokens/costUsdTicks.
 */
function extractGrokTurnUsage(result: unknown): GrokTurnUsage {
  const record = getRecord(result);
  const meta = getRecord(record?._meta);
  const usage = getRecord(meta?.usage) || getRecord(record?.usage) || {};
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

  const inputTokens = num(usage.inputTokens) || num(meta?.inputTokens);
  const outputTokens = num(usage.outputTokens) || num(meta?.outputTokens);
  const cacheReadTokens = num(usage.cachedReadTokens) || num(meta?.cachedReadTokens);
  const cacheCreationTokens = num(usage.cacheCreationTokens) || num(meta?.cacheCreationTokens);
  const reasoningTokens = num(usage.reasoningTokens) || num(meta?.reasoningTokens);
  const costUsdTicks = num(usage.costUsdTicks);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    costUSD: costUsdTicks / GROK_COST_TICKS_PER_USD,
  };
}

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

/**
 * Grok ships skills and built-in slash commands in one available_commands
 * list. A skill is the entry that carries `_meta.path` — the SKILL.md it was
 * loaded from; builtins (compact, context, …) have no `_meta`. Reading the
 * agent's own list beats re-deriving its discovery rules, which span
 * ~/.grok/skills, ~/.agents/skills, bundled skills inside the install, and a
 * compatibility scan of ~/.claude/skills.
 */
function extractSkillsFromCommands(availableCommands: unknown): ProviderSkillDescriptor[] {
  const skills = getArray(availableCommands).flatMap((command): ProviderSkillDescriptor[] => {
    const record = getRecord(command);
    const meta = getRecord(record?._meta);
    const path = getString(meta?.path).trim();
    const name = getString(record?.name).replace(/^\//, '').trim();
    if (!path || !name) return [];
    const description = getString(record?.description).trim();
    const scope = getString(meta?.scope).trim();
    return [
      {
        name,
        path,
        enabled: true,
        ...(description ? { description } : {}),
        ...(scope ? { scope } : {}),
      },
    ];
  });
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function extractGrokToolName(update: GrokSessionUpdate): string {
  const meta = getRecord(update._meta);
  const tool = getRecord(meta?.['x.ai/tool']);
  const metaName = getString(tool?.name).trim();
  if (metaName) return metaName;
  return getString(update.title) || 'GrokTool';
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

const SKILLS_CACHE_TTL_MS = 5 * 60 * 1000;
/** Cold probes wait on the agent booting its MCP servers before it lists commands. */
const SKILLS_PROBE_TIMEOUT_MS = 45_000;

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
  private skillsCache = new Map<string, { skills: ProviderSkillDescriptor[]; fetchedAt: number }>();
  private skillsProbes = new Map<string, Promise<ProviderSkillDescriptor[]>>();
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

    await rpc
      .request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.32' },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      })
      .catch((error) => {
        terminateSpawnedGrokProcess(proc);
        throw error;
      });

    const permissionMode = normalizeGrokPermissionMode(input.grokPermissionMode);
    // Built-in browser use: hand grok the loopback HTTP MCP server when the
    // feature is on (ACP session/new mcpServers, http variant).
    const browserUseDescriptor = getBrowserUseMcpDescriptor();
    const mcpServers = browserUseDescriptor
      ? [createGrokAcpHttpMcpServer('aegis-browser', browserUseDescriptor)]
      : [];
    const sessionResult = await rpc
      .request(input.resumeSessionId ? 'session/resume' : 'session/new', {
        ...(input.resumeSessionId ? { sessionId: input.resumeSessionId } : {}),
        cwd: input.cwd,
        mcpServers,
        ...(permissionMode ? { permissionMode } : {}),
      })
      .catch((error) => {
        terminateSpawnedGrokProcess(proc);
        throw error;
      });
    let sessionRecord = getRecord(sessionResult);
    const providerSessionId = getString(
      sessionRecord?.sessionId || sessionRecord?.id || input.resumeSessionId
    );
    if (!providerSessionId) {
      terminateSpawnedGrokProcess(proc);
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
      nextBlockIndex: 0,
    };
    // Never orphan a previous session for the same thread — an undisposed
    // predecessor would leak its grok child process.
    this.disposeSession(input.threadId);
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

    // Grok's signals.json persists on disk, so a restored session can show its
    // context watermark before the first turn of this run — unlike codex/kimi
    // whose watermark only exists at runtime and relies on transcript history.
    this.hydrateContextFromDisk(active);

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
      const promptResult = await session.rpc.request('session/prompt', {
        sessionId: session.providerSessionId,
        prompt: buildPromptBlocks(input.prompt, input.attachments),
      });
      this.finalizeStreaming(session);
      const turnUsage = extractGrokTurnUsage(promptResult);
      this.emitGrokTokenUsage(session, turnUsage);
      session.status = 'completed';
      this.emit({
        type: 'message',
        threadId: input.threadId,
        message: {
          type: 'result',
          subtype: 'success',
          duration_ms: 0,
          total_cost_usd: turnUsage.costUSD,
          usage: {
            input_tokens: turnUsage.inputTokens,
            output_tokens: turnUsage.outputTokens,
            cache_creation_input_tokens: turnUsage.cacheCreationTokens,
            cache_read_input_tokens: turnUsage.cacheReadTokens,
            reasoning_output_tokens: turnUsage.reasoningTokens,
            total_tokens:
              turnUsage.inputTokens +
              turnUsage.outputTokens +
              turnUsage.cacheReadTokens +
              turnUsage.cacheCreationTokens +
              turnUsage.reasoningTokens,
          },
          model: session.model,
        },
      });
      this.emit({ type: 'status_change', threadId: input.threadId, status: 'completed' });
    } catch (error) {
      // A disposeSession kills the process, which rejects this turn's RPC —
      // that stale rejection must not emit an error result into whatever
      // replacement session now owns the thread.
      if (this.sessions.get(input.threadId) !== session) {
        return;
      }
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

  disposeSession(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session) {
      return false;
    }
    try {
      // Dismiss stranded approval cards before killing the process: a card
      // clicked after dispose would otherwise hit a dead binding and the
      // pendingPermissions entry would leak forever.
      for (const [requestId, pending] of this.pendingPermissions) {
        if (pending.threadId !== threadId) {
          continue;
        }
        this.pendingPermissions.delete(requestId);
        this.emit({ type: 'permission_dismissed', threadId, requestId });
        try {
          pending.rpc.respond(pending.request.id, { outcome: { outcome: 'cancelled' } });
        } catch {
          // The process may already be gone.
        }
      }
      this.cleanupTerminals(session);
      // Map entry goes first: the exit handler is identity-guarded
      // (current?.proc === proc), so the async exit then emits nothing.
      this.sessions.delete(threadId);
      session.proc.kill('SIGTERM');
    } catch (error) {
      console.warn('[GrokAcpAdapter] disposeSession cleanup failed:', error);
    }
    return true;
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

  /**
   * Skills come from the agent itself: Grok pushes available_commands_update
   * right after session/new, and every skill entry carries its SKILL.md path.
   * A live session for this cwd answers instantly; otherwise a throwaway
   * session is opened just to read the list, which is slow (the agent boots
   * the configured MCP servers first), so results are cached per cwd and the
   * library's Refresh button is the way to bypass it.
   */
  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    const cwd = input.cwd?.trim() || process.cwd();

    for (const session of this.sessions.values()) {
      if (session.cwd === cwd && session.skills && session.skills.length > 0) {
        return { skills: session.skills, source: 'grok-acp', cached: false };
      }
    }

    const cached = this.skillsCache.get(cwd);
    if (!input.forceReload && cached && Date.now() - cached.fetchedAt < SKILLS_CACHE_TTL_MS) {
      return { skills: cached.skills, source: 'grok-acp', cached: true };
    }

    // Single-flight: the composer and every message card ask for this catalog,
    // and the result cache only helps once the first probe has RESOLVED —
    // without this, the callers that arrive during those seconds each boot
    // their own agent.
    const pending = this.skillsProbes.get(cwd);
    if (pending && !input.forceReload) {
      return { skills: await pending, source: 'grok-acp', cached: true };
    }

    const probe = this.probeSkills(cwd)
      .then((skills) => {
        this.skillsCache.set(cwd, { skills, fetchedAt: Date.now() });
        return skills;
      })
      .finally(() => {
        if (this.skillsProbes.get(cwd) === probe) {
          this.skillsProbes.delete(cwd);
        }
      });
    this.skillsProbes.set(cwd, probe);
    return { skills: await probe, source: 'grok-acp', cached: false };
  }

  /** Opens a short-lived ACP session purely to collect its command list. */
  private async probeSkills(cwd: string): Promise<ProviderSkillDescriptor[]> {
    const binary = await resolveGrokBinary();
    if (!binary) {
      throw new Error('Grok Build CLI was not found. Install Grok Build or set GROK_CODE_PATH.');
    }

    const proc = spawn(binary, buildGrokAgentArgs(undefined), {
      cwd,
      env: buildGrokEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stderr.resume();

    let collected: ProviderSkillDescriptor[] = [];
    let onSkills: (() => void) | null = null;
    const rpc = new AcpJsonRpcClient(
      proc,
      (method, params) => {
        if (method !== 'session/update') return;
        const update = getRecord(getRecord(params)?.update);
        if (!update || update.sessionUpdate !== 'available_commands_update') return;
        const skills = extractSkillsFromCommands(update.availableCommands);
        if (skills.length > 0) {
          collected = skills;
          onSkills?.();
        }
      },
      // A probe session never runs tools, so nothing should call back into us;
      // answer anything that does with an error rather than hanging the CLI.
      (request) => {
        try {
          rpc.respond(request.id, undefined, {
            code: -32601,
            message: 'Aegis skill probe does not service requests.',
          });
        } catch {
          // The process may already be gone.
        }
      },
      () => {
        // Ignore unparsable lines: the probe only cares about one notification.
      }
    );

    try {
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.32' },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      });
      await rpc.request('session/new', { cwd, mcpServers: [] });

      if (collected.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SKILLS_PROBE_TIMEOUT_MS);
          timer.unref?.();
          onSkills = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    } finally {
      onSkills = null;
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
    }

    return collected;
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
      case 'available_commands_update': {
        const skills = extractSkillsFromCommands(update.availableCommands);
        if (skills.length > 0) {
          session.skills = skills;
        }
        this.emitAvailableCommands(threadId, session.providerSessionId, update);
        break;
      }
      case 'config_option_update':
        session.model = extractModelFromConfigOptions(update.configOptions) || session.model;
        break;
      default:
        break;
    }
  }

  /**
   * Mid-turn text and reasoning ride Claude-shaped stream events carrying only
   * the INCREMENT, which is what the renderer's delta coalescer batches.
   * Re-emitting the whole buffer per chunk instead made the bytes grow with
   * the square of the answer and bypassed coalescing entirely — a 300-char
   * reply cost 9.6KB across 66 renders. The committed message still lands in
   * finalizeStreaming, so the transcript and persistence are unchanged.
   */
  private emitAssistantDelta(session: ActiveGrokSession, text: string): void {
    if (!text) return;
    if (!session.currentAssistant) {
      session.currentAssistant = {
        uuid: `grok-assistant:${session.threadId}:${uuidv4()}`,
        text: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    const current = session.currentAssistant;
    current.text += text;
    this.emitStreamDelta(session, current.blockIndex, { type: 'text_delta', text });
  }

  private emitThinkingDelta(session: ActiveGrokSession, thinking: string): void {
    if (!thinking) return;
    if (!session.currentThinking) {
      session.currentThinking = {
        uuid: `grok-thinking:${session.threadId}:${uuidv4()}`,
        thinking: '',
        createdAt: Date.now(),
        blockIndex: session.nextBlockIndex++,
      };
    }
    const current = session.currentThinking;
    current.thinking += thinking;
    this.emitStreamDelta(session, current.blockIndex, { type: 'thinking_delta', thinking });
  }

  private emitStreamDelta(
    session: ActiveGrokSession,
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

  /**
   * Hydrate the context ring from Grok's on-disk signals.json. Called right
   * after a session binds (new or resumed): a restored session shows its last
   * known watermark immediately, before any turn runs in this process. Fresh
   * sessions have no signals.json yet, so this is a no-op there.
   */
  private hydrateContextFromDisk(session: ActiveGrokSession): void {
    const signals = readGrokSessionSignals(session.cwd, session.providerSessionId);
    if (!signals || signals.contextWindowTokens <= 0) {
      return;
    }
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'token_usage',
        uuid: 'grok-token-usage:' + session.threadId + ':hydrate',
        session_id: session.threadId,
        provider: 'grok',
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: signals.contextTokensUsed,
          contextWindow: signals.contextWindowTokens,
        },
      },
    });
  }

  /**
   * Emit the codex-style context ring for Grok. Context occupancy comes from
   * Grok's own signals.json watermark (contextTokensUsed, written when a turn
   * settles and after every auto-compaction), NOT from summing per-turn usage
   * — the latter keeps growing and never reflects post-compact occupancy.
   * Per-turn input/output/cache/reasoning tokens ride the same message for
   * the detail rows.
   */
  private emitGrokTokenUsage(session: ActiveGrokSession, turnUsage: GrokTurnUsage): void {
    const signals = readGrokSessionSignals(session.cwd, session.providerSessionId);
    const contextWindow = signals?.contextWindowTokens ?? 0;
    if (contextWindow <= 0) {
      // No window size on disk yet (fresh session); the ring needs a
      // denominator, so skip until signals.json lands. The result message
      // still carries per-turn token/cost regardless.
      return;
    }
    const contextTokens = signals?.contextTokensUsed ?? turnUsage.inputTokens;
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'system',
        subtype: 'token_usage',
        uuid: 'grok-token-usage:' + session.threadId + ':' + Date.now(),
        session_id: session.threadId,
        provider: 'grok',
        usage: {
          inputTokens: turnUsage.inputTokens,
          cachedInputTokens: turnUsage.cacheReadTokens,
          outputTokens: turnUsage.outputTokens,
          reasoningOutputTokens: turnUsage.reasoningTokens,
          totalTokens: contextTokens,
          contextWindow,
        },
      },
    });
  }

  private emitToolUse(threadId: string, update: GrokSessionUpdate): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    const id = getString(update.toolCallId) || uuidv4();
    const name = extractGrokToolName(update);
    const rawInput = getRecord(update.rawInput) || {};
    const existing = session.toolCalls.get(id);
    // A new tool call closes the current text/thinking block: Grok narrates
    // between calls, and one buffer per turn would stamp the whole turn's
    // prose at the first chunk — the narration then rides into the final
    // answer and sorts in among the tool rows. Only a first-seen id flushes;
    // a repeat is an input update for a call already in flight and must not
    // split the prose mid-sentence.
    if (!existing) {
      this.finalizeStreaming(session);
    }
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
    const name = existing?.name || extractGrokToolName(update);
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
    const session = this.sessions.get(threadId);
    const toolName = session?.toolCalls.get(id)?.name || extractGrokToolName(update);
    const fallbackKind = mediaKindFromToolName(toolName);
    const generatedMedia = isMediaGenerationTool(toolName) || fallbackKind
      ? extractMediaPathsFromValue(
          { text, rawOutput: update.rawOutput, content: update.content, locations: update.locations },
          fallbackKind
        )
      : [];
    if (session && generatedMedia.length > 0) {
      const existing = session.toolCalls.get(id);
      const prompt = typeof existing?.input?.prompt === 'string' ? existing.input.prompt : undefined;
      const media = generatedMedia.map((item) => ({ ...item, toolUseId: id, prompt }));
      const nextInput = withGeneratedMediaInput(existing?.input || {}, media);
      session.toolCalls.set(id, {
        name: existing?.name || toolName,
        input: nextInput,
        createdAt: existing?.createdAt || Date.now(),
      });
      this.emit({
        type: 'message',
        threadId,
        message: {
          type: 'assistant',
          uuid: `grok-tool-use:${threadId}:${id}`,
          createdAt: existing?.createdAt,
          message: {
            content: [{ type: 'tool_use', id, name: existing?.name || toolName, input: nextInput }],
          },
        },
      });
    }
    if (!text && generatedMedia.length === 0) return;
    const resultText = text
      || generatedMedia.map((item) => item.path).join('\n')
      || status
      || 'Updated';
    const message: StreamMessage = {
      type: 'assistant',
      uuid: `grok-tool-result:${threadId}:${id}:${uuidv4()}`,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: resultText,
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
        // Skills ride this same list; their `_meta` (SKILL.md path + scope) is
        // what tells the composer they are skills rather than built-ins.
        const metaRecord = getRecord(record?._meta);
        const path = getString(metaRecord?.path).trim();
        const scope = getString(metaRecord?.scope).trim();
        return {
          name,
          description,
          ...(hint ? { input: { hint } } : {}),
          ...(path || scope
            ? { meta: { ...(path ? { path } : {}), ...(scope ? { scope } : {}) } }
            : {}),
        };
      })
      .filter(
        (
          command
        ): command is {
          name: string;
          description: string;
          input?: { hint: string };
          meta?: { scope?: string; path?: string };
        } => Boolean(command)
      );

    // Grok re-pushes this list on its own schedule, and it is large (~49KB
    // with 139 skills). An identical repeat would cross IPC, re-render the
    // menu, and land another copy in the transcript store and the database.
    // Compared order-insensitively: observed repeats carry the same commands
    // in a different order, and the renderer sorts by name anyway.
    const signature = JSON.stringify(
      [...availableCommands].sort((left, right) => left.name.localeCompare(right.name))
    );
    const session = this.sessions.get(threadId);
    if (session) {
      if (session.lastCommandsSignature === signature) {
        return;
      }
      session.lastCommandsSignature = signature;
    }

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
