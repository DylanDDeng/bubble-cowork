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
  ipcSource.includes('entry.handle.interrupt!().catch(() => resolveStopFallback(sessionId, entry))'),
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
  /setTimeout\(\s*\(\) => resolveStopFallback\(sessionId, entry\),\s*STOP_INTERRUPT_FALLBACK_MS\s*\)/,
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
  ipcSource.includes('resolveStopFallbackAction(stopStateOf(entry))'),
  true,
  'the stop fallback must consult resolveStopFallbackAction'
);
assert.equal(
  ipcSource.includes('shouldDropRunnerErrorSilently(stopStateOf(mappedEntry))'),
  true,
  'onError may only silent-drop per shouldDropRunnerErrorSilently — a follow-up turn must surface errors'
);
assert.equal(
  ipcSource.includes('classifyResultForStop(stopStateOf(entryForPrompt))'),
  true,
  'result attribution must go through classifyResultForStop'
);
assert.equal(
  ipcSource.includes('entry.stoppedTurns = markTurnStopped(stopStateOf(entry))'),
  true,
  'stop must mark turns via markTurnStopped (capped by in-flight turns)'
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
  ],
  { cwd: root, stdio: 'inherit' }
);

if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

const testPath = path.join(tmpDir, 'scripts', 'tests', 'claude-stop-reconcile.test.js');
const run = spawnSync(process.execPath, [testPath], { cwd: root, stdio: 'inherit' });
fs.rmSync(tmpDir, { recursive: true, force: true });
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

console.log('claude-interrupt-stop: wiring checks passed');
