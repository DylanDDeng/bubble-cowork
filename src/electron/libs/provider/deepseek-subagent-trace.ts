/**
 * Attribute DeepSeek Harness child-session activity onto the spawning
 * `subagent` tool_use id so Aegis can reuse the Claude/Codex nested trace UI.
 *
 * The SDK `subagent.started` payload has no parentToolCallId. Pairing is
 * therefore fail-closed: bind only when exactly one unmatched spawn can claim
 * the child (lone pending spawn, or a unique description/prompt fingerprint).
 * Parallel siblings with identical empty fingerprints stay unbound rather than
 * being FIFO-misfiled.
 */

export interface DeepseekPendingSpawn {
  displayId: string;
  rawCallId: string;
  parentSessionId: string;
  label: string;
  prompt: string;
}

export interface DeepseekChildHint {
  label: string;
  prompt: string;
}

export interface DeepseekSubagentRuntime {
  /** childSessionId → namespaced parent tool_use id, once uniquely bound. */
  parents: Map<string, string>;
  /** childSessionId → spawning parent session id (set on started, before bind). */
  lineage: Map<string, string>;
  /** parentSessionId → unmatched spawn tool calls. */
  pendingByParent: Map<string, DeepseekPendingSpawn[]>;
  /** parentSessionId → child session ids waiting for a unique spawn. */
  waitingByParent: Map<string, string[]>;
  /** childSessionId → description/prompt hints gathered from the child log. */
  hints: Map<string, DeepseekChildHint>;
}

export function createDeepseekSubagentRuntime(): DeepseekSubagentRuntime {
  return {
    parents: new Map(),
    lineage: new Map(),
    pendingByParent: new Map(),
    waitingByParent: new Map(),
    hints: new Map(),
  };
}

export function isDeepseekSubagentToolName(name: string): boolean {
  return name.trim().toLowerCase() === 'subagent';
}

export function namespaceDeepseekToolId(sessionId: string, rawCallId: string): string {
  return `${sessionId}:${rawCallId}`;
}

export function spawnFromToolInput(
  parentSessionId: string,
  rawCallId: string,
  input: Record<string, unknown>
): DeepseekPendingSpawn {
  return {
    displayId: namespaceDeepseekToolId(parentSessionId, rawCallId),
    rawCallId,
    parentSessionId,
    label: readTrimmed(input.description),
    prompt: readTrimmed(input.prompt),
  };
}

export function registerDeepseekSpawn(
  state: DeepseekSubagentRuntime,
  spawn: DeepseekPendingSpawn
): string | null {
  if (state.parents.has(spawn.displayId)) {
    return null;
  }
  const pending = state.pendingByParent.get(spawn.parentSessionId) ?? [];
  if (pending.some((entry) => entry.displayId === spawn.displayId)) {
    return tryBindWaitingChildren(state, spawn.parentSessionId);
  }
  pending.push(spawn);
  state.pendingByParent.set(spawn.parentSessionId, pending);
  return tryBindWaitingChildren(state, spawn.parentSessionId);
}

export function registerDeepseekStarted(
  state: DeepseekSubagentRuntime,
  parentSessionId: string,
  childSessionId: string
): string | null {
  if (!parentSessionId || !childSessionId) return null;
  if (state.parents.has(childSessionId)) {
    return state.parents.get(childSessionId) ?? null;
  }
  state.lineage.set(childSessionId, parentSessionId);
  const waiting = state.waitingByParent.get(parentSessionId) ?? [];
  if (!waiting.includes(childSessionId)) {
    waiting.push(childSessionId);
    state.waitingByParent.set(parentSessionId, waiting);
  }
  return tryBindWaitingChildren(state, parentSessionId);
}

export function registerDeepseekChildHint(
  state: DeepseekSubagentRuntime,
  childSessionId: string,
  hint: Partial<DeepseekChildHint>
): string | null {
  const current = state.hints.get(childSessionId) ?? { label: '', prompt: '' };
  const next: DeepseekChildHint = {
    label: hint.label?.trim() || current.label,
    prompt: hint.prompt?.trim() || current.prompt,
  };
  state.hints.set(childSessionId, next);
  if (state.parents.has(childSessionId)) {
    return state.parents.get(childSessionId) ?? null;
  }
  const parentSessionId = state.lineage.get(childSessionId);
  if (!parentSessionId) return null;
  return tryBindWaitingChildren(state, parentSessionId);
}

function tryBindWaitingChildren(
  state: DeepseekSubagentRuntime,
  parentSessionId: string
): string | null {
  const waiting = state.waitingByParent.get(parentSessionId) ?? [];
  const pending = state.pendingByParent.get(parentSessionId) ?? [];
  let lastBound: string | null = null;

  if (waiting.length === 1 && pending.length === 1) {
    lastBound = bindChild(state, waiting[0], pending[0]);
    return lastBound;
  }

  for (const childSessionId of [...waiting]) {
    if (state.parents.has(childSessionId)) continue;
    const hint = state.hints.get(childSessionId);
    const spawn = findUniqueSpawn(pending.filter((entry) => !isSpawnBound(state, entry)), (entry) => {
      if (hint?.label && entry.label && hint.label === entry.label) return true;
      if (hint?.prompt && entry.prompt && hint.prompt === entry.prompt) return true;
      return false;
    });
    if (!spawn) continue;
    lastBound = bindChild(state, childSessionId, spawn) ?? lastBound;
  }
  return lastBound;
}

function findUniqueSpawn(
  pending: DeepseekPendingSpawn[],
  predicate: (spawn: DeepseekPendingSpawn) => boolean
): DeepseekPendingSpawn | undefined {
  const matches = pending.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function isSpawnBound(state: DeepseekSubagentRuntime, spawn: DeepseekPendingSpawn): boolean {
  for (const displayId of state.parents.values()) {
    if (displayId === spawn.displayId) return true;
  }
  return false;
}

function bindChild(
  state: DeepseekSubagentRuntime,
  childSessionId: string,
  spawn: DeepseekPendingSpawn
): string | null {
  if (state.parents.has(childSessionId)) {
    return state.parents.get(childSessionId) ?? null;
  }
  state.parents.set(childSessionId, spawn.displayId);
  const pending = (state.pendingByParent.get(spawn.parentSessionId) ?? []).filter(
    (entry) => entry.displayId !== spawn.displayId
  );
  if (pending.length > 0) {
    state.pendingByParent.set(spawn.parentSessionId, pending);
  } else {
    state.pendingByParent.delete(spawn.parentSessionId);
  }
  const waiting = (state.waitingByParent.get(spawn.parentSessionId) ?? []).filter(
    (id) => id !== childSessionId
  );
  if (waiting.length > 0) {
    state.waitingByParent.set(spawn.parentSessionId, waiting);
  } else {
    state.waitingByParent.delete(spawn.parentSessionId);
  }
  return spawn.displayId;
}

function readTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
