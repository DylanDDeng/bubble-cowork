#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-subagent-workstream-'));

// The runner must forward the SDK's parent_tool_use_id so the UI can nest
// subagent activity under its Task row instead of splicing it inline.
const runnerSource = fs.readFileSync(
  path.join(root, 'src', 'electron', 'libs', 'runner.ts'),
  'utf8'
);
assert.equal(
  (runnerSource.match(/parentToolUseId: getParentToolUseId\(message\)/g) || []).length >= 3,
  true,
  'runner.ts must forward parent_tool_use_id on assistant, user, and stream_event messages'
);

// Subagent stream deltas must never touch the top-level streaming buffer.
const storeSource = fs.readFileSync(
  path.join(root, 'src', 'ui', 'store', 'useAppStore.ts'),
  'utf8'
);
assert.equal(
  storeSource.includes("message.type === 'stream_event' && message.parentToolUseId"),
  true,
  'useAppStore.ts must drop subagent stream events before they reach the streaming buffer'
);

// The workstream must render Task calls through the subagent lane/board UI.
const workstreamComponent = fs.readFileSync(
  path.join(root, 'src', 'ui', 'components', 'AssistantWorkstream.tsx'),
  'utf8'
);
assert.equal(
  workstreamComponent.includes('function SubagentBoard'),
  true,
  'AssistantWorkstream.tsx must render parallel Tasks as a subagent board'
);
assert.equal(
  workstreamComponent.includes('subagents in parallel'),
  true,
  'the subagent board header must summarize the parallel run'
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
    'scripts/tests/subagent-workstream.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);

if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

const testPath = path.join(tmpDir, 'scripts', 'tests', 'subagent-workstream.test.js');
const run = spawnSync(process.execPath, [testPath], { cwd: root, stdio: 'inherit' });
fs.rmSync(tmpDir, { recursive: true, force: true });

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}
