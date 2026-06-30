#!/usr/bin/env node
// Compiles + runs the recursive tiling layout-tree unit tests (pure functions:
// split/close coalescing, sizes invariants, duplicate-session vacating, MRU
// focus, never-empty-tree).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-layout-tree-'));
const tscBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);

const compile = spawnSync(
  tscBin,
  [
    '--target', 'ES2022',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict',
    '--outDir', tmpDir,
    'scripts/tests/layout-tree.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);
if (compile.status !== 0) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}

const run = spawnSync(
  process.execPath,
  [path.join(tmpDir, 'scripts', 'tests', 'layout-tree.test.js')],
  { cwd: root, stdio: 'inherit' }
);
fs.rmSync(tmpDir, { recursive: true, force: true });
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

console.log('layout-tree: checks passed');
