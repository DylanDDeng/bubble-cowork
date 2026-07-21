#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const packageJson = JSON.parse(read('package.json'));
assert.ok(
  packageJson.dependencies?.['@opencode-ai/sdk'],
  'package.json must depend on @opencode-ai/sdk'
);

const loader = read('src/electron/libs/provider/opencode-sdk-loader.ts');
assert.ok(
  loader.includes("return import(specifier)") && loader.includes("@opencode-ai/sdk"),
  'OpenCode SDK loader must use native dynamic import for the ESM-only SDK'
);
assert.ok(
  loader.includes("@opencode-ai/sdk/v2") && loader.includes('loadOpenCodeV2Sdk'),
  'OpenCode SDK loader must expose the v2 client for permission/question APIs'
);
assert.ok(
  !/import\s+.*from ['"]@opencode-ai\/sdk['"]/.test(loader),
  'OpenCode SDK loader must not statically import the ESM-only SDK'
);

const manager = read('src/electron/libs/provider/opencode-serve-manager.ts');
assert.ok(
  manager.includes('createOpencodeServer') &&
    manager.includes('createOpencodeClient') &&
    manager.includes('findAvailablePort'),
  'OpenCode serve manager must start opencode serve and create SDK clients'
);
assert.ok(
  manager.includes("edit: 'ask'") &&
    manager.includes("bash: 'ask'") &&
    manager.includes("external_directory: 'ask'"),
  'OpenCode serve manager must default tools to ask permissions'
);
assert.ok(
  manager.includes('command(options: unknown)') &&
    manager.includes('list(options?: unknown)'),
  'OpenCode SDK client type must expose command list and session command APIs'
);
assert.ok(
  manager.includes('v2?: OpenCodeV2Client') &&
    manager.includes('session?: {') &&
    manager.includes('question?: OpenCodeQuestionReplyApi') &&
    manager.includes('permission?: OpenCodePermissionReplyApi'),
  'OpenCode serve manager must attach v2 permission and question clients'
);

const adapter = read('src/electron/libs/provider/opencode-sdk-adapter.ts');
assert.ok(
  adapter.includes("readonly provider: ProviderKind = 'opencode'"),
  'OpenCode SDK adapter must register provider=opencode'
);
assert.ok(
  adapter.includes('session.client.event.subscribe') &&
    adapter.includes('eventReady') &&
    adapter.includes('markEventReady'),
  'OpenCode SDK adapter must start the event stream before sending prompts'
);
assert.ok(
  adapter.includes("type: 'permission_request'") &&
    adapter.includes("provider: 'opencode'") &&
    adapter.includes("response: 'once' | 'always' | 'reject'"),
  'OpenCode SDK adapter must map SDK permission events and replies'
);
assert.ok(
  adapter.includes("case 'permission.asked'") &&
    adapter.includes("case 'permission.v2.asked'") &&
    adapter.includes('respondToOpenCodePermissionReply') &&
    adapter.includes('respondToOpenCodePermissionV2'),
  'OpenCode SDK adapter must handle legacy and v2 permission ask events'
);
assert.ok(
  adapter.includes("case 'question.asked'") &&
    adapter.includes("case 'question.v2.asked'") &&
    adapter.includes('AskUserQuestionInput') &&
    adapter.includes('buildOpenCodeQuestionInput') &&
    adapter.includes('respondToOpenCodeQuestion') &&
    adapter.includes('questionV2Reply'),
  'OpenCode SDK adapter must show and answer OpenCode question popups'
);
assert.ok(
  adapter.includes('session.client.session.prompt') &&
    adapter.includes('buildPromptParts') &&
    adapter.includes('data:') &&
    adapter.includes('pathToFileURL'),
  'OpenCode SDK adapter must send prompts and support image/file attachment fallback'
);
assert.ok(
  adapter.includes('emitAvailableCommands') &&
    adapter.includes('session.client.command.list') &&
    adapter.includes("subtype: 'available_commands_update'") &&
    adapter.includes('parseOpenCodeSlashCommand') &&
    adapter.includes('session.client.session.command'),
  'OpenCode SDK adapter must list and execute OpenCode slash commands through the SDK'
);
assert.ok(
  adapter.includes('refreshModelLimits') &&
    adapter.includes('client.config.providers') &&
    adapter.includes('context_window') &&
    adapter.includes('total_tokens') &&
    adapter.includes('reasoning_output_tokens'),
  'OpenCode SDK adapter must enrich token usage with model context limits'
);
assert.ok(
  adapter.includes('planMode: true') &&
    adapter.includes('getOpenCodeAgentForMode') &&
    adapter.includes("mode === 'plan' ? 'plan'") &&
    adapter.includes('...(agent ? { agent } : {})'),
  'OpenCode SDK adapter must map Composer Plan mode to the OpenCode plan agent'
);
assert.ok(
  adapter.includes('messageRoles') &&
    adapter.includes('pendingPartUpdates') &&
    adapter.includes("role === 'user'") &&
    adapter.includes('queuePendingPartUpdate') &&
    adapter.includes('flushPendingPartUpdates'),
  'OpenCode SDK adapter must filter user message parts and buffer unknown-role parts'
);
assert.ok(
  adapter.includes("type: 'stream_event'") &&
    adapter.includes("type: 'tool_use'") &&
    adapter.includes("type: 'tool_result'") &&
    adapter.includes("type: 'result'"),
  'OpenCode SDK adapter must map streaming, tool, and result messages'
);
assert.ok(
  adapter.includes('session.client.mcp.status') && adapter.includes("tool: 'opencode'"),
  'OpenCode SDK adapter must emit OpenCode MCP status when available'
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
  promptInput.includes('OpenCodePermissionModePicker') &&
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

const openCodePermissionPicker = read('src/ui/components/OpenCodePermissionModePicker.tsx');
assert.ok(
  openCodePermissionPicker.includes('OpenCodePermissionMode') &&
    openCodePermissionPicker.includes('Plan') &&
    openCodePermissionPicker.includes("'plan'") &&
    openCodePermissionPicker.includes('Full Access') &&
    openCodePermissionPicker.includes("'defaultPermissions'") &&
    openCodePermissionPicker.includes("'fullAccess'"),
  'OpenCode permission picker must expose default, plan, and full access modes'
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

// ═══════════ L1 runtime: dispose semantics (fake serve-manager seam) ═══════
// Requires `npm run transpile:electron` to have produced dist-electron.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OpenCodeSdkAdapter } = require('../dist-electron/electron/libs/provider/opencode-sdk-adapter.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Broadcast-bus fake for the serve manager: every event.subscribe() call gets
 * its own queue fed by bus.push (mirrors the real server broadcasting SSE to
 * all connections), honoring the passed AbortSignal — which is exactly the
 * mechanism the double-emission bug rode on (an orphaned subscription with a
 * never-aborted signal kept receiving broadcasts).
 */
function makeFakeOpenCodeEnv() {
  const subscriptions = [];
  let sessionCounter = 0;
  let promptGate = null;
  const bus = {
    subscriptions,
    push(event) {
      for (const sub of subscriptions) {
        sub.push(event);
      }
    },
  };
  const client = {
    event: {
      subscribe: async ({ signal }) => {
        const queue = [];
        let waiter = null;
        let closed = false;
        const deliver = (event) => {
          if (closed || signal?.aborted) return;
          if (waiter) {
            const pending = waiter;
            waiter = null;
            pending({ value: event, done: false });
          } else {
            queue.push(event);
          }
        };
        const close = () => {
          closed = true;
          if (waiter) {
            const pending = waiter;
            waiter = null;
            pending({ value: undefined, done: true });
          }
        };
        signal?.addEventListener('abort', close, { once: true });
        subscriptions.push({ signal, push: deliver });
        return {
          stream: {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  if (queue.length > 0) {
                    return Promise.resolve({ value: queue.shift(), done: false });
                  }
                  if (closed || signal?.aborted) {
                    return Promise.resolve({ value: undefined, done: true });
                  }
                  return new Promise((resolve) => {
                    waiter = resolve;
                  });
                },
              };
            },
          },
        };
      },
    },
    session: {
      create: async () => ({ id: `sess-${(sessionCounter += 1)}` }),
      get: async ({ path: p }) => ({ id: p.id }),
      prompt: () =>
        promptGate
          ? promptGate.promise
          : Promise.resolve({ info: {}, parts: [] }),
      abort: async () => ({}),
    },
  };
  const manager = {
    getClient: async () => client,
    close: async () => {},
  };
  const gatePrompt = () => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    promptGate = { promise, release };
    return promptGate;
  };
  return { manager, bus, client, gatePrompt };
}

function collectAdapterEvents(adapter) {
  const events = [];
  adapter.events.on('event', (event) => events.push(event));
  return events;
}
const assistantDeltas = (events) =>
  events.filter((e) => e.type === 'message' && e.message?.type === 'stream_event');

// ── Double-emission regression: errored-turn retire → resume → single feed ──
{
  const env = makeFakeOpenCodeEnv();
  const adapter = new OpenCodeSdkAdapter(env.manager);
  const events = collectAdapterEvents(adapter);
  await adapter.startSession({ provider: 'opencode', threadId: 't1', cwd: '/tmp' });
  const providerSessionId = 'sess-1';

  // Sanity: one subscription, one delta per broadcast.
  env.bus.push({
    type: 'message.updated',
    properties: { info: { id: 'm1', sessionID: providerSessionId, role: 'assistant' } },
  });
  env.bus.push({
    type: 'message.part.updated',
    properties: {
      part: { id: 'p1', sessionID: providerSessionId, messageID: 'm1', type: 'text', text: 'Hi' },
      delta: 'Hi',
    },
  });
  await sleep(40);
  const baseline = assistantDeltas(events).length;
  assert.ok(baseline >= 1, 'fake bus must drive at least one assistant delta');

  // Errored-turn retirement path: dispose, then respawn resuming the SAME
  // provider session id (exactly what handleSessionContinue does).
  assert.equal(adapter.disposeSession('t1'), true, 'dispose of live session → true');
  assert.equal(env.bus.subscriptions[0].signal.aborted, true, 'dispose must abort the SSE subscription');
  await adapter.startSession({
    provider: 'opencode',
    threadId: 't1',
    cwd: '/tmp',
    resumeSessionId: providerSessionId,
  });

  env.bus.push({
    type: 'message.updated',
    properties: { info: { id: 'm2', sessionID: providerSessionId, role: 'assistant' } },
  });
  env.bus.push({
    type: 'message.part.updated',
    properties: {
      part: { id: 'p2', sessionID: providerSessionId, messageID: 'm2', type: 'text', text: 'again' },
      delta: 'again',
    },
  });
  await sleep(40);
  const after = assistantDeltas(events).length - baseline;
  assert.equal(after, 1, `post-respawn broadcast must emit exactly once, got ${after} (zombie double-feed)`);
  console.log('  ✓ dispose → resume: one subscription, one emission per broadcast (double-feed regression)');

  // Defensive overwrite: startSession over a live same-thread session
  // disposes the predecessor (never orphan).
  const liveSubs = env.bus.subscriptions.filter((sub) => !sub.signal.aborted).length;
  await adapter.startSession({ provider: 'opencode', threadId: 't1', cwd: '/tmp' });
  const liveAfter = env.bus.subscriptions.filter((sub) => !sub.signal.aborted).length;
  assert.equal(liveAfter, liveSubs, 'same-thread restart must not grow live subscriptions');
  console.log('  ✓ startSession disposes a same-thread predecessor (never orphan)');
}

// ── Dispose is quiet + dismisses stranded permission cards ─────────────────
{
  const env = makeFakeOpenCodeEnv();
  const adapter = new OpenCodeSdkAdapter(env.manager);
  const events = collectAdapterEvents(adapter);
  await adapter.startSession({ provider: 'opencode', threadId: 't2', cwd: '/tmp' });

  env.bus.push({
    type: 'permission.asked',
    properties: { id: 'perm-1', sessionID: 'sess-1', permission: { id: 'perm-1' } },
  });
  await sleep(40);
  assert.ok(
    events.some((e) => e.type === 'permission_request'),
    'permission.asked must surface a permission_request'
  );

  const before = events.length;
  assert.equal(adapter.disposeSession('t2'), true);
  const emitted = events.slice(before);
  assert.ok(
    emitted.some((e) => e.type === 'permission_dismissed' && e.requestId === 'perm-1'),
    'dispose must dismiss the stranded permission card'
  );
  assert.equal(
    emitted.filter((e) => e.type === 'status_change' || (e.type === 'message' && e.message?.type === 'result')).length,
    0,
    'dispose must emit no status_change and no result'
  );
  assert.equal(adapter.disposeSession('t2'), false, 'second dispose → false (idempotent)');
  console.log('  ✓ dispose: permission_dismissed only, no status/result, idempotent');
}

// ── Stranded sendTurn: late prompt resolution after dispose emits nothing ──
{
  const env = makeFakeOpenCodeEnv();
  const adapter = new OpenCodeSdkAdapter(env.manager);
  const events = collectAdapterEvents(adapter);
  await adapter.startSession({ provider: 'opencode', threadId: 't3', cwd: '/tmp' });

  const gate = env.gatePrompt();
  const turnPromise = adapter.sendTurn({ provider: 'opencode', threadId: 't3', prompt: 'hello' });
  await sleep(20);
  assert.equal(adapter.disposeSession('t3'), true);
  const before = events.length;
  gate.release({ info: { id: 'm9', sessionID: 'sess-1', role: 'assistant' }, parts: [] });
  await turnPromise;
  await sleep(20);
  assert.equal(
    events.length - before,
    0,
    'a prompt resolving after dispose must emit nothing (stale-result guard)'
  );
  console.log('  ✓ stranded sendTurn after dispose emits nothing (liveness recheck)');
}

console.log('opencode-sdk-adapter: dispose runtime checks passed');
