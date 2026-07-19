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
    ipc.includes('bootstrapClaudeSessionFromHistory(') &&
    ipc.includes('copySessionHistory(') &&
    ipc.includes('buildSessionInfoFromRow('),
  'fork-session handler must bootstrap a fork point when needed, fork, copy history, and return SessionInfo'
);

// The transcript copy must re-key messages to avoid a messages.id collision.
const store2 = read('src/electron/libs/session-store.ts');
assert.ok(
  store2.includes('export function copySessionHistory') &&
    /uuidv4\(\)/.test(store2.split('copySessionHistory')[1] || '') &&
    (store2.split('copySessionHistory')[1] || '').includes('parentTurnId'),
  'copySessionHistory must re-key message uuids (and remap parentTurnId) to avoid a messages.id collision'
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

// Right-click context menu on the sidebar session row (in-app Base UI menu),
// gated to providers whose runtime can fork.
const tree = read('src/ui/components/FolderTreeView.tsx');
assert.ok(
  tree.includes('forkSessionToPane(session.id)') &&
    tree.includes('canFork') &&
    tree.includes('providerSupportsFork') &&
    tree.includes("session.provider === 'claude'") &&
    tree.includes("session.provider === 'kimi'"),
  'sidebar session items must offer Fork via the in-app context menu, gated to fork-capable providers (incl. kimi)'
);

// Kimi wiring: dispatch includes kimi, the provider thread id round-trips
// through kimi_session_id with the server: provenance guard.
assert.ok(
  ipc.includes("sourceProvider === 'codex' || sourceProvider === 'opencode' || sourceProvider === 'kimi'") &&
    ipc.includes('source.kimi_session_id') &&
    ipc.includes('updateKimiSessionId(fork.id, forkedThreadId)') &&
    ipc.includes("!providerThreadId.startsWith('server:')"),
  'fork must route kimi through kimi_session_id with the server-runtime provenance guard'
);

// Adapter rejections must resolve to the {ok:false} toast path, not an
// unhandled renderer rejection (return await, not bare return).
assert.ok(
  ipc.includes('return await forkProviderThreadSession(source, sourceProvider)'),
  'forkSessionInternal must await forkProviderThreadSession so adapter failures hit its catch'
);

console.log('fork-session: wiring checks passed');
