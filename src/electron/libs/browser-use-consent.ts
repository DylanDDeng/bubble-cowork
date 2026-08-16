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

export interface BrowserUseConsentHost {
  getSessionHistory(sessionId: string): StreamMessage[];
  /** Session ids with a live runner, for attribution scans. */
  listRunningSessionIds(): string[];
  /**
   * Ask navigation consent through the session's permission card. Returns
   * true when the user allowed the origin.
   */
  requestPermission(
    sessionId: string,
    question: string,
    url: string
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
    // Codex composes mcp__<server>__<tool>; the server is aegis-browser.
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
 * Resolve which running session made this HTTP browser_use call. Returns the
 * session id or null when no running session has a matching pending call.
 */
export function findBrowserUseCallerSessionId(
  args: { action?: string; url?: string }
): Promise<string | null> {
  if (!host) return Promise.resolve(null);
  for (const sessionId of host.listRunningSessionIds()) {
    const history = host.getSessionHistory(sessionId);
    if (!history?.length) continue;
    if (findPendingBrowserUseSessionId(args, history)) return Promise.resolve(sessionId);
  }
  return Promise.resolve(null);
}

/** Ask navigation consent: persisted policy first, then the permission card. */
export async function requestBrowserUseNavigationConsent(
  sessionId: string,
  url: string
): Promise<boolean> {
  const origin = originOf(url);
  if (!origin) return false;
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
    url
  );
  if (allowed) rememberBrowserUseApproval(sessionId, origin);
  return allowed;
}
