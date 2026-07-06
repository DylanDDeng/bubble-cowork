#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

// ── Source wiring assertions ─────────────────────────────────────────────────

const ipcSource = fs.readFileSync(path.join(root, 'src', 'electron', 'ipc-handlers.ts'), 'utf8');

// The result handler must keep the Claude entry alive (turn accounting instead
// of the old unconditional delete) and reset per-turn detection state.
assert.equal(
  ipcSource.includes('currentEntry.inFlightTurns = Math.max(0, (currentEntry.inFlightTurns ?? 1) - 1)'),
  true,
  'result handler must decrement inFlightTurns instead of deleting the Claude entry'
);
assert.equal(
  ipcSource.includes('currentEntry.lastTurnEndedAt = Date.now()'),
  true,
  'result handler must stamp the idle anchor for the reaper'
);
assert.equal(
  ipcSource.includes('localFailureMessage = null;\n        sawTurnOutput = false;'),
  true,
  'per-turn detection state must reset when the runner is kept for reuse'
);

// The reaper and the config-flush hooks must be wired.
assert.equal(ipcSource.includes('function sweepIdleClaudeRunners'), true, 'idle reaper missing');
assert.equal(ipcSource.includes('function flushClaudeRunners'), true, 'config flush missing');
assert.equal(
  (ipcSource.match(/flushClaudeRunners\(/g) || []).length >= 4,
  true,
  'flushClaudeRunners must cover provider config, MCP config, and skill installs'
);
assert.equal(ipcSource.includes('stopClaudeRunnerReaper();'), true, 'cleanup must stop the reaper');

// Skill installs change what a Claude CLI process loaded at spawn — both the
// module registration (which shadows the inline handler) and the inline
// handler must retire kept-alive runners on a successful install.
assert.equal(
  ipcSource.includes('onClaudeSkillsChanged: () => flushClaudeRunners()'),
  true,
  'ipcCtx must wire skill-change flushes for the skill-market module'
);
const skillMarketIpcSource = fs.readFileSync(
  path.join(root, 'src', 'electron', 'ipc', 'skill-market.ts'),
  'utf8'
);
assert.equal(
  skillMarketIpcSource.includes('ctx.onClaudeSkillsChanged?.()'),
  true,
  'skill install must retire kept-alive Claude runners'
);

// Workspace changes must retire the session runner for EVERY provider —
// non-Claude handles persist between turns too and are bound to their spawn
// cwd, so a Claude-only flush would reuse them against the wrong checkout.
assert.equal(ipcSource.includes('function retireSessionRunner'), true, 'all-provider retire missing');
assert.equal(
  (ipcSource.match(/retireSessionRunner\(/g) || []).length >= 4,
  true,
  'retireSessionRunner must cover worktree move, workspace handoff, and git-root flush'
);

// Checkout-mutating paths (branch checkout/create, handoff stash+branch
// switch, worktree apply squash-merge) rewrite files under every session
// sharing the git root; kept-alive runners must be flushed around each.
assert.equal(
  (ipcSource.match(/await flushRunnersSharingGitRoot\(/g) || []).length >= 4,
  true,
  'checkout/create-branch, handoff local mutation, and worktree apply must flush runners sharing the git root'
);

// Worktree apply/discard force-remove the checkout directory; the session's
// runner AND any runner anchored inside the removed path must be retired.
assert.equal(
  ipcSource.includes('function retireRunnersUnderPath'),
  true,
  'path-scoped retire missing'
);
assert.equal(
  (ipcSource.match(/retireRunnersUnderPath\(/g) || []).length >= 3,
  true,
  'apply-worktree-changes and discard-worktree-changes must retire runners under the removed worktree'
);

// ...but never a runner whose session is mid-turn: apply/discard block on
// running siblings up front and the path-scoped retire skips running rows.
assert.equal(
  (ipcSource.match(/findRunningSessionUnderPath\(/g) || []).length >= 3,
  true,
  'apply/discard must block when a running sibling session sits under the worktree'
);
assert.equal(
  ipcSource.includes("if (sessions.getSession(sessionId)?.status === 'running') continue;"),
  true,
  'retireRunnersUnderPath must never abort a running session'
);

// Turn prompts are a per-turn FIFO: a queued second prompt must never be
// checked against the first turn's result.
assert.equal(
  ipcSource.includes('(existingEntry.pendingTurnPrompts ??= []).push(runnerPrompt)'),
  true,
  'continue reuse must enqueue the dispatched prompt'
);
assert.equal(
  ipcSource.includes('entryForPrompt.pendingTurnPrompts?.shift()'),
  true,
  'each result must pop its own turn prompt from the FIFO'
);

// Queued-turn session semantics: a result that leaves turns in flight must
// not write a terminal DB status (the git/workspace gates trust DB status),
// and a doomed/one-shot runner is only retired once the queue is drained —
// aborting earlier would drop a persisted queued prompt without a result.
assert.equal(
  ipcSource.includes("hasQueuedTurns ? 'running' : turnStatus"),
  true,
  'a result with queued turns must keep the session status running'
);
assert.equal(
  ipcSource.includes('drained && (currentEntry.doomed || currentEntry.autoApprove)'),
  true,
  'doomed/automation runners must drain queued turns before retiring'
);

// A silent slash-command failure proves the live CLI's init-time skill list
// is stale; the runner must be doomed so the retry respawns with a rescan.
assert.equal(
  ipcSource.includes('activeEntry.doomed = true'),
  true,
  'slash-command failure must doom the kept-alive runner'
);

// Reuse regression guards (family alias vs init-resolved concrete id made
// every follow-up abort the warm runner and flip the session to error):
// - the Claude model-change gate must be alias-aware;
// - deliberate aborts must be swallowed whatever error shape the SDK throws
//   (its transport raises a plain Error named 'Error' with message
//   'Operation aborted', not an AbortError);
// - a stale (replaced/retired) handle's late teardown error must never flip
//   the live session to error — only the mapped handle may.
assert.equal(
  ipcSource.includes('!isSameClaudeModelSelection(nextModel, previousModel)'),
  true,
  'the continue model-change gate must compare alias-aware for Claude'
);
{
  const runnerSourceForAbort = fs.readFileSync(
    path.join(root, 'src', 'electron', 'libs', 'runner.ts'),
    'utf8'
  );
  assert.match(
    runnerSourceForAbort,
    /abortController\.signal\.aborted \|\|\s*\(error instanceof Error &&\s*\(error\.name === 'AbortError' \|\| \/operation aborted\/i\.test\(error\.message\)\)\)/,
    'the runner must swallow every deliberate-abort error shape'
  );
}
assert.match(
  ipcSource,
  /if \(mappedEntry\?\.handle !== handle\) \{\s*return;\s*\}/,
  'onError must silently drop errors from any stale (replaced) handle'
);

// Reuse must be cwd-guarded: a live runner is bound to its spawn cwd.
assert.equal(
  ipcSource.includes('cwd: runnerSession.cwd || null'),
  true,
  'runner entries must record their spawn cwd'
);
assert.equal(ipcSource.includes('runnerCwdChanged ||'), true, 'continue reuse must reject cwd mismatch');

// Replacing a runner must abort the stale handle BEFORE the new one spawns —
// provider-service stops are keyed by threadId and would otherwise race the
// replacement session.
{
  const staleAbortAt = ipcSource.indexOf('Never orphan a previous runner');
  const handleCreateAt = ipcSource.indexOf('const handle = runAgentLoop({');
  assert.equal(staleAbortAt >= 0 && handleCreateAt >= 0 && staleAbortAt < handleCreateAt, true,
    'startRunner must retire the stale entry before creating the replacement handle');
}
const agentLoopSource = fs.readFileSync(
  path.join(root, 'src', 'electron', 'libs', 'agent-loop.ts'),
  'utf8'
);
assert.equal(
  agentLoopSource.includes('pendingSessionStops'),
  true,
  'agent loop must serialize startSession behind a pending stop for the same thread'
);
// …and sends must queue behind the (possibly delayed) start: a follow-up
// send on a replacement runner must never hit an unregistered session.
{
  const sendAt = agentLoopSource.indexOf('send: (');
  const sendBody = sendAt >= 0 ? agentLoopSource.slice(sendAt) : '';
  assert.equal(
    sendBody.includes('startPromise'),
    true,
    'provider-service send must chain sendTurn behind startPromise'
  );
}

// The reuse branch must re-fetch the live entry right before dispatch and
// count the turn before send.
assert.equal(
  ipcSource.includes("runnerHandles.get(sessionId)?.handle !== existingEntry.handle"),
  true,
  'continue reuse must re-fetch the entry after the awaits'
);
assert.equal(
  ipcSource.includes('existingEntry.inFlightTurns = (existingEntry.inFlightTurns ?? 0) + 1'),
  true,
  'continue reuse must count the dispatched turn before send'
);

// Poisoned/one-shot runners must never be reused.
assert.equal(ipcSource.includes('poisonedEntry.doomed = true'), true, 'invalid-thinking dooming missing');
assert.equal(
  ipcSource.includes('sanitizedHistoryResult.hadInvalidThinking'),
  true,
  'continue must skip reuse when stored history was sanitized'
);
assert.equal(
  ipcSource.includes('currentEntry.doomed || currentEntry.autoApprove'),
  true,
  'doomed/automation runners must be retired at result'
);

// Busy gates must not treat handle presence as running.
assert.equal(
  ipcSource.includes('runnerHandles.has(session.id) ||'),
  false,
  'git-branch gate must use DB session status, not handle presence'
);
assert.equal(
  ipcSource.includes('runnerHandles.has(input.sessionId) ||'),
  false,
  'workspace-handoff gate must use DB session status, not handle presence'
);

// The pre-send runtime gate must be probe-cached (model-independent).
const statusSource = fs.readFileSync(
  path.join(root, 'src', 'electron', 'libs', 'claude-runtime-verdict.ts'),
  'utf8'
);
assert.equal(
  statusSource.includes('export function createClaudeRuntimeStatusCache'),
  true,
  'runtime status cache factory missing'
);
assert.equal(
  statusSource.includes('deriveClaudeRuntimeStatus(cachedProbe, model'),
  true,
  'cache must decide block-vs-serve on the derived per-model verdict'
);
assert.equal(
  statusSource.includes('generation === startedGeneration'),
  true,
  'a probe invalidated while in flight must not repopulate the cache'
);

// ── Compile + run the unit tests ─────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-claude-turn-latency-'));
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
    'scripts/tests/claude-runtime-cache.test.ts',
    'scripts/tests/claude-runner-pool.test.ts',
    'scripts/tests/claude-model-selection.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);

if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

for (const testFile of [
  'claude-runtime-cache.test.js',
  'claude-runner-pool.test.js',
  'claude-model-selection.test.js',
]) {
  const testPath = path.join(tmpDir, 'scripts', 'tests', testFile);
  const run = spawnSync(process.execPath, [testPath], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(run.status ?? 1);
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('claude-turn-latency: wiring checks passed');
