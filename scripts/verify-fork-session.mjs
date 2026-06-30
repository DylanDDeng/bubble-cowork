#!/usr/bin/env node
// Verifies the "fork conversation into a new pane" wiring end to end:
// SDK fork helper -> IPC handler (copies config + transcript) -> preload bridge
// -> store action -> pane header button.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// SDK fork helper
const util = read('src/electron/libs/util.ts');
assert.ok(
  util.includes('export async function forkClaudeAgentSession') &&
    util.includes('sdk.forkSession('),
  'util.ts must expose forkClaudeAgentSession calling sdk.forkSession'
);

// Main-process IPC handler: forks the Claude session, copies config + transcript
const ipc = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipc.includes("ipcMainHandle('fork-session'") &&
    ipc.includes('forkClaudeAgentSession(') &&
    ipc.includes('setClaudeSessionId(') &&
    ipc.includes('replaceSessionHistory(') &&
    ipc.includes('buildSessionInfoFromRow('),
  'fork-session handler must fork, set the new claude session id, copy history, and return SessionInfo'
);

// Preload bridge
const preload = read('src/electron/preload.cts');
assert.ok(
  preload.includes('forkSession:') && preload.includes("'fork-session'"),
  'preload must expose forkSession over the fork-session channel'
);

// Store action + view builder
const store = read('src/ui/store/useAppStore.ts');
assert.ok(
  store.includes('forkSessionToPane:') &&
    store.includes('window.electron.forkSession(') &&
    store.includes('freshSessionViewFromInfo(') &&
    /splitPaneAt\(active\.id, 'right', view\.id\)|placeSessionInPane\(active\.id, view\.id\)/.test(store),
  'forkSessionToPane must call the IPC, build a SessionView, and open it in a pane'
);

// Pane header button, gated to Claude sessions with a session id
const host = read('src/ui/components/WorkspaceHost.tsx');
assert.ok(
  host.includes('GitFork') &&
    host.includes('forkSessionToPane(leaf.sessionId)') &&
    host.includes('canFork') &&
    host.includes("session.provider === 'claude'") &&
    host.includes('session.claudeSessionId'),
  'WorkspaceHost must show a Fork button only for Claude sessions with a session id'
);

console.log('fork-session: wiring checks passed');
