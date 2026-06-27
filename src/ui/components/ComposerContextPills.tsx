import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { Folder, FolderOpen, GitBranch, ChevronDown, Check } from './icons';
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
}) {
  const { current: branch, isRepo, localBranches, loading: branchesLoading, refresh: refreshBranches } =
    useGitBranches(hasSelectedCwd ? cwd : null);

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
                  className="z-50 max-h-[320px] w-[260px] overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
                >
                  {branchesLoading && localBranches.length === 0 ? (
                    <div className="px-2 py-1.5 text-[12px] text-[var(--text-muted)]">Loading branches…</div>
                  ) : localBranches.length === 0 ? (
                    <div className="px-2 py-1.5 text-[12px] text-[var(--text-muted)]">No branches found</div>
                  ) : (
                    localBranches.map((entry) => (
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
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
