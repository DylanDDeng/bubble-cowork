#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-composer-agent-selection-'));

const controls = read('src/ui/components/ComposerAgentControls.tsx');
assert.ok(
  controls.includes('onModelChange(option, provider);') &&
    controls.includes('key: `codex:${codexModel.name}`') &&
    !controls.includes('onCodexReasoningEffortChange={(effort) => {\n                          onAgentChange(provider);') &&
    !controls.includes('onClaudeReasoningEffortChange={(effort) => {\n                          onAgentChange(provider);') &&
    !controls.includes('onGrokReasoningEffortChange={(effort) => {\n                          onAgentChange(provider);'),
  'model options must remain provider-scoped and per-model controls must not split one click into two state updates'
);
assert.ok(
  controls.includes("const fullModelLabelTriggerClassName = 'w-max max-w-none shrink-0 whitespace-nowrap';") &&
    (controls.match(/className=\{`\$\{triggerClassName\} \$\{fullModelLabelTriggerClassName\}`\}/g) ?? []).length === 2 &&
    controls.includes('<span className="whitespace-nowrap">{modelLabel}{effortSuffix}</span>') &&
    !controls.includes('<span className="min-w-0 truncate">{modelLabel}{effortSuffix}</span>'),
  'composer model triggers must reserve their full content width without truncating the reasoning label'
);

const hook = read('src/ui/hooks/useComposerAgentSelection.ts');
assert.ok(
  hook.includes('targetProvider: AgentProvider = provider') &&
    hook.includes('input?.onSelectionChange?.(nextSelection)') &&
    hook.includes('option.key.startsWith(`${targetProvider}:`)') &&
    hook.includes('isGrokModelId') &&
    hook.includes('savePreferredGrokModel(confirmedModel)') &&
    hook.includes('const selectAgentConfiguration = useCallback(') &&
    hook.includes('savePreferredCodexReasoningEffort(nextModel, change.codexReasoningEffort)') &&
    hook.includes('input?.codexReasoningEffort'),
  'model selection must be atomic, target-model scoped, restorable, and reject foreign provider values'
);

const ipcHandlers = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipcHandlers.includes('normalizeProviderModel(chosenProvider, model)') &&
    ipcHandlers.includes("normalizeProviderModel('grok', payload.model ?? session.model ?? undefined)") &&
    ipcHandlers.includes('model: resolvedModelOverride'),
  'the main process must reject foreign models before starting or prewarming Grok'
);

const promptInput = read('src/ui/components/PromptInput.tsx');
assert.ok(
  promptInput.includes('handoffSessionToProvider,\n    setSessionAgentSelection,') &&
  promptInput.includes('onSelectionChange: handleSessionAgentSelectionChange') &&
    promptInput.includes('setSessionAgentSelection(activeSession.id, selection)') &&
    promptInput.includes('onModelChange={handleModelChange}') &&
    (promptInput.match(/codexReasoningEffort:/g) ?? []).length >= 3 &&
    (promptInput.match(/codexFastMode:/g) ?? []).length >= 3 &&
    promptInput.includes("handleAgentConfigurationChange({ provider: 'codex', codexReasoningEffort: effort })") &&
    promptInput.includes('change.provider !== activeSession.provider'),
  'PromptInput must persist atomic picker changes and send Codex effort/speed on start and continue'
);

const newSessionView = read('src/ui/components/NewSessionView.tsx');
assert.ok(
  newSessionView.includes('codexReasoningEffort:') &&
    newSessionView.includes('codexFastMode:') &&
    newSessionView.includes("selectAgentConfiguration({ provider: 'codex', codexReasoningEffort: effort })"),
  'NewSessionView must send the exact Codex effort/speed selected in the composer'
);

const tscBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);
const compile = spawnSync(
  tscBin,
  [
    '--target',
    'ES2022',
    '--module',
    'CommonJS',
    '--moduleResolution',
    'Node',
    '--jsx',
    'react-jsx',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict',
    '--noEmitOnError',
    'true',
    '--outDir',
    tmpDir,
    'scripts/tests/composer-agent-selection-session-switch.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);

if (compile.status !== 0) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}

const testPath = path.join(
  tmpDir,
  'scripts',
  'tests',
  'composer-agent-selection-session-switch.test.js'
);
const run = spawnSync(process.execPath, [testPath], { cwd: root, stdio: 'inherit' });
fs.rmSync(tmpDir, { recursive: true, force: true });

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}
