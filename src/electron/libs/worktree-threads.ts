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

// 分支第三级尽量像 session title 一样可读：从提示词/标题提取 ascii slug。
// 中日韩等非 ascii 内容进不了安全的分支名，退回短哈希（侧栏显示层会再兜底）。
function branchSlugFromHint(hint?: string | null): string | null {
  if (!hint) return null;
  const slug = hint
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : null;
}

// 建一个隔离 worktree（从项目当前 HEAD 出发）。session.start 的
// createIsolatedWorkspace 开关和 Move into a new worktree 都走这里。
// labelHint（提示词/标题）用于生成可读的分支名。
export async function provisionIsolatedWorkspace(
  projectCwd: string,
  labelHint?: string | null
): Promise<IsolatedWorkspaceProvision> {
  await assertGitRepo(projectCwd);
  const repoRoot = await getGitTopLevel(projectCwd);
  await ensureWorktreesExcluded(repoRoot);
  const baseRef = await getHeadCommit(repoRoot);
  const slug = branchSlugFromHint(labelHint);
  const candidates = slug
    ? [`aegis/iso/${slug}`, `aegis/iso/${slug}-${uuidv4().slice(0, 4)}`]
    : [`aegis/iso/${uuidv4().slice(0, 8)}`];
  let lastError: unknown = null;
  for (const branch of candidates) {
    try {
      const worktree = await createWorktree({ cwd: repoRoot, branch: baseRef, newBranch: branch });
      return { repoRoot, worktreePath: worktree.path, branch, baseRef };
    } catch (error) {
      // 同名分支已存在（同一句提示词重复开）→ 带短后缀重试一次
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// 给已存在的 session 套上隔离 worktree（Move into a new worktree）。
export async function assignIsolatedWorkspace(sessionId: string): Promise<IsolatedWorkspaceActionResult> {
  const row = sessions.getSession(sessionId);
  if (!row) return { ok: false, message: 'Session not found.' };
  const projectCwd = row.project_cwd || row.cwd;
  if (!projectCwd) return { ok: false, message: 'This thread has no project folder.' };
  try {
    const provision = await provisionIsolatedWorkspace(projectCwd, row.title);
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
  sessionId: string
): Promise<IsolatedWorkspaceActionResult> {
  const row = sessions.getSession(sessionId);
  if (!row) return { ok: false, message: 'Session not found.' };
  // running 判定只信 DB status：非 Claude provider 的 runner 句柄在 turn 结束后
  // 会留在内存里复用连接，不能当作"正在跑"的信号
  if (row.status === 'running') {
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
  sessionId: string
): Promise<IsolatedWorkspaceActionResult> {
  const row = sessions.getSession(sessionId);
  if (!row) return { ok: false, message: 'Session not found.' };
  if (row.status === 'running') {
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
