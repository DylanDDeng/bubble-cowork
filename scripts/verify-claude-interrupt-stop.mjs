#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

// ── Source wiring assertions ─────────────────────────────────────────────────

// The runner must expose the SDK's soft interrupt.
const runnerSource = fs.readFileSync(path.join(root, 'src', 'electron', 'libs', 'runner.ts'), 'utf8');
assert.equal(
  runnerSource.includes('await activeQuery.interrupt()'),
  true,
  'runner.ts must forward interrupt() to the live SDK query'
);

const typesSource = fs.readFileSync(path.join(root, 'src', 'electron', 'types.ts'), 'utf8');
assert.equal(
  typesSource.includes('interrupt?: () => Promise<void>;'),
  true,
  'RunnerHandle must declare the optional interrupt capability'
);

const ipcSource = fs.readFileSync(path.join(root, 'src', 'electron', 'ipc-handlers.ts'), 'utf8');

// Stop must soft-interrupt an in-flight Claude turn instead of killing the
// process, and every failure to reconcile must route through the guarded
// fallback (never a direct hard abort that could kill a follow-up turn).
assert.equal(
  ipcSource.includes('entry.handle.interrupt!().catch(() => resolveStopFallback(mainWindow, sessionId, entry))'),
  true,
  'handleSessionStop must soft-interrupt and route rejections through the guarded fallback'
);
assert.equal(
  ipcSource.includes('STOP_INTERRUPT_FALLBACK_MS'),
  true,
  'the interrupted-turn fallback timer must exist'
);
assert.match(
  ipcSource,
  /setTimeout\(\s*\(\) => resolveStopFallback\(mainWindow, sessionId, entry\),\s*STOP_INTERRUPT_FALLBACK_MS\s*\)/,
  'the fallback timer must go through resolveStopFallback, not hard-abort directly'
);
assert.match(
  ipcSource,
  /\(entry\.inFlightTurns \?\? 0\) > 0/,
  'soft interrupt must only apply to entries with an in-flight turn'
);

// The reconcile decisions must come from the pure policy module (unit-tested
// below), not ad-hoc conditions on the entry.
assert.equal(
  ipcSource.includes("from './libs/claude-stop-reconcile'"),
  true,
  'ipc-handlers must use the claude-stop-reconcile policy module'
);
assert.equal(
  ipcSource.includes('resolveStopFallbackAction(stopStateOf(entry), attempt)'),
  true,
  'the stop fallback must consult resolveStopFallbackAction with the attempt count'
);
assert.equal(
  ipcSource.includes('shouldDropRunnerErrorSilently(stopStateOf(mappedEntry))'),
  true,
  'onError may only silent-drop per shouldDropRunnerErrorSilently — a follow-up turn must surface errors'
);
assert.equal(
  ipcSource.includes('classifyResultForStop(stopStateForMessage)'),
  true,
  'result attribution must go through classifyResultForStop'
);

// A wedged stop with a queued follow-up must eventually be reclaimed WITH a
// surfaced failure (status + toast), never left stuck on 'running'.
assert.match(
  ipcSource,
  /case 'reclaim-and-surface':[\s\S]{0,900}?type: 'runner\.error'/,
  'the escalated fallback must surface a runner.error after reclaiming'
);

// A stale (already replaced/retired) handle the user stopped must not mark
// the session as failed from its late teardown noise.
assert.equal(
  ipcSource.includes('userStoppedRunnerHandles.has(handle)'),
  true,
  'onError must silence late errors from replaced user-stopped handles'
);
assert.equal(
  ipcSource.includes('userStoppedRunnerHandles.add(entry.handle)'),
  true,
  'handleSessionStop must record stopped handles for stale-error silencing'
);

// A doomed/one-shot runner may only be retired at a result when NO turns
// remain in flight — a stopped turn's result must not abort a live follow-up.
assert.match(
  ipcSource,
  /\(currentEntry\.doomed \|\| currentEntry\.autoApprove\) &&\s*\(currentEntry\.inFlightTurns \?\? 0\) === 0/,
  'doomed/automation retire at result must wait for zero in-flight turns'
);

// A user-stopped turn's terminal result AND its post-interrupt drain
// (assistant output, tool results, stream events) stay out of the
// transcript: with a follow-up prompt already persisted they would land
// under — and be attributed to — the wrong turn.
assert.match(
  ipcSource,
  /sanitizedStreamMessage\.message &&\s*!stopClassification\.stoppedByUser &&\s*!isStoppedTurnDrain/,
  'stopped-turn results and drain must be kept out of the persisted transcript'
);
assert.equal(
  ipcSource.includes('isStoppedTurnDrainMessage(message)'),
  true,
  'drain suppression must use the policy module message-shape rule'
);
assert.match(
  ipcSource,
  /stopStateForMessage\.stoppedTurns > 0 &&\s*isStoppedTurnDrainMessage\(message\)/,
  'drain suppression must apply while stopped turns still owe a result'
);

// A second stop can mark a QUEUED turn; interrupt() only reaches the active
// one, so when a stopped turn settles with more still marked, the interrupt
// must be re-issued for the newly active turn (with the fallback re-armed).
assert.match(
  ipcSource,
  /entryToReinterrupt\.handle\s*\n?\s*\.interrupt!\(\)\s*\n?\s*\.catch\(\(\) => resolveStopFallback\(mainWindow, session\.id, entryToReinterrupt\)\)/,
  'settling a stopped turn with more stopped turns pending must re-issue interrupt()'
);

// Soft stop must settle pending permissions as a clean DENY (the runner and
// its queued follow-up stay alive); rejection is only for the hard-abort
// path where the process dies anyway.
assert.match(
  ipcSource,
  /if \(softStopped\) \{\s*pending\.resolve\(\{ behavior: 'deny'/,
  'soft stop must resolve pending permissions as deny, not reject them'
);
assert.match(
  ipcSource,
  /\} else \{\s*pending\.reject\(new Error\('Session aborted'\)\)/,
  'hard stop keeps the rejection path for pending permissions'
);
assert.equal(
  ipcSource.includes('entry.stoppedTurns = markTurnsStopped(stopStateOf(entry))'),
  true,
  'stop must mark turns via markTurnsStopped (everything in flight, capped)'
);

// A prompt still being prepared when stop lands must be cancelled before it
// reaches the input queue, and removed from the turn accounting (it never
// produces a result); with nothing left in flight, the runner stays warm
// with no interrupt and no fallback armed. The cancellation must also
// RELEASE the serial enqueue chain (race against the long prepare step) so
// a follow-up send never queues behind — or waits on — the cancelled work.
assert.equal(
  runnerSource.includes('cancelPendingPrompts: () => {'),
  true,
  'the Claude runner must expose cancelPendingPrompts'
);
assert.equal(
  runnerSource.includes('createPromptCancellation()'),
  true,
  'the runner must use the unit-tested prompt-cancellation primitive'
);
assert.match(
  runnerSource,
  /promptCancellation\.isCancelled\(seq\)/,
  'enqueues must re-check the cancellation mark around their awaits'
);
assert.match(
  runnerSource,
  /await promptCancellation\.race\(\s*buildUserMessage\(/,
  'the long prepare step must race cancellation so the chain settles immediately'
);
assert.match(
  runnerSource,
  /await activeQuery\.setModel\(nextRuntimeModel\);[\s\S]{0,900}?promptCancellation\.isCancelled\(seq\)[\s\S]{0,300}?await promptCancellation\.race\(\s*buildUserMessage\(/,
  'a stop during the model round-trip must bail before starting attachment prep'
);
assert.match(
  runnerSource,
  /promptCancellation\.settle\(seq\)/,
  'every enqueue link must settle its sequence number'
);
assert.match(
  ipcSource,
  /const cancelledPrompts = entry\.handle\.cancelPendingPrompts\?\.\(\) \?\? 0/,
  'soft stop must cancel prompts still being prepared'
);
assert.match(
  ipcSource,
  /\(entry\.inFlightTurns \?\? 0\) - cancelledPrompts/,
  'cancelled prompts must be removed from the in-flight accounting'
);
assert.match(
  ipcSource,
  /entry\.pendingTurnPrompts\?\.splice\(-cancelledPrompts\)/,
  'cancelled prompts must be trimmed from the prompt FIFO tail in lockstep'
);

// A replaced stopped runner's late result/drain must still classify as
// user-stopped (by handle, not by the map) so it cannot persist or clobber
// the replacement run's status.
// A replaced stopped runner is dead to the session: EVERY message it emits
// (init, drain, result) is dropped at the top of onMessage, before the init
// block could overwrite the replacement's session id/model or broadcast
// stale status.
assert.match(
  ipcSource,
  /onMessage: \(message\) => \{\s*\/\/[\s\S]{0,700}?if \(userStoppedRunnerHandles\.has\(handle\) && runnerHandles\.get\(session\.id\)\?\.handle !== handle\) \{\s*return;/,
  'onMessage must drop all messages from replaced user-stopped handles before init handling'
);

// A permission request emitted after the stop (the runner stays alive now)
// must be auto-denied instead of surfacing a modal for canceled work.
assert.equal(
  ipcSource.includes('shouldAutoDenyPermission(stopStateOf(permissionEntry))'),
  true,
  'late permission requests from stopped turns must be auto-denied'
);
assert.match(
  ipcSource,
  /shouldAutoDenyPermission[\s\S]{0,300}?\{ behavior: 'deny', message: 'The user stopped this turn\.' \}/,
  'the auto-deny must answer with the stop deny message'
);

// The native runtime wrapper must forward the optional soft-stop (and
// rewind) capabilities, or stop degrades to a hard abort in that runtime.
const nativeRuntimeSource = fs.readFileSync(
  path.join(root, 'src', 'electron', 'libs', 'runtime', 'native-runtime.ts'),
  'utf8'
);
assert.equal(
  nativeRuntimeSource.includes('interrupt: handle.interrupt'),
  true,
  'native runtime must forward interrupt'
);
assert.equal(
  nativeRuntimeSource.includes('cancelPendingPrompts: handle.cancelPendingPrompts'),
  true,
  'native runtime must forward cancelPendingPrompts'
);
assert.equal(
  nativeRuntimeSource.includes('rewindFiles: handle.rewindFiles'),
  true,
  'native runtime must forward rewindFiles'
);

// The interrupted turn's result must read as idle, never as a failure, and a
// late result must not clobber the status of a newer in-flight turn.
assert.match(
  ipcSource,
  /stoppedByUser\s*\?\s*'idle'/,
  'a user-stopped turn result must map to idle status'
);
assert.equal(
  ipcSource.includes("provider === 'claude' && !stoppedByUser"),
  true,
  'slash-command failure detection must be skipped for user-stopped turns'
);
assert.equal(
  ipcSource.includes('suppressStatusBroadcast'),
  true,
  'a late stopped-turn result must not override a newer running turn status'
);

// A result settles one stopped turn and stands the fallback down when none
// remain.
assert.match(
  ipcSource,
  /currentEntry\.stoppedTurns = \(currentEntry\.stoppedTurns \?\? 1\) - 1/,
  'the result handler must settle stopped turns one at a time'
);

// No abort/delete path may leave the fallback timer behind: stop (hard path),
// delete, workspace retire, config/provider-change aborts, stale-entry
// replacement, and the error paths all clear it.
assert.equal(
  (ipcSource.match(/clearStopFallbackTimer\(/g) || []).length >= 10,
  true,
  'every abort/delete path must clear the stop fallback timer'
);

// ── Compile + run the reconcile policy unit tests ────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-claude-interrupt-stop-'));
const tscBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);

const compile = spawnSync(
  tscBin,
  [
    '--target',
    'ES2022',
    '--module',
    'CommonJS',
    '--moduleResolution',
    'Node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict',
    '--noEmitOnError',
    'true',
    '--outDir',
    tmpDir,
    'scripts/tests/claude-stop-reconcile.test.ts',
    'scripts/tests/claude-prompt-cancellation.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);

if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

for (const testFile of [
  'claude-stop-reconcile.test.js',
  'claude-prompt-cancellation.test.js',
]) {
  const testPath = path.join(tmpDir, 'scripts', 'tests', testFile);
  const run = spawnSync(process.execPath, [testPath], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(run.status ?? 1);
  }
}
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('claude-interrupt-stop: wiring checks passed');
