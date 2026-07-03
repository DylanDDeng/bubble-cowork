import { useMemo, useState } from 'react';
import * as DropdownMenu from '@/ui/components/ui/dropdown-menu';
import * as Dialog from '@/ui/components/ui/dialog';
import { toast } from 'sonner';
import { Folder, FolderOpen, GitBranch, GitFork, ChevronDown, Check, Monitor, Plus, Search, X } from './icons';
import { useGitBranches } from '../hooks/useGitBranches';

export const CONTEXT_PILL_CLASS =
  'inline-flex max-w-[200px] items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]';

/**
 * Context row shown under the composer on the new-thread surfaces: a project
 * folder selector and — only when the folder is a git repository — the current
 * branch. Used by both the first-entry NewSessionView and the ChatPane "New
 * Thread" draft landing.
 */
export function ComposerContextPills({
  cwd,
  projectName,
  hasSelectedCwd,
  disabled,
  onBrowse,
  recentOptions,
  onSelectRecent,
  sessionId,
  startMode,
  onStartModeChange,
}: {
  cwd: string | null;
  projectName: string;
  hasSelectedCwd: boolean;
  disabled?: boolean;
  onBrowse: () => void;
  recentOptions: string[];
  onSelectRecent: (dir: string) => void;
  /** Draft session id (if any) — passed to checkout so a running session is guarded. */
  sessionId?: string | null;
  /** 启动模式：local（项目工作区）或 worktree（提交时新建隔离 worktree）。 */
  startMode?: 'local' | 'worktree';
  onStartModeChange?: (mode: 'local' | 'worktree') => void;
}) {
  const { current: branch, isRepo, localBranches, loading: branchesLoading, refresh: refreshBranches } =
    useGitBranches(hasSelectedCwd ? cwd : null);
  const [branchQuery, setBranchQuery] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [createBranchDialogOpen, setCreateBranchDialogOpen] = useState(false);
  const filteredLocalBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase();
    if (!query) return localBranches;
    return localBranches.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [branchQuery, localBranches]);
  const newBranchValidationMessage = useMemo(() => {
    const name = newBranchName.trim();
    if (!name) return null;
    if (name.endsWith('/')) return '分支名不能以“/”结尾。';
    if (name.includes('..')) return '分支名不能包含“..”。';
    if (localBranches.some((entry) => entry.name === name)) {
      return `分支 ${name} 已存在。`;
    }
    return null;
  }, [localBranches, newBranchName]);
  const canCreateBranch =
    newBranchName.trim().length > 0 && !newBranchValidationMessage && !creatingBranch;

  const handleSelectBranch = async (name: string) => {
    const dir = cwd?.trim();
    if (!dir || !name || name === branch) return;
    try {
      const result = await window.electron.gitCheckoutBranch({
        cwd: dir,
        branch: name,
        sessionId: sessionId ?? null,
      });
      if (!result?.ok) {
        toast.error(result?.message || `Couldn't switch to ${name}.`);
        return;
      }
      toast.success(`Switched to ${name}.`);
      refreshBranches();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Couldn't switch to ${name}.`);
    }
  };

  const handleCreateBranch = async () => {
    const dir = cwd?.trim();
    const name = newBranchName.trim();
    if (!dir || !name || creatingBranch) return;
    if (newBranchValidationMessage) {
      toast.error(newBranchValidationMessage);
      return;
    }

    setCreatingBranch(true);
    try {
      const result = await window.electron.gitCreateBranch({
        cwd: dir,
        branch: name,
        sessionId: sessionId ?? null,
      });
      if (!result?.ok) {
        toast.error(result?.message || `Couldn't create ${name}.`);
        return;
      }
      toast.success(`Created and switched to ${name}.`);
      setNewBranchName('');
      setCreateBranchDialogOpen(false);
      setBranchQuery('');
      refreshBranches();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Couldn't create ${name}.`);
    } finally {
      setCreatingBranch(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-2 pb-1 pt-2.5">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            title="Project folder"
            className={CONTEXT_PILL_CLASS}
          >
            <span className="shrink-0 text-[var(--text-muted)]">
              <Folder className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 truncate">
              {hasSelectedCwd ? projectName : 'Choose project'}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            side="bottom"
            sideOffset={6}
            className="z-50 max-h-[320px] w-[280px] overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
          >
            <DropdownMenu.Item
              onSelect={() => {
                onBrowse();
              }}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--bg-tertiary)]"
            >
              <FolderOpen className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              Browse…
            </DropdownMenu.Item>
            {recentOptions.length > 0 ? (
              <>
                <div className="my-1 h-px bg-[var(--border)]" />
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Recent
                </div>
                {recentOptions.map((dir) => (
                  <DropdownMenu.Item
                    key={dir}
                    onSelect={() => onSelectRecent(dir)}
                    title={dir}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--bg-tertiary)]"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    <span className="min-w-0 truncate">
                      {dir.split('/').filter(Boolean).pop() || dir}
                    </span>
                  </DropdownMenu.Item>
                ))}
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {hasSelectedCwd && isRepo && onStartModeChange ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              disabled={disabled}
              title={
                startMode === 'worktree'
                  ? 'Starts in a fresh git worktree on its own branch'
                  : 'Start mode: run in the project working tree, or in a fresh worktree'
              }
              className={CONTEXT_PILL_CLASS}
            >
              <span className="shrink-0 text-[var(--text-muted)]">
                {startMode === 'worktree' ? (
                  <GitFork className="h-3.5 w-3.5" />
                ) : (
                  <Monitor className="h-3.5 w-3.5" />
                )}
              </span>
              <span className="min-w-0 truncate">
                {startMode === 'worktree' ? 'New worktree' : 'Local'}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              side="bottom"
              sideOffset={6}
              className="z-50 w-[300px] rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
            >
              <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Start mode
              </div>
              <DropdownMenu.Item
                onSelect={() => onStartModeChange('local')}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 outline-none data-[highlighted]:bg-[var(--bg-tertiary)]"
              >
                <Monitor className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-[var(--text-primary)]">Local</span>
                  <span className="block text-[11px] text-[var(--text-muted)]">
                    Run in the project working tree
                  </span>
                </span>
                {startMode !== 'worktree' ? (
                  <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                ) : null}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => onStartModeChange('worktree')}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 outline-none data-[highlighted]:bg-[var(--bg-tertiary)]"
              >
                <GitFork className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-[var(--text-primary)]">New worktree</span>
                  <span className="block text-[11px] text-[var(--text-muted)]">
                    Isolated checkout on its own branch; squash-merge back when done
                  </span>
                </span>
                {startMode === 'worktree' ? (
                  <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                ) : null}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
      {hasSelectedCwd ? (
        <>
          {isRepo && branch ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  title="Switch branch"
                  className={CONTEXT_PILL_CLASS}
                >
                  <span className="shrink-0 text-[var(--text-muted)]">
                    <GitBranch className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 truncate">{branch}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  side="bottom"
                  sideOffset={6}
                  className="z-50 flex max-h-[360px] w-[280px] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-2 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
                >
                  <div
                    className="flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-[var(--text-secondary)]"
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    <input
                      value={branchQuery}
                      onChange={(event) => setBranchQuery(event.target.value)}
                      placeholder="搜索分支"
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                    />
                  </div>
                  <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-[var(--text-muted)]">
                    分支
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {branchesLoading && localBranches.length === 0 ? (
                      <div className="px-2 py-1.5 text-[12px] text-[var(--text-muted)]">Loading branches…</div>
                    ) : filteredLocalBranches.length === 0 ? (
                      <div className="px-2 py-1.5 text-[12px] text-[var(--text-muted)]">No branches found</div>
                    ) : (
                      filteredLocalBranches.map((entry) => (
                        <DropdownMenu.Item
                          key={entry.name}
                          onSelect={() => {
                            void handleSelectBranch(entry.name);
                          }}
                          title={entry.name}
                          className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--bg-tertiary)]"
                        >
                          <GitBranch className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                          {entry.name === branch ? (
                            <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                          ) : null}
                        </DropdownMenu.Item>
                      ))
                    )}
                  </div>
                  <div className="mt-2 border-t border-[var(--border)] pt-1">
                    <DropdownMenu.Item
                      onSelect={() => {
                        setNewBranchName('');
                        setCreateBranchDialogOpen(true);
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-[var(--text-secondary)] outline-none data-[highlighted]:bg-[var(--bg-tertiary)] data-[highlighted]:text-[var(--text-primary)]"
                    >
                      <Plus className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                      <span className="min-w-0 truncate">创建并检出新分支...</span>
                    </DropdownMenu.Item>
                  </div>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : null}
        </>
      ) : null}
      <Dialog.Root open={createBranchDialogOpen} onOpenChange={setCreateBranchDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[91] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[22px] border border-[var(--border)] bg-[var(--bg-primary)] p-6 shadow-[0_24px_80px_rgba(15,23,42,0.22)] outline-none">
            <div className="mb-7 flex items-start justify-between gap-4">
              <Dialog.Title className="text-[20px] font-semibold leading-7 tracking-[-0.02em] text-[var(--text-primary)]">
                创建并检出分支
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="-mr-1 flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateBranch();
              }}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <label htmlFor="composer-new-branch-name" className="text-[13px] font-semibold text-[var(--text-primary)]">
                  分支名称
                </label>
              </div>
              <input
                id="composer-new-branch-name"
                value={newBranchName}
                onChange={(event) => setNewBranchName(event.target.value)}
                placeholder="feature/name"
                disabled={creatingBranch}
                autoFocus
                className="h-12 w-full rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-[15px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:opacity-60"
              />
              {newBranchValidationMessage ? (
                <div className="mt-3 text-[13px] font-medium text-[var(--error)]">
                  {newBranchValidationMessage}
                </div>
              ) : null}
              <div className="mt-7 flex justify-end gap-3">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-[12px] bg-[var(--bg-tertiary)] px-5 py-2.5 text-[14px] font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)]"
                  >
                    关闭
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  disabled={!canCreateBranch}
                  className="rounded-[12px] bg-[var(--text-primary)] px-5 py-2.5 text-[14px] font-semibold text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {creatingBranch ? '创建中...' : '创建并检出'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
