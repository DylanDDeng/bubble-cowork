import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@/ui/components/ui/dropdown-menu';
import * as Dialog from '@/ui/components/ui/dialog';
import { Check, ChevronDown, GitBranch, GitFork, Loader2, Monitor, X } from './icons';
import { toast } from 'sonner';
import { sendEvent } from '../hooks/useIPC';
import { useAppStore } from '../store/useAppStore';
import { createStreamingWorkstreamModel } from '../utils/workstream';
import { deriveTurnPhase, hasRunningToolInMessages } from '../utils/turn-utils';
import {
  getMessageContentBlocks,
  normalizeToolResultBlock,
  normalizeToolUseBlock,
} from '../utils/message-content';
import { deriveTranscriptTimelineItems } from '../utils/transcript-timeline';
import { resolveCodexModel } from '../utils/codex-model';
import { AssistantCopyAction, MessageCard, getAssistantMarkdownToCopy } from './MessageCard';
import { ToolExecutionBatch, WorkstreamDisclosure } from './ToolExecutionBatch';
import { StructuredResponse } from './StructuredResponse';
import { WorkingFooter } from './AssistantWorkstream';
import { PromptInput } from './PromptInput';
import { NewThreadLanding } from './NewThreadLanding';
import { ComposerContextPills } from './ComposerContextPills';
import { InSessionSearch } from './search/InSessionSearch';
import { ComposerPendingPermissionPanel } from './ComposerPendingPermissionPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { TurnChangesCard } from './TurnChangesCard';
import { TurnDiffContext, type TurnDiffContextValue } from './TurnDiffContext';
import { CodexActivePlanCard } from './CodexActivePlanCard';
import { ClaudeRewindDialog, type ClaudeRewindTarget } from './ClaudeRewindDialog';
import {
  buildTurnChangeContext,
  type TurnChangeSummary,
} from '../utils/turn-change-records';
import { buildReviewTurnSelection } from '../utils/review-diff-selection';
import type { ChangeRecord } from '../utils/change-records';
import type {
  ContentBlock,
  PermissionResult,
  SessionView,
  StreamMessage,
  ToolStatus,
} from '../types';
import type { GitBranchInfo } from '../../shared/types';

type ToolResultBlock = ContentBlock & { type: 'tool_result' };
type ChatScrollPosition = { scrollTop: number; stickToBottom: boolean };
type PendingStopWorkspaceAction =
  | { kind: 'branch'; entry: GitBranchInfo }
  | { kind: 'local' }
  | { kind: 'new-worktree' };

const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 120;
const chatPaneScrollPositions = new Map<string, ChatScrollPosition>();

// Key scroll memory on the session, not the pane id: with the recursive tiling
// layout a session can move between leaves (split/unsplit, move) and should keep
// its scroll position.
function getChatScrollPositionKey(_paneId: string, sessionId: string): string {
  return `session:${sessionId}`;
}

function isNearScrollBottom(container: HTMLDivElement): boolean {
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <
    CHAT_SCROLL_BOTTOM_THRESHOLD_PX
  );
}

function rememberChatScrollPosition(key: string, container: HTMLDivElement): void {
  chatPaneScrollPositions.set(key, {
    scrollTop: container.scrollTop,
    stickToBottom: isNearScrollBottom(container),
  });
}

function restoreChatScrollPosition(key: string, container: HTMLDivElement): void {
  const savedPosition = chatPaneScrollPositions.get(key);
  if (savedPosition) {
    if (savedPosition.stickToBottom) {
      container.scrollTop = container.scrollHeight;
      return;
    }

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.min(savedPosition.scrollTop, maxScrollTop);
    return;
  }

  container.scrollTop = container.scrollHeight;
}

function buildAegisWorktreeBranch(baseBranch: string): string {
  const suffix = Date.now().toString(36);
  if (baseBranch === 'HEAD') {
    return `aegis/worktree-${suffix}`;
  }
  const sanitized = baseBranch
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/[\\/]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `aegis/${sanitized || 'worktree'}-${suffix}`;
}

export function SessionWorkspaceControl({
  session,
  sessionId,
  onWorkspaceGitChanged,
  variant = 'header',
}: {
  session: SessionView;
  sessionId: string;
  onWorkspaceGitChanged?: () => Promise<void>;
  variant?: 'header' | 'panel';
}) {
  const createDraftSession = useAppStore((state) => state.createDraftSession);
  const projectCwd = session.projectCwd || session.cwd || null;
  const effectiveCwd = session.worktreePath || session.cwd || projectCwd;
  const isWorktree = session.envMode === 'worktree' && Boolean(session.worktreePath);
  const isRunning = session.status === 'running';
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<'local' | 'worktree' | 'branch' | null>(null);
  // worktree 收尾动作（Environment 卡片 / Workspace 下拉里）："收下"或"扔掉"
  const [worktreeActionBusy, setWorktreeActionBusy] = useState(false);

  const handleSquashMerge = async () => {
    setWorktreeActionBusy(true);
    try {
      const result = await window.electron.applyWorktreeChanges(session.id);
      if (result.ok) {
        toast.success('Squash-merged — changes are staged in your project for review.');
      } else {
        toast.error(result.message || 'Squash-merge failed.');
      }
    } finally {
      setWorktreeActionBusy(false);
    }
  };

  const handleDiscardWorktree = async () => {
    const branch = session.associatedWorktreeBranch;
    if (
      !window.confirm(
        `Remove this worktree${branch ? ` and delete branch ${branch}` : ''}? All uncommitted changes in it are lost. The conversation stays.`
      )
    ) {
      return;
    }
    setWorktreeActionBusy(true);
    try {
      const result = await window.electron.discardWorktreeChanges(session.id);
      if (result.ok) {
        toast.success('Worktree removed — thread is back on the project.');
      } else {
        toast.error(result.message || 'Could not remove the worktree.');
      }
    } finally {
      setWorktreeActionBusy(false);
    }
  };
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [localDialogOpen, setLocalDialogOpen] = useState(false);
  const [branchDialog, setBranchDialog] = useState<{
    entry: GitBranchInfo;
    reason: 'running' | 'dirty';
    dirtyCount?: number | null;
  } | null>(null);
  const [pendingStopAction, setPendingStopAction] = useState<PendingStopWorkspaceAction | null>(null);
  const [stopConfirmAction, setStopConfirmAction] = useState<PendingStopWorkspaceAction | null>(null);
  const [worktreeChanges, setWorktreeChanges] = useState<{
    loading: boolean;
    totalChanges: number | null;
    error: string | null;
  }>({ loading: false, totalChanges: null, error: null });

  const refreshBranches = useCallback(async () => {
    const cwd = effectiveCwd || projectCwd;
    if (!cwd) return;
    setBranchesLoading(true);
    try {
      const result = await window.electron.getGitBranches(cwd);
      if (!result.ok) {
        setBranches([]);
        setBranchesError(result.error || 'Unable to read branches.');
        return;
      }
      setBranches(result.entries);
      setBranchesError(null);
    } catch (error) {
      setBranches([]);
      setBranchesError(error instanceof Error ? error.message : 'Unable to read branches.');
    } finally {
      setBranchesLoading(false);
    }
  }, [effectiveCwd, projectCwd]);

  useEffect(() => {
    void refreshBranches();
  }, [refreshBranches]);

  const refreshWorkspaceGit = useCallback(async () => {
    await refreshBranches();
    await onWorkspaceGitChanged?.();
  }, [onWorkspaceGitChanged, refreshBranches]);

  const branchOptions = useMemo(() => {
    const byName = new Map<string, GitBranchInfo>();
    for (const entry of branches) {
      if (!entry.name) continue;
      const existing = byName.get(entry.name);
      if (!existing || (existing.remote && !entry.remote) || (!existing.worktreePath && entry.worktreePath)) {
        byName.set(entry.name, entry);
      }
    }
    return Array.from(byName.values()).sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (Boolean(a.worktreePath) !== Boolean(b.worktreePath)) return a.worktreePath ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [branches]);

  const currentBranch =
    branches.find((entry) => entry.current && !entry.remote)?.name ||
    branches.find((entry) => entry.current)?.name ||
    session.associatedWorktreeBranch ||
    session.associatedWorktreeRef ||
    'HEAD';

  useEffect(() => {
    if (!worktreeDialogOpen) return;
    if (isRunning) return;
    const cwd = effectiveCwd || projectCwd;
    if (!cwd) return;
    let cancelled = false;
    setWorktreeChanges({ loading: true, totalChanges: null, error: null });
    void window.electron.getGitOverview(cwd)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setWorktreeChanges({
            loading: false,
            totalChanges: null,
            error: result.error || 'Unable to inspect current changes.',
          });
          return;
        }
        setWorktreeChanges({ loading: false, totalChanges: result.totalChanges, error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setWorktreeChanges({
          loading: false,
          totalChanges: null,
          error: error instanceof Error ? error.message : 'Unable to inspect current changes.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveCwd, isRunning, projectCwd, worktreeDialogOpen]);

  const runHandoff = useCallback(async (
    targetMode: 'local' | 'worktree',
    branch?: string | null,
    worktreePath?: string | null,
    includeChanges?: boolean
  ) => {
    setBusyAction(targetMode);
    try {
      const result = await window.electron.gitSessionHandoff({
        sessionId,
        targetMode,
        branch: branch || null,
        worktreePath: worktreePath || null,
        includeChanges,
      });
      if (!result.ok) {
        toast.error(result.message || 'Workspace switch failed.');
        return;
      }
      toast.success(targetMode === 'worktree' ? 'Session moved to worktree.' : 'Session moved to local workspace.');
      await refreshWorkspaceGit();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Workspace switch failed.');
    } finally {
      setBusyAction(null);
    }
  }, [refreshWorkspaceGit, sessionId]);

  const openDraftInWorkspace = useCallback((input: {
    cwd: string;
    projectCwd: string;
    envMode: 'local' | 'worktree';
    worktreePath?: string | null;
    branch?: string | null;
    title?: string;
  }) => {
    createDraftSession(input.cwd, session.channelId || null, {
      title: input.title || `New Chat - ${input.branch || (input.envMode === 'worktree' ? 'Worktree' : 'Local')}`,
      projectCwd: input.projectCwd,
      envMode: input.envMode,
      worktreePath: input.worktreePath ?? null,
      associatedWorktreePath: input.worktreePath ?? null,
      associatedWorktreeBranch: input.branch ?? null,
      associatedWorktreeRef: input.branch ?? null,
    });
  }, [createDraftSession, session.channelId]);

  const openExistingWorktreeInNewThread = useCallback((entry: GitBranchInfo) => {
    if (!projectCwd || !entry.worktreePath) return;
    openDraftInWorkspace({
      cwd: entry.worktreePath,
      projectCwd,
      envMode: 'worktree',
      worktreePath: entry.worktreePath,
      branch: entry.name,
      title: `New Chat - ${entry.name}`,
    });
    toast.success(`Opened ${entry.name} in a new thread.`);
  }, [openDraftInWorkspace, projectCwd]);

  const openLocalInNewThread = useCallback(() => {
    if (!projectCwd) return;
    openDraftInWorkspace({
      cwd: projectCwd,
      projectCwd,
      envMode: 'local',
      title: 'New Chat - Local',
    });
    toast.success('Opened Local in a new thread.');
  }, [openDraftInWorkspace, projectCwd]);

  const createWorktreeAndOpenThread = useCallback(async (
    branch: string,
    options?: { newBranch?: string | null }
  ) => {
    if (!projectCwd) return;
    setBusyAction('worktree');
    try {
      const result = await window.electron.gitCreateWorktree({
        cwd: projectCwd,
        branch,
        newBranch: options?.newBranch ?? null,
      });
      if (!result.ok || !result.worktree) {
        toast.error(result.message || 'Worktree creation failed.');
        return;
      }
      openDraftInWorkspace({
        cwd: result.worktree.path,
        projectCwd,
        envMode: 'worktree',
        worktreePath: result.worktree.path,
        branch: result.worktree.branch || branch,
        title: `New Chat - ${result.worktree.branch || branch}`,
      });
      toast.success(`Created worktree for ${branch}.`);
      await refreshWorkspaceGit();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Worktree creation failed.');
    } finally {
      setBusyAction(null);
    }
  }, [openDraftInWorkspace, projectCwd, refreshWorkspaceGit]);

  const requestStopThenSwitch = useCallback((action: PendingStopWorkspaceAction) => {
    setBranchDialog(null);
    setLocalDialogOpen(false);
    setWorktreeDialogOpen(false);
    setPendingStopAction(action);
    sendEvent({ type: 'session.stop', payload: { sessionId } });
    toast.info('Stopping current task before switching workspace.');
  }, [sessionId]);

  const createNewWorktree = useCallback((includeChanges: boolean) => {
    setWorktreeDialogOpen(false);
    if (isRunning) {
      void createWorktreeAndOpenThread(currentBranch, {
        newBranch: buildAegisWorktreeBranch(currentBranch),
      });
      return;
    }
    void runHandoff('worktree', currentBranch, null, includeChanges);
  }, [createWorktreeAndOpenThread, currentBranch, isRunning, runHandoff]);

  const runBranchCheckout = useCallback(async (entry: GitBranchInfo) => {
    const cwd = effectiveCwd || projectCwd;
    if (!cwd) return;
    setBusyAction('branch');
    try {
      const result = await window.electron.gitCheckoutBranch({
        cwd,
        branch: entry.name,
        sessionId,
      });
      if (!result.ok) {
        toast.error(result.message || 'Branch checkout failed.');
        return;
      }
      toast.success(`Checked out ${entry.name}.`);
      await refreshWorkspaceGit();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Branch checkout failed.');
    } finally {
      setBusyAction(null);
    }
  }, [effectiveCwd, projectCwd, refreshWorkspaceGit, sessionId]);

  const handleSelectBranch = useCallback(async (entry: GitBranchInfo) => {
    const cwd = effectiveCwd || projectCwd;
    if (!cwd) return;
    if (entry.current && (!entry.worktreePath || entry.worktreePath === cwd)) {
      return;
    }
    if (isRunning) {
      setBranchDialog({ entry, reason: 'running' });
      return;
    }
    if (entry.worktreePath && entry.worktreePath !== cwd) {
      await runHandoff('worktree', entry.name, entry.worktreePath, false);
      return;
    }
    setBusyAction('branch');
    try {
      const overview = await window.electron.getGitOverview(cwd);
      if (overview.ok && overview.totalChanges > 0) {
        setBranchDialog({ entry, reason: 'dirty', dirtyCount: overview.totalChanges });
        return;
      }
      await runBranchCheckout(entry);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to inspect git status.');
    } finally {
      setBusyAction(null);
    }
  }, [effectiveCwd, isRunning, projectCwd, runBranchCheckout, runHandoff]);

  useEffect(() => {
    if (!pendingStopAction || isRunning) return;
    const action = pendingStopAction;
    setPendingStopAction(null);
    if (action.kind === 'branch') {
      void handleSelectBranch(action.entry);
    } else if (action.kind === 'local') {
      setLocalDialogOpen(true);
    } else {
      setWorktreeDialogOpen(true);
    }
  }, [handleSelectBranch, isRunning, pendingStopAction]);

  if (session.isDraft || session.scope === 'dm' || !projectCwd || !effectiveCwd) {
    return null;
  }

  // Only real switch operations replace the workspace icon; the silent
  // branch-list refresh on dropdown open must not flash it into a spinner.
  const BusyIcon = busyAction ? Loader2 : null;
  const panelVariant = variant === 'panel';
  const wrapperClass = panelVariant ? 'flex flex-col gap-1.5' : 'flex min-w-0 items-center gap-1';
  const rowButtonClass = panelVariant
    ? 'flex h-8 w-full items-center gap-2 rounded-md px-2 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50'
    : 'inline-flex h-6 max-w-[112px] items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]';
  const branchButtonClass = panelVariant
    ? 'flex h-8 w-full items-center gap-2 rounded-md px-2 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50'
    : 'inline-flex h-6 max-w-[150px] items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]';
  const environmentHubLayerProps = panelVariant ? { 'data-environment-hub-layer': true } : {};

  return (
    <div className={wrapperClass}>
      <DropdownMenu.Root modal={!panelVariant} onOpenChange={(open) => { if (open) void refreshBranches(); }}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={rowButtonClass}
            disabled={busyAction !== null}
            title={isWorktree ? session.worktreePath || 'Worktree' : projectCwd}
          >
            {BusyIcon ? <BusyIcon className="h-3.5 w-3.5 animate-spin" /> : isWorktree ? <GitFork className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
            {panelVariant ? <span className="text-[var(--text-muted)]">Workspace</span> : null}
            <span className="min-w-0 flex-1 truncate text-left">{isWorktree ? 'Worktree' : 'Local'}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            {...environmentHubLayerProps}
            align="start"
            sideOffset={6}
            className="z-[9999] min-w-[190px] rounded-[var(--popover-radius)] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 shadow-[var(--popover-shadow)]"
          >
            <DropdownMenu.Item
              disabled={!isWorktree || busyAction !== null}
              onSelect={(event) => {
                event.preventDefault();
                setLocalDialogOpen(true);
              }}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--sidebar-item-hover)]"
            >
              <Monitor className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              <span className="flex-1">Local</span>
              {!isWorktree ? <Check className="h-3.5 w-3.5" /> : null}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={busyAction !== null}
              onSelect={(event) => {
                event.preventDefault();
                setWorktreeDialogOpen(true);
              }}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--sidebar-item-hover)]"
            >
              <GitFork className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              <span className="flex-1">New worktree</span>
            </DropdownMenu.Item>
            {isWorktree ? (
              <>
                <div className="my-1 h-px bg-[var(--border)]" />
                <div
                  className="truncate px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]"
                  title={session.worktreePath || undefined}
                >
                  {session.associatedWorktreeBranch || 'worktree'}
                </div>
                <DropdownMenu.Item
                  disabled={isRunning || worktreeActionBusy}
                  onSelect={(event) => {
                    event.preventDefault();
                    void handleSquashMerge();
                  }}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--sidebar-item-hover)]"
                  title="git merge --squash into your project — the result lands in the staging area for review"
                >
                  <GitBranch className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                  <span className="flex-1">Squash-merge into project</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={isRunning || worktreeActionBusy}
                  onSelect={(event) => {
                    event.preventDefault();
                    void handleDiscardWorktree();
                  }}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--sidebar-item-hover)] data-[highlighted]:text-rose-500"
                  title="Remove the worktree and delete its branch"
                >
                  <X className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                  <span className="flex-1">Discard worktree…</span>
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Dialog.Root open={localDialogOpen} onOpenChange={setLocalDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay {...environmentHubLayerProps} className="fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Content {...environmentHubLayerProps} className="fixed left-1/2 top-1/2 z-[100] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_60px_rgba(15,23,42,0.18)] outline-none">
            <div className="border-b border-[var(--border)] px-4 py-3">
              <Dialog.Title className="text-[14px] font-semibold text-[var(--text-primary)]">
                Switch to Local
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">
                {isRunning
                  ? 'The current task is running. Open Local in a new thread or stop the task before moving this session.'
                  : 'Uncommitted changes in the worktree will stay in the worktree unless you choose to bring them.'}
              </Dialog.Description>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              <button
                type="button"
                onClick={() => setLocalDialogOpen(false)}
                className="rounded-md px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              {isRunning ? (
                <>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => {
                      setLocalDialogOpen(false);
                      openLocalInNewThread();
                    }}
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Open Local in new thread
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => setStopConfirmAction({ kind: 'local' })}
                    className="rounded-md bg-[var(--error)] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Stop task and switch
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => {
                      setLocalDialogOpen(false);
                      void runHandoff('local', null, null, false);
                    }}
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Switch only
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => {
                      setLocalDialogOpen(false);
                      void runHandoff('local', null, null, true);
                    }}
                    className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--accent-foreground)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Bring changes to Local
                  </button>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={worktreeDialogOpen} onOpenChange={setWorktreeDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay {...environmentHubLayerProps} className="fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Content {...environmentHubLayerProps} className="fixed left-1/2 top-1/2 z-[100] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_60px_rgba(15,23,42,0.18)] outline-none">
            <div className="border-b border-[var(--border)] px-4 py-3">
              <Dialog.Title className="text-[14px] font-semibold text-[var(--text-primary)]">
                Create isolated worktree
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">
                {isRunning
                  ? 'The current task is running. Create a separate worktree in a new thread or stop the task before moving this session.'
                  : 'Aegis will create a separate working directory for this session. It will not commit anything.'}
              </Dialog.Description>
            </div>
            <div className="space-y-3 px-4 py-4 text-[12px] text-[var(--text-secondary)]">
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5">
                <div className="flex items-center gap-2 text-[var(--text-primary)]">
                  <GitBranch className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                  <span className="min-w-0 truncate">{currentBranch}</span>
                </div>
                <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                  New worktree branch will be created from this branch.
                </div>
              </div>
              {!isRunning ? <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5">
                {worktreeChanges.loading ? (
                  <div className="flex items-center gap-2 text-[var(--text-muted)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Checking current changes...</span>
                  </div>
                ) : worktreeChanges.error ? (
                  <div className="text-[var(--text-muted)]">{worktreeChanges.error}</div>
                ) : worktreeChanges.totalChanges && worktreeChanges.totalChanges > 0 ? (
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">
                      {worktreeChanges.totalChanges} uncommitted file{worktreeChanges.totalChanges === 1 ? '' : 's'} found
                    </div>
                    <div className="mt-1 leading-5 text-[var(--text-muted)]">
                      Choose whether to leave them here or temporarily stash and copy them into the new worktree.
                    </div>
                  </div>
                ) : (
                  <div className="text-[var(--text-muted)]">
                    No uncommitted changes found. A clean worktree will be created.
                  </div>
                )}
              </div> : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              <button
                type="button"
                onClick={() => setWorktreeDialogOpen(false)}
                className="rounded-md px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              {isRunning ? (
                <>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => createNewWorktree(false)}
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Create worktree + new thread
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => setStopConfirmAction({ kind: 'new-worktree' })}
                    className="rounded-md bg-[var(--error)] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Stop task and switch
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busyAction !== null || worktreeChanges.loading}
                    onClick={() => createNewWorktree(false)}
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Create clean worktree
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null || worktreeChanges.loading || !worktreeChanges.totalChanges}
                    onClick={() => createNewWorktree(true)}
                    className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--accent-foreground)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Bring current changes
                  </button>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={branchDialog !== null} onOpenChange={(open) => { if (!open) setBranchDialog(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay {...environmentHubLayerProps} className="fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Content {...environmentHubLayerProps} className="fixed left-1/2 top-1/2 z-[100] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_60px_rgba(15,23,42,0.18)] outline-none">
            <div className="border-b border-[var(--border)] px-4 py-3">
              <Dialog.Title className="text-[14px] font-semibold text-[var(--text-primary)]">
                {branchDialog?.reason === 'running' ? 'Open branch safely' : 'Uncommitted changes'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">
                {branchDialog?.reason === 'running'
                  ? 'The current task is running. Use a separate worktree/thread or stop the task before switching this session.'
                  : `${branchDialog?.dirtyCount ?? 'Some'} uncommitted file${branchDialog?.dirtyCount === 1 ? '' : 's'} found. Switching branches may carry these changes to the target branch or fail if files conflict.`}
              </Dialog.Description>
            </div>
            {branchDialog ? (
              <div className="px-4 py-3 text-[12px] text-[var(--text-secondary)]">
                <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-[var(--text-primary)]">
                  <GitBranch className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                  <span className="min-w-0 truncate">{branchDialog.entry.name}</span>
                  {branchDialog.entry.worktreePath ? <GitFork className="h-3.5 w-3.5 text-[var(--text-muted)]" /> : null}
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              <button
                type="button"
                onClick={() => setBranchDialog(null)}
                className="rounded-md px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              {branchDialog?.reason === 'running' ? (
                <>
                  {branchDialog.entry.worktreePath ? (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => {
                        const entry = branchDialog.entry;
                        setBranchDialog(null);
                        openExistingWorktreeInNewThread(entry);
                      }}
                      className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Open in new thread
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => {
                        const entry = branchDialog.entry;
                        setBranchDialog(null);
                        void createWorktreeAndOpenThread(entry.name);
                      }}
                      className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Create worktree + new thread
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => setStopConfirmAction({ kind: 'branch', entry: branchDialog.entry })}
                    className="rounded-md bg-[var(--error)] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Stop task and switch
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busyAction !== null || !branchDialog}
                    onClick={() => {
                      const entry = branchDialog?.entry;
                      setBranchDialog(null);
                      if (entry) void runBranchCheckout(entry);
                    }}
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Continue checkout
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null || !branchDialog}
                    onClick={() => {
                      const entry = branchDialog?.entry;
                      setBranchDialog(null);
                      if (entry) void runHandoff('worktree', entry.name, null, false);
                    }}
                    className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--accent-foreground)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Create worktree instead
                  </button>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={stopConfirmAction !== null} onOpenChange={(open) => { if (!open) setStopConfirmAction(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay {...environmentHubLayerProps} className="fixed inset-0 z-[110] bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Content {...environmentHubLayerProps} className="fixed left-1/2 top-1/2 z-[120] w-[min(400px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_60px_rgba(15,23,42,0.18)] outline-none">
            <div className="border-b border-[var(--border)] px-4 py-3">
              <Dialog.Title className="text-[14px] font-semibold text-[var(--text-primary)]">
                Stop current task?
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">
                This will stop the running task first. After it is idle, Aegis will continue with the workspace switch you selected.
              </Dialog.Description>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              <button
                type="button"
                onClick={() => setStopConfirmAction(null)}
                className="rounded-md px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => {
                  const action = stopConfirmAction;
                  setStopConfirmAction(null);
                  if (action) requestStopThenSwitch(action);
                }}
                className="rounded-md bg-[var(--error)] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Stop task
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <DropdownMenu.Root modal={!panelVariant} onOpenChange={(open) => { if (open) void refreshBranches(); }}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={branchButtonClass}
            disabled={busyAction !== null}
            title={currentBranch}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            {panelVariant ? <span className="text-[var(--text-muted)]">Branch</span> : null}
            <span className="min-w-0 flex-1 truncate text-left">{currentBranch}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            {...environmentHubLayerProps}
            align="start"
            sideOffset={6}
            className="scrollbar-slim z-[9999] max-h-[320px] min-w-[240px] overflow-y-auto rounded-[var(--popover-radius)] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 shadow-[var(--popover-shadow)]"
          >
            {branchesError ? (
              <div className="px-2 py-1.5 text-xs text-[var(--text-muted)]">{branchesError}</div>
            ) : branchOptions.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-[var(--text-muted)]">
                {branchesLoading ? 'Loading branches…' : 'No branches'}
              </div>
            ) : (
              branchOptions.map((entry) => (
                <DropdownMenu.Item
                  key={`${entry.fullRef}:${entry.worktreePath || ''}`}
                  disabled={busyAction !== null}
                  onSelect={(event) => {
                    event.preventDefault();
                    void handleSelectBranch(entry);
                  }}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--sidebar-item-hover)]"
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.worktreePath ? <GitFork className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" /> : null}
                  {entry.current ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                </DropdownMenu.Item>
              ))
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

export function ChatPane({
  paneId,
  sessionId,
  isActive,
  onActivate,
  codexModelConfig,
  dropHint,
  onDropSession,
  onClose,
  headerActions,
  onWorkspaceGitChanged,
}: {
  paneId: string;
  sessionId: string | null;
  isActive: boolean;
  onActivate: () => void;
  codexModelConfig: import('../types').CodexModelConfig;
  dropHint?: string | null;
  onDropSession?: (sessionId: string) => void;
  onClose?: () => void;
  headerActions?: ReactNode;
  onWorkspaceGitChanged?: () => Promise<void>;
}) {
  const {
    sessions,
    historyNavigationTarget,
    loadOlderSessionHistory,
    setHistoryNavigationTarget,
    removePermissionRequest,
    openReviewDiff,
    requestChatInjection,
    setActiveSettingsTab,
    setShowSettings,
    createDraftSession,
    removeDraftSession,
    draftStartMode,
    setDraftStartMode,
  } = useAppStore();
  const session = sessionId ? sessions[sessionId] : null;
  const scrollPositionKey = sessionId ? getChatScrollPositionKey(paneId, sessionId) : null;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const historyRequested = useRef(new Set<string>());
  const scrollUpdateStateRef = useRef<{ key: string; messageCount: number } | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const scrollHeightBeforeLoadRef = useRef<number>(0);
  const historyHighlightTimerRef = useRef<number | null>(null);
  const [highlightedHistoryAnchor, setHighlightedHistoryAnchor] = useState<string | null>(null);
  const activePlanMessage = useMemo(() => {
    if (!session || session.provider !== 'codex' || session.status !== 'running') {
      return null;
    }
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index];
      if (message?.type === 'plan_update' && message.steps.length > 0) {
        return message;
      }
    }
    return null;
  }, [session?.messages, session?.provider, session?.status]);

  const { partialMessage, partialThinking, isStreaming: showPartialMessage } = useMemo(() => {
    if (!session) {
      return { partialMessage: '', partialThinking: '', isStreaming: false };
    }

    return {
      partialMessage: session.streaming.text,
      partialThinking: session.streaming.thinking,
      isStreaming: session.streaming.isStreaming,
    };
  }, [session?.streaming.text, session?.streaming.thinking, session?.streaming.isStreaming]);

  const streamingAssistantText = useMemo(() => {
    if (!session) return '';
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const message = session.messages[i];
      if (message.type !== 'assistant' || message.streaming !== true) {
        continue;
      }
      return getMessageContentBlocks(message)
        .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
        .map((block) => block.text || '')
        .join('\n');
    }
    return '';
  }, [session?.messages]);

  const { toolStatusMap, toolResultsMap } = useMemo(() => {
    const statusMap = new Map<string, ToolStatus>();
    const resultsMap = new Map<string, ToolResultBlock>();
    if (!session) return { toolStatusMap: statusMap, toolResultsMap: resultsMap };

    for (const msg of session.messages) {
      if (msg.type !== 'assistant' && msg.type !== 'user') continue;
      for (const block of getMessageContentBlocks(msg)) {
        const normalizedUse = normalizeToolUseBlock(block);
        if (normalizedUse) {
          if (!statusMap.has(normalizedUse.id)) {
            statusMap.set(normalizedUse.id, 'pending');
          }
          continue;
        }
        const normalizedResult = normalizeToolResultBlock(block);
        if (normalizedResult) {
          statusMap.set(
            normalizedResult.tool_use_id,
            normalizedResult.is_error ? 'error' : 'success'
          );
          resultsMap.set(normalizedResult.tool_use_id, {
            type: 'tool_result',
            tool_use_id: normalizedResult.tool_use_id,
            content: normalizedResult.content,
            is_error: normalizedResult.is_error,
          });
        }
      }
    }

    return { toolStatusMap: statusMap, toolResultsMap: resultsMap };
  }, [session?.messages]);

  const hasRunningTool = useMemo(
    () => (session ? hasRunningToolInMessages(session.messages, toolStatusMap) : false),
    [session?.messages, toolStatusMap]
  );

  const turnPhase = useMemo(() => {
    if (!session) return 'complete' as const;

    const isRunning = session.status === 'running';
    const isStreaming = showPartialMessage || streamingAssistantText.length > 0;

    return deriveTurnPhase(session.messages, isRunning, hasRunningTool, isStreaming);
  }, [session?.messages, session?.status, hasRunningTool, showPartialMessage, streamingAssistantText]);

  const lastUserPromptIndex = useMemo(() => {
    if (!session) return -1;
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      if (session.messages[i]?.type === 'user_prompt') {
        return i;
      }
    }
    return -1;
  }, [session?.messages]);

  // ── Claude rewind ──────────────────────────────────────────────────────────
  const [rewindTarget, setRewindTarget] = useState<ClaudeRewindTarget | null>(null);

  // The checkpoint anchor is the SDK user message (uuid-bearing) that follows
  // the display-only user_prompt; older histories may not have one persisted.
  const resolveRewindTarget = useCallback(
    (userPromptIndex: number): ClaudeRewindTarget | null => {
      if (!sessionId || !session || session.provider !== 'claude') return null;
      const promptMessage = session.messages[userPromptIndex];
      if (promptMessage?.type !== 'user_prompt') return null;
      for (let index = userPromptIndex + 1; index < session.messages.length; index += 1) {
        const message = session.messages[index];
        if (!message) continue;
        if (message.type === 'user_prompt') break;
        if (message.type !== 'user') continue;
        const uuid = (message as { uuid?: unknown }).uuid;
        if (typeof uuid !== 'string' || !uuid) continue;
        const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
        if (!blocks.some((block) => block?.type === 'text')) continue;
        return {
          sessionId,
          anchorMessageId: uuid,
          promptPreview: promptMessage.prompt || '',
        };
      }
      return null;
    },
    [session, sessionId]
  );

  // `/rewind` in the composer opens the dialog for the latest user message.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      if (!session || session.status === 'running') return;
      for (let index = session.messages.length - 1; index >= 0; index -= 1) {
        if (session.messages[index]?.type !== 'user_prompt') continue;
        const target = resolveRewindTarget(index);
        if (target) {
          setRewindTarget(target);
          return;
        }
      }
      toast.error('No rewindable message found in this session.');
    };
    window.addEventListener('aegis-claude-rewind-open', handler);
    return () => window.removeEventListener('aegis-claude-rewind-open', handler);
  }, [resolveRewindTarget, session, sessionId]);
  const activeTurnStartedAt = useMemo(() => {
    if (!session || lastUserPromptIndex < 0) {
      return undefined;
    }
    const createdAt = (session.messages[lastUserPromptIndex] as { createdAt?: unknown })?.createdAt;
    return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : undefined;
  }, [lastUserPromptIndex, session?.messages]);

  const timelineItems = useMemo(
    () =>
      session
        ? deriveTranscriptTimelineItems(session.messages, {
            activeTurnStartIndex: lastUserPromptIndex,
            sessionRunning: session.status === 'running',
          })
        : [],
    [lastUserPromptIndex, session?.messages, session?.status]
  );
  const activeTimelineWorkId = useMemo(() => {
    for (let index = timelineItems.length - 1; index >= 0; index -= 1) {
      const item = timelineItems[index];
      if (item?.type === 'work' && item.active) {
        return item.group.id;
      }
    }
    return null;
  }, [timelineItems]);
  const hasActiveTimelineWork = useMemo(
    () => Boolean(activeTimelineWorkId),
    [activeTimelineWorkId]
  );

  const { turns, changeRecordByToolUseId, changeRecordsByToolUseId } = useMemo(
    () =>
      session
        ? buildTurnChangeContext(session.messages)
        : {
            turns: [] as TurnChangeSummary[],
            changeRecordByToolUseId: new Map<string, ChangeRecord>(),
            changeRecordsByToolUseId: new Map<string, ChangeRecord[]>(),
          },
    [session?.messages]
  );

  const turnCardByTimelineIndex = useMemo(() => {
    const map = new Map<number, TurnChangeSummary>();
    if (turns.length === 0 || timelineItems.length === 0) {
      return map;
    }

    let activeWorkLastMessageIndex: number | null = null;
    if (activeTimelineWorkId) {
      for (const item of timelineItems) {
        if (item.type === 'work' && item.group.id === activeTimelineWorkId) {
          const indices = item.group.originalIndices;
          activeWorkLastMessageIndex = indices[indices.length - 1] ?? null;
          break;
        }
      }
    }

    for (const turn of turns) {
      if (turn.totalFiles === 0) continue;
      if (
        activeWorkLastMessageIndex !== null &&
        turn.lastMessageIndex >= activeWorkLastMessageIndex
      ) {
        continue;
      }
      let lastIdx = -1;
      for (let i = 0; i < timelineItems.length; i += 1) {
        const item = timelineItems[i];
        const lastOrig =
          item.type === 'work'
            ? item.group.originalIndices[item.group.originalIndices.length - 1]
            : item.originalIndex;
        if (lastOrig <= turn.lastMessageIndex) {
          lastIdx = i;
        } else {
          break;
        }
      }
      if (lastIdx >= 0) {
        map.set(lastIdx, turn);
      }
    }
    return map;
  }, [turns, timelineItems, activeTimelineWorkId]);

  const copyPlacementByTimelineIndex = useMemo(() => {
    const actionTextByCardIndex = new Map<number, string>();
    const hiddenMessageIndices = new Set<number>();

    for (const [cardIndex, turn] of turnCardByTimelineIndex) {
      for (let index = cardIndex; index >= 0; index -= 1) {
        const item = timelineItems[index];
        if (!item) continue;

        const originalIndices =
          item.type === 'work'
            ? item.group.originalIndices
            : [item.originalIndex];
        const itemIsInTurn = originalIndices.some(
          (originalIndex) =>
            originalIndex >= turn.firstMessageIndex &&
            originalIndex <= turn.lastMessageIndex
        );
        if (!itemIsInTurn) {
          continue;
        }
        if (item.type !== 'message' || item.message.type !== 'assistant') {
          continue;
        }
        if (item.assistantPresentation === 'progress' || item.message.streaming === true) {
          continue;
        }

        const markdownToCopy = getAssistantMarkdownToCopy(item.message);
        if (!markdownToCopy.trim()) {
          continue;
        }

        actionTextByCardIndex.set(cardIndex, markdownToCopy);
        hiddenMessageIndices.add(index);
        break;
      }
    }

    return { actionTextByCardIndex, hiddenMessageIndices };
  }, [timelineItems, turnCardByTimelineIndex]);

  const handleOpenDiff = useCallback((
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => {
    const turn = turns.find((entry) => entry.records.some((candidate) => candidate.id === record.id));
    if (turn) {
      openReviewDiff(buildReviewTurnSelection(turn, sessionId, record));
      return;
    }

    openReviewDiff({
      source: {
        kind: 'turn',
        turnKey: scope?.turnKey || `record:${record.id}`,
        label: scope?.label || 'Selected file changes',
        sessionId,
      },
      records: scope?.records || [record],
      selectedRecordId: record.id,
      selectedFilePath: record.filePath,
    });
  }, [openReviewDiff, sessionId, turns]);

  const turnDiffContextValue = useMemo<TurnDiffContextValue>(
    () => ({
      changeRecordByToolUseId,
      changeRecordsByToolUseId,
      onOpenDiff: handleOpenDiff,
    }),
    [changeRecordByToolUseId, changeRecordsByToolUseId, handleOpenDiff]
  );

  const historyNavigationAnchor = useMemo(() => {
    if (!sessionId || !historyNavigationTarget || historyNavigationTarget.sessionId !== sessionId) {
      return null;
    }

    for (const item of timelineItems) {
      if (item.type === 'message' && item.message.createdAt === historyNavigationTarget.messageCreatedAt) {
        return String(item.originalIndex);
      }

      if (
        item.type === 'work' &&
        item.group.messages.some((message) => message.createdAt === historyNavigationTarget.messageCreatedAt)
      ) {
        return String(item.group.originalIndices[0]);
      }
    }

    return null;
  }, [historyNavigationTarget, sessionId, timelineItems]);

  const historyNavigationPending =
    !!historyNavigationTarget &&
    historyNavigationTarget.sessionId === sessionId &&
    !historyNavigationAnchor;

  const streamingWorkstreamModel = useMemo(
    () => {
      if (hasActiveTimelineWork) {
        return null;
      }
      return createStreamingWorkstreamModel({
        partialText: partialMessage,
        partialThinking,
        phase: turnPhase,
        startedAt: activeTurnStartedAt,
        permissionRequests: session?.permissionRequests || [],
      });
    },
    [
      activeTurnStartedAt,
      hasActiveTimelineWork,
      partialMessage,
      partialThinking,
      session?.permissionRequests,
      turnPhase,
    ]
  );
  const activeLiveTrace = useMemo(
    () => ({
      partialText: partialMessage,
      partialThinking,
      permissionRequests: session?.permissionRequests || [],
    }),
    [partialMessage, partialThinking, session?.permissionRequests]
  );
  const shouldRenderStandalonePartial =
    !hasActiveTimelineWork &&
    !streamingWorkstreamModel &&
    showPartialMessage &&
    partialMessage.length > 0;

  useEffect(() => {
    if (!sessionId || !session) {
      return;
    }

    if (!session.hydrated && !historyRequested.current.has(sessionId)) {
      historyRequested.current.add(sessionId);
      sendEvent({
        type: 'session.history',
        payload: { sessionId },
      });
    }
  }, [session, sessionId]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const count = session?.messages.length ?? 0;
    if (!container || !scrollPositionKey) {
      scrollUpdateStateRef.current = null;
      return;
    }

    const previous = scrollUpdateStateRef.current;
    const isNewScrollTarget = previous?.key !== scrollPositionKey;
    if (isNewScrollTarget) {
      restoreChatScrollPosition(scrollPositionKey, container);
    } else if (count > previous.messageCount && scrollHeightBeforeLoadRef.current > 0) {
      const delta = container.scrollHeight - scrollHeightBeforeLoadRef.current;
      if (delta > 0) {
        container.scrollTop += delta;
      }
    } else if (shouldStickToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }

    rememberChatScrollPosition(scrollPositionKey, container);
    shouldStickToBottomRef.current = isNearScrollBottom(container);
    scrollUpdateStateRef.current = { key: scrollPositionKey, messageCount: count };
    scrollHeightBeforeLoadRef.current = 0;
  }, [
    scrollPositionKey,
    session?.messages.length,
    session?.streaming.isStreaming,
    partialMessage,
    partialThinking,
    streamingAssistantText,
    showPartialMessage,
  ]);

  useEffect(() => {
    scrollHeightBeforeLoadRef.current = 0;
    setHighlightedHistoryAnchor(null);
  }, [sessionId]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !sessionId) return;

    if (scrollPositionKey) {
      rememberChatScrollPosition(scrollPositionKey, container);
      shouldStickToBottomRef.current = isNearScrollBottom(container);
    }

    if (!session?.hasMoreHistory || session?.loadingMoreHistory) return;
    if (container.scrollTop < 200) {
      scrollHeightBeforeLoadRef.current = container.scrollHeight;
      loadOlderSessionHistory(sessionId);
    }
  }, [
    loadOlderSessionHistory,
    scrollPositionKey,
    session?.hasMoreHistory,
    session?.loadingMoreHistory,
    sessionId,
  ]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      if (scrollPositionKey) {
        rememberChatScrollPosition(scrollPositionKey, container);
      }
      container.removeEventListener('scroll', handleScroll);
    };
  }, [handleScroll, scrollPositionKey]);

  useEffect(() => {
    if (!historyNavigationTarget || !sessionId || historyNavigationTarget.sessionId !== sessionId) {
      return;
    }

    if (!session?.hydrated) {
      return;
    }

    if (!historyNavigationAnchor) {
      if (session.hasMoreHistory && !session.loadingMoreHistory) {
        if (scrollContainerRef.current) {
          scrollHeightBeforeLoadRef.current = scrollContainerRef.current.scrollHeight;
        }
        loadOlderSessionHistory(sessionId);
        return;
      }

      if (!session.hasMoreHistory && !session.loadingMoreHistory) {
        toast.error('Could not locate the selected message in session history.');
        setHistoryNavigationTarget(null);
      }
      return;
    }

    const selector = `[data-message-index="${historyNavigationAnchor}"]`;
    const messageEl = scrollContainerRef.current?.querySelector(selector);
    if (!messageEl) {
      return;
    }

    messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedHistoryAnchor(historyNavigationAnchor);
    setHistoryNavigationTarget(null);

    if (historyHighlightTimerRef.current !== null) {
      window.clearTimeout(historyHighlightTimerRef.current);
    }

    historyHighlightTimerRef.current = window.setTimeout(() => {
      setHighlightedHistoryAnchor((current) => (current === historyNavigationAnchor ? null : current));
      historyHighlightTimerRef.current = null;
    }, 2400);
  }, [
    historyNavigationAnchor,
    historyNavigationTarget,
    loadOlderSessionHistory,
    session?.hasMoreHistory,
    session?.hydrated,
    session?.loadingMoreHistory,
    sessionId,
    setHistoryNavigationTarget,
  ]);

  useEffect(() => {
    return () => {
      if (historyHighlightTimerRef.current !== null) {
        window.clearTimeout(historyHighlightTimerRef.current);
      }
    };
  }, []);

  const handlePermissionResult = (toolUseId: string, result: PermissionResult) => {
    if (!sessionId) return;

    sendEvent({
      type: 'permission.response',
      payload: {
        sessionId,
        toolUseId,
        result,
      },
    });

    removePermissionRequest(sessionId, toolUseId);
  };

  const permissionQueue = session?.permissionRequests || [];
  const activePermissionRequest = permissionQueue[0] || null;

  // A freshly created draft thread with no messages shows the centered landing
  // (title + composer + starter suggestions), matching the first-entry screen.
  const showThreadStarter = Boolean(
    session &&
      session.scope !== 'dm' &&
      session.messages.length === 0 &&
      // Only treat an empty session as a fresh thread once we know it's actually
      // empty. Drafts/new sessions are created hydrated; an existing session that
      // hasn't loaded its history yet is hydrated=false with messages=[], and must
      // not flash the New Thread landing while its history is still loading (e.g.
      // right after dropping it into the Side Chat).
      session.hydrated &&
      session.status !== 'running' &&
      !session.readOnly &&
      !activePermissionRequest
  );
  const threadStarterCwd = session?.projectCwd || session?.cwd || '';
  const threadStarterProject = threadStarterCwd
    ? threadStarterCwd.split('/').filter(Boolean).pop() || threadStarterCwd
    : '';
  const threadStarterHeading = threadStarterProject
    ? `What should we build in ${threadStarterProject}?`
    : 'What can I help you with?';
  const openConnectAppsSettings = () => {
    setActiveSettingsTab('mcp');
    setShowSettings(true);
  };

  // Recent folders for the new-thread context pill's project dropdown.
  const [threadStarterRecentCwds, setThreadStarterRecentCwds] = useState<string[]>([]);
  useEffect(() => {
    if (!showThreadStarter) return;
    let active = true;
    window.electron.getRecentCwds(8).then((dirs) => {
      if (active) setThreadStarterRecentCwds(dirs);
    });
    return () => {
      active = false;
    };
  }, [showThreadStarter]);
  const threadStarterRecentOptions = useMemo(() => {
    if (!threadStarterCwd) return threadStarterRecentCwds.slice(0, 6);
    return [threadStarterCwd, ...threadStarterRecentCwds.filter((dir) => dir !== threadStarterCwd)].slice(0, 6);
  }, [threadStarterCwd, threadStarterRecentCwds]);
  // Switching the draft's folder starts a fresh draft in that folder and
  // discards the current empty one (so we don't pile up orphan drafts).
  const switchDraftFolder = useCallback(
    (dir: string) => {
      if (!dir || dir === threadStarterCwd || !sessionId) return;
      createDraftSession(dir, session?.channelId || null, { projectCwd: dir });
      removeDraftSession(sessionId);
    },
    [createDraftSession, removeDraftSession, session?.channelId, threadStarterCwd, sessionId]
  );
  const handleThreadStarterBrowse = useCallback(() => {
    void window.electron.selectDirectory().then((dir) => {
      if (dir) switchDraftFolder(dir);
    });
  }, [switchDraftFolder]);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const droppedSessionId = event.dataTransfer.getData('application/x-aegis-session-id');
    if (!droppedSessionId || !onDropSession) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onDropSession(droppedSessionId);
  };

  return (
    <div
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)] transition-colors ${
        isActive
          ? 'bg-[var(--bg-primary)]'
          : 'bg-[color-mix(in_srgb,var(--bg-primary)_96%,var(--bg-secondary))]'
      }`}
      onMouseDown={() => {
        if (!isActive && (sessionId || !onDropSession)) {
          onActivate();
        }
      }}
      onDragOver={(event) => {
        if (onDropSession) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={handleDrop}
    >
      {dropHint ? (
        <div className="pointer-events-none absolute inset-6 z-10 flex items-center justify-center rounded-[var(--radius-2xl)] border-2 border-dashed border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent-light)_75%,transparent)] text-sm font-medium text-[var(--text-primary)]">
          {dropHint}
        </div>
      ) : null}

      {!session ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-sm">
            <div className="text-sm font-medium text-[var(--text-primary)]">Drop a conversation here</div>
            <div className="mt-2 text-sm text-[var(--text-muted)]">
              Drag a thread from the sidebar to open it in this pane.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex h-9 items-center justify-between bg-[var(--bg-primary)] px-3">
            <div className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <span className="truncate font-medium text-[var(--text-primary)]">
                {session.title || 'Chat'}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {headerActions}
              {onClose ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose();
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                  aria-label="Close pane"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
          {showThreadStarter ? (
            <NewThreadLanding
              heading={threadStarterHeading}
              onPickSuggestion={(text) =>
                requestChatInjection({ sessionId, text, mode: 'replace' })
              }
              onConnectApps={openConnectAppsSettings}
            >
              <div className="mx-auto w-full max-w-3xl">
                <PromptInput
                  sessionId={sessionId}
                  menuSide="bottom"
                  composerSurface="landing"
                  footer={
                    <ComposerContextPills
                      cwd={threadStarterCwd || null}
                      projectName={threadStarterProject}
                      hasSelectedCwd={Boolean(threadStarterCwd)}
                      onBrowse={handleThreadStarterBrowse}
                      recentOptions={threadStarterRecentOptions}
                      onSelectRecent={switchDraftFolder}
                      sessionId={sessionId}
                      startMode={sessionId ? draftStartMode[sessionId] || 'local' : 'local'}
                      onStartModeChange={(mode) => {
                        if (sessionId) setDraftStartMode(sessionId, mode);
                      }}
                    />
                  }
                />
              </div>
            </NewThreadLanding>
          ) : (
          <>
          <div ref={scrollContainerRef} className="flex-1 overflow-auto p-4 relative">
            {isActive ? <InSessionSearch /> : null}

            {session.readOnly && (
              <div className="mb-4 flex justify-center">
                <div className="max-w-[760px] rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                  This conversation is read-only in Aegis.
                </div>
              </div>
            )}

            <div className="message-container">
              {historyNavigationPending && (
                <div className="mb-4 flex justify-center">
                  <div className="rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-secondary)]">
                    {session.loadingMoreHistory ? 'Loading matched message from older history…' : 'Locating matched message…'}
                  </div>
                </div>
              )}

              {session.hasMoreHistory && session.loadingMoreHistory && (
                <div className="mb-4 flex justify-center">
                  <div className="rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-secondary)]">
                    Loading older messages…
                  </div>
                </div>
              )}

              <TurnDiffContext.Provider value={turnDiffContextValue}>
                {timelineItems.map((item, idx) => {
                  const turnCard = turnCardByTimelineIndex.get(idx);
                  if (item.type === 'work') {
                    const anchor = String(item.group.originalIndices[0]);
                    const highlighted = highlightedHistoryAnchor === anchor;
                    const copyActionText = turnCard
                      ? copyPlacementByTimelineIndex.actionTextByCardIndex.get(idx) || ''
                      : '';
                    return (
                      <div key={item.group.id} className={copyActionText ? 'group' : undefined}>
                        <div
                          data-message-index={item.group.originalIndices[0]}
                          className={highlighted ? 'rounded-2xl transition-colors duration-300' : undefined}
                          style={
                            highlighted
                              ? {
                                  backgroundColor: 'color-mix(in srgb, var(--accent-light) 70%, transparent)',
                                  boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent)',
                                }
                              : undefined
                          }
                        >
                          <ToolExecutionBatch
                            messages={item.group.messages}
                            toolStatusMap={toolStatusMap}
                            toolResultsMap={toolResultsMap}
                            isSessionRunning={session.status === 'running'}
                            isLastBatch={item.active}
                            startedAt={item.active ? activeTurnStartedAt : undefined}
                            liveTrace={item.group.id === activeTimelineWorkId ? activeLiveTrace : undefined}
                            defaultExpanded={item.defaultExpanded}
                            resetKey={item.disclosureResetKey}
                          />
                        </div>
                        {copyActionText ? <AssistantCopyAction text={copyActionText} /> : null}
                      </div>
                    );
                  }

                  const anchor = String(item.originalIndex);
                  const highlighted = highlightedHistoryAnchor === anchor;
                  const copyActionText = turnCard
                    ? copyPlacementByTimelineIndex.actionTextByCardIndex.get(idx) || ''
                    : '';
                  const hideAssistantCopyBar = copyPlacementByTimelineIndex.hiddenMessageIndices.has(idx);
                  const showTurnChangesCard = Boolean(turnCard) && !item.inlineWorkGroup;
                  return (
                    <div key={`message-${item.originalIndex}`} className={copyActionText ? 'group' : undefined}>
                      <div
                        data-message-index={item.originalIndex}
                        className={highlighted ? 'rounded-2xl transition-colors duration-300' : undefined}
                        style={
                          highlighted
                            ? {
                                backgroundColor: 'color-mix(in srgb, var(--accent-light) 70%, transparent)',
                                boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent)',
                              }
                            : undefined
                        }
                      >
                        <MessageCard
                          sessionId={sessionId}
                          message={item.message}
                          toolStatusMap={toolStatusMap}
                          toolResultsMap={toolResultsMap}
                          assistantPresentation={item.assistantPresentation}
                          hideAssistantCopyBar={hideAssistantCopyBar}
                          userPromptActions={
                            item.message.type === 'user_prompt' &&
                            session.readOnly !== true &&
                            (session.provider === 'claude' ||
                              session.provider === 'codex' ||
                              session.provider === 'opencode' ||
                              session.provider === 'pi')
                              ? {
                                  canEditAndRetry: item.originalIndex === lastUserPromptIndex,
                                  isSessionRunning: session.status === 'running',
                                  onRewind:
                                    session.provider === 'claude' && resolveRewindTarget(item.originalIndex)
                                      ? () => {
                                          const target = resolveRewindTarget(item.originalIndex);
                                          if (target) setRewindTarget(target);
                                        }
                                      : undefined,
                                  onResend: (prompt: string, attachments) => {
                                    if (!sessionId) return;
                                    if (!prompt.trim() && (!attachments || attachments.length === 0)) return;
                                    if (session.status === 'running') return;

                                    sendEvent({
                                      type: 'session.editLatestPrompt',
                                      payload: {
                                        sessionId,
                                        prompt: prompt.trim(),
                                        attachments: attachments && attachments.length > 0 ? attachments : undefined,
                                        provider: session.provider,
                                        model:
                                          session.provider === 'codex'
                                            ? resolveCodexModel(session.model, codexModelConfig) || undefined
                                            : session.model,
                                        compatibleProviderId: session.compatibleProviderId,
                                        betas: session.betas,
                                        claudeAccessMode:
                                          session.provider === 'claude'
                                            ? session.claudeAccessMode || 'default'
                                            : undefined,
                                        claudeExecutionMode:
                                          session.provider === 'claude'
                                            ? session.claudeExecutionMode || 'execute'
                                            : undefined,
                                        codexExecutionMode:
                                          session.provider === 'codex'
                                            ? session.codexExecutionMode || 'execute'
                                            : undefined,
                                        codexPermissionMode:
                                          session.provider === 'codex'
                                            ? session.codexPermissionMode || 'defaultPermissions'
                                            : undefined,
                                        codexReasoningEffort:
                                          session.provider === 'codex' ? session.codexReasoningEffort : undefined,
                                        codexFastMode:
                                          session.provider === 'codex' ? session.codexFastMode === true : undefined,
                                        opencodePermissionMode:
                                          session.provider === 'opencode'
                                            ? session.opencodePermissionMode || 'defaultPermissions'
                                            : undefined,
                                      },
                                    });
                                  },
                                }
                              : undefined
                          }
                        />
                        {item.inlineWorkGroup ? (
                          <div className="-mt-1 pl-1">
                            <ToolExecutionBatch
                              messages={item.inlineWorkGroup.messages}
                              toolStatusMap={toolStatusMap}
                              toolResultsMap={toolResultsMap}
                              isSessionRunning={false}
                              defaultExpanded={false}
                            />
                          </div>
                        ) : null}
                      </div>
                      {showTurnChangesCard && turnCard ? <TurnChangesCard summary={turnCard} /> : null}
                      {copyActionText ? <AssistantCopyAction text={copyActionText} /> : null}
                    </div>
                  );
                })}
              </TurnDiffContext.Provider>

              {(streamingWorkstreamModel || shouldRenderStandalonePartial) && (
                <div className="my-2 min-w-0 overflow-x-auto streaming-content">
                  {streamingWorkstreamModel ? (
                    <WorkstreamDisclosure
                      model={streamingWorkstreamModel}
                      isRunning={turnPhase !== 'complete'}
                      defaultExpanded={turnPhase !== 'complete'}
                      resetKey={`${sessionId}:${lastUserPromptIndex}`}
                    />
                  ) : null}
                  {shouldRenderStandalonePartial ? (
                    <ErrorBoundary
                      resetKey={partialMessage}
                      fallback={
                        <div className="rounded bg-gray-800 p-3">
                          <pre className="whitespace-pre-wrap break-words text-sm text-gray-300">
                            {partialMessage}
                          </pre>
                        </div>
                      }
                    >
                      <StructuredResponse content={partialMessage} streaming />
                    </ErrorBoundary>
                  ) : null}
                </div>
              )}

              {/* Single source of "Working for Xs..." footer during streaming.
                  If the active timeline row or live streaming workstream is
                  present, that surface already renders its own footer. */}
              {(() => {
                if (session.status !== 'running') return null;
                if (streamingWorkstreamModel) return null;
                if (hasActiveTimelineWork) return null;
                if (turnPhase === 'complete') return null;
                return <WorkingFooter startedAt={activeTurnStartedAt} />;
              })()}

              <div />
            </div>
          </div>

          {session.readOnly ? null : (
            <div className="px-8 pb-4">
              {activePermissionRequest ? (
                <PromptInput
                  sessionId={sessionId}
                  approvalPending
                  approvalPanel={
                    <ComposerPendingPermissionPanel
                      request={activePermissionRequest}
                      pendingCount={permissionQueue.length}
                      onSubmit={handlePermissionResult}
                    />
                  }
                />
              ) : (
                <>
                  {activePlanMessage ? (
                    <CodexActivePlanCard
                      explanation={activePlanMessage.explanation}
                      steps={activePlanMessage.steps}
                    />
                  ) : null}
                  <PromptInput sessionId={sessionId} />
                </>
              )}
            </div>
          )}
          </>
          )}

          <ClaudeRewindDialog
            target={rewindTarget}
            onClose={() => setRewindTarget(null)}
            onRewound={(removedPrompt) => {
              if (removedPrompt && sessionId) {
                window.dispatchEvent(
                  new CustomEvent('aegis-composer-set-prompt', {
                    detail: { sessionId, text: removedPrompt },
                  })
                );
              }
            }}
          />
        </>
      )}
    </div>
  );
}
