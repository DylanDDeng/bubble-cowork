import assert from 'node:assert/strict';
import {
  CLAUDE_RUNNER_IDLE_TTL_MS,
  CLAUDE_RUNNER_MAX_IDLE,
  CLAUDE_RUNNER_MIN_IDLE_GRACE_MS,
  selectClaudeRunnersToReap,
  type ClaudeRunnerSnapshot,
} from '../../src/electron/libs/claude-runner-pool';

function snapshot(
  sessionId: string,
  overrides: Partial<ClaudeRunnerSnapshot> = {}
): ClaudeRunnerSnapshot {
  return {
    sessionId,
    inFlightTurns: 0,
    lastTurnEndedAt: 0,
    hasPendingPermissions: false,
    ...overrides,
  };
}

const NOW = 100 * 60 * 1000; // 100 minutes

// Busy runners are untouchable, no matter how old their last result is.
{
  const victims = selectClaudeRunnersToReap(
    [snapshot('busy', { inFlightTurns: 1, lastTurnEndedAt: 0 })],
    NOW
  );
  assert.deepEqual(victims, [], 'in-flight turns block reaping past any TTL');
}

// A session waiting on a permission dialog is never reaped.
{
  const victims = selectClaudeRunnersToReap(
    [snapshot('waiting', { hasPendingPermissions: true, lastTurnEndedAt: 0 })],
    NOW
  );
  assert.deepEqual(victims, [], 'pending permissions block reaping');
}

// A first turn that has not produced a result yet has no idle anchor.
{
  const victims = selectClaudeRunnersToReap(
    [snapshot('first-turn', { lastTurnEndedAt: undefined })],
    NOW
  );
  assert.deepEqual(victims, [], 'no lastTurnEndedAt means never idle');
}

// TTL expiry reaps; fresher runners survive.
{
  const victims = selectClaudeRunnersToReap(
    [
      snapshot('old', { lastTurnEndedAt: NOW - CLAUDE_RUNNER_IDLE_TTL_MS - 1 }),
      snapshot('fresh', { lastTurnEndedAt: NOW - 1_000 }),
    ],
    NOW
  );
  assert.deepEqual(victims, ['old']);
}

// LRU cap: with more idle runners than maxIdle, the oldest beyond the grace
// window are evicted until the cap holds.
{
  const count = CLAUDE_RUNNER_MAX_IDLE + 2;
  const snapshots = Array.from({ length: count }, (_, index) =>
    snapshot(`s${index}`, {
      // s0 is oldest; all within TTL, all older than the grace window.
      lastTurnEndedAt: NOW - CLAUDE_RUNNER_MIN_IDLE_GRACE_MS - (count - index) * 1_000,
    })
  );
  const victims = selectClaudeRunnersToReap(snapshots, NOW).sort();
  assert.deepEqual(victims, ['s0', 's1'], 'the two oldest idle runners are cap-evicted');
}

// Grace window: runners idle for less than the grace period are not
// cap-evicted even when the pool is over the cap.
{
  const count = CLAUDE_RUNNER_MAX_IDLE + 2;
  const snapshots = Array.from({ length: count }, (_, index) =>
    snapshot(`s${index}`, { lastTurnEndedAt: NOW - 1_000 - index })
  );
  const victims = selectClaudeRunnersToReap(snapshots, NOW);
  assert.deepEqual(victims, [], 'freshly idle runners are protected by the grace window');
}

// Options are injectable for tuning without code changes elsewhere.
{
  const victims = selectClaudeRunnersToReap(
    [snapshot('a', { lastTurnEndedAt: NOW - 5_000 })],
    NOW,
    { idleTtlMs: 4_000 }
  );
  assert.deepEqual(victims, ['a']);
}

// TTL reaping and cap eviction combine without double-counting.
{
  const snapshots = [
    snapshot('expired', { lastTurnEndedAt: NOW - CLAUDE_RUNNER_IDLE_TTL_MS - 1 }),
    ...Array.from({ length: CLAUDE_RUNNER_MAX_IDLE + 1 }, (_, index) =>
      snapshot(`live${index}`, {
        lastTurnEndedAt: NOW - CLAUDE_RUNNER_MIN_IDLE_GRACE_MS - (index + 1) * 1_000,
      })
    ),
  ];
  const victims = selectClaudeRunnersToReap(snapshots, NOW).sort();
  // 'expired' goes by TTL; the surviving pool is maxIdle+1 so the oldest
  // survivor ('live5', furthest past grace) is cap-evicted too.
  assert.equal(victims.includes('expired'), true);
  assert.equal(victims.length, 2, 'one TTL reap + one cap eviction');
}

console.log('claude-runner-pool.test.ts passed');
