import { useSessionPullRequests } from './useSessionPullRequests';
import { EnvironmentPullRequestsSection } from './EnvironmentPullRequestsSection';
import './environment-summary.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  BrandGithubFilled,
  ChevronDown,
  Code2,
  Copy,
  ExternalLink,
  FileDiff,
  MoreHorizontal,
} from '../icons';
import { SessionWorkspaceControl } from '../ChatPane';
import type { EnvironmentEditorLauncher } from '../../../shared/types';
import type { ActiveEnvironmentContext } from './useActiveEnvironmentContext';
import type { GitEnvironmentState } from './useGitEnvironment';
import { EnvironmentGitActionsSection } from './EnvironmentGitActionsSection';
import { EnvironmentComputerUseSection, environmentHasComputerUseSection } from './EnvironmentComputerUseSection';
import { useAppStore } from '../../store/useAppStore';
import { deriveSubagentSummaries } from '../../utils/subagent-registry';
import { SubagentAvatar } from '../SubagentAvatar';
import { Users } from '../icons';
import * as DropdownMenu from '../ui/dropdown-menu';

function EnvironmentListIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="5" cy="8" r="2" />
      <circle cx="5" cy="16" r="2" />
      <path d="M10 8h8" />
      <path d="M10 16h8" />
    </svg>
  );
}

function SectionRow({
  icon: Icon,
  iconClassName,
  label,
  detail,
  title,
  trailing,
  disabled,
  onClick,
}: {
  icon: typeof FileDiff;
  iconClassName?: string;
  label: string;
  detail?: string;
  title?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="environment-summary-row"
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClassName ?? 'text-[var(--text-muted)]'}`} />
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
    case 'xcode':
      return { mark: 'X', tone: 'bg-gradient-to-br from-sky-400 to-blue-600 text-white' };
    case 'terminal':
      return { mark: '>_', tone: 'bg-zinc-950 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]' };
    case 'iterm':
      return { mark: '>_', tone: 'bg-emerald-950 text-emerald-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]' };
    case 'ghostty':
      return { mark: 'G', tone: 'bg-indigo-950 text-indigo-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]' };
    case 'warp':
      return { mark: 'W', tone: 'bg-slate-950 text-sky-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]' };
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

  const primaryEditor =
    editorLaunchers.find((editor) => editor.available && editor.id !== 'finder')
    ?? editorLaunchers.find((editor) => editor.available)
    ?? editorLaunchers[0]
    ?? null;
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
      <div
        className={`no-drag inline-flex h-6 overflow-hidden rounded-[9px] border border-[var(--border)] bg-[var(--chat-chrome-chip-surface)] [backdrop-filter:var(--chat-chrome-chip-backdrop)] text-[var(--text-secondary)] ${
          disabled ? 'opacity-45' : ''
        }`}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (primaryEditor) void openEditor(primaryEditor);
          }}
          className={`inline-flex h-full w-[26px] items-center justify-center transition-colors ${
            disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
          }`}
          title={primaryEditor ? `Open in ${primaryEditor.label}` : 'No editor detected'}
          aria-label={primaryEditor ? `Open workspace in ${primaryEditor.label}` : 'No editor detected'}
        >
          {triggerVisual}
        </button>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={`inline-flex h-full w-[18px] items-center justify-center transition-colors ${
              disabled
                ? 'cursor-not-allowed'
                : 'cursor-pointer hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] data-[popup-open]:bg-[var(--sidebar-item-active)] data-[popup-open]:text-[var(--text-primary)]'
            }`}
            title="Choose application"
            aria-label="Choose application to open workspace"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenu.Trigger>
      </div>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[9999] w-[200px] rounded-[14px] !border-0 bg-[var(--popover-bg)] [background-image:none] p-1.5 shadow-[0_18px_42px_-12px_rgba(15,23,42,0.16)]"
        >
          <DropdownMenu.Group>
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
                className="flex h-7 cursor-default items-center gap-2 rounded-lg px-2 text-[12px] text-[var(--text-primary)] outline-none transition-colors data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--sidebar-item-hover)]"
              >
                {editor.iconDataUrl ? (
                  <img src={editor.iconDataUrl} alt="" className="h-4 w-4 shrink-0 rounded-[4px]" />
                ) : (
                  <span className={`flex h-4 w-4 items-center justify-center rounded-[4px] text-[8px] font-semibold ${visual.tone}`}>
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

export function EnvironmentHub({
  context,
  git,
  onOpenProjectPanel,
}: {
  context: ActiveEnvironmentContext;
  git: GitEnvironmentState;
  onOpenProjectPanel: (view: 'files' | 'changes') => void;
}) {
  const prs = useSessionPullRequests(context, git);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const overview = git.overview;
  const previewSessionId = useAppStore((s) => s.computerUsePreviewSessionId);
  const previewOpen = Boolean(context.sessionId) && previewSessionId === context.sessionId;
  const knownNonGit = !context.unavailableReason && !overview.hasRepo && (overview.error === 'not-a-repo' || overview.ok);
  const subagents = useMemo(() => context.session ? deriveSubagentSummaries(context.session.messages) : [], [context.session?.messages]);
  const hasComputerUse = environmentHasComputerUseSection({ frames: context.session?.computerUseFrames, grants: context.session?.computerUseGrants });


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


  // A plain directory has no Git environment to summarize. Other task
  // sections remain available independently when they contain information.
  if (knownNonGit && !hasComputerUse && subagents.length === 0 && prs.items.length === 0 && !prs.error) return null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`no-drag relative inline-flex h-7 w-7 items-center justify-center rounded-lg text-[11px] font-medium transition-colors ${
          open
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
        title="Environment"
        aria-label="Open environment panel"
        aria-expanded={open}
      >
        <EnvironmentListIcon />
      </button>
      {open ? (
        // Anchored to the trigger (the wrapper div is position:relative) so the
        // card opens under the Environment icon wherever the header ends up —
        // a viewport-fixed position drifts away from the icon once the right
        // utility panel shrinks the chat pane.
        <div
          ref={panelRef}
          className="no-drag absolute right-0 top-full z-[70] mt-1.5 max-h-[min(680px,calc(100vh-64px))] w-[300px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[20px] bg-[var(--popover-bg)] shadow-[var(--popover-shadow-lg)]"
        >
          <div className="scrollbar-slim max-h-[min(680px,calc(100vh-64px))] overflow-y-auto py-2.5">
            {!knownNonGit ? <>
            <div className="flex items-center gap-2 px-3.5 pb-1">
              <div className="flex min-h-7 min-w-0 flex-1 items-center text-[12px] font-medium text-[var(--text-secondary)]">
                Environment
              </div>
              {!context.unavailableReason ? (
                <DropdownMenu.Root modal={false}>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      aria-label="Environment options"
                      title="Environment options"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content data-environment-hub-layer align="end" sideOffset={6} className="min-w-[220px] max-w-[280px]">
                      <DropdownMenu.Item
                        disabled={!context.effectiveCwd}
                        onSelect={() => void copyPath(context.effectiveCwd)}
                        title={context.effectiveCwd || undefined}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--sidebar-item-hover)] data-[disabled]:opacity-45"
                      >
                        <Copy className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                        <span>Copy workspace path</span>
                      </DropdownMenu.Item>
                      {overview.repository?.webUrl ? (
                        <DropdownMenu.Item
                          onSelect={() => void openRepository()}
                          title={overview.repository.fullName || undefined}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--sidebar-item-hover)]"
                        >
                          <BrandGithubFilled className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                          <span className="min-w-0 flex-1 truncate">Open repository</span>
                          <ExternalLink className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                        </DropdownMenu.Item>
                      ) : null}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              ) : null}
            </div>
            <div>
              {context.unavailableReason ? (
                <div className="px-3.5 py-2 text-[12px] leading-5 text-[var(--text-muted)]">
                  {context.unavailableReason}
                </div>
              ) : (
                <>
                  <section className="flex flex-col gap-0.5 px-1.5">
                    {overview.hasRepo ? (
                      <SectionRow
                        icon={FileDiff}
                        label="Changes"
                        onClick={() => onOpenProjectPanel('changes')}
                        trailing={
                          <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
                            <span className="text-emerald-600">+{overview.insertions}</span>
                            <span className="text-[var(--error)]">-{overview.deletions}</span>
                          </span>
                        }
                      />
                    ) : null}
                    {overview.hasRepo && context.session && context.sessionId ? (
                      <SessionWorkspaceControl
                        key={context.contextKey}
                        session={context.session}
                        sessionId={context.sessionId}
                        currentBranch={overview.branch}
                        onWorkspaceGitChanged={git.refresh}
                        variant="panel"
                      />
                    ) : null}
                    {git.loading && !overview.hasRepo ? (
                      <div role="status" className="px-2 py-1 text-[12px] text-[var(--text-muted)]">Checking environment…</div>
                    ) : overview.error && overview.error !== 'not-a-repo' ? (
                      <div role="status" className="px-2 py-1 text-[12px] leading-5 text-[var(--text-muted)]">{overview.error === 'git-error' ? 'Unable to read Git status. Try refreshing.' : overview.error}</div>
                    ) : null}
                  </section>
                  {overview.hasRepo ? <EnvironmentGitActionsSection context={context} git={git} prs={prs} /> : null}

                </>
              )}
            </div>
            </> : null}
            {!context.unavailableReason ? (
              <>
                <EnvironmentPullRequestsSection prs={prs} />
                <EnvironmentComputerUseSection
                  session={context.session}
                  sessionId={context.sessionId}
                  previewOpen={previewOpen}
                />
                <EnvironmentSubagentSection session={context.session} summaries={subagents} onNavigate={() => setOpen(false)} />
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Navigation index for this pane's subagents. Uses the same summaries as the
 * hub's visibility check, including when no Git environment section exists.
 */
function EnvironmentSubagentSection({ session, summaries, onNavigate }: {
  session: ActiveEnvironmentContext['session'];
  summaries: ReturnType<typeof deriveSubagentSummaries>;
  onNavigate: () => void;
}) {
  const openSubagentPanel = useAppStore((s) => s.openSubagentPanel);

  if (summaries.length === 0) return null;

  return (
    <section className="environment-summary-section">
      <div className="flex items-center gap-1.5 px-2 text-[11px] font-medium text-[var(--text-muted)]">
        <Users className="h-3 w-3" />
        <span>Subagents</span>
        <span>· {summaries.length}</span>
      </div>
      {summaries.map((s) => {
        const running = s.status === 'pending' && session?.status === 'running';
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              openSubagentPanel(s.id);
              onNavigate();
            }}
            title={s.persona.functionalName}
            className="environment-summary-row"
          >
            <SubagentAvatar id={s.id} hue={s.persona.colorHue} size={14} />
            <span className="shrink-0">{s.persona.persona}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">
              {s.persona.functionalName}
            </span>
            {s.status === 'error' ? (
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: 'var(--error)' }} />
            ) : running ? (
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: 'var(--accent)' }} />
            ) : null}
          </button>
        );
      })}
    </section>
  );
}
