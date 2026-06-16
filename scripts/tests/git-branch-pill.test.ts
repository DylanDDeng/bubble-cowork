// Unit test for the git-branch pill's pure mapping: the branch pill must show
// only for real git repositories and reflect the actual branch name.
import assert from 'node:assert/strict';
import { resolveGitBranchState } from '../../src/ui/utils/git-branch-state';

// A real repo on a branch.
assert.deepEqual(
  resolveGitBranchState({ ok: true, branch: 'main' }),
  { branch: 'main', isRepo: true },
  'a branch from a git repo should be shown'
);

// Real branch name other than main is preserved verbatim (no hardcoding).
assert.deepEqual(
  resolveGitBranchState({ ok: true, branch: 'feature/pickers' }),
  { branch: 'feature/pickers', isRepo: true },
  'the actual branch name must be preserved'
);

// Detached HEAD — the IPC returns "HEAD"; still a repo.
assert.deepEqual(
  resolveGitBranchState({ ok: true, branch: 'HEAD' }),
  { branch: 'HEAD', isRepo: true },
  'detached HEAD is still a repo'
);

// Not a git repo — the call fails; the pill must be hidden.
assert.deepEqual(
  resolveGitBranchState({ ok: false, branch: null, message: 'not a git repository' }),
  { branch: null, isRepo: false },
  'a non-repo folder must not show a branch'
);

// Defensive: ok but empty/whitespace branch → treated as no repo.
assert.deepEqual(
  resolveGitBranchState({ ok: true, branch: '   ' }),
  { branch: null, isRepo: false },
  'empty branch is not a usable branch'
);
assert.deepEqual(
  resolveGitBranchState(null),
  { branch: null, isRepo: false },
  'null result is handled'
);

console.log('git-branch-pill: all cases passed');
