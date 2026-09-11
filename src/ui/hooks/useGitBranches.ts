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

// Heading and footer share the same initial read and immediately reuse known
// project metadata. Each mount still revalidates in the background.
const cache = new Map<string, GitBranchesState>();
const pending = new Map<string, Promise<GitBranchesState>>();
function readBranches(dir: string) {
  const existing = pending.get(dir);
  if (existing) return existing;
  const request = window.electron.getGitBranches(dir)
    .then(resolveGitBranchesState)
    .then((data) => { cache.set(dir, data); return data; })
    .finally(() => { pending.delete(dir); });
  pending.set(dir, request);
  return request;
}

/**
 * Reads the git branches for `cwd`: the current branch, whether it's a repo,
 * and the list of local branches for a picker. `isRepo` is false for non-git
 * folders so callers can hide the branch pill. Re-fetches on `cwd` change or
 * when `refresh()` is called; stale responses are ignored.
 */
export function useGitBranches(cwd: string | null | undefined): UseGitBranchesResult {
  const dir = cwd?.trim() || '';
  const [snapshot, setSnapshot] = useState<{ dir: string; data: GitBranchesState } | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!dir || !window.electron?.getGitBranches) {
      setSnapshot({ dir, data: EMPTY_GIT_BRANCHES_STATE });
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    readBranches(dir)
      .then((data) => {
        if (!cancelled) {
          setSnapshot({ dir, data });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSnapshot({ dir, data: cache.get(dir) ?? EMPTY_GIT_BRANCHES_STATE });
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
  }, [dir, tick]);

  const known = snapshot?.dir === dir ? snapshot.data : cache.get(dir);
  const initialRead = Boolean(dir && typeof window.electron?.getGitBranches === 'function' && !known);
  return { ...(known ?? EMPTY_GIT_BRANCHES_STATE), loading: initialRead || (loading && !known), refresh };
}
