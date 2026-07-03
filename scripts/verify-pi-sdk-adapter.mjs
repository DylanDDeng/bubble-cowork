#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const packageJson = JSON.parse(read('package.json'));
assert.ok(
  packageJson.dependencies?.['@earendil-works/pi-coding-agent'],
  'package.json must depend on @earendil-works/pi-coding-agent'
);

const loader = read('src/electron/libs/provider/pi-sdk-loader.ts');
assert.ok(
  loader.includes("return import(specifier)") &&
    loader.includes('@earendil-works/pi-coding-agent') &&
    loader.includes('createAgentSession') &&
    loader.includes('SessionManager') &&
    loader.includes('markAsUncloneable'),
  'Pi SDK loader must dynamically import the SDK and expose session APIs'
);

const adapter = read('src/electron/libs/provider/pi-sdk-adapter.ts');
assert.ok(
  adapter.includes("readonly provider: ProviderKind = 'pi'") &&
    adapter.includes("tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']"),
  'Pi adapter must register provider=pi and pass the SDK tool allowlist'
);
assert.ok(
  adapter.includes('SessionManager.list(cwd)') &&
    adapter.includes('SessionManager.open(match.path'),
  'Pi sessions must be resumable through stored Pi session ids'
);
assert.ok(
  adapter.includes("message.role !== 'assistant'") &&
    adapter.includes("type: 'stream_event'") &&
    adapter.includes("type: 'tool_use'") &&
    adapter.includes("type: 'tool_result'") &&
    adapter.includes("type: 'result'"),
  'Pi adapter must filter user echo and emit unified stream/tool/result messages'
);
assert.ok(
  adapter.includes('buildPromptImages') &&
    adapter.includes("mimeType: attachment.mimeType || 'image/png'"),
  'Pi adapter must pass image attachments to session.prompt images'
);
assert.ok(
  adapter.includes('usageFromPi') &&
    adapter.includes('context_window') &&
    adapter.includes('total_tokens') &&
    adapter.includes('handleSessionError') &&
    adapter.includes("emitResult(session, 'error')"),
  'Pi adapter must map SDK usage into unified token usage metadata'
);

const agentLoop = read('src/electron/libs/agent-loop.ts');
assert.ok(
  agentLoop.includes('PiSdkAdapter') &&
    agentLoop.includes('service.registerAdapter(new PiSdkAdapter())'),
  'agent-loop must register the Pi SDK adapter'
);

const providerTypes = read('src/electron/libs/provider/types.ts');
const sharedTypes = read('src/shared/types.ts');
assert.ok(
  providerTypes.includes("'pi'") &&
    sharedTypes.includes("'pi_local'") &&
    sharedTypes.includes("AgentProvider = 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'pi'"),
  'provider/shared types must include Pi'
);

const sessionStore = read('src/electron/libs/session-store.ts');
assert.ok(
  sessionStore.includes('pi_session_id TEXT') &&
    sessionStore.includes("ensureColumn('sessions', 'pi_session_id', 'TEXT')") &&
    sessionStore.includes('updatePiSessionId') &&
    sessionStore.includes("'pi_local'"),
  'session-store must persist Pi session ids and source origin'
);

const ipcHandlers = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipcHandlers.includes("if (provider === 'pi') return 'Pi'") &&
    ipcHandlers.includes('pi_session_id') &&
    ipcHandlers.includes('sessions.updatePiSessionId'),
  'IPC handlers must label, resume, and persist Pi sessions'
);

const providerUtils = read('src/ui/utils/provider.ts');
const composerSelection = read('src/ui/hooks/useComposerAgentSelection.ts');
assert.ok(
  providerUtils.includes("{ id: 'pi', label: 'Pi' }") &&
    providerUtils.includes("raw === 'pi'") &&
    composerSelection.includes("key: 'pi:default'") &&
    composerSelection.includes('Use Pi default model'),
  'Composer provider/model selection must expose Pi with a default model option'
);

const readiness = read('src/ui/hooks/useAgentReadiness.ts');
assert.ok(
  readiness.includes("provider: 'pi'") &&
    readiness.includes('getAgentRuntimeDirectory'),
  'Agent readiness must include Pi via the unified runtime directory'
);

const runtimeDirectory = read('src/electron/libs/agent-runtime-directory.ts');
assert.ok(
  runtimeDirectory.includes("entry('pi', 'ready'") &&
    runtimeDirectory.includes('bundled') &&
    runtimeDirectory.includes('auth.json'),
  'Runtime directory must treat Pi as bundled and check its credentials'
);

const logo = read('src/ui/components/PiLogo.tsx');
const controls = read('src/ui/components/ComposerAgentControls.tsx');
const piLogoAsset = read('src/ui/assets/pi-logo-auto.svg');
assert.ok(
  logo.includes("pi-logo-auto.svg") &&
    piLogoAsset.includes('viewBox="0 0 800 800"') &&
    controls.includes('PiLogo'),
  'UI must include the official Pi SVG logo in provider controls'
);

const promptInput = read('src/ui/components/PromptInput.tsx');
const contextUsage = read('src/ui/utils/context-usage.ts');
const openCodeIndicator = read('src/ui/components/OpenCodeContextIndicator.tsx');
assert.ok(
  promptInput.includes("runtimeProvider === 'pi'") &&
    promptInput.includes("getLatestOpenCodeContextSnapshot(activeSession.messages, piContextModel, 'Pi')") &&
    promptInput.includes('providerLabel="Pi"') &&
    contextUsage.includes("fallbackModelLabel = 'OpenCode'") &&
    openCodeIndicator.includes('providerLabel =') &&
    openCodeIndicator.includes('Latest {providerLabel} usage'),
  'Composer must show Pi token/context usage with Pi-specific copy'
);

console.log('pi-sdk-adapter: wiring checks passed');
