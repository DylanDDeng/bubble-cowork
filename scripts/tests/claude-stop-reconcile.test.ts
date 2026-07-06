import assert from 'node:assert/strict';
import {
  classifyResultForStop,
  isStoppedTurnDrainMessage,
  markTurnStopped,
  onlyStoppedTurnsInFlight,
  resolveStopFallbackAction,
  shouldDropRunnerErrorSilently,
  STOP_FALLBACK_MAX_ATTEMPTS,
  type StopStateSnapshot,
} from '../../src/electron/libs/claude-stop-reconcile';

function state(inFlightTurns: number, stoppedTurns: number): StopStateSnapshot {
  return { inFlightTurns, stoppedTurns };
}

// ── markTurnStopped ──────────────────────────────────────────────────────────

// A stop marks the (single) in-flight turn.
assert.equal(markTurnStopped(state(1, 0)), 1, 'first stop marks the running turn');

// Stop pressed again during the same turn must not over-count: a later live
// turn's result would otherwise be misattributed as stopped.
assert.equal(markTurnStopped(state(1, 1)), 1, 'double-press on one turn stays capped');

// Stop-then-send-then-stop: both in-flight turns are now stopped.
assert.equal(markTurnStopped(state(2, 1)), 2, 'second stop marks the follow-up too');

// ── classifyResultForStop (result attribution, oldest turn first) ────────────

// No stop pending: a result is a live turn's — full status handling.
{
  const c = classifyResultForStop(state(1, 0));
  assert.equal(c.stoppedByUser, false, 'live result is not user-stopped');
  assert.equal(c.suppressStatusBroadcast, false, 'live result broadcasts its status');
}

// Plain stop, no follow-up: the interrupted result maps to idle and its idle
// status is broadcast (nothing newer to clobber).
{
  const c = classifyResultForStop(state(1, 1));
  assert.equal(c.stoppedByUser, true, 'stopped result maps to idle');
  assert.equal(c.suppressStatusBroadcast, false, 'no newer turn — idle broadcasts');
}

// Stop then immediate follow-up send: the stopped turn's late result must not
// flip the running session back to idle.
{
  const c = classifyResultForStop(state(2, 1));
  assert.equal(c.stoppedByUser, true, 'stopped result still maps to idle');
  assert.equal(c.suppressStatusBroadcast, true, 'follow-up in flight — suppress');
}

// ── resolveStopFallbackAction (P1: fallback must never silently kill a
// follow-up; P2: nor stand down permanently on a wedged runner) ──────────────

assert.equal(
  resolveStopFallbackAction(state(1, 1), 1),
  'hard-abort',
  'only the stopped turn in flight — a wedged interrupt is resolved by abort'
);
assert.equal(
  resolveStopFallbackAction(state(1, 0), 1),
  'stand-down',
  'stop already reconciled — nothing left for the fallback to do'
);
assert.equal(
  resolveStopFallbackAction(state(0, 0), 1),
  'stand-down',
  'idle runner — the fallback never fires destructively'
);
// Escape hatch: the user stopped the follow-up too, so everything in flight
// is stopped and a renewed fallback may hard-abort the wedged runner.
assert.equal(
  resolveStopFallbackAction(state(2, 2), 1),
  'hard-abort',
  'every in-flight turn stopped — hard abort recovers the wedged runner'
);

// With a live follow-up the fallback re-arms while the interrupt may still be
// merely slow, then reclaims WITH a surfaced failure once the escalation
// budget is spent: per the serial-stream contract the queued follow-up can
// never complete behind a missing result, so standing down permanently would
// strand the session on 'running' with a wedged runner.
for (let attempt = 1; attempt < STOP_FALLBACK_MAX_ATTEMPTS; attempt += 1) {
  assert.equal(
    resolveStopFallbackAction(state(2, 1), attempt),
    're-arm',
    `attempt ${attempt}: live follow-up on the runner — wait, never destroy silently`
  );
}
assert.equal(
  resolveStopFallbackAction(state(2, 1), STOP_FALLBACK_MAX_ATTEMPTS),
  'reclaim-and-surface',
  'budget spent — reclaim the wedged runner and surface the failure'
);
assert.equal(
  resolveStopFallbackAction(state(2, 1), STOP_FALLBACK_MAX_ATTEMPTS + 3),
  'reclaim-and-surface',
  'past-budget attempts still reclaim'
);

// ── shouldDropRunnerErrorSilently (P1: onError must not eat a follow-up) ─────

assert.equal(
  shouldDropRunnerErrorSilently(state(0, 0)),
  true,
  'idle between-turns crash stays silent'
);
assert.equal(
  shouldDropRunnerErrorSilently(state(1, 1)),
  true,
  'teardown noise from a just-stopped turn stays silent'
);
assert.equal(
  shouldDropRunnerErrorSilently(state(2, 1)),
  false,
  'follow-up in flight — the error must surface with a status update'
);
assert.equal(
  shouldDropRunnerErrorSilently(state(1, 0)),
  false,
  'live turn erroring is a real failure'
);

// ── onlyStoppedTurnsInFlight sanity ──────────────────────────────────────────

assert.equal(onlyStoppedTurnsInFlight(state(0, 0)), false);
assert.equal(onlyStoppedTurnsInFlight(state(1, 1)), true);
assert.equal(onlyStoppedTurnsInFlight(state(2, 1)), false);

// ── Scenario walk: stop → send correction → both results land ────────────────
// Mirrors the ipc-handlers bookkeeping: dispatch increments inFlightTurns,
// stop marks a turn stopped, each result settles one stopped turn (if any)
// and decrements inFlightTurns.
{
  let inFlight = 1; // turn A streaming
  let stopped = 0;

  // User presses stop.
  stopped = markTurnStopped(state(inFlight, stopped));
  assert.equal(stopped, 1);

  // User immediately sends a correction into the same runner.
  inFlight += 1;

  // Fallback timer fires before turn A's result lands: re-arm — never destroy
  // the runner carrying the correction, but never give up on it either.
  assert.equal(resolveStopFallbackAction(state(inFlight, stopped), 1), 're-arm');
  // A teardown error now must surface, not vanish.
  assert.equal(shouldDropRunnerErrorSilently(state(inFlight, stopped)), false);

  // Turn A's (interrupted) result lands: idle, suppressed, settles the stop.
  const first = classifyResultForStop(state(inFlight, stopped));
  assert.equal(first.stoppedByUser, true);
  assert.equal(first.suppressStatusBroadcast, true);
  stopped -= 1;
  inFlight -= 1;

  // Turn B's result lands: normal full handling — the correction's status
  // must not be mapped to idle or suppressed.
  const second = classifyResultForStop(state(inFlight, stopped));
  assert.equal(second.stoppedByUser, false);
  assert.equal(second.suppressStatusBroadcast, false);
  inFlight -= 1;

  // Runner is cleanly idle afterwards — no leaked turn pins it forever.
  assert.equal(inFlight, 0);
  assert.equal(stopped, 0);
}

// ── Scenario walk: stop → send → stop again (user stops the correction too) ──
{
  let inFlight = 1;
  let stopped = markTurnStopped(state(1, 0)); // stop turn A
  inFlight += 1; // send turn B
  stopped = markTurnStopped(state(inFlight, stopped)); // stop turn B
  assert.equal(stopped, 2);

  // Everything in flight is stopped: a wedged runner may now be hard-aborted.
  assert.equal(resolveStopFallbackAction(state(inFlight, stopped), 1), 'hard-abort');

  // If instead both results land, each maps to idle and only the last one
  // broadcasts (nothing newer remains).
  const first = classifyResultForStop(state(inFlight, stopped));
  assert.equal(first.stoppedByUser, true);
  assert.equal(first.suppressStatusBroadcast, true);
  stopped -= 1;
  inFlight -= 1;
  const second = classifyResultForStop(state(inFlight, stopped));
  assert.equal(second.stoppedByUser, true);
  assert.equal(second.suppressStatusBroadcast, false);
}

// ── Scenario walk: stop → send → interrupted result never lands (wedged) ─────
// The fallback re-arms through its budget and then reclaims with a surfaced
// failure — the session must never stay stuck on 'running' forever.
{
  let stopped = markTurnStopped(state(1, 0)); // stop turn A
  const inFlight = 2; // correction B queued behind the wedged turn A

  const actions: string[] = [];
  for (let attempt = 1; attempt <= STOP_FALLBACK_MAX_ATTEMPTS; attempt += 1) {
    actions.push(resolveStopFallbackAction(state(inFlight, stopped), attempt));
  }
  assert.deepEqual(
    actions,
    [...Array(STOP_FALLBACK_MAX_ATTEMPTS - 1).fill('re-arm'), 'reclaim-and-surface'],
    'a wedged runner with a queued follow-up is eventually reclaimed, not orphaned'
  );

  // If the slow result DOES land mid-escalation, the stop settles normally
  // and the next fallback firing stands down.
  stopped -= 1;
  assert.equal(resolveStopFallbackAction(state(inFlight - 1, stopped), 3), 'stand-down');
}

// ── isStoppedTurnDrainMessage (post-interrupt drain vs follow-up echo) ───────
// While stopped turns still owe a result, the serial stream can only carry
// the interrupted turn's drain plus host-minted artifacts. Turn work is
// suppressed; the follow-up's prompt echo and session records survive.

assert.equal(
  isStoppedTurnDrainMessage({ type: 'assistant', message: { content: [{ type: 'text' }] } }),
  true,
  'truncated assistant output drains from the stopped turn'
);
assert.equal(
  isStoppedTurnDrainMessage({ type: 'stream_event' }),
  true,
  'partial stream events drain from the stopped turn'
);
assert.equal(
  isStoppedTurnDrainMessage({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
  }),
  true,
  'tool results returning into the stopped turn are drain'
);
assert.equal(
  isStoppedTurnDrainMessage({
    type: 'user',
    message: { content: [{ type: 'text', text: 'corrected prompt' }] },
  }),
  false,
  "the follow-up's host-minted prompt echo must survive (it anchors /rewind)"
);
assert.equal(
  isStoppedTurnDrainMessage({ type: 'system' }),
  false,
  'session-level system records are not turn drain'
);
assert.equal(
  isStoppedTurnDrainMessage({ type: 'result' }),
  false,
  'results are classified by classifyResultForStop, not the drain rule'
);

console.log('claude-stop-reconcile.test: all assertions passed');
