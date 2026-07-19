#!/usr/bin/env node
// Runtime verification for the kimi server runtime (docs/kimi-server-adapter-plan.md).
//   L1 in-process — drive the compiled manager/adapter/facade with injected
//      fetch/WS/spawn fakes (no processes).
//   L2 fake daemon — a real spawned fake `kimi server` (scripts/fake-kimi-server.mjs)
//      for lifecycle races: token parse variants, healthz gating, daemon death
//      mid-turn, WS drop + cursor resubscribe, adoption, quit kill ordering.
// Requires `npm run transpile:electron` to have produced dist-electron.

process.env.AEGIS_KIMI_SERVER_READY_TIMEOUT_MS = '4000';
process.env.AEGIS_KIMI_SERVER_REQUEST_TIMEOUT_MS = '3000';
process.env.AEGIS_KIMI_SERVER_SUBSCRIBE_TIMEOUT_MS = '2000';
process.env.AEGIS_KIMI_SERVER_RECONNECT_MAX_MS = '400';
process.env.AEGIS_KIMI_SERVER_STOP_CONFIRM_TIMEOUT_MS = '300';
process.env.AEGIS_KIMI_SERVER_RESUME_ATTEMPTS = '3';
process.env.AEGIS_KIMI_SERVER_RESUME_RETRY_MS = '20';

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  KimiServerManager,
  KimiServerApiError,
  KimiServerTransportError,
} = require('../dist-electron/electron/libs/provider/kimi-server-manager.js');
const {
  KimiServerAdapter,
  mapKimiPermissionMode,
} = require('../dist-electron/electron/libs/provider/kimi-server-adapter.js');
const {
  KimiAdapterFacade,
  KIMI_SERVER_ID_PREFIX,
  isKimiServerCapable,
  requireKimiServerCapability,
  getKimiDefaultRuntime,
  setKimiCapabilityProbeForTests,
} = require('../dist-electron/electron/libs/provider/kimi-adapter-facade.js');
const { runAgentLoop, ensureProviderService } = require('../dist-electron/electron/libs/agent-loop.js');
const { getProviderService } = require('../dist-electron/electron/libs/provider/service.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = join(__dirname, 'fake-kimi-server.mjs');

// Deterministic capability verdict for the whole harness run (no real
// execFile probe — machines without the kimi CLI must behave identically).
const PINNED_CAPABLE_PROBE = async () => ({ definitive: true, capable: true });
setKimiCapabilityProbeForTests(PINNED_CAPABLE_PROBE);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ═══════════════════════════════ L1 fakes ═══════════════════════════════════

function makeFakeChild() {
  const dataListeners = { stdout: [], stderr: [] };
  const child = {
    pid: 4242,
    exitCode: null,
    stdout: {
      setEncoding() {},
      on(event, fn) {
        if (event === 'data') dataListeners.stdout.push(fn);
      },
    },
    stderr: {
      setEncoding() {},
      on(event, fn) {
        if (event === 'data') dataListeners.stderr.push(fn);
      },
    },
    _exit: [],
    _error: [],
    killed: [],
    on(event, fn) {
      if (event === 'exit') child._exit.push(fn);
      if (event === 'error') child._error.push(fn);
    },
    kill(signal) {
      child.killed.push(signal || 'SIGTERM');
      return true;
    },
    emitStdout(text) {
      dataListeners.stdout.forEach((fn) => fn(text));
    },
    emitStderr(text) {
      dataListeners.stderr.forEach((fn) => fn(text));
    },
    emitExit(code) {
      child.exitCode = code;
      child._exit.forEach((fn) => fn(code, null));
    },
  };
  return child;
}

function makeFakeWsFactory() {
  const factory = (url, headers) => {
    const handlers = { open: [], message: [], close: [], error: [] };
    const ws = {
      url,
      headers,
      sent: [],
      closed: false,
      on(event, fn) {
        handlers[event]?.push(fn);
      },
      send(data) {
        const msg = JSON.parse(data);
        ws.sent.push(msg);
        if (msg.type === 'subscribe') {
          const respond = factory.onSubscribe || defaultSubscribe;
          setImmediate(() => ws.receive(respond(msg)));
        }
      },
      close() {
        ws.closed = true;
      },
      receive(frame) {
        handlers.message.forEach((fn) => fn(JSON.stringify(frame)));
      },
      drop() {
        handlers.close.forEach((fn) => fn());
      },
    };
    factory.sockets.push(ws);
    setImmediate(() => ws.receive({ type: 'server_hello', payload: {} }));
    return ws;
  };
  const defaultSubscribe = (msg) => ({
    type: 'ack',
    id: msg.id,
    code: 0,
    msg: 'success',
    payload: {
      accepted: msg.payload.session_ids,
      not_found: [],
      resync_required: [],
      cursors: Object.fromEntries(msg.payload.session_ids.map((sid) => [sid, { seq: 1, epoch: 'ep1' }])),
    },
  });
  factory.sockets = [];
  factory.defaultSubscribe = defaultSubscribe;
  return factory;
}

function makeFakeFetch(state) {
  const calls = [];
  const respond = (code, data) => ({
    ok: true,
    status: 200,
    json: async () => ({ code, msg: code === 0 ? 'success' : 'fake error', data }),
  });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = init.headers?.authorization || '';
    calls.push({ path: u.pathname, method, body, auth });

    if (state.refuseConnections) {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }
    if (u.pathname === '/api/v1/healthz') return respond(0, {});
    if (state.expectToken && auth !== `Bearer ${state.expectToken}`) {
      return { ok: false, status: 401, json: async () => ({ code: 40100, msg: 'unauthorized', data: null }) };
    }
    if (u.pathname === '/api/v1/sessions' && method === 'POST') {
      state.sessionSeq = (state.sessionSeq || 0) + 1;
      return respond(0, { id: `session_test_${state.sessionSeq}` });
    }
    if (u.pathname === '/api/v1/config') return respond(0, { default_model: 'kimi-default-model' });
    if (u.pathname === '/api/v1/models') {
      return respond(0, { items: [{ model: 'kimi-for-coding', max_context_size: 262144 }] });
    }
    if (/\/prompts:steer$/.test(u.pathname)) {
      if (state.steerRaceLost) return respond(40402, null);
      return respond(0, { steered: true, prompt_ids: body.prompt_ids });
    }
    if (/\/prompts\/[^/]+:cancel$/.test(u.pathname) && method === 'POST') {
      return respond(0, { cancelled: true });
    }
    if (/\/prompts$/.test(u.pathname) && method === 'POST') {
      if (state.submitDelayMs) await new Promise((r) => setTimeout(r, state.submitDelayMs));
      if (state.failSubmitOnce) {
        state.failSubmitOnce = false;
        return respond(50000, null);
      }
      state.promptSeq = (state.promptSeq || 0) + 1;
      return respond(0, {
        prompt_id: `prompt_${state.promptSeq}`,
        status: state.busy ? 'queued' : 'running',
      });
    }
    if (/:abort$/.test(u.pathname)) return respond(0, { aborted: true });
    if (/:compact$/.test(u.pathname)) return respond(0, {});
    if (/:archive$/.test(u.pathname)) return respond(0, {});
    if (/:fork$/.test(u.pathname)) return respond(0, { id: 'session_forked_1' });
    if (/\/messages$/.test(u.pathname)) return respond(0, { items: state.messages || [] });
    if (u.pathname === '/api/v1/workspaces') {
      return respond(0, { items: state.workspaces ?? [{ id: 'wd_test_1', root: '/tmp/proj' }] });
    }
    const sessionGet = /^\/api\/v1\/sessions\/([^/:]+)$/.exec(u.pathname);
    if (sessionGet && method === 'GET') {
      return state.missingSessions?.includes(sessionGet[1])
        ? respond(40401, null)
        : respond(0, { id: sessionGet[1] });
    }
    if (/\/skills$/.test(u.pathname)) {
      return respond(0, {
        skills: state.skills || [
          { name: 'clarify', description: 'Improve unclear UX copy', path: '/tmp/skills/clarify', source: 'user' },
          { name: 'check-kimi-code-docs', description: 'Answer Kimi Code questions', path: 'builtin://check-kimi-code-docs', source: 'builtin' },
        ],
      });
    }
    if (/\/approvals\//.test(u.pathname) && method === 'POST') {
      if (state.approvalDelayMs) await new Promise((r) => setTimeout(r, state.approvalDelayMs));
      if (state.failApprovalOnce) {
        state.failApprovalOnce = false;
        return respond(50000, null);
      }
      if (state.approvalsCode) return respond(state.approvalsCode, null);
      return respond(0, { resolved: true });
    }
    if (/\/questions\//.test(u.pathname) && method === 'POST') return respond(0, {});
    return respond(0, {});
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeTransport(overrides = {}) {
  const child = makeFakeChild();
  const wsFactory = makeFakeWsFactory();
  const state = { expectToken: null };
  const fetchImpl = makeFakeFetch(state);
  const transport = {
    fetchImpl,
    createWebSocket: wsFactory,
    spawnDaemon: () => {
      setImmediate(() => child.emitStdout('\n  Kimi server ready  0.26.0\n\n  Token:    tok_l1_test\n\n'));
      return child;
    },
    resolveBinary: async () => '/fake/kimi',
    readTokenFile: () => 'tok_l1_test',
    ...overrides,
  };
  return { transport, child, wsFactory, state, fetchImpl };
}

function collectEvents(adapter) {
  const events = [];
  adapter.events.on('event', (event) => events.push(event));
  events.byType = (type) => events.filter((event) => event.type === type);
  events.messages = (type) =>
    events.filter((event) => event.type === 'message' && event.message.type === type).map((event) => event.message);
  return events;
}

/** Start a session and return everything a frame-driving test needs. */
async function startL1Session(options = {}) {
  const { transport, child, wsFactory, state, fetchImpl } = makeTransport(options.transport);
  const adapter = new KimiServerAdapter(transport);
  const events = collectEvents(adapter);
  const session = await adapter.startSession({
    provider: 'kimi',
    threadId: options.threadId || 'thread-1',
    cwd: '/tmp/proj',
    prompt: '',
    model: options.model,
    resumeSessionId: options.resumeSessionId,
    kimiPermissionMode: options.kimiPermissionMode,
  });
  const ws = wsFactory.sockets[0];
  const sid = session.providerSessionId;
  let seq = 1;
  // `extras` land at the frame's TOP LEVEL (offset is a top-level field —
  // spreading it into payload would test nothing).
  const push = (type, payload = {}, volatile = false, extras = {}) => {
    if (!volatile) seq += 1;
    ws.receive({
      type,
      seq,
      session_id: sid,
      payload: { type, ...payload },
      epoch: 'ep1',
      ...(volatile ? { volatile: true } : {}),
      ...extras,
    });
  };
  return { adapter, events, session, sid, ws, push, child, state, fetchImpl, wsFactory };
}

// ═══════════════════════════════ L1 tests ═══════════════════════════════════

async function l1PermissionModeMapping() {
  assert.deepEqual(mapKimiPermissionMode('default'), { permission_mode: 'manual', plan_mode: false });
  assert.deepEqual(mapKimiPermissionMode('plan'), { permission_mode: 'manual', plan_mode: true });
  assert.deepEqual(mapKimiPermissionMode('auto'), { permission_mode: 'auto', plan_mode: false });
  assert.deepEqual(mapKimiPermissionMode('yolo'), { permission_mode: 'yolo', plan_mode: false });
  assert.deepEqual(mapKimiPermissionMode(undefined), { permission_mode: 'manual', plan_mode: false });
  ok('permission modes map default/plan/auto/yolo → manual/manual+plan/auto/yolo');
}

async function l1TurnCompleted() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'kimi-for-coding' });
  const submit = t.fetchImpl.calls.find((call) => /\/prompts$/.test(call.path));
  assert.equal(submit.body.model, 'kimi-for-coding', 'model must be passed on every submit (C3)');
  t.push('turn.started', { turnId: 1 });
  t.push('assistant.delta', { delta: 'Hel' }, true);
  t.push('assistant.delta', { delta: 'lo' }, true);
  t.push('turn.ended', { reason: 'completed', durationMs: 7 });
  await waitFor(() => t.events.messages('result').length === 1, 2000, 'result');
  const results = t.events.messages('result');
  assert.equal(results.length, 1, 'exactly one result per turn');
  assert.equal(results[0].subtype, 'success');
  const streamed = t.events.messages('assistant').filter((m) => m.streaming);
  assert.equal(streamed[streamed.length - 1].message.content[0].text, 'Hello');
  const finals = t.events.messages('assistant').filter((m) => !m.streaming && m.message.content[0]?.type === 'text');
  assert.equal(finals[finals.length - 1].message.content[0].text, 'Hello', 'accumulator finalized');
  ok('turn.ended(completed) → exactly one success result; deltas accumulate in place');
}

async function l1TurnFailedOrder() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('turn.ended', { reason: 'failed', error: { code: 'model.not_configured', message: 'boom' } });
  await waitFor(() => t.events.messages('result').length === 1, 2000, 'error result');
  const errorIndex = t.events.findIndex((event) => event.type === 'error');
  const resultIndex = t.events.findIndex((event) => event.type === 'message' && event.message.type === 'result');
  assert.ok(errorIndex >= 0 && errorIndex < resultIndex, 'error event precedes the error result');
  assert.equal(t.events.messages('result')[0].subtype, 'error');
  assert.equal(t.events.byType('error').length, 1);
  ok('turn.ended(failed) → error event precedes the single error result (P0-1)');
}

async function l1ErrorFrameDedupe() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('error', { message: 'stream exploded' });
  t.push('turn.ended', { reason: 'failed', error: { message: 'stream exploded' } });
  await waitFor(() => t.events.messages('result').length === 1, 2000, 'error result');
  assert.equal(t.events.byType('error').length, 1, 'error frame + failed terminal report once');
  assert.equal(t.events.messages('result')[0].subtype, 'error');
  ok('error frame + turn.ended(failed) dedupe to one error report');
}

async function l1SeqReplayIdempotence() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  const frame = (seq) => ({
    type: 'tool.call.started',
    seq,
    session_id: t.sid,
    payload: { type: 'tool.call.started', toolCallId: 'tool_A', name: 'Read', args: { path: 'x' } },
    epoch: 'ep1',
  });
  t.ws.receive(frame(5));
  t.ws.receive(frame(5)); // duplicate seq — replay must not re-emit
  t.ws.receive({ type: 'agent.status.updated', seq: 5, session_id: t.sid, volatile: true, epoch: 'ep1', payload: { type: 'agent.status.updated', contextTokens: 123, maxContextTokens: 1000 } });
  await sleep(30);
  const toolUses = t.events
    .messages('assistant')
    .filter((m) => m.message.content[0]?.type === 'tool_use');
  assert.equal(toolUses.length, 1, 'duplicate non-volatile seq is dropped');
  // Volatile frames sharing seq still flow (context absorbed).
  t.ws.receive({
    type: 'turn.step.completed',
    seq: 6,
    session_id: t.sid,
    epoch: 'ep1',
    payload: { type: 'turn.step.completed', usage: { inputOther: 9, output: 3, inputCacheRead: 1, inputCacheCreation: 0 } },
  });
  await waitFor(() => t.events.messages('system').some((m) => m.subtype === 'token_usage'), 2000, 'token_usage');
  const usage = t.events.messages('system').find((m) => m.subtype === 'token_usage');
  assert.equal(usage.provider, 'kimi');
  assert.equal(usage.usage.inputTokens, 9);
  assert.equal(usage.usage.totalTokens, 123, 'context from volatile agent.status.updated');
  assert.equal(usage.usage.contextWindow, 1000);
  ok('seq dedupe drops replayed frames; volatile frames flow and feed the context ring');
}

async function l1ToolFlow() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('tool.call.started', { toolCallId: 'tool_B', name: 'Bash', args: { command: 'ls' }, description: 'Listing' });
  t.push('tool.result', { toolCallId: 'tool_B', output: 'file.txt' });
  t.push('turn.ended', { reason: 'completed' });
  await waitFor(() => t.events.messages('result').length === 1, 2000, 'result');
  const toolUse = t.events.messages('assistant').find((m) => m.message.content[0]?.type === 'tool_use');
  assert.equal(toolUse.message.content[0].name, 'Bash');
  assert.equal(toolUse.message.content[0].input.command, 'ls');
  const toolResult = t.events.messages('user').find((m) => m.message.content[0]?.type === 'tool_result');
  assert.equal(toolResult.message.content[0].tool_use_id, 'tool_B');
  assert.equal(toolResult.message.content[0].content, 'file.txt');
  ok('tool.call.started/tool.result map to tool_use/tool_result');
}

async function l1StopSettle() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'count', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  await sleep(10);
  const stopPromise = t.adapter.stopSession('thread-1');
  await waitFor(() => t.fetchImpl.calls.some((call) => /:abort$/.test(call.path)), 2000, ':abort call');
  t.push('turn.ended', { reason: 'cancelled', durationMs: 3 });
  await stopPromise;
  const settle = await waitFor(
    () => t.events.byType('stop_settled').find((event) => event.confirmed === true),
    2000,
    'confirmed settle'
  );
  assert.equal(settle.threadId, 'thread-1');
  assert.equal(t.adapter.hasSession('thread-1'), false, 'binding released at settle');
  const results = t.events.messages('result');
  assert.equal(results.length, 1);
  assert.equal(results[0].subtype, 'success', 'cancelled terminal ends as success (stop confirmation)');
  ok('stop → :abort → turn.ended(cancelled) settles confirmed and releases the binding');
}

async function l1StopSafetyTimeout() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'count', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  await sleep(10);
  await t.adapter.stopSession('thread-1');
  const settle = await waitFor(() => t.events.byType('stop_settled')[0], 2000, 'settle');
  assert.equal(settle.confirmed, false, 'no cancel confirmation → unconfirmed settle');
  ok('stop without cancel confirmation settles unconfirmed via the safety timeout');
}

async function l1StopNoTurn() {
  const t = await startL1Session();
  await t.adapter.stopSession('thread-1');
  const settle = t.events.byType('stop_settled')[0];
  assert.equal(settle.confirmed, true);
  assert.equal(settle.noTurn, true);
  assert.equal(t.adapter.hasSession('thread-1'), false);
  ok('stop with no active turn settles immediately (noTurn)');
}

async function l1ApprovalDedupeAndDecision() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'run it', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  // The server pushes both frame variants for the same approval.
  t.push('permission.approval.requested', {
    toolCallId: 'tool_appr',
    toolName: 'Bash',
    action: 'Running: rm -rf /tmp/x',
    display: { kind: 'command', command: 'rm -rf /tmp/x' },
    toolInput: { command: 'rm -rf /tmp/x' },
  });
  t.push('event.approval.requested', {
    approval_id: 'tool_appr',
    tool_call_id: 'tool_appr',
    tool_name: 'Bash',
    action: 'Running: rm -rf /tmp/x',
  });
  await sleep(30);
  const requests = t.events.byType('permission_request');
  assert.equal(requests.length, 1, 'near-duplicate approval frames dedupe by approval_id');
  const request = requests[0];
  assert.equal(request.toolName, 'Bash');

  await t.adapter.respondToRequest('thread-1', request.requestId, {
    behavior: 'allow',
    updatedInput: { optionId: 'approved_session' },
  });
  const decision = t.fetchImpl.calls.find((call) => call.path.includes('/approvals/tool_appr'));
  assert.equal(decision.body.decision, 'approved');
  assert.equal(decision.body.scope, 'session', 'allow-for-session passes scope through');
  ok('approval frames dedupe; decision maps behavior/optionId → decision+scope');
}

async function l1ApprovalResolvedElsewhereDismisses() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'run it', model: 'm' });
  t.push('event.approval.requested', { approval_id: 'appr_2', tool_name: 'Bash', action: 'x' });
  await sleep(20);
  t.push('event.approval.resolved', { approval_id: 'appr_2', decision: 'approved' });
  await waitFor(() => t.events.byType('permission_dismissed').length === 1, 2000, 'dismiss');
  ok('approval resolved by another client dismisses the pending card');
}

async function l1FailClosedRouting() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'x', model: 'm' });
  t.push('event.approval.requested', { approval_id: 'appr_3', tool_name: 'Bash', action: 'x' });
  await sleep(20);
  const request = t.events.byType('permission_request')[0];
  const before = t.fetchImpl.calls.length;
  // Wrong thread id: the decision must be dropped, not forwarded (P0-7).
  await t.adapter.respondToRequest('other-thread', request.requestId, { behavior: 'allow' });
  assert.equal(
    t.fetchImpl.calls.slice(before).filter((call) => call.path.includes('/approvals/')).length,
    0,
    'unroutable decision reaches no REST call'
  );
  ok('unroutable approval decisions are dropped (fail-closed, P0-7)');
}

async function l1QueueSteer() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'first', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  await sleep(10);
  t.state.busy = true; // server-side: next submit lands queued
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'second', model: 'm' });
  const steer = await waitFor(
    () => t.fetchImpl.calls.find((call) => /prompts:steer$/.test(call.path)),
    2000,
    'steer call'
  );
  assert.deepEqual(steer.body.prompt_ids, ['prompt_2']);
  ok('send while a turn is active queues + steers into the running turn');
}

async function l1SteerRaceBenign() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'first', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  await sleep(10);
  t.state.busy = true;
  t.state.steerRaceLost = true; // 40402: turn ended inside the race window
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'second', model: 'm' });
  await sleep(30);
  assert.equal(t.events.byType('error').length, 0, '40402 steer race is benign');
  ok('steer race (40402) is swallowed — the prompt auto-runs from the queue');
}

async function l1ResultCarriesTurnUsage() {
  const t = await startL1Session({ model: 'kimi-for-coding' });
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'a', model: 'kimi-for-coding' });
  t.push('turn.started', { turnId: 1 });
  t.push('turn.step.completed', {
    turnId: 1,
    usage: { inputOther: 100, output: 20, inputCacheRead: 300, inputCacheCreation: 5 },
  });
  t.push('turn.step.completed', {
    turnId: 1,
    usage: { inputOther: 50, output: 10, inputCacheRead: 100, inputCacheCreation: 0 },
  });
  t.push('turn.ended', { reason: 'completed', durationMs: 9 });
  await waitFor(() => t.events.messages('result').length === 1, 2000, 'result');
  const result = t.events.messages('result')[0];
  assert.equal(result.usage.input_tokens, 150, 'steps accumulate input tokens');
  assert.equal(result.usage.output_tokens, 30);
  assert.equal(result.usage.cache_read_input_tokens, 400);
  assert.equal(result.usage.cache_creation_input_tokens, 5);
  assert.equal(result.model, 'kimi-for-coding', 'result attributes the model');

  // Next turn starts from zero — no cross-turn double counting.
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'b', model: 'kimi-for-coding' });
  t.push('turn.started', { turnId: 2 });
  t.push('turn.step.completed', {
    turnId: 2,
    usage: { inputOther: 7, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
  });
  t.push('turn.ended', { reason: 'completed' });
  await waitFor(() => t.events.messages('result').length === 2, 2000, 'result 2');
  const second = t.events.messages('result')[1];
  assert.equal(second.usage.input_tokens, 7, 'turn usage resets per turn');
  assert.equal(second.usage.output_tokens, 3);

  // token_usage messages: per-TURN stable uuid (steps overwrite in place,
  // each finished turn persists one cumulative row).
  const usageMessages = t.events.messages('system').filter((m) => m.subtype === 'token_usage');
  const turn1 = usageMessages.filter((m) => m.uuid.endsWith(':1'));
  const turn2 = usageMessages.filter((m) => m.uuid.endsWith(':2'));
  assert.equal(turn1.length, 2, 'both turn-1 steps share one uuid');
  assert.equal(new Set(turn1.map((m) => m.uuid)).size, 1);
  assert.equal(turn1[1].usage.inputTokens, 150, 'second step carries turn-cumulative tokens');
  assert.equal(turn1[1].usage.cachedInputTokens, 400);
  assert.equal(turn2.length, 1);
  assert.notEqual(turn2[0].uuid, turn1[0].uuid, 'each turn gets its own persisted row');
  assert.equal(turn2[0].usage.inputTokens, 7);
  ok('result + per-turn token_usage carry accumulated usage (append-only per-turn ledger)');
}

async function l1ThinkingPassthrough() {
  const t = await startL1Session({ kimiPermissionMode: 'auto' });
  // No thinking set → the field is omitted (server per-model default rules).
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'a', model: 'm' });
  let submit = t.fetchImpl.calls.filter((call) => /\/prompts$/.test(call.path)).pop();
  assert.equal(submit.body.thinking, undefined, 'unset thinking is not sent');
  t.push('turn.ended', { reason: 'completed' });
  await waitFor(() => t.events.messages('result').length === 1, 2000, 'result');

  // Thinking set on a later turn → effort tier string rides the submit and
  // sticks for subsequent turns.
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'b', model: 'm', kimiThinking: 'on' });
  submit = t.fetchImpl.calls.filter((call) => /\/prompts$/.test(call.path)).pop();
  assert.equal(submit.body.thinking, 'on');
  t.push('turn.ended', { reason: 'completed' });
  await waitFor(() => t.events.messages('result').length === 2, 2000, 'result 2');
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'c', model: 'm' });
  submit = t.fetchImpl.calls.filter((call) => /\/prompts$/.test(call.path)).pop();
  assert.equal(submit.body.thinking, 'on', 'thinking sticks across turns');
  ok('thinking passthrough: omitted when unset, effort string when set, sticky');
}

async function l1ModelSwitchPerPrompt() {
  const t = await startL1Session({ model: 'model-a' });
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'x', model: 'model-a' });
  t.push('turn.ended', { reason: 'completed' });
  await waitFor(() => t.events.messages('result').length === 1, 2000, 'result');
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'y', model: 'model-b' });
  const submits = t.fetchImpl.calls.filter((call) => /\/prompts$/.test(call.path));
  assert.equal(submits[0].body.model, 'model-a');
  assert.equal(submits[1].body.model, 'model-b', 'per-prompt model switch');
  ok('mid-session model switch rides the per-prompt model field');
}

async function l1CompactFlow() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: '/compact' });
  assert.ok(
    t.fetchImpl.calls.some((call) => /:compact$/.test(call.path)),
    '/compact routes to the :compact action'
  );
  t.push('agent.status.updated', { contextTokens: 5000, maxContextTokens: 10000 }, true);
  t.push('event.session.history_compacted', {});
  await waitFor(() => t.events.messages('result').length === 1, 2000, 'compact result');
  const boundary = t.events.messages('system').find((m) => m.subtype === 'compact_boundary');
  assert.equal(boundary.compactMetadata.trigger, 'manual');
  assert.equal(boundary.compactMetadata.preTokens, 5000);
  ok('/compact → :compact → history_compacted emits a manual compact_boundary + result');
}

async function l1DaemonExitMidTurn() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'x', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('event.approval.requested', { approval_id: 'appr_exit', tool_name: 'Bash', action: 'x' });
  await sleep(20);
  t.child.emitExit(1);
  await waitFor(() => t.events.byType('error').length >= 1, 2000, 'daemon exit error');
  assert.equal(t.events.byType('permission_dismissed').length, 1, 'pending approvals dismissed on daemon death');
  assert.equal(t.adapter.hasSession('thread-1'), false, 'session released (recovers via resume)');
  ok('daemon exit mid-turn errors the thread, dismisses approvals, releases the session');
}

async function l1ResumeNotFound() {
  const { transport, wsFactory, state } = makeTransport();
  // Genuinely gone: subscribe says not_found AND REST confirms 40401.
  state.missingSessions = ['session_gone_1'];
  wsFactory.onSubscribe = (msg) => ({
    type: 'ack',
    id: msg.id,
    code: 0,
    msg: 'success',
    payload:
      msg.payload.session_ids[0] === 'session_gone_1'
        ? { accepted: [], not_found: ['session_gone_1'], resync_required: [], cursors: {} }
        : wsFactory.defaultSubscribe(msg).payload,
  });
  const adapter = new KimiServerAdapter(transport);
  const events = collectEvents(adapter);
  const session = await adapter.startSession({
    provider: 'kimi',
    threadId: 'thread-r',
    cwd: '/tmp/proj',
    prompt: '',
    resumeSessionId: 'session_gone_1',
  });
  assert.notEqual(session.providerSessionId, 'session_gone_1', 'fell forward to a fresh session');
  const notice = events
    .messages('assistant')
    .find((m) => m.message.content[0]?.text?.includes('Could not restore'));
  assert.ok(notice, 'visible degradation notice (P0-5)');
  const init = events.byType('system_init')[0];
  assert.equal(init.sessionId, session.providerSessionId, 'new id flows back via system_init');
  ok('resume of a dead session falls forward visibly and rebinds the cursor');
}

async function l1ResumeFlushRace() {
  // Daemon-restart flush race: the first subscribe says not_found while REST
  // says the session EXISTS — resolveResume must retry and attach instead of
  // falling forward (a real 50-message session was orphaned this way).
  const { transport, wsFactory, fetchImpl } = makeTransport();
  // Model the REAL daemon semantics: a cold session subscribes as not_found
  // until its messages have been loaded once (warming) in this daemon's
  // lifetime — regardless of how many times you subscribe.
  let warmed = false;
  let subscribeCalls = 0;
  transport.fetchImpl = async (url, init) => {
    if (String(url).includes('/sessions/session_racy_1/messages')) {
      warmed = true;
    }
    return fetchImpl(url, init);
  };
  wsFactory.onSubscribe = (msg) => {
    if (msg.payload.session_ids.includes('session_racy_1')) {
      subscribeCalls += 1;
      if (!warmed) {
        return {
          type: 'ack',
          id: msg.id,
          code: 0,
          msg: 'success',
          payload: { accepted: [], not_found: ['session_racy_1'], resync_required: [], cursors: {} },
        };
      }
    }
    return wsFactory.defaultSubscribe(msg);
  };
  const adapter = new KimiServerAdapter(transport);
  const events = collectEvents(adapter);
  const session = await adapter.startSession({
    provider: 'kimi',
    threadId: 'thread-race',
    cwd: '/tmp/proj',
    prompt: '',
    resumeSessionId: 'session_racy_1',
  });
  assert.equal(session.providerSessionId, 'session_racy_1', 'transient not_found recovers to the SAME session');
  assert.ok(subscribeCalls >= 2, 'subscribe was retried');
  assert.ok(
    fetchImpl.calls.some((call) => call.path === '/api/v1/sessions/session_racy_1/messages'),
    'the session was warmed via GET /messages before the retry'
  );
  assert.ok(
    !events.messages('assistant').some((m) => m.message.content[0]?.text?.includes('Could not restore')),
    'no false degradation notice'
  );

  // Session exists but never attaches: throw loudly, never rebind — the
  // stored id survives for a later retry.
  const t2 = makeTransport();
  t2.wsFactory.onSubscribe = (msg) =>
    msg.payload.session_ids[0] === 'session_stuck_1'
      ? {
          type: 'ack',
          id: msg.id,
          code: 0,
          msg: 'success',
          payload: { accepted: [], not_found: ['session_stuck_1'], resync_required: [], cursors: {} },
        }
      : t2.wsFactory.defaultSubscribe(msg);
  const adapter2 = new KimiServerAdapter(t2.transport);
  const events2 = collectEvents(adapter2);
  await assert.rejects(
    adapter2.startSession({
      provider: 'kimi',
      threadId: 'thread-stuck',
      cwd: '/tmp/proj',
      prompt: '',
      resumeSessionId: 'session_stuck_1',
    }),
    /could not be attached/,
    'exists-but-unattachable throws instead of falling forward'
  );
  assert.equal(events2.byType('system_init').length, 0, 'no system_init → stored id is never rewritten');
  ok('resume verification: flush race retries to the same session; unattachable throws, id preserved');
}

async function l1OneOwnerGuard() {
  const t = await startL1Session();
  await assert.rejects(
    t.adapter.startSession({
      provider: 'kimi',
      threadId: 'thread-2',
      cwd: '/tmp/proj',
      prompt: '',
      resumeSessionId: t.sid,
    }),
    /already bound/,
    'double-binding refused'
  );
  ok('one-owner guard refuses to bind a server session to two threads');
}

async function l1ResyncNotice() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'x', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('assistant.delta', { delta: 'partial' }, true);
  t.state.messages = [
    { role: 'assistant', content: [], toolCalls: [{ id: 'tool_never_emitted' }] },
  ];
  t.adapter.manager.emit('resync_required', { sessionId: t.sid, reason: 'buffer_overflow' });
  await waitFor(
    () =>
      t.events
        .messages('assistant')
        .some((m) => m.message.content[0]?.text?.includes('resynchronized')),
    2000,
    'resync notice'
  );
  const finalized = t.events
    .messages('assistant')
    .find((m) => !m.streaming && m.message.content[0]?.text === 'partial');
  assert.ok(finalized, 'open accumulator finalized, transcript not re-emitted');
  ok('resync finalizes the open stream and surfaces a visible notice');
}

async function l1SlashCatalog() {
  const t = await startL1Session();
  const catalog = await waitFor(
    () =>
      t.events
        .messages('system')
        .find((m) => m.subtype === 'available_commands_update'),
    2000,
    'available_commands_update'
  );
  const names = catalog.availableCommands.map((command) => command.name);
  assert.ok(names.includes('compact'), 'adapter-routed /compact advertised');
  assert.ok(names.includes('skill:clarify'), 'skills advertised with the skill: prefix');
  assert.ok(names.includes('skill:check-kimi-code-docs'), 'builtin skills included');
  assert.ok(!names.includes('status') && !names.includes('help'), 'ACP-only builtins NOT advertised (server does not parse slash text)');
  const clarify = catalog.availableCommands.find((command) => command.name === 'skill:clarify');
  assert.equal(clarify.description, 'Improve unclear UX copy');
  ok('slash catalog: /compact + skill:<name> entries, no ACP-only builtins');
}

async function l1SessionlessSkillListing() {
  const t = makeTransport();
  const adapter = new KimiServerAdapter(t.transport);
  const result = await adapter.listSkills({ provider: 'kimi', cwd: '/tmp/proj' });
  const clarify = result.skills.find((skill) => skill.name === 'clarify');
  assert.ok(clarify, 'workspace-scoped listing returns skills');
  assert.equal(clarify.description, 'Improve unclear UX copy');
  assert.equal(clarify.scope, 'user');
  assert.equal(result.cached, false);
  assert.ok(
    !t.fetchImpl.calls.some((call) => call.path === '/api/v1/sessions' && call.method === 'POST'),
    'workspace route needs no throwaway session'
  );
  const again = await adapter.listSkills({ provider: 'kimi', cwd: '/tmp/proj' });
  assert.equal(again.cached, true, 'second call within TTL is cached');

  // No workspace for the cwd and none at all → throwaway session + archive.
  const t2 = makeTransport();
  t2.state.workspaces = [];
  const adapter2 = new KimiServerAdapter(t2.transport);
  const fallback = await adapter2.listSkills({ provider: 'kimi', cwd: '/tmp/other' });
  assert.ok(fallback.skills.length > 0, 'session fallback returns skills');
  assert.ok(
    t2.fetchImpl.calls.some((call) => /:archive$/.test(call.path)),
    'throwaway listing session is archived'
  );
  ok('sessionless skill listing: workspace route, cache, session fallback + archive');
}

async function l1RunOneShot() {
  const t = makeTransport();
  const adapter = new KimiServerAdapter(t.transport);
  const oneShot = adapter.runOneShot({
    provider: 'kimi',
    threadId: 'oneshot-1',
    cwd: '/tmp/proj',
    prompt: 'Suggest a title',
    model: 'kimi-for-coding',
  });
  await waitFor(() => t.fetchImpl.calls.some((call) => /\/prompts$/.test(call.path)), 3000, 'oneshot submit');
  const ws = t.wsFactory.sockets[0];
  const sid = 'session_test_1';
  ws.receive({ type: 'assistant.delta', seq: 2, session_id: sid, volatile: true, epoch: 'ep1', payload: { type: 'assistant.delta', delta: 'A Nice Title' } });
  ws.receive({ type: 'turn.ended', seq: 3, session_id: sid, epoch: 'ep1', payload: { type: 'turn.ended', reason: 'completed' } });
  const result = await oneShot;
  assert.equal(result.text, 'A Nice Title');
  assert.ok(
    t.fetchImpl.calls.some((call) => /:archive$/.test(call.path)),
    'one-shot session archived (no store littering)'
  );
  ok('runOneShot collects text and archives the throwaway session');
}

async function l1TokenRotationRetry() {
  const t = makeTransport();
  let currentToken = 'tok_l1_test';
  t.transport.readTokenFile = () => currentToken;
  const manager = new KimiServerManager(t.transport);
  await manager.ensureDaemon();
  t.state.expectToken = 'tok_l1_test';
  await manager.createSession('/tmp/proj');
  // User rotates the token: old bearer starts 401ing; the file has the new one.
  t.state.expectToken = 'tok_rotated';
  currentToken = 'tok_rotated';
  const session = await manager.createSession('/tmp/proj');
  assert.ok(session.id, '401 → token file re-read → retried request succeeds');
  ok('token rotation is absorbed by a 401-triggered re-read + retry');
}

// ── Facade (provenance routing) ─────────────────────────────────────────────

function stubAcp(facade) {
  const acp = facade.acp;
  const calls = { start: [], sendTurn: [], stop: [] };
  const threads = new Set();
  acp.startSession = async (input) => {
    calls.start.push(input);
    threads.add(input.threadId);
    return {
      threadId: input.threadId,
      provider: 'kimi',
      providerSessionId: 'acp_session_1',
      status: 'running',
    };
  };
  acp.sendTurn = async (input) => calls.sendTurn.push(input);
  acp.stopSession = async (threadId) => {
    calls.stop.push(threadId);
    threads.delete(threadId);
  };
  acp.hasSession = (threadId) => threads.has(threadId);
  acp.listSessions = () =>
    Array.from(threads).map((threadId) => ({
      threadId,
      provider: 'kimi',
      providerSessionId: 'acp_session_1',
      status: 'running',
    }));
  return calls;
}

async function l1FacadeForkRoundTrip() {
  const t = makeTransport();
  const facade = new KimiAdapterFacade(t.transport);
  stubAcp(facade);
  // Server-provenance id: prefix stripped for the REST call, re-stamped on
  // the returned fork id (stored verbatim for resume routing).
  const forked = await facade.forkThread({ cwd: '/tmp', providerThreadId: `${KIMI_SERVER_ID_PREFIX}session_src_1` });
  assert.equal(forked, `${KIMI_SERVER_ID_PREFIX}session_forked_1`);
  const forkCall = t.fetchImpl.calls.find((call) => /:fork$/.test(call.path));
  assert.ok(forkCall.path.includes('/sessions/session_src_1:fork'), 'prefix stripped before the REST call');
  // Bare (legacy-runtime) ids refuse with a clear error.
  await assert.rejects(
    facade.forkThread({ cwd: '/tmp', providerThreadId: 'bare_acp_id' }),
    /server-runtime/,
    'legacy ids cannot fork'
  );
  ok('facade fork: prefix round-trip + legacy-id refusal');
}

async function l1FacadeProvenanceRouting() {
  // Escape hatch semantics: under AEGIS_KIMI_RUNTIME=acp, bare ids stay on
  // the legacy runtime (no adoption) while server: ids route to the server
  // regardless of the override.
  process.env.AEGIS_KIMI_RUNTIME = 'acp';
  try {
    const t = makeTransport();
    const facade = new KimiAdapterFacade(t.transport);
    const acpCalls = stubAcp(facade);
    const events = collectEvents(facade);

    const acpSession = await facade.startSession({
      provider: 'kimi',
      threadId: 'thread-acp',
      cwd: '/tmp',
      prompt: '',
      resumeSessionId: 'raw_acp_id_123',
    });
    assert.equal(acpCalls.start.length, 1);
    assert.equal(acpCalls.start[0].resumeSessionId, 'raw_acp_id_123');
    assert.equal(acpSession.providerSessionId, 'acp_session_1');

    // server: prefix → server runtime even under the acp override.
    const serverSession = await facade.startSession({
      provider: 'kimi',
      threadId: 'thread-server',
      cwd: '/tmp',
      prompt: '',
      resumeSessionId: `${KIMI_SERVER_ID_PREFIX}session_test_9`,
    });
    assert.ok(serverSession.providerSessionId.startsWith(KIMI_SERVER_ID_PREFIX));
    const init = events.byType('system_init').find((event) => event.threadId === 'thread-server');
    assert.ok(init.sessionId.startsWith(KIMI_SERVER_ID_PREFIX), 'system_init persists the provenance prefix');

    // Provenance stickiness on sendTurn.
    await facade.sendTurn({ threadId: 'thread-acp', prompt: 'hello acp' });
    assert.equal(acpCalls.sendTurn.length, 1, 'ACP thread stays on ACP');
    ok('facade provenance under acp override: bare → ACP, server: → server, sticky');
  } finally {
    delete process.env.AEGIS_KIMI_RUNTIME;
  }
}

async function l1FacadeLegacyAdoption() {
  process.env.AEGIS_KIMI_RUNTIME = 'server';
  try {
    // Default path: a bare legacy id is ADOPTED by the server runtime — the
    // subscribe is accepted, the same id round-trips with the provenance
    // prefix (that prefixed system_init is what rewrites the DB id), and
    // the ACP stub is never touched.
    const t = makeTransport();
    const facade = new KimiAdapterFacade(t.transport);
    const acpCalls = stubAcp(facade);
    const events = collectEvents(facade);
    const session = await facade.startSession({
      provider: 'kimi',
      threadId: 'thread-migrate',
      cwd: '/tmp',
      prompt: '',
      resumeSessionId: 'raw_acp_id_123',
    });
    assert.equal(acpCalls.start.length, 0, 'ACP is not consulted on the default path');
    assert.equal(session.providerSessionId, `${KIMI_SERVER_ID_PREFIX}raw_acp_id_123`, 'same id, prefixed');
    const init = events.byType('system_init').find((event) => event.threadId === 'thread-migrate');
    assert.equal(init.sessionId, `${KIMI_SERVER_ID_PREFIX}raw_acp_id_123`, 'rewrite rides system_init');
    assert.ok(
      !t.fetchImpl.calls.some((call) => call.path === '/api/v1/sessions' && call.method === 'POST'),
      'adoption creates no new session'
    );

    // Adoption REFUSED (server does not know the id — subscribe not_found
    // AND REST-confirmed 40401): the thread stays on the legacy runtime and
    // the bare id is never destroyed.
    const t2 = makeTransport();
    t2.state.missingSessions = ['raw_dead_id_9'];
    t2.wsFactory.onSubscribe = (msg) => ({
      type: 'ack',
      id: msg.id,
      code: 0,
      msg: 'success',
      payload: { accepted: [], not_found: msg.payload.session_ids, resync_required: [], cursors: {} },
    });
    const facade2 = new KimiAdapterFacade(t2.transport);
    const acpCalls2 = stubAcp(facade2);
    const refused = await facade2.startSession({
      provider: 'kimi',
      threadId: 'thread-stay',
      cwd: '/tmp',
      prompt: '',
      resumeSessionId: 'raw_dead_id_9',
    });
    assert.equal(acpCalls2.start.length, 1, 'refused adoption falls back to the legacy runtime');
    assert.equal(acpCalls2.start[0].resumeSessionId, 'raw_dead_id_9', 'bare id passed through untouched');
    assert.equal(refused.providerSessionId, 'acp_session_1', 'no server session was created or persisted');
    ok('legacy adoption: accepted → server with same prefixed id; refused → ACP, id preserved');
  } finally {
    delete process.env.AEGIS_KIMI_RUNTIME;
  }
}

async function l1FacadeDefaultRuntime() {
  process.env.AEGIS_KIMI_RUNTIME = 'acp';
  try {
    const t = makeTransport();
    const facade = new KimiAdapterFacade(t.transport);
    const acpCalls = stubAcp(facade);
    await facade.startSession({ provider: 'kimi', threadId: 'thread-n1', cwd: '/tmp', prompt: '' });
    assert.equal(acpCalls.start.length, 1, 'override=acp routes new threads to ACP');
  } finally {
    process.env.AEGIS_KIMI_RUNTIME = 'server';
  }
  const t2 = makeTransport();
  const facade2 = new KimiAdapterFacade(t2.transport);
  stubAcp(facade2);
  const session = await facade2.startSession({ provider: 'kimi', threadId: 'thread-n2', cwd: '/tmp', prompt: '' });
  assert.ok(session.providerSessionId.startsWith(KIMI_SERVER_ID_PREFIX), 'override=server routes new threads to server');
  delete process.env.AEGIS_KIMI_RUNTIME;
  ok('AEGIS_KIMI_RUNTIME picks the runtime for NEW threads only');
}

async function l1FacadeAcpStopSettles() {
  process.env.AEGIS_KIMI_RUNTIME = 'acp';
  try {
    const t = makeTransport();
    const facade = new KimiAdapterFacade(t.transport);
    stubAcp(facade);
    const events = collectEvents(facade);
    await facade.startSession({ provider: 'kimi', threadId: 'thread-a', cwd: '/tmp', prompt: '' });
    await facade.stopSession('thread-a');
    const settle = events.byType('stop_settled')[0];
    assert.ok(settle, 'ACP stop emits a synthetic settle');
    assert.equal(settle.confirmed, true);
    ok('ACP-runtime stop settles synthetically so the ipc two-phase gate never hangs');
  } finally {
    delete process.env.AEGIS_KIMI_RUNTIME;
  }
}

// ═══════════════════════════════ L2 tests ═══════════════════════════════════

const l2Children = [];
function makeL2Transport(behavior = 'ok', extraEnv = {}) {
  return {
    spawnDaemon: (binary, args) => {
      const child = spawn(process.execPath, [FAKE_SERVER, ...args.filter((a) => a !== 'server' && a !== 'run' && a !== '--foreground')], {
        env: {
          ...process.env,
          AEGIS_FAKE_KIMI_BEHAVIOR: behavior,
          AEGIS_FAKE_KIMI_TOKEN: 'tok_l2',
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      l2Children.push(child);
      return child;
    },
    resolveBinary: async () => '/fake/kimi-l2',
    readTokenFile: () => (behavior === 'no-token' ? null : 'tok_l2'),
  };
}

async function l2CleanBoot() {
  const manager = new KimiServerManager(makeL2Transport('ok'));
  await manager.ensureDaemon();
  const session = await manager.createSession('/tmp/proj');
  assert.ok(session.id.startsWith('session_fake_'));
  const models = await manager.listModels();
  assert.equal(models[0].model, 'fake-default-model');
  await manager.stop();
  ok('L2 clean boot: token line parsed, healthz gated, REST envelope unwrapped');
}

async function l2DelayedToken() {
  const manager = new KimiServerManager(makeL2Transport('delayed-token'));
  await manager.ensureDaemon();
  const session = await manager.createSession('/tmp/proj');
  assert.ok(session.id);
  await manager.stop();
  ok('L2 delayed token line still boots (poll until deadline)');
}

async function l2MalformedTokenFallsBackToFile() {
  // Banner has an empty Token: line — the persistent token file wins.
  const manager = new KimiServerManager(makeL2Transport('malformed-token'));
  await manager.ensureDaemon();
  const session = await manager.createSession('/tmp/proj');
  assert.ok(session.id);
  await manager.stop();
  ok('L2 malformed token banner falls back to the token file');
}

async function l2NoTokenAnywhereFails() {
  const manager = new KimiServerManager(makeL2Transport('no-token'));
  await assert.rejects(manager.ensureDaemon(), /token|ready/i);
  await manager.stop();
  ok('L2 no token anywhere → loud spawn failure (no silent downgrade)');
}

async function l2UnhealthyNeverGreens() {
  const manager = new KimiServerManager(makeL2Transport('unhealthy'));
  await assert.rejects(manager.ensureDaemon(), /healthz/i);
  await manager.stop();
  ok('L2 healthz gating: a listening-but-unhealthy daemon never becomes ready');
}

async function l2AdoptExistingSingleton() {
  // A real "daemon" already running…
  const first = new KimiServerManager(makeL2Transport('ok'));
  const state = await first.ensureDaemon();
  const realPort = state.port;
  // …and a second manager whose spawn refuses with the singleton message.
  const second = new KimiServerManager(
    makeL2Transport('already-running', { AEGIS_FAKE_KIMI_REAL_PORT: String(realPort) })
  );
  await second.ensureDaemon();
  const session = await second.createSession('/tmp/proj');
  assert.ok(session.id, 'adopted daemon serves REST');
  // killSync on the adopter must NOT kill the daemon it does not own.
  second.killSync();
  await sleep(100);
  const stillAlive = await fetch(`http://127.0.0.1:${realPort}/api/v1/healthz`).then(
    (response) => response.ok,
    () => false
  );
  assert.equal(stillAlive, true, 'adopted daemon survives the adopter quitting');
  await first.stop();
  ok('L2 singleton adoption: parse refusal, adopt port+token, never kill what we did not spawn');
}

async function l2DaemonDiesMidTurn() {
  const adapter = new KimiServerAdapter(makeL2Transport('die-after-prompt'));
  const events = collectEvents(adapter);
  await adapter.startSession({ provider: 'kimi', threadId: 'l2-die', cwd: '/tmp/proj', prompt: '' });
  await adapter.sendTurn({ threadId: 'l2-die', prompt: 'x', model: 'fake-default-model' });
  await waitFor(() => events.byType('error').length >= 1, 5000, 'daemon-death error');
  assert.equal(adapter.hasSession('l2-die'), false, 'session released');
  const deadGeneration = adapter.manager.getGeneration();
  // Failure domain (b): the next call goes down the full respawn path on a
  // fresh generation — deterministic recovery, no ACP fallback.
  const recovered = await adapter.manager.createSession('/tmp/proj');
  assert.ok(recovered.id, 'respawn path recovers REST');
  assert.ok(adapter.manager.getGeneration() > deadGeneration, 'new daemon generation');
  await adapter.stopAll();
  ok('L2 daemon death mid-turn: thread errors, session releases, respawn recovers');
}

async function l2WsDropCursorResubscribe() {
  const adapter = new KimiServerAdapter(makeL2Transport('ok'));
  const events = collectEvents(adapter);
  const session = await adapter.startSession({ provider: 'kimi', threadId: 'l2-ws', cwd: '/tmp/proj', prompt: '' });
  const sid = session.providerSessionId;
  await adapter.sendTurn({ threadId: 'l2-ws', prompt: 'hello', model: 'fake-default-model' });
  await waitFor(() => events.messages('result').length === 1, 5000, 'first turn result');

  const state = await adapter.manager.ensureDaemon();
  const control = (path, body) =>
    fetch(`http://127.0.0.1:${state.port}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok_l2', 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

  // Drop every WS, then emit a buffered frame while the client is offline.
  await control('/__test/drop-ws');
  await control('/__test/emit', {
    sessionId: sid,
    frames: [{ type: 'tool.call.started', payload: { toolCallId: 'tool_offline', name: 'Read', args: {} } }],
  });
  // Reconnect + cursor resubscribe must replay exactly that frame.
  await waitFor(
    () =>
      events
        .messages('assistant')
        .filter((m) => m.message.content[0]?.type === 'tool_use' && m.message.content[0].id === 'tool_offline')
        .length === 1,
    6000,
    'replayed offline frame'
  );
  await sleep(150);
  const replays = events
    .messages('assistant')
    .filter((m) => m.message.content[0]?.type === 'tool_use' && m.message.content[0].id === 'tool_offline');
  assert.equal(replays.length, 1, 'replayed exactly once (cursor + seq dedupe)');
  await adapter.stopAll();
  ok('L2 WS drop: reconnect resubscribes with cursors and replays the gap exactly once');
}

async function l2DeepBacklogResync() {
  const adapter = new KimiServerAdapter(makeL2Transport('ok'));
  const events = collectEvents(adapter);
  const session = await adapter.startSession({ provider: 'kimi', threadId: 'l2-resync', cwd: '/tmp/proj', prompt: '' });
  const sid = session.providerSessionId;
  const state = await adapter.manager.ensureDaemon();
  const control = (path, body) =>
    fetch(`http://127.0.0.1:${state.port}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok_l2', 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  await control('/__test/drop-ws');
  // Force an epoch mismatch on resubscribe by faking the stored cursor.
  adapter.manager.subscriptions.set(sid, { seq: 1, epoch: 'ep_other_epoch' });
  await waitFor(
    () =>
      events
        .messages('assistant')
        .some((m) => m.message.content[0]?.text?.includes('resynchronized')),
    6000,
    'resync notice'
  );
  await adapter.stopAll();
  ok('L2 unreplayable gap (epoch change) surfaces the visible resync notice');
}

async function l2QuitKillOrdering() {
  const manager = new KimiServerManager(makeL2Transport('ok'));
  const state = await manager.ensureDaemon();
  const child = l2Children[l2Children.length - 1];
  manager.killSync();
  await waitFor(() => child.exitCode !== null, 3000, 'owned daemon exit');
  const alive = await fetch(`http://127.0.0.1:${state.port}/api/v1/healthz`).then(
    () => true,
    () => false
  );
  assert.equal(alive, false, 'owned daemon is gone after killSync');
  ok('L2 quit ordering: killSync tears down the owned daemon synchronously');
}

// ═════════════════════ Audit-fix suites (kimi-server-fixes-plan v2) ═════════

// F10: a stop between the submit REST ack and the WS turn.started frame must
// still reach the server (cancel the tracked prompt + belt-and-braces abort).
async function l1StopSubmitWindow() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  // No turn.started pushed — we are inside the ack→frame window.
  await t.adapter.stopSession('thread-1');
  const cancel = t.fetchImpl.calls.find((call) => /\/prompts\/prompt_1:cancel$/.test(call.path));
  const abort = t.fetchImpl.calls.find((call) => /:abort$/.test(call.path));
  assert.ok(cancel, 'queued/submitted prompt is cancelled on stop');
  assert.ok(abort, 'abort covers a possibly-already-running turn');
  const settled = t.events.byType('stop_settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].confirmed, true, 'settles confirmed without waiting for a terminal');
  ok('stop in the submit→turn.started window cancels the prompt and aborts (F10)');
}

// F10: a stop while the submit REST call is still in flight — the submit
// continuation must cancel+abort its own prompt after the release.
async function l1StopDuringInflightSubmit() {
  const t = await startL1Session();
  t.state.submitDelayMs = 80;
  const sendPromise = t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  await sleep(15);
  await t.adapter.stopSession('thread-1');
  assert.equal(t.events.byType('stop_settled').length, 1, 'stop settles immediately');
  await sendPromise;
  await waitFor(
    () => t.fetchImpl.calls.some((call) => /\/prompts\/prompt_1:cancel$/.test(call.path)),
    2000,
    'late submit continuation cancels its prompt'
  );
  assert.ok(
    t.fetchImpl.calls.some((call) => /:abort$/.test(call.path)),
    'late submit continuation aborts'
  );
  ok('stop during an in-flight submit: the continuation cancels+aborts (F10)');
}

// F11: turn.ended(completed) racing a pending stop settles it confirmed
// instead of hanging "stopping" until the safety timer's false warning.
async function l1StopVsNaturalCompletion() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  const stopPromise = t.adapter.stopSession('thread-1');
  t.push('turn.ended', { reason: 'completed', durationMs: 5 });
  await stopPromise;
  await waitFor(() => t.events.byType('stop_settled').length === 1, 1000, 'stop settled');
  assert.equal(t.events.byType('stop_settled')[0].confirmed, true, 'completed settles the stop confirmed');
  assert.equal(t.events.messages('result').length, 1, 'exactly one result');
  assert.equal(t.events.messages('result')[0].subtype, 'success');
  ok('turn.ended(completed) settles a pending stop confirmed (F11)');
}

// F13: a failed approval REST resolution keeps the interaction answerable —
// notice + re-emitted permission_request; the retry lands.
async function l1ApprovalRestFailureRetry() {
  const t = await startL1Session({ kimiPermissionMode: 'default' });
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('event.approval.requested', { approval_id: 'ap1', toolName: 'Bash', action: 'run ls' });
  await waitFor(() => t.events.byType('permission_request').length === 1, 1000, 'request');
  const requestId = t.events.byType('permission_request')[0].requestId;

  t.state.failApprovalOnce = true;
  await assert.rejects(
    t.adapter.respondToRequest('thread-1', requestId, { behavior: 'allow', updatedInput: { optionId: 'approved' } })
  );
  await waitFor(() => t.events.byType('permission_request').length === 2, 1000, 're-emit');
  assert.equal(t.events.byType('permission_request')[1].requestId, requestId, 'same requestId re-emitted');
  assert.ok(
    t.events.messages('assistant').some((m) => m.message.content[0]?.text?.includes("didn't reach")),
    'failure notice shown'
  );

  await t.adapter.respondToRequest('thread-1', requestId, { behavior: 'allow', updatedInput: { optionId: 'approved' } });
  const posts = t.fetchImpl.calls.filter((call) => /\/approvals\//.test(call.path));
  assert.equal(posts.length, 2, 'failed attempt + successful retry');
  // Entry consumed on success: a third answer is a fail-closed no-op.
  await t.adapter.respondToRequest('thread-1', requestId, { behavior: 'deny' });
  assert.equal(t.fetchImpl.calls.filter((call) => /\/approvals\//.test(call.path)).length, 2);
  ok('approval REST failure → notice + re-emitted card; retry lands once (F13)');
}

// F13: an expired approval (envelope 40404, probe P5) dismisses the card.
async function l1ApprovalExpiredDismiss() {
  const t = await startL1Session({ kimiPermissionMode: 'default' });
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('event.approval.requested', { approval_id: 'ap2', toolName: 'Bash', action: 'run ls' });
  await waitFor(() => t.events.byType('permission_request').length === 1, 1000, 'request');
  const requestId = t.events.byType('permission_request')[0].requestId;
  t.state.approvalsCode = 40404;
  await t.adapter.respondToRequest('thread-1', requestId, { behavior: 'allow', updatedInput: { optionId: 'approved' } });
  assert.equal(t.events.byType('permission_dismissed').length, 1, 'card dismissed');
  assert.equal(t.events.byType('permission_request').length, 1, 'no re-emit for an expired approval');
  ok('expired approval (40404) maps to permission_dismissed (F13)');
}

// F13: double-click while the resolution is in flight → exactly one REST call.
async function l1ApprovalDoubleClickLatch() {
  const t = await startL1Session({ kimiPermissionMode: 'default' });
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('event.approval.requested', { approval_id: 'ap3', toolName: 'Bash', action: 'run ls' });
  await waitFor(() => t.events.byType('permission_request').length === 1, 1000, 'request');
  const requestId = t.events.byType('permission_request')[0].requestId;
  t.state.approvalDelayMs = 60;
  const first = t.adapter.respondToRequest('thread-1', requestId, { behavior: 'allow', updatedInput: { optionId: 'approved' } });
  const second = t.adapter.respondToRequest('thread-1', requestId, { behavior: 'deny' });
  await Promise.all([first, second]);
  const posts = t.fetchImpl.calls.filter((call) => /\/approvals\//.test(call.path));
  assert.equal(posts.length, 1, 'the concurrent second answer is dropped');
  assert.equal(posts[0].body.decision, 'approved', 'the first answer wins');
  ok('concurrent double-answer resolves once (F13 latch)');
}

// F16: a steer-path submit failure must not fail the RUNNING turn.
async function l1SteerSubmitFailureNoDoubleTerminal() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'first', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.state.failSubmitOnce = true;
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'steer me', model: 'm' });
  assert.equal(t.events.messages('result').length, 0, 'no terminal for the running turn');
  assert.equal(t.events.byType('error').length, 0, 'no error event mid-turn');
  assert.ok(
    t.events.messages('assistant').some((m) => m.message.content[0]?.text?.includes("wasn't submitted")),
    'failure notice shown'
  );
  t.push('turn.ended', { reason: 'completed', durationMs: 5 });
  await waitFor(() => t.events.messages('result').length === 1, 1000, 'single terminal');
  assert.equal(t.events.messages('result')[0].subtype, 'success');
  ok('mid-turn submit failure: notice only, one terminal (F16)');
}

// F16: /compact submitted mid-turn is rejected with a notice.
async function l1CompactMidTurnRejected() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'first', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: '/compact', model: 'm' });
  assert.ok(
    t.events.messages('assistant').some((m) => m.message.content[0]?.text?.includes('Wait for the current turn')),
    'mid-turn compact notice'
  );
  assert.ok(!t.fetchImpl.calls.some((call) => /:compact$/.test(call.path)), 'no compact call mid-turn');
  assert.equal(t.events.messages('result').length, 0, 'no synthetic terminal into the live turn');
  ok('/compact mid-turn rejected with a notice (F16)');
}

// F15: duplicated volatile deltas dedupe by offset; no doubled text.
async function l1OffsetDedupe() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('assistant.delta', { delta: 'Hel' }, true, { offset: 0 });
  t.push('assistant.delta', { delta: 'Hel' }, true, { offset: 0 }); // volatile dup
  t.push('assistant.delta', { delta: 'lo' }, true, { offset: 3 });
  t.push('turn.ended', { reason: 'completed', durationMs: 5 });
  await waitFor(() => t.events.messages('result').length === 1, 1000, 'result');
  const finals = t.events.messages('assistant').filter((m) => !m.streaming && m.message.content[0]?.type === 'text');
  assert.equal(finals[finals.length - 1].message.content[0].text, 'Hello', 'duplicate frame did not double text');
  ok('offset dedupe: repeated volatile delta appends nothing (F15)');
}

// F15: a dropped delta (offset ahead) is repaired from GET /messages at turn
// end, under the SAME streamed uuid.
async function l1OffsetGapRepair() {
  const t = await startL1Session();
  t.state.messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ];
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('assistant.delta', { delta: 'Hel' }, true, { offset: 0 });
  t.push('assistant.delta', { delta: 'ld' }, true, { offset: 9 }); // dropped middle
  const streamedUuid = t.events
    .messages('assistant')
    .filter((m) => m.streaming)
    .at(-1).uuid;
  t.push('turn.ended', { reason: 'completed', durationMs: 5 });
  await waitFor(
    () =>
      t.events
        .messages('assistant')
        .some((m) => !m.streaming && m.uuid === streamedUuid && m.message.content[0]?.text === 'Hello world'),
    2000,
    'authoritative repair under the same uuid'
  );
  ok('offset gap repaired from GET /messages under the streamed uuid (F15)');
}

// F15: per-segment offset reset at a tool-call boundary is NOT a gap.
async function l1OffsetSegments() {
  const t = await startL1Session();
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.push('assistant.delta', { delta: 'One' }, true, { offset: 0 });
  t.push('tool.call.started', { toolCallId: 'tc-seg', name: 'List' });
  t.push('tool.result', { toolCallId: 'tc-seg', output: 'ok' });
  t.push('assistant.delta', { delta: 'Two' }, true, { offset: 0 }); // new segment
  t.push('assistant.delta', { delta: '!' }, true, { offset: 3 });
  t.push('turn.ended', { reason: 'completed', durationMs: 5 });
  await waitFor(() => t.events.messages('result').length === 1, 1000, 'result');
  assert.ok(
    !t.events.messages('assistant').some((m) => m.message.content[0]?.text?.includes('connection blip')),
    'no spurious gap repair/notice across the segment boundary'
  );
  const finals = t.events
    .messages('assistant')
    .filter((m) => !m.streaming && m.message.content[0]?.type === 'text')
    .map((m) => m.message.content[0].text);
  assert.ok(finals.includes('One') && finals.includes('Two!'), 'both segments finalized intact');
  ok('offset resets per assistant segment without false gaps (F15/P4)');
}

// F8: daemon death errors only mid-turn sessions; idle ones release silently.
async function l1DaemonExitIdleQuiet() {
  const t = await startL1Session();
  await t.adapter.startSession({ provider: 'kimi', threadId: 'thread-idle', cwd: '/tmp/proj', prompt: '' });
  await t.adapter.sendTurn({ threadId: 'thread-1', prompt: 'hi', model: 'm' });
  t.push('turn.started', { turnId: 1 });
  t.child.emitExit(1);
  await waitFor(() => t.events.byType('error').length === 1, 2000, 'mid-turn error');
  const errorThreads = t.events.byType('error').map((event) => event.threadId);
  assert.deepEqual(errorThreads, ['thread-1'], 'only the mid-turn session errors');
  const errorResults = t.events
    .filter((e) => e.type === 'message' && e.message.type === 'result' && e.threadId === 'thread-1')
    .map((e) => e.message);
  assert.equal(errorResults.length, 1, 'mid-turn session gets its terminal');
  assert.equal(errorResults[0].subtype, 'error');
  const idleStatusErrors = t.events
    .byType('status_change')
    .filter((event) => event.threadId === 'thread-idle' && event.status === 'error');
  assert.equal(idleStatusErrors.length, 0, 'idle session never flips to error');
  assert.equal(t.adapter.hasSession('thread-idle'), false, 'idle session released for transparent resume');
  ok('daemon exit: mid-turn errors with terminal, idle releases silently (F8)');
}

// F5b: a daemon bounce during resume must not bind the session to the dead
// generation (stale_generation on every later send).
async function l1StaleGenerationRebind() {
  const children = [];
  const base = makeTransport();
  base.transport.spawnDaemon = () => {
    const child = makeFakeChild();
    children.push(child);
    setImmediate(() => child.emitStdout('\n  Kimi server ready  0.26.0\n\n  Token:    tok_l1_test\n\n'));
    return child;
  };
  let subscribeCount = 0;
  base.wsFactory.onSubscribe = (msg) => {
    subscribeCount += 1;
    if (subscribeCount === 1) {
      // First resume attempt: not_found — and the daemon dies underneath.
      setImmediate(() => children[0]?.emitExit(1));
      return {
        type: 'ack',
        id: msg.id,
        code: 0,
        msg: 'success',
        payload: { accepted: [], not_found: msg.payload.session_ids, resync_required: [], cursors: {} },
      };
    }
    return base.wsFactory.defaultSubscribe(msg);
  };
  const adapter = new KimiServerAdapter(base.transport);
  collectEvents(adapter);
  await adapter.startSession({
    provider: 'kimi',
    threadId: 'thread-gen',
    cwd: '/tmp/proj',
    prompt: '',
    resumeSessionId: 'session_resume_x',
  });
  // The regression threw stale_generation here (session bound to gen 1 on a
  // gen-2 daemon).
  await adapter.sendTurn({ threadId: 'thread-gen', prompt: 'hi', model: 'm' });
  assert.ok(
    base.fetchImpl.calls.some((call) => /\/prompts$/.test(call.path)),
    'sendTurn reaches the daemon after the mid-resume bounce'
  );
  ok('session binds the post-resume generation, not the pre-resume one (F5b)');
}

// F9b: a reconnect-ack not_found is verified before session_gone.
async function l1ReconnectNotFoundVerified() {
  const t = await startL1Session();
  let resubscribes = 0;
  t.wsFactory.onSubscribe = (msg) => {
    resubscribes += 1;
    if (resubscribes <= 2) {
      return {
        type: 'ack',
        id: msg.id,
        code: 0,
        msg: 'success',
        payload: { accepted: [], not_found: msg.payload.session_ids, resync_required: [], cursors: {} },
      };
    }
    return t.wsFactory.defaultSubscribe(msg);
  };
  t.ws.drop();
  await waitFor(() => resubscribes >= 3, 4000, 'verification resubscribes');
  await sleep(60);
  assert.equal(t.adapter.hasSession('thread-1'), true, 'session survives a transient not_found');
  assert.ok(
    !t.events.messages('assistant').some((m) => m.message.content[0]?.text?.includes('no longer has this session')),
    'no gone notice for a recovered session'
  );
  ok('reconnect not_found recovers via verification — no session_gone (F9b)');
}

// F9b: REST-confirmed absence still notifies (and idle release is quiet).
async function l1ReconnectGoneConfirmed() {
  const t = await startL1Session();
  t.state.missingSessions = [t.sid];
  t.wsFactory.onSubscribe = (msg) => ({
    type: 'ack',
    id: msg.id,
    code: 0,
    msg: 'success',
    payload: { accepted: [], not_found: msg.payload.session_ids, resync_required: [], cursors: {} },
  });
  t.ws.drop();
  await waitFor(() => t.adapter.hasSession('thread-1') === false, 4000, 'confirmed-gone release');
  assert.ok(
    t.events.messages('assistant').some((m) => m.message.content[0]?.text?.includes('no longer has this session')),
    'gone notice shown'
  );
  assert.equal(t.events.byType('error').length, 0, 'idle gone releases without an error event');
  ok('double-confirmed absence releases the thread with a notice (F9b/F14)');
}

// F9a: the reconnect loop re-reads a rotated token before dialing.
async function l1WsReconnectTokenRefresh() {
  let token = 'tok_l1_test';
  const t = await startL1Session({ transport: { readTokenFile: () => token } });
  token = 'tok_rotated';
  t.ws.drop();
  await waitFor(() => t.wsFactory.sockets.length >= 2, 4000, 'reconnect socket');
  const reconnect = t.wsFactory.sockets[t.wsFactory.sockets.length - 1];
  assert.equal(reconnect.headers.authorization, 'Bearer tok_rotated', 'fresh token on reconnect');
  ok('WS reconnect re-reads the rotated token (F9a)');
}

// F3b: the refused adoption probe child's LATE exit must not tear down the
// freshly adopted daemon.
async function l1AdoptionProbeChildLateExit() {
  const { transport, child } = makeTransport({
    spawnDaemon: undefined, // use the child below
  });
  transport.spawnDaemon = () => {
    setImmediate(() => child.emitStderr('Error: server already running (pid=999, port=4321).\n'));
    return child;
  };
  const manager = new KimiServerManager(transport);
  let daemonExits = 0;
  manager.on('daemon_exit', () => {
    daemonExits += 1;
  });
  await manager.ensureDaemon();
  // The refused probe child exits AFTER adoption completed.
  child.emitExit(0);
  await sleep(30);
  assert.equal(manager.isRunning(), true, 'adopted daemon survives the probe child exit');
  assert.equal(daemonExits, 0, 'no daemon_exit for the expected probe-child exit');
  ok('adoption disarms the probe-child exit handler (F3b)');
}

// F3/F5: a healthz-never spawn must not leak the owned child, and killSync
// during the spawn window reaps it synchronously.
async function l1SpawnFailureReapsChild() {
  const state = { expectToken: null };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/v1/healthz') {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, msg: 'success', data: {} }) };
  };
  const child = makeFakeChild();
  const manager = new KimiServerManager({
    fetchImpl,
    createWebSocket: makeFakeWsFactory(),
    spawnDaemon: () => {
      setImmediate(() => child.emitStdout('\n  Kimi server ready  0.26.0\n\n  Token:    tok_x\n\n'));
      return child;
    },
    resolveBinary: async () => '/fake/kimi',
    readTokenFile: () => 'tok_x',
  });
  await assert.rejects(manager.ensureDaemon(), /healthz/i);
  assert.ok(child.killed.includes('SIGTERM'), 'owned child reaped after healthz failure (F3)');

  const child2 = makeFakeChild();
  const manager2 = new KimiServerManager({
    fetchImpl,
    createWebSocket: makeFakeWsFactory(),
    spawnDaemon: () => child2, // never becomes ready
    resolveBinary: async () => '/fake/kimi',
    readTokenFile: () => null,
  });
  const pending = manager2.ensureDaemon();
  await sleep(20);
  manager2.killSync();
  assert.ok(child2.killed.includes('SIGTERM'), 'killSync reaps the in-flight spawn synchronously (F5)');
  await assert.rejects(pending);
  ok('spawn failures and quit races never leak the owned child (F3/F5)');
}

// F4: a request timeout (or transient error with a live daemon) fails that
// request only — no all-session teardown.
async function l1RequestTimeoutIsolated() {
  process.env.AEGIS_KIMI_SERVER_REQUEST_TIMEOUT_MS = '80';
  try {
    const t = await startL1Session();
    let daemonExits = 0;
    t.adapter.manager.on('daemon_exit', () => {
      daemonExits += 1;
    });
    const baseFetch = t.fetchImpl;
    let slowOnce = true;
    t.adapter.manager.fetchImpl = async (url, init) => {
      if (slowOnce && /\/messages$/.test(new URL(url).pathname)) {
        slowOnce = false;
        // A real fetch rejects when its signal aborts — honor it.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 300);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new TypeError('operation aborted'));
          });
        });
      }
      return baseFetch(url, init);
    };
    await assert.rejects(t.adapter.manager.getMessages(t.sid), /timeout/i);
    assert.equal(daemonExits, 0, 'timeout does not declare daemon death');
    assert.equal(t.adapter.hasSession('thread-1'), true, 'sessions untouched');
    await t.adapter.manager.getMessages(t.sid); // next request is fine
    // Transient socket error with a live daemon (healthz OK): request-scoped.
    let failOnce = true;
    t.adapter.manager.fetchImpl = async (url, init) => {
      if (failOnce && /\/messages$/.test(new URL(url).pathname)) {
        failOnce = false;
        throw new TypeError('fetch failed: ECONNRESET');
      }
      return baseFetch(url, init);
    };
    await assert.rejects(t.adapter.manager.getMessages(t.sid), /http_error/i);
    assert.equal(daemonExits, 0, 'transient error with healthy daemon is not death');
  } finally {
    process.env.AEGIS_KIMI_SERVER_REQUEST_TIMEOUT_MS = '3000';
  }
  ok('timeouts and transient errors are request-scoped, never a teardown (F4)');
}

// F7/F12: capability probe caching + sync default runtime.
async function l1CapabilityProbeCache() {
  const outcomes = [];
  let probeCalls = 0;
  setKimiCapabilityProbeForTests(async () => {
    probeCalls += 1;
    return outcomes.shift() || { definitive: false, capable: false };
  });
  try {
    assert.equal(getKimiDefaultRuntime(), 'acp', 'unresolved probe defaults to legacy (steer-safe)');
    outcomes.push({ definitive: false, capable: false });
    assert.equal(await isKimiServerCapable(), false, 'indeterminate reads false for this call');
    outcomes.push({ definitive: true, capable: true });
    assert.equal(await isKimiServerCapable(), true, 'not cached: next call re-probes');
    assert.equal(getKimiDefaultRuntime(), 'server', 'definitive verdict flips the sync default');
    const before = probeCalls;
    assert.equal(await isKimiServerCapable(), true);
    assert.equal(probeCalls, before, 'definitive verdict is cached');

    setKimiCapabilityProbeForTests(async () => ({ definitive: false, capable: false }));
    await assert.rejects(requireKimiServerCapability(), /could not determine/i, 'loud fail after two indeterminates');

    setKimiCapabilityProbeForTests(async () => ({ definitive: true, capable: false }));
    assert.equal(await requireKimiServerCapability(), false, 'definitive no routes to ACP');
    assert.equal(getKimiDefaultRuntime(), 'acp');

    process.env.AEGIS_KIMI_RUNTIME = 'server';
    assert.equal(getKimiDefaultRuntime(), 'server', 'env override wins');
  } finally {
    delete process.env.AEGIS_KIMI_RUNTIME;
    setKimiCapabilityProbeForTests(PINNED_CAPABLE_PROBE);
  }
  ok('capability probe: indeterminate never cached, loud start fail, sync default (F7/F12)');
}

// F1/F13 at the agent-loop level: a two-phase-stopped runner is detached at
// settle, so the replacement's permission requests reach the USER, not the
// stale-handle auto-deny.
async function l1AgentLoopStopDetachPermission() {
  process.env.AEGIS_KIMI_RUNTIME = 'server';
  try {
    ensureProviderService();
    const service = getProviderService();
    const base = makeTransport();
    const facade = new KimiAdapterFacade(base.transport);
    service.registerAdapter(facade);
    const baselineListeners = service.events.listenerCount('event');

    const stoppedHandles = new Set();
    const makeRunner = (resumeSessionId, onPermission) =>
      runAgentLoop({
        prompt: '',
        session: { id: 'al-thread', provider: 'kimi', cwd: '/tmp/proj' },
        resumeSessionId,
        onMessage: () => {},
        onError: () => {},
        onPermissionRequest: onPermission,
      });

    // Runner A: its permission callback mimics the ipc stale-handle guard.
    let aPermissionCalls = 0;
    const handleA = makeRunner(undefined, async () => {
      aPermissionCalls += 1;
      return { behavior: 'deny', message: 'The user stopped this turn.' };
    });
    await waitFor(() => facade.hasSession('al-thread'), 3000, 'A session');
    const ws = base.wsFactory.sockets[0];
    const sid = 'session_test_1';
    let seq = 1;
    const push = (type, payload = {}) => {
      seq += 1;
      ws.receive({ type, seq, session_id: sid, payload: { type, ...payload }, epoch: 'ep1' });
    };

    await facade.sendTurn({ threadId: 'al-thread', prompt: 'hi', model: 'm' });
    push('turn.started', { turnId: 1 });

    // Two-phase stop; the cancelled terminal confirms it.
    const settlePromise = handleA.interruptAndSettle();
    await sleep(30);
    push('turn.ended', { reason: 'cancelled' });
    const settled = await settlePromise;
    assert.equal(settled.confirmed, true, 'stop settles confirmed');

    // ipc settle continuation: retire + DETACH the stopped runner.
    stoppedHandles.add(handleA);
    assert.equal(typeof handleA.detach, 'function', 'runner handle exposes detach()');
    handleA.detach();

    // Replacement runner B with a real user decision.
    let resolveDecision;
    const decision = new Promise((resolve) => {
      resolveDecision = resolve;
    });
    let bPermissionCalls = 0;
    const handleB = makeRunner(`${KIMI_SERVER_ID_PREFIX}${sid}`, async () => {
      bPermissionCalls += 1;
      return decision;
    });
    await waitFor(() => facade.hasSession('al-thread'), 3000, 'B session');
    await facade.sendTurn({ threadId: 'al-thread', prompt: 'again', model: 'm' });
    push('turn.started', { turnId: 2 });
    push('event.approval.requested', { approval_id: 'al-ap1', toolName: 'Bash', action: 'run ls' });
    await waitFor(() => bPermissionCalls === 1, 2000, "B's permission callback");
    assert.equal(aPermissionCalls, 0, 'the detached runner never auto-denies (F1)');

    resolveDecision({ behavior: 'allow', updatedInput: { optionId: 'approved' } });
    await waitFor(
      () => base.fetchImpl.calls.filter((call) => /\/approvals\//.test(call.path)).length === 1,
      2000,
      'approval resolution'
    );
    assert.equal(
      base.fetchImpl.calls.find((call) => /\/approvals\//.test(call.path)).body.decision,
      'approved',
      "the USER's answer reaches the server"
    );

    handleB.detach();
    assert.equal(
      service.events.listenerCount('event'),
      baselineListeners,
      'no leaked service listeners after both runners retired (F1)'
    );
  } finally {
    delete process.env.AEGIS_KIMI_RUNTIME;
  }
  ok('agent-loop: detached stop → replacement approvals reach the user (F1/F13)');
}

// ═══════════════════════════════ Runner ═════════════════════════════════════

const suites = [
  ['L1: permission mode mapping', l1PermissionModeMapping],
  ['L1: turn completed', l1TurnCompleted],
  ['L1: turn failed ordering', l1TurnFailedOrder],
  ['L1: error frame dedupe', l1ErrorFrameDedupe],
  ['L1: seq replay idempotence + volatile', l1SeqReplayIdempotence],
  ['L1: tool flow', l1ToolFlow],
  ['L1: stop settle', l1StopSettle],
  ['L1: stop safety timeout', l1StopSafetyTimeout],
  ['L1: stop no turn', l1StopNoTurn],
  ['L1: approval dedupe + decision mapping', l1ApprovalDedupeAndDecision],
  ['L1: approval resolved elsewhere', l1ApprovalResolvedElsewhereDismisses],
  ['L1: fail-closed routing', l1FailClosedRouting],
  ['L1: queue + steer', l1QueueSteer],
  ['L1: steer race benign', l1SteerRaceBenign],
  ['L1: per-prompt model switch', l1ModelSwitchPerPrompt],
  ['L1: result carries turn usage', l1ResultCarriesTurnUsage],
  ['L1: thinking passthrough', l1ThinkingPassthrough],
  ['L1: compact flow', l1CompactFlow],
  ['L1: daemon exit mid-turn', l1DaemonExitMidTurn],
  ['L1: resume not_found falls forward', l1ResumeNotFound],
  ['L1: resume flush-race verification', l1ResumeFlushRace],
  ['L1: one-owner guard', l1OneOwnerGuard],
  ['L1: resync notice', l1ResyncNotice],
  ['L1: slash catalog', l1SlashCatalog],
  ['L1: sessionless skill listing', l1SessionlessSkillListing],
  ['L1: runOneShot + archive', l1RunOneShot],
  ['L1: token rotation retry', l1TokenRotationRetry],
  ['L1: facade fork round-trip', l1FacadeForkRoundTrip],
  ['L1: facade provenance routing', l1FacadeProvenanceRouting],
  ['L1: facade legacy adoption', l1FacadeLegacyAdoption],
  ['L1: facade default runtime override', l1FacadeDefaultRuntime],
  ['L1: facade ACP stop settles', l1FacadeAcpStopSettles],
  ['L1: stop in submit window (F10)', l1StopSubmitWindow],
  ['L1: stop during in-flight submit (F10)', l1StopDuringInflightSubmit],
  ['L1: stop vs natural completion (F11)', l1StopVsNaturalCompletion],
  ['L1: approval REST failure retry (F13)', l1ApprovalRestFailureRetry],
  ['L1: approval expired dismiss (F13)', l1ApprovalExpiredDismiss],
  ['L1: approval double-click latch (F13)', l1ApprovalDoubleClickLatch],
  ['L1: steer submit failure (F16)', l1SteerSubmitFailureNoDoubleTerminal],
  ['L1: compact mid-turn rejected (F16)', l1CompactMidTurnRejected],
  ['L1: offset dedupe (F15)', l1OffsetDedupe],
  ['L1: offset gap repair (F15)', l1OffsetGapRepair],
  ['L1: offset per-segment reset (F15)', l1OffsetSegments],
  ['L1: daemon exit idle quiet (F8)', l1DaemonExitIdleQuiet],
  ['L1: stale generation rebind (F5b)', l1StaleGenerationRebind],
  ['L1: reconnect not_found verified (F9b)', l1ReconnectNotFoundVerified],
  ['L1: reconnect gone confirmed (F9b)', l1ReconnectGoneConfirmed],
  ['L1: WS reconnect token refresh (F9a)', l1WsReconnectTokenRefresh],
  ['L1: adoption probe-child late exit (F3b)', l1AdoptionProbeChildLateExit],
  ['L1: spawn failure reaps child (F3/F5)', l1SpawnFailureReapsChild],
  ['L1: request timeout isolated (F4)', l1RequestTimeoutIsolated],
  ['L1: capability probe cache (F7/F12)', l1CapabilityProbeCache],
  ['L1: agent-loop stop detach (F1/F13)', l1AgentLoopStopDetachPermission],
  ['L2: clean boot', l2CleanBoot],
  ['L2: delayed token', l2DelayedToken],
  ['L2: malformed token → file fallback', l2MalformedTokenFallsBackToFile],
  ['L2: no token → loud failure', l2NoTokenAnywhereFails],
  ['L2: unhealthy never greens', l2UnhealthyNeverGreens],
  ['L2: singleton adoption', l2AdoptExistingSingleton],
  ['L2: daemon dies mid-turn', l2DaemonDiesMidTurn],
  ['L2: WS drop + cursor resubscribe', l2WsDropCursorResubscribe],
  ['L2: deep-backlog resync notice', l2DeepBacklogResync],
  ['L2: quit kill ordering', l2QuitKillOrdering],
];

let failed = 0;
for (const [name, fn] of suites) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}:`, error?.stack || error);
  }
}

for (const child of l2Children) {
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

console.log(`\n${passed} assertions passed, ${failed} suites failed`);
process.exit(failed > 0 ? 1 : 0);
