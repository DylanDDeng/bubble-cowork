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
  controls.includes('onModelChange(option, provider);'),
  'the merged picker must forward the model option with its target provider'
);

const hook = read('src/ui/hooks/useComposerAgentSelection.ts');
assert.ok(
  hook.includes('targetProvider: AgentProvider = provider') &&
    hook.includes('input?.onSelectionChange?.({'),
  'model selection must be atomic and report the new controlled value'
);

const promptInput = read('src/ui/components/PromptInput.tsx');
assert.ok(
  promptInput.includes('handoffSessionToProvider,\n    setSessionAgentSelection,') &&
  promptInput.includes('onSelectionChange: handleSessionAgentSelectionChange') &&
    promptInput.includes('setSessionAgentSelection(activeSession.id, selection)') &&
    promptInput.includes('onModelChange={handleModelChange}'),
  'PromptInput must write picker changes back to the current session'
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
