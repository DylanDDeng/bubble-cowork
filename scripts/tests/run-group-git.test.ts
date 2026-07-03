// Integration tests for the fan-out git plumbing against a real scratch repo:
// - ensureWorktreesExcluded keeps the main working tree's `git status` clean
//   while .worktrees/ exists (review finding 1: without the exclude rule the
//   linked worktree shows up as `?? .worktrees/` forever)
// - createWorktree from a locked base commit, clean/dirty detection, recycling
// Compiled + executed by scripts/verify-run-group.mjs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorktree,
  deleteBranch,
  ensureWorktreesExcluded,
  getHeadCommit,
  hasDirtyWorkingTree,
  removeWorktree,
} from '../../src/electron/libs/git-service';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function main() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-run-group-git-'));
  try {
    git(repo, ['init', '--initial-branch=main']);
    git(repo, ['config', 'user.email', 'test@aegis.local']);
    git(repo, ['config', 'user.name', 'Aegis Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);

    const baseRef = await getHeadCommit(repo);
    assert.match(baseRef, /^[0-9a-f]{40}$/, 'getHeadCommit returns a full sha');

    // --- git hygiene: exclude before the first worktree ---
    await ensureWorktreesExcluded(repo);
    const excludePath = path.join(repo, '.git', 'info', 'exclude');
    const excludeBody = fs.readFileSync(excludePath, 'utf8');
    assert.ok(excludeBody.includes('.worktrees/'), 'exclude rule written');

    // Idempotent: second call must not duplicate the rule.
    await ensureWorktreesExcluded(repo);
    const occurrences = fs
      .readFileSync(excludePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() === '.worktrees/').length;
    assert.equal(occurrences, 1, 'exclude rule written exactly once');

    // --- worktree creation off the locked base sha ---
    const wt1 = await createWorktree({ cwd: repo, branch: baseRef, newBranch: 'aegis/fan/test/1-claude' });
    assert.ok(fs.existsSync(wt1.path), 'worktree directory exists');
    assert.equal(await getHeadCommit(wt1.path), baseRef, 'member starts at base_ref');

    // Main working tree stays clean while the worktree exists (the acceptance
    // criterion from the plan: no `?? .worktrees` entry during a fan-out).
    const status = git(repo, ['status', '--porcelain']);
    assert.equal(status.trim(), '', `main tree clean, got: ${status}`);
    assert.equal(await hasDirtyWorkingTree(repo), false, 'hasDirtyWorkingTree agrees');

    // --- dirty detection inside the member worktree ---
    assert.equal(await hasDirtyWorkingTree(wt1.path), false, 'fresh worktree is clean');
    fs.writeFileSync(path.join(wt1.path, 'agent-output.txt'), 'work\n');
    assert.equal(await hasDirtyWorkingTree(wt1.path), true, 'untracked file counts as dirty');

    // --- recycling: clean worktree removed + branch deleted ---
    const wt2 = await createWorktree({ cwd: repo, branch: baseRef, newBranch: 'aegis/fan/test/2-codex' });
    assert.equal(await hasDirtyWorkingTree(wt2.path), false);
    await removeWorktree({ cwd: repo, path: wt2.path });
    assert.ok(!fs.existsSync(wt2.path), 'clean worktree removed');
    await deleteBranch({ cwd: repo, branch: 'aegis/fan/test/2-codex', force: true });
    const branches = git(repo, ['branch', '--list', 'aegis/fan/test/2-codex']);
    assert.equal(branches.trim(), '', 'member branch deleted');

    // Same-name refusal: creating the same branch twice fails cleanly (fan-out
    // branch names embed the group id so this never happens in practice).
    await assert.rejects(
      createWorktree({ cwd: repo, branch: baseRef, newBranch: 'aegis/fan/test/1-claude' }),
      'duplicate branch is rejected by git'
    );

    console.log('run-group-git: all checks passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

void main();
