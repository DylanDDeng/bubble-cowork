/**
 * Soft-stop reconciliation policy for kept-alive Claude runners.
 *
 * Pressing stop soft-interrupts the in-flight turn via the SDK and keeps the
 * runner (and its warm context) alive for follow-up turns. The runner entry
 * then carries stop state — how many interrupted turns still owe a `result`,
 * plus a hard-abort fallback timer — that must be reconciled against turns
 * the user dispatched AFTER the stop: a destructive fallback may only fire
 * when every in-flight turn is a stopped one, otherwise it would silently
 * kill the user's follow-up turn sharing the same runner.
 *
 * Ordering contract: the CLI serves turns serially over one stream — each
 * turn's `result` lands before the next turn starts. A stopped turn's result
 * therefore always precedes a follow-up's, which is what makes the
 * oldest-turn-first attribution in `classifyResultForStop` sound. If a
 * stopped turn never produces a result the stream is wedged and the queued
 * follow-up cannot complete either; recovery then comes from `onError`
 * teardown, a renewed stop, or — once the fallback has re-armed past its
 * escalation budget — a reclaim that surfaces the failure to the user. Never
 * from guessing which turn an arriving result belongs to.
 *
 * This module is pure (plain counters in, decisions out) so the policy is
 * unit-testable without Electron.
 */

export interface StopStateSnapshot {
  /** Turns dispatched into the runner that have not yet produced a `result`. */
  inFlightTurns: number;
  /** User-stopped turns whose `result` has not landed yet (≤ inFlightTurns). */
  stoppedTurns: number;
}

/**
 * True when the runner carries stopped turns and nothing else — tearing it
 * down loses no work the user still wants.
 */
export function onlyStoppedTurnsInFlight(state: StopStateSnapshot): boolean {
  return state.stoppedTurns > 0 && state.inFlightTurns <= state.stoppedTurns;
}

/**
 * Stop marks the oldest live turn as interrupted. The count is capped by the
 * turns actually in flight so repeated stop presses can never mark more
 * results as "stopped" than will ever arrive (which would misattribute a
 * later live turn's result).
 */
export function markTurnStopped(state: StopStateSnapshot): number {
  return Math.min(state.stoppedTurns + 1, Math.max(state.inFlightTurns, 1));
}

export type StopFallbackAction = 'hard-abort' | 'stand-down' | 're-arm' | 'reclaim-and-surface';

/**
 * With the fallback interval at 8s this gives a wedged interrupt ~40s to
 * deliver its result before the runner is reclaimed out from under a queued
 * follow-up (which, per the serial-stream contract, cannot run until that
 * result arrives anyway).
 */
export const STOP_FALLBACK_MAX_ATTEMPTS = 5;

/**
 * What the stop fallback (timer expiry, or a rejected `interrupt()`) may do
 * on its `attempt`-th firing (1-based) for the same unreconciled stop.
 *
 * - `stand-down`: the stop already reconciled (a result/onError landed
 *   first); drop the timer, nothing left to do.
 * - `hard-abort`: every in-flight turn was stopped by the user; the runner
 *   owes nothing live, so a wedged interrupt is resolved by killing it
 *   silently (the stop already reported 'idle').
 * - `re-arm`: a follow-up turn is in flight on this runner. Destroying the
 *   runner now would silently kill that live turn, and a slow interrupt may
 *   still deliver its result — keep the stop attribution and check again.
 * - `reclaim-and-surface`: the follow-up is still queued behind a stopped
 *   turn whose result never came after the full escalation budget; the
 *   stream is wedged and the follow-up can never complete. Reclaim the
 *   runner AND surface a failure (status + toast) so the user can resend —
 *   never leave the session stuck on 'running' with no way out.
 */
export function resolveStopFallbackAction(
  state: StopStateSnapshot,
  attempt: number
): StopFallbackAction {
  if (state.stoppedTurns <= 0) return 'stand-down';
  if (onlyStoppedTurnsInFlight(state)) return 'hard-abort';
  return attempt < STOP_FALLBACK_MAX_ATTEMPTS ? 're-arm' : 'reclaim-and-surface';
}

export interface StopResultClassification {
  /**
   * The arriving `result` belongs to a user-stopped turn (results land
   * oldest-turn-first): map it to 'idle' — never 'error' — skip failure
   * detection for it, and keep it out of the transcript (a hard-aborted turn
   * never produced a terminal result either, and with a follow-up prompt
   * already persisted it would land under the wrong turn).
   */
  stoppedByUser: boolean;
  /**
   * A newer turn is still in flight after this result; persisting or
   * broadcasting the stopped turn's status would clobber the live turn's
   * `running` state.
   */
  suppressStatusBroadcast: boolean;
}

/** Classify an arriving `result` against the runner's stop state. */
export function classifyResultForStop(state: StopStateSnapshot): StopResultClassification {
  const stoppedByUser = state.stoppedTurns > 0;
  return {
    stoppedByUser,
    suppressStatusBroadcast: stoppedByUser && state.inFlightTurns - 1 > 0,
  };
}

/**
 * Whether a runner error may be swallowed without any status update: only
 * when nothing live is lost — an idle (between-turns) crash, or teardown
 * noise from a runner whose every in-flight turn the user already stopped.
 * With a live follow-up turn in flight the error must surface normally, or
 * the follow-up would vanish with the session stuck on 'running'.
 */
export function shouldDropRunnerErrorSilently(state: StopStateSnapshot): boolean {
  return state.inFlightTurns === 0 || onlyStoppedTurnsInFlight(state);
}

/**
 * Which stream messages belong to a stopped turn's drain — content the SDK
 * still delivers between `interrupt()` and the interrupted turn's terminal
 * `result` (truncated assistant output, tool results, partial stream
 * events). While stopped turns still owe a result, this drain must stay out
 * of the transcript: the user canceled that work (a hard-aborted turn never
 * recorded it either), and once a follow-up prompt is persisted the drain
 * would be filed under — and attributed to — the wrong turn.
 *
 * Attribution rests on the serial-stream contract: no follow-up turn output
 * can appear before the stopped turn's result lands, so everything
 * turn-shaped in that window is the stopped turn's. The only non-drain
 * messages in the window are host-minted user prompt echoes (plain text —
 * never tool_result blocks), which anchor /rewind for the follow-up, and
 * session-level system records; both must be kept.
 */
export function isStoppedTurnDrainMessage(message: {
  type: string;
  message?: { content?: unknown };
}): boolean {
  if (message.type === 'assistant' || message.type === 'stream_event') {
    return true;
  }
  if (message.type === 'user') {
    // SDK 'user' messages carry tool results back into the turn; the host's
    // own follow-up prompt echo is plain text and must survive.
    const content = message.message?.content;
    return (
      Array.isArray(content) &&
      content.some((block) => (block as { type?: string } | null)?.type === 'tool_result')
    );
  }
  return false;
}
