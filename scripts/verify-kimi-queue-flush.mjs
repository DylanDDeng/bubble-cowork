#!/usr/bin/env node
// F17 (docs/kimi-server-fixes-plan.md): the queue auto-flush must outlive the
// mounted pane. Wiring is asserted statically; the queue-store semantics the
// store-level flusher depends on run as a compiled unit test.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const flusher = read('src/ui/lib/queue-auto-flush.ts');
assert.ok(
  flusher.includes('hasQueueFlushOwner(sessionId)') && flusher.includes('takeAll(sessionId)'),
  'store-level flush must defer to a mounted owner and drain atomically'
);
assert.ok(
  !/model:/.test(flusher),
  'background flush must not carry composer overrides — session-sticky config applies'
);
assert.ok(
  flusher.includes("status === 'completed'") && flusher.includes("=== 'running'"),
  'flush fires only on a running→completed transition'
);

const promptInput = read('src/ui/components/PromptInput.tsx');
assert.ok(
  promptInput.includes('claimQueueFlushOwner(targetSessionId)') &&
    promptInput.includes('releaseQueueFlushOwner(targetSessionId)'),
  'the mounted composer must claim/release flush ownership for its session'
);

const app = read('src/ui/App.tsx');
assert.ok(app.includes('startQueueAutoFlush()'), 'App must start the store-level watcher');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-kimi-queue-flush-'));
const tscBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
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
    'scripts/tests/kimi-queue-flush.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);
if (compile.status !== 0) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}
const run = spawnSync(
  process.execPath,
  [path.join(tmpDir, 'scripts', 'tests', 'kimi-queue-flush.test.js')],
  {
    cwd: root,
    stdio: 'inherit',
    // The compiled tree lives outside the repo — point require() back at it.
    env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
  }
);
fs.rmSync(tmpDir, { recursive: true, force: true });
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}
console.log('verify:kimi-queue-flush OK');
