#!/usr/bin/env node
// Verifies the provider-handoff wiring end to end:
// session lock in the composer -> handoff dialog -> session-handoff IPC
// (new session + transcript copy + pending flag + source session id) ->
// first-prompt <handoff_context> brief in handleSessionContinue.
//
// Also runs functional passes against the transpiled handoff brief builder
// and session-store (electron stubbed, scratch sqlite DB) when the native
// better-sqlite3 build is loadable from plain Node.

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
    store.includes("ensureColumn('sessions', 'handoff_pending', 'INTEGER DEFAULT 0')") &&
    store.includes("ensureColumn('sessions', 'handoff_source_session_id', 'TEXT')"),
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
    ipc.includes('sessions.setSessionHandoff(handoff.id, sourceProvider, source.id)') &&
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
  ipc.includes('buildHandoffBrief({') &&
    ipc.includes('<handoff_context>') &&
    ipc.includes('<latest_user_message>') &&
    ipc.includes('clearSessionHandoffPending(sessionId)'),
  'handleSessionContinue must inject <handoff_context> around the first prompt and clear the pending flag'
);
assert.ok(
  /!handoffContextText &&\s*\n\s*historyBeforeContinue\.length > 0/.test(ipc),
  'the Claude history bootstrap must be skipped when handoff context is being injected'
);

// The brief links the source conversation only for runtimes with read_session.
assert.ok(
  ipc.includes('referenceSessionId: supportsSessionReferences(nextProvider)') &&
    ipc.includes('resolveHandoffReferenceSessionId(session)') &&
    ipc.includes('workspace: await readHandoffWorkspace(session.cwd)'),
  'handleSessionContinue must pass the reference, goal and live workspace to the brief'
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
assert.ok(
  appStore.includes('handoffSourceProvider: session.handoffSourceProvider || null'),
  'session.list reconstruction must preserve handoffSourceProvider after reload'
);

// Composer: provider lock + dialog instead of silent switch
const promptInput = read('src/ui/components/PromptInput.tsx');
assert.ok(
  promptInput.includes('sessionProviderLocked') &&
    promptInput.includes('void requestHandoff(nextProvider)') &&
    promptInput.includes('onAgentChange={handleAgentChange}'),
  'PromptInput must intercept provider switches on locked sessions'
);
assert.ok(
  promptInput.includes('confirmDialog({') && promptInput.includes('Hand off to') && promptInput.includes('handoffSessionToProvider('),
  'PromptInput must render the handoff confirm dialog wired to the store action'
);

// Handoff provenance belongs with the session identity, not the composer.
const handoffIndicator = read('src/ui/components/SessionHandoffIndicator.tsx');
assert.ok(
  handoffIndicator.includes('export function SessionHandoffProviderRoute') &&
    !handoffIndicator.includes('export function SessionHandoffBadge'),
  'the shared handoff indicator must expose one consistent provider-route style'
);
const appSource = read('src/ui/App.tsx');
const chatPaneSource = read('src/ui/components/ChatPane.tsx');
const appHeaderHandoffStart = appSource.indexOf('{activeSession?.handoffSourceProvider ?');
const appHeaderRouteIndex = appSource.indexOf('<SessionHandoffProviderRoute', appHeaderHandoffStart);
const appHeaderTitleIndex = appSource.indexOf('<SessionTitleActions session={activeSession}', appHeaderHandoffStart);
const chatPaneHandoffStart = chatPaneSource.indexOf('{session.handoffSourceProvider ?');
const chatPaneRouteIndex = chatPaneSource.indexOf('<SessionHandoffProviderRoute', chatPaneHandoffStart);
const chatPaneTitleIndex = chatPaneSource.indexOf('<SessionTitleActions session={session}', chatPaneHandoffStart);
assert.ok(
  appHeaderHandoffStart >= 0 &&
    appHeaderRouteIndex >= 0 &&
    appHeaderRouteIndex < appHeaderTitleIndex &&
    appSource.includes('targetProvider={activeSession.provider') &&
    chatPaneHandoffStart >= 0 &&
    chatPaneRouteIndex >= 0 &&
    chatPaneRouteIndex < chatPaneTitleIndex &&
    chatPaneSource.includes('targetProvider={session.provider'),
  'global and split-pane headers must show the provider route before the title, matching the sidebar'
);
assert.ok(
  read('src/ui/components/FolderTreeView.tsx').includes('<SessionHandoffProviderRoute') &&
    read('src/ui/components/FolderTreeView.tsx').includes('targetProvider={session.provider'),
  'project session rows must show source-to-target provider icons for handoff sessions'
);
assert.ok(
  !promptInput.includes('Handoff from {providerLabel(activeSession.handoffSourceProvider)}'),
  'the composer must not duplicate the handoff-source marker'
);

console.log('static wiring assertions passed');

// ---------- functional pass: handoff brief ----------

{
  const require1 = createRequire(import.meta.url);
  const { buildHandoffBrief } = require1(path.join(root, 'dist-electron/electron/libs/session-handoff.js'));
  const assistant = (content) => ({ type: 'assistant', message: { content } });
  const history = [
    { type: 'user_prompt', prompt: 'Add a retry helper to src/http.ts' },
    assistant([
      { type: 'text', text: 'Planning the helper.' },
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [
        { content: 'Write retry helper', status: 'completed' },
        { content: 'Cover it with tests', status: 'in_progress' },
      ] } },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/src/http.ts' } },
    ]),
    { type: 'user_prompt', prompt: 'Subagent noise', parentToolUseId: 'task-1' },
    assistant([{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: '/repo/test/http.test.ts' } }]),
    { type: 'assistant', message: { content: [{ type: 'text', text: '**Session usage** 12k tokens' }] } },
    { type: 'user_prompt', prompt: 'Now make the backoff exponential' },
    assistant([{ type: 'text', text: 'Switched to exponential backoff capped at 30s.' }]),
  ];
  const workspace = { cwd: '/repo', branch: 'feat/retry', status: [' M src/http.ts', '?? test/http.test.ts'] };

  const linked = buildHandoffBrief({
    history,
    title: 'Retry helper',
    sourceProvider: 'claude',
    referenceSessionId: '11111111-2222-3333-4444-555555555555',
    goal: { objective: 'Ship resilient HTTP calls', status: 'active' },
    workspace,
  });
  for (const expected of [
    'taking over this conversation from claude',
    'aegis://sessions/11111111-2222-3333-4444-555555555555',
    'Call read_session with sessionId "11111111-2222-3333-4444-555555555555"',
    '## Goal\nShip resilient HTTP calls (status: active)',
    '## Original request\nAdd a retry helper to src/http.ts',
    'Branch: feat/retry',
    ' M src/http.ts',
    '- src/http.ts',
    '- test/http.test.ts',
    '- [x] Write retry helper',
    '- [ ] Cover it with tests (in progress)',
    'User:\nNow make the backoff exponential',
    'Assistant:\nSwitched to exponential backoff capped at 30s.',
  ]) {
    assert.ok(linked.includes(expected), `linked brief must include ${JSON.stringify(expected)}\n---\n${linked}`);
  }
  assert.ok(!linked.includes('Subagent noise'), 'subagent prompts must stay out of the brief');
  assert.ok(!linked.includes('Session usage'), 'Aegis utility rows must stay out of the brief');
  assert.ok(!linked.includes('## Earlier turns'), 'linked briefs page history through read_session instead of inlining it');

  const inline = buildHandoffBrief({
    history,
    title: 'Retry helper',
    sourceProvider: 'claude',
    referenceSessionId: null,
    workspace: null,
  });
  assert.ok(!inline.includes('aegis://sessions/') && !inline.includes('read_session'), 'runtimes without a reader must not be told to call read_session');
  assert.ok(inline.includes('## Earlier turns (most recent 2)') && inline.includes('Planning the helper.'), 'runtimes without a reader get earlier turns inline');
  assert.ok(!inline.includes('## Workspace') && !inline.includes('## Goal'), 'missing goal/workspace sections are omitted');

  const interrupted = buildHandoffBrief({
    history: [{ type: 'user_prompt', prompt: 'Start the migration' }],
    title: 'Migration',
    sourceProvider: 'codex',
    referenceSessionId: null,
  });
  assert.ok(interrupted.includes('No reply was recorded'), 'an unanswered last prompt must be flagged');
  assert.ok(!interrupted.includes('## Original request'), 'a single-turn conversation must not repeat the request');
  assert.equal(
    buildHandoffBrief({ history: [], title: 'Empty', sourceProvider: 'claude', referenceSessionId: null }),
    null,
    'an empty conversation yields no brief'
  );

  // A long history must never push the latest exchange out of the brief.
  const long = (label) => `${label} ${'x'.repeat(6_000)}`;
  const longHistory = [];
  for (let index = 0; index < 6; index += 1) {
    longHistory.push({ type: 'user_prompt', prompt: long(`earlier user ${index}`) });
    longHistory.push(assistant([{ type: 'text', text: long(`earlier reply ${index}`) }]));
  }
  longHistory.push({ type: 'user_prompt', prompt: long('LATEST-USER-MARKER') });
  longHistory.push(assistant([{ type: 'text', text: long('LATEST-REPLY-MARKER') }]));
  for (const referenceSessionId of [null, '11111111-2222-3333-4444-555555555555']) {
    const brief = buildHandoffBrief({
      history: longHistory,
      title: 'Long',
      sourceProvider: 'claude',
      referenceSessionId,
      goal: { objective: long('goal'), status: 'active' },
      workspace: { cwd: '/repo', branch: 'main', status: Array.from({ length: 60 }, (_, index) => ` M src/file-${index}.ts`) },
    });
    assert.ok(brief.length <= 32_000, `brief must stay within its budget (got ${brief.length})`);
    assert.ok(brief.includes('User:\nLATEST-USER-MARKER') && brief.includes('Assistant:\nLATEST-REPLY-MARKER'), 'both sides of the latest exchange must survive a long history');
    assert.ok(brief.trimEnd().endsWith('…'), 'the latest reply is truncated by its own limit, not dropped');
    if (!referenceSessionId) {
      assert.ok(brief.includes('## Earlier turns') && brief.includes('earlier reply 5'), 'the newest earlier turns fill the remaining budget');
      assert.ok(!brief.includes('earlier user 1 '), 'the oldest inline turns are the ones dropped');
    }
  }

  console.log('functional handoff brief pass passed');
}

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
  sessionsLib.setSessionHandoff(handoff.id, 'claude', source.id);

  const row = sessionsLib.getSession(handoff.id);
  assert.equal(row.provider, 'codex', 'handoff session must be created for the target provider');
  assert.equal(row.handoff_source_provider, 'claude', 'source provider must be persisted');
  assert.equal(row.handoff_pending, 1, 'handoff must start pending');
  assert.equal(row.handoff_source_session_id, source.id, 'source session id must be persisted for the brief link');
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
