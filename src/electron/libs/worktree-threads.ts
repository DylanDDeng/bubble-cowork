// Session-first 的"隔离副本"流：worktree 是 thread 的一个属性，不是导航对象。
// 三个动作对应用户心智的三句话——"开个安全模式让它试 / 试好了收下 / 试砸了扔掉"。
import { v4 as uuidv4 } from 'uuid';
import * as sessions from './session-store';
import {
  assertGitRepo,
  commitAllChanges,
  createWorktree,
  deleteBranch,
  ensureWorktreesExcluded,
  getGitTopLevel,
  getHeadCommit,
  hasTrackedChanges,
  removeWorktree,
  squashMergeBranch,
} from './git-service';

export interface IsolatedWorkspaceProvision {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}

export interface IsolatedWorkspaceActionResult {
  ok: boolean;
  message?: string;
  conflict?: boolean;
}

// 建一个隔离 worktree（从项目当前 HEAD 出发）。session.start 的
// createIsolatedWorkspace 开关和"派生到隔离副本"都走这里。
export async function provisionIsolatedWorkspace(
  projectCwd: string
): Promise<IsolatedWorkspaceProvision> {
  await assertGitRepo(projectCwd);
  const repoRoot = await getGitTopLevel(projectCwd);
  await ensureWorktreesExcluded(repoRoot);
  const baseRef = await getHeadCommit(repoRoot);
  const branch = `aegis/iso/${uuidv4().slice(0, 8)}`;
  const worktree = await createWorktree({ cwd: repoRoot, branch: baseRef, newBranch: branch });
  return { repoRoot, worktreePath: worktree.path, branch, baseRef };
}

// 给已存在的 session（如刚 fork 出来的）套上隔离 worktree。
export async function assignIsolatedWorkspace(sessionId: string): Promise<IsolatedWorkspaceActionResult> {
  const row = sessions.getSession(sessionId);
  if (!row) return { ok: false, message: 'Session not found.' };
  const projectCwd = row.project_cwd || row.cwd;
  if (!projectCwd) return { ok: false, message: 'This thread has no project folder.' };
  try {
    const provision = await provisionIsolatedWorkspace(projectCwd);
    sessions.updateSessionWorkspace(sessionId, {
      envMode: 'worktree',
      projectCwd: provision.repoRoot,
      worktreePath: provision.worktreePath,
      associatedWorktreePath: provision.worktreePath,
      associatedWorktreeBranch: provision.branch,
      associatedWorktreeRef: provision.baseRef,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `Could not create a worktree — this needs a git repository with at least one commit. ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

// "把改动带回项目"：worktree 里的工作 commit 到分支 → squash-merge 到主工作区
// 暂存区（用户审查后自行 commit）→ 回收 worktree 与分支 → thread 回到项目本体。
export async function applyIsolatedWorkspace(
  sessionId: string,
  isSessionRunning: (sessionId: string) => boolean
): Promise<IsolatedWorkspaceActionResult> {
  const row = sessions.getSession(sessionId);
  if (!row) return { ok: false, message: 'Session not found.' };
  if (isSessionRunning(sessionId) || row.status === 'running') {
    return { ok: false, message: 'Wait for the agent to finish before bringing changes back.' };
  }
  const projectCwd = row.project_cwd || null;
  const worktreePath = row.worktree_path;
  const branch = row.associated_worktree_branch;
  if (row.env_mode !== 'worktree' || !worktreePath || !branch || !projectCwd) {
    return { ok: false, message: 'This thread is not running in a worktree.' };
  }
  if (await hasTrackedChanges(projectCwd)) {
    return {
      ok: false,
      message:
        'Your project has uncommitted changes. Commit or stash them first so the worktree changes can squash-merge cleanly.',
    };
  }

  try {
    await commitAllChanges({ cwd: worktreePath, message: 'aegis: isolated workspace changes' });
  } catch (error) {
    return {
      ok: false,
      message: `Failed to gather the isolated changes: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const merge = await squashMergeBranch({ cwd: projectCwd, branch });
  if (!merge.ok) {
    return {
      ok: false,
      conflict: merge.conflict,
      message: merge.conflict
        ? 'The changes conflict with your project. Nothing was applied — resolve manually or discard the worktree.'
        : merge.message,
    };
  }

  await removeWorktree({ cwd: projectCwd, path: worktreePath, force: true }).catch(() => undefined);
  await deleteBranch({ cwd: projectCwd, branch, force: true }).catch(() => undefined);
  sessions.updateSessionWorkspace(sessionId, {
    envMode: 'local',
    projectCwd,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
  });
  return { ok: true, message: merge.message };
}

// "丢弃这次尝试"：worktree 与分支强制回收，thread 回到项目本体（对话保留）。
export async function discardIsolatedWorkspace(
  sessionId: string,
  isSessionRunning: (sessionId: string) => boolean
): Promise<IsolatedWorkspaceActionResult> {
  const row = sessions.getSession(sessionId);
  if (!row) return { ok: false, message: 'Session not found.' };
  if (isSessionRunning(sessionId) || row.status === 'running') {
    return { ok: false, message: 'Stop the agent before removing the worktree.' };
  }
  const projectCwd = row.project_cwd || null;
  const worktreePath = row.worktree_path;
  const branch = row.associated_worktree_branch;
  if (row.env_mode !== 'worktree' || !worktreePath || !projectCwd) {
    return { ok: false, message: 'This thread is not running in a worktree.' };
  }
  await removeWorktree({ cwd: projectCwd, path: worktreePath, force: true }).catch(() => undefined);
  if (branch) {
    await deleteBranch({ cwd: projectCwd, branch, force: true }).catch(() => undefined);
  }
  sessions.updateSessionWorkspace(sessionId, {
    envMode: 'local',
    projectCwd,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
  });
  return { ok: true };
}
