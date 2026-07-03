// Worktree 卫生：session 删除后的 worktree 回收。
// 只回收 clean 且无其它 session 引用的 worktree（dirty 保留，防止销毁
// 未合并的工作成果）；关联分支强制删除（worktree 已确认 clean）。
import * as sessions from './session-store';
import { deleteBranch, hasDirtyWorkingTree, removeWorktree } from './git-service';
import type { SessionRow } from '../types';

export async function recycleSessionWorktree(row: SessionRow): Promise<void> {
  const worktreePath = row.worktree_path;
  if (!worktreePath || !row.project_cwd) return;

  // 引用判定：其它 session（含隐藏的 running session）的
  // worktree_path / associated_worktree_path 指向同一路径则不回收。
  const referenced =
    sessions
      .listRunningSessions()
      .some((other) => other.id !== row.id && other.worktree_path === worktreePath) ||
    sessions
      .listSessions()
      .some(
        (other) =>
          other.id !== row.id &&
          (other.worktree_path === worktreePath ||
            other.associated_worktree_path === worktreePath)
      );
  if (referenced) return;

  try {
    const dirty = await hasDirtyWorkingTree(worktreePath).catch(() => false);
    if (dirty) return;
    await removeWorktree({ cwd: row.project_cwd, path: worktreePath });
    if (row.associated_worktree_branch) {
      await deleteBranch({
        cwd: row.project_cwd,
        branch: row.associated_worktree_branch,
        force: true,
      }).catch(() => undefined);
    }
  } catch (error) {
    console.warn(`[WorktreeHygiene] failed to recycle worktree ${worktreePath}:`, error);
  }
}
