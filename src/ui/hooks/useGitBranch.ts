import { useEffect, useState } from 'react';
import {
  resolveGitBranchState,
  EMPTY_GIT_BRANCH_STATE,
  type GitBranchState,
} from '../utils/git-branch-state';

export { resolveGitBranchState, type GitBranchState } from '../utils/git-branch-state';

/**
 * Reads the current git branch for `cwd`. Returns `{ branch, isRepo }`, with
 * `isRepo: false` for non-git folders so callers can hide the branch pill.
 * Re-fetches whenever `cwd` changes; stale responses are ignored.
 */
export function useGitBranch(cwd: string | null | undefined): GitBranchState {
  const [state, setState] = useState<GitBranchState>(EMPTY_GIT_BRANCH_STATE);

  useEffect(() => {
    const dir = cwd?.trim();
    if (!dir || !window.electron?.getGitBranch) {
      setState(EMPTY_GIT_BRANCH_STATE);
      return;
    }

    let cancelled = false;
    setState(EMPTY_GIT_BRANCH_STATE);
    window.electron
      .getGitBranch(dir)
      .then((result) => {
        if (!cancelled) {
          setState(resolveGitBranchState(result));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState(EMPTY_GIT_BRANCH_STATE);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return state;
}
