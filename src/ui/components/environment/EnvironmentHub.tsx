import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
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
  Settings,
} from '../icons';
import { SessionWorkspaceControl } from '../ChatPane';
import type { EnvironmentEditorLauncher } from '../../../shared/types';
import type { ActiveEnvironmentContext } from './useActiveEnvironmentContext';
import type { GitEnvironmentState } from './useGitEnvironment';
import { EnvironmentGitActionsSection } from './EnvironmentGitActionsSection';
import { EnvironmentContextSection } from './EnvironmentContextSection';

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


export function EnvironmentEditorPicker({ context }: { context: ActiveEnvironmentContext }) {
  const [open, setOpen] = useState(false);
  const [editorLaunchers, setEditorLaunchers] = useState<EnvironmentEditorLauncher[]>([]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electron.getEnvironmentEditorLaunchers().then((launchers) => {
      if (!cancelled) setEditorLaunchers(launchers);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

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
      return;
    }
    setOpen(false);
  };

  const disabled = !primaryEditor || !context.effectiveCwd;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={`no-drag inline-flex h-7 min-w-7 items-center justify-center rounded-lg px-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
          open
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
        title={primaryEditor ? `Open in ${primaryEditor.label}` : 'No editor detected'}
        aria-label="Open workspace in editor"
        aria-expanded={open}
      >
        {primaryEditor?.iconDataUrl ? (
          <img src={primaryEditor.iconDataUrl} alt="" className="h-4 w-4 shrink-0 rounded-[4px]" />
        ) : primaryEditorVisual ? (
          <span className={`flex h-4 w-4 items-center justify-center rounded-[4px] text-[9px] font-semibold ${primaryEditorVisual.tone}`}>
            {primaryEditorVisual.mark}
          </span>
        ) : (
          <Code2 className="h-[14px] w-[14px] shrink-0" />
        )}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="no-drag fixed right-[86px] top-11 z-[80] w-[260px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_12px_30px_rgba(15,23,42,0.18)]"
        >
          {editorLaunchers.map((editor, index) => {
            const visual = getEditorVisual(editor);
            const itemDisabled = !editor.available || !context.effectiveCwd;
            return (
              <button
                key={editor.id}
                type="button"
                disabled={itemDisabled}
                onClick={() => void openEditor(editor)}
                className={`group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-45 ${
                  index === 0 ? '' : 'border-t border-[var(--border)]/70'
                }`}
              >
                {editor.iconDataUrl ? (
                  <img src={editor.iconDataUrl} alt="" className="h-8 w-8 shrink-0 rounded-lg" />
                ) : (
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[14px] font-semibold ${visual.tone}`}
                    aria-hidden="true"
                  >
                    {visual.mark}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">{editor.label}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
                    {editor.available ? 'Open current workspace' : 'Not installed'}
                  </span>
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] opacity-70 transition-opacity group-hover:opacity-100" />
              </button>
            );
          })}
        </div>
      ) : null}
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
        <div
          ref={panelRef}
          className="no-drag fixed right-3 top-11 z-[70] max-h-[min(680px,calc(100vh-64px))] w-[318px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_20px_50px_rgba(15,23,42,0.18)]"
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
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                title="Environment settings"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="max-h-[calc(min(680px,100vh-64px)-58px)] overflow-y-auto pb-2">
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
