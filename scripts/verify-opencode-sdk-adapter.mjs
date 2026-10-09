#!/usr/bin/env node
// OpenCode 2.x provider checks. Static wiring first, then runtime checks that
// need `npm run transpile:electron` (dist-electron): the adapter driven through
// a fake serve manager, the HTTP client against a local fake server, and the
// server-process/binary-selection helpers with fake `opencode` binaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ═══════════ Static wiring ═════════════════════════════════════════════════
const packageJson = JSON.parse(read('package.json'));
assert.ok(
  !packageJson.dependencies?.['@opencode-ai/sdk'],
  'the OpenCode 1.x SDK must not be a dependency (Aegis speaks the 2.x API directly)'
);
assert.ok(
  !fs.existsSync(path.join(root, 'src/electron/libs/provider/opencode-sdk-loader.ts')),
  'the 1.x SDK loader must be gone'
);

const manager = read('src/electron/libs/provider/opencode-serve-manager.ts');
assert.ok(
  manager.includes('OPENCODE_ASK_PERMISSIONS') &&
    manager.includes("'shell'") &&
    manager.includes("'external_directory'") &&
    manager.includes('permissions: OPENCODE_ASK_PERMISSIONS'),
  'OpenCode server config must route tools through Aegis approvals'
);
const serverProcess = read('src/electron/libs/provider/opencode-server-process.ts');
assert.ok(
  serverProcess.includes("'--stdio'") && serverProcess.includes('OPENCODE_SERVER_PASSWORD'),
  'OpenCode must run as a password-protected stdio server'
);
const ipcHandlers = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipcHandlers.includes('getOpenCodeServeManager().interruptActiveExecutionsSync()'),
  'app cleanup must interrupt running OpenCode turns before quitting'
);

const service = read('src/electron/libs/provider/service.ts');
assert.ok(
  service.includes('adapter.runOneShot') &&
    service.includes('event.threadId !== input.threadId') &&
    !service.includes('setTimeout(resolve, 2000)') &&
    !/adapter\.sendTurn\(\{\s*threadId:\s*input\.threadId,\s*prompt:\s*input\.prompt/s.test(service),
  'ProviderService.runOneShot must not double-send prompts or wait a fixed 2 seconds'
);

const agentLoop = read('src/electron/libs/agent-loop.ts');
assert.ok(
  agentLoop.includes('OpenCodeSdkAdapter') &&
    agentLoop.includes('service.registerAdapter(new OpenCodeSdkAdapter())'),
  'agent-loop must register the OpenCode SDK adapter'
);
assert.ok(
  agentLoop.includes('service.getAdapter(provider)') &&
    agentLoop.includes('event.threadId !== threadId') &&
    agentLoop.includes('opencodePermissionMode'),
  'agent-loop must route registered providers through ProviderService and isolate thread events'
);

const codexRunner = read('src/electron/libs/codex-runner.ts');
assert.ok(
  codexRunner.includes('OpenCodeSdkAdapter') &&
    codexRunner.includes("provider: 'opencode'") &&
    codexRunner.includes('service.runOneShot'),
  'runOpenCodeOneShot must use the OpenCode SDK adapter through ProviderService'
);

const sharedTypes = read('src/shared/types.ts');
assert.ok(
  sharedTypes.includes("'kimi' | 'grok' | 'opencode'"),
  'AcpPermissionInput must allow OpenCode permission requests'
);
assert.ok(
  sharedTypes.includes('context_window?: number | null') &&
    sharedTypes.includes('total_tokens?: number | null') &&
    sharedTypes.includes('reasoning_output_tokens?: number | null') &&
    sharedTypes.includes('model?: string'),
  'shared stream result usage must carry OpenCode context/token metadata'
);

const contextUsage = read('src/ui/utils/context-usage.ts');
assert.ok(
  contextUsage.includes('OpenCodeContextSnapshot') &&
    contextUsage.includes('getLatestOpenCodeContextSnapshot') &&
    contextUsage.includes('context_window') &&
    contextUsage.includes('total_tokens'),
  'context usage utilities must derive OpenCode context snapshots from result usage'
);

const promptInput = read('src/ui/components/PromptInput.tsx');
assert.ok(
  promptInput.includes('OpenCodeContextIndicator') &&
    promptInput.includes('getLatestOpenCodeContextSnapshot') &&
    promptInput.includes('openCodeContextSnapshot') &&
    promptInput.includes('isOpenCodeContextVisible ? ('),
  'PromptInput must render OpenCode context usage like other providers, including waiting state'
);
assert.ok(
  promptInput.includes('OPENCODE_PERMISSION_MODE_OPTIONS') &&
    promptInput.includes("runtimeProvider === 'opencode'") &&
    promptInput.includes('agentSelection.opencodePermissionMode') &&
    promptInput.includes('agentSelection.setOpencodePermissionMode'),
  'PromptInput must render and send the OpenCode permission mode'
);

const openCodeIndicator = read('src/ui/components/OpenCodeContextIndicator.tsx');
assert.ok(
  openCodeIndicator.includes('OpenCodeContextSnapshot | null') &&
    openCodeIndicator.includes('providerLabel =') &&
    openCodeIndicator.includes('Waiting for {providerLabel} usage from this model.'),
  'OpenCode context indicator must support an empty waiting state before first usage'
);

// Per-provider mode lists live in the shared option maps the picker renders.
const permissionPickerSrc = read('src/ui/utils/permission-modes.ts');
const openCodeOptionsBlock =
  permissionPickerSrc.match(/OPENCODE_PERMISSION_MODE_OPTIONS[\s\S]*?\];/)?.[0] ?? '';
assert.ok(
  openCodeOptionsBlock.includes("'defaultPermissions'") &&
    openCodeOptionsBlock.includes("'plan'") &&
    openCodeOptionsBlock.includes("'fullAccess'") &&
    openCodeOptionsBlock.includes('Full Access'),
  'Unified permission picker must expose OpenCode default, plan, and full access modes'
);

const composerSelection = read('src/ui/hooks/useComposerAgentSelection.ts');
assert.ok(
  composerSelection.includes('loadPreferredOpencodePermissionMode') &&
    composerSelection.includes('savePreferredOpencodePermissionMode') &&
    composerSelection.includes('opencodePermissionMode') &&
    composerSelection.includes('setOpencodePermissionMode'),
  'Composer agent selection must persist OpenCode permission mode'
);
assert.ok(
  composerSelection.includes('buildOpencodeComposerModelOptions') &&
    composerSelection.includes("'opencode:default'") &&
    composerSelection.includes('Use OpenCode default model') &&
    !composerSelection.includes('Setup OpenCode'),
  'Composer agent selection must use OpenCode default model instead of Setup OpenCode'
);

for (const file of [
  'src/ui/components/settings/CompatibleProviderSettings.tsx',
  'src/electron/ipc-handlers.ts',
]) {
  const source = read(file);
  assert.ok(!source.includes('OpenCode ACP'), `${file} must not show OpenCode ACP copy`);
}

console.log('opencode-sdk-adapter: wiring checks passed');

// ═══════════ Adapter runtime (fake serve manager + client) ═════════════════
const { OpenCodeSdkAdapter } = require('../dist-electron/electron/libs/provider/opencode-sdk-adapter.js');
const { OpenCodeApiError } = require('../dist-electron/electron/libs/provider/opencode-v2-client.js');
const { OPENCODE_ASK_PERMISSIONS, OPENCODE_SERVER_EXITED_EVENT } = require('../dist-electron/electron/libs/provider/opencode-serve-manager.js');

function makeFakeOpenCode(overrides = {}) {
  const calls = [];
  const listeners = new Map();
  let sessionCounter = 0;
  const record = (name, value) => (...args) => {
    calls.push([name, ...args]);
    return Promise.resolve(typeof value === 'function' ? value(...args) : value);
  };
  const client = {
    createSession: record('createSession', (input) => ({ id: `ses_${++sessionCounter}`, permissions: input.permissions })),
    getSession: record('getSession', (id) => ({ id, permissions: [] })),
    updateSession: record('updateSession'),
    switchModel: record('switchModel'),
    switchAgent: record('switchAgent'),
    prompt: record('prompt', {}),
    command: record('command'),
    compact: record('compact', {}),
    interrupt: record('interrupt', { interrupted: true }),
    fork: record('fork', { id: 'ses_fork' }),
    replyPermission: record('replyPermission'),
    replyForm: record('replyForm'),
    cancelForm: record('cancelForm'),
    listCommands: record('listCommands', [{ name: 'review', description: 'Review changes' }]),
    listSkills: record('listSkills', []),
    listMcpServers: record('listMcpServers', [{ name: 'aegis', status: { status: 'connected' } }]),
    listModels: record('listModels', [{ providerID: 'opencode', modelID: 'm1', limit: { context: 1000, output: 100 } }]),
    defaultModel: record('defaultModel', null),
    ...overrides,
  };
  const managerSeam = {
    getClient: async () => client,
    loadModels: async (directory) => ({ models: await client.listModels(directory), defaultModel: await client.defaultModel(directory) }),
    subscribe(sessionID, listener) {
      const set = listeners.get(sessionID) ?? new Set();
      set.add(listener);
      listeners.set(sessionID, set);
      return () => set.delete(listener);
    },
    close: async () => calls.push(['close']),
  };
  const send = (sessionID, type, data = {}) => {
    for (const listener of [...(listeners.get(sessionID) ?? [])]) listener({ type, data: { sessionID, ...data } });
  };
  const listenerCount = (sessionID) => listeners.get(sessionID)?.size ?? 0;
  return { client, managerSeam, calls, send, listenerCount };
}

function collect(adapter) {
  const events = [];
  adapter.events.on('event', (event) => events.push(event));
  const messages = () => events.filter((e) => e.type === 'message').map((e) => e.message);
  return { events, messages };
}

// ── Session start: durable ask rules, plan agent, commands, MCP ──────────────
{
  const fake = makeFakeOpenCode();
  const adapter = new OpenCodeSdkAdapter(fake.managerSeam);
  const { events, messages } = collect(adapter);
  const started = await adapter.startSession({ provider: 'opencode', threadId: 't', cwd: '/repo', prompt: '', opencodePermissionMode: 'plan', model: 'opencode/m1' });
  const create = fake.calls.find(([name]) => name === 'createSession')[1];
  assert.deepEqual(create.permissions, OPENCODE_ASK_PERMISSIONS, 'new sessions carry Aegis ask rules');
  assert.equal(create.agent, 'plan');
  assert.deepEqual(create.model, { providerID: 'opencode', id: 'm1' });
  assert.equal(started.providerSessionId, 'ses_1');
  assert.ok(events.some((e) => e.type === 'system_init' && e.sessionId === 'ses_1'));
  const commands = messages().find((m) => m.subtype === 'available_commands_update').availableCommands.map((c) => c.name);
  assert.deepEqual(commands, ['compact', 'review']);
  assert.equal(messages().find((m) => m.type === 'mcp_status').servers[0].status, 'connected');
  console.log('  ✓ startSession: ask rules, plan agent, model, commands, MCP status');
}

// ── A full turn: deltas, text before tools, tool cards, summed cost, result ──
{
  const fake = makeFakeOpenCode();
  const adapter = new OpenCodeSdkAdapter(fake.managerSeam);
  const { events, messages } = collect(adapter);
  await adapter.startSession({ provider: 'opencode', threadId: 't', cwd: '/repo', prompt: '' });
  await sleep(0); // model limits load in the background
  await adapter.sendTurn({ threadId: 't', prompt: 'hi' });
  const prompt = fake.calls.find(([name]) => name === 'prompt');
  assert.deepEqual(prompt.slice(1), ['ses_1', { text: 'hi', delivery: 'queue' }], 'prompts queue behind a running turn');
  const s = 'ses_1';
  fake.send(s, 'session.execution.started');
  fake.send(s, 'session.step.started', { assistantMessageID: 'a1', model: { providerID: 'opencode', id: 'm1' } });
  fake.send(s, 'session.reasoning.delta', { assistantMessageID: 'a1', ordinal: 0, delta: 'think' });
  fake.send(s, 'session.text.delta', { assistantMessageID: 'a1', ordinal: 1, delta: 'Hel' });
  fake.send(s, 'session.text.delta', { assistantMessageID: 'a1', ordinal: 1, delta: 'lo' });
  fake.send(s, 'session.tool.input.started', { assistantMessageID: 'a1', id: 'call_1', name: 'shell' });
  fake.send(s, 'session.tool.called', { assistantMessageID: 'a1', id: 'call_1', input: { command: 'ls' } });
  fake.send(s, 'session.tool.success', { assistantMessageID: 'a1', id: 'call_1', content: [{ type: 'text', text: 'out' }] });
  fake.send(s, 'session.step.ended', { assistantMessageID: 'a1', cost: 0.25, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } });
  fake.send(s, 'session.step.started', { assistantMessageID: 'a2', model: { providerID: 'opencode', id: 'm1' } });
  fake.send(s, 'session.text.delta', { assistantMessageID: 'a2', ordinal: 0, delta: 'partial' });
  fake.send(s, 'session.text.ended', { assistantMessageID: 'a2', ordinal: 0, text: 'Done.' });
  fake.send(s, 'session.step.ended', { assistantMessageID: 'a2', cost: 0.5, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 7, write: 3 } } });
  fake.send(s, 'session.execution.succeeded');

  const deltas = messages().filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta').map((m) => m.event.delta);
  assert.deepEqual(deltas.map((d) => d.text ?? d.thinking), ['think', 'Hel', 'lo', 'partial']);
  const committed = messages().filter((m) => m.type === 'assistant' || m.type === 'user').map((m) => m.message.content.map((b) => b.type + ':' + (b.text ?? b.name ?? b.content ?? b.thinking)).join('+'));
  assert.deepEqual(committed, ['thinking:think+text:Hello', 'tool_use:Bash', 'tool_result:out', 'text:Done.'],
    'text is committed before the tool card it preceded; the ended text is authoritative');
  const result = messages().find((m) => m.type === 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.total_cost_usd, 0.75, 'turn cost sums every step');
  assert.equal(result.model, 'opencode/m1');
  assert.equal(result.usage.input_tokens, 10, 'usage reflects the last step (context occupancy)');
  assert.equal(result.usage.context_window, 1000);
  assert.equal(result.usage.total_tokens, 45);
  assert.equal(events.at(-1).type === 'status_change' && events.at(-1).status, 'completed');
  console.log('  ✓ turn: deltas, ordered text/tool cards, summed cost, usage + context window');
}

// ── Model/agent switches only on change; commands and /compact routes ───────
{
  const fake = makeFakeOpenCode({ createSession: (input) => Promise.resolve({ id: 'ses_m', agent: 'build', model: { providerID: 'opencode', id: 'm1' } }) });
  const adapter = new OpenCodeSdkAdapter(fake.managerSeam);
  await adapter.startSession({ provider: 'opencode', threadId: 't', cwd: '/repo', prompt: '' });
  await adapter.sendTurn({ threadId: 't', prompt: 'a', model: 'opencode/m1' });
  assert.equal(fake.calls.filter(([n]) => n === 'switchModel').length, 0, 'same model: no switch');
  await adapter.sendTurn({ threadId: 't', prompt: 'b', model: 'openrouter/vendor/model-x' });
  assert.deepEqual(fake.calls.find(([n]) => n === 'switchModel')[2], { providerID: 'openrouter', id: 'vendor/model-x' });
  await adapter.sendTurn({ threadId: 't', prompt: 'c', model: 'openrouter/vendor/model-x', opencodePermissionMode: 'plan' });
  await adapter.sendTurn({ threadId: 't', prompt: 'd', model: 'openrouter/vendor/model-x', opencodePermissionMode: 'defaultPermissions' });
  assert.deepEqual(fake.calls.filter(([n]) => n === 'switchAgent').map((c) => c[2]), ['plan', 'build']);
  assert.equal(fake.calls.filter(([n]) => n === 'switchModel').length, 1);
  await adapter.sendTurn({ threadId: 't', prompt: '/compact' });
  await adapter.sendTurn({ threadId: 't', prompt: '/review the diff' });
  await adapter.sendTurn({ threadId: 't', prompt: '/unknown thing' });
  assert.equal(fake.calls.filter(([n]) => n === 'compact').length, 1);
  assert.deepEqual(fake.calls.find(([n]) => n === 'command').slice(2), [{ name: 'review', text: 'the diff' }]);
  assert.equal(fake.calls.filter(([n]) => n === 'prompt').at(-1)[2].text, '/unknown thing', 'unknown slash text goes out as a prompt');
  console.log('  ✓ model/agent switch only on change; /compact, server commands, unknown slash text');
}

// ── Permissions: card, reply, auto-approve once, settled elsewhere ──────────
{
  const fake = makeFakeOpenCode();
  const adapter = new OpenCodeSdkAdapter(fake.managerSeam);
  const { events } = collect(adapter);
  await adapter.startSession({ provider: 'opencode', threadId: 't', cwd: '/repo', prompt: '' });
  fake.send('ses_1', 'session.tool.input.started', { assistantMessageID: 'a', id: 'call_9', name: 'shell' });
  fake.send('ses_1', 'permission.asked', { id: 'per_1', action: 'shell', resources: ['rm -rf x'], source: { type: 'tool', messageID: 'm', id: 'call_9' } });
  fake.send('ses_1', 'permission.asked', { id: 'per_1', action: 'shell', resources: ['rm -rf x'] });
  const cards = events.filter((e) => e.type === 'permission_request');
  assert.equal(cards.length, 1, 'duplicate asks show one card');
  assert.equal(cards[0].toolName, 'Bash');
  assert.match(cards[0].input.title, /shell: rm -rf x/);
  await adapter.respondToRequest('t', 'per_1', { behavior: 'allow', updatedInput: { optionId: 'always' } });
  assert.deepEqual(fake.calls.find(([n]) => n === 'replyPermission').slice(1), ['ses_1', 'per_1', 'always']);
  fake.send('ses_1', 'permission.asked', { id: 'per_2', action: 'edit', resources: ['a.ts'] });
  fake.send('ses_1', 'permission.replied', { requestID: 'per_2', reply: 'once' });
  assert.ok(events.some((e) => e.type === 'permission_dismissed' && e.requestId === 'per_2'), 'answered elsewhere → card dismissed');

  const full = makeFakeOpenCode();
  const fullAdapter = new OpenCodeSdkAdapter(full.managerSeam);
  const fullEvents = collect(fullAdapter).events;
  await fullAdapter.startSession({ provider: 'opencode', threadId: 'f', cwd: '/repo', prompt: '', opencodePermissionMode: 'fullAccess' });
  full.send('ses_1', 'permission.asked', { id: 'per_f', action: 'shell', resources: ['ls'] });
  await sleep(10);
  assert.deepEqual(full.calls.find(([n]) => n === 'replyPermission').slice(1), ['ses_1', 'per_f', 'once'],
    'full access approves once — never a saved "always" rule');
  assert.ok(!fullEvents.some((e) => e.type === 'permission_request'));
  console.log('  ✓ permissions: one card, tool name from call, replies, auto once, dismissed elsewhere');
}

// ── Question forms → AskUserQuestion and back ───────────────────────────────
{
  const fake = makeFakeOpenCode();
  const adapter = new OpenCodeSdkAdapter(fake.managerSeam);
  const { events } = collect(adapter);
  await adapter.startSession({ provider: 'opencode', threadId: 't', cwd: '/repo', prompt: '' });
  const form = (id) => ({
    id,
    sessionID: 'ses_1',
    title: 'Questions',
    fields: [
      { key: 'q0', type: 'string', title: 'Color', description: 'Which color?', custom: true,
        options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] },
      { key: 'q1', type: 'multiselect', title: 'Pets', description: 'Which pets?',
        options: [{ value: 'cat', label: 'Cat' }, { value: 'dog', label: 'Dog' }] },
    ],
  });
  fake.send('ses_1', 'form.created', { form: form('frm_1') });
  const card = events.find((e) => e.type === 'permission_request' && e.toolName === 'AskUserQuestion');
  assert.deepEqual(card.input.questions.map((q) => [q.question, q.header, q.multiSelect ?? false]),
    [['Which color?', 'Color', false], ['Which pets?', 'Pets', true]]);
  await adapter.respondToRequest('t', 'frm_1', { behavior: 'allow', updatedInput: { answers: { 'Which color?': 'Blue', 'Which pets?': 'Cat, Dog' } } });
  assert.deepEqual(fake.calls.find(([n]) => n === 'replyForm').slice(1), ['ses_1', 'frm_1', { q0: 'blue', q1: ['cat', 'dog'] }]);
  fake.send('ses_1', 'form.created', { form: form('frm_2') });
  await adapter.respondToRequest('t', 'frm_2', { behavior: 'deny' });
  assert.deepEqual(fake.calls.find(([n]) => n === 'cancelForm').slice(1), ['ses_1', 'frm_2']);
  console.log('  ✓ forms: question/header mapping, option values, multiselect, cancel');
}

// ── Failures and interruptions end the turn ────────────────────────────────
{
  const fake = makeFakeOpenCode();
  const adapter = new OpenCodeSdkAdapter(fake.managerSeam);
  const { events, messages } = collect(adapter);
  await adapter.startSession({ provider: 'opencode', threadId: 't', cwd: '/repo', prompt: '' });
  await adapter.sendTurn({ threadId: 't', prompt: 'x' });
  fake.send('ses_1', 'session.execution.failed', { error: { type: 'provider', message: 'rate limited' } });
  assert.ok(events.some((e) => e.type === 'error' && e.error.message === 'rate limited'));
  assert.equal(messages().filter((m) => m.type === 'result').at(-1).subtype, 'error');
  await adapter.sendTurn({ threadId: 't', prompt: 'y' });
  fake.send('ses_1', 'session.execution.interrupted', { reason: 'shutdown' });
  assert.equal(messages().filter((m) => m.type === 'result').length, 2);
  // Rejecting a request halts the turn (interrupted after an aborted step): a normal end.
  await adapter.sendTurn({ threadId: 't', prompt: 'w' });
  fake.send('ses_1', 'permission.asked', { id: 'per_r', action: 'edit', resources: ['a.ts'] });
  await adapter.respondToRequest('t', 'per_r', { behavior: 'deny' });
  fake.send('ses_1', 'session.step.failed', { assistantMessageID: 'a', error: { type: 'aborted', message: 'Step interrupted' } });
  fake.send('ses_1', 'session.execution.interrupted', { reason: 'shutdown' });
  assert.equal(messages().filter((m) => m.type === 'result').at(-1).subtype, 'success', 'a user rejection ends the turn normally');
  assert.equal(messages().filter((m) => m.type === 'result').length, 3);
  await adapter.sendTurn({ threadId: 't', prompt: 'z' });
  fake.send('ses_1', OPENCODE_SERVER_EXITED_EVENT, { code: 1 });
  assert.ok(events.some((e) => e.type === 'error' && /stopped unexpectedly/.test(e.error.message)));
  assert.equal(messages().filter((m) => m.type === 'result').length, 4);
  console.log('  ✓ failed / interrupted / server-exited turns end in error; a user rejection ends normally');
}

// ── Busy session: interrupt once, then retry ───────────────────────────────
{
  let attempts = 0;
  const fake = makeFakeOpenCode({
    prompt: (...args) => {
      fake.calls.push(['prompt', ...args]);
      attempts += 1;
      return attempts === 1 ? Promise.reject(new OpenCodeApiError('busy', 409, 'SessionBusyError')) : Promise.resolve({});
    },
  });
  const adapter = new OpenCodeSdkAdapter(fake.managerSeam);
  await adapter.startSession({ provider: 'opencode', threadId: 't', cwd: '/repo', prompt: '' });
  await adapter.sendTurn({ threadId: 't', prompt: 'x' });
  assert.equal(attempts, 2);
  assert.equal(fake.calls.filter(([n]) => n === 'interrupt').length, 1);
  console.log('  ✓ busy session is interrupted once and the prompt retried');
}

// ── Resume adds missing ask rules; a failed resume creates a new session ────
{
  const fake = makeFakeOpenCode({
    getSession: (id) => (id === 'ses_gone' ? Promise.reject(new Error('404')) : Promise.resolve({ id, permissions: [{ action: 'read', resource: '*', effect: 'allow' }] })),
  });
  const adapter = new OpenCodeSdkAdapter(fake.managerSeam);
  const resumed = await adapter.startSession({ provider: 'opencode', threadId: 'a', cwd: '/repo', prompt: '', resumeSessionId: 'ses_old' });
  assert.equal(resumed.providerSessionId, 'ses_old');
  const update = fake.calls.find(([n]) => n === 'updateSession');
  assert.equal(update[1], 'ses_old');
  assert.equal(update[2].permissions.length, 1 + OPENCODE_ASK_PERMISSIONS.length, 'existing rules kept, ask rules added');
  const fresh = await adapter.startSession({ provider: 'opencode', threadId: 'b', cwd: '/repo', prompt: '', resumeSessionId: 'ses_gone' });
  assert.equal(fresh.providerSessionId, 'ses_1');
  console.log('  ✓ resume: ask rules added to old sessions; unknown id → new session');
}

// ── Stop, dispose, and same-thread restart ─────────────────────────────────
{
  const fake = makeFakeOpenCode();
  const adapter = new OpenCodeSdkAdapter(fake.managerSeam);
  const { events, messages } = collect(adapter);
  await adapter.startSession({ provider: 'opencode', threadId: 't', cwd: '/repo', prompt: '' });
  await adapter.sendTurn({ threadId: 't', prompt: 'x' });
  await adapter.stopSession('t');
  assert.deepEqual(fake.calls.find(([n]) => n === 'interrupt').slice(1), ['ses_1']);
  assert.equal(fake.listenerCount('ses_1'), 0, 'stop drops the event subscription');
  fake.send('ses_1', 'session.execution.interrupted', { reason: 'user' });
  assert.equal(messages().filter((m) => m.type === 'result').length, 0, 'a user stop emits no turn result');
  assert.equal(events.at(-1).status, 'stopped');

  await adapter.startSession({ provider: 'opencode', threadId: 'd', cwd: '/repo', prompt: '' });
  fake.send('ses_2', 'permission.asked', { id: 'per_d', action: 'shell', resources: ['ls'] });
  const before = events.length;
  assert.equal(adapter.disposeSession('d'), true);
  const emitted = events.slice(before);
  assert.deepEqual(emitted.map((e) => e.type), ['permission_dismissed'], 'dispose only dismisses stranded cards');
  assert.equal(fake.listenerCount('ses_2'), 0);
  assert.equal(adapter.disposeSession('d'), false, 'second dispose → false (idempotent)');
  assert.equal(fake.calls.filter(([n]) => n === 'interrupt').length, 1, 'dispose makes no network calls');

  await adapter.startSession({ provider: 'opencode', threadId: 'r', cwd: '/repo', prompt: '', resumeSessionId: 'ses_x' });
  await adapter.startSession({ provider: 'opencode', threadId: 'r', cwd: '/repo', prompt: '', resumeSessionId: 'ses_x' });
  assert.equal(fake.listenerCount('ses_x'), 1, 'same-thread restart never leaves two subscriptions');
  fake.send('ses_x', 'session.execution.started');
  fake.send('ses_x', 'session.step.started', { assistantMessageID: 'a' });
  const deltaCount = () => messages().filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta').length;
  const baseline = deltaCount();
  fake.send('ses_x', 'session.text.delta', { assistantMessageID: 'a', ordinal: 0, delta: 'once' });
  assert.equal(deltaCount() - baseline, 1, 'one emission per event after a restart (no double feed)');
  console.log('  ✓ stop interrupts silently; dispose is quiet and idempotent; restart never double-feeds');
}

console.log('opencode-sdk-adapter: adapter runtime checks passed');

// ═══════════ HTTP client + manager shutdown against a local fake server ═══
const { OpenCodeV2Client, parseServerSentEvents } = require('../dist-electron/electron/libs/provider/opencode-v2-client.js');
const { OpenCodeServeManager } = require('../dist-electron/electron/libs/provider/opencode-serve-manager.js');
{
  // The fake server runs in a worker thread: the sync quit path blocks this
  // thread's event loop (as it does Electron's), so a same-thread server could
  // never answer.
  const worker = new Worker(`
    const http = require('node:http');
    const { parentPort } = require('node:worker_threads');
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      if (req.url.startsWith('/api/session/ses_bad')) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ _tag: 'SessionBusyError', message: 'Session is busy' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url.startsWith('/api/model')
        ? JSON.stringify({ location: {}, data: [{ providerID: 'p', modelID: 'm' }] })
        : JSON.stringify({ data: { id: 'ses_ok', interrupted: true } }));
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
    parentPort.on('message', (message) => {
      if (message === 'take') parentPort.postMessage({ requests: requests.splice(0) });
    });
  `, { eval: true });
  const nextMessage = () => new Promise((resolve) => worker.once('message', resolve));
  const { port } = await nextMessage();
  const takeRequests = async () => { worker.postMessage('take'); return (await nextMessage()).requests; };
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = new OpenCodeV2Client(baseUrl, 'pw');
  assert.equal((await client.getSession('ses_ok')).id, 'ses_ok', 'responses are unwrapped from { data }');
  assert.deepEqual(await client.listModels('/a b'), [{ providerID: 'p', modelID: 'm' }]);
  const modelRequest = (await takeRequests()).at(-1);
  assert.equal(modelRequest.url, '/api/model?location%5Bdirectory%5D=%2Fa+b', 'location is sent as location[directory]');
  assert.equal(modelRequest.auth, `Basic ${Buffer.from('opencode:pw').toString('base64')}`);
  await assert.rejects(client.prompt('ses_bad', { text: 'x' }), (error) => error.status === 409 && error.tag === 'SessionBusyError' && error.message === 'Session is busy');

  const encoder = new TextEncoder();
  const chunks = [': heartbeat\n\n', 'data: {"type":"a","data":{"sessionID":"s"}}\r\n\r\ndata: {"ty', 'pe":"b"}\n\n', 'data: not-json\n\n', 'data: {"type":"c"}'];
  const stream = new ReadableStream({ start(controller) { for (const c of chunks) controller.enqueue(encoder.encode(c)); controller.close(); } });
  const parsed = [];
  for await (const event of parseServerSentEvents(stream)) parsed.push(event.type);
  assert.deepEqual(parsed, ['a', 'b', 'c'], 'SSE: heartbeats skipped, CRLF and split frames handled, bad frames dropped');

  // Shutdown interrupts every running turn (async close and the sync quit path).
  const makeManager = () => {
    const m = new OpenCodeServeManager();
    m.state = { client: new OpenCodeV2Client(baseUrl, 'pw'), password: 'pw', process: { close() {}, exited: new Promise(() => {}) }, events: new AbortController() };
    return m;
  };
  const interrupts = async () => (await takeRequests()).filter((r) => r.method === 'POST' && r.url.endsWith('/interrupt')).map((r) => r.url);
  let m = makeManager();
  m.dispatch({ type: 'session.execution.started', data: { sessionID: 'ses_run' } });
  m.dispatch({ type: 'session.execution.started', data: { sessionID: 'ses_done' } });
  m.dispatch({ type: 'session.execution.succeeded', data: { sessionID: 'ses_done' } });
  await takeRequests();
  m.interruptActiveExecutionsSync();
  assert.deepEqual(await interrupts(), ['/api/session/ses_run/interrupt'], 'quit interrupts only turns still running');
  m = makeManager();
  m.dispatch({ type: 'session.execution.started', data: { sessionID: 'ses_run2' } });
  await m.close();
  assert.deepEqual(await interrupts(), ['/api/session/ses_run2/interrupt'], 'close() interrupts running turns first');
  m = makeManager();
  m.interruptActiveExecutionsSync();
  assert.equal((await takeRequests()).length, 0, 'nothing running → no child process, no requests');

  // Model catalogs are read only after the server announces the directory's full catalog.
  m = makeManager();
  let settled = false;
  const loading = m.loadModels('/proj').then((value) => { settled = true; return value; });
  await sleep(50);
  assert.equal(settled, false, 'waits for model.updated');
  m.dispatch({ type: 'model.updated', location: { directory: '/other' }, data: {} });
  await sleep(20);
  assert.equal(settled, false, 'another directory does not count');
  m.dispatch({ type: 'model.updated', location: { directory: '/proj' }, data: {} });
  assert.equal((await loading).models.length, 1);
  const again = Date.now();
  await m.loadModels('/proj');
  assert.ok(Date.now() - again < 1_000, 'a loaded catalog is read straight away');
  await worker.terminate();
  console.log('  ✓ client: data unwrap, location query, auth, typed errors; SSE framing');
  console.log('  ✓ shutdown interrupts running turns (sync quit path and close())');
  console.log('  ✓ model catalog waits for the directory\'s model.updated');
}

// ═══════════ Binary selection + `opencode serve --stdio` startup ══════════
{
  const {
    OPENCODE_BIN_ENV,
    parseOpenCodeServerUrl,
    parseOpenCodeVersion,
    resolveOpenCodeBinary,
    startOpenCodeServerProcess,
  } = require('../dist-electron/electron/libs/provider/opencode-server-process.js');

  assert.equal(parseOpenCodeServerUrl('{"url":"http://127.0.0.1:4096"}'), 'http://127.0.0.1:4096');
  assert.equal(parseOpenCodeServerUrl('server listening on http://127.0.0.1:4096'), 'http://127.0.0.1:4096');
  assert.equal(parseOpenCodeServerUrl('server password abc'), null);
  assert.equal(parseOpenCodeVersion('opencode v2.0.18').major, 2);
  console.log('  ✓ parses stdio and plain readiness lines and versions');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-opencode-bin-'));
  const writeFake = (dir, version) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode');
    fs.writeFileSync(
      file,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
port=$(echo "$4" | sed 's/--port=//')
[ "$2" = "--stdio" ] && [ -n "$OPENCODE_SERVER_PASSWORD" ] || exit 3
echo "{\\"url\\":\\"http://127.0.0.1:$port\\"}"
cat > /dev/null
`
    );
    fs.chmodSync(file, 0o755);
    return file;
  };
  try {
    const v1 = writeFake(path.join(tmp, 'v1'), '1.18.34');
    const v2 = writeFake(path.join(tmp, 'v2'), 'opencode v2.0.18');
    const basePath = '/usr/bin:/bin';
    const picked = await resolveOpenCodeBinary({ PATH: `${path.dirname(v1)}:${path.dirname(v2)}:${basePath}` });
    assert.equal(picked.path, v2, 'a 2.x opencode later on PATH wins over a 1.x one');
    await assert.rejects(resolveOpenCodeBinary({ PATH: `${path.dirname(v1)}:${basePath}` }), /1\.18\.34 at .*too old: Aegis needs OpenCode 2\.x/);
    await assert.rejects(resolveOpenCodeBinary({ PATH: basePath }), /not found on PATH/);
    assert.equal((await resolveOpenCodeBinary({ PATH: basePath, [OPENCODE_BIN_ENV]: v2 })).path, v2, `${OPENCODE_BIN_ENV} bypasses the PATH search`);
    console.log('  ✓ picks the first 2.x opencode; 1.x-only fails fast; honors the override');

    const server = await startOpenCodeServerProcess({ binary: v2, hostname: '127.0.0.1', port: 45999, password: 'pw', timeout: 5_000, config: {} });
    assert.equal(server.url, 'http://127.0.0.1:45999');
    server.close();
    assert.equal(await Promise.race([server.exited, sleep(4_000).then(() => 'still running')]), 0, 'closing stdin stops the server');
    const crashing = path.join(tmp, 'crashing-opencode');
    fs.writeFileSync(crashing, '#!/bin/sh\necho "boom" >&2\nexit 1\n');
    fs.chmodSync(crashing, 0o755);
    const exited = await startOpenCodeServerProcess({ binary: crashing, hostname: '127.0.0.1', port: 45998, password: 'pw', timeout: 5_000, config: {} }).then(() => null, (error) => error);
    assert.match(String(exited?.message), /exited with code 1[\s\S]*boom/, 'a server that exits rejects with its output');
    console.log('  ✓ starts `serve --stdio` with a password, resolves on the URL line, stops on stdin close');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('opencode-sdk-adapter: server and client checks passed');
