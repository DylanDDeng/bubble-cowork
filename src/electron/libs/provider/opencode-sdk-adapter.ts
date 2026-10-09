import { CompactionTracker } from './compaction-tracker';
import { validUsd } from '../agent-cost';
import { isProjectDirectoryApproval } from './project-access';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type {
  AcpPermissionInput,
  AskUserQuestionInput,
  Attachment,
  AvailableCommand,
  ContentBlock,
  McpServerStatus,
  OpenCodePermissionMode,
  PermissionResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillDescriptor,
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
  getOpenCodeServeManager,
  OPENCODE_ASK_PERMISSIONS,
  OPENCODE_SERVER_EXITED_EVENT,
  type OpenCodeClient,
  type OpenCodeEventListener,
} from './opencode-serve-manager';
import {
  OpenCodeApiError,
  type OpenCodeModelInfo,
  type OpenCodeModelRef,
  type OpenCodePermissionDecision,
  type OpenCodePermissionRule,
  type OpenCodePromptFile,
  type OpenCodeServerEvent,
  type OpenCodeSessionInfo,
  type OpenCodeTokens,
} from './opencode-v2-client';

/**
 * OpenCode 2.x provider. Talks to the app-wide `opencode serve` (see
 * OpenCodeServeManager) over its `/api/*` routes. Prompts are asynchronous:
 * the server accepts them immediately and the turn is reported only through
 * the event stream, ending with one `session.execution.*` terminal event.
 */

const CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: false,
  skillDiscovery: true,
  pluginDiscovery: false,
  mcpServers: true,
  imageAttachments: true,
  forkThread: true,
  compactThread: true,
  planMode: true,
};

/** Built into the server as its own route rather than listed by `/api/command`. */
const COMPACT_COMMAND: AvailableCommand = { name: 'compact', description: 'Compact the current session' };

export type OpenCodeServeManagerLike = {
  getClient(): Promise<OpenCodeClient>;
  loadModels(directory: string): Promise<{ models: OpenCodeModelInfo[]; defaultModel: OpenCodeModelInfo | null }>;
  subscribe(sessionID: string, listener: OpenCodeEventListener): () => void;
  close(): Promise<void>;
  setBrowserUseHooks?(
    resolve: (meta: Record<string, unknown> | undefined) => Promise<string | null>,
    canRestart: () => boolean
  ): void;
};

type StepAccumulator = {
  uuid: string;
  text: Map<number, string>;
  reasoning: Map<number, string>;
};

type TurnAccumulator = {
  startedAt: number;
  cost: number;
  tokens?: OpenCodeTokens;
  model?: string;
  error?: string;
  /** The user rejected a request: OpenCode then halts the turn, which is a normal end. */
  userRejected?: boolean;
};

type OpenCodePendingRequest =
  | { kind: 'permission' }
  | { kind: 'form'; fields: OpenCodeFormFieldDescriptor[] };

type OpenCodeFormFieldDescriptor = {
  key: string;
  question: string;
  type: string;
  options: Array<{ value: string; label: string }>;
};

type ActiveOpenCodeSession = {
  threadId: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  cwd: string;
  model?: string;
  /** Model and agent the server-side session currently uses. */
  appliedModel?: string;
  appliedAgent?: string;
  permissionMode: OpenCodePermissionMode;
  unsubscribe: () => void;
  availableCommands: Set<string>;
  steps: Map<string, StepAccumulator>;
  toolNames: Map<string, string>;
  emittedToolCallIds: Set<string>;
  emittedToolResultIds: Set<string>;
  emittedRequestIds: Set<string>;
  pendingRequests: Map<string, OpenCodePendingRequest>;
  turn: TurnAccumulator | null;
};

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

export function normalizeOpenCodePermissionMode(
  mode: OpenCodePermissionMode | undefined
): OpenCodePermissionMode {
  if (mode === 'plan') {
    return 'plan';
  }

  return mode === 'fullAccess' ? 'fullAccess' : 'defaultPermissions';
}

/** `provider/model` → the server's model reference (the model id may contain slashes). */
export function parseOpenCodeModel(model: string | undefined): OpenCodeModelRef | undefined {
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
    id: normalized.slice(slashIndex + 1),
  };
}

export function formatOpenCodeModel(model: unknown): string | undefined {
  const record = getRecord(model);
  const provider = getString(record?.providerID).trim();
  const id = getString(record?.id).trim();
  return provider && id ? `${provider}/${id}` : undefined;
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
      name: 'Always allow',
      kind: 'allow_always',
      description: 'Save an OpenCode rule that allows matching actions without asking again.',
    },
    {
      optionId: 'reject',
      name: 'Reject',
      kind: 'reject',
      description: 'Reject this OpenCode action.',
    },
  ];
}

function mapPermissionDecision(decision: PermissionResult): OpenCodePermissionDecision {
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

function describeResources(resourcesValue: unknown): string {
  if (!Array.isArray(resourcesValue)) {
    return '';
  }
  return resourcesValue
    .map((resource) => getString(resource).trim())
    .filter(Boolean)
    .join(', ');
}

function mapMcpStatus(status: unknown): McpServerStatus['status'] {
  const raw = getString(getRecord(status)?.status);
  if (raw === 'connected') return 'connected';
  if (raw === 'failed' || raw === 'needs-auth') return 'failed';
  return 'pending';
}

function describeStructuredError(value: unknown, fallback: string): string {
  const record = getRecord(value);
  return getString(record?.message) || getString(record?.type) || fallback;
}

function joinOrdinals(parts: Map<number, string>): string {
  return [...parts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('');
}

function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const record = getRecord(item);
      return getString(record?.type) === 'text' ? getString(record?.text) : '';
    })
    .filter(Boolean)
    .join('\n');
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

/** Images go inline as data URIs; other attachments are referenced by path in the text. */
async function buildPromptFiles(attachments: Attachment[] | undefined): Promise<OpenCodePromptFile[]> {
  const files: OpenCodePromptFile[] = [];
  for (const attachment of attachments?.filter((item) => item?.kind === 'image') || []) {
    try {
      const buffer = await readFile(attachment.path);
      const mime = attachment.mimeType || 'application/octet-stream';
      files.push({ uri: `data:${mime};base64,${buffer.toString('base64')}`, name: attachment.name });
    } catch (error) {
      console.warn('[OpenCodeSdkAdapter] failed to read image attachment:', error);
    }
  }
  return files;
}

/** Maps an OpenCode form (the question tool's prompt) onto Aegis's question card. */
export function buildOpenCodeFormQuestions(
  formValue: unknown
): { input: AskUserQuestionInput; fields: OpenCodeFormFieldDescriptor[] } | null {
  const form = getRecord(formValue);
  const rawFields = Array.isArray(form?.fields) ? form.fields : [];
  const fields: OpenCodeFormFieldDescriptor[] = [];
  const questions: AskUserQuestionInput['questions'] = [];
  const usedQuestions = new Set<string>();
  for (const rawField of rawFields) {
    const field = getRecord(rawField);
    const key = getString(field?.key);
    if (!field || !key || field.hidden === true) continue;
    // The question tool puts the question in `description` and a short label in `title`.
    const title = getString(field.title).trim();
    const description = getString(field.description).trim();
    let question = description || title || key;
    while (usedQuestions.has(question)) question = `${question} (${key})`;
    usedQuestions.add(question);
    const options = (Array.isArray(field.options) ? field.options : [])
      .map((rawOption) => {
        const option = getRecord(rawOption);
        const value = getString(option?.value);
        const label = getString(option?.label).trim() || value;
        return value ? { value, label, description: getString(option?.description).trim() } : null;
      })
      .filter((option): option is { value: string; label: string; description: string } => Boolean(option));
    const type = getString(field.type);
    fields.push({ key, question, type, options: options.map(({ value, label }) => ({ value, label })) });
    questions.push({
      question,
      ...(title && description && description !== title ? { header: title.slice(0, 12) } : {}),
      ...(options.length > 0
        ? { options: options.map(({ label, description: detail }) => ({ label, ...(detail ? { description: detail } : {}) })) }
        : {}),
      ...(type === 'multiselect' ? { multiSelect: true } : {}),
    });
  }
  return questions.length > 0 ? { input: { questions }, fields } : null;
}

/** Converts the question card's label answers back into the form's typed values. */
export function buildOpenCodeFormAnswer(
  fields: OpenCodeFormFieldDescriptor[],
  decision: PermissionResult
): Record<string, unknown> {
  const answers = getRecord(decision.updatedInput?.answers);
  const answer: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = getString(answers?.[field.question]).trim();
    if (!raw) continue;
    const toValue = (label: string) => field.options.find((option) => option.label === label)?.value ?? label;
    if (field.type === 'multiselect') {
      answer[field.key] = raw.split(',').map((part) => part.trim()).filter(Boolean).map(toValue);
    } else if (field.type === 'number' || field.type === 'integer') {
      const parsed = Number(raw);
      answer[field.key] = Number.isFinite(parsed) ? parsed : raw;
    } else if (field.type === 'boolean') {
      answer[field.key] = /^(true|yes|y|1)$/i.test(raw);
    } else {
      answer[field.key] = toValue(raw);
    }
  }
  return answer;
}

/** Adds Aegis's ask rules to a session's own rules (missing ones only). */
function withAskPermissions(existing: OpenCodePermissionRule[] | undefined): OpenCodePermissionRule[] | null {
  const rules = existing ?? [];
  const missing = OPENCODE_ASK_PERMISSIONS.filter(
    (ask) => !rules.some((rule) => rule.action === ask.action && rule.resource === ask.resource && rule.effect === 'ask')
  );
  return missing.length > 0 ? [...rules, ...missing] : null;
}

export class OpenCodeSdkAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'opencode';
  readonly displayName = 'OpenCode';
  readonly capabilities = CAPABILITIES;
  readonly events = new EventEmitter();

  private manager: OpenCodeServeManagerLike;
  private readonly compactions = new CompactionTracker(event => this.emit(event));

  private sessions = new Map<string, ActiveOpenCodeSession>();
  private modelLimits = new Map<string, { contextWindow: number; outputLimit: number }>();

  constructor(manager: OpenCodeServeManagerLike = getOpenCodeServeManager()) {
    this.manager = manager;
    // Optional: test doubles of the serve manager may not implement it.
    this.manager.setBrowserUseHooks?.(
      (meta) => this.resolveBrowserUseThread(meta),
      () => this.sessions.size === 0
    );
  }

  /**
   * The Aegis thread behind a browser_use call: OpenCode names its session in
   * the MCP request meta. A subagent runs in a child session, so unknown ids
   * follow their parent up to the session a thread owns.
   */
  private async resolveBrowserUseThread(meta: Record<string, unknown> | undefined): Promise<string | null> {
    let id = getString(meta?.['ai.opencode/sessionID']).trim();
    for (let depth = 0; id && depth < 4; depth += 1) {
      for (const session of this.sessions.values()) {
        if (session.providerSessionId === id) return session.threadId;
      }
      if (this.sessions.size === 0) return null;
      const client = await this.manager.getClient();
      const info = await client.getSession(id).catch(() => null);
      id = getString(info?.parentID).trim();
    }
    return null;
  }

  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    const cwd = input.cwd?.trim() || process.cwd();
    const client = await this.manager.getClient();
    const rawSkills = await client.listSkills(cwd);
    const skills = rawSkills
      .flatMap((record): ProviderSkillDescriptor[] => {
        const name = getString(record.name);
        if (!name) return [];
        const path = getString(record.path);
        return [
          {
            name,
            ...(getString(record.description)
              ? { description: getString(record.description) }
              : {}),
            path: path || name,
            enabled: true,
            scope: path && path.startsWith(cwd) ? 'project' : 'user',
            content: getString(record.content) || null,
          },
        ];
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    return { skills, source: 'opencode-sdk', cached: false };
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const cwd = input.cwd || process.cwd();
    const client = await this.manager.getClient();
    const permissionMode = normalizeOpenCodePermissionMode(input.opencodePermissionMode);
    // Model limits only size the context meter; loading them can take seconds,
    // so they arrive in the background instead of delaying the first prompt.
    void this.refreshModelLimits(cwd);
    const info = await this.resolveProviderSession(client, cwd, input.resumeSessionId, input.model, permissionMode);
    const providerSessionId = info.id;
    const session: ActiveOpenCodeSession = {
      threadId: input.threadId,
      providerSessionId,
      status: 'running',
      cwd,
      model: input.model || formatOpenCodeModel(info.model),
      appliedModel: formatOpenCodeModel(info.model),
      appliedAgent: getString(info.agent) || undefined,
      permissionMode,
      unsubscribe: () => undefined,
      availableCommands: new Set([COMPACT_COMMAND.name]),
      steps: new Map(),
      toolNames: new Map(),
      emittedToolCallIds: new Set(),
      emittedToolResultIds: new Set(),
      emittedRequestIds: new Set(),
      pendingRequests: new Map(),
      turn: null,
    };
    // Never orphan a previous session for the same thread (an errored runner
    // is retired with dispose, but any path that missed it lands here).
    this.disposeSession(input.threadId);
    session.unsubscribe = this.manager.subscribe(providerSessionId, (event) => {
      if (this.sessions.get(input.threadId) === session) this.handleServerEvent(session, event);
    });
    this.sessions.set(input.threadId, session);

    this.emit({
      type: 'system_init',
      threadId: input.threadId,
      sessionId: providerSessionId,
      model: session.model,
    });
    await Promise.all([this.emitMcpStatus(session, client), this.emitAvailableCommands(session, client)]);

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
    const client = await this.manager.getClient();
    await this.applySessionSettings(session, client, input.model || session.model);
    if (this.sessions.get(input.threadId) !== session) {
      return;
    }

    const slashCommand = parseOpenCodeSlashCommand(input.prompt);
    const runCommand = slashCommand && !input.attachments?.length && session.availableCommands.has(slashCommand.name);
    const text = buildPromptText(input.prompt, input.attachments);
    const files = runCommand ? [] : await buildPromptFiles(input.attachments);
    if (!runCommand && !text.trim() && files.length === 0) {
      return;
    }

    session.status = 'running';
    // A queued prompt runs after the current turn; it must not reset that turn's totals.
    const startedTurn = !session.turn;
    session.turn ??= { startedAt: Date.now(), cost: 0, model: session.appliedModel };
    this.emit({ type: 'status_change', threadId: input.threadId, status: 'running' });

    const submit = () => {
      if (runCommand && slashCommand.name === COMPACT_COMMAND.name) {
        return client.compact(session.providerSessionId);
      }
      if (runCommand) {
        return client.command(session.providerSessionId, { name: slashCommand.name, text: slashCommand.args });
      }
      return client.prompt(session.providerSessionId, {
        text,
        ...(files.length > 0 ? { files } : {}),
        delivery: 'queue',
      });
    };
    try {
      try {
        await submit();
      } catch (error) {
        // A turn still holding the session (e.g. one another OpenCode server
        // resumed) blocks new input: interrupt it once and retry.
        if (!(error instanceof OpenCodeApiError) || error.tag !== 'SessionBusyError') throw error;
        await client.interrupt(session.providerSessionId);
        await submit();
      }
    } catch (error) {
      if (startedTurn && this.sessions.get(input.threadId) === session) {
        session.turn = null;
        session.status = 'error';
      }
      throw error;
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    session.status = 'stopped';
    this.releaseSessionResources(threadId, session);
    try {
      const client = await this.manager.getClient();
      await client.interrupt(session.providerSessionId);
    } catch {
      // The session may already be idle or the server may be shutting down.
    }
    this.emit({ type: 'status_change', threadId, status: 'stopped' });
  }

  disposeSession(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session) {
      return false;
    }
    try {
      this.releaseSessionResources(threadId, session);
    } catch (error) {
      console.warn('[OpenCodeSdkAdapter] disposeSession cleanup failed:', error);
    }
    return true;
  }

  /**
   * Resource-release subset shared by stopSession and disposeSession: drops
   * the event subscription (so nothing more is emitted for this session),
   * dismisses stranded approval cards, and removes the map entry. No network
   * interrupt, no status emission — dispose must stay silent for stop gates.
   */
  private releaseSessionResources(threadId: string, session: ActiveOpenCodeSession): void {
    session.unsubscribe();
    for (const requestId of session.pendingRequests.keys()) {
      this.emit({ type: 'permission_dismissed', threadId, requestId });
    }
    session.pendingRequests.clear();
    this.sessions.delete(threadId);
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
    const request = session.pendingRequests.get(requestId) || { kind: 'permission' };
    const client = await this.manager.getClient();
    const rejected = request.kind === 'form' ? decision.behavior === 'deny' : mapPermissionDecision(decision) === 'reject';
    if (rejected && session.turn) session.turn.userRejected = true;
    if (request.kind === 'form') {
      if (decision.behavior === 'deny') {
        await client.cancelForm(session.providerSessionId, requestId);
      } else {
        await client.replyForm(session.providerSessionId, requestId, buildOpenCodeFormAnswer(request.fields, decision));
      }
    } else {
      await client.replyPermission(session.providerSessionId, requestId, mapPermissionDecision(decision));
    }
    session.pendingRequests.delete(requestId);
  }

  async forkThread(input: { cwd: string; providerThreadId: string }): Promise<string> {
    const client = await this.manager.getClient();
    const forked = await client.fork(input.providerThreadId);
    const forkedId = getString(forked?.id).trim();
    if (!forkedId) {
      throw new Error('OpenCode did not return a forked session id.');
    }
    return forkedId;
  }

  private async resolveProviderSession(
    client: OpenCodeClient,
    cwd: string,
    resumeSessionId: string | undefined,
    model: string | undefined,
    permissionMode: OpenCodePermissionMode
  ): Promise<OpenCodeSessionInfo> {
    if (resumeSessionId?.trim()) {
      try {
        const existing = await client.getSession(resumeSessionId.trim());
        if (getString(existing?.id)) {
          // Sessions created before Aegis set its own rules (or by 1.x) get them now.
          const permissions = withAskPermissions(existing.permissions);
          if (permissions) await client.updateSession(existing.id, { permissions });
          return existing;
        }
      } catch (error) {
        console.warn('[OpenCodeSdkAdapter] failed to resume session, creating a new one:', error);
      }
    }

    const created = await client.createSession({
      directory: cwd,
      ...(permissionMode === 'plan' ? { agent: 'plan' } : {}),
      ...(parseOpenCodeModel(model) ? { model: parseOpenCodeModel(model) } : {}),
      permissions: OPENCODE_ASK_PERMISSIONS,
    });
    if (!getString(created?.id)) {
      throw new Error('OpenCode did not return a session id.');
    }
    return created;
  }

  /**
   * Prompts carry no model or agent in 2.x; both are session state, and each
   * switch is recorded in the session history — so switch only on change.
   */
  private async applySessionSettings(
    session: ActiveOpenCodeSession,
    client: OpenCodeClient,
    model: string | undefined
  ): Promise<void> {
    const modelRef = parseOpenCodeModel(model);
    if (modelRef && model !== session.appliedModel) {
      await client.switchModel(session.providerSessionId, modelRef);
      session.appliedModel = model;
      session.model = model;
    }
    const agent =
      session.permissionMode === 'plan' ? 'plan' : session.appliedAgent === 'plan' ? 'build' : undefined;
    if (agent && agent !== session.appliedAgent) {
      await client.switchAgent(session.providerSessionId, agent);
      session.appliedAgent = agent;
    }
  }

  private handleServerEvent(session: ActiveOpenCodeSession, event: OpenCodeServerEvent): void {
    const data = event.data ?? {};
    switch (event.type) {
      case 'session.execution.started':
        session.turn ??= { startedAt: Date.now(), cost: 0, model: session.appliedModel };
        session.status = 'running';
        break;
      case 'session.step.started': {
        const turn = (session.turn ??= { startedAt: Date.now(), cost: 0 });
        turn.model = formatOpenCodeModel(data.model) || turn.model;
        session.model = turn.model || session.model;
        this.ensureStep(session, getString(data.assistantMessageID));
        break;
      }
      case 'session.text.delta':
      case 'session.reasoning.delta':
      case 'session.text.ended':
      case 'session.reasoning.ended':
        this.handleTextEvent(session, event.type, data);
        break;
      case 'session.tool.input.started':
        this.flushStep(session, getString(data.assistantMessageID));
        if (getString(data.id)) session.toolNames.set(getString(data.id), getString(data.name));
        break;
      case 'session.tool.called':
        this.flushStep(session, getString(data.assistantMessageID));
        this.emitToolUse(session, getString(data.id), getRecord(data.input) || {});
        break;
      case 'session.tool.success':
        this.emitToolResult(session, getString(data.id), toolContentText(data.content), false);
        break;
      case 'session.tool.failed':
        this.emitToolResult(
          session,
          getString(data.id),
          describeStructuredError(data.error, '') || toolContentText(data.content) || 'OpenCode tool failed.',
          true
        );
        break;
      case 'session.step.ended':
      case 'session.step.failed': {
        this.flushStep(session, getString(data.assistantMessageID));
        session.steps.delete(getString(data.assistantMessageID));
        const turn = session.turn;
        if (turn) {
          turn.cost += getNumber(data.cost) || 0;
          turn.tokens = (getRecord(data.tokens) as OpenCodeTokens | null) || turn.tokens;
          const aborted = getString(getRecord(data.error)?.type) === 'aborted';
          if (event.type === 'session.step.failed' && !(aborted && turn.userRejected)) {
            turn.error = describeStructuredError(data.error, 'OpenCode step failed.');
          }
        }
        break;
      }
      case 'session.execution.succeeded':
        this.finishTurn(session, null);
        break;
      case 'session.execution.failed': {
        const message = describeStructuredError(data.error, 'OpenCode turn failed.');
        this.emit({ type: 'error', threadId: session.threadId, error: new Error(message) });
        this.finishTurn(session, message);
        break;
      }
      case 'session.execution.interrupted':
        // A user stop already released the session, and a rejected request halts
        // the turn by design; anything else ended the turn early.
        this.finishTurn(
          session,
          session.turn?.userRejected ? null : `OpenCode turn was interrupted (${getString(data.reason) || 'unknown'}).`
        );
        break;
      case 'session.compaction.started':
        this.compactions.start(session, { trigger: data.reason === 'manual' ? 'manual' : 'auto' });
        break;
      case 'session.compaction.ended':
        this.compactions.complete(session, { trigger: data.reason === 'manual' ? 'manual' : 'auto' });
        break;
      case 'session.compaction.failed':
        this.compactions.interrupt(session);
        break;
      case 'permission.asked':
        this.handlePermissionAsked(session, data);
        break;
      case 'permission.replied':
        this.dismissRequest(session, getString(data.requestID));
        break;
      case 'form.created':
        this.handleFormCreated(session, getRecord(data.form));
        break;
      case 'form.replied':
      case 'form.cancelled':
        this.dismissRequest(session, getString(data.id));
        break;
      case OPENCODE_SERVER_EXITED_EVENT:
        if (session.turn) {
          this.emit({
            type: 'error',
            threadId: session.threadId,
            error: new Error('The OpenCode server stopped unexpectedly.'),
          });
          this.finishTurn(session, 'The OpenCode server stopped unexpectedly.');
        }
        break;
    }
  }

  private ensureStep(session: ActiveOpenCodeSession, messageId: string): StepAccumulator {
    let step = session.steps.get(messageId);
    if (!step) {
      step = { uuid: uuidv4(), text: new Map(), reasoning: new Map() };
      session.steps.set(messageId, step);
    }
    return step;
  }

  private handleTextEvent(session: ActiveOpenCodeSession, type: string, data: Record<string, unknown>): void {
    const step = this.ensureStep(session, getString(data.assistantMessageID));
    const ordinal = getNumber(data.ordinal) ?? 0;
    const reasoning = type.startsWith('session.reasoning.');
    const parts = reasoning ? step.reasoning : step.text;
    if (type.endsWith('.ended')) {
      // The ended text is authoritative (deltas can be lost across a stream reconnect).
      parts.set(ordinal, getString(data.text) || parts.get(ordinal) || '');
      return;
    }
    const delta = getString(data.delta);
    if (!delta) return;
    parts.set(ordinal, (parts.get(ordinal) || '') + delta);
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: reasoning ? { type: 'thinking_delta', thinking: delta } : { type: 'text_delta', text: delta },
        },
      },
    });
  }

  /**
   * Commits the step's text so far as an assistant message. Runs before each
   * tool call so text and tool cards keep the order the model produced them.
   */
  private flushStep(session: ActiveOpenCodeSession, messageId: string): void {
    const step = session.steps.get(messageId);
    if (!step) return;
    const reasoning = joinOrdinals(step.reasoning);
    const text = joinOrdinals(step.text);
    step.reasoning = new Map();
    step.text = new Map();
    const uuid = step.uuid;
    step.uuid = uuidv4();
    if (!reasoning && !text) return;

    const content: ContentBlock[] = [];
    if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
    if (text) content.push({ type: 'text', text });
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    });
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: { type: 'assistant', uuid, message: { content } },
    });
  }

  private emitToolUse(session: ActiveOpenCodeSession, toolId: string, input: Record<string, unknown>): void {
    if (!toolId || session.emittedToolCallIds.has(toolId)) return;
    session.emittedToolCallIds.add(toolId);
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'assistant',
        uuid: uuidv4(),
        message: {
          content: [{ type: 'tool_use', id: toolId, name: inferToolName(session.toolNames.get(toolId) || ''), input }],
        },
      },
    });
  }

  private emitToolResult(session: ActiveOpenCodeSession, toolId: string, output: string, isError: boolean): void {
    if (!toolId || session.emittedToolResultIds.has(toolId)) return;
    if (!session.emittedToolCallIds.has(toolId)) this.emitToolUse(session, toolId, {});
    session.emittedToolResultIds.add(toolId);
    this.emit({
      type: 'message',
      threadId: session.threadId,
      message: {
        type: 'user',
        uuid: uuidv4(),
        message: {
          content: [{ type: 'tool_result', tool_use_id: toolId, content: output, is_error: isError }],
        },
      },
    });
  }

  private finishTurn(session: ActiveOpenCodeSession, errorMessage: string | null): void {
    for (const messageId of session.steps.keys()) this.flushStep(session, messageId);
    session.steps.clear();
    const turn = session.turn;
    session.turn = null;
    if (!turn) return;

    const tokens = turn.tokens;
    const usage: Usage = tokens
      ? {
          input_tokens: tokens.input || 0,
          output_tokens: tokens.output || 0,
          reasoning_output_tokens: tokens.reasoning || 0,
          cache_read_input_tokens: tokens.cache?.read || 0,
          cache_creation_input_tokens: tokens.cache?.write || 0,
        }
      : { input_tokens: 0, output_tokens: 0 };
    const limits = turn.model ? this.modelLimits.get(turn.model) : undefined;
    if (tokens && limits?.contextWindow) {
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
      subtype: errorMessage || turn.error ? 'error' : 'success',
      duration_ms: Math.max(0, Date.now() - turn.startedAt),
      total_cost_usd: validUsd(turn.cost) ? turn.cost : 0,
      costSource: validUsd(turn.cost) ? 'reported' : 'unavailable',
      usage,
      ...(turn.model ? { model: turn.model } : {}),
    };
    session.status = 'completed';
    this.emit({ type: 'message', threadId: session.threadId, message });
    this.emit({ type: 'status_change', threadId: session.threadId, status: 'completed' });
  }

  private handlePermissionAsked(session: ActiveOpenCodeSession, data: Record<string, unknown>): void {
    const permissionId = getString(data.id);
    if (!permissionId || session.emittedRequestIds.has(permissionId)) {
      return;
    }
    session.emittedRequestIds.add(permissionId);
    session.pendingRequests.set(permissionId, { kind: 'permission' });

    const action = getString(data.action) || 'perform an action';
    const resources = describeResources(data.resources);
    const title = getString(data.message) ||
      (resources ? `OpenCode wants to ${action}: ${resources}` : `OpenCode wants to ${action}`);
    const sourceToolName = session.toolNames.get(getString(getRecord(data.source)?.id));
    const toolName = inferToolName(sourceToolName || action);
    const input: AcpPermissionInput = {
      kind: 'acp-permission',
      provider: 'opencode',
      question: title,
      title,
      toolName,
      options: buildPermissionOptions(),
      toolCall: {
        action,
        resources: data.resources,
        save: data.save,
        metadata: data.metadata,
        source: data.source,
      },
    };

    const projectDirectory = isProjectDirectoryApproval(session.threadId, session.cwd, data.action, data.resources);
    if (session.permissionMode === 'fullAccess' || projectDirectory) {
      // Approve this request only: an "always" reply would save a permanent
      // OpenCode allow rule. Native deny rules and Plan still apply.
      void this.manager.getClient()
        .then((client) => client.replyPermission(session.providerSessionId, permissionId, 'once'))
        .then(() => {
          session.pendingRequests.delete(permissionId);
        })
        .catch((error) => {
          console.warn('[OpenCodeSdkAdapter] automatic permission reply failed:', error);
          if (!session.pendingRequests.has(permissionId)) return;
          this.emit({ type: 'permission_request', threadId: session.threadId,
            requestId: permissionId, toolName, input });
        });
      return;
    }

    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId: permissionId,
      toolName,
      input,
    });
  }

  private handleFormCreated(session: ActiveOpenCodeSession, form: Record<string, unknown> | null): void {
    const formId = getString(form?.id);
    if (!formId || session.emittedRequestIds.has(formId)) {
      return;
    }
    const built = buildOpenCodeFormQuestions(form);
    if (!built) {
      return;
    }
    session.emittedRequestIds.add(formId);
    session.pendingRequests.set(formId, { kind: 'form', fields: built.fields });
    this.emit({
      type: 'permission_request',
      threadId: session.threadId,
      requestId: formId,
      toolName: 'AskUserQuestion',
      input: built.input,
    });
  }

  /** A request settled elsewhere (another OpenCode client, or a timeout). */
  private dismissRequest(session: ActiveOpenCodeSession, requestId: string): void {
    if (!requestId || !session.pendingRequests.delete(requestId)) return;
    this.emit({ type: 'permission_dismissed', threadId: session.threadId, requestId });
  }

  private async emitMcpStatus(session: ActiveOpenCodeSession, client: OpenCodeClient): Promise<void> {
    try {
      const servers = (await client.listMcpServers(session.cwd)).map((server) => {
        const error = getString(getRecord(server.status)?.error);
        return {
          name: server.name,
          status: mapMcpStatus(server.status),
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

  private async emitAvailableCommands(session: ActiveOpenCodeSession, client: OpenCodeClient): Promise<void> {
    const commands: AvailableCommand[] = [COMPACT_COMMAND];
    try {
      for (const command of await client.listCommands(session.cwd)) {
        const name = getString(command.name).replace(/^\//, '').trim().toLowerCase();
        if (!name || name === COMPACT_COMMAND.name) continue;
        commands.push({ name, description: getString(command.description) || 'OpenCode slash command' });
      }
    } catch (error) {
      console.warn('[OpenCodeSdkAdapter] failed to list commands:', error);
    }
    session.availableCommands = new Set(commands.map((command) => command.name));
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

  private async refreshModelLimits(cwd: string): Promise<void> {
    try {
      const { models, defaultModel } = await this.manager.loadModels(cwd);
      // The configured default can come from a provider the listing omits.
      for (const model of defaultModel ? [...models, defaultModel] : models) {
        const contextWindow = getNumber(model.limit?.context) || 0;
        if (contextWindow <= 0) continue;
        this.modelLimits.set(`${model.providerID}/${model.modelID}`, {
          contextWindow,
          outputLimit: getNumber(model.limit?.output) || 0,
        });
      }
    } catch (error) {
      console.warn('[OpenCodeSdkAdapter] failed to read model limits:', error);
    }
  }

  private emit(event: ProviderRuntimeEvent): void {
    if (event.type === 'error' ||
        (event.type === 'status_change' && ['completed', 'stopped', 'error'].includes(event.status)) ||
        (event.type === 'message' && event.message.type === 'result')) {
      const session = this.sessions.get(event.threadId);
      if (session) this.compactions.interrupt(session);
    }
    this.events.emit('event', event);
  }
}
