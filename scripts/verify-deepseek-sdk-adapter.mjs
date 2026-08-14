#!/usr/bin/env node
// Wiring checks for the DeepSeek Harness SDK adapter (verify-pi-sdk-adapter
// style). The SDK wire streams the full session log; these checks pin the
// adapter to that contract and to the registration surface.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ── SDK dependency ──────────────────────────────────────────────────────────
const rootPkg = JSON.parse(read('package.json'));
assert.ok(
  rootPkg.dependencies?.['@deepseek-ai/dsh-sdk-client'],
  'package.json must depend on @deepseek-ai/dsh-sdk-client (pinned rc)'
);

// ── Launch profile fixture ──────────────────────────────────────────────────
const profilePkg = JSON.parse(read('dev-fixtures/deepseek-harness/package.json'));
assert.ok(
  profilePkg.dependencies?.['@deepseek-ai/dsh-sdk-jsonrpc-server'] &&
    profilePkg.dependencies?.['@deepseek-ai/dsh-llm-deepseek'] &&
    profilePkg.dependencies?.['@deepseek-ai/dsh-bash-sandbox'] &&
    profilePkg.dependencies?.['@deepseek-ai/dsh-fs-sandbox'],
  'deepseek-harness profile must compose the SDK server, DeepSeek adapter and sandboxed tool stack'
);
const cordisYml = read('dev-fixtures/deepseek-harness/cordis.yml');
assert.ok(
  cordisYml.includes("name: '@deepseek-ai/dsh-sdk-jsonrpc-server'") &&
    cordisYml.includes("name: '@deepseek-ai/dsh-llm-deepseek'") &&
    cordisYml.includes('models:') &&
    cordisYml.includes('DSH_PERMISSION_MODE') &&
    cordisYml.includes('DSH_CWD') &&
    cordisYml.includes('policy: never'),
  'profile cordis.yml must mount the SDK server, model catalog, env-driven sandbox, and auto-deny approvals'
);
assert.ok(
  fs.existsSync(path.join(root, 'dev-fixtures/deepseek-harness/runtime-bin.mjs')) &&
    fs.existsSync(path.join(root, 'dev-fixtures/deepseek-harness/runtime-resume-shim.mjs')),
  'profile must ship the app-boot runtime bin and native-resume shim'
);
const runtimeBin = read('dev-fixtures/deepseek-harness/runtime-bin.mjs');
const resumeShim = read('dev-fixtures/deepseek-harness/runtime-resume-shim.mjs');
assert.ok(
  runtimeBin.includes('installDeepseekSdkResumeShim') &&
    resumeShim.includes('server.ctx.agents.resume') &&
    resumeShim.includes('AEGIS_DSH_RESUME_SESSION_ID') &&
    resumeShim.includes('AEGIS_DSH_RESUME_CWD_MISMATCH'),
  'runtime must resume stored same-cwd sessions and reject unsafe fallback cases explicitly'
);

// ── Settings / runtime probe ────────────────────────────────────────────────
const cli = read('src/electron/libs/deepseek-cli.ts');
assert.ok(
  cli.includes("'runtime-bin.mjs'") &&
    cli.includes('AEGIS_DSH_PROFILE_DIR') &&
    cli.includes("'dev-fixtures', 'deepseek-harness'"),
  'deepseek-cli must resolve the launch profile (env override + dev fixture)'
);
assert.ok(
  cli.includes('DEEPSEEK_API_KEY') &&
    cli.includes("'.deepseek'") &&
    cli.includes("'config.toml'") &&
    cli.includes('DSH_PERMISSION_MODE') &&
    cli.includes('DSH_CWD'),
  'deepseek-cli must resolve the API key (env + TUI config) and build the runtime env'
);
assert.ok(
  cli.includes('getDeepseekModelConfig') && cli.includes('dsh-llm-deepseek'),
  'deepseek-cli must derive the model catalog from the profile cordis.yml'
);

const runtimeDirectory = read('src/electron/libs/agent-runtime-directory.ts');
assert.ok(
  runtimeDirectory.includes('probeDeepseek') &&
    runtimeDirectory.includes("['deepseek', probeDeepseek()]") &&
    /deepseek:\s*\{/.test(runtimeDirectory),
  'runtime directory must probe DeepSeek (profile + API key, file checks only)'
);

// ── Loader + adapter contract ───────────────────────────────────────────────
const loader = read('src/electron/libs/provider/deepseek-sdk-loader.ts');
assert.ok(
  loader.includes("return import(specifier)") &&
    loader.includes('@deepseek-ai/dsh-sdk-client') &&
    loader.includes('DeepSeekHarness'),
  'loader must dynamically import the ESM SDK and expose DeepSeekHarness'
);

const adapter = read('src/electron/libs/provider/deepseek-sdk-adapter.ts');
assert.ok(
  adapter.includes("readonly provider: ProviderKind = 'deepseek'") &&
    adapter.includes('loadDeepseekSdk'),
  'adapter must register provider=deepseek over the SDK loader'
);
assert.ok(
  adapter.includes("'reasoning-delta'") &&
    adapter.includes("'text-delta'") &&
    adapter.includes('thinking_delta') &&
    adapter.includes('text_delta'),
  'adapter must stream reasoning and text deltas from assistant/chunk events'
);
assert.ok(
  adapter.includes("'tool/call'") &&
    adapter.includes("'tool/result'") &&
    adapter.includes("type: 'tool_use'") &&
    adapter.includes("type: 'tool_result'"),
  'adapter must render tool calls and results from session events'
);
assert.ok(
  adapter.includes("'request/context'") &&
    adapter.includes("subtype: 'token_usage'") &&
    adapter.includes('contextWindow'),
  'adapter must emit the codex-style context ring from request/context + usage'
);
assert.ok(
  adapter.includes("type: 'result'") &&
    adapter.includes("'turn/end'") &&
    adapter.includes('this.sessions.get(input.threadId) !== active'),
  'adapter must synthesize a turn-terminal result from turn/end with the stale-session guard'
);
assert.ok(
  adapter.includes('harness.close()') &&
    adapter.includes('active.closed = true') &&
    adapter.includes('ELECTRON_RUN_AS_NODE'),
  'adapter must interrupt by closing the runtime (no wire cancel) and launch the bin as plain node'
);
assert.ok(
  adapter.includes('subscribeSessionTree') &&
    adapter.includes('turnInFlight') &&
    adapter.includes('client.prompt('),
  'adapter must steer mid-turn via inbox enqueue over a persistent session-tree subscription'
);
assert.ok(
  !adapter.includes('onNotification: (notification)'),
  'events must ride the persistent subscription, never the per-run observer (steer-race safety)'
);

// ── Provider registration ───────────────────────────────────────────────────
const agentLoop = read('src/electron/libs/agent-loop.ts');
assert.ok(
  agentLoop.includes('service.registerAdapter(new DeepseekSdkAdapter())') &&
    agentLoop.includes('deepseekPermissionMode: options.deepseekPermissionMode') &&
    agentLoop.includes("sendOptions?.deepseekPermissionMode ?? options.deepseekPermissionMode"),
  'agent-loop must register the adapter and forward deepseekPermissionMode on start and warm send'
);

const service = read('src/electron/libs/provider/service.ts');
assert.ok(service.includes("provider === 'deepseek'"), 'isProviderKind must accept deepseek');

const providerTypes = read('src/electron/libs/provider/types.ts');
const sharedTypes = read('src/shared/types.ts');
assert.ok(
  /ProviderKind =[^;]*'deepseek'/.test(providerTypes) &&
    /AgentProvider =[^;]*'deepseek'/.test(sharedTypes) &&
    sharedTypes.includes("'deepseek_local'") &&
    sharedTypes.includes('DeepseekPermissionMode'),
  'provider/shared types must include deepseek, deepseek_local and DeepseekPermissionMode'
);
assert.ok(
  /token_usage[\s\S]{0,200}'codex' \| 'kimi' \| 'grok' \| 'deepseek'/.test(sharedTypes),
  'token_usage message provider union must include deepseek'
);

const warmSend = read('src/electron/libs/warm-send-options.ts');
assert.ok(
  warmSend.includes("'deepseekPermissionMode'") &&
    warmSend.includes('deepseekPermissionMode: next.deepseekPermissionMode'),
  'warm-send envelope must carry deepseekPermissionMode unconditionally'
);

const sessionStore = read('src/electron/libs/session-store.ts');
assert.ok(
  sessionStore.includes('deepseek_session_id TEXT') &&
    sessionStore.includes("ensureColumn('sessions', 'deepseek_session_id', 'TEXT')") &&
    sessionStore.includes('updateDeepseekSessionId') &&
    sessionStore.includes("'deepseek_local'"),
  'session store must persist deepseek session ids and source origin'
);

const ipc = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipc.includes("'get-deepseek-model-config'") &&
    ipc.includes('updateDeepseekSessionId') &&
    ipc.includes('formatDeepseekRuntimeBlockingMessage') &&
    ipc.includes('selectedDeepseekPermissionMode') &&
    ipc.includes('nextDeepseekPermissionMode') &&
    ipc.includes('deepseekPermissionModeChanged'),
  'ipc-handlers must wire model config, init persistence, runtime gates and mode plumbing'
);

// ── Bridge + UI ─────────────────────────────────────────────────────────────
const preload = read('src/electron/preload.cts');
const typesDts = read('src/types.d.ts');
const uiTypes = read('src/ui/types.ts');
assert.ok(
  preload.includes("ipcRenderer.invoke('get-deepseek-model-config')") &&
    typesDts.includes('getDeepseekModelConfig') &&
    uiTypes.includes('DeepseekModelConfig'),
  'bridge chain must expose getDeepseekModelConfig end to end'
);

const providers = read('src/ui/utils/provider.ts');
const picker = read('src/ui/components/ProviderPicker.tsx');
const onboarding = read('src/ui/components/onboarding/AgentOnboardingView.tsx');
const readiness = read('src/ui/hooks/useAgentReadiness.ts');
const composerSelection = read('src/ui/hooks/useComposerAgentSelection.ts');
const usage = read('src/ui/components/settings/ClaudeUsageSettings.tsx');
assert.ok(
  providers.includes("{ id: 'deepseek', label: 'DeepSeek' }") &&
    picker.includes('DeepseekLogo') &&
    onboarding.includes('deepseek:') &&
    readiness.includes("provider: 'deepseek'") &&
    composerSelection.includes('useDeepseekModelConfig') &&
    composerSelection.includes('savePreferredDeepseekModel') &&
    usage.includes("id: 'deepseek'"),
  'UI must list DeepSeek across picker, onboarding, readiness, composer and usage settings'
);

const contextUsage = read('src/ui/utils/context-usage.ts');
const promptInput = read('src/ui/components/PromptInput.tsx');
const appStore = read('src/ui/store/useAppStore.ts');
assert.ok(
  contextUsage.includes("message.provider === 'deepseek'") &&
    promptInput.includes('isDeepseekContextVisible') &&
    appStore.includes("provider === 'deepseek'"),
  'UI must render the deepseek context ring and hold the streaming buffer across tool interleaves'
);
assert.ok(
  /canSteerWhileRunning =[\s\S]{0,400}'deepseek'/.test(promptInput) &&
    ipc.includes('deepseekMidTurn'),
  'steer must be enabled end to end: composer queue/steer UI + mid-turn respawn guard'
);

// ── Composer permission picker (unified mapping) ────────────────────────────
const unifiedPicker = read('src/ui/components/PermissionModePicker.tsx');
const deepseekOptionsBlock =
  unifiedPicker.match(/DEEPSEEK_PERMISSION_MODE_OPTIONS[\s\S]*?\];/)?.[0] ?? '';
assert.ok(
  deepseekOptionsBlock.includes("'workspace-write'") &&
    deepseekOptionsBlock.includes("'danger-full-access'") &&
    deepseekOptionsBlock.includes("tone: 'full-access'"),
  'unified permission picker must map deepseek workspace-write + danger-full-access modes'
);
const permissionUtil = read('src/ui/utils/deepseek-permission.ts');
const newSession = read('src/ui/components/NewSessionView.tsx');
assert.ok(
  permissionUtil.includes('cowork.preferredDeepseekPermissionMode') &&
    composerSelection.includes('loadPreferredDeepseekPermissionMode') &&
    composerSelection.includes('setDeepseekPermissionMode') &&
    promptInput.includes('DEEPSEEK_PERMISSION_MODE_OPTIONS') &&
    promptInput.includes('agentSelection.deepseekPermissionMode') &&
    newSession.includes('DEEPSEEK_PERMISSION_MODE_OPTIONS') &&
    newSession.includes('agentSelection.deepseekPermissionMode'),
  'composer must render the deepseek picker and send the stored mode preference end to end'
);

// ── History bootstrap (respawn context restore) ─────────────────────────────
// Same-cwd restarts pass the stored DSH id and send only the latest user
// message. Missing logs and cwd mismatches must fail loudly.
assert.ok(
  !ipc.includes('buildDeepseekRestoredContextText') &&
    !ipc.includes('<restored_context>') &&
    !ipc.includes('deepseekFallbackPrompt'),
  'session continue must not rebuild or inject a transcript for DeepSeek'
);
assert.ok(
  adapter.includes('harness.session(input.resumeSessionId)') &&
    adapter.includes('AEGIS_DSH_RESUME_SESSION_ID') &&
    !adapter.includes('replaceWithFreshSession') &&
    !adapter.includes('resumeFallbackPrompt') &&
    !agentLoop.includes('deepseekResumeFallbackPrompt'),
  'adapter must pass the durable id through without any fresh-session fallback'
);

// Exercise the dependency-free resume policy without requiring the fixture's
// ignored node_modules installation in CI.
const {
  openSessionWithNativeResume,
  RESUME_CWD_MISMATCH_CODE,
  RESUME_NOT_FOUND_CODE,
} = await import('../dev-fixtures/deepseek-harness/runtime-resume-shim.mjs');
const sessionId = (value) => value;
const makeServer = (headers) => {
  const resumed = [];
  const server = {
    cwd: '/workspace',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    sessions: new Map(),
    ctx: {
      get: (name) => name === 'sessionPersistence' ? { list: async () => headers } : undefined,
      agents: {
        resume: async (options) => {
          resumed.push(options);
          return { agent: { id: options.resumeSessionId } };
        },
      },
    },
  };
  return { server, resumed };
};

{
  const { server, resumed } = makeServer([{ id: 'stored', cwd: '/workspace' }]);
  const record = await openSessionWithNativeResume({
    server,
    sessionId: 'stored',
    SessionId: sessionId,
    createFresh: () => assert.fail('stored session must not be recreated'),
    expectedResumeSessionId: 'stored',
  });
  assert.equal(record.handle.agent.id, 'stored');
  assert.equal(resumed.length, 1);
  assert.equal(server.sessions.get('stored'), record);
}

{
  const { server } = makeServer([]);
  const created = await openSessionWithNativeResume({
    server,
    sessionId: 'fresh',
    SessionId: sessionId,
    createFresh: async () => ({ fresh: true }),
    expectedResumeSessionId: undefined,
  });
  assert.deepEqual(created, { fresh: true });
}

for (const testCase of [
  { headers: [], expected: RESUME_NOT_FOUND_CODE },
  { headers: [{ id: 'stored', cwd: '/other' }], expected: RESUME_CWD_MISMATCH_CODE },
]) {
  const { server } = makeServer(testCase.headers);
  await assert.rejects(
    openSessionWithNativeResume({
      server,
      sessionId: 'stored',
      SessionId: sessionId,
      createFresh: () => assert.fail('unsafe resume must fail loudly'),
      expectedResumeSessionId: 'stored',
    }),
    (error) => error instanceof Error && error.message.includes(testCase.expected)
  );
}

console.log('deepseek-sdk-adapter: wiring checks passed');
