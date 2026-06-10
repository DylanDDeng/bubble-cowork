import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import {
  CloudUpload,
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
}: {
  context: ActiveEnvironmentContext;
  git: GitEnvironmentState;
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
    if (overview.isDefaultBranch) {
      toast.error('Default branch pushes are disabled from Environment. Create a branch or worktree first.');
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
    if (overview.totalChanges > 0 || overview.aheadCount === 0 || overview.behindCount > 0) {
      toast.error('Push committed changes before creating a pull request.');
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
      await window.electron.openExternalUrl(result.url);
      await git.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create pull request.');
      await git.refresh();
    } finally {
      setPrLoading(false);
    }
  }, [git, mutatingDisabledReason, overview.aheadCount, overview.behindCount, overview.isGitHubRemote, overview.pr, overview.prStatus, overview.totalChanges, validateSnapshot]);

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
      overview.aheadCount > 0 &&
      !overview.isDefaultBranch &&
      !diverged;
    const canCreatePr =
      !busy &&
      !mutatingDisabledReason &&
      overview.isGitHubRemote &&
      overview.prStatus === 'not_found' &&
      overview.totalChanges === 0 &&
      overview.aheadCount > 0 &&
      overview.behindCount === 0;

    return { canCommit, canSync, canPush, canCreatePr };
  }, [busy, diverged, hasChanges, mutatingDisabledReason, overview.aheadCount, overview.behindCount, overview.hasOriginRemote, overview.isDefaultBranch, overview.isGitHubRemote, overview.prStatus, overview.totalChanges]);

  return {
    busy,
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
              {overview.isDefaultBranch ? (
                <div className="rounded-[var(--radius-lg)] border border-[var(--warning)]/35 bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-2 text-[12px] leading-5 text-[var(--text-primary)]">
                  This is the default branch. Prefer creating a branch or worktree before committing.
                </div>
              ) : null}
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
  disabled,
  onClick,
}: {
  icon: typeof GitCommit;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function EnvironmentGitActionsSection({
  context,
  git,
}: {
  context: ActiveEnvironmentContext;
  git: GitEnvironmentState;
}) {
  const actions = useEnvironmentGitActions({ context, git });
  const overview = git.overview;
  const pushLabel = overview.hasUpstream ? 'Push' : 'Publish';
  const prLabel = overview.pr?.url ? 'View PR' : overview.prStatus === 'unknown' ? 'PR unknown' : 'Create PR';

  return (
    <section className="space-y-2 border-t border-[var(--border)] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-primary)]">
          <CloudUpload className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <span>Commit and Push</span>
        </div>
        {actions.mutatingDisabledReason ? (
          <span className="truncate text-[10px] text-[var(--text-muted)]">{actions.mutatingDisabledReason}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <ActionButton icon={GitCommit} label="Commit..." disabled={!actions.actionState.canCommit} onClick={() => actions.openCommitDialog('commit')} />
        <ActionButton icon={Upload} label={pushLabel} disabled={!actions.actionState.canPush} onClick={() => void actions.runPush()} />
        <ActionButton icon={RefreshCw} label="Sync" disabled={!actions.actionState.canSync} onClick={() => void actions.runSync()} />
        <ActionButton
          icon={overview.pr?.url ? ExternalLink : GitPullRequest}
          label={prLabel}
          disabled={!overview.pr?.url && !actions.actionState.canCreatePr}
          onClick={() => overview.pr?.url ? void actions.runOpenPr() : void actions.runCreatePr()}
        />
      </div>
      {overview.aheadCount > 0 && overview.behindCount > 0 ? (
        <div className="text-[11px] leading-4 text-[var(--text-muted)]">
          Branch has diverged. Rebase or merge manually before syncing.
        </div>
      ) : overview.isDefaultBranch ? (
        <div className="text-[11px] leading-4 text-[var(--text-muted)]">
          Default branch push is disabled here. Create a branch or worktree first.
        </div>
      ) : null}
      {actions.dialog}
    </section>
  );
}
