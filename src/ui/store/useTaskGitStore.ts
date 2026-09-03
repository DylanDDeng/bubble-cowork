import { useEffect } from 'react';
import { create } from 'zustand';
import type { PullRequestSummary } from '../../shared/types';
import type { SessionView } from '../types';
import { syncPullRequestEvents, type BoardTask } from './useBoardStore';

/**
 * Git facts for board cards and the task detail rail: which branch a task
 * ran on, what it changed relative to its base, and whether a pull request
 * exists for it. Nothing here is persisted — it is a runtime cache over
 * cheap local git calls plus the (main-process cached) pull-request list.
 *
 * A task that ran in an isolated copy owns its branch, so it also gets a
 * change count against the base. A local run shows the project checkout's
 * current branch (and any PR on it) but no count: those changes belong to
 * the checkout, not to one task.
 */

export interface RepoBrief {
  fullName: string | null;
  defaultBranch: string | null;
  branch: string | null;
  fetchedAt: number;
}

export interface BranchChanges {
  files: number;
  insertions: number;
  deletions: number;
  fetchedAt: number;
}

export interface TaskGitInfo {
  /** Where the branch is checked out: the worktree, or the project itself. */
  cwd: string;
  branch: string;
  /** True when the branch is task-owned (isolated copy). */
  isolated: boolean;
  base: string | null;
  repo: string | null;
  changes: BranchChanges | null;
  pr: PullRequestSummary | null;
}

interface TaskGitStore {
  briefs: Record<string, RepoBrief>;
  changes: Record<string, BranchChanges>;
  prs: PullRequestSummary[];
  prsFetchedAt: number;
  ensureBrief: (projectCwd: string) => void;
  ensureChanges: (cwd: string, base: string, opts?: { force?: boolean }) => void;
  refreshPullRequests: (force?: boolean) => Promise<void>;
  /**
   * Publish the branch if needed and open a pull request for it. Opens the
   * existing PR instead when one is already there.
   */
  createPullRequest: (cwd: string) => Promise<{ ok: boolean; message?: string }>;
}

const BRIEF_TTL_MS = 5 * 60_000;
const CHANGES_TTL_MS = 45_000;
const PR_LIST_TTL_MS = 60_000;

const inflight = new Set<string>();

function syncEvents(state: Pick<TaskGitStore, 'prs' | 'briefs'>): void {
  const briefByProject: Record<string, { repo: string | null; branch: string | null }> = {};
  for (const [cwd, brief] of Object.entries(state.briefs)) {
    briefByProject[cwd] = { repo: brief.fullName, branch: brief.branch };
  }
  syncPullRequestEvents(state.prs, briefByProject);
}

export const useTaskGitStore = create<TaskGitStore>()((set, get) => ({
  briefs: {},
  changes: {},
  prs: [],
  prsFetchedAt: 0,

  ensureBrief: (projectCwd) => {
    const key = `brief:${projectCwd}`;
    const existing = get().briefs[projectCwd];
    // Renderer hot-reloaded against an older main process: no bridge yet.
    if (typeof window.electron.getGitRepoBrief !== 'function') return;
    if (inflight.has(key)) return;
    if (existing && Date.now() - existing.fetchedAt < BRIEF_TTL_MS) return;
    inflight.add(key);
    void window.electron
      .getGitRepoBrief(projectCwd)
      .then((result) => {
        set((state) => ({
          briefs: {
            ...state.briefs,
            [projectCwd]: {
              fullName: result.ok ? result.fullName : null,
              defaultBranch: result.ok ? result.defaultBranch : null,
              branch: result.ok ? result.branch : null,
              fetchedAt: Date.now(),
            },
          },
        }));
        // A brief can disambiguate a PR match that was waiting on the repo.
        syncEvents(get());
      })
      .finally(() => inflight.delete(key));
  },

  ensureChanges: (cwd, base, opts) => {
    const key = `changes:${cwd}`;
    const existing = get().changes[cwd];
    if (typeof window.electron.getGitBranchChanges !== 'function') return;
    if (inflight.has(key)) return;
    if (!opts?.force && existing && Date.now() - existing.fetchedAt < CHANGES_TTL_MS) return;
    inflight.add(key);
    void window.electron
      .getGitBranchChanges(cwd, base)
      .then((result) => {
        if (!result.ok) return;
        set((state) => ({
          changes: {
            ...state.changes,
            [cwd]: {
              files: result.files,
              insertions: result.insertions,
              deletions: result.deletions,
              fetchedAt: Date.now(),
            },
          },
        }));
      })
      .finally(() => inflight.delete(key));
  },

  refreshPullRequests: async (force) => {
    const key = 'prs';
    if (inflight.has(key)) return;
    if (!force && Date.now() - get().prsFetchedAt < PR_LIST_TTL_MS) return;
    inflight.add(key);
    try {
      const result = await window.electron.listPullRequests(force === true);
      // A failed sweep (gh missing, signed out) keeps the previous list.
      if (!result.error || result.prs.length > 0) {
        set({ prs: result.prs, prsFetchedAt: Date.now() });
        syncEvents(get());
      } else {
        set({ prsFetchedAt: Date.now() });
      }
    } catch {
      set({ prsFetchedAt: Date.now() });
    } finally {
      inflight.delete(key);
    }
  },

  createPullRequest: async (cwd) => {
    const overview = await window.electron.getGitOverview(cwd);
    if (!overview.ok || !overview.hasRepo) {
      return { ok: false, message: 'Git state is not available for this task.' };
    }
    if (!overview.isGitHubRemote) {
      return { ok: false, message: 'Pull requests require a GitHub origin.' };
    }
    if (overview.pr?.url) {
      await window.electron.openExternalUrl(overview.pr.url);
      await get().refreshPullRequests(true);
      return { ok: true };
    }
    if (overview.totalChanges > 0) {
      return {
        ok: false,
        message: 'This branch has uncommitted changes. Commit them in the session first.',
      };
    }
    if (!overview.hasUpstream || overview.aheadCount > 0) {
      const pushed = await window.electron.gitPush(cwd);
      if (!pushed.ok) {
        return { ok: false, message: pushed.message || 'Could not push the branch.' };
      }
    }
    const created = await window.electron.gitCreatePr(cwd);
    if (!created.ok || !created.url) {
      return { ok: false, message: created.message || 'Could not create the pull request.' };
    }
    await window.electron.openExternalUrl(created.url);
    await get().refreshPullRequests(true);
    return { ok: true };
  },
}));

/** The worktree a task's latest run lives in, or null for a local run. */
export function taskWorktree(session: SessionView | null): { cwd: string; branch: string } | null {
  const branch = session?.associatedWorktreeBranch?.trim();
  const cwd = session?.worktreePath || session?.associatedWorktreePath || null;
  if (!branch || !cwd) return null;
  return { cwd, branch };
}

/**
 * Git facts for one task, fetching what is missing. Returns null until the
 * task has a run in a git project, so callers render nothing git-related.
 */
export function useTaskGit(task: BoardTask, session: SessionView | null): TaskGitInfo | null {
  const worktree = taskWorktree(session);
  const projectCwd = session ? task.projectCwd : null;
  const brief = useTaskGitStore((state) => (projectCwd ? state.briefs[projectCwd] : undefined));
  const changes = useTaskGitStore((state) => (worktree ? state.changes[worktree.cwd] : undefined));
  const prs = useTaskGitStore((state) => state.prs);
  const ensureBrief = useTaskGitStore((state) => state.ensureBrief);
  const ensureChanges = useTaskGitStore((state) => state.ensureChanges);

  const base = brief?.defaultBranch || null;
  const status = session?.status;
  const worktreeCwd = worktree?.cwd || null;

  useEffect(() => {
    if (!projectCwd) return;
    ensureBrief(projectCwd);
  }, [projectCwd, ensureBrief]);

  useEffect(() => {
    if (!worktreeCwd || !base) return;
    // A status change (run finished) is the moment the numbers moved.
    ensureChanges(worktreeCwd, base, { force: true });
  }, [worktreeCwd, base, status, task.updatedAt, ensureChanges]);

  const branch = worktree?.branch || brief?.branch || null;
  if (!projectCwd || !branch) return null;
  const repo = brief?.fullName || null;
  const pr =
    prs.find((entry) => entry.headRefName === branch && (!repo || entry.repo === repo)) || null;
  return {
    cwd: worktree?.cwd || projectCwd,
    branch,
    isolated: !!worktree,
    base,
    repo,
    changes: worktree ? changes || null : null,
    pr,
  };
}
