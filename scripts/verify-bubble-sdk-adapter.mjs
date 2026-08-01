#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const packageJson = JSON.parse(read('package.json'));
assert.ok(
  packageJson.dependencies?.['@bubblebrain-ai/bubble'],
  'package.json must depend on @bubblebrain-ai/bubble'
);

const loader = read('src/electron/libs/provider/bubble-sdk-loader.ts');
assert.ok(
  loader.includes('return import(specifier)') &&
    loader.includes('@bubblebrain-ai/bubble') &&
    loader.includes('runTurn') &&
    loader.includes('createSession') &&
    loader.includes('listSessions') &&
    loader.includes('getModelConfig') &&
    loader.includes('resolveBubbleHome'),
  'Bubble SDK loader must dynamically import the ESM SDK and expose the facade surface'
);
assert.ok(
  loader.includes('getBubbleSdk') && loader.includes('sdkInstance'),
  'Bubble SDK loader must expose a process-wide BubbleSdk singleton'
);

const adapter = read('src/electron/libs/provider/bubble-sdk-adapter.ts');
assert.ok(
  adapter.includes("readonly provider: ProviderKind = 'bubble'") &&
    adapter.includes('getBubbleSdk') &&
    adapter.includes('runTurn'),
  'Bubble adapter must register provider=bubble and drive turns through sdk.runTurn'
);
assert.ok(
  adapter.includes('resolveSessionId') &&
    adapter.includes('sdk.listSessions()') &&
    adapter.includes('sdk.createSession({ cwd })'),
  'Bubble sessions must resume through the SDK on-disk index (lazy persistence tolerated)'
);
assert.ok(
  adapter.includes("type: 'stream_event'") &&
    adapter.includes("type: 'tool_use'") &&
    adapter.includes("type: 'tool_result'") &&
    adapter.includes("type: 'result'") &&
    adapter.includes('thinking_delta') &&
    adapter.includes('text_delta'),
  'Bubble adapter must emit unified stream/tool/result messages'
);
assert.ok(
  adapter.includes('onApproval') &&
    adapter.includes('onQuestion') &&
    adapter.includes('onPlanApproval') &&
    adapter.includes("type: 'permission_request'") &&
    adapter.includes("toolName: 'AskUserQuestion'") &&
    adapter.includes("toolName: 'ExitPlanMode'") &&
    adapter.includes('permission_dismissed'),
  'Bubble adapter must map approval/question/plan callbacks to permission requests'
);
assert.ok(
  adapter.includes('buildPromptParts') &&
    adapter.includes("type: 'image_url'") &&
    adapter.includes('base64'),
  'Bubble adapter must inline image attachments as data-URL content parts'
);
assert.ok(
  adapter.includes('usageFromBubble') &&
    adapter.includes('promptTokens') &&
    adapter.includes('completionTokens') &&
    adapter.includes('total_tokens') &&
    adapter.includes("emitResult(session, 'error')"),
  'Bubble adapter must map SDK usage into unified token usage metadata'
);
assert.ok(
  adapter.includes('sdk.stop(session.providerSessionId)') &&
    adapter.includes('abortController?.abort()'),
  'Bubble adapter must stop turns through sdk.stop + abort signal'
);

assert.ok(
  adapter.includes('bubblePermissionMode') &&
    adapter.includes('session.permissionMode ? { mode: session.permissionMode }') &&
    adapter.includes("selectedAnswer === 'Approve and execute'"),
  'Bubble adapter must pass the permission mode into runTurn and gate plan exit on the approve answer'
);

const permissionUtil = read('src/ui/utils/bubble-permission.ts');
const permissionPicker = read('src/ui/components/BubblePermissionModePicker.tsx');
const warmSend = read('src/electron/libs/warm-send-options.ts');
assert.ok(
  permissionUtil.includes('cowork.preferredBubblePermissionMode') &&
    permissionPicker.includes("'bypassPermissions'") &&
    permissionPicker.includes('FullAccessPermissionIcon') &&
    warmSend.includes("'bubblePermissionMode'") &&
    warmSend.includes('bubblePermissionMode: next.bubblePermissionMode'),
  'Bubble permission mode must have a picker, a stored preference, and warm-send coverage'
);
// Plan is Claude-style: /plan + pill, not a picker menu entry, and the agent's
// own mid-turn mode switch flows back so the pill exits after plan approval.
const slashDefs = read('src/ui/utils/claude-slash.ts');
const promptInputSrc = read('src/ui/components/PromptInput.tsx');
const agentLoopSrc = read('src/electron/libs/agent-loop.ts');
assert.ok(
  !/'default',\s*\n\s*'plan'/.test(permissionPicker) &&
    permissionUtil.includes("value === 'bypassPermissions' ? value : 'default'") &&
    slashDefs.includes('BUBBLE_COMMAND_DEFINITIONS') &&
    promptInputSrc.includes("agentSelection.provider === 'bubble' && agentSelection.bubbleExecutionMode === 'plan'") &&
    adapter.includes("type: 'permission_mode_changed'") &&
    agentLoopSrc.includes('onBubblePermissionModeChange'),
  'Bubble plan mode must use /plan + pill with the mode-change feedback chain'
);

// Slash-invocable skills: bubble follows the qoder text-only pattern — a
// dedicated list IPC plus the three renderer whitelists and the '/' insertion.
const slashSkillsHook = read('src/ui/hooks/useProviderSlashSkills.ts');
const autocompleteHook = read('src/ui/hooks/useClaudeSkillAutocomplete.ts');
const preload = read('src/electron/preload.cts');
assert.ok(
  read('src/electron/ipc-handlers.ts').includes("ipcMainHandle('bubble-list-skills'") &&
    preload.includes('listBubbleSkills') &&
    slashSkillsHook.includes("provider === 'bubble'") &&
    slashSkillsHook.includes('listBubbleSkills') &&
    autocompleteHook.split("'bubble'").length >= 5,
  'Bubble skills must be listable over IPC and surfaced in the composer slash menu'
);

const agentLoop = read('src/electron/libs/agent-loop.ts');
assert.ok(
  agentLoop.includes('BubbleSdkAdapter') &&
    agentLoop.includes('service.registerAdapter(new BubbleSdkAdapter())'),
  'agent-loop must register the Bubble SDK adapter'
);

const providerTypes = read('src/electron/libs/provider/types.ts');
const sharedTypes = read('src/shared/types.ts');
assert.ok(
  providerTypes.includes("'bubble'") &&
    sharedTypes.includes("'bubble_local'") &&
    /AgentProvider =[^;]*'bubble'/.test(sharedTypes),
  'provider/shared types must include Bubble'
);

const sessionStore = read('src/electron/libs/session-store.ts');
assert.ok(
  sessionStore.includes('bubble_session_id TEXT') &&
    sessionStore.includes("ensureColumn('sessions', 'bubble_session_id', 'TEXT')") &&
    sessionStore.includes('updateBubbleSessionId') &&
    sessionStore.includes("'bubble_local'"),
  'session-store must persist Bubble session ids and source origin'
);

const ipcHandlers = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipcHandlers.includes("if (provider === 'bubble') return 'Bubble'") &&
    ipcHandlers.includes('bubble_session_id') &&
    ipcHandlers.includes('sessions.updateBubbleSessionId') &&
    ipcHandlers.includes("ipcMainHandle('get-bubble-model-config'"),
  'IPC handlers must label, resume, and persist Bubble sessions and serve the model config'
);

const providerUtils = read('src/ui/utils/provider.ts');
const composerSelection = read('src/ui/hooks/useComposerAgentSelection.ts');
assert.ok(
  providerUtils.includes("{ id: 'bubble', label: 'Bubble' }") &&
    providerUtils.includes("raw === 'bubble'") &&
    composerSelection.includes("key: 'bubble:default'") &&
    composerSelection.includes('Use Bubble default model'),
  'Composer provider/model selection must expose Bubble with a default model option'
);

const readiness = read('src/ui/hooks/useAgentReadiness.ts');
assert.ok(
  readiness.includes("provider: 'bubble'") &&
    readiness.includes('getAgentRuntimeDirectory'),
  'Agent readiness must include Bubble via the unified runtime directory'
);

const runtimeDirectory = read('src/electron/libs/agent-runtime-directory.ts');
assert.ok(
  runtimeDirectory.includes("entry('bubble', 'ready'") &&
    runtimeDirectory.includes('resolveBubbleHome') &&
    runtimeDirectory.includes('config.json'),
  'Runtime directory must treat Bubble as bundled and check its credentials'
);

const logo = read('src/ui/components/BubbleLogo.tsx');
const controls = read('src/ui/components/ComposerAgentControls.tsx');
const bubbleLogoAsset = read('src/ui/assets/bubble-logo-auto.svg');
assert.ok(
  logo.includes('bubble-logo-auto.svg') &&
    bubbleLogoAsset.includes('viewBox="0 0 800 800"') &&
    controls.includes('BubbleLogo'),
  'UI must include the Bubble SVG logo in provider controls'
);

const promptInput = read('src/ui/components/PromptInput.tsx');
assert.ok(
  promptInput.includes("runtimeProvider === 'bubble'") &&
    promptInput.includes("getLatestOpenCodeContextSnapshot(activeSession.messages, bubbleContextModel, 'Bubble')") &&
    promptInput.includes('providerLabel="Bubble"'),
  'Composer must show Bubble token/context usage with Bubble-specific copy'
);

console.log('bubble-sdk-adapter: wiring checks passed');
