#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

// The runner must expose the SDK's soft interrupt.
const runnerSource = fs.readFileSync(path.join(root, 'src', 'electron', 'libs', 'runner.ts'), 'utf8');
assert.equal(
  runnerSource.includes('await activeQuery.interrupt();'),
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
// process, with a hard-abort fallback if the result never lands.
assert.equal(
  ipcSource.includes('entry.handle.interrupt!().catch(() => hardStopClaudeRunner(sessionId, entry))'),
  true,
  'handleSessionStop must soft-interrupt Claude turns and fall back to a hard abort on failure'
);
assert.equal(
  ipcSource.includes('STOP_INTERRUPT_FALLBACK_MS'),
  true,
  'the interrupted-turn fallback timer must exist'
);
assert.equal(
  ipcSource.includes("(entry.inFlightTurns ?? 0) > 0"),
  true,
  'soft interrupt must only apply to entries with an in-flight turn'
);

// The interrupted turn's result must read as idle, never as a failure, and a
// late result must not clobber the status of a newer in-flight turn.
assert.equal(
  ipcSource.includes("stoppedByUser\n          ? 'idle'"),
  true,
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
assert.equal(
  ipcSource.includes('currentEntry.stoppedByUser = undefined;'),
  true,
  'the stop flag must clear when the interrupted result lands'
);

console.log('claude-interrupt-stop: wiring checks passed');
