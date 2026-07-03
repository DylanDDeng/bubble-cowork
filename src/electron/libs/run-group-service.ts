import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as sessions from './session-store';
import { subscribeTerminalEvents, terminalManager } from './terminal-runtime';
import {
  assertGitRepo,
  commitAllChanges,
  createWorktree,
  deleteBranch,
  ensureWorktreesExcluded,
  getDiffAgainstRef,
  getDiffStatAgainstRef,
  getGitTopLevel,
  getHeadCommit,
  hasDirtyWorkingTree,
  hasTrackedChanges,
  listWorktrees,
  removeWorktree,
  squashMergeBranch,
} from './git-service';
import type { SessionRow } from '../types';
import type {
  RunGroupAdoptResult,
  RunGroupInfo,
  RunGroupMember,
  RunGroupMemberSummary,
  RunGroupStartInput,
  RunGroupStartResult,
  RunGroupSummary,
  SessionStartPayload,
  SessionStatus,
} from '../../shared/types';

export const MAX_RUN_GROUP_MEMBERS = 6;

type SessionStarter = (payload: SessionStartPayload) => Promise<string | null>;
type SessionStopper = (sessionId: string) => void;
type RunGroupEmitter = (group: RunGroupInfo) => void;

function promptExcerpt(prompt: string, max = 42): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function isCustomRuntimeRef(ref: string): ref is `custom:${string}` {
  return ref.startsWith('custom:');
}

// PTY 里 env 值有长度上限（MAX_TERMINAL_ENV_VALUE_LENGTH = 8192）；
// 超长 prompt 完整落临时文件，env 里只放截断版
const MAX_ENV_PROMPT_CHARS = 7500;

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
    // custom（终端）成员的完成检测：PTY 退出码为准
    subscribeTerminalEvents((event) => {
      if (event.type !== 'exited') return;
      const match = /^rg-(.+)-m(\d+)$/.exec(event.threadId);
      if (!match) return;
      const group = sessions.getRunGroup(match[1]);
      if (!group) return;
      const memberIndex = Number(match[2]);
      const members = group.members;
      const member = members.find((item) => item.index === memberIndex);
      if (!member || member.terminalThreadId !== event.threadId || member.phase !== 'running') return;
      if (event.exitCode === 0) {
        member.phase = 'done';
      } else {
        member.phase = 'failed';
        member.failReason = `Exited with code ${event.exitCode ?? 'unknown'}${
          event.exitSignal ? ` (signal ${event.exitSignal})` : ''
        }`;
      }
      sessions.updateRunGroupMembers(group.id, members);
      this.recompute(group.id);
    });
  }

  // 由 ipc-handlers 的全局 session 状态监听器调用（成员 session 到达终态 → 重算 group）
  handleSessionStatusChanged(row: SessionRow): void {
    if (row.run_group_id) this.recompute(row.run_group_id);
  }

  // 启动期调用（必须先于任何 runner 启动）：清算崩溃残留的 running session，
  // 再重算所有 running group，让它们收敛到 settled/cancelled。
  reconcileOnBoot(): void {
    const swept = sessions.sweepOrphanRunningSessions();
    if (swept > 0) {
      console.log(`[RunGroup] swept ${swept} orphan running session(s) on boot`);
    }
    for (const group of sessions.listActiveRunGroups()) {
      // PTY 不跨重启存活：崩溃残留的 running 终端成员清算为 failed
      let changed = false;
      const members = group.members;
      for (const member of members) {
        if (member.terminalThreadId && member.phase === 'running') {
          member.phase = 'failed';
          member.failReason = 'Interrupted by app restart.';
          changed = true;
        }
      }
      if (changed) sessions.updateRunGroupMembers(group.id, members);
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
    const group = sessions.createRunGroup({
      projectCwd: repoRoot,
      prompt,
      baseRef,
      members,
      automationRunId: input.automationRunId || null,
    });
    this.emit(group.id);

    // 成员串行启动：worktree 创建串行是防御 git 并发边界的最简做法；
    // startSession 本身很快（runner 在其内部异步起跑），串行代价可忽略，
    // 还让"runtime 未 ready 时 handleSessionStart 返回 null 但 session 行已建"
    // 的落库行可以被确定性地认领。
    for (const member of members) {
      const branchSlug = isCustomRuntimeRef(member.provider)
        ? 'custom'
        : member.provider;
      const branch = `aegis/fan/${group.id.slice(0, 8)}/${member.index + 1}-${branchSlug}`;
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

      // Custom runtime 成员：PTY 里跑任意 CLI，无 chat session；
      // 完成检测 = shell 退出码（构造器里的 terminal exit 订阅）
      if (isCustomRuntimeRef(member.provider)) {
        await this.launchCustomMember(group.id, member, prompt);
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
          title: input.title
            ? `⑂ ${member.provider} — ${input.title}`
            : `⑂ ${member.provider} — ${promptExcerpt(prompt)}`,
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
    const finalMembers = sessions.getRunGroup(group.id)?.members ?? members;
    const memberSessionIds = finalMembers
      .filter((member) => member.phase === 'running' && member.sessionId)
      .map((member) => member.sessionId as string);
    const anyStarted = finalMembers.some((member) => member.phase === 'running');
    if (!anyStarted) {
      return { ok: false, message: 'No fan-out member could start.', groupId: group.id, members: finalMembers };
    }
    return { ok: true, groupId: group.id, memberSessionIds, members: finalMembers };
  }

  // 在 worktree 里通过 PTY 启动一个 custom CLI agent。prompt 经 env 传值
  // （argv 安全，不做字符串插值进命令）；超长 prompt 完整落临时文件。
  private async launchCustomMember(
    groupId: string,
    member: RunGroupMember,
    prompt: string
  ): Promise<void> {
    const runtimeId = member.provider.slice('custom:'.length);
    const runtime = sessions.getCustomRuntime(runtimeId);
    if (!runtime) {
      member.phase = 'failed';
      member.failReason = 'Custom runtime not found (was it deleted?).';
      return;
    }
    member.runtimeName = runtime.name;
    const threadId = `rg-${groupId}-m${member.index}`;
    try {
      const promptFile = join(tmpdir(), `aegis-prompt-${groupId.slice(0, 8)}-m${member.index}.md`);
      writeFileSync(promptFile, prompt, 'utf8');
      const opened = await terminalManager.open({
        threadId,
        cwd: member.worktreePath!,
        agentKind: 'shell',
        env: {
          AEGIS_PROMPT:
            prompt.length > MAX_ENV_PROMPT_CHARS ? prompt.slice(0, MAX_ENV_PROMPT_CHARS) : prompt,
          AEGIS_PROMPT_FILE: promptFile,
        },
      });
      if (!opened.ok) {
        member.phase = 'failed';
        member.failReason = opened.message || 'Failed to open a terminal for the runtime.';
        return;
      }
      const command = runtime.command
        .replaceAll('{prompt}', '"$AEGIS_PROMPT"')
        .replaceAll('{promptFile}', '"$AEGIS_PROMPT_FILE"');
      // exit $? 让 shell 随命令退出，退出码即完成信号
      await terminalManager.write({ threadId, data: ` ${command}; exit $?\n` });
      member.terminalThreadId = threadId;
      member.phase = 'running';
    } catch (error) {
      member.phase = 'failed';
      member.failReason = error instanceof Error ? error.message : String(error);
      terminalManager.close({ threadId });
    }
  }

  async cancel(groupId: string): Promise<{ ok: boolean; message?: string }> {
    const group = sessions.getRunGroup(groupId);
    if (!group) return { ok: false, message: 'Run group not found.' };
    this.stopGroupMembers(group);
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

  private stopGroupMembers(group: RunGroupInfo): void {
    for (const member of group.members) {
      if (member.sessionId) {
        const row = sessions.getSession(member.sessionId);
        if (row?.status === 'running') this.stopSession(member.sessionId);
      }
      if (member.terminalThreadId && member.phase === 'running') {
        terminalManager.close({ threadId: member.terminalThreadId });
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
      // 终端（custom）成员：phase 由 PTY 退出码驱动，是唯一真相
      if (member.terminalThreadId) {
        if (member.phase === 'running') anyActive = true;
        else if (member.phase === 'done') anySucceeded = true;
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

  async summary(groupId: string): Promise<RunGroupSummary | null> {
    const group = sessions.getRunGroup(groupId);
    if (!group) return null;
    const members: RunGroupMemberSummary[] = await Promise.all(
      group.members.map(async (member) => {
        const row = member.sessionId ? sessions.getSession(member.sessionId) : undefined;
        let diffStat: RunGroupMemberSummary['diffStat'] = null;
        if (member.worktreePath && group.baseRef) {
          diffStat = await getDiffStatAgainstRef(member.worktreePath, group.baseRef).catch(() => null);
        }
        return {
          ...member,
          sessionStatus: (row?.status as SessionStatus | undefined) ?? null,
          title: row?.title ?? null,
          startedAt: row?.created_at ?? null,
          updatedAt: row?.updated_at ?? null,
          diffStat,
          excerpt: member.sessionId ? sessions.getLastAssistantExcerpt(member.sessionId) : null,
        };
      })
    );
    return { group, members };
  }

  async memberDiff(groupId: string, memberIndex: number): Promise<string | null> {
    const group = sessions.getRunGroup(groupId);
    const member = group?.members.find((item) => item.index === memberIndex);
    if (!group?.baseRef || !member?.worktreePath) return null;
    return getDiffAgainstRef(member.worktreePath, group.baseRef).catch(() => null);
  }

  // 采纳赢家：squash-merge 到主工作区暂存区（用户审查后自行 commit）。
  // 落败成员的 worktree 强制回收（采纳是"选这个、弃其余"的显式决定）；
  // 赢家分支保留（误采纳可从分支恢复），worktree 移除。
  async adopt(groupId: string, memberIndex: number): Promise<RunGroupAdoptResult> {
    const group = sessions.getRunGroup(groupId);
    if (!group) return { ok: false, message: 'Run group not found.' };
    if (group.status === 'adopted') return { ok: false, message: 'This fan-out was already adopted.' };
    const winner = group.members.find((member) => member.index === memberIndex);
    if (!winner) return { ok: false, message: 'That agent is not a member of this fan-out.' };
    if (!winner.worktreePath || !winner.branch) {
      return { ok: false, message: 'The winning agent has no worktree to adopt.' };
    }
    if (winner.sessionId) {
      const winnerRow = sessions.getSession(winner.sessionId);
      if (winnerRow?.status === 'running') {
        return { ok: false, message: 'Stop the winning agent before adopting its result.' };
      }
    } else if (winner.terminalThreadId && winner.phase === 'running') {
      return { ok: false, message: 'The winning agent is still running.' };
    }
    if (await hasTrackedChanges(group.projectCwd)) {
      return {
        ok: false,
        message:
          'Your main workspace has uncommitted changes. Commit or stash them before adopting a fan-out result.',
      };
    }

    // 1. 赢家未提交的工作先落到其分支（squash-merge 只吃已提交内容）
    try {
      await commitAllChanges({
        cwd: winner.worktreePath,
        message: `aegis: fan-out result (${winner.provider})`,
      });
    } catch (error) {
      return {
        ok: false,
        message: `Failed to commit the winning worktree: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 2. squash-merge 到主工作区（冲突则干净中止，worktree 原样保留）
    const merge = await squashMergeBranch({ cwd: group.projectCwd, branch: winner.branch });
    if (!merge.ok) {
      return {
        ok: false,
        conflict: merge.conflict,
        message: merge.conflict
          ? 'The result conflicts with your main workspace. The merge was aborted cleanly; resolve manually from the member branch.'
          : merge.message,
      };
    }

    // 3. 状态落库
    sessions.setRunGroupAdoptedSession(groupId, winner.sessionId ?? null);
    sessions.setRunGroupStatus(groupId, 'adopted', Date.now());

    // 4. 回收：赢家 worktree（改动已在分支 + 主工作区暂存区）+ 落败成员（强制）
    const members = sessions.getRunGroup(groupId)?.members ?? [];
    for (const member of members) {
      if (!member.worktreePath) continue;
      const isWinner = member.index === memberIndex;
      try {
        await removeWorktree({ cwd: group.projectCwd, path: member.worktreePath, force: true });
        member.worktreePath = null;
        if (!isWinner && member.branch) {
          await deleteBranch({ cwd: group.projectCwd, branch: member.branch, force: true }).catch(
            () => undefined
          );
        }
      } catch (error) {
        console.warn(`[RunGroup] failed to remove worktree ${member.worktreePath}:`, error);
      }
    }
    sessions.updateRunGroupMembers(groupId, members);
    this.emit(groupId);
    return { ok: true, message: merge.message };
  }

  // 全组放弃：停掉 running 成员，回收全部 worktree（含 dirty——放弃是显式决定），删分支。
  async discard(groupId: string): Promise<{ ok: boolean; message?: string }> {
    const group = sessions.getRunGroup(groupId);
    if (!group) return { ok: false, message: 'Run group not found.' };
    this.stopGroupMembers(group);
    const members = sessions.getRunGroup(groupId)?.members ?? [];
    for (const member of members) {
      if (!member.worktreePath) continue;
      try {
        await removeWorktree({ cwd: group.projectCwd, path: member.worktreePath, force: true });
        if (member.branch) {
          await deleteBranch({ cwd: group.projectCwd, branch: member.branch, force: true }).catch(
            () => undefined
          );
        }
        member.worktreePath = null;
      } catch (error) {
        console.warn(`[RunGroup] failed to remove worktree ${member.worktreePath}:`, error);
      }
    }
    sessions.updateRunGroupMembers(groupId, members);
    sessions.setRunGroupStatus(groupId, 'discarded', Date.now());
    this.emit(groupId);
    return { ok: true };
  }

  // 启动 GC 的"可清理"清单：.worktrees 下无任何 session 引用且 clean 的 worktree。
  // 不默认静默删——列出来让用户一键清理。
  async listReclaimableWorktrees(projectCwd: string): Promise<string[]> {
    const worktrees = await listWorktrees(projectCwd).catch(() => []);
    const referenced = new Set<string>();
    for (const row of sessions.listSessions()) {
      if (row.worktree_path) referenced.add(row.worktree_path);
      if (row.associated_worktree_path) referenced.add(row.associated_worktree_path);
    }
    for (const group of sessions.listRunGroups()) {
      for (const member of group.members) {
        if (member.worktreePath) referenced.add(member.worktreePath);
      }
    }
    const reclaimable: string[] = [];
    for (const worktree of worktrees) {
      if (worktree.current) continue;
      if (!worktree.path.includes('/.worktrees/') && !worktree.path.includes('\\.worktrees\\')) continue;
      if (referenced.has(worktree.path)) continue;
      const dirty = await hasDirtyWorkingTree(worktree.path).catch(() => true);
      if (!dirty) reclaimable.push(worktree.path);
    }
    return reclaimable;
  }

  async reclaimWorktrees(projectCwd: string): Promise<{ removed: number }> {
    const reclaimable = await this.listReclaimableWorktrees(projectCwd);
    let removed = 0;
    for (const worktreePath of reclaimable) {
      try {
        await removeWorktree({ cwd: projectCwd, path: worktreePath });
        removed += 1;
      } catch (error) {
        console.warn(`[RunGroup] failed to reclaim ${worktreePath}:`, error);
      }
    }
    return { removed };
  }

  private emit(groupId: string): void {
    const group = sessions.getRunGroup(groupId);
    if (group) this.emitChanged(group);
  }
}
