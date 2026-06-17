/** Minimal structural shape of a branch entry from the `get-git-branches` IPC. */
export interface GitBranchEntryLike {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitBranchesState {
  /** Current branch name, or null when not a git repo / unknown. */
  current: string | null;
  /** True only when the directory is a git repository. */
  isRepo: boolean;
  /** Local branches (remotes filtered out) for the branch picker. */
  localBranches: GitBranchEntryLike[];
}

export const EMPTY_GIT_BRANCHES_STATE: GitBranchesState = {
  current: null,
  isRepo: false,
  localBranches: [],
};

/**
 * Pure mapping from the `get-git-branches` IPC result to the UI state. The pill
 * is a repo only when the call succeeded; the current branch is the entry
 * flagged `current`, and the picker lists local branches (remotes filtered out).
 * Kept dependency-free so it can be unit-tested.
 */
export function resolveGitBranchesState(
  result: { ok: boolean; entries?: GitBranchEntryLike[] } | null | undefined
): GitBranchesState {
  if (result?.ok && Array.isArray(result.entries)) {
    const localBranches = result.entries.filter((entry) => !entry.remote);
    const current = result.entries.find((entry) => entry.current)?.name ?? null;
    return { current, isRepo: true, localBranches };
  }
  return EMPTY_GIT_BRANCHES_STATE;
}
