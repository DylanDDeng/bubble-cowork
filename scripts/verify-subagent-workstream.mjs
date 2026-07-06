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
assert.equal(
  runnerSource.includes('forwardSubagentText: true'),
  true,
  'the SDK forwards subagent text/thinking only when forwardSubagentText is set — without it the nested traces show tool rows only'
);

// Backend consumers that treat assistant messages as top-level replies must
// skip subagent-attributed messages.
const ipcSourceForGuards = fs.readFileSync(
  path.join(root, 'src', 'electron', 'ipc-handlers.ts'),
  'utf8'
);
assert.equal(
  ipcSourceForGuards.includes('shouldPersistMessage && !attributedMessage.parentToolUseId'),
  true,
  'the feishu bridge must not receive subagent internal messages'
);
assert.equal(
  (ipcSourceForGuards.match(/if \(message\.parentToolUseId\) continue;/g) || []).length >= 3,
  true,
  'history transcript builders must skip subagent messages'
);
assert.equal(
  ipcSourceForGuards.includes('.filter((message) => !message.parentToolUseId)'),
  true,
  'the environment recap must skip subagent messages'
);
assert.equal(
  ipcSourceForGuards.includes('if (!attributedMessage.parentToolUseId) {'),
  true,
  'subagent narration must not trip local failure detection'
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
assert.equal(
  workstreamComponent.includes("if (entry.type === 'task')"),
  true,
  'EntryRow must route task entries to the subagent lane so nested Task traces stay expandable'
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
