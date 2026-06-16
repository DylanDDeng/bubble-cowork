export interface GitBranchState {
  /** Current branch name, or null when not a git repo / unknown. */
  branch: string | null;
  /** True only when the directory is a git repository with a readable branch. */
  isRepo: boolean;
}

export const EMPTY_GIT_BRANCH_STATE: GitBranchState = { branch: null, isRepo: false };

/**
 * Pure mapping from the `get-git-branch` IPC result to the UI state. A
 * directory is treated as a repo only when the call succeeded and returned a
 * non-empty branch name. Kept dependency-free so it can be unit-tested.
 */
export function resolveGitBranchState(
  result: { ok: boolean; branch: string | null; message?: string } | null | undefined
): GitBranchState {
  if (result?.ok && typeof result.branch === 'string' && result.branch.trim()) {
    return { branch: result.branch.trim(), isRepo: true };
  }
  return EMPTY_GIT_BRANCH_STATE;
}
