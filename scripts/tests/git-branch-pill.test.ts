// Unit test for the git-branch pill's pure mapping: the branch pill shows only
// for real git repositories, reflects the actual current branch, and exposes
// the local branches (remotes filtered out) for the switch dropdown.
import assert from 'node:assert/strict';
import { resolveGitBranchesState } from '../../src/ui/utils/git-branch-state';

function entry(name: string, current = false, remote = false) {
  return { name, current, remote };
}

// A real repo: current branch detected, local branches listed, remotes dropped.
{
  const state = resolveGitBranchesState({
    ok: true,
    entries: [
      entry('master', true),
      entry('feature/pickers'),
      entry('origin/master', false, true),
    ],
  });
  assert.equal(state.isRepo, true, 'a git repo is a repo');
  assert.equal(state.current, 'master', 'the current branch is detected, not hardcoded');
  assert.deepEqual(
    state.localBranches.map((b) => b.name),
    ['master', 'feature/pickers'],
    'local branches are listed and remotes are filtered out'
  );
}

// The actual current branch name is preserved (not assumed to be main/master).
{
  const state = resolveGitBranchesState({
    ok: true,
    entries: [entry('develop'), entry('release/v2', true)],
  });
  assert.equal(state.current, 'release/v2', 'current branch reflects the real HEAD');
  assert.equal(state.localBranches.length, 2, 'all local branches are available to pick');
}

// Not a git repo — the call fails; the pill must be hidden.
{
  const state = resolveGitBranchesState({ ok: false, entries: [] });
  assert.deepEqual(state, { current: null, isRepo: false, localBranches: [] });
}

// Defensive: null/garbage result is handled.
assert.deepEqual(
  resolveGitBranchesState(null),
  { current: null, isRepo: false, localBranches: [] },
  'null result is handled'
);

console.log('git-branch-pill: all cases passed');
