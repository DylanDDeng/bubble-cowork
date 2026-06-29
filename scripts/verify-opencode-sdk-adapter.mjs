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
    openCodeIndicator.includes('Waiting for OpenCode usage from this model.'),
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
  'src/ui/components/ProvidersRuntimeStatusPanel.tsx',
  'src/ui/components/settings/CompatibleProviderSettings.tsx',
  'src/electron/ipc-handlers.ts',
]) {
  const source = read(file);
  assert.ok(!source.includes('OpenCode ACP'), `${file} must not show OpenCode ACP copy`);
}

console.log('opencode-sdk-adapter: wiring checks passed');
