import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  ArrowsSplit,
  BrandGithub,
  ChevronDown,
  Code2,
  Copy,
  EnvironmentIcon,
  ExternalLink,
  FileDiff,
  FolderClosed,
  Monitor,
  RefreshCw,
  X,
} from '../icons';
import { SessionWorkspaceControl } from '../ChatPane';
import type { EnvironmentEditorLauncher } from '../../../shared/types';
import type { ActiveEnvironmentContext } from './useActiveEnvironmentContext';
import type { GitEnvironmentState } from './useGitEnvironment';
import { EnvironmentGitActionsSection } from './EnvironmentGitActionsSection';
import { EnvironmentContextSection } from './EnvironmentContextSection';
import * as DropdownMenu from '../ui/dropdown-menu';

function getPathLeaf(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) || path;
}

function formatTime(value: number | null): string {
  if (!value) return 'not refreshed';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function SectionRow({
  icon: Icon,
  label,
  detail,
  trailing,
  disabled,
  onClick,
}: {
  icon: typeof FileDiff;
  label: string;
  detail?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="max-w-[96px] truncate text-[11px] text-[var(--text-muted)]">{detail}</span> : null}
      {trailing}
    </button>
  );
}

function VsCodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#22a6f2"
        d="M19.05 3.15 9.7 11.67 4.1 7.42a.72.72 0 0 0-.92.04L1.42 9.06a.72.72 0 0 0 0 1.07L6.28 14l-4.86 3.87a.72.72 0 0 0 0 1.07l1.76 1.6c.25.23.63.25.92.04l5.6-4.25 9.35 8.52A1.18 1.18 0 0 0 21 24V4a1.18 1.18 0 0 0-1.95-.85Z"
      />
      <path fill="#0078d4" d="M19.2 7.1 11.9 12l7.3 4.9V7.1Z" />
      <path fill="#0f5fb3" d="m4.1 7.42 5.6 4.25L6.28 14 1.42 10.13a.72.72 0 0 1 0-1.07l1.76-1.6c.25-.23.63-.25.92-.04Z" />
    </svg>
  );
}

function getEditorVisual(editor: EnvironmentEditorLauncher): { mark: ReactNode; tone: string } {
  switch (editor.id) {
    case 'cursor':
      return { mark: '◈', tone: 'bg-slate-950 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]' };
    case 'vscode':
      return { mark: <VsCodeIcon className="h-[18px] w-[18px]" />, tone: 'bg-[#eaf6ff] shadow-[inset_0_0_0_1px_rgba(0,120,212,0.18)]' };
    case 'windsurf':
      return { mark: 'W', tone: 'bg-cyan-50 text-cyan-700 shadow-[inset_0_0_0_1px_rgba(6,182,212,0.2)]' };
    case 'zed':
      return { mark: 'Z', tone: 'bg-zinc-950 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]' };
    case 'trae':
      return { mark: 'T', tone: 'bg-purple-50 text-purple-700 shadow-[inset_0_0_0_1px_rgba(147,51,234,0.18)]' };
    case 'intellij':
      return { mark: 'IJ', tone: 'bg-gradient-to-br from-pink-500 via-purple-600 to-blue-600 text-white' };
    case 'webstorm':
      return { mark: 'WS', tone: 'bg-gradient-to-br from-cyan-400 to-blue-700 text-white' };
    case 'sublime':
      return { mark: 'S', tone: 'bg-orange-50 text-orange-700 shadow-[inset_0_0_0_1px_rgba(249,115,22,0.2)]' };
    case 'finder':
      return { mark: '⌘', tone: 'bg-gradient-to-br from-sky-100 to-blue-200 text-blue-700' };
    case 'system':
    default:
      return { mark: '↗', tone: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' };
  }
}

let cachedEditorLaunchers: EnvironmentEditorLauncher[] | null = null;
let editorLaunchersRequest: Promise<EnvironmentEditorLauncher[]> | null = null;

function loadEditorLaunchers(): Promise<EnvironmentEditorLauncher[]> {
  if (!editorLaunchersRequest) {
    editorLaunchersRequest = window.electron
      .getEnvironmentEditorLaunchers()
      .then((launchers) => launchers.filter((launcher) => launcher.id !== 'system'))
      .then((launchers) => {
        cachedEditorLaunchers = launchers;
        return launchers;
      })
      .finally(() => {
        editorLaunchersRequest = null;
      });
  }
  return editorLaunchersRequest;
}

export function EnvironmentEditorPicker({ context }: { context: ActiveEnvironmentContext }) {
  const [editorLaunchers, setEditorLaunchers] = useState<EnvironmentEditorLauncher[]>(() => cachedEditorLaunchers ?? []);

  useEffect(() => {
    let cancelled = false;
    void loadEditorLaunchers().then((launchers) => {
      if (!cancelled) {
        setEditorLaunchers(launchers);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const primaryEditor = editorLaunchers.find((editor) => editor.available) ?? editorLaunchers[0] ?? null;
  const primaryEditorVisual = primaryEditor ? getEditorVisual(primaryEditor) : null;

  const openEditor = async (editor: EnvironmentEditorLauncher) => {
    if (!context.effectiveCwd) return;
    const result = await window.electron.openInEditor({
      cwd: context.effectiveCwd,
      editorId: editor.id,
    });
    if (!result.ok) {
      toast.error(result.message || `Failed to open ${editor.label}.`);
    }
  };

  const disabled = !primaryEditor || !context.effectiveCwd;

  const triggerVisual = primaryEditor?.iconDataUrl ? (
    <img src={primaryEditor.iconDataUrl} alt="" className="h-4 w-4 shrink-0 rounded-[4px]" />
  ) : primaryEditorVisual ? (
    <span className={`flex h-4 w-4 items-center justify-center rounded-[4px] text-[9px] font-semibold ${primaryEditorVisual.tone}`}>
      {primaryEditorVisual.mark}
    </span>
  ) : (
    <Code2 className="h-[14px] w-[14px] shrink-0" />
  );

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`no-drag inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[11px] font-medium transition-colors ${
            disabled
              ? 'cursor-not-allowed opacity-45'
              : 'cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] data-[popup-open]:bg-[var(--sidebar-item-active)] data-[popup-open]:text-[var(--text-primary)]'
          }`}
          title={primaryEditor ? `Open in ${primaryEditor.label}` : 'No editor detected'}
          aria-label="Open workspace in editor"
        >
          {triggerVisual}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[9999] min-w-[200px] rounded-[var(--popover-radius)] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 shadow-[var(--popover-shadow)]"
        >
          <DropdownMenu.Group>
            <DropdownMenu.Label>Open in…</DropdownMenu.Label>
            {editorLaunchers.map((editor) => {
            const visual = getEditorVisual(editor);
            const itemDisabled = !editor.available || !context.effectiveCwd;
            return (
              <DropdownMenu.Item
                key={editor.id}
                disabled={itemDisabled}
                onSelect={(event) => {
                  event.preventDefault();
                  void openEditor(editor);
                }}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--sidebar-item-hover)]"
              >
                {editor.iconDataUrl ? (
                  <img src={editor.iconDataUrl} alt="" className="h-4 w-4 shrink-0 rounded-[4px]" />
                ) : (
                  <span className={`flex h-4 w-4 items-center justify-center rounded-[4px] text-[9px] font-semibold ${visual.tone}`}>
                    {visual.mark}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{editor.label}</span>
                {!editor.available ? (
                  <span className="shrink-0 text-[10px] text-[var(--text-muted)]">not detected</span>
                ) : null}
              </DropdownMenu.Item>
            );
          })}
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// worktree 收尾动作（对照参考 app 的"工作树"卡：动作平铺可见，不藏在下拉里）
function WorktreeActions({
  sessionId,
  branch,
  isRunning,
  onDone,
}: {
  sessionId: string;
  branch: string | null;
  isRunning: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<'apply' | 'discard' | null>(null);
  const buttonClass =
    'inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-45';

  const squashMerge = async () => {
    setBusy('apply');
    try {
      const result = await window.electron.applyWorktreeChanges(sessionId);
      if (result.ok) {
        toast.success('Squash-merged — changes are staged in your project for review.');
        onDone();
      } else {
        toast.error(result.message || 'Squash-merge failed.');
      }
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (
      !window.confirm(
        `Remove this worktree${branch ? ` and delete branch ${branch}` : ''}? All uncommitted changes in it are lost. The conversation stays.`
      )
    ) {
      return;
    }
    setBusy('discard');
    try {
      const result = await window.electron.discardWorktreeChanges(sessionId);
      if (result.ok) {
        toast.success('Worktree removed — thread is back on the project.');
        onDone();
      } else {
        toast.error(result.message || 'Could not remove the worktree.');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-1.5 px-2 pt-1.5">
      <button
        type="button"
        disabled={isRunning || busy !== null}
        onClick={() => void squashMerge()}
        title={
          isRunning
            ? 'Wait for the agent to finish first'
            : 'git merge --squash into your project — the result lands in the staging area for review'
        }
        className={buttonClass}
      >
        <ArrowsSplit className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{busy === 'apply' ? 'Merging…' : 'Squash-merge'}</span>
      </button>
      <button
        type="button"
        disabled={isRunning || busy !== null}
        onClick={() => void discard()}
        title="Remove the worktree and delete its branch"
        className={buttonClass}
      >
        <X className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{busy === 'discard' ? 'Removing…' : 'Discard worktree'}</span>
      </button>
    </div>
  );
}

export function EnvironmentHub({
  context,
  git,
  onOpenProjectPanel,
}: {
  context: ActiveEnvironmentContext;
  git: GitEnvironmentState;
  onOpenProjectPanel: (view: 'files' | 'changes') => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const overview = git.overview;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      // Dialogs opened from panel sections (e.g. the commit dialog) render in a
      // portal outside panelRef; clicking them must not dismiss the panel.
      if (target instanceof Element && target.closest('[data-environment-hub-layer]')) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[data-environment-hub-layer]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);


  useEffect(() => {
    if (!open) return;
    void git.refresh();
  }, [context.contextKey, open]);

  const copyPath = async (path: string | null) => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      toast.success('Path copied.');
    } catch {
      toast.error('Failed to copy path.');
    }
  };

  const openRepository = async () => {
    const url = overview.repository?.webUrl;
    if (!url) return;
    const result = await window.electron.openExternalUrl(url);
    if (!result.ok) toast.error(result.message || 'Failed to open repository.');
  };


  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`no-drag relative inline-flex h-7 min-w-7 items-center justify-center rounded-lg px-1.5 text-[11px] font-medium transition-colors ${
          open
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
        title="Environment"
        aria-label="Open environment panel"
        aria-expanded={open}
      >
        <EnvironmentIcon className="h-[14px] w-[14px] shrink-0" />
      </button>
      {open ? (
        // Anchored to the trigger (the wrapper div is position:relative) so the
        // card opens under the Environment icon wherever the header ends up —
        // a viewport-fixed position drifts away from the icon once the right
        // utility panel shrinks the chat pane.
        <div
          ref={panelRef}
          className="no-drag absolute right-0 top-full z-[70] mt-1.5 max-h-[min(680px,calc(100vh-64px))] w-[318px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_20px_50px_rgba(15,23,42,0.18)]"
        >
          <div className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">Environment</div>
              <div className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                {context.paneLabel} · {context.session ? context.title : 'Empty'}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void git.refresh()}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                title={`Refresh · ${formatTime(git.lastUpdatedAt)}`}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${git.loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
          <div className="scrollbar-slim max-h-[calc(min(680px,100vh-64px)-58px)] overflow-y-auto pb-2">
            {context.unavailableReason ? (
              <div className="border-t border-[var(--border)] px-4 py-4 text-[12px] leading-5 text-[var(--text-muted)]">
                {context.unavailableReason}
              </div>
            ) : (
              <>
                <section className="space-y-1 border-t border-[var(--border)] px-3 py-3">
                  <div className="px-2 text-[11px] font-medium text-[var(--text-muted)]">Workspace</div>
                  {context.session && context.sessionId ? (
                    <SessionWorkspaceControl
                      session={context.session}
                      sessionId={context.sessionId}
                      onWorkspaceGitChanged={git.refresh}
                      variant="panel"
                    />
                  ) : null}
                  {context.effectiveCwd ? (
                    <div className="truncate px-2 pt-1 text-[10px] text-[var(--text-muted)]" title={context.effectiveCwd}>
                      {getPathLeaf(context.effectiveCwd)} · {context.envMode}
                    </div>
                  ) : null}
                  {context.session &&
                  context.sessionId &&
                  context.session.envMode === 'worktree' &&
                  context.session.worktreePath ? (
                    <WorktreeActions
                      sessionId={context.sessionId}
                      branch={context.session.associatedWorktreeBranch || null}
                      isRunning={context.session.status === 'running'}
                      onDone={() => void git.refresh()}
                    />
                  ) : null}
                </section>
                <section className="space-y-1 border-t border-[var(--border)] px-3 py-3">
                  <div className="px-2 text-[11px] font-medium text-[var(--text-muted)]">Project</div>
                  <SectionRow icon={FolderClosed} label="Files" detail="Project" onClick={() => onOpenProjectPanel('files')} />
                  <SectionRow
                    icon={FileDiff}
                    label="Changes"
                    onClick={() => onOpenProjectPanel('changes')}
                    trailing={
                      <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
                        <span className="text-emerald-600">+{overview.insertions}</span>
                        <span className="text-[var(--error)]">-{overview.deletions}</span>
                      </span>
                    }
                  />
                </section>
                <EnvironmentGitActionsSection context={context} git={git} />
                <section className="space-y-1 border-t border-[var(--border)] px-3 py-3">
                  <div className="px-2 text-[11px] font-medium text-[var(--text-muted)]">Source</div>
                  <SectionRow
                    icon={overview.repository?.webUrl ? BrandGithub : Monitor}
                    label={overview.repository?.fullName || 'No source'}
                    detail={overview.repository?.defaultBranch || undefined}
                    disabled={!overview.repository?.webUrl}
                    onClick={openRepository}
                    trailing={overview.repository?.webUrl ? <ExternalLink className="h-3 w-3 text-[var(--text-muted)]" /> : null}
                  />
                  <SectionRow
                    icon={Copy}
                    label="Copy workspace path"
                    detail={context.effectiveCwd ? getPathLeaf(context.effectiveCwd) : undefined}
                    disabled={!context.effectiveCwd}
                    onClick={() => void copyPath(context.effectiveCwd)}
                  />
                </section>
                <EnvironmentContextSection context={context} />
              </>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-2 text-[10px] text-[var(--text-muted)]">
            <span>{formatTime(git.lastUpdatedAt)}</span>
            <span className="inline-flex items-center gap-1">
              <ChevronDown className="h-3 w-3 -rotate-90" />
              <span>{overview.repoRoot ? getPathLeaf(overview.repoRoot) : 'No repo'}</span>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
