#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-theme-variables-'));
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
    'src/types.d.ts',
    'scripts/tests/theme-variables.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);

if (compile.status !== 0) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}

const run = spawnSync(
  process.execPath,
  [path.join(tmpDir, 'scripts/tests/theme-variables.test.js')],
  { cwd: root, stdio: 'inherit' }
);

fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(run.status ?? 1);
