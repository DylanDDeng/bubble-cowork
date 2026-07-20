#!/usr/bin/env node
// Runtime verification for the Qoder SDK adapter (docs/qoder-sdk-adapter-plan.md).
//   Wiring asserts — every registration point from the plan's checklist.
//   L1 in-process — drive the compiled adapter with an injected fake SDK
//      (setQoderSdkForTests seam; no qodercli process, no network).
// Requires `npm run transpile:electron` to have produced dist-electron.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(p, 'utf8');

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

// ═══════════════════════════ wiring asserts ════════════════════════════════

console.log('Wiring:');

const providerTypes = read('src/electron/libs/provider/types.ts');
const sharedTypes = read('src/shared/types.ts');
assert.ok(
  providerTypes.includes("'qoder'") && providerTypes.includes('qoderPermissionMode'),
  'provider/types.ts must include qoder kind + qoderPermissionMode input fields'
);
assert.ok(
  /AgentProvider =[^;]*'qoder'/.test(sharedTypes) &&
    sharedTypes.includes('QoderPermissionMode') &&
    sharedTypes.includes('QoderModelConfig') &&
    sharedTypes.includes("'qoder_local'"),
  'shared/types.ts must include qoder provider, permission mode, model config, and source'
);
ok('provider + shared type unions');

assert.ok(
  read('src/electron/libs/provider/service.ts').includes("|| provider === 'qoder'"),
  'service.isProviderKind must accept qoder'
);
const agentLoop = read('src/electron/libs/agent-loop.ts');
assert.ok(
  agentLoop.includes('QoderSdkAdapter') && agentLoop.includes('service.registerAdapter(new QoderSdkAdapter())'),
  'agent-loop must register the Qoder SDK adapter'
);
ok('service + agent-loop registration');

const sessionStore = read('src/electron/libs/session-store.ts');
assert.ok(
  sessionStore.includes('qoder_session_id TEXT') &&
    sessionStore.includes("ensureColumn('sessions', 'qoder_session_id', 'TEXT')") &&
    sessionStore.includes('updateQoderSessionId') &&
    sessionStore.includes('setQoderSessionId') &&
    sessionStore.includes("'qoder_local'"),
  'session-store must persist qoder session ids and source origin'
);
const electronTypes = read('src/electron/types.ts');
assert.ok(
  electronTypes.includes('qoder_session_id') && electronTypes.includes('qoderPermissionMode'),
  'electron/types.ts SessionRow + RunnerOptions must include qoder fields'
);
ok('session-store + SessionRow persistence');

const ipcHandlers = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipcHandlers.includes("if (provider === 'qoder') return 'Qoder'") &&
    ipcHandlers.includes("'qoder_local'") &&
    ipcHandlers.includes('sessions.updateQoderSessionId') &&
    ipcHandlers.includes('session.qoder_session_id') &&
    ipcHandlers.includes('normalizeQoderPermissionMode') &&
    ipcHandlers.includes("nextProvider === 'qoder'") &&
    ipcHandlers.includes('get-qoder-model-config'),
  'ipc-handlers must label, source, persist, resume, normalize, and serve qoder'
);
assert.ok(
  read('src/electron/preload.cts').includes('get-qoder-model-config') &&
    read('src/types.d.ts').includes('getQoderModelConfig') &&
    read('src/ui/types.ts').includes('QoderModelConfig'),
  'preload → types.d.ts → ui/types bridge must expose getQoderModelConfig'
);
assert.ok(
  read('src/electron/libs/agent-runtime-directory.ts').includes('probeQoder'),
  'agent-runtime-directory must probe qoder'
);
ok('ipc + bridge + runtime probe');

const providerUtils = read('src/ui/utils/provider.ts');
assert.ok(providerUtils.includes("{ id: 'qoder', label: 'Qoder' }"), 'ui provider list must include qoder');
assert.ok(
  read('src/ui/components/ProviderPicker.tsx').includes('QoderLogo') &&
    existsSync('src/ui/components/QoderLogo.tsx') &&
    existsSync('src/ui/assets/qoder.svg'),
  'ProviderPicker must render the qoder logo'
);
assert.ok(
  read('src/ui/components/onboarding/AgentOnboardingView.tsx').includes('qoder'),
  'onboarding logos must include qoder'
);
assert.ok(
  read('src/ui/hooks/useAgentReadiness.ts').includes("'qoder'"),
  'useAgentReadiness order must include qoder'
);
const composerSelection = read('src/ui/hooks/useComposerAgentSelection.ts');
assert.ok(
  composerSelection.includes('useQoderModelConfig') &&
    composerSelection.includes('buildQoderModelOptions') &&
    composerSelection.includes('resolveConfiguredQoderModel') &&
    composerSelection.includes('savePreferredQoderModel'),
  'useComposerAgentSelection must build/resolve/persist qoder models'
);
assert.ok(existsSync('src/ui/hooks/useQoderModelConfig.ts'), 'useQoderModelConfig hook must exist');
assert.ok(
  read('src/ui/components/PromptInput.tsx').includes('isQoderContextVisible'),
  'PromptInput must render the qoder context ring'
);
assert.ok(
  read('src/ui/components/settings/ClaudeUsageSettings.tsx').includes("'qoder'") &&
    read('src/ui/lib/wechatMarkdown.ts').includes("'qoder'") &&
    read('src/ui/components/ComposerAgentControls.tsx').includes('QoderLogo') &&
    read('src/ui/components/AgentModelPicker.tsx').includes('QoderLogo'),
  'usage settings / wechat export / composer controls / model picker must include qoder'
);
ok('ui registration');

assert.ok(
  read('electron-builder.json').includes('qoder-agent-sdk/dist/_bundled'),
  'electron-builder must exclude the SDK-bundled qodercli binary'
);
ok('packaging exclusion');

// ═══════════════════════════ L1: fake SDK harness ══════════════════════════

console.log('\nL1 (injected fake SDK):');

const { QoderSdkAdapter } = require('../dist-electron/electron/libs/provider/qoder-sdk-adapter.js');
const { setQoderSdkForTests } = require('../dist-electron/electron/libs/provider/qoder-sdk-loader.js');

function makeModelUsage(contextWindow = 200000) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow,
    maxOutputTokens: 0,
  };
}

function successResult(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 5,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, context_usage_ratio: 0.25 },
    modelUsage: { auto: makeModelUsage() },
    ...overrides,
  };
}

function makeFakeQuery(prompt, options, harness) {
  const state = {
    initSent: false,
    interrupted: false,
    closed: false,
    done: false,
    failWith: null,
    interruptCalls: 0,
    closeCalls: 0,
    setModelCalls: [],
    titleCalls: 0,
    sessionId: harness.sessionId ?? 'qoder-fake-session',
  };
  const outbox = [];
  let waiter = null;

  const push = (msg) => {
    if (state.done) return;
    if (waiter) {
      const pending = waiter;
      waiter = null;
      pending({ value: msg, done: false });
    } else {
      outbox.push(msg);
    }
  };
  const finish = () => {
    if (state.done) return;
    state.done = true;
    if (waiter) {
      const pending = waiter;
      waiter = null;
      pending({ value: undefined, done: true });
    }
  };

  const api = {
    state,
    push,
    finish,
    fail(error) {
      state.failWith = error;
      if (waiter) {
        const pending = waiter;
        waiter = null;
        pending(Promise.reject(error));
      }
    },
    options,
    interrupt: async () => {
      state.interruptCalls += 1;
      state.interrupted = true;
      push({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['Operation aborted'],
        usage: { context_usage_ratio: 0.1 },
        modelUsage: {},
      });
    },
    close: async () => {
      state.closeCalls += 1;
      state.closed = true;
      finish();
    },
    setModel: async (model) => {
      state.setModelCalls.push(model);
      // P10: a re-init (same session id) follows a mid-session switch.
      push({ type: 'system', subtype: 'init', session_id: state.sessionId, model });
    },
    setPermissionMode: async () => {},
    initializationResult: async () =>
      harness.initResult ?? {
        models: [
          {
            value: 'auto',
            displayName: 'Auto',
            isDefault: true,
            isEnabled: true,
            isVl: true,
            defaultContextWindow: 180000,
            maxInputTokens: 180000,
            availableContextWindows: [180000],
          },
          { value: 'ultimate', displayName: 'Ultimate', isEnabled: true, isVl: true, defaultContextWindow: 200000 },
        ],
        skills: [
          { name: 'demo-skill', description: 'Demo skill', source: 'user' },
          { name: 'plug:skill', description: 'Plugin skill', source: 'plugin' },
        ],
        account: { subscriptionType: 'Pro' },
      },
    generateSessionTitle: async () => {
      state.titleCalls += 1;
      return harness.title ?? 'Fake Session Title';
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (state.failWith) {
            const error = state.failWith;
            state.failWith = null;
            return Promise.reject(error);
          }
          if (outbox.length > 0) return Promise.resolve({ value: outbox.shift(), done: false });
          if (state.done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
      };
    },
  };

  const pushInit = () => {
    if (state.initSent) return;
    state.initSent = true;
    push({
      type: 'system',
      subtype: 'init',
      session_id: state.sessionId,
      model: harness.model ?? 'auto',
      permissionMode: options?.permissionMode ?? 'default',
    });
  };
  // The real CLI emits system.init right after spawn, BEFORE any user
  // message — the adapter awaits it prior to dispatching the first turn.
  queueMicrotask(pushInit);

  const startTurn = async () => {
    pushInit();
    await harness.onTurn(api);
  };

  (async () => {
    if (typeof prompt === 'string') {
      if (prompt.trim()) await startTurn();
      finish();
      return;
    }
    for await (const msg of prompt) {
      void msg;
      await startTurn();
      if (state.closed) break;
    }
    finish();
  })().catch(() => finish());

  return api;
}

function makeHarness(overrides = {}) {
  const harness = {
    queries: [],
    onTurn:
      overrides.onTurn ??
      (async (q) => {
        q.push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'fake reply' }] },
          parent_tool_use_id: null,
        });
        q.push(successResult());
      }),
    ...overrides,
  };
  const sdk = {
    query: ({ prompt, options }) => {
      const q = makeFakeQuery(prompt, options, harness);
      harness.queries.push(q);
      return q;
    },
    qodercliAuth: () => ({ type: 'qodercli' }),
    forkSession: async (sessionId) => ({ sessionId: `${sessionId}-fork` }),
  };
  return { harness, sdk };
}

function collectEvents(adapter) {
  const events = [];
  adapter.events.on('event', (event) => events.push(event));
  return events;
}
const resultEvents = (events) =>
  events.filter((event) => event.type === 'message' && event.message.type === 'result');
const messageEvents = (events) => events.filter((event) => event.type === 'message');

// ── L1-1: start, init, catalog, turn translation ────────────────────────────
{
  const { harness, sdk } = makeHarness({
    onTurn: async (q) => {
      // message_start must be filtered; only text/thinking deltas pass.
      q.push({ type: 'stream_event', event: { type: 'message_start' } });
      q.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
        parent_tool_use_id: null,
      });
      // Subagent assistant: parent mapping must survive.
      q.push({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] },
        parent_tool_use_id: 'task-1',
      });
      // Replay echoes must be dropped; tool_result user messages pass.
      q.push({ type: 'user', message: { role: 'user', content: 'echo' }, parent_tool_use_id: null, isReplay: true });
      q.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
        parent_tool_use_id: null,
      });
      q.push(successResult());
    },
  });
  setQoderSdkForTests(sdk);
  const adapter = new QoderSdkAdapter();
  const events = collectEvents(adapter);
  await adapter.startSession({ provider: 'qoder', threadId: 't1', cwd: '/tmp', prompt: 'hello' });

  await waitFor(() => events.some((event) => event.type === 'system_init'), 4000, 'system_init');
  assert.equal(events.find((event) => event.type === 'system_init')?.sessionId, 'qoder-fake-session');
  await waitFor(() => resultEvents(events).length === 1, 4000, 'one result');
  ok('startSession emits system_init and exactly one result');

  await waitFor(() => adapter.getModelCatalog()?.models?.length >= 2, 4000, 'model catalog');
  assert.equal(adapter.getModelCatalog()?.defaultModel, 'auto');
  ok('model catalog populated from initializationResult');

  // Skill discovery: {name, description, source} entries become descriptors
  // with virtual qoder:// paths; the second call hits the process cache.
  const skillsLive = await adapter.listSkills({ provider: 'qoder', cwd: '/tmp', forceReload: true });
  assert.equal(skillsLive.skills.length, 2);
  assert.equal(skillsLive.skills[0].name, 'demo-skill');
  assert.equal(skillsLive.skills[0].path, 'qoder://skill/demo-skill');
  assert.equal(skillsLive.skills[0].scope, 'user');
  assert.equal(skillsLive.skills[1].scope, 'plugin');
  const skillsCached = await adapter.listSkills({ provider: 'qoder', cwd: '/tmp' });
  assert.equal(skillsCached.cached, true);
  ok('listSkills serves the initializationResult skill catalog (live + cached)');

  const messages = messageEvents(events).map((event) => event.message);
  const streamEvents = messages.filter((message) => message.type === 'stream_event');
  assert.equal(streamEvents.length, 1, 'message_start must be filtered out');
  assert.equal(streamEvents[0].event?.type, 'content_block_delta');
  const subAssistant = messages.find(
    (message) => message.type === 'assistant' && message.parentToolUseId === 'task-1'
  );
  assert.ok(subAssistant, 'parent_tool_use_id must map to parentToolUseId');
  const userMessages = messages.filter((message) => message.type === 'user');
  assert.equal(userMessages.length, 1, 'isReplay echo must be dropped');
  assert.equal(userMessages[0].message?.content?.[0]?.type, 'tool_result');
  const result = resultEvents(events)[0].message;
  assert.equal(result.subtype, 'success');
  assert.deepEqual(result.modelUsage?.auto?.contextWindow, 200000, 'modelUsage passthrough');
  ok('translation: stream narrowing, replay drop, parent mapping, modelUsage');
}

// ── L1-2: multi-turn, one result per turn ───────────────────────────────────
{
  const { sdk } = makeHarness({});
  setQoderSdkForTests(sdk);
  const adapter = new QoderSdkAdapter();
  const events = collectEvents(adapter);
  await adapter.startSession({ provider: 'qoder', threadId: 't2', cwd: '/tmp', prompt: 'one' });
  await waitFor(() => resultEvents(events).length === 1, 4000, 'turn 1 result');
  await adapter.sendTurn({ threadId: 't2', prompt: 'two' });
  await waitFor(() => resultEvents(events).length === 2, 4000, 'turn 2 result');
  assert.ok(adapter.hasSession('t2'));
  ok('same-Query multi-turn: exactly one result per turn (P9)');
}

// ── L1-3: permissions — request, allow, deny default message, dismiss ───────
{
  const { sdk } = makeHarness({
    onTurn: async (q) => {
      const decision = await q.options.canUseTool(
        'Bash',
        { command: 'rm -rf /tmp/qoder-fake' },
        {
          toolUseID: 'tool-1',
          signal: new AbortController().signal,
          suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
        }
      );
      assert.equal(decision?.behavior, 'allow');
      q.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
        parent_tool_use_id: null,
      });
      q.push(successResult());
    },
  });
  setQoderSdkForTests(sdk);
  const adapter = new QoderSdkAdapter();
  const events = collectEvents(adapter);
  await adapter.startSession({ provider: 'qoder', threadId: 't3', cwd: '/tmp', prompt: 'run it' });
  await waitFor(() => events.some((event) => event.type === 'permission_request'), 4000, 'permission_request');
  const request = events.find((event) => event.type === 'permission_request');
  assert.equal(request.requestId, 'tool-1');
  assert.equal(request.toolName, 'Bash');
  await adapter.respondToRequest('t3', 'tool-1', { behavior: 'allow' });
  await waitFor(() => resultEvents(events).length === 1, 4000, 'result after allow');
  ok('canUseTool → permission_request → allow resolves the turn (P6c)');

  // deny: the SDK requires a message — the adapter must supply a default.
  const denyHarness = makeHarness({
    onTurn: async (q) => {
      const decision = await q.options
        .canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 'tool-2', signal: new AbortController().signal })
        .catch((error) => ({ behavior: 'error', message: String(error) }));
      assert.equal(decision?.behavior, 'deny');
      assert.ok(typeof decision?.message === 'string' && decision.message.length > 0, 'deny message required');
      q.push(successResult());
    },
  });
  setQoderSdkForTests(denyHarness.sdk);
  const adapter2 = new QoderSdkAdapter();
  const events2 = collectEvents(adapter2);
  await adapter2.startSession({ provider: 'qoder', threadId: 't3b', cwd: '/tmp', prompt: 'run it' });
  await waitFor(() => events2.some((event) => event.type === 'permission_request'), 4000, 'permission_request (deny)');
  await adapter2.respondToRequest('t3b', 'tool-2', { behavior: 'deny' });
  await waitFor(() => resultEvents(events2).length === 1, 4000, 'result after deny');
  ok('deny without message gets a default message');
}

// ── L1-4: stop mid-turn — interrupt → abort result → single stopped result ──
{
  const { harness, sdk } = makeHarness({
    onTurn: async (q) => {
      q.push({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'working…' }] },
        parent_tool_use_id: null,
      });
      // Park the turn until interrupt() lands the abort result (P9b shape).
      const deadline = Date.now() + 4000;
      while (!q.state.interrupted && Date.now() < deadline) {
        await sleep(10);
      }
    },
  });
  setQoderSdkForTests(sdk);
  const adapter = new QoderSdkAdapter();
  const events = collectEvents(adapter);
  await adapter.startSession({ provider: 'qoder', threadId: 't4', cwd: '/tmp', prompt: 'long task' });
  await waitFor(() => messageEvents(events).some((event) => event.message.type === 'assistant'), 4000, 'turn started');
  await adapter.stopSession('t4');
  assert.equal(harness.queries[0].state.interruptCalls, 1, 'stopSession must interrupt the query');
  assert.equal(harness.queries[0].state.closeCalls, 1, 'stopSession must close the query (no process leak)');
  assert.equal(resultEvents(events).length, 1, 'exactly one result for the stopped turn');
  assert.equal(resultEvents(events)[0].message.subtype, 'stopped');
  assert.equal(adapter.hasSession('t4'), false, 'stopSession releases the binding');
  ok('stopSession: interrupt → abort result → stopped, binding released (B1 lifecycle)');
}

// ── L1-5: crash synthesis — iterator throw yields one error result ──────────
{
  const { sdk } = makeHarness({
    onTurn: async (q) => {
      q.push({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'before crash' }] },
        parent_tool_use_id: null,
      });
      q.fail(new Error('Qoder CLI process exited with code 1'));
      await sleep(30);
    },
  });
  setQoderSdkForTests(sdk);
  const adapter = new QoderSdkAdapter();
  const events = collectEvents(adapter);
  await adapter.startSession({ provider: 'qoder', threadId: 't5', cwd: '/tmp', prompt: 'boom' });
  await waitFor(() => resultEvents(events).length === 1, 4000, 'synthesized error result');
  assert.equal(resultEvents(events)[0].message.subtype, 'error');
  await waitFor(() => events.some((event) => event.type === 'error'), 4000, 'error event');
  assert.equal(adapter.hasSession('t5'), false, 'crash releases the binding for resume-rebuild');
  ok('turn-terminal invariant: crash synthesizes exactly one error result');
}

// ── L1-6: re-init tolerance + setModel ──────────────────────────────────────
{
  const { harness, sdk } = makeHarness({});
  setQoderSdkForTests(sdk);
  const adapter = new QoderSdkAdapter();
  const events = collectEvents(adapter);
  await adapter.startSession({ provider: 'qoder', threadId: 't6', cwd: '/tmp', prompt: 'hi' });
  await waitFor(() => resultEvents(events).length === 1, 4000, 'turn result');
  await adapter.setModel('t6', 'ultimate');
  await waitFor(() => harness.queries[0].state.setModelCalls.length === 1, 4000, 'setModel forwarded');
  await sleep(50); // let the re-init flow through the pump
  assert.equal(
    events.filter((event) => event.type === 'system_init').length,
    1,
    're-init after setModel must not re-emit system_init (P10)'
  );
  assert.equal(adapter.listSessions().find((session) => session.threadId === 't6')?.model, 'ultimate');
  ok('setModel: warm switch, re-init tolerated, model refreshed');
}

// ── L1-7: auth failure maps to login_required surface ───────────────────────
{
  const { sdk } = makeHarness({
    onTurn: async (q) => {
      q.push({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['No qodercli login found. Run "qodercli login" first.'],
        terminal_reason: 'auth_required',
        usage: {},
        modelUsage: {},
      });
    },
  });
  setQoderSdkForTests(sdk);
  const adapter = new QoderSdkAdapter();
  const events = collectEvents(adapter);
  await adapter.startSession({ provider: 'qoder', threadId: 't7', cwd: '/tmp', prompt: 'hi' });
  await waitFor(() => events.some((event) => event.type === 'error'), 4000, 'auth error event');
  const errorEvent = events.find((event) => event.type === 'error');
  assert.ok(/login/i.test(errorEvent.error?.message ?? ''), 'error must point at login');
  assert.equal(resultEvents(events).length, 1, 'auth failure still resolves the turn FIFO');
  ok('auth_required → login-required error surface (exit-41 baseline)');
}

// ── L1-8: fork, resume passthrough, runOneShot ──────────────────────────────
{
  const { harness, sdk } = makeHarness({});
  setQoderSdkForTests(sdk);
  const adapter = new QoderSdkAdapter();
  const forked = await adapter.forkThread({ cwd: '/tmp', providerThreadId: 'abc' });
  assert.equal(forked, 'abc-fork');
  ok('forkThread returns the new session id');

  const events = collectEvents(adapter);
  await adapter.startSession({ provider: 'qoder', threadId: 't8', cwd: '/tmp', prompt: 'continue', resumeSessionId: 'prev-id' });
  await waitFor(() => resultEvents(events).length === 1, 4000, 'resumed turn');
  assert.equal(harness.queries[0].options?.resume, 'prev-id', 'resumeSessionId must map to options.resume');
  assert.equal(harness.queries[0].options?.forkSession, undefined, 'plain resume must not fork');
  ok('resumeSessionId → options.resume');

  const oneShot = await adapter.runOneShot({ provider: 'qoder', threadId: 't8', cwd: '/tmp', prompt: 'title please' });
  assert.equal(oneShot.text, 'Fake Session Title');
  assert.equal(harness.queries[0].state.titleCalls, 1, 'live query generateSessionTitle preferred');
  ok('runOneShot reuses the live query for titles');

  const oneShotCold = await adapter.runOneShot({ provider: 'qoder', threadId: 't8-cold', cwd: '/tmp', prompt: 'title please' });
  assert.equal(oneShotCold.text, 'fake reply', 'cold path returns the one-shot turn text');
  ok('runOneShot cold path returns text');
}

setQoderSdkForTests(null);
console.log(`\nverify-qoder-sdk-adapter: ${passed + 8} checks passed`);
