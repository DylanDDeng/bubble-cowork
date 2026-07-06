/**
 * Idle-reap policy for kept-alive Claude runners.
 *
 * Claude runners stay alive between turns so follow-up messages reuse the
 * live CLI process instead of paying a cold start + resume replay. This
 * module decides which idle runners to retire; it is pure (injectable clock,
 * plain data in/out) so the policy is unit-testable without Electron.
 */

export interface ClaudeRunnerSnapshot {
  sessionId: string;
  /** Turns dispatched into the runner that have not yet produced a `result`. */
  inFlightTurns: number;
  /** Wall-clock time of the latest `result`; undefined while the first turn runs. */
  lastTurnEndedAt?: number;
  /** A permission dialog is open for this session. */
  hasPendingPermissions: boolean;
}

export interface ClaudeRunnerReapOptions {
  /** Idle runners older than this are always retired. */
  idleTtlMs?: number;
  /** Keep at most this many idle runners; the oldest beyond the cap are retired. */
  maxIdle?: number;
  /**
   * Never cap-evict a runner idle for less than this — protects the entry a
   * just-completed turn is about to reuse from cap churn.
   */
  minIdleGraceMs?: number;
}

export const CLAUDE_RUNNER_IDLE_TTL_MS = 15 * 60 * 1000;
export const CLAUDE_RUNNER_MAX_IDLE = 5;
export const CLAUDE_RUNNER_MIN_IDLE_GRACE_MS = 2 * 60 * 1000;

/**
 * Returns the session ids whose runners should be aborted now.
 *
 * A runner is a candidate only when it is provably idle: zero in-flight
 * turns, no pending permission dialog, and at least one completed turn
 * (`lastTurnEndedAt` set — a first turn still streaming has none). Candidates
 * are retired when idle past the TTL; beyond that, the oldest candidates past
 * the grace window are retired until at most `maxIdle` idle runners remain.
 */
export function selectClaudeRunnersToReap(
  snapshots: ClaudeRunnerSnapshot[],
  nowMs: number,
  options: ClaudeRunnerReapOptions = {}
): string[] {
  const idleTtlMs = options.idleTtlMs ?? CLAUDE_RUNNER_IDLE_TTL_MS;
  const maxIdle = options.maxIdle ?? CLAUDE_RUNNER_MAX_IDLE;
  const minIdleGraceMs = options.minIdleGraceMs ?? CLAUDE_RUNNER_MIN_IDLE_GRACE_MS;

  const candidates = snapshots.filter(
    (snapshot) =>
      snapshot.inFlightTurns === 0 &&
      !snapshot.hasPendingPermissions &&
      typeof snapshot.lastTurnEndedAt === 'number'
  );

  const reap = new Set<string>();
  for (const candidate of candidates) {
    if (nowMs - candidate.lastTurnEndedAt! > idleTtlMs) {
      reap.add(candidate.sessionId);
    }
  }

  const surviving = candidates.filter((candidate) => !reap.has(candidate.sessionId));
  if (surviving.length > maxIdle) {
    const evictable = surviving
      .filter((candidate) => nowMs - candidate.lastTurnEndedAt! > minIdleGraceMs)
      // Oldest first (least recently used).
      .sort((a, b) => a.lastTurnEndedAt! - b.lastTurnEndedAt!);
    let excess = surviving.length - maxIdle;
    for (const candidate of evictable) {
      if (excess <= 0) break;
      reap.add(candidate.sessionId);
      excess -= 1;
    }
  }

  return Array.from(reap);
}
