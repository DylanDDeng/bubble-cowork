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
} = require('../dist-electron/electron/libs/provider/kimi-adapter-facade.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = join(__dirname, 'fake-kimi-server.mjs');

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
    if (/\/prompts$/.test(u.pathname) && method === 'POST') {
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
    if (/\/skills$/.test(u.pathname)) {
      return respond(0, {
        skills: state.skills || [
          { name: 'clarify', description: 'Improve unclear UX copy', path: '/tmp/skills/clarify', source: 'user' },
          { name: 'check-kimi-code-docs', description: 'Answer Kimi Code questions', path: 'builtin://check-kimi-code-docs', source: 'builtin' },
        ],
      });
    }
    if (/\/approvals\//.test(u.pathname) && method === 'POST') return respond(0, { resolved: true });
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
  const push = (type, payload = {}, volatile = false) => {
    if (!volatile) seq += 1;
    ws.receive({
      type,
      seq,
      session_id: sid,
      payload: { type, ...payload },
      epoch: 'ep1',
      ...(volatile ? { volatile: true } : {}),
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
  const { transport, wsFactory } = makeTransport();
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

    // Adoption REFUSED (server does not know the id): the thread stays on
    // the legacy runtime and the bare id is never destroyed.
    const t2 = makeTransport();
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
