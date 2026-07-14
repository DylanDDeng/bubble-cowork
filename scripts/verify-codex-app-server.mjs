#!/usr/bin/env node
// Runtime verification for the codex app-server P0 fixes (P0-1..P0-9, see
// codex-appserver-p0-fix-plan.md). Two layers:
//   L1 in-process — drive the compiled manager/adapter with captured outbound
//      JSON and injected notifications/responses (no process).
//   L2 fake binary — a real spawned fake app-server for the lifecycle races
//      (spawn barrier, initialize failure retry, crash mid-turn).
// Requires `npm run transpile:electron` to have produced dist-electron.

// Test-only timeout overrides — MUST be set before the module loads.
// Initialize must absorb a cold node boot of the fake binary (~1s on CI).
process.env.AEGIS_CODEX_INITIALIZE_TIMEOUT_MS = '3000';
process.env.AEGIS_CODEX_REQUEST_TIMEOUT_MS = '2000';
process.env.AEGIS_CODEX_TURN_TIMEOUT_MS = '4000';
process.env.AEGIS_CODEX_STOP_CONFIRM_TIMEOUT_MS = '250';

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  CodexAppServerManager,
  CodexRpcError,
  CodexRpcTransportError,
  CodexThreadBindingError,
  resolveFastTier,
} = require('../dist-electron/electron/libs/provider/codex-app-server-manager.js');
const { CodexAdapter } = require('../dist-electron/electron/libs/provider/codex-adapter.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = join(__dirname, 'fake-codex-app-server.mjs');
chmodSync(FAKE_BIN, 0o755);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/**
 * In-process manager: initialized, generation=1, fake child stub, outbound
 * captured, per-method auto-responders.
 */
function createCapturingManager() {
  const manager = new CodexAppServerManager('/nonexistent-codex-binary', '9.9.9-test');
  manager.initialized = true;
  manager.generation = 1;
  manager.child = { stdin: { writable: true, write() {} }, kill() {} };
  const outbound = [];
  const responders = new Map();
  manager.writeMessage = (message) => {
    outbound.push(message);
    if (message && message.id !== undefined && message.method) {
      const responder = responders.get(message.method);
      if (responder) {
        const reply = responder(message);
        if (reply !== undefined) {
          setImmediate(() =>
            manager.handleStdoutLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }))
          );
        }
      }
    }
  };
  const notify = (method, params) =>
    manager.handleStdoutLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
  const serverRequest = (id, method, params) =>
    manager.handleStdoutLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  const collect = (event) => {
    const seen = [];
    manager.on(event, (payload) => seen.push(payload));
    return seen;
  };
  return { manager, outbound, responders, notify, serverRequest, collect };
}

function seedSession(manager, threadId, providerThreadId, extra = {}) {
  manager.sessions.set(threadId, {
    threadId,
    providerThreadId,
    generation: manager.generation,
    cwd: '/tmp/proj',
    status: 'ready',
    model: 'fake-model',
    ...extra,
  });
}

/** Adapter wired to a capturing manager. */
function createCapturingAdapter() {
  const adapter = new CodexAdapter('/nonexistent-codex-binary');
  const manager = adapter.manager;
  manager.initialized = true;
  manager.generation = 1;
  manager.child = { stdin: { writable: true, write() {} }, kill() {} };
  const outbound = [];
  const responders = new Map();
  manager.writeMessage = (message) => {
    outbound.push(message);
    if (message && message.id !== undefined && message.method) {
      const responder = responders.get(message.method);
      if (responder) {
        const reply = responder(message);
        if (reply !== undefined) {
          setImmediate(() =>
            manager.handleStdoutLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }))
          );
        }
      }
    }
  };
  const events = [];
  adapter.events.on('event', (event) => events.push(event));
  const notify = (method, params) =>
    manager.handleStdoutLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
  return { adapter, manager, outbound, responders, events, notify };
}

const results = (events) => events.filter((e) => e.type === 'message' && e.message.type === 'result');
const errorEvents = (events) => events.filter((e) => e.type === 'error');
const noticeTexts = (events) =>
  events
    .filter((e) => e.type === 'message' && e.message.type === 'assistant')
    .map((e) => e.message.message?.content?.[0]?.text || '');

// ── P0-1: turn terminal dispatch ──────────────────────────────────────────
async function testTurnTerminals() {
  console.log('P0-1 turn terminals');

  // failed + trailing thread/status/changed(ready) → one error result, no success
  {
    const { adapter, manager, events, notify } = createCapturingAdapter();
    manager.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, cwd: '/tmp', status: 'running', activeTurnId: 'turn-1' });
    adapter.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, status: 'running' });
    notify('turn/completed', { threadId: 'p1', turn: { id: 'turn-1', status: 'failed', error: { message: 'boom', codexErrorInfo: null, additionalDetails: null } } });
    notify('thread/status/changed', { threadId: 'p1', status: { type: 'idle' } });
    await sleep(10);
    const rs = results(events);
    assert.equal(rs.length, 1, `expected exactly one result, got ${rs.length}`);
    assert.equal(rs[0].message.subtype, 'error');
    const errs = errorEvents(events);
    assert.equal(errs.length, 1);
    assert.match(errs[0].error.message, /boom/);
    const errIndex = events.indexOf(errs[0]);
    const resultIndex = events.indexOf(rs[0]);
    assert.ok(errIndex < resultIndex, 'error event must precede the error result');
    ok('failed turn → single error result (status/changed emits nothing)');
  }

  // interrupted → success result, no error status
  {
    const { adapter, manager, events, notify } = createCapturingAdapter();
    manager.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, cwd: '/tmp', status: 'running', activeTurnId: 'turn-1' });
    adapter.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, status: 'running' });
    notify('turn/completed', { threadId: 'p1', turn: { id: 'turn-1', status: 'interrupted', error: null } });
    await sleep(10);
    const rs = results(events);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].message.subtype, 'success');
    assert.equal(errorEvents(events).length, 0);
    ok('interrupted turn → success result, no error');
  }

  // willRetry=true → notice, session stays running, no error
  {
    const { adapter, manager, events, notify } = createCapturingAdapter();
    manager.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, cwd: '/tmp', status: 'running', activeTurnId: 'turn-1' });
    adapter.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, status: 'running' });
    notify('error', { threadId: 'p1', turnId: 'turn-1', error: { message: 'transient blip' }, willRetry: true });
    await sleep(10);
    assert.equal(errorEvents(events).length, 0, 'willRetry must not surface an error');
    assert.equal(manager.sessions.get('t1').status, 'running', 'manager session must stay running');
    assert.ok(noticeTexts(events).some((t) => t.includes('retrying after a transient error')));
    ok('willRetry=true → retry notice, session stays running');
  }

  // willRetry=false then turn/completed(failed) same turn → single error event
  {
    const { adapter, manager, events, notify } = createCapturingAdapter();
    manager.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, cwd: '/tmp', status: 'running', activeTurnId: 'turn-1' });
    adapter.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, status: 'running' });
    notify('error', { threadId: 'p1', turnId: 'turn-1', error: { message: 'hard fail' }, willRetry: false });
    notify('turn/completed', { threadId: 'p1', turn: { id: 'turn-1', status: 'failed', error: { message: 'hard fail' } } });
    await sleep(10);
    assert.equal(errorEvents(events).length, 1, 'same-turn failure must be reported once');
    const rs = results(events);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].message.subtype, 'error');
    ok('error(willRetry=false) + failed terminal → deduped error');
  }
}

// ── P0-2: auto permission mode ────────────────────────────────────────────
async function testAutoPermissionMode() {
  console.log('P0-2 auto permission mode');
  const { manager, outbound, responders } = createCapturingManager();
  seedSession(manager, 't1', 'p1', { codexPermissionMode: 'auto' });
  responders.set('turn/start', () => ({ result: { turn: { id: 'turn-1' } } }));
  responders.set('model/list', () => ({ result: { items: [], nextCursor: null } }));
  await manager.sendTurn('t1', 'hello', undefined, undefined, undefined, { codexPermissionMode: 'auto' });
  const turnStart = outbound.find((m) => m.method === 'turn/start');
  assert.ok(turnStart, 'turn/start must be sent');
  assert.equal(turnStart.params.approvalsReviewer, 'auto_review');
  assert.equal(turnStart.params.approvalPolicy, 'on-request');
  assert.ok(!('permissionMode' in turnStart.params), 'permissionMode is not a protocol field');
  ok('auto mode → approvalsReviewer auto_review, no permissionMode');

  // Regression pin: default/fullAccess/plan permission fields unchanged
  const cases = [
    ['defaultPermissions', 'execute', { approvalPolicy: 'on-request', approvalsReviewer: 'user' }],
    ['fullAccess', 'execute', { approvalPolicy: 'never', approvalsReviewer: 'user' }],
    ['defaultPermissions', 'plan', { approvalPolicy: 'on-request', approvalsReviewer: 'user' }],
  ];
  for (const [mode, exec, expected] of cases) {
    const params = manager.buildTurnPermissionOptions('/tmp/proj', mode, exec);
    assert.equal(params.approvalPolicy, expected.approvalPolicy, `${mode}/${exec} approvalPolicy`);
    assert.equal(params.approvalsReviewer, expected.approvalsReviewer, `${mode}/${exec} reviewer`);
    assert.ok(!('permissionMode' in params));
  }
  ok('default/fullAccess/plan permission fields pinned');

  // Source-level pin: the ipc normalizer preserves 'auto' (ipc-handlers
  // imports electron, so it can only be asserted at source level here).
  const ipcSource = readFileSync(join(__dirname, '../src/electron/ipc-handlers.ts'), 'utf8');
  assert.match(
    ipcSource,
    /value === 'auto' \|\| value === 'autoReview'\) return 'auto'/,
    'ipc normalizeCodexPermissionMode must preserve auto'
  );
  ok("ipc normalizer preserves 'auto' (source pin)");
}

// ── P0-3: serviceTier / fast mode ─────────────────────────────────────────
async function testServiceTier() {
  console.log('P0-3 serviceTier');
  const { manager, outbound, responders, collect } = createCapturingManager();
  const unavailable = collect('fast_mode_unavailable');
  seedSession(manager, 't1', 'p1');
  manager.modelCatalog = {
    generation: 1,
    models: [
      {
        id: 'fake-model', model: 'fake-model', displayName: 'Fake', hidden: false,
        serviceTiers: [
          { id: 'standard', name: 'Standard', description: '' },
          { id: 'priority', name: 'Priority', description: '' },
        ],
        defaultServiceTier: 'standard',
        supportedReasoningEfforts: [], defaultReasoningEffort: null,
      },
      {
        id: 'flat-model', model: 'flat-model', displayName: 'Flat', hidden: false,
        serviceTiers: [{ id: 'standard', name: 'Standard', description: '' }],
        defaultServiceTier: 'standard',
        supportedReasoningEfforts: [], defaultReasoningEffort: null,
      },
    ],
  };
  responders.set('turn/start', () => ({ result: { turn: { id: `turn-${outbound.length}` } } }));

  // on → tier id
  await manager.sendTurn('t1', 'x', undefined, undefined, undefined, { codexFastMode: true });
  // off → explicit null (sticky clear)
  manager.sessions.get('t1').status = 'ready';
  manager.sessions.get('t1').activeTurnId = undefined;
  await manager.sendTurn('t1', 'x', undefined, undefined, undefined, { codexFastMode: false });
  // on again
  manager.sessions.get('t1').status = 'ready';
  manager.sessions.get('t1').activeTurnId = undefined;
  await manager.sendTurn('t1', 'x', undefined, undefined, undefined, { codexFastMode: true });

  const turnStarts = outbound.filter((m) => m.method === 'turn/start');
  assert.equal(turnStarts.length, 3);
  assert.equal(turnStarts[0].params.serviceTier, 'priority');
  assert.strictEqual(turnStarts[1].params.serviceTier, null, 'fast off must send explicit null');
  assert.equal(turnStarts[2].params.serviceTier, 'priority');
  assert.ok(turnStarts.every((m) => typeof m.params.cwd === 'string' && m.params.cwd));
  ok('fast on/off/on → tier / explicit null / tier (+ sticky cwd)');

  // no resolvable tier → no field + one-shot notice
  const flat = manager.sessions.get('t1');
  flat.status = 'ready';
  flat.activeTurnId = undefined;
  flat.model = 'flat-model';
  await manager.sendTurn('t1', 'x', undefined, undefined, undefined, { codexFastMode: true, model: 'flat-model' });
  flat.status = 'ready';
  flat.activeTurnId = undefined;
  await manager.sendTurn('t1', 'x', undefined, undefined, undefined, { codexFastMode: true, model: 'flat-model' });
  const flatTurns = outbound.filter((m) => m.method === 'turn/start').slice(3);
  assert.equal(flatTurns.length, 2);
  assert.ok(!('serviceTier' in flatTurns[0].params), 'unresolvable tier must omit the field');
  assert.equal(unavailable.length, 1, 'fast-unavailable notice must fire once per session+model');
  ok('no non-default tier → field omitted + single notice');

  // resolveFastTier unit: 0 / 1 / N branches
  assert.equal(resolveFastTier({ serviceTiers: [{ id: 'a', name: 'A', description: '' }], defaultServiceTier: 'a' }), null);
  assert.equal(
    resolveFastTier({ serviceTiers: [{ id: 'a', name: 'A', description: '' }, { id: 'b', name: 'B', description: '' }], defaultServiceTier: 'a' })?.id,
    'b'
  );
  assert.equal(
    resolveFastTier({
      serviceTiers: [
        { id: 'a', name: 'A', description: '' },
        { id: 'b', name: 'B', description: '' },
        { id: 'c', name: 'C', description: '' },
      ],
      defaultServiceTier: 'a',
    }),
    null
  );
  ok('resolveFastTier 0/1/N branches');

  // thread/start never carries serviceTier
  const { manager: m2, outbound: out2, responders: r2 } = createCapturingManager();
  r2.set('thread/start', () => ({ result: { thread: { id: 'p-new', model: 'fake-model' }, cwd: '/tmp/proj' } }));
  await m2.createSession('t2', '/tmp/proj', undefined, { codexFastMode: true });
  const threadStart = out2.find((m) => m.method === 'thread/start');
  assert.ok(threadStart);
  assert.ok(!('serviceTier' in threadStart.params), 'thread/start must not carry serviceTier');
  ok('thread/start never carries serviceTier');
}

// ── P0-4: MCP status parse + routing ──────────────────────────────────────
async function testMcpStatus() {
  console.log('P0-4 MCP status');
  const { manager, notify, collect } = createCapturingManager();
  seedSession(manager, 't1', 'p1');
  seedSession(manager, 't2', 'p2');
  const updates = collect('mcp_status_updated');

  // flat object, matching thread → routed to that session only
  notify('mcpServer/startupStatus/updated', { threadId: 'p1', name: 'github', status: 'ready', error: null, failureReason: null });
  // flat object, unknown thread → dropped
  notify('mcpServer/startupStatus/updated', { threadId: 'p-unknown', name: 'gone', status: 'ready', error: null, failureReason: null });
  // flat object, null thread → broadcast
  notify('mcpServer/startupStatus/updated', { threadId: null, name: 'global', status: 'failed', error: 'auth', failureReason: 'reauthenticationRequired' });
  // legacy array shape still parses
  notify('mcpServer/startupStatus/updated', { threadId: 'p1', servers: [{ name: 'legacy', status: 'connected' }] });

  assert.equal(updates.length, 3, 'unknown-thread update must be dropped');
  assert.equal(updates[0].threadId, 't1');
  assert.equal(updates[0].servers[0].name, 'github');
  assert.equal(updates[0].servers[0].status, 'connected');
  assert.equal(updates[1].threadId, null, 'null threadId → broadcast marker');
  assert.equal(updates[1].servers[0].failureReason, 'reauthenticationRequired');
  assert.equal(updates[1].servers[0].status, 'failed');
  assert.equal(updates[2].servers[0].name, 'legacy');
  ok('flat parse, exact routing, drop, broadcast, failureReason, legacy fallback');
}

// ── P0-5: resume ──────────────────────────────────────────────────────────
async function testResume() {
  console.log('P0-5 resume');

  // resume params carry cwd + permission fields; effective cwd read back
  {
    const { manager, outbound, responders } = createCapturingManager();
    responders.set('thread/resume', () => ({
      result: { thread: { id: 'p-resumed', model: 'fake-model' }, cwd: '/tmp/effective' },
    }));
    const created = await manager.createSession('t1', '/tmp/requested', 'p-resumed', {
      codexPermissionMode: 'auto',
    });
    const resume = outbound.find((m) => m.method === 'thread/resume');
    assert.ok(resume);
    assert.equal(resume.params.cwd, '/tmp/requested');
    assert.equal(resume.params.approvalsReviewer, 'auto_review');
    assert.strictEqual(resume.params.serviceTier, null, 'fast-off resume sends explicit null');
    assert.equal(created.resumeFallback, undefined);
    assert.equal(manager.sessions.get('t1').cwd, '/tmp/effective', 'server effective cwd wins');
    ok('resume params + effective-cwd readback');
  }

  // resume RPC failure → fresh thread + resumeFallback + notice at adapter level
  {
    const { adapter, manager, responders, events } = createCapturingAdapter();
    responders.set('thread/resume', () => ({ error: { code: -32602, message: 'thread not found' } }));
    responders.set('thread/start', () => ({
      result: { thread: { id: 'p-fresh', model: 'fake-model' }, cwd: '/tmp/proj' },
    }));
    const session = await adapter.startSession({
      provider: 'codex', threadId: 't1', cwd: '/tmp/proj', prompt: '', resumeSessionId: 'p-dead',
    });
    assert.equal(session.providerSessionId, 'p-fresh');
    assert.ok(
      noticeTexts(events).some((t) => t.includes('Could not restore the previous Codex thread')),
      'resume fallback must surface a visible notice'
    );
    ok('resume failure → fresh thread + visible notice');
  }

  // double binding → typed error, no silent fallback
  {
    const { manager } = createCapturingManager();
    seedSession(manager, 'existing', 'p-shared');
    await assert.rejects(
      () => manager.createSession('other', '/tmp/proj', 'p-shared'),
      (error) => error instanceof CodexThreadBindingError
    );
    ok('double binding rejected with typed error');
  }

  // thread/load is gone from the codebase
  const managerSource = readFileSync(
    join(__dirname, '../src/electron/libs/provider/codex-app-server-manager.ts'),
    'utf8'
  );
  assert.ok(!managerSource.includes("'thread/load'"), 'thread/load must not be called (not in 0.144.x)');
  ok('no thread/load calls (source pin)');
}

// ── P0-6: two-phase stop ──────────────────────────────────────────────────
async function testTwoPhaseStop() {
  console.log('P0-6 two-phase stop');

  // confirmed stop: interrupt → terminal → stop_settled(confirmed) + deferred deletion
  {
    const { manager, outbound, responders, notify, collect } = createCapturingManager();
    const settled = collect('stop_settled');
    seedSession(manager, 't1', 'p1', { status: 'running', activeTurnId: 'turn-1' });
    responders.set('turn/interrupt', () => ({ result: {} }));
    await manager.stopSession('t1');
    const interrupt = outbound.find((m) => m.method === 'turn/interrupt');
    assert.ok(interrupt);
    assert.equal(interrupt.params.turnId, 'turn-1');
    assert.equal(manager.sessions.get('t1').status, 'interrupting');
    assert.equal(settled.length, 0, 'must not settle before the terminal');
    notify('turn/completed', { threadId: 'p1', turn: { id: 'turn-1', status: 'interrupted', error: null } });
    await sleep(10);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].confirmed, true);
    assert.ok(!manager.sessions.has('t1'), 'session deleted after settle');
    ok('interrupt → terminal → stop_settled(confirmed=true) + deletion');
  }

  // steer gate: send during interrupting goes to turn/start, not steer
  {
    const { manager, outbound, responders } = createCapturingManager();
    seedSession(manager, 't1', 'p1', { status: 'interrupting', activeTurnId: 'turn-1' });
    responders.set('turn/start', () => ({ result: { turn: { id: 'turn-2' } } }));
    await manager.sendTurn('t1', 'follow-up');
    assert.ok(!outbound.some((m) => m.method === 'turn/steer'), 'must not steer a dying turn');
    assert.ok(outbound.some((m) => m.method === 'turn/start'));
    ok('interrupting blocks steer (turn/start instead)');
  }

  // unconfirmed stop: no terminal → timeout → stop_settled(confirmed=false)
  {
    const { manager, responders, collect } = createCapturingManager();
    const settled = collect('stop_settled');
    seedSession(manager, 't1', 'p1', { status: 'running', activeTurnId: 'turn-1' });
    responders.set('turn/interrupt', () => ({ result: {} }));
    await manager.stopSession('t1');
    await sleep(500); // > AEGIS_CODEX_STOP_CONFIRM_TIMEOUT_MS (250ms)
    assert.equal(settled.length, 1);
    assert.equal(settled[0].confirmed, false);
    ok('no terminal → timeout settle (confirmed=false)');
  }

  // replacement staleness: late terminal must not delete the rebuilt session
  {
    const { manager, responders, notify, collect } = createCapturingManager();
    const settled = collect('stop_settled');
    seedSession(manager, 't1', 'p1', { status: 'running', activeTurnId: 'turn-1' });
    responders.set('turn/interrupt', () => ({ result: {} }));
    await manager.stopSession('t1');
    // Replacement runner rebuilt the same aegis thread on a new provider thread
    seedSession(manager, 't1', 'p2', { status: 'ready' });
    notify('turn/completed', { threadId: 'p1', turn: { id: 'turn-1', status: 'interrupted', error: null } });
    await sleep(10);
    assert.equal(settled.length, 1);
    assert.ok(manager.sessions.has('t1'), 'replacement session must survive the late settle');
    assert.equal(manager.sessions.get('t1').providerThreadId, 'p2');
    ok('late settle never deletes the replacement session');
  }

  // adapter staleness guard + post-settle send works on the replacement
  {
    const { adapter, manager, notify } = createCapturingAdapter();
    manager.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, cwd: '/tmp', status: 'running', activeTurnId: 'turn-1' });
    adapter.sessions.set('t1', { threadId: 't1', providerThreadId: 'p2', generation: 1, status: 'running' });
    adapter.lastStartInput.set('t1', { provider: 'codex', threadId: 't1', cwd: '/tmp', prompt: '' });
    // Settle for old provider thread p1 — adapter session (p2) must be kept.
    manager.emit('stop_settled', { aegisThreadId: 't1', providerThreadId: 'p1', generation: 1, confirmed: true });
    assert.ok(adapter.sessions.has('t1'), 'adapter must keep the replacement session');
    assert.ok(adapter.lastStartInput.has('t1'));
    // Matching settle → cleaned.
    manager.emit('stop_settled', { aegisThreadId: 't1', providerThreadId: 'p2', generation: 1, confirmed: true });
    assert.ok(!adapter.sessions.has('t1'));
    ok('adapter cleanup is providerThreadId/generation-guarded');
  }

  // idle stop → noTurn settle + adapter cleanup (no leak)
  {
    const { adapter, manager } = createCapturingAdapter();
    manager.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, cwd: '/tmp', status: 'ready' });
    adapter.sessions.set('t1', { threadId: 't1', providerThreadId: 'p1', generation: 1, status: 'completed' });
    adapter.lastStartInput.set('t1', { provider: 'codex', threadId: 't1', cwd: '/tmp', prompt: '' });
    const settled = [];
    manager.on('stop_settled', (p) => settled.push(p));
    await adapter.stopSession('t1');
    await sleep(10);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].noTurn, true);
    assert.ok(!adapter.sessions.has('t1'), 'idle stop must clean adapter state');
    assert.ok(!adapter.lastStartInput.has('t1'));
    ok('idle stop → stop_settled(noTurn) + adapter cleanup');
  }

  // stop with no session at all still settles (no 15s hang)
  {
    const { manager, collect } = createCapturingManager();
    const settled = collect('stop_settled');
    await manager.stopSession('t-ghost');
    assert.equal(settled.length, 1);
    assert.equal(settled[0].noTurn, true);
    ok('stop of unknown session settles immediately');
  }
}

// ── P0-7: approval routing ────────────────────────────────────────────────
async function testApprovalRouting() {
  console.log('P0-7 approval routing');

  // per-method fail-closed responses for unroutable requests
  {
    const cases = [
      ['item/commandExecution/requestApproval', { threadId: 'p-unknown', availableDecisions: ['accept', 'decline'] }, (r) => r.decision === 'decline'],
      ['item/fileChange/requestApproval', { threadId: 'p-unknown', availableDecisions: ['accept', 'decline'] }, (r) => r.decision === 'decline'],
      ['item/permissions/requestApproval', { threadId: 'p-unknown', permissions: { network: {} } }, (r) => JSON.stringify(r.permissions) === '{}' && r.scope === 'turn'],
      ['item/tool/requestUserInput', { threadId: 'p-unknown', questions: [] }, (r) => JSON.stringify(r.answers) === '{}'],
      ['mcpServer/elicitation/request', { threadId: 'p-unknown' }, (r) => r.action === 'decline' && r.content === null],
      ['execCommandApproval', { conversationId: 'p-unknown' }, (r) => r.decision === 'denied'],
      ['applyPatchApproval', { conversationId: 'p-unknown' }, (r) => r.decision === 'denied'],
    ];
    for (const [method, params, check] of cases) {
      const { manager, outbound, serverRequest } = createCapturingManager();
      const requests = [];
      manager.on('approval_request', (p) => requests.push(p));
      manager.on('user_input_request', (p) => requests.push(p));
      serverRequest(101, method, params);
      await sleep(5);
      assert.equal(requests.length, 0, `${method}: unroutable must not reach the UI`);
      const reply = outbound.find((m) => m.id === 101);
      assert.ok(reply?.result, `${method}: must be answered with a result`);
      assert.ok(check(reply.result), `${method}: wrong fail-closed shape ${JSON.stringify(reply.result)}`);
    }
    ok('unroutable requests: per-method protocol-legal minimal responses');
  }

  // currentTime/read answered; unknown methods → -32601
  {
    const { manager, outbound, serverRequest } = createCapturingManager();
    serverRequest(7, 'currentTime/read', { threadId: 'whatever' });
    serverRequest('str-8', 'attestation/generate', {});
    await sleep(5);
    const time = outbound.find((m) => m.id === 7);
    assert.ok(typeof time?.result?.currentTimeAt === 'number');
    const attest = outbound.find((m) => m.id === 'str-8');
    assert.equal(attest?.error?.code, -32601);
    assert.strictEqual(attest.id, 'str-8', 'string id must be echoed back as string');
    ok('currentTime answered; others -32601; string ids echoed (P0-9)');
  }

  // routable approval routes exactly; descendant mapping; wrong-session writeback rejected
  {
    const { manager, outbound, notify, serverRequest } = createCapturingManager();
    seedSession(manager, 't1', 'p1');
    seedSession(manager, 't2', 'p2');
    const requests = [];
    manager.on('approval_request', (p) => requests.push(p));
    // Register descendant p-child under root t1 via a collab item
    notify('item/completed', {
      threadId: 'p1',
      item: { type: 'collabAgentToolCall', id: 'i1', collabAgentToolCall: { receiverThreadIds: ['p-child'] }, receiverThreadIds: ['p-child'] },
    });
    serverRequest(11, 'item/commandExecution/requestApproval', { threadId: 'p-child', command: 'ls' });
    await sleep(5);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].threadId, 't1', 'descendant approval must route to the root session');

    // wrong-session writeback rejected; correct session accepted
    await manager.respondToApproval(requests[0].requestId, { behavior: 'allow' }, 't2');
    assert.ok(!outbound.some((m) => m.id === 11 && m.result), 'wrong-session decision must not be written');
    await manager.respondToApproval(requests[0].requestId, { behavior: 'allow' }, 't1');
    assert.ok(outbound.some((m) => m.id === 11 && m.result), 'owner decision must be written');
    ok('descendant routing + wrong-session writeback rejection');
  }

  // serverRequest/resolved → pending approval dismissed
  {
    const { manager, notify, serverRequest, collect } = createCapturingManager();
    seedSession(manager, 't1', 'p1');
    const dismissed = collect('approval_dismissed');
    serverRequest(21, 'item/commandExecution/requestApproval', { threadId: 'p1', command: 'ls' });
    await sleep(5);
    notify('serverRequest/resolved', { threadId: 'p1', requestId: 21 });
    assert.equal(dismissed.length, 1);
    assert.equal(dismissed[0].threadId, 't1');
    ok('serverRequest/resolved dismisses the pending card');
  }
}

// ── P0-8/P0-9: process lifecycle with the real fake binary ────────────────
async function testProcessLifecycle() {
  console.log('P0-8/P0-9 process lifecycle (fake binary)');

  // spawn barrier: concurrent ensureSpawned → exactly one initialize
  {
    process.env.FAKE_CODEX_MODE = 'normal';
    const manager = new CodexAppServerManager(FAKE_BIN, '9.9.9-test');
    const sent = [];
    const originalWrite = manager.writeMessage.bind(manager);
    manager.writeMessage = (msg) => {
      sent.push(msg);
      originalWrite(msg);
    };
    await Promise.all([manager.spawn('/tmp'), manager.spawn('/tmp'), manager.spawn('/tmp')]);
    assert.equal(sent.filter((m) => m.method === 'initialize').length, 1, 'single initialize handshake');
    assert.equal(sent.find((m) => m.method === 'initialize').params.clientInfo.version, '9.9.9-test');
    await manager.stop();
    ok('concurrent spawn → one initialize (version injected)');
  }

  // initialize timeout → cleanup → retry succeeds
  {
    process.env.FAKE_CODEX_MODE = 'silent';
    const manager = new CodexAppServerManager(FAKE_BIN, '9.9.9-test');
    await assert.rejects(() => manager.spawn('/tmp'), (error) => error instanceof CodexRpcTransportError);
    assert.equal(manager.child, null, 'failed initialize must tear the child down');
    process.env.FAKE_CODEX_MODE = 'normal';
    await manager.spawn('/tmp');
    assert.equal(manager.initialized, true, 'retry after failed initialize must succeed');
    await manager.stop();
    ok('initialize timeout → full cleanup → retry works');
  }

  // crash mid-turn: pending turn/start rejects immediately; approvals dismissed
  {
    process.env.FAKE_CODEX_MODE = 'crash-on-turn';
    const manager = new CodexAppServerManager(FAKE_BIN, '9.9.9-test');
    await manager.spawn('/tmp');
    const created = await manager.createSession('t1', '/tmp');
    assert.ok(created.providerThreadId);
    const dismissed = [];
    manager.on('approval_dismissed', (p) => dismissed.push(p));
    // Inject a pending approval before the crash.
    manager.handleStdoutLine(
      JSON.stringify({ jsonrpc: '2.0', id: 55, method: 'item/commandExecution/requestApproval', params: { threadId: created.providerThreadId, command: 'ls' } })
    );
    const exitEvents = [];
    manager.on('process_exit', (p) => exitEvents.push(p));
    const startedAt = Date.now();
    await assert.rejects(
      () => manager.sendTurn('t1', 'hello'),
      (error) => error instanceof CodexRpcTransportError && error.reason !== 'timeout'
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1500, `pending turn must reject on crash, not wait for the timeout (took ${elapsed}ms)`);
    assert.equal(exitEvents.length, 1);
    assert.equal(dismissed.length, 1, 'pending approval must be dismissed on crash');
    ok('crash mid-turn → immediate rejection + approval dismissal');
  }

  // error.code preserved (CodexRpcError)
  {
    process.env.FAKE_CODEX_MODE = 'normal';
    const manager = new CodexAppServerManager(FAKE_BIN, '9.9.9-test');
    await manager.spawn('/tmp');
    await assert.rejects(
      () => manager.listSkills({ cwd: '/tmp' }),
      (error) => error instanceof CodexRpcError && error.code === -32601
    );
    await manager.stop();
    ok('JSON-RPC error code preserved on typed errors');
  }

  // full round trip: start thread + turn + interrupt through a real pipe
  {
    process.env.FAKE_CODEX_MODE = 'normal';
    const adapter = new CodexAdapter(FAKE_BIN);
    const manager = adapter.manager;
    const settled = [];
    manager.on('stop_settled', (p) => settled.push(p));
    await adapter.startSession({ provider: 'codex', threadId: 't1', cwd: '/tmp', prompt: 'hi' });
    await sleep(50);
    await adapter.stopSession('t1');
    await sleep(300);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].confirmed, true, 'fake binary confirms the interrupt terminal');
    await manager.stop();
    ok('end-to-end: spawn → turn → interrupt → confirmed settle');
  }
}

// ── Builtin slash commands (/compact, /review) ────────────────────────────
async function testSlashCommands() {
  console.log('builtin slash commands');

  const { parseCodexSlashCommand } = require('../dist-electron/electron/libs/provider/codex-adapter.js');

  // parser: recognized shapes
  {
    assert.deepEqual(parseCodexSlashCommand('/compact'), { name: 'compact' });
    assert.deepEqual(parseCodexSlashCommand('  /compact  '), { name: 'compact' });
    assert.deepEqual(parseCodexSlashCommand('/review'), {
      name: 'review',
      target: { type: 'uncommittedChanges' },
    });
    assert.deepEqual(parseCodexSlashCommand('/review branch main'), {
      name: 'review',
      target: { type: 'baseBranch', branch: 'main' },
    });
    assert.deepEqual(parseCodexSlashCommand('/review commit abc123'), {
      name: 'review',
      target: { type: 'commit', sha: 'abc123' },
    });
    assert.deepEqual(parseCodexSlashCommand('/review focus on error handling'), {
      name: 'review',
      target: { type: 'custom', instructions: 'focus on error handling' },
    });
    // not commands: args after /compact, unknown names, plain prompts
    assert.equal(parseCodexSlashCommand('/compact everything'), null);
    assert.equal(parseCodexSlashCommand('/model'), null);
    assert.equal(parseCodexSlashCommand('hello /compact'), null);
    assert.equal(parseCodexSlashCommand('compact'), null);
    ok('parseCodexSlashCommand recognizes builtins and rejects the rest');
  }

  const seedSession = () => {
    const harness = createCapturingAdapter();
    harness.manager.sessions.set('t1', {
      threadId: 't1', providerThreadId: 'p1', generation: 1, cwd: '/tmp', status: 'ready',
    });
    harness.adapter.sessions.set('t1', {
      threadId: 't1', providerThreadId: 'p1', generation: 1, status: 'ready',
    });
    harness.responders.set('thread/compact/start', () => ({ result: {} }));
    harness.responders.set('review/start', () => ({ result: {} }));
    harness.responders.set('turn/start', () => ({ result: { turn: { id: 'turn-1' } } }));
    return harness;
  };

  // /compact routes to thread/compact/start, not turn/start
  {
    const { adapter, outbound } = seedSession();
    await adapter.sendTurn({ threadId: 't1', prompt: '/compact' });
    const compactReq = outbound.find((m) => m.method === 'thread/compact/start');
    assert.ok(compactReq, '/compact must send thread/compact/start');
    assert.equal(compactReq.params.threadId, 'p1');
    assert.ok(!outbound.some((m) => m.method === 'turn/start'), 'no literal turn for /compact');
    ok('/compact → thread/compact/start RPC');
  }

  // /review with custom instructions routes to review/start
  {
    const { adapter, outbound } = seedSession();
    await adapter.sendTurn({ threadId: 't1', prompt: '/review check the auth flow' });
    const reviewReq = outbound.find((m) => m.method === 'review/start');
    assert.ok(reviewReq, '/review must send review/start');
    assert.deepEqual(reviewReq.params.target, { type: 'custom', instructions: 'check the auth flow' });
    assert.ok(!outbound.some((m) => m.method === 'turn/start'), 'no literal turn for /review');
    ok('/review <args> → review/start custom target');
  }

  // command-shaped text with structured input still goes as a normal turn
  {
    const { adapter, outbound } = seedSession();
    await adapter.sendTurn({
      threadId: 't1',
      prompt: '/compact',
      codexSkills: [{ name: 'compact', path: '/skills/compact/SKILL.md' }],
    });
    assert.ok(!outbound.some((m) => m.method === 'thread/compact/start'), 'skill turn must not compact');
    assert.ok(outbound.some((m) => m.method === 'turn/start'), 'skill turn must dispatch normally');
    ok('slash text with a skill reference stays a normal turn');
  }
}

// ── Source-level pins for electron-bound modules ──────────────────────────
function testSourcePins() {
  console.log('source pins (electron-bound modules)');
  const sessionStore = readFileSync(join(__dirname, '../src/electron/libs/session-store.ts'), 'utf8');
  assert.match(sessionStore, /function writeCodexSessionId/, 'shared codex session id writer must exist');
  const updateFn = sessionStore.slice(sessionStore.indexOf('export function updateCodexSessionId'));
  assert.ok(updateFn.slice(0, 200).includes('writeCodexSessionId'), 'updateCodexSessionId must use the shared writer');
  const setFn = sessionStore.slice(sessionStore.indexOf('export function setCodexSessionId'));
  assert.ok(setFn.slice(0, 200).includes('writeCodexSessionId'), 'setCodexSessionId must use the shared writer');
  ok('both codex_session_id writers use the reverse-unique helper');

  const ipcSource = readFileSync(join(__dirname, '../src/electron/ipc-handlers.ts'), 'utf8');
  assert.match(ipcSource, /stoppingCodexSessions/, 'ipc must track codex stop windows');
  assert.match(ipcSource, /codexStopping && message\.type === 'result'/, 'stopping result must be classified');
  assert.match(ipcSource, /await stoppingEntry\.settlePromise/, 'continue must hold on the stop settle');
  ok('ipc stop-window classification wired (source pin)');
}

async function main() {
  await testTurnTerminals();
  await testAutoPermissionMode();
  await testServiceTier();
  await testMcpStatus();
  await testResume();
  await testTwoPhaseStop();
  await testApprovalRouting();
  await testProcessLifecycle();
  await testSlashCommands();
  testSourcePins();
  console.log(`\nverify:codex-app-server OK (${passed} checks)`);
  process.exit(0);
}

main().catch((error) => {
  console.error('\nverify:codex-app-server FAILED');
  console.error(error);
  process.exit(1);
});
