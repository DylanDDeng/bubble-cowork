#!/usr/bin/env node
// Runs the fan-out end-to-end check inside a real Electron main process
// (headless: no window is created). Requires dist-electron to be built
// (`npm run transpile:electron`) and native deps prepared.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
if (!fs.existsSync(path.join(root, 'dist-electron/electron/libs/run-group-service.js'))) {
  console.error('dist-electron missing — run `npm run transpile:electron` first.');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const run = spawnSync(
  './node_modules/.bin/electron',
  ['scripts/e2e/run-group-e2e.cjs'],
  { cwd: root, stdio: 'inherit', env, timeout: 120_000 }
);
process.exit(run.status ?? 1);
