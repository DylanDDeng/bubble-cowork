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
assert.ok(!/>\s*main\s*</.test(pills), 'the branch must not be hardcoded to "main"');
// The branch pill must be an interactive switcher, not a disabled label.
assert.ok(
  pills.includes('gitCheckoutBranch') && pills.includes('filteredLocalBranches.map'),
  'the branch pill must list branches and check out the selected one'
);
assert.ok(
  pills.includes('gitCreateBranch') &&
    pills.includes('handleCreateBranch') &&
    pills.includes('createBranchDialogOpen') &&
    pills.includes('Create and checkout new branch') &&
    pills.includes('Create and checkout branch'),
  'the branch pill must open a dialog to create and switch to a new branch'
);
assert.ok(
  pills.includes('branchQuery') && pills.includes('Search branches'),
  'the branch picker must include branch search'
);

const hook = read('src/ui/hooks/useGitBranches.ts');
assert.ok(hook.includes('getGitBranches'), 'useGitBranches must call the getGitBranches IPC');
assert.ok(hook.includes('resolveGitBranchesState'), 'useGitBranches must use the pure mapping');

const dropdownMenu = read('src/ui/components/ui/dropdown-menu.tsx');
assert.ok(
  dropdownMenu.includes('onSelect?:') &&
    dropdownMenu.includes('onSelect?.(event)') &&
    dropdownMenu.includes('preventBaseUIHandler'),
  'DropdownMenu.Item must map Radix-style onSelect to Base UI onClick'
);

const preload = read('src/electron/preload.cts');
assert.ok(preload.includes('gitCreateBranch'), 'preload must expose gitCreateBranch');

const sharedTypes = read('src/shared/types.ts');
assert.ok(sharedTypes.includes('GitCreateBranchInput'), 'shared types must define GitCreateBranchInput');

const ipcHandlers = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipcHandlers.includes("ipcMainHandle('git-create-branch'") &&
    ipcHandlers.includes('getGitBranchMutationBlockMessage'),
  'git-create-branch IPC must create branches with the running-session guard'
);

const gitService = read('src/electron/libs/git-service.ts');
assert.ok(
  gitService.includes("['checkout', '-b', branch]") &&
    gitService.includes("['check-ref-format', '--branch', branch]"),
  'git service must validate, create, and switch to the new branch'
);

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
