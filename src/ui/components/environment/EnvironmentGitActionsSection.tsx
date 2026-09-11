import type { SessionPullRequestsState } from './useSessionPullRequests';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Dialog from '@/ui/components/ui/dialog';
import { toast } from 'sonner';
import {
  ExternalLink,
  GitCommit,
  GitPullRequest,
  RefreshCw,
  Sparkles,
  Upload,
  X,
} from '../icons';
import type { GitOverviewResult } from '../../../shared/types';
import type { ActiveEnvironmentContext } from './useActiveEnvironmentContext';
import type { GitEnvironmentSnapshot, GitEnvironmentState } from './useGitEnvironment';

const COMMIT_GENERATION_MIN_VISIBLE_MS = 450;

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function gitSignature(overview: GitOverviewResult): string {
  return [
    overview.repoRoot || '',
    overview.branch || '',
    overview.upstream || '',
    overview.aheadCount,
    overview.behindCount,
    overview.totalChanges,
    overview.insertions,
    overview.deletions,
    overview.prStatus,
    overview.pr?.number || '',
  ].join(':');
}

function createFallbackCommitMessage(files: string[]): string {
  const allDocs = files.every((filePath) => /\.(md|mdx|txt)$/i.test(filePath));
  const allTests = files.every((filePath) => /\.(test|spec)\.[jt]sx?$/i.test(filePath) || filePath.includes('__tests__'));
  const allStyles = files.every((filePath) => /\.(css|scss|sass|less)$/i.test(filePath));
  const type = allDocs ? 'docs' : allTests ? 'test' : allStyles ? 'style' : 'chore';
  const target = files.some((filePath) => filePath.startsWith('src/ui/'))
    ? 'UI'
    : files.some((filePath) => filePath.startsWith('src/electron/'))
      ? 'electron'
      : files.length === 1
        ? files[0]
            .split('/')
            .pop()
            ?.replace(/\.[^.]+$/, '')
            .replace(/[-_]+/g, ' ')
            .toLowerCase()
            .trim() || 'project files'
        : 'project files';
  return `${type}: update ${target}`;
}

export function useEnvironmentGitActions({
  context,
  git,
  onPrCreated,
}: {
  context: ActiveEnvironmentContext;
  git: GitEnvironmentState;
  onPrCreated?: (url: string) => Promise<void>;
}) {
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitSnapshot, setCommitSnapshot] = useState<GitEnvironmentSnapshot | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [commitMode, setCommitMode] = useState<'commit' | 'commit_push'>('commit');
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitGenerating, setCommitGenerating] = useState(false);
  const [commitGenerationError, setCommitGenerationError] = useState<string | null>(null);
  const [pushLoading, setPushLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [prLoading, setPrLoading] = useState(false);

  const overview = git.overview;
  const busy = commitLoading || commitGenerating || pushLoading || syncLoading || prLoading;
  const hasChanges = overview.totalChanges > 0;
  const diverged = overview.aheadCount > 0 && overview.behindCount > 0;
  const mutatingDisabledReason =
    context.unavailableReason ||
    (!overview.hasRepo ? 'Not a Git repository.' : null) ||
    (!overview.ok ? 'Git state is unavailable. Refresh and try again.' : null) ||
    (!overview.branch ? 'Checking current branch.' : null) ||
    (context.isRunning ? 'The active task is running.' : null) ||
    (overview.branch === 'HEAD' ? 'Detached HEAD is not supported for this action.' : null);

  const validateSnapshot = useCallback(async (snapshot: GitEnvironmentSnapshot) => {
    if (context.contextKey !== snapshot.contextKey || context.effectiveCwd !== snapshot.cwd) {
      throw new Error('Environment changed. Refresh the panel before running this action.');
    }
    if (!snapshot.cwd) {
      throw new Error('No workspace path is available.');
    }

    const latest = await window.electron.getGitOverview(snapshot.cwd);
    if (!latest.ok || !latest.hasRepo) {
      throw new Error('Git state is no longer available for this workspace.');
    }
    if (latest.repoRoot !== snapshot.repoRoot || latest.branch !== snapshot.branch) {
      throw new Error('Repository or branch changed. Refresh before running this action.');
    }
    if (gitSignature(latest) !== snapshot.signature) {
      throw new Error('Git state changed. Refresh before running this action.');
    }
    return latest;
  }, [context.contextKey, context.effectiveCwd]);

  const generateCommitMessage = useCallback(async (cwd: string) => {
    const startedAt = Date.now();
    setCommitGenerating(true);
    setCommitGenerationError(null);
    try {
      const result = await window.electron.gitGenerateCommitMessage(cwd);
      if (result.ok && result.message) {
        setCommitMessage(result.message);
        return;
      }

      const changes = await window.electron.getGitChanges(cwd);
      if (changes.ok && changes.entries.length > 0) {
        setCommitMessage(createFallbackCommitMessage(changes.entries.map((entry) => entry.filePath)));
        setCommitGenerationError(result.message || 'Used a basic local suggestion.');
        return;
      }

      throw new Error(result.message || 'Failed to generate commit message.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate commit message.';
      setCommitGenerationError(message);
      toast.error(message);
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < COMMIT_GENERATION_MIN_VISIBLE_MS) {
        await wait(COMMIT_GENERATION_MIN_VISIBLE_MS - elapsed);
      }
      setCommitGenerating(false);
    }
  }, []);

  const openCommitDialog = useCallback((mode: 'commit' | 'commit_push') => {
    const snapshot = git.getSnapshot();
    if (!snapshot.cwd || mutatingDisabledReason || !hasChanges) {
      toast.error(mutatingDisabledReason || 'No changes to commit.');
      return;
    }
    setCommitSnapshot(snapshot);
    setCommitMode(mode);
    setCommitMessage('');
    setCommitGenerationError(null);
    setCommitDialogOpen(true);
    void generateCommitMessage(snapshot.cwd);
  }, [generateCommitMessage, git, hasChanges, mutatingDisabledReason]);

  const runPush = useCallback(async () => {
    const snapshot = git.getSnapshot();
    if (!snapshot.cwd || mutatingDisabledReason) {
      toast.error(mutatingDisabledReason || 'Cannot push this workspace.');
      return;
    }
    if (overview.totalChanges > 0) {
      toast.error('Commit or discard local changes before pushing.');
      return;
    }
    if (!overview.hasOriginRemote) {
      toast.error('No origin remote is configured.');
      return;
    }
    if (diverged) {
      toast.error('This branch has diverged. Rebase or merge manually before pushing.');
      return;
    }

    setPushLoading(true);
    try {
      await validateSnapshot(snapshot);
      const result = await window.electron.gitPush(snapshot.cwd);
      if (!result.ok) {
        toast.error(result.message || 'Push failed.');
        return;
      }
      toast.success(overview.hasUpstream ? 'Push completed.' : 'Branch published.');
      await git.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Push failed.');
      await git.refresh();
    } finally {
      setPushLoading(false);
    }
  }, [diverged, git, mutatingDisabledReason, overview.hasOriginRemote, overview.hasUpstream, overview.isDefaultBranch, overview.totalChanges, validateSnapshot]);

  const runSync = useCallback(async () => {
    const snapshot = git.getSnapshot();
    if (!snapshot.cwd || mutatingDisabledReason) {
      toast.error(mutatingDisabledReason || 'Cannot sync this workspace.');
      return;
    }
    if (overview.totalChanges > 0) {
      toast.error('Commit or discard local changes before syncing.');
      return;
    }
    if (diverged) {
      toast.error('This branch has diverged. Rebase or merge manually.');
      return;
    }
    if (overview.behindCount === 0) {
      toast.error('This branch is already up to date.');
      return;
    }

    setSyncLoading(true);
    try {
      await validateSnapshot(snapshot);
      const result = await window.electron.gitSync(snapshot.cwd);
      if (!result.ok) {
        toast.error(result.message || 'Sync failed.');
        return;
      }
      toast.success('Remote synced.');
      await git.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sync failed.');
      await git.refresh();
    } finally {
      setSyncLoading(false);
    }
  }, [diverged, git, mutatingDisabledReason, overview.behindCount, overview.totalChanges, validateSnapshot]);

  const runCreatePr = useCallback(async () => {
    const snapshot = git.getSnapshot();
    if (!snapshot.cwd || mutatingDisabledReason) {
      toast.error(mutatingDisabledReason || 'Cannot create a pull request.');
      return;
    }
    if (!overview.isGitHubRemote) {
      toast.error('Pull requests require a GitHub origin.');
      return;
    }
    if (overview.prStatus === 'unknown') {
      toast.error('Pull request status is unknown. Refresh or check GitHub authentication.');
      return;
    }
    if (overview.pr?.url) {
      await window.electron.openExternalUrl(overview.pr.url);
      return;
    }
    if (overview.isDefaultBranch || !overview.hasUpstream || overview.totalChanges > 0 || overview.aheadCount > 0 || overview.behindCount > 0) {
      toast.error('Publish a clean feature branch before creating a pull request.');
      return;
    }

    setPrLoading(true);
    try {
      await validateSnapshot(snapshot);
      const result = await window.electron.gitCreatePr(snapshot.cwd);
      if (!result.ok || !result.url) {
        toast.error(result.message || 'Failed to create pull request.');
        return;
      }
      toast.success('Pull request created.');
      await onPrCreated?.(result.url);
      await window.electron.openExternalUrl(result.url);
      await git.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create pull request.');
      await git.refresh();
    } finally {
      setPrLoading(false);
    }
  }, [git, onPrCreated, mutatingDisabledReason, overview.aheadCount, overview.behindCount, overview.hasUpstream, overview.isDefaultBranch, overview.isGitHubRemote, overview.pr, overview.prStatus, overview.totalChanges, validateSnapshot]);

  const runOpenPr = useCallback(async () => {
    if (!overview.pr?.url) return;
    const result = await window.electron.openExternalUrl(overview.pr.url);
    if (!result.ok) toast.error(result.message || 'Failed to open pull request.');
  }, [overview.pr?.url]);

  const runCommit = useCallback(async () => {
    const snapshot = commitSnapshot;
    const message = commitMessage.trim();
    if (!snapshot?.cwd || !message) return;

    setCommitLoading(true);
    try {
      await validateSnapshot(snapshot);
      const changes = await window.electron.getGitChanges(snapshot.cwd);
      if (!changes.ok) {
        toast.error('Failed to read git status.');
        return;
      }

      for (const entry of changes.entries.filter((item) => !item.staged)) {
        const stageResult = await window.electron.gitStagePath(snapshot.cwd, entry.filePath);
        if (!stageResult.ok) {
          toast.error(stageResult.message || `Failed to stage ${entry.filePath}.`);
          return;
        }
      }

      const commitResult = await window.electron.gitCommit(snapshot.cwd, message);
      if (!commitResult.ok) {
        toast.error(commitResult.message || 'Commit failed.');
        return;
      }

      if (commitMode === 'commit_push') {
        const pushResult = await window.electron.gitPush(snapshot.cwd);
        if (!pushResult.ok) {
          toast.error(pushResult.message || 'Push failed.');
          return;
        }
      }

      toast.success(commitMode === 'commit_push' ? 'Commit and push completed.' : 'Commit created.');
      setCommitDialogOpen(false);
      setCommitSnapshot(null);
      setCommitMessage('');
      await git.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Commit failed.');
      await git.refresh();
    } finally {
      setCommitLoading(false);
    }
  }, [commitMessage, commitMode, commitSnapshot, git, validateSnapshot]);

  useEffect(() => {
    if (!commitDialogOpen) return;
    if (!commitSnapshot || context.contextKey !== commitSnapshot.contextKey) {
      setCommitDialogOpen(false);
      setCommitSnapshot(null);
      toast.error('Environment changed. Reopen commit from the current environment.');
    }
  }, [commitDialogOpen, commitSnapshot, context.contextKey]);

  const actionState = useMemo(() => {
    const canCommit = !busy && !mutatingDisabledReason && hasChanges;
    const canSync = !busy && !mutatingDisabledReason && overview.behindCount > 0 && overview.totalChanges === 0 && !diverged;
    const canPush =
      !busy &&
      !mutatingDisabledReason &&
      overview.hasOriginRemote &&
      overview.totalChanges === 0 &&
      (!overview.hasUpstream || overview.aheadCount > 0) &&
      !diverged;
    const canCreatePr =
      !busy &&
      !mutatingDisabledReason &&
      overview.isGitHubRemote &&
      overview.prStatus === 'not_found' &&
      !overview.isDefaultBranch &&
      overview.hasUpstream &&
      overview.totalChanges === 0 &&
      overview.aheadCount === 0 &&
      overview.behindCount === 0;

    return { canCommit, canSync, canPush, canCreatePr };
  }, [busy, diverged, hasChanges, mutatingDisabledReason, overview.aheadCount, overview.behindCount, overview.hasOriginRemote, overview.hasUpstream, overview.isDefaultBranch, overview.isGitHubRemote, overview.prStatus, overview.totalChanges]);

  return {
    busy,
    operationLabel: commitLoading ? 'Committing…' : pushLoading ? 'Pushing…' : null,
    syncLoading,
    prLoading,
    actionState,
    mutatingDisabledReason,
    openCommitDialog,
    runPush,
    runSync,
    runCreatePr,
    runOpenPr,
    dialog: (
      <Dialog.Root open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay data-environment-hub-layer className="fixed inset-0 z-[90] bg-black/18 backdrop-blur-[1px]" />
          <Dialog.Content data-environment-hub-layer className="fixed left-1/2 top-1/2 z-[100] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_60px_rgba(15,23,42,0.18)] outline-none">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <Dialog.Title className="text-[14px] font-semibold text-[var(--text-primary)]">
                Commit all changes
              </Dialog.Title>
              <button
                type="button"
                onClick={() => setCommitDialogOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-3 px-4 py-3.5">
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--text-secondary)]">Branch</span>
                <span className="font-medium text-[var(--text-primary)]">{overview.branch || 'HEAD'}</span>
              </div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--text-secondary)]">Changes</span>
                <span className="flex items-center gap-2">
                  <span className="text-[var(--text-muted)]">{overview.totalChanges} files</span>
                  <span className="font-mono text-emerald-600">+{overview.insertions}</span>
                  <span className="font-mono text-[var(--error)]">-{overview.deletions}</span>
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-[var(--text-secondary)]">Message</span>
                <button
                  type="button"
                  onClick={() => commitSnapshot?.cwd && void generateCommitMessage(commitSnapshot.cwd)}
                  disabled={commitGenerating || commitLoading}
                  className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {commitGenerating ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  <span>{commitGenerating ? 'Generating...' : 'Generate'}</span>
                </button>
              </div>
              <textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder={commitGenerating ? 'Generating commit message...' : 'Commit message...'}
                rows={4}
                className="w-full resize-none rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-[13px] leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
              {commitGenerationError ? (
                <div className="text-[11px] leading-4 text-[var(--error)]">{commitGenerationError}</div>
              ) : null}
              <div className="space-y-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
                <label className="flex items-center gap-2.5 text-[13px] text-[var(--text-primary)]">
                  <input type="radio" checked={commitMode === 'commit'} onChange={() => setCommitMode('commit')} />
                  <span>Commit only</span>
                </label>
                <label className="flex items-center gap-2.5 text-[13px] text-[var(--text-primary)]">
                  <input type="radio" checked={commitMode === 'commit_push'} onChange={() => setCommitMode('commit_push')} />
                  <span>Commit and push</span>
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              <button
                type="button"
                onClick={() => setCommitDialogOpen(false)}
                className="inline-flex h-9 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void runCommit()}
                disabled={commitLoading || commitGenerating || !commitMessage.trim()}
                className="inline-flex h-9 min-w-[118px] items-center justify-center rounded-[var(--radius-lg)] bg-[var(--accent)] px-3.5 text-[13px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {commitLoading ? 'Working...' : commitMode === 'commit_push' ? 'Commit & Push' : 'Commit'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    ),
  };
}

function ActionButton({
  icon: Icon,
  label,
  detail,
  title,
  disabled,
  loading,
  trailing,
  onClick,
}: {
  icon: typeof GitCommit;
  label: string;
  detail?: string;
  title?: string;
  disabled?: boolean;
  loading?: boolean;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-busy={loading || undefined}
      onClick={onClick}
      className="environment-summary-row"
    >
      {loading ? <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Icon className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{detail}</span> : null}
      {trailing}
    </button>
  );
}

export function EnvironmentGitActionsSection({
  context,
  git,
  prs,
}: {
  context: ActiveEnvironmentContext;
  git: GitEnvironmentState;
  prs: SessionPullRequestsState;
}) {
  const actions = useEnvironmentGitActions({ context, git, onPrCreated: prs.attach });
  const overview = git.overview;
  const { canCommit, canPush, canSync, canCreatePr } = actions.actionState;
  const hasChanges = overview.totalChanges > 0;
  const diverged = overview.aheadCount > 0 && overview.behindCount > 0;
  const primaryReason = actions.mutatingDisabledReason ||
    (hasChanges ? 'Review and commit local changes.' :
      diverged ? 'Branch has diverged. Rebase or merge before pushing.' :
      !overview.hasOriginRemote ? 'No origin remote is configured.' :
      !overview.hasUpstream ? 'Publish this branch.' :
      overview.aheadCount > 0 ? 'Push local commits.' :
      overview.behindCount > 0 ? 'Sync remote changes first.' : 'No local changes or commits to push.');
  const syncReason = actions.mutatingDisabledReason ||
    (hasChanges ? 'Commit or discard local changes before syncing.' :
      diverged ? 'Branch has diverged. Rebase or merge before syncing.' : 'Sync remote changes.');
  const pr = overview.pr;

  return (
    <section className="flex flex-col gap-0.5 px-1.5">
      <ActionButton
        icon={hasChanges || !canPush ? GitCommit : Upload}
        label={actions.operationLabel || 'Commit or push'}
        detail={!actions.busy && !hasChanges && overview.aheadCount > 0 ? `${overview.aheadCount} to push` : undefined}
        title={primaryReason}
        // Background refresh retains a valid overview. Use its eligibility until
        // new data arrives; validateSnapshot checks again before any Git write.
        disabled={!canCommit && !canPush}
        loading={Boolean(actions.operationLabel)}
        onClick={() => hasChanges ? actions.openCommitDialog('commit') : void actions.runPush()}
      />
      {overview.behindCount > 0 ? (
        <ActionButton
          icon={RefreshCw}
          label={actions.syncLoading ? 'Syncing…' : 'Sync'}
          loading={actions.syncLoading}
          detail={`${overview.behindCount} behind`}
          title={syncReason}
          disabled={!canSync}
          onClick={() => void actions.runSync()}
        />
      ) : null}
      {actions.mutatingDisabledReason ? (
        <p className="px-2 py-1 text-[11px] leading-4 text-[var(--text-muted)]">{actions.mutatingDisabledReason}</p>
      ) : diverged ? (
        <p className="px-2 py-1 text-[11px] leading-4 text-[var(--text-muted)]">Branch has diverged. Rebase or merge before syncing.</p>
      ) : null}
      {pr?.url ? (prs.items.some(item => item.url.toLowerCase() === pr.url.toLowerCase()) ? null :
        <div className="flex items-center">
          <ActionButton
            icon={GitPullRequest}
            label="Existing pull request"
            detail={`#${pr.number}`}
            title={`${pr.title} · ${pr.state}`}
            onClick={() => void actions.runOpenPr()}
          />
          <button
            className="h-7 shrink-0 rounded-md px-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] disabled:opacity-50"
            disabled={!prs.canAttach || !overview.ok || !overview.branch}
            onClick={() => void prs.attach(pr.url)}
          >{prs.busy ? 'Attaching…' : 'Attach'}</button>
        </div>
      ) : overview.isGitHubRemote && overview.prStatus === 'unknown' ? (
        <ActionButton
          icon={GitPullRequest}
          label="Pull request status unavailable"
          title="Retry the lookup. If it still fails, check GitHub authentication."
          trailing={<RefreshCw className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />}
          onClick={() => void git.refresh()}
        />
      ) : canCreatePr || actions.prLoading ? (
        <ActionButton
          icon={GitPullRequest}
          label={actions.prLoading ? 'Creating pull request…' : 'Create pull request'}
          disabled={!canCreatePr}
          loading={actions.prLoading}
          onClick={() => void actions.runCreatePr()}
        />
      ) : null}
      {actions.dialog}
    </section>
  );
}
