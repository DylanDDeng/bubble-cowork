/**
 * Lightweight latency instrumentation for Claude turns (P0c of the
 * streaming/cold-start optimization).
 *
 * Measures, per session, the wall-clock time from a prompt dispatch to:
 *   - the CLI's `system:init` message (spawn + settings + MCP boot, first
 *     turn only — warm reuse never re-emits init), and
 *   - the first visible output (first stream delta or assistant message).
 *
 * Only the FIRST dispatch of a measurement window is tracked: queued
 * follow-up prompts on a busy runner share the stream, so attributing init /
 * first-output to them would lie. A new dispatch after the window closed
 * starts a fresh window.
 */

export type ClaudeDispatchMode = 'cold-start' | 'warm-reuse' | 'prewarm-hit';

interface PendingMeasurement {
  mode: ClaudeDispatchMode;
  hasResume: boolean;
  dispatchedAt: number;
  initLoggedAt?: number;
  firstOutputLoggedAt?: number;
}

const pending = new Map<string, PendingMeasurement>();

function log(sessionId: string, entry: PendingMeasurement, phase: 'init' | 'first-output', elapsedMs: number): void {
  console.log(
    `[ClaudeLatency] ${phase} +${elapsedMs}ms (mode=${entry.mode}${entry.hasResume ? ', resume' : ''}, session=${sessionId.slice(0, 8)})`
  );
}

export function markClaudePromptDispatched(
  sessionId: string,
  mode: ClaudeDispatchMode,
  hasResume: boolean
): void {
  const existing = pending.get(sessionId);
  // A window still waiting for first output belongs to an earlier prompt on
  // the same live stream — don't clobber its dispatch anchor.
  if (existing && existing.firstOutputLoggedAt === undefined) {
    return;
  }
  pending.set(sessionId, { mode, hasResume, dispatchedAt: Date.now() });
}

export function markClaudeInit(sessionId: string): void {
  const entry = pending.get(sessionId);
  if (!entry || entry.initLoggedAt !== undefined) {
    return;
  }
  entry.initLoggedAt = Date.now();
  log(sessionId, entry, 'init', entry.initLoggedAt - entry.dispatchedAt);
}

export function markClaudeFirstOutput(sessionId: string): void {
  const entry = pending.get(sessionId);
  if (!entry || entry.firstOutputLoggedAt !== undefined) {
    return;
  }
  entry.firstOutputLoggedAt = Date.now();
  log(sessionId, entry, 'first-output', entry.firstOutputLoggedAt - entry.dispatchedAt);
}

export function clearClaudeTurnMetrics(sessionId: string): void {
  pending.delete(sessionId);
}
