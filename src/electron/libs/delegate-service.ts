// Cross-agent delegation core (docs/delegate-mcp-plan.md).
//
// The lead agent of a session calls the `delegate_task` MCP tool; this module
// runs the target agent in a hidden execution session and mirrors its message
// stream into the parent session's transcript tagged with `parentToolUseId`,
// so the renderer reuses the existing SubagentPanel/capsule machinery
// unchanged. Transport-agnostic: the Claude in-process server and the
// loopback HTTP server both funnel into `runDelegateTask`.
//
// The host (ipc-handlers) is injected at startup — this module never imports
// ipc-handlers, so the logic stays testable with a fake host.

import { randomUUID } from 'crypto';
import type { AgentProvider, SessionStartPayload, StreamMessage } from '../../shared/types';
import type { SessionRow } from '../types';

export const DELEGATE_MCP_SERVER_NAME = 'aegis-delegate';
export const DELEGATE_TOOL_NAME = 'delegate_task';

export const DELEGATE_TARGET_PROVIDERS: AgentProvider[] = [
  'claude',
  'codex',
  'opencode',
  'kimi',
  'grok',
  'pi',
  'qoder',
  'bubble',
];

const DELEGATE_TIMEOUT_MS = Number(process.env.AEGIS_DELEGATE_TIMEOUT_MS || '') || 30 * 60 * 1000;
const COMPLETION_POLL_MS = 500;
const ATTRIBUTION_RETRY_MS = 10_000;
const ATTRIBUTION_POLL_MS = 250;
const SUMMARY_TEXT_LIMIT = 6_000;
const SUMMARY_FILE_LIMIT = 50;
// Accumulator bound for the trailing text run (keep the tail — the verdict
// of a long answer lives at the end).
const FINAL_TEXT_RUN_LIMIT = 24_000;

export interface DelegateAgentModel {
  id: string;
  label?: string | null;
}

export interface DelegateHost {
  startSession(payload: SessionStartPayload): Promise<string | null>;
  stopSession(sessionId: string): void;
  getSession(sessionId: string): SessionRow | null;
  getSessionHistory(sessionId: string): StreamMessage[];
  /** Session ids with a live runner, for HTTP-caller attribution scans. */
  listRunningSessionIds(): string[];
  /** Persist into the session's transcript AND broadcast to the renderer. */
  addMessageToSession(sessionId: string, message: StreamMessage): void;
  /**
   * The target agent's installed model catalog, for fuzzy model resolution.
   * Empty/absent = no catalog known → requested models pass through as-is.
   */
  listAgentModels?(agent: AgentProvider): Promise<DelegateAgentModel[]>;
}

export interface DelegateTaskRequest {
  agent: string;
  prompt: string;
  description?: string;
  /**
   * Model / reasoning effort for the delegated agent. Open strings on
   * purpose — valid sets are provider- and version-specific (codex models
   * and effort tiers come from its models_cache); never whitelist here.
   * Unset = the target agent's own default.
   */
  model?: string;
  reasoningEffort?: string;
  /**
   * The session the call came from, when the transport knows it (Claude
   * in-process closure). HTTP callers leave it null and rely on the
   * pending-tool-call attribution scan.
   */
  callerSessionId?: string | null;
}

export interface DelegateTaskResult {
  ok: boolean;
  status: 'completed' | 'error' | 'timeout' | 'rejected';
  agent?: AgentProvider;
  summary: string;
}

export interface DelegateExecution {
  execSessionId: string | null;
  parentSessionId: string;
  parentToolUseId: string;
  agent: AgentProvider;
  startedAt: number;
  /**
   * The trailing run of text-only assistant messages — providers (kimi/ACP
   * especially) commit one logical final answer as SEVERAL assistant
   * messages, so "the last message" alone is a mid-sentence fragment. Reset
   * whenever a tool_use message arrives (text before tool work is narration,
   * not the answer).
   */
  finalTextRun: string;
  /** Most recent non-empty text, kept as a fallback for runs that end on a tool call. */
  lastAssistantText: string;
  changedFiles: Set<string>;
  mirroredCount: number;
  settled: boolean;
  /** Model the lead asked for (tool param), if any. */
  requestedModel: string | null;
  reasoningEffort: string | null;
  /** Effective model reported by the child runtime's system init. */
  actualModel: string | null;
  /** Last error text from the child (runner error / error result), for the summary. */
  errorText: string | null;
}

let host: DelegateHost | null = null;

const executionsByExecSession = new Map<string, DelegateExecution>();
const activeParentCounts = new Map<string, number>();
const claimedToolUseIds = new Set<string>();

export function initializeDelegateService(nextHost: DelegateHost): void {
  host = nextHost;
}

export function isDelegateExecutionSession(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && executionsByExecSession.has(sessionId));
}

export function getDelegateMirrorTarget(
  execSessionId: string
): { parentSessionId: string; parentToolUseId: string; agent: AgentProvider } | null {
  const exec = executionsByExecSession.get(execSessionId);
  if (!exec || exec.settled) return null;
  return {
    parentSessionId: exec.parentSessionId,
    parentToolUseId: exec.parentToolUseId,
    agent: exec.agent,
  };
}

export function hasActiveDelegationForParent(parentSessionId: string): boolean {
  return (activeParentCounts.get(parentSessionId) ?? 0) > 0;
}

/** Stop-cascade: stopping the parent stops every delegate runner under it. */
export function stopDelegationsForParent(parentSessionId: string): void {
  for (const exec of executionsByExecSession.values()) {
    if (exec.parentSessionId === parentSessionId && !exec.settled && exec.execSessionId) {
      try {
        host?.stopSession(exec.execSessionId);
      } catch (error) {
        console.warn('Failed to stop delegate execution:', error);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tool-call attribution
// ---------------------------------------------------------------------------

export function isDelegateToolUseName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  return normalized === DELEGATE_TOOL_NAME || normalized.endsWith(`__${DELEGATE_TOOL_NAME}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentBlocksOf(message: StreamMessage): Record<string, unknown>[] {
  const outer = asRecord((message as Record<string, unknown>).message);
  const content = outer?.content;
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((block): block is Record<string, unknown> => block !== null);
}

/**
 * Find the pending `delegate_task` tool_use in a session's transcript that
 * matches (agent + prompt) and has no tool_result yet. This is the shared
 * attribution mechanism: for Claude the caller session is known from the
 * closure and this only pins the anchoring tool_use id; for codex it also
 * decides which running session made the HTTP call.
 */
export function findPendingDelegateCall(
  history: StreamMessage[],
  match: { agent: string; prompt: string },
  claimed: ReadonlySet<string> = claimedToolUseIds
): string | null {
  const resolved = new Set<string>();
  const candidates: string[] = [];
  for (const message of history) {
    if (message.parentToolUseId) continue;
    if (message.type === 'assistant') {
      for (const block of contentBlocksOf(message)) {
        if (block.type !== 'tool_use' || !isDelegateToolUseName(block.name)) continue;
        const input = asRecord(block.input);
        if (!input) continue;
        if (input.agent !== match.agent || input.prompt !== match.prompt) continue;
        if (typeof block.id === 'string' && block.id) candidates.push(block.id);
      }
    } else if (message.type === 'user') {
      for (const block of contentBlocksOf(message)) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          resolved.add(block.tool_use_id);
        }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const id = candidates[i];
    if (!resolved.has(id) && !claimed.has(id)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Permission inheritance (decided: child inherits the parent's mode directly)
// ---------------------------------------------------------------------------

export type DelegatePermissionTier = 'safe' | 'autoEdit' | 'full';

export function resolveParentPermissionTier(row: SessionRow | null): DelegatePermissionTier {
  if (!row) return 'safe';
  const provider = (row.provider || 'claude') as AgentProvider;
  if (provider === 'claude') {
    const mode = row.claude_access_mode || 'default';
    if (mode === 'bypassPermissions' || mode === 'fullAccess') return 'full';
    if (mode === 'acceptEdits') return 'autoEdit';
    return 'safe';
  }
  if (provider === 'codex') {
    const mode = row.codex_permission_mode || 'defaultPermissions';
    if (mode === 'fullAccess') return 'full';
    if (mode === 'auto') return 'autoEdit';
    return 'safe';
  }
  if (provider === 'opencode') {
    return row.opencode_permission_mode === 'fullAccess' ? 'full' : 'safe';
  }
  // kimi/grok/qoder/bubble modes are not persisted on the session row; those
  // providers are not v1 leads, so default to the safe tier.
  return 'safe';
}

export function applyPermissionTier(
  payload: SessionStartPayload,
  agent: AgentProvider,
  tier: DelegatePermissionTier
): void {
  switch (agent) {
    case 'claude':
      payload.claudeAccessMode =
        tier === 'full' ? 'bypassPermissions' : tier === 'autoEdit' ? 'acceptEdits' : 'default';
      payload.claudeExecutionMode = 'execute';
      break;
    case 'codex':
      payload.codexPermissionMode =
        tier === 'full' ? 'fullAccess' : tier === 'autoEdit' ? 'auto' : 'defaultPermissions';
      payload.codexExecutionMode = 'execute';
      break;
    case 'kimi':
      payload.kimiPermissionMode = tier === 'full' ? 'yolo' : tier === 'autoEdit' ? 'auto' : 'default';
      break;
    case 'grok':
      payload.grokPermissionMode = tier === 'full' ? 'yolo' : tier === 'autoEdit' ? 'auto' : 'default';
      break;
    case 'opencode':
      payload.opencodePermissionMode = tier === 'full' ? 'fullAccess' : 'defaultPermissions';
      break;
    case 'qoder':
      payload.qoderPermissionMode =
        tier === 'full' ? 'bypassPermissions' : tier === 'autoEdit' ? 'acceptEdits' : 'default';
      break;
    case 'bubble':
      payload.bubblePermissionMode = tier === 'full' ? 'bypassPermissions' : 'default';
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Fuzzy model resolution
// ---------------------------------------------------------------------------

function modelTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter(Boolean)
  );
}

export interface DelegateModelResolution {
  id: string | null;
  /** Set when several catalog entries matched equally well. */
  ambiguous?: string[];
}

/**
 * Resolve a user/lead-worded model ("kimi code k3 thinking", "gpt 5.6 sol")
 * against the target agent's real catalog. Token-overlap scoring, no
 * hardcoded names: exact id match wins; otherwise the candidate sharing the
 * most tokens with the request (id + display label) wins if it is a UNIQUE
 * best; ties surface as ambiguous so the lead can pick precisely.
 */
export function resolveDelegateModelId(
  requested: string,
  candidates: DelegateAgentModel[]
): DelegateModelResolution {
  const trimmed = requested.trim();
  if (!trimmed || candidates.length === 0) return { id: trimmed || null };
  const exact = candidates.find((c) => c.id.toLowerCase() === trimmed.toLowerCase());
  if (exact) return { id: exact.id };

  const requestedTokens = modelTokens(trimmed);
  let best: Array<{ id: string; score: number; coverage: number }> = [];
  for (const candidate of candidates) {
    const tokens = modelTokens(`${candidate.id} ${candidate.label ?? ''}`);
    let score = 0;
    for (const token of requestedTokens) if (tokens.has(token)) score += 1;
    if (score === 0) continue;
    const coverage = score / tokens.size;
    best.push({ id: candidate.id, score, coverage });
  }
  if (best.length === 0) return { id: null };
  best.sort((a, b) => b.score - a.score || b.coverage - a.coverage);
  const top = best[0];
  const rivals = best.filter(
    (entry) => entry.score === top.score && entry.coverage === top.coverage
  );
  if (rivals.length > 1) return { id: null, ambiguous: rivals.map((entry) => entry.id) };
  return { id: top.id };
}

/**
 * Route the requested reasoning effort to the target provider's payload
 * field. The value stays an open string — each runtime validates its own
 * tiers; providers without an effort knob ignore it.
 */
export function applyReasoningEffort(
  payload: SessionStartPayload,
  agent: AgentProvider,
  effort: string
): void {
  if (!effort) return;
  switch (agent) {
    case 'claude':
      payload.claudeReasoningEffort = effort as SessionStartPayload['claudeReasoningEffort'];
      break;
    case 'codex':
      payload.codexReasoningEffort = effort;
      break;
    case 'grok':
      payload.grokReasoningEffort = effort as SessionStartPayload['grokReasoningEffort'];
      break;
    case 'kimi':
      payload.kimiThinking = effort;
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Mirror pipeline
// ---------------------------------------------------------------------------

function extractAssistantTextBlocks(message: StreamMessage): string {
  const parts: string[] = [];
  for (const block of contentBlocksOf(message)) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function collectChangedFiles(message: StreamMessage, into: Set<string>): void {
  for (const block of contentBlocksOf(message)) {
    if (block.type !== 'tool_use') continue;
    const input = asRecord(block.input);
    if (!input) continue;
    const path = input.file_path ?? input.path ?? input.notebook_path;
    const name = typeof block.name === 'string' ? block.name.toLowerCase() : '';
    const isWriteTool =
      name.includes('edit') || name.includes('write') || name.includes('apply_patch') || name.includes('patch');
    if (isWriteTool && typeof path === 'string' && path) into.add(path);
  }
}

/**
 * Transform a hidden-execution-session message into its mirrored form for the
 * parent stream, or null when the message must not be mirrored. Only
 * assistant/user messages mirror — that is exactly what the subagent panel
 * machinery consumes; stream_events/system/result stay out entirely.
 *
 * Nesting: when the delegated agent spawns its OWN subagents, their messages
 * already carry that inner Task/Agent tool_use id — preserve it (clobbering
 * it would flatten the inner trace into the delegate's panel). The inner
 * spawn block itself is mirrored under the delegate anchor, so the grouping
 * chain anchor → inner block → inner messages stays intact and the existing
 * nested-lane UI works unchanged.
 */
export function transformDelegateMessage(
  exec: Pick<DelegateExecution, 'parentToolUseId' | 'agent'> &
    Partial<Pick<DelegateExecution, 'actualModel' | 'requestedModel'>>,
  message: StreamMessage
): StreamMessage | null {
  if (message.type !== 'assistant' && message.type !== 'user') return null;
  const innerParent =
    typeof message.parentToolUseId === 'string' && message.parentToolUseId
      ? message.parentToolUseId
      : null;
  return {
    ...message,
    parentToolUseId: innerParent ?? exec.parentToolUseId,
    sourceProvider: exec.agent,
    sourceModel: exec.actualModel || exec.requestedModel || null,
  } as StreamMessage;
}

/**
 * Entry point for the runner's onMessage path: returns true when the message
 * belonged to a delegate execution and was handled here (mirrored into the
 * parent or intentionally swallowed) — the caller must then skip its normal
 * persist/broadcast for it.
 */
export function mirrorDelegateMessage(execSessionId: string, message: StreamMessage): boolean {
  const exec = executionsByExecSession.get(execSessionId);
  if (!exec || exec.settled) return false;
  // The child runtime's init reports the model it actually resolved (e.g.
  // codex falling back to its config.toml default) — capture it so mirrored
  // messages and the panel header can show the real thing.
  if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
    const model = (message as { model?: unknown }).model;
    if (typeof model === 'string' && model.trim()) exec.actualModel = model.trim();
  }
  // Error results carry the only diagnostic the lead will ever see — losing
  // them leaves it retrying blind (observed: four attempts to land one
  // delegation because every summary said "produced no final text").
  if (message.type === 'result') {
    const record = message as { subtype?: string; is_error?: boolean; result?: unknown; error?: unknown };
    const failed = record.is_error === true || (record.subtype && record.subtype !== 'success');
    const text =
      typeof record.result === 'string' ? record.result :
      typeof record.error === 'string' ? record.error : '';
    if (failed && text.trim()) exec.errorText = text.trim();
  }
  // Inner-subagent messages (the delegated agent's own spawns) mirror with
  // their inner attribution preserved, but must not pollute the delegate's
  // final answer or changed-file collection — their outcomes surface through
  // the inner tool_result the top-level agent receives.
  if (message.type === 'assistant' && !message.parentToolUseId) {
    const text = extractAssistantTextBlocks(message);
    if (text) exec.lastAssistantText = text;
    const hasToolUse = contentBlocksOf(message).some((block) => block.type === 'tool_use');
    if (hasToolUse) {
      // Tool work after text means that text was narration — the final
      // answer is whatever trailing text run follows the LAST tool call.
      exec.finalTextRun = '';
      collectChangedFiles(message, exec.changedFiles);
    } else if (text) {
      exec.finalTextRun = exec.finalTextRun ? `${exec.finalTextRun}\n${text}` : text;
      if (exec.finalTextRun.length > FINAL_TEXT_RUN_LIMIT) {
        exec.finalTextRun = exec.finalTextRun.slice(-FINAL_TEXT_RUN_LIMIT);
      }
    }
  }
  const mirrored = transformDelegateMessage(exec, message);
  if (mirrored) {
    exec.mirroredCount += 1;
    try {
      host?.addMessageToSession(exec.parentSessionId, mirrored);
    } catch (error) {
      console.warn('Failed to mirror delegate message:', error);
    }
  }
  return true;
}

/**
 * Runner-level failures (spawn errors, API errors) never pass through the
 * message stream — ipc-handlers' onError reports them here so the summary
 * can tell the lead WHY the delegation failed.
 */
export function recordDelegateExecutionError(execSessionId: string, errorText: string): void {
  const exec = executionsByExecSession.get(execSessionId);
  if (exec && !exec.settled && errorText.trim()) exec.errorText = errorText.trim();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function buildDelegateSummary(exec: DelegateExecution, status: DelegateTaskResult['status']): string {
  const lines: string[] = [];
  if (status === 'timeout') {
    lines.push(`[${exec.agent}] delegate timed out after ${Math.round(DELEGATE_TIMEOUT_MS / 60000)} minutes; partial output below.`);
  } else if (status === 'error') {
    lines.push(`[${exec.agent}] delegate ended with an error; last output below.`);
  }
  if (status !== 'completed' && exec.errorText) {
    let errorText = exec.errorText;
    if (errorText.length > 1_000) errorText = `${errorText.slice(0, 1_000)}… [truncated]`;
    lines.push(`Error: ${errorText}`);
  }
  let text = exec.finalTextRun || exec.lastAssistantText || '(the delegated agent produced no final text)';
  if (text.length > SUMMARY_TEXT_LIMIT) {
    text = `${text.slice(0, SUMMARY_TEXT_LIMIT)}\n… [truncated]`;
  }
  lines.push(text);
  if (exec.changedFiles.size > 0) {
    const files = [...exec.changedFiles];
    const shown = files.slice(0, SUMMARY_FILE_LIMIT);
    lines.push('', `Files changed (${files.length}):`);
    for (const file of shown) lines.push(`- ${file}`);
    if (files.length > shown.length) lines.push(`- … and ${files.length - shown.length} more`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The tool itself
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejected(summary: string): DelegateTaskResult {
  return { ok: false, status: 'rejected', summary };
}

function bumpParent(parentSessionId: string, delta: number): void {
  const next = (activeParentCounts.get(parentSessionId) ?? 0) + delta;
  if (next > 0) activeParentCounts.set(parentSessionId, next);
  else activeParentCounts.delete(parentSessionId);
}

async function attributeCall(
  request: DelegateTaskRequest,
  activeHost: DelegateHost,
  timeoutMs: number
): Promise<{ parentSessionId: string; toolUseId: string } | null> {
  const deadline = Date.now() + timeoutMs;
  const match = { agent: request.agent, prompt: request.prompt };
  for (;;) {
    const candidates = request.callerSessionId
      ? [request.callerSessionId]
      : activeHost.listRunningSessionIds().filter((id) => !isDelegateExecutionSession(id));
    for (const sessionId of candidates) {
      try {
        const found = findPendingDelegateCall(activeHost.getSessionHistory(sessionId), match);
        if (found) return { parentSessionId: sessionId, toolUseId: found };
      } catch (error) {
        console.warn('Delegate attribution scan failed for session', sessionId, error);
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(ATTRIBUTION_POLL_MS);
  }
}

export async function runDelegateTask(
  request: DelegateTaskRequest,
  overrides?: { timeoutMs?: number; attributionTimeoutMs?: number }
): Promise<DelegateTaskResult> {
  const activeHost = host;
  if (!activeHost) return rejected('The delegate service is not available in this build.');

  const agent = String(request.agent || '').trim().toLowerCase() as AgentProvider;
  if (!DELEGATE_TARGET_PROVIDERS.includes(agent)) {
    return rejected(
      `Unknown agent "${request.agent}". Valid agents: ${DELEGATE_TARGET_PROVIDERS.join(', ')}.`
    );
  }
  const prompt = String(request.prompt || '').trim();
  if (!prompt) return rejected('The prompt must not be empty.');

  // Depth limit: one level, no chained delegation — enforced server-side
  // because singleton CLI daemons share one MCP connection across sessions.
  if (request.callerSessionId && isDelegateExecutionSession(request.callerSessionId)) {
    return rejected('Chained delegation is not allowed: a delegated agent cannot delegate further.');
  }

  const attribution = await attributeCall(
    { ...request, agent, prompt },
    activeHost,
    overrides?.attributionTimeoutMs ?? ATTRIBUTION_RETRY_MS
  );
  let parentSessionId: string;
  let toolUseId: string;
  if (attribution) {
    ({ parentSessionId, toolUseId } = attribution);
  } else if (request.callerSessionId) {
    // Claude closure knows the caller; a missed anchor only degrades the
    // capsule grouping, not the delegation itself.
    parentSessionId = request.callerSessionId;
    toolUseId = `delegate-${randomUUID()}`;
    console.warn('Delegate call could not find its anchoring tool_use; using a synthetic anchor.');
  } else {
    return rejected(
      'Could not attribute this delegate call to a running session. Retry the tool call.'
    );
  }
  if (isDelegateExecutionSession(parentSessionId)) {
    return rejected('Chained delegation is not allowed: a delegated agent cannot delegate further.');
  }

  const parentRow = activeHost.getSession(parentSessionId);
  if (!parentRow) return rejected('The calling session no longer exists.');

  let requestedModel = String(request.model || '').trim() || null;
  const reasoningEffort = String(request.reasoningEffort || '').trim() || null;

  // Fuzzy model resolution: leads pass the user's wording ("kimi code k3
  // thinking"); pin it to a real catalog id before starting the child, and
  // fail fast WITH the catalog when it can't be pinned — a blind pass-through
  // costs a whole failed child run per guess.
  if (requestedModel) {
    let candidates: DelegateAgentModel[] = [];
    try {
      candidates = (await activeHost.listAgentModels?.(agent)) ?? [];
    } catch (error) {
      console.warn('Delegate model catalog lookup failed for', agent, error);
    }
    if (candidates.length > 0) {
      const resolution = resolveDelegateModelId(requestedModel, candidates);
      const catalog = candidates
        .slice(0, 20)
        .map((c) => (c.label && c.label !== c.id ? `${c.id} (${c.label})` : c.id))
        .join(', ');
      if (resolution.ambiguous) {
        return rejected(
          `Model "${requestedModel}" is ambiguous for ${agent}: ${resolution.ambiguous.join(', ')}. Pick one exact id.`
        );
      }
      if (!resolution.id) {
        return rejected(
          `Unknown model "${requestedModel}" for ${agent}. Available models: ${catalog}. Retry with an exact id, or omit model to use the default.`
        );
      }
      requestedModel = resolution.id;
    }
  }

  claimedToolUseIds.add(toolUseId);
  const exec: DelegateExecution = {
    execSessionId: null,
    parentSessionId,
    parentToolUseId: toolUseId,
    agent,
    startedAt: Date.now(),
    finalTextRun: '',
    lastAssistantText: '',
    changedFiles: new Set(),
    mirroredCount: 0,
    settled: false,
    requestedModel,
    reasoningEffort,
    actualModel: null,
    errorText: null,
  };
  bumpParent(parentSessionId, 1);

  try {
    const payload: SessionStartPayload = {
      title: `Delegate → ${agent}`,
      prompt,
      cwd: parentRow.cwd ?? undefined,
      projectCwd: parentRow.project_cwd ?? undefined,
      worktreePath: parentRow.worktree_path ?? undefined,
      scope: (parentRow.conversation_scope as SessionStartPayload['scope']) ?? 'project',
      provider: agent,
      hiddenFromThreads: true,
      skipTitleGeneration: true,
      channelId: parentRow.workspace_channel_id ?? undefined,
    };
    if (requestedModel) payload.model = requestedModel;
    if (reasoningEffort) applyReasoningEffort(payload, agent, reasoningEffort);
    applyPermissionTier(payload, agent, resolveParentPermissionTier(parentRow));

    const execSessionId = await activeHost.startSession(payload);
    if (!execSessionId) {
      return { ok: false, status: 'error', agent, summary: 'Failed to start the delegated agent session.' };
    }
    exec.execSessionId = execSessionId;
    executionsByExecSession.set(execSessionId, exec);

    const timeoutMs = overrides?.timeoutMs ?? DELEGATE_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let finalStatus: DelegateTaskResult['status'] = 'completed';
    for (;;) {
      await sleep(COMPLETION_POLL_MS);
      const row = activeHost.getSession(execSessionId);
      if (!row) {
        finalStatus = 'error';
        break;
      }
      if (row.status !== 'running') {
        finalStatus = row.status === 'error' ? 'error' : 'completed';
        break;
      }
      if (Date.now() >= deadline) {
        try {
          activeHost.stopSession(execSessionId);
        } catch (error) {
          console.warn('Failed to stop timed-out delegate execution:', error);
        }
        finalStatus = 'timeout';
        break;
      }
    }
    return {
      ok: finalStatus === 'completed',
      status: finalStatus,
      agent,
      summary: buildDelegateSummary(exec, finalStatus),
    };
  } finally {
    exec.settled = true;
    if (exec.execSessionId) executionsByExecSession.delete(exec.execSessionId);
    claimedToolUseIds.delete(toolUseId);
    bumpParent(parentSessionId, -1);
  }
}

/** Test-only: reset module state between verify cases. */
export function __resetDelegateServiceForTests(): void {
  host = null;
  executionsByExecSession.clear();
  activeParentCounts.clear();
  claimedToolUseIds.clear();
}
