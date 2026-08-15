#!/usr/bin/env node
// Wiring checks for the DeepSeek Harness SDK adapter (verify-pi-sdk-adapter
// style). The SDK wire streams the full session log; these checks pin the
// adapter to that contract and to the registration surface.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
    cordisYml.includes('DSH_REASONING_EFFORT') &&
    cordisYml.includes('DSH_CWD') &&
    cordisYml.includes('policy: never'),
  'profile cordis.yml must mount the SDK server, model catalog, env-driven sandbox, and auto-deny approvals'
);
assert.ok(
  /skills:\s*\n\s+enabled:[^\n]*AEGIS_DSH_AGENT_PRESET/.test(cordisYml),
  'profile must mount the Harness filesystem skill provider and native /name invocation tool'
);
assert.ok(
  cordisYml.includes('AEGIS_DSH_AGENT_PRESET') &&
    cordisYml.includes("=== 'code' ? 'code' : 'native'") &&
    cordisYml.includes("name: '@deepseek-ai/dsh-code-runtime-worker-thread'") &&
    cordisYml.includes("name: '@deepseek-ai/dsh-tool-bash-persistent'") &&
    cordisYml.includes("name: '@deepseek-ai/dsh-tool-str-replace-editor'") &&
    cordisYml.includes("name: '@deepseek-ai/dsh-tool-cordis'"),
  'profile must compose real Standard, PTC, Minimal and Creator runtime capabilities'
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
    cli.includes("'.dsh'") &&
    cli.includes("'.credentials.yaml'") &&
    !cli.includes("'.deepseek'") &&
    !cli.includes("'config.toml'") &&
    cli.includes('DSH_PERMISSION_MODE') &&
    cli.includes('AEGIS_DSH_AGENT_PRESET') &&
    cli.includes('DSH_REASONING_EFFORT') &&
    cli.includes('DSH_CWD'),
  'deepseek-cli must resolve the API key (Aegis store + env + dsh credentials; the unrelated ~/.deepseek/config.toml must stay ignored) and build the runtime env'
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
  adapter.includes('listDeepseekSkills') &&
    adapter.includes('supportsSkillDiscovery: true') &&
    adapter.includes("source: 'deepseek-harness'"),
  'adapter must expose the Harness filesystem skill catalog to the composer'
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
  adapter.includes('usageByStep') &&
    adapter.includes('turn.usageByStep.get(key)') &&
    adapter.includes('estimateDeepseekUsageCost') &&
    !adapter.includes('turn.usage.output + turn.usage.reasoning'),
  'adapter must de-duplicate rc.6 usage samples, estimate cost, and not double-count reasoning'
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
    agentLoop.includes("sendOptions?.deepseekPermissionMode ?? options.deepseekPermissionMode") &&
    agentLoop.includes('deepseekReasoningEffort: options.deepseekReasoningEffort') &&
    agentLoop.includes("sendOptions?.deepseekReasoningEffort ?? options.deepseekReasoningEffort"),
  'agent-loop must register the adapter and forward DeepSeek runtime options on start and warm send'
);

const service = read('src/electron/libs/provider/service.ts');
assert.ok(service.includes("provider === 'deepseek'"), 'isProviderKind must accept deepseek');

const providerTypes = read('src/electron/libs/provider/types.ts');
const sharedTypes = read('src/shared/types.ts');
assert.ok(
  /ProviderKind =[^;]*'deepseek'/.test(providerTypes) &&
    /AgentProvider =[^;]*'deepseek'/.test(sharedTypes) &&
    sharedTypes.includes("'deepseek_local'") &&
    sharedTypes.includes('DeepseekPermissionMode') &&
    sharedTypes.includes("DeepseekAgentPreset = 'standard' | 'code' | 'minimal' | 'cordis'") &&
    sharedTypes.includes("DeepseekReasoningEffort = 'off' | 'high' | 'max'"),
  'provider/shared types must include DeepSeek identity, presets, permissions and reasoning tiers'
);
assert.ok(
  /token_usage[\s\S]{0,200}'codex' \| 'kimi' \| 'grok' \| 'deepseek'/.test(sharedTypes),
  'token_usage message provider union must include deepseek'
);

const warmSend = read('src/electron/libs/warm-send-options.ts');
assert.ok(
  warmSend.includes("'deepseekPermissionMode'") &&
    warmSend.includes('deepseekPermissionMode: next.deepseekPermissionMode') &&
    warmSend.includes("'deepseekReasoningEffort'") &&
    warmSend.includes('deepseekReasoningEffort: next.deepseekReasoningEffort'),
  'warm-send envelope must carry DeepSeek runtime options unconditionally'
);

const sessionStore = read('src/electron/libs/session-store.ts');
assert.ok(
  sessionStore.includes('deepseek_session_id TEXT') &&
    sessionStore.includes("ensureColumn('sessions', 'deepseek_session_id', 'TEXT')") &&
    sessionStore.includes('updateDeepseekSessionId') &&
    sessionStore.includes("'deepseek_local'"),
  'session store must persist deepseek session ids and source origin'
);
assert.ok(
  sessionStore.includes("provider === 'deepseek'") &&
    sessionStore.includes('official DeepSeek API list prices') &&
    sessionStore.includes('peak/off-peak schedule') &&
    sessionStore.includes("result.usageAccounting !== 'deepseek-step-last-wins-v1'"),
  'DeepSeek Usage settings must label estimates and repair legacy doubled usage'
);
assert.ok(
  sessionStore.includes("deepseek_agent_preset TEXT DEFAULT 'standard'") &&
    sessionStore.includes("ensureColumn('sessions', 'deepseek_agent_preset'") &&
    sessionStore.includes('normalizeDeepseekAgentPreset(params.deepseekAgentPreset)'),
  'session store must persist and normalize the DeepSeek agent preset'
);

// Pricing is based on disjoint Harness buckets: uncached input, cache hits,
// and output. reasoningTokens is already included in outputTokens.
{
  const {
    estimateDeepseekUsageCost,
    isDeepseekPeakPeriod,
  } = require('../dist-electron/electron/libs/deepseek-pricing.js');
  const usage = {
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 500_000,
  };
  const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12);

  closeTo(
    estimateDeepseekUsageCost('deepseek-v4-flash', usage, Date.parse('2026-08-14T12:00:00Z')),
    0.4228
  );
  closeTo(
    estimateDeepseekUsageCost('deepseek-v4-pro', usage, Date.parse('2026-08-14T12:00:00Z')),
    1.308625
  );
  assert.equal(isDeepseekPeakPeriod(Date.parse('2026-08-17T00:59:59Z')), false);
  assert.equal(isDeepseekPeakPeriod(Date.parse('2026-08-17T01:00:00Z')), true);
  assert.equal(isDeepseekPeakPeriod(Date.parse('2026-08-17T04:00:00Z')), false);
  assert.equal(isDeepseekPeakPeriod(Date.parse('2026-08-17T06:00:00Z')), true);
  assert.equal(isDeepseekPeakPeriod(Date.parse('2026-08-17T10:00:00Z')), false);
  closeTo(
    estimateDeepseekUsageCost('deepseek-v4-flash', usage, Date.parse('2026-08-17T02:00:00Z')),
    1.774
  );
  closeTo(
    estimateDeepseekUsageCost('deepseek-v4-flash', usage, Date.parse('2026-08-17T05:00:00Z')),
    0.887
  );
  closeTo(
    estimateDeepseekUsageCost('deepseek-v4-pro', usage, Date.parse('2026-08-17T02:00:00Z')),
    5.324
  );
  closeTo(
    estimateDeepseekUsageCost('deepseek-v4-pro', usage, Date.parse('2026-08-17T05:00:00Z')),
    2.662
  );
  assert.equal(estimateDeepseekUsageCost('unknown-model', usage), 0);
}

// rc.6 publishes the same per-step usage on the streaming usage chunk and
// the committed assistant message. Exercise the adapter's last-wins fold so
// Settings and billing receive one sample, not two.
{
  const { DeepseekSdkAdapter } = require('../dist-electron/electron/libs/provider/deepseek-sdk-adapter.js');
  const adapterInstance = new DeepseekSdkAdapter();
  const emitted = [];
  adapterInstance.events.on('event', (event) => emitted.push(event));
  let active;
  const notify = (type, data) => adapterInstance.handleNotification(active, {
    method: 'session.event',
    params: {
      sessionId: 'provider-session',
      event: { type, data },
    },
  });
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, reasoningTokens: 7 };
  active = {
    threadId: 'thread-cost',
    providerSessionId: 'provider-session',
    status: 'running',
    cwd: '/tmp',
    model: 'deepseek-v4-flash',
    permissionMode: 'workspace-write',
    reasoningEffort: 'max',
    harness: {},
    subscription: { close() {} },
    session: {
      id: 'provider-session',
      async run() {
        notify('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage } });
        notify('assistant/message', { turn: 1, step: 1, message: { content: [] }, usage });
        notify('turn/end', { reason: { kind: 'completed' } });
        return {};
      },
    },
  };
  adapterInstance.sessions.set(active.threadId, active);
  await adapterInstance.sendTurn({ threadId: active.threadId, prompt: 'hello' });
  const resultEvent = emitted.find(
    (event) => event.type === 'message' && event.message?.type === 'result'
  );
  assert.ok(resultEvent, 'adapter must emit a result carrying priced usage');
  assert.deepEqual(resultEvent.message.usage, {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 5,
    reasoning_output_tokens: 7,
  });
  assert.ok(resultEvent.message.total_cost_usd > 0, 'known DeepSeek models must emit a positive cost');
}

const ipc = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipc.includes("'get-deepseek-model-config'") &&
    ipc.includes('updateDeepseekSessionId') &&
    ipc.includes('formatDeepseekRuntimeBlockingMessage') &&
    ipc.includes('selectedDeepseekPermissionMode') &&
    ipc.includes('nextDeepseekPermissionMode') &&
    ipc.includes('deepseekPermissionModeChanged') &&
    ipc.includes('selectedDeepseekReasoningEffort') &&
    ipc.includes('nextDeepseekReasoningEffort') &&
    ipc.includes('deepseekReasoningEffortChanged'),
  'ipc-handlers must wire model config, init persistence, runtime gates and config-drift plumbing'
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
const slashSkills = read('src/ui/hooks/useProviderSlashSkills.ts');
const capabilityMenu = read('src/ui/hooks/useClaudeSkillAutocomplete.ts');
assert.ok(
  preload.includes("ipcRenderer.invoke('deepseek-list-skills'") &&
    typesDts.includes('listDeepseekSkills') &&
    ipc.includes("ipcMainHandle('deepseek-list-skills'") &&
    slashSkills.includes("'deepseek'") &&
    slashSkills.includes('window.electron.listDeepseekSkills') &&
    capabilityMenu.includes("provider === 'deepseek'"),
  'DeepSeek skill discovery must reach the shared slash menu through preload and IPC'
);

// Exercise the catalog mirror against the same project/user precedence and
// user-invocable policy used by dsh-skill-filesystem.
{
  const { listDeepseekSkills } = require('../dist-electron/electron/libs/deepseek-skills.js');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deepseek-skills-'));
  const project = path.join(tempRoot, 'project');
  const nestedCwd = path.join(project, 'packages', 'app');
  const dshHome = path.join(tempRoot, 'dsh-home');
  const agentsHome = path.join(tempRoot, 'agents-home');
  const writeSkill = (rootPath, directory, frontmatter) => {
    const skillDir = path.join(rootPath, directory);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\nInstructions.\n`);
  };
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(nestedCwd, { recursive: true });
  writeSkill(
    path.join(project, '.agents', 'skills'),
    'project-version',
    'name: shared-skill\ndescription: project wins'
  );
  writeSkill(
    path.join(agentsHome, 'skills'),
    'user-version',
    'name: shared-skill\ndescription: user loses'
  );
  writeSkill(
    path.join(dshHome, 'skills'),
    'model-only',
    'name: model-only\ndescription: hidden from slash\nuser-invocable: false'
  );

  const previousDshHome = process.env.DSH_HOME;
  const previousAgentsHome = process.env.DSH_AGENTS_HOME;
  process.env.DSH_HOME = dshHome;
  process.env.DSH_AGENTS_HOME = agentsHome;
  try {
    const skills = listDeepseekSkills(nestedCwd);
    assert.deepEqual(skills.map((skill) => skill.name), ['shared-skill']);
    assert.equal(skills[0].description, 'project wins');
    assert.equal(skills[0].scope, 'project-agents');
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME;
    else process.env.DSH_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

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
assert.ok(
  usage.includes('estimatedCost={estimatedCost}') && !usage.includes('activeReport!.note'),
  'Usage settings must mark estimated costs without rendering an explanatory note row'
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

// ── Composer reasoning picker ──────────────────────────────────────────────
const composerControls = read('src/ui/components/ComposerAgentControls.tsx');
const reasoningUtil = read('src/ui/utils/deepseek-reasoning.ts');
assert.ok(
  reasoningUtil.includes("'off'") &&
    reasoningUtil.includes("'high'") &&
    reasoningUtil.includes("'max'") &&
    reasoningUtil.includes("DEFAULT_DEEPSEEK_REASONING_EFFORT: DeepseekReasoningEffort = 'max'") &&
    composerSelection.includes('loadPreferredDeepseekReasoningEffort') &&
    composerSelection.includes('setDeepseekReasoningEffort') &&
    composerControls.includes('DeepseekAgentSubContent') &&
    composerControls.includes('DEEPSEEK_REASONING_EFFORT_OPTIONS') &&
    promptInput.includes('agentSelection.deepseekReasoningEffort') &&
    newSession.includes('agentSelection.deepseekReasoningEffort'),
  'composer must offer off/high/max and send the persisted DeepSeek reasoning preference'
);
assert.ok(
  adapter.includes('normalizeDeepseekReasoningEffort') &&
    adapter.includes('buildDeepseekEnv({ cwd, permissionMode, agentPreset, reasoningEffort })') &&
    ipc.includes('(!deepseekMidTurn && deepseekReasoningEffortChanged)'),
  'DeepSeek reasoning changes must reach the runtime env and respawn outside an in-flight turn'
);

// ── Agent preset picker and fixed-session semantics ────────────────────────
const presetPicker = read('src/ui/components/DeepseekAgentPresetPicker.tsx');
const presetUtil = read('src/ui/utils/deepseek-agent-preset.ts');
assert.ok(
  presetPicker.includes("value: 'standard'") &&
    presetPicker.includes("value: 'code'") &&
    presetPicker.includes("value: 'minimal'") &&
    presetPicker.includes("value: 'cordis'") &&
    presetPicker.includes("label: 'PTC'") &&
    presetPicker.includes("label: 'Creator'") &&
    presetPicker.includes('readOnly') &&
    presetUtil.includes('cowork.preferredDeepseekAgentPreset'),
  'composer must expose all four presets and make the existing-session picker read-only'
);
assert.ok(
  composerSelection.includes('loadPreferredDeepseekAgentPreset') &&
    composerSelection.includes('setDeepseekAgentPreset') &&
    promptInput.includes('deepseekAgentPreset:') &&
    promptInput.includes('readOnly={!activeSession?.isDraft}') &&
    newSession.includes('agentSelection.deepseekAgentPreset') &&
    appStore.includes('deepseekAgentPreset: session.deepseekAgentPreset'),
  'preset selection must reach new-session IPC and round-trip through renderer session state'
);
assert.ok(
  adapter.includes('normalizeDeepseekAgentPreset(input.deepseekAgentPreset)') &&
    adapter.includes('buildDeepseekEnv({ cwd, permissionMode, agentPreset, reasoningEffort })') &&
    ipc.includes('normalizeDeepseekAgentPreset(session.deepseek_agent_preset)') &&
    ipc.includes('deepseekAgentPreset: normalizedDeepseekAgentPreset'),
  'adapter must launch the stored preset and resume with the persisted session binding'
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
