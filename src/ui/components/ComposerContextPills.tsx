import type { ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Folder, FolderOpen, Monitor, GitBranch, ChevronDown } from './icons';
import { useGitBranch } from '../hooks/useGitBranch';

export const CONTEXT_PILL_CLASS =
  'inline-flex max-w-[200px] items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]';

export function ContextPill({
  icon,
  children,
  onClick,
  disabled,
  title,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={CONTEXT_PILL_CLASS}
    >
      <span className="shrink-0 text-[var(--text-muted)]">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
      <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
    </button>
  );
}

/**
 * Context row shown under the composer on the new-thread surfaces: a project
 * folder selector, a "Work locally" indicator, and — only when the folder is a
 * git repository — the current branch. Used by both the first-entry
 * NewSessionView and the ChatPane "New Thread" draft landing.
 */
export function ComposerContextPills({
  cwd,
  projectName,
  hasSelectedCwd,
  disabled,
  onBrowse,
  recentOptions,
  onSelectRecent,
}: {
  cwd: string | null;
  projectName: string;
  hasSelectedCwd: boolean;
  disabled?: boolean;
  onBrowse: () => void;
  recentOptions: string[];
  onSelectRecent: (dir: string) => void;
}) {
  const { branch, isRepo } = useGitBranch(hasSelectedCwd ? cwd : null);

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
          <ContextPill
            icon={<Monitor className="h-3.5 w-3.5" />}
            disabled
            title="Runs on your machine"
          >
            Work locally
          </ContextPill>
          {isRepo && branch ? (
            <ContextPill
              icon={<GitBranch className="h-3.5 w-3.5" />}
              disabled
              title="Current branch"
            >
              {branch}
            </ContextPill>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
