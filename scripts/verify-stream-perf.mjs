#!/usr/bin/env node
// Verifies the streaming-performance work (P0 + P1):
//  - P0a: subagent stream_events are filtered out of the renderer broadcast
//  - P0b: the Claude Agent SDK import is warmed at app startup
//  - P0c: turn-latency instrumentation is wired (dispatch/init/first-output)
//  - P1:  renderer-side delta coalescer behavior (compiled unit tests) and
//         its store wiring (flush/discard rules per event type)

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

// ── Source wiring assertions ─────────────────────────────────────────────────

const ipcSource = fs.readFileSync(path.join(root, 'src', 'electron', 'ipc-handlers.ts'), 'utf8');

// P0a — subagent stream_events must not be broadcast.
assert.equal(
  ipcSource.includes("attributedMessage.type === 'stream_event' && Boolean(attributedMessage.parentToolUseId)"),
  true,
  'P0a: subagent stream_event broadcast filter missing'
);
assert.equal(
  ipcSource.includes('if (!isSubagentStreamEvent) {'),
  true,
  'P0a: broadcast must be gated on the subagent stream_event check'
);

// P0c — latency instrumentation wiring.
assert.equal(
  ipcSource.includes("markClaudePromptDispatched(session.id, 'cold-start', Boolean(resumeSessionId))"),
  true,
  'P0c: cold-start dispatch mark missing in startRunner'
);
assert.equal(
  ipcSource.includes("existingEntry.prewarmed ? 'prewarm-hit' : 'warm-reuse'"),
  true,
  'P0c: warm-reuse/prewarm-hit dispatch mark missing in the reuse send path'
);
assert.equal(ipcSource.includes('markClaudeInit(session.id)'), true, 'P0c: init mark missing');
assert.equal(
  ipcSource.includes('markClaudeFirstOutput(session.id)'),
  true,
  'P0c: first-output mark missing'
);
// first-output must be gated on real model output, NOT the host user echo
// (which lands at prompt-enqueue time and would zero out the metric).
assert.equal(
  /\(message\.type === 'assistant' \|\| message\.type === 'stream_event'\)\s*\)\s*\{\s*markClaudeFirstOutput/.test(
    ipcSource
  ),
  true,
  'P0c: first-output must be gated on assistant/stream_event, excluding the user echo'
);

// P0b — SDK import warmed at startup.
const mainSource = fs.readFileSync(path.join(root, 'src', 'electron', 'main.ts'), 'utf8');
assert.equal(
  mainSource.includes('preloadClaudeAgentSdk()'),
  true,
  'P0b: preloadClaudeAgentSdk() must run at app startup'
);
const runnerSource = fs.readFileSync(
  path.join(root, 'src', 'electron', 'libs', 'runner.ts'),
  'utf8'
);
assert.equal(
  runnerSource.includes('export function preloadClaudeAgentSdk'),
  true,
  'P0b: runner must export preloadClaudeAgentSdk'
);
assert.equal(
  runnerSource.includes('_claudeAgentSdkPromise'),
  true,
  'P0b: SDK import must be cached so preload benefits runClaude'
);

// P1 — store wiring: coalescer intercepts stream.message and every event
// that clears streaming state discards/flushes the buffer first.
const storeSource = fs.readFileSync(
  path.join(root, 'src', 'ui', 'store', 'useAppStore.ts'),
  'utf8'
);
assert.equal(
  storeSource.includes('const streamDeltaCoalescer = new StreamDeltaCoalescer()'),
  true,
  'P1: store must instantiate the coalescer'
);
assert.equal(
  storeSource.includes('if (!streamDeltaCoalescer.push(event.payload))'),
  true,
  'P1: stream.message must route through the coalescer'
);
assert.equal(
  (storeSource.match(/streamDeltaCoalescer\.discardSession\(/g) || []).length >= 4,
  true,
  'P1: non-running status, user_prompt, history reload and session delete must discard the buffer'
);
assert.equal(
  storeSource.includes("event.payload.status === 'running'"),
  true,
  'P1: running status must flush (not discard) the buffer'
);

// P2 — subscription narrowing + markdown memoization.
const appSource = fs.readFileSync(path.join(root, 'src', 'ui', 'App.tsx'), 'utf8');
assert.equal(
  appSource.includes("import { useShallow } from 'zustand/react/shallow'"),
  true,
  'P2: App must use shallow-picked store subscriptions'
);
assert.equal(
  /const activeSession = useAppStore\(/.test(appSource),
  true,
  'P2: App must subscribe to the active session via a narrow selector'
);
assert.equal(
  appSource.includes('sessionStatusFingerprint'),
  true,
  'P2: status-transition effect must subscribe to a status fingerprint, not the sessions map'
);
assert.equal(
  (appSource.match(/= useAppStore\(\);/g) || []).length,
  0,
  'P2: App must not contain whole-store subscriptions'
);
const chatPaneSource = fs.readFileSync(
  path.join(root, 'src', 'ui', 'components', 'ChatPane.tsx'),
  'utf8'
);
assert.equal(
  (chatPaneSource.match(/= useAppStore\(\);/g) || []).length,
  0,
  'P2: ChatPane must not contain whole-store subscriptions'
);
assert.equal(
  chatPaneSource.includes('s.sessions[sessionId] ?? null'),
  true,
  'P2: ChatPane must subscribe to its own session only'
);
const markdownSource = fs.readFileSync(
  path.join(root, 'src', 'ui', 'render', 'markdown.tsx'),
  'utf8'
);
assert.equal(
  markdownSource.includes('export const MDContent = memo(MDContentImpl)'),
  true,
  'P2: MDContent must be memoized so unchanged messages skip re-parsing'
);

// P3 — runner prewarm wiring.
assert.equal(
  ipcSource.includes("case 'runner.prewarm':"),
  true,
  'P3: runner.prewarm client event must be handled'
);
assert.equal(
  ipcSource.includes('async function handleRunnerPrewarm'),
  true,
  'P3: prewarm handler missing'
);
// Guards that reviewers flagged as user-visible-damage risks:
assert.equal(
  ipcSource.includes('sessions.getSessionHistory(sessionId).length > 0'),
  true,
  'P3: history-bootstrap guard missing (prewarm would bypass bootstrap and lose context)'
);
assert.equal(
  ipcSource.includes("initial.session_origin === 'claude_remote'"),
  true,
  'P3: read-only external session guard missing'
);
// The sync re-check after the awaited runtime probe (prewarm-vs-send race).
assert.equal(
  /const runtimeStatus = await getClaudeRuntimeStatusCached\(payload\.model \|\| null\);[\s\S]{0,600}if \(runnerHandles\.has\(sessionId\)\) return;/.test(
    ipcSource
  ),
  true,
  'P3: post-await sync re-check missing — prewarm could abort a live user turn'
);
// Prewarm entries must not fake a dispatched turn.
assert.equal(
  ipcSource.includes('inFlightTurns: prewarmRunner ? 0 : 1'),
  true,
  'P3: prewarm entry must start with zero in-flight turns'
);
assert.equal(
  ipcSource.includes('pendingTurnPrompts: prewarmRunner ? [] : [prompt]'),
  true,
  'P3: prewarm entry must not seed a phantom prompt into the turn FIFO'
);
assert.equal(
  ipcSource.includes('lastTurnEndedAt: prewarmRunner ? Date.now() : undefined'),
  true,
  'P3: prewarm entry must stamp an idle anchor or it can never be reaped'
);
assert.equal(
  ipcSource.includes('const MAX_PREWARMED_RUNNERS = 2'),
  true,
  'P3: prewarmed fleet cap missing'
);
// Prewarm must not fire when composer config diverges from the session row,
// or the send-path reuse check aborts it (model/provider/betas compare
// against the row) — a wasted spawn on top of the cold start.
assert.equal(
  ipcSource.includes('const configDivergesFromRow ='),
  true,
  'P3: prewarm must skip when composer config diverges from the session row'
);
// Composer trigger.
const promptInputSource = fs.readFileSync(
  path.join(root, 'src', 'ui', 'components', 'PromptInput.tsx'),
  'utf8'
);
assert.equal(
  promptInputSource.includes("type: 'runner.prewarm'"),
  true,
  'P3: composer must send the prewarm event'
);
assert.equal(
  promptInputSource.includes('prewarmedSessionRef'),
  true,
  'P3: prewarm must fire at most once per session per composer mount'
);

// ── Behavioral tests (compiled + run) ────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-stream-perf-'));
const tscBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);

try {
  const compile = spawnSync(
    tscBin,
    [
      '--target', 'ES2022',
      '--module', 'CommonJS',
      '--moduleResolution', 'Node',
      '--skipLibCheck',
      '--esModuleInterop',
      '--strict',
      '--outDir', tmpDir,
      'scripts/tests/stream-delta-coalescer.test.ts',
    ],
    { cwd: root, stdio: 'inherit' }
  );
  assert.equal(compile.status, 0, 'coalescer test compile failed');

  const run = spawnSync(
    process.execPath,
    [path.join(tmpDir, 'scripts', 'tests', 'stream-delta-coalescer.test.js')],
    { cwd: root, stdio: 'inherit' }
  );
  assert.equal(run.status, 0, 'coalescer tests failed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('verify-stream-perf: OK');
