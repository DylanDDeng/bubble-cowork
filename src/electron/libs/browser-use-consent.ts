// Browser-use HTTP-caller attribution + navigation consent routing.
//
// An HTTP MCP call carries no session identity. Attribution follows the
// delegate-service pattern: scan running sessions' transcripts for a PENDING
// browser_use tool_use whose input matches the incoming action, and route
// consent to that session's permission pipeline. The host (ipc-handlers)
// supplies transcript access, the running-session list, and the permission
// request channel — the same shape DelegateHost uses.

import type { StreamMessage } from '../../shared/types';
import { resolveBrowserUsePolicy } from './browser-use-permissions';

export const BROWSER_USE_TOOL_NAME = 'browser_use';

/**
 * Sessions whose permission mode is bypassPermissions (Full Access): their
 * browser navigation needs NO consent card — the user already granted the
 * broadest permission, asking again is double-confirmation (Codex parity:
 * full-access sessions run browser use silently).
 */
const fullAccessSessions = new Set<string>();

export function setBrowserUseSessionFullAccess(sessionId: string, fullAccess: boolean): void {
  if (fullAccess) fullAccessSessions.add(sessionId);
  else fullAccessSessions.delete(sessionId);
}

export function isBrowserUseSessionFullAccess(sessionId: string): boolean {
  return fullAccessSessions.has(sessionId);
}

/** Loopback origins never need a card (local dev pages, health checks). */
function isLoopbackOrigin(origin: string): boolean {
  return origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost') || origin.startsWith('http://[::1]');
}

export interface BrowserUseConsentHost {
  getSessionHistory(sessionId: string): StreamMessage[];
  /** Session ids with a live runner, for attribution scans. */
  listRunningSessionIds(): string[];
  /** True when the session's permission mode is a full-access variant
   * (claude bypassPermissions / codex bypassPermissions / equivalent). */
  isSessionFullAccess(sessionId: string): boolean;
  /**
   * Ask navigation consent through the session's permission card. Returns
   * true when the user allowed the origin.
   */
  requestPermission(
    sessionId: string,
    question: string,
    url: string,
    signal?: AbortSignal
  ): Promise<boolean>;
}

let host: BrowserUseConsentHost | null = null;

export function initializeBrowserUseConsent(nextHost: BrowserUseConsentHost): void {
  host = nextHost;
}

/** Per-session origins approved this app run (turn-scoped memory). */
const approvedOrigins = new Map<string, Set<string>>();

export function rememberBrowserUseApproval(sessionId: string, origin: string): void {
  let set = approvedOrigins.get(sessionId);
  if (!set) {
    set = new Set();
    approvedOrigins.set(sessionId, set);
  }
  set.add(origin);
}

export function forgetBrowserUseApprovals(sessionId: string): void {
  approvedOrigins.delete(sessionId);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function isBrowserUseToolName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  return (
    normalized === BROWSER_USE_TOOL_NAME ||
    normalized.endsWith(`__${BROWSER_USE_TOOL_NAME}`) ||
    // OpenCode composes server.tool with a dot; Codex with double underscore.
    normalized.endsWith(`.${BROWSER_USE_TOOL_NAME}`) ||
    normalized === `mcp__aegis-browser__${BROWSER_USE_TOOL_NAME}`
  );
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
 * Match the pending browser_use tool_use whose action (+ identifying args)
 * equals the incoming HTTP call. Same algorithm as the delegate scan: walk
 * the transcript, collect matching tool_use ids, drop resolved ones, take
 * the latest.
 */
export function findPendingBrowserUseSessionId(
  args: { action?: string; url?: string },
  history: StreamMessage[]
): string | null {
  const resolved = new Set<string>();
  const candidates: string[] = [];
  for (const message of history) {
    if (message.parentToolUseId) continue;
    if (message.type === 'assistant') {
      for (const block of contentBlocksOf(message)) {
        if (block.type !== 'tool_use' || !isBrowserUseToolName(block.name)) continue;
        const input = asRecord(block.input);
        if (!input) continue;
        if (input.action !== args.action) continue;
        // Navigate is the consent-gated action; match on url so two sessions
        // navigating concurrently attribute correctly.
        if (args.action === 'navigate' && input.url !== args.url) continue;
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
  if (!candidates.length) return null;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (!resolved.has(candidates[i])) return candidates[i];
  }
  return null;
}

/**
 * Resolve which running session made this HTTP browser_use call. Waits
 * (delegate-service attribution pattern: poll until deadline) for the
 * matching tool_use to land in a running session's transcript — the HTTP
 * request can beat the runner's event loop. Claimed ids are remembered so
 * two concurrent identical calls cannot double-claim one pending block.
 */
const ATTRIBUTION_POLL_MS = 250;
const ATTRIBUTION_TIMEOUT_MS = 5_000;
const claimedToolUseIds = new Set<string>();
const CLAIM_TTL_MS = 2 * 60_000;

export function findBrowserUseCallerSessionId(
  args: { action?: string; url?: string },
  signal?: AbortSignal
): Promise<string | null> {
  const deadline = Date.now() + ATTRIBUTION_TIMEOUT_MS;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (sessionId: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(sessionId);
    };
    const onAbort = () => finish(null);
    const attempt = () => {
      if (signal?.aborted) {
        finish(null);
        return;
      }
      if (!host) {
        finish(null);
        return;
      }
      for (const sessionId of host.listRunningSessionIds()) {
        const history = host.getSessionHistory(sessionId);
        if (!history?.length) continue;
        const toolUseId = findPendingBrowserUseSessionId(args, history);
        if (toolUseId && !claimedToolUseIds.has(toolUseId)) {
          claimedToolUseIds.add(toolUseId);
          const claimTimer = setTimeout(() => claimedToolUseIds.delete(toolUseId), CLAIM_TTL_MS);
          claimTimer.unref?.();
          finish(sessionId);
          return;
        }
      }
      if (Date.now() >= deadline) {
        finish(null);
        return;
      }
      timer = setTimeout(attempt, ATTRIBUTION_POLL_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    attempt();
  });
}

/** Ask navigation consent: persisted policy first, then the permission card.
 * Full-access sessions and loopback origins skip the card entirely. */
export async function requestBrowserUseNavigationConsent(
  sessionId: string,
  url: string,
  signal?: AbortSignal
): Promise<boolean> {
  const origin = originOf(url);
  if (!origin) return false;
  if (
    isBrowserUseSessionFullAccess(sessionId) ||
    (host?.isSessionFullAccess(sessionId) ?? false) ||
    isLoopbackOrigin(origin)
  ) {
    return true;
  }
  if (approvedOrigins.get(sessionId)?.has(origin)) return true;
  const policy = resolveBrowserUsePolicy(url);
  if (policy === 'allow') {
    rememberBrowserUseApproval(sessionId, origin);
    return true;
  }
  if (policy === 'block') return false;
  if (!host) return false;
  const allowed = await host.requestPermission(
    sessionId,
    `Allow the agent to open ${origin} in the session browser?`,
    url,
    signal
  );
  if (allowed) rememberBrowserUseApproval(sessionId, origin);
  return allowed;
}
