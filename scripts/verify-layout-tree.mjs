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

const testFiles = [
  'scripts/tests/layout-tree.test.ts',
  'scripts/tests/layout-adapter.test.ts',
];

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
    ...testFiles,
  ],
  { cwd: root, stdio: 'inherit' }
);
if (compile.status !== 0) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}

for (const file of testFiles) {
  const compiled = path.join(tmpDir, file.replace(/\.ts$/, '.js'));
  const run = spawnSync(process.execPath, [compiled], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(run.status ?? 1);
  }
}
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('layout-tree + layout-adapter: checks passed');
