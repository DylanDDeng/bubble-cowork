import * as sessions from './session-store';
import {
  assertGitRepo,
  createWorktree,
  deleteBranch,
  ensureWorktreesExcluded,
  getGitTopLevel,
  getHeadCommit,
  hasDirtyWorkingTree,
  removeWorktree,
} from './git-service';
import type { SessionRow } from '../types';
import type {
  RunGroupInfo,
  RunGroupMember,
  RunGroupStartInput,
  RunGroupStartResult,
  SessionStartPayload,
} from '../../shared/types';

export const MAX_RUN_GROUP_MEMBERS = 6;

type SessionStarter = (payload: SessionStartPayload) => Promise<string | null>;
type SessionStopper = (sessionId: string) => void;
type RunGroupEmitter = (group: RunGroupInfo) => void;

function promptExcerpt(prompt: string, max = 42): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

// worktree 隔离下的 full-access 档：取值与 automation 的 headless 预设一致
// （automation-scheduler.buildAutomationSessionPayload），codex 用 'auto'
// （映射 workspace-write 沙箱，写权限收敛到 worktree）而非 danger-full-access。
function permissionFieldsFor(member: RunGroupMember): Partial<SessionStartPayload> {
  if (member.permissionPreset === 'safe') return {};
  switch (member.provider) {
    case 'claude':
      return { claudeAccessMode: 'bypassPermissions', claudeExecutionMode: 'execute' };
    case 'codex':
      return { codexExecutionMode: 'execute', codexPermissionMode: 'auto' };
    case 'kimi':
      return { kimiPermissionMode: 'yolo' };
    case 'grok':
      return { grokPermissionMode: 'yolo' };
    case 'opencode':
      return { opencodePermissionMode: 'fullAccess' };
    default:
      return {};
  }
}

export class RunGroupService {
  constructor(
    private readonly startSession: SessionStarter,
    private readonly stopSession: SessionStopper,
    private readonly emitChanged: RunGroupEmitter
  ) {
    sessions.setSessionStatusListener((row) => {
      if (row.run_group_id) this.recompute(row.run_group_id);
    });
  }

  // 启动期调用（必须先于任何 runner 启动）：清算崩溃残留的 running session，
  // 再重算所有 running group，让它们收敛到 settled/cancelled。
  reconcileOnBoot(): void {
    const swept = sessions.sweepOrphanRunningSessions();
    if (swept > 0) {
      console.log(`[RunGroup] swept ${swept} orphan running session(s) on boot`);
    }
    for (const group of sessions.listActiveRunGroups()) {
      this.recompute(group.id);
    }
  }

  async start(input: RunGroupStartInput): Promise<RunGroupStartResult> {
    const prompt = input.prompt?.trim();
    if (!prompt) return { ok: false, message: 'Prompt is empty.' };
    if (!Array.isArray(input.variants) || input.variants.length === 0) {
      return { ok: false, message: 'Select at least one agent.' };
    }
    if (input.variants.length > MAX_RUN_GROUP_MEMBERS) {
      return { ok: false, message: `A fan-out is limited to ${MAX_RUN_GROUP_MEMBERS} agents.` };
    }

    let repoRoot: string;
    let baseRef: string;
    try {
      await assertGitRepo(input.projectCwd);
      repoRoot = await getGitTopLevel(input.projectCwd);
      await ensureWorktreesExcluded(repoRoot);
      baseRef = await getHeadCommit(repoRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Fan-out needs a git repository with at least one commit. ${message}` };
    }

    const members: RunGroupMember[] = input.variants.map((variant, index) => ({
      ...variant,
      index,
      phase: 'preparing',
      branch: null,
      worktreePath: null,
      sessionId: null,
      failReason: null,
    }));
    const group = sessions.createRunGroup({ projectCwd: repoRoot, prompt, baseRef, members });
    this.emit(group.id);

    // 成员串行启动：worktree 创建串行是防御 git 并发边界的最简做法；
    // startSession 本身很快（runner 在其内部异步起跑），串行代价可忽略，
    // 还让"runtime 未 ready 时 handleSessionStart 返回 null 但 session 行已建"
    // 的落库行可以被确定性地认领。
    for (const member of members) {
      const branch = `aegis/fan/${group.id.slice(0, 8)}/${member.index + 1}-${member.provider}`;
      try {
        const worktree = await createWorktree({ cwd: repoRoot, branch: baseRef, newBranch: branch });
        member.branch = worktree.branch;
        member.worktreePath = worktree.path;
      } catch (error) {
        member.phase = 'failed';
        member.failReason = `Worktree creation failed: ${error instanceof Error ? error.message : String(error)}`;
        sessions.updateRunGroupMembers(group.id, members);
        this.emit(group.id);
        continue;
      }

      const knownSessionIds = new Set(
        members.map((item) => item.sessionId).filter((id): id is string => Boolean(id))
      );
      let sessionId: string | null = null;
      let startError: string | null = null;
      try {
        sessionId = await this.startSession({
          title: `⑂ ${member.provider} — ${promptExcerpt(prompt)}`,
          prompt,
          cwd: member.worktreePath,
          projectCwd: repoRoot,
          envMode: 'worktree',
          worktreePath: member.worktreePath,
          associatedWorktreePath: member.worktreePath,
          associatedWorktreeBranch: member.branch,
          associatedWorktreeRef: baseRef,
          provider: member.provider,
          model: member.model || undefined,
          compatibleProviderId: member.provider === 'claude' ? member.compatibleProviderId : undefined,
          claudeReasoningEffort: member.provider === 'claude' ? member.claudeReasoningEffort : undefined,
          codexReasoningEffort: member.provider === 'codex' ? member.codexReasoningEffort : undefined,
          ...permissionFieldsFor(member),
          attachments: input.attachments,
          channelId: input.channelId,
          hiddenFromThreads: false,
          skipTitleGeneration: true,
          runGroupId: group.id,
        });
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }

      if (sessionId) {
        member.sessionId = sessionId;
        member.phase = 'running';
      } else {
        // handleSessionStart 在 runtime 未 ready 时先建 session 行（status=error）
        // 再返回 null——认领这条已落库的行，成员在重启后仍完整可见。
        const orphan = sessions
          .listSessionsByRunGroup(group.id)
          .find((row) => !knownSessionIds.has(row.id));
        member.sessionId = orphan?.id ?? null;
        member.phase = 'failed';
        member.failReason = startError || 'The agent runtime is not ready.';
        if (!orphan && member.worktreePath) {
          await this.recycleWorktree(repoRoot, member.worktreePath, member.branch);
          member.worktreePath = null;
          member.branch = null;
        }
      }
      sessions.updateRunGroupMembers(group.id, members);
      this.emit(group.id);
    }

    this.recompute(group.id);
    const memberSessionIds = members
      .filter((member) => member.phase === 'running' && member.sessionId)
      .map((member) => member.sessionId as string);
    if (memberSessionIds.length === 0) {
      return { ok: false, message: 'No fan-out member could start.', groupId: group.id };
    }
    return { ok: true, groupId: group.id, memberSessionIds };
  }

  async cancel(groupId: string): Promise<{ ok: boolean; message?: string }> {
    const group = sessions.getRunGroup(groupId);
    if (!group) return { ok: false, message: 'Run group not found.' };
    for (const member of group.members) {
      if (member.sessionId) {
        const row = sessions.getSession(member.sessionId);
        if (row?.status === 'running') this.stopSession(member.sessionId);
      }
    }
    if (group.status === 'running' || group.status === 'settled') {
      sessions.setRunGroupStatus(groupId, 'cancelled', Date.now());
    }
    await this.recycleGroupWorktrees(group);
    this.emit(groupId);
    return { ok: true };
  }

  // deleteSession 之后调用：worktree 回收 + group 收尾（被采纳成员置 NULL / 最后成员删组）。
  async handleSessionDeleted(row: SessionRow): Promise<void> {
    if (row.worktree_path) {
      const referenced = sessions
        .listRunningSessions()
        .some((other) => other.id !== row.id && other.worktree_path === row.worktree_path);
      const anyReference = referenced || this.isWorktreeReferenced(row.worktree_path, row.id);
      if (!anyReference && row.project_cwd) {
        await this.recycleWorktree(row.project_cwd, row.worktree_path, row.associated_worktree_branch);
      }
    }
    if (row.run_group_id) {
      const { groupDeleted } = sessions.handleRunGroupSessionDeleted(row.run_group_id, row.id);
      if (!groupDeleted) {
        this.recompute(row.run_group_id);
      }
    }
  }

  private isWorktreeReferenced(worktreePath: string, excludeSessionId: string): boolean {
    return sessions
      .listSessions()
      .some(
        (other) =>
          other.id !== excludeSessionId &&
          (other.worktree_path === worktreePath || other.associated_worktree_path === worktreePath)
      );
  }

  private async recycleGroupWorktrees(group: RunGroupInfo): Promise<void> {
    const members = sessions.getRunGroup(group.id)?.members ?? group.members;
    let changed = false;
    for (const member of members) {
      if (!member.worktreePath) continue;
      const recycled = await this.recycleWorktree(group.projectCwd, member.worktreePath, member.branch);
      if (recycled) {
        member.worktreePath = null;
        changed = true;
      }
    }
    if (changed) sessions.updateRunGroupMembers(group.id, members);
  }

  // 只回收 clean 的 worktree（dirty 保留，防止销毁未采纳的工作成果）。返回是否回收成功。
  private async recycleWorktree(
    repoCwd: string,
    worktreePath: string,
    branch?: string | null
  ): Promise<boolean> {
    try {
      const dirty = await hasDirtyWorkingTree(worktreePath).catch(() => false);
      if (dirty) return false;
      await removeWorktree({ cwd: repoCwd, path: worktreePath });
      if (branch) {
        await deleteBranch({ cwd: repoCwd, branch, force: true }).catch(() => undefined);
      }
      return true;
    } catch (error) {
      console.warn(`[RunGroup] failed to recycle worktree ${worktreePath}:`, error);
      return false;
    }
  }

  // settled 判定是从成员状态派生的幂等函数：成员终态变化和启动时都会重算。
  recompute(groupId: string): void {
    const group = sessions.getRunGroup(groupId);
    if (!group) return;
    if (group.status !== 'running') {
      this.emit(groupId);
      return;
    }
    let anyActive = false;
    let anySucceeded = false;
    for (const member of group.members) {
      if (member.phase === 'preparing') {
        anyActive = true;
        continue;
      }
      if (member.sessionId) {
        const row = sessions.getSession(member.sessionId);
        if (row?.status === 'running') {
          anyActive = true;
        } else if (row && row.status !== 'error') {
          anySucceeded = true;
        }
      }
    }
    if (!anyActive) {
      sessions.setRunGroupStatus(groupId, anySucceeded ? 'settled' : 'cancelled', Date.now());
      this.onGroupSettled?.(sessions.getRunGroup(groupId)!);
    }
    this.emit(groupId);
  }

  // Phase 3 的通知在此挂接（group 全员到达终态）。
  onGroupSettled: ((group: RunGroupInfo) => void) | null = null;

  private emit(groupId: string): void {
    const group = sessions.getRunGroup(groupId);
    if (group) this.emitChanged(group);
  }
}
