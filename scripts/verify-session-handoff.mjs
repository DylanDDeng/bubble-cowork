#!/usr/bin/env node
// Verifies the provider-handoff wiring end to end:
// session lock in the composer -> handoff dialog -> session-handoff IPC
// (new session + transcript copy + pending flag) -> first-prompt
// <handoff_context> injection in handleSessionContinue.
//
// Also runs a functional pass against the transpiled session-store (electron
// stubbed, scratch sqlite DB) when the native better-sqlite3 build is loadable
// from plain Node.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ---------- static wiring assertions ----------

// Schema + updaters
const store = read('src/electron/libs/session-store.ts');
assert.ok(
  store.includes("ensureColumn('sessions', 'handoff_source_provider', 'TEXT')") &&
    store.includes("ensureColumn('sessions', 'handoff_pending', 'INTEGER DEFAULT 0')"),
  'session-store must migrate handoff columns'
);
assert.ok(
  store.includes('export function setSessionHandoff') &&
    store.includes('export function clearSessionHandoffPending'),
  'session-store must expose handoff updaters'
);

// IPC handler: new session for the target provider, transcript copy, pending flag
const ipc = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipc.includes("'session-handoff',") &&
    ipc.includes('sessions.copySessionHistory(source.id, handoff.id)') &&
    ipc.includes('sessions.setSessionHandoff(handoff.id, sourceProvider)') &&
    ipc.includes('buildSessionInfoFromRow(row)'),
  'session-handoff handler must create the target session, copy the transcript, and mark handoff pending'
);
assert.ok(
  ipc.includes('targetProvider === sourceProvider') &&
    ipc.includes('there is no conversation to hand off yet'),
  'session-handoff handler must reject same-provider and empty-transcript handoffs'
);

// First-prompt injection + one-shot semantics + no double bootstrap
assert.ok(
  ipc.includes('buildHandoffContextText({') &&
    ipc.includes('<handoff_context>') &&
    ipc.includes('<latest_user_message>') &&
    ipc.includes('clearSessionHandoffPending(sessionId)'),
  'handleSessionContinue must inject <handoff_context> around the first prompt and clear the pending flag'
);
assert.ok(
  /!handoffContextText &&\s*\n\s*historyBeforeContinue\.length > 0/.test(ipc),
  'the Claude history bootstrap must be skipped when handoff context is being injected'
);

// Bootstrap text shape: earlier summary + recent verbatim within a budget
assert.ok(
  ipc.includes('HANDOFF_RECENT_MESSAGE_COUNT') &&
    ipc.includes('Earlier conversation summary:') &&
    ipc.includes('Most recent messages:') &&
    ipc.includes('HANDOFF_CONTEXT_MAX_CHARS'),
  'buildHandoffContextText must split earlier/recent messages under a char budget'
);

// SessionInfo surface for the UI badge
const shared = read('src/shared/types.ts');
assert.ok(
  shared.includes('handoffSourceProvider?: AgentProvider | null'),
  'SessionInfo must expose handoffSourceProvider'
);
assert.ok(
  ipc.includes('handoffSourceProvider: (row.handoff_source_provider'),
  'buildSessionInfoFromRow must map handoff_source_provider'
);

// Preload bridge + renderer typing
const preload = read('src/electron/preload.cts');
assert.ok(
  preload.includes('sessionHandoff:') && preload.includes("'session-handoff'"),
  'preload must expose sessionHandoff over the session-handoff channel'
);
assert.ok(
  read('src/types.d.ts').includes('sessionHandoff: (payload:'),
  'types.d.ts must declare sessionHandoff'
);

// Store action: same-pane takeover
const appStore = read('src/ui/store/useAppStore.ts');
assert.ok(
  appStore.includes('handoffSessionToProvider:') &&
    appStore.includes('window.electron.sessionHandoff(') &&
    appStore.includes('placeSessionInPane(active.id, view.id)'),
  'handoffSessionToProvider must call the IPC and take over the focused pane'
);
assert.ok(
  appStore.includes('handoffSourceProvider: info.handoffSourceProvider'),
  'freshSessionViewFromInfo must carry handoffSourceProvider to the SessionView'
);

// Composer: provider lock + dialog instead of silent switch
const promptInput = read('src/ui/components/PromptInput.tsx');
assert.ok(
  promptInput.includes('sessionProviderLocked') &&
    promptInput.includes('setHandoffTarget(nextProvider)') &&
    promptInput.includes('onAgentChange={handleAgentChange}'),
  'PromptInput must intercept provider switches on locked sessions'
);
assert.ok(
  promptInput.includes('Hand off to') && promptInput.includes('handoffSessionToProvider('),
  'PromptInput must render the handoff confirm dialog wired to the store action'
);
assert.ok(
  promptInput.includes('Handoff from {providerLabel(activeSession.handoffSourceProvider)}'),
  'PromptInput must show the handoff-source badge'
);

console.log('static wiring assertions passed');

// ---------- functional pass (transpiled session-store, electron stubbed) ----------

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-handoff-verify-'));
const require2 = createRequire(import.meta.url);
const Module = require2('module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => scratchDir } };
  }
  return originalLoad.call(this, request, ...rest);
};

let sessionsLib;
try {
  sessionsLib = require2(path.join(root, 'dist-electron/electron/libs/session-store.js'));
  sessionsLib.initialize();
} catch (error) {
  console.log(`functional pass SKIPPED (session-store not loadable in plain Node): ${error.message}`);
  process.exit(0);
}

try {
  const source = sessionsLib.createSession({
    title: 'Handoff verify',
    cwd: scratchDir,
    provider: 'claude',
  });
  sessionsLib.addMessage(source.id, {
    type: 'user_prompt',
    prompt: 'Please add a retry helper to http.ts',
    createdAt: Date.now(),
  });

  // Simulate the IPC handler's session-side effects.
  const handoff = sessionsLib.createSession({
    title: source.title,
    cwd: scratchDir,
    provider: 'codex',
  });
  sessionsLib.copySessionHistory(source.id, handoff.id);
  sessionsLib.setSessionHandoff(handoff.id, 'claude');

  const row = sessionsLib.getSession(handoff.id);
  assert.equal(row.provider, 'codex', 'handoff session must be created for the target provider');
  assert.equal(row.handoff_source_provider, 'claude', 'source provider must be persisted');
  assert.equal(row.handoff_pending, 1, 'handoff must start pending');
  assert.equal(
    row.claude_session_id ?? null,
    null,
    'handoff session must not inherit any provider resume id'
  );
  const history = sessionsLib.getSessionHistory(handoff.id);
  assert.ok(
    history.some((m) => m.type === 'user_prompt' && m.prompt.includes('retry helper')),
    'transcript must be copied into the handoff session'
  );

  sessionsLib.clearSessionHandoffPending(handoff.id);
  assert.equal(
    sessionsLib.getSession(handoff.id).handoff_pending,
    0,
    'pending flag must clear after the first prompt'
  );

  console.log('functional session-store pass passed');
} finally {
  Module._load = originalLoad;
  fs.rmSync(scratchDir, { recursive: true, force: true });
}

console.log('verify-session-handoff: all checks passed');
