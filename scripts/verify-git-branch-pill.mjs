#!/usr/bin/env node
// Verifies the new-thread context pills: a real (not hardcoded) git branch that
// only shows for git repos, wired into both the first-entry NewSessionView and
// the ChatPane "New Thread" draft landing. Compiles + runs the unit test, then
// does static wiring assertions.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 1. Static wiring checks.
const pills = read('src/ui/components/ComposerContextPills.tsx');
assert.ok(pills.includes('useGitBranches'), 'ComposerContextPills must use the git-branches hook');
assert.ok(
  /isRepo\s*&&\s*branch\s*\?/.test(pills),
  'the branch pill must render only when isRepo && branch'
);
assert.ok(pills.includes('Work locally'), 'the "Work locally" pill must be present');
assert.ok(!/>\s*main\s*</.test(pills), 'the branch must not be hardcoded to "main"');
// The branch pill must be an interactive switcher, not a disabled label.
assert.ok(
  pills.includes('gitCheckoutBranch') && pills.includes('localBranches.map'),
  'the branch pill must list branches and check out the selected one'
);

const hook = read('src/ui/hooks/useGitBranches.ts');
assert.ok(hook.includes('getGitBranches'), 'useGitBranches must call the getGitBranches IPC');
assert.ok(hook.includes('resolveGitBranchesState'), 'useGitBranches must use the pure mapping');

const newSession = read('src/ui/components/NewSessionView.tsx');
assert.ok(
  newSession.includes('<ComposerContextPills'),
  'NewSessionView must render the shared context pills'
);
assert.ok(
  !/>\s*main\s*</.test(newSession),
  'NewSessionView must no longer hardcode the "main" branch'
);

const chatPane = read('src/ui/components/ChatPane.tsx');
assert.ok(
  chatPane.includes('<ComposerContextPills'),
  'the ChatPane new-thread landing must render the context pills'
);

// 2. Compile + run the pure-mapping unit test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-git-branch-pill-'));
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
    '--outDir', tmpDir,
    'scripts/tests/git-branch-pill.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);
if (compile.status !== 0) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}
const run = spawnSync(
  process.execPath,
  [path.join(tmpDir, 'scripts', 'tests', 'git-branch-pill.test.js')],
  { cwd: root, stdio: 'inherit' }
);
fs.rmSync(tmpDir, { recursive: true, force: true });
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

console.log('git-branch-pill: wiring checks passed');
