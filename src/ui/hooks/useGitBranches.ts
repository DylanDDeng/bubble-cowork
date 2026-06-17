import { useCallback, useEffect, useState } from 'react';
import {
  resolveGitBranchesState,
  EMPTY_GIT_BRANCHES_STATE,
  type GitBranchesState,
} from '../utils/git-branch-state';

export type { GitBranchesState } from '../utils/git-branch-state';

export interface UseGitBranchesResult extends GitBranchesState {
  loading: boolean;
  /** Re-read branches (e.g. after checking out a branch). */
  refresh: () => void;
}

/**
 * Reads the git branches for `cwd`: the current branch, whether it's a repo,
 * and the list of local branches for a picker. `isRepo` is false for non-git
 * folders so callers can hide the branch pill. Re-fetches on `cwd` change or
 * when `refresh()` is called; stale responses are ignored.
 */
export function useGitBranches(cwd: string | null | undefined): UseGitBranchesResult {
  const [state, setState] = useState<GitBranchesState>(EMPTY_GIT_BRANCHES_STATE);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const dir = cwd?.trim();
    if (!dir || !window.electron?.getGitBranches) {
      setState(EMPTY_GIT_BRANCHES_STATE);
      return;
    }

    let cancelled = false;
    setLoading(true);
    window.electron
      .getGitBranches(dir)
      .then((result) => {
        if (!cancelled) {
          setState(resolveGitBranchesState(result));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState(EMPTY_GIT_BRANCHES_STATE);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, tick]);

  return { ...state, loading, refresh };
}
