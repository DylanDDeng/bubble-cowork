import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileDiff, Virtualizer } from '@pierre/diffs/react';
import { toast } from 'sonner';
import type { GitPatchScope, ReviewDiffSelection, SessionView } from '../types';
import { useAppStore } from '../store/useAppStore';
import { useAegisDiffPanelData, type AegisDiffTurnOption } from '../hooks/useAegisDiffPanelData';
import {
  WORKSPACE_DIFF_SCOPES,
  buildCommitReviewSelection,
  buildReviewTurnSelection,
  buildWorkspaceReviewSelection,
  getTurnDiffLabel,
  getWorkspaceDiffLabel,
} from '../utils/review-diff-selection';
import type { AegisDiffFile, AegisDiffRenderMode } from '../utils/aegis-diff-rendering';
import { basenameOfDiffPath } from '../utils/aegis-diff-rendering';
import { DiffStatLabel } from './DiffStatLabel';
import { FileTypeIcon } from './FileTypeIcon';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  FileDiff as FileDiffIcon,
  FileSearch,
  Loader2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Sparkles,
  TextWrap,
  TextWrapDisabled,
  X,
} from './icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import * as Dialog from './ui/dialog';
import { ExpandAllGlyph, GitCommitHorizontalGlyph, SplitDiffGlyph } from './diff-glyphs';

// Matches the app's compact menus (13px, tight rows) instead of the roomier
// DropdownMenuItem default.
const MENU_ITEM_CLASS = 'rounded-md px-2.5 py-1 text-[13px]';
const MENU_SEPARATOR_CLASS = 'my-0.5';
const ICON_BUTTON_CLASS =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-40';
const MENU_ITEM_ICON_CLASS = 'mr-2 h-3.5 w-3.5 text-[var(--text-muted)]';

function readDiffPref(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function writeDiffPref(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Preferences fall back to session-only when storage is unavailable.
  }
}

function useDiffPref(key: string, fallback: boolean): [boolean, () => void] {
  const [value, setValue] = useState(() => readDiffPref(key, fallback));
  const toggle = useCallback(() => {
    setValue((current) => {
      const next = !current;
      writeDiffPref(key, next);
      return next;
    });
  }, [key]);
  return [value, toggle];
}

function sourceLabel(selection: ReviewDiffSelection, turn?: AegisDiffTurnOption | null): string {
  if (selection.source.kind === 'turn') {
    if (turn?.current) return 'Last turn';
    if (turn) return getTurnDiffLabel(turn.summary);
    return selection.source.label;
  }
  if (selection.source.kind === 'commit') {
    return selection.source.label || selection.source.shortSha;
  }
  return selection.source.label || getWorkspaceDiffLabel(selection.source.scope);
}

function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function isWorkspaceSelection(selection: ReviewDiffSelection, scope: GitPatchScope): boolean {
  return selection.source.kind === 'workspace' && selection.source.scope === scope;
}

function isTurnSelection(selection: ReviewDiffSelection, turnKey: string): boolean {
  return selection.source.kind === 'turn' && selection.source.turnKey === turnKey;
}

function isCommitSelection(selection: ReviewDiffSelection, sha: string): boolean {
  return selection.source.kind === 'commit' && selection.source.sha === sha;
}

function statusLabel(file: AegisDiffFile): string {
  if (file.status === 'A' || file.status === '?') return 'added';
  if (file.status === 'D') return 'deleted';
  if (file.status === 'R') return 'renamed';
  return 'modified';
}

function emptyMessage(
  selection: ReviewDiffSelection,
  error: string | null
): { title: string; detail: string } {
  if (error === 'no-cwd') {
    return { title: 'Select a folder', detail: 'Choose a workspace folder to inspect changes.' };
  }
  if (error === 'not-a-repo') {
    return { title: 'Not a git repository', detail: 'Turn diffs can still be opened from the chat transcript.' };
  }
  if (error) {
    return { title: 'Unable to load changes', detail: error };
  }
  if (selection.source.kind === 'turn') {
    return { title: 'No diff captured', detail: 'This turn has no renderable file changes.' };
  }
  if (selection.source.kind === 'commit') {
    return { title: 'No changes in this commit', detail: 'This commit has no renderable file changes.' };
  }
  return { title: 'No changes', detail: 'No file changes are available for this scope.' };
}

function useExpandedFiles(files: AegisDiffFile[], selection: ReviewDiffSelection) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    const selected =
      files.find((file) => file.record?.id === selection.selectedRecordId) ||
      files.find((file) => file.path === selection.selectedFilePath) ||
      files[0] ||
      null;
    setExpandedKeys(selected ? new Set([selected.key]) : new Set());
  }, [files, selection.requestedAt, selection.selectedFilePath, selection.selectedRecordId]);

  const toggleFile = useCallback((key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const expandFile = useCallback((key: string) => {
    setExpandedKeys((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpandedKeys(new Set()), []);
  const expandAll = useCallback(
    () => setExpandedKeys(new Set(files.map((file) => file.key))),
    [files]
  );

  return { expandedKeys, toggleFile, expandFile, collapseAll, expandAll };
}

export function AegisDiffPanel({
  collapsed,
  cwd,
  session,
  onClose,
  isFullscreen,
  onToggleFullscreen,
}: {
  collapsed: boolean;
  cwd: string | null;
  session: SessionView | null;
  onClose: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { reviewDiffSelection, setReviewDiffSelection } = useAppStore();
  const data = useAegisDiffPanelData({
    cwd,
    session,
    selection: reviewDiffSelection,
    active: !collapsed,
  });
  const [renderMode, setRenderMode] = useState<AegisDiffRenderMode>('unified');
  const [copied, setCopied] = useState(false);
  const [wordWrap, toggleWordWrap] = useDiffPref('aegis-diff-word-wrap', false);
  const [richPreview, toggleRichPreview] = useDiffPref('aegis-diff-rich-preview', true);
  const [wordDiffs, toggleWordDiffs] = useDiffPref('aegis-diff-word-diffs', true);
  const { expandedKeys, toggleFile, expandFile, collapseAll, expandAll } = useExpandedFiles(
    data.files,
    data.selection
  );
  const activeTurn = useMemo(() => {
    const source = data.selection.source;
    return source.kind === 'turn'
      ? data.turns.find((entry) => entry.key === source.turnKey) || null
      : null;
  }, [data.selection, data.turns]);
  const lastTurn = useMemo(
    () => data.turns.find((entry) => entry.current) || null,
    [data.turns]
  );

  const diffOptions = useMemo(
    () => ({
      diffStyle: renderMode,
      hunkSeparators: 'line-info-basic' as const,
      disableFileHeader: true,
      stickyHeader: false,
      overflow: wordWrap ? ('wrap' as const) : ('scroll' as const),
      diffIndicators: 'bars' as const,
      lineDiffType: wordDiffs ? ('word' as const) : ('none' as const),
      useCSSClasses: true,
      tokenizeMaxLineLength: 400,
    }),
    [renderMode, wordDiffs, wordWrap]
  );

  const openWorkspaceScope = useCallback((scope: GitPatchScope) => {
    setReviewDiffSelection(buildWorkspaceReviewSelection(scope));
  }, [setReviewDiffSelection]);

  const openTurn = useCallback((turnKey: string) => {
    const turn = data.turns.find((entry) => entry.key === turnKey);
    if (!turn) return;
    setReviewDiffSelection(buildReviewTurnSelection(turn.summary, session?.id ?? null));
  }, [data.turns, session?.id, setReviewDiffSelection]);

  const openCommit = useCallback((sha: string) => {
    const commit = data.commits.find((entry) => entry.sha === sha);
    if (!commit) return;
    setReviewDiffSelection(buildCommitReviewSelection(commit));
  }, [data.commits, setReviewDiffSelection]);

  const copyPatch = useCallback(async () => {
    if (!data.patch.trim()) return;
    try {
      await navigator.clipboard.writeText(data.patch);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error('Unable to copy patch.');
    }
  }, [data.patch]);

  const copyGitApplyCommand = useCallback(async () => {
    const patch = data.patch.trim();
    if (!patch) return;
    const root = data.gitResult?.repoRoot || cwd;
    const cdPrefix = root ? `cd '${root.replace(/'/g, `'\\''`)}' && ` : '';
    const command = `${cdPrefix}git apply --3way <<'AEGIS_PATCH_EOF'\n${patch}\nAEGIS_PATCH_EOF`;
    try {
      await navigator.clipboard.writeText(command);
      toast.success('git apply command copied.');
    } catch {
      toast.error('Unable to copy command.');
    }
  }, [cwd, data.gitResult?.repoRoot, data.patch]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const jumpToFile = useCallback(
    (file: AegisDiffFile) => {
      expandFile(file.key);
      // Wait for the expanded diff to render before scrolling the row into view.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          listRef.current
            ?.querySelector(`[data-aegis-diff-file="${CSS.escape(file.path)}"]`)
            ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
      });
    },
    [expandFile]
  );

  const showEmpty = !data.loading && data.files.length === 0;
  const empty = emptyMessage(data.selection, data.error);
  const allExpanded = data.files.length > 0 && expandedKeys.size === data.files.length;
  const canCommit = Boolean(cwd) && data.error !== 'not-a-repo' && data.error !== 'no-cwd';

  if (collapsed) {
    return <div className="absolute inset-0 hidden" aria-hidden="true" />;
  }

  return (
    <div className="aegis-diff-panel absolute inset-0 flex min-h-0 min-w-0 flex-col bg-[var(--bg-primary)]">
      <div className="aegis-diff-toolbar flex shrink-0 flex-col border-b border-[var(--border)] bg-[var(--bg-primary)]">
        <div className="flex h-11 items-center gap-2 px-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              >
                <span className="min-w-0 truncate">{sourceLabel(data.selection, activeTurn)}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[190px] p-1">
              {lastTurn ? (
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openTurn(lastTurn.key)}>
                  <span className="min-w-0 flex-1 truncate">Last turn</span>
                  {isTurnSelection(data.selection, lastTurn.key) ? (
                    <Check className="ml-3 h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  ) : null}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem className={MENU_ITEM_CLASS} disabled>
                  <span className="text-[var(--text-muted)]">Last turn</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
              <DropdownMenuGroup>
                {WORKSPACE_DIFF_SCOPES.filter((entry) => entry.scope !== 'branch').map((entry) => {
                  const active = isWorkspaceSelection(data.selection, entry.scope);
                  return (
                    <DropdownMenuItem
                      key={entry.scope}
                      className={MENU_ITEM_CLASS}
                      onSelect={() => openWorkspaceScope(entry.scope)}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      {active ? (
                        <Check className="ml-3 h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
              <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={MENU_ITEM_CLASS}>
                  <span className="min-w-0 flex-1 truncate">Committed</span>
                  {data.selection.source.kind === 'commit' ? (
                    <Check className="ml-3 h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  ) : null}
                  <ChevronRight className="ml-2 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-[320px] min-w-[260px] overflow-y-auto p-1">
                  {data.commits.length === 0 ? (
                    <DropdownMenuItem className={MENU_ITEM_CLASS} disabled>
                      <span className="text-[var(--text-muted)]">No commits yet</span>
                    </DropdownMenuItem>
                  ) : (
                    data.commits.map((commit) => {
                      const active = isCommitSelection(data.selection, commit.sha);
                      return (
                        <DropdownMenuItem
                          key={commit.sha}
                          className={MENU_ITEM_CLASS}
                          onSelect={() => openCommit(commit.sha)}
                        >
                          <span className="mr-2 shrink-0 font-mono text-xs text-[var(--text-muted)]">
                            {commit.shortSha}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                          {active ? (
                            <Check className="ml-3 h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                          ) : null}
                        </DropdownMenuItem>
                      );
                    })
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {WORKSPACE_DIFF_SCOPES.filter((entry) => entry.scope === 'branch').map((entry) => {
                const active = isWorkspaceSelection(data.selection, entry.scope);
                return (
                  <DropdownMenuItem
                    key={entry.scope}
                    className={MENU_ITEM_CLASS}
                    onSelect={() => openWorkspaceScope(entry.scope)}
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {active ? (
                      <Check className="ml-3 h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="hidden min-w-0 items-center gap-2 text-xs text-[var(--text-muted)] sm:flex">
            <span>{fileCountLabel(data.summary.totalFiles)}</span>
            <DiffStatLabel additions={data.summary.addedLines} deletions={data.summary.removedLines} />
            {data.gitResult?.truncated ? (
              <span className="text-amber-600">truncated</span>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={ICON_BUTTON_CLASS}
                  title="More actions"
                  aria-label="More actions"
                >
                  {data.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[210px] p-1">
                <DropdownMenuItem
                  className={MENU_ITEM_CLASS}
                  disabled={data.loading || data.selection.source.kind === 'turn'}
                  onSelect={() => data.refresh()}
                >
                  <RefreshCw className={MENU_ITEM_ICON_CLASS} />
                  Refresh
                </DropdownMenuItem>
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={toggleWordWrap}>
                  {wordWrap ? (
                    <TextWrapDisabled className={MENU_ITEM_ICON_CLASS} />
                  ) : (
                    <TextWrap className={MENU_ITEM_ICON_CLASS} />
                  )}
                  {wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
                </DropdownMenuItem>
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={toggleRichPreview}>
                  <Code2 className={MENU_ITEM_ICON_CLASS} />
                  {richPreview ? 'Disable rich preview' : 'Enable rich preview'}
                </DropdownMenuItem>
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={toggleWordDiffs}>
                  <FileDiffIcon className={MENU_ITEM_ICON_CLASS} />
                  {wordDiffs ? 'Disable word diffs' : 'Enable word diffs'}
                </DropdownMenuItem>
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem
                  className={MENU_ITEM_CLASS}
                  disabled={!data.patch.trim()}
                  onSelect={() => void copyGitApplyCommand()}
                >
                  <Copy className={MENU_ITEM_ICON_CLASS} />
                  Copy git apply command
                </DropdownMenuItem>
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={onToggleFullscreen}>
                  {isFullscreen ? (
                    <Minimize2 className={MENU_ITEM_ICON_CLASS} />
                  ) : (
                    <Maximize2 className={MENU_ITEM_ICON_CLASS} />
                  )}
                  {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={allExpanded ? collapseAll : expandAll}
              disabled={data.files.length === 0}
              className={`${ICON_BUTTON_CLASS} ${allExpanded ? 'bg-[var(--bg-tertiary)]' : ''}`}
              title={allExpanded ? 'Collapse all diffs' : 'Expand all diffs'}
              aria-label={allExpanded ? 'Collapse all diffs' : 'Expand all diffs'}
            >
              <ExpandAllGlyph className="h-4 w-4" />
            </button>
            <JumpToFileButton files={data.files} onSelect={jumpToFile} />
            <button
              type="button"
              onClick={() => setRenderMode((current) => current === 'unified' ? 'split' : 'unified')}
              className={`${ICON_BUTTON_CLASS} ${renderMode === 'split' ? 'bg-[var(--bg-tertiary)]' : ''}`}
              title={renderMode === 'unified' ? 'Split diff' : 'Unified diff'}
              aria-label={renderMode === 'unified' ? 'Split diff' : 'Unified diff'}
            >
              <SplitDiffGlyph className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={copyPatch}
              disabled={!data.patch.trim()}
              className={ICON_BUTTON_CLASS}
              title="Copy patch"
              aria-label="Copy patch"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            </button>
            {canCommit && cwd ? <CommitOrPushButton cwd={cwd} onRefresh={data.refresh} /> : null}
            <button
              type="button"
              onClick={onClose}
              className={ICON_BUTTON_CLASS}
              title="Close"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

      </div>

      <div ref={listRef} className="relative min-h-0 flex-1 overflow-auto bg-[var(--bg-primary)] px-3 py-3">
        {data.loading && data.files.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-3 top-3 z-10 rounded-md border border-[var(--border)] bg-[var(--bg-primary)]/85 px-3 py-2 text-xs text-[var(--text-muted)] shadow-sm backdrop-blur">
            Refreshing changes...
          </div>
        ) : null}

        {data.parseError ? (
          <div className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs text-amber-700">
            {data.parseError}
          </div>
        ) : null}

        {showEmpty ? (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center text-center">
            <FileDiffIcon className="mb-3 h-8 w-8 text-[var(--text-muted)]" />
            <div className="text-sm font-medium text-[var(--text-primary)]">{empty.title}</div>
            <div className="mt-1 max-w-[260px] text-xs leading-5 text-[var(--text-muted)]">{empty.detail}</div>
          </div>
        ) : (
          <Virtualizer>
            <div className="pb-8">
              {data.files.map((file) => (
                <DiffFileCard
                  key={file.key}
                  file={file}
                  expanded={expandedKeys.has(file.key)}
                  onToggle={() => toggleFile(file.key)}
                  options={diffOptions}
                  richPreview={richPreview}
                />
              ))}
            </div>
          </Virtualizer>
        )}

        {!data.loading && data.parseError && data.files.length === 0 && data.patch.trim() ? (
          <pre className="mt-3 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3 font-mono text-xs leading-5 text-[var(--text-primary)]">
            {data.patch}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function DiffFileCard({
  file,
  expanded,
  onToggle,
  options,
  richPreview,
}: {
  file: AegisDiffFile;
  expanded: boolean;
  onToggle: () => void;
  options: Parameters<typeof FileDiff>[0]['options'];
  richPreview: boolean;
}) {
  const basename = basenameOfDiffPath(file.path);
  const dir = file.path.slice(0, file.path.length - basename.length);
  // Rich preview off → force plain-text so the diff renders without syntax
  // highlighting.
  const fileDiff = useMemo(
    () => (richPreview || !file.diff ? file.diff : { ...file.diff, lang: 'text' as const }),
    [file.diff, richPreview]
  );

  return (
    <section data-aegis-diff-file={file.path} className="aegis-diff-card">
      <button
        type="button"
        onClick={onToggle}
        title={file.path}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left hover:bg-[var(--bg-tertiary)]/45 ${
          expanded ? 'bg-[var(--bg-secondary)]' : ''
        }`}
      >
        <FileTypeIcon
          name={basename}
          className="h-4 w-4 shrink-0"
          fallbackClassName="h-4 w-4 text-[var(--text-muted)]"
        />
        <span className="flex min-w-0 items-baseline font-mono text-[12px] leading-5">
          {dir ? <span className="min-w-0 truncate text-[var(--text-muted)]">{dir}</span> : null}
          <span className="shrink-0 font-medium text-[var(--text-primary)]">{basename}</span>
        </span>
        <DiffStatLabel additions={file.addedLines} deletions={file.removedLines} className="shrink-0" />
        {file.status === 'D' || file.status === 'R' ? (
          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{statusLabel(file)}</span>
        ) : null}
      </button>

      {expanded ? (
        <div className="aegis-diff-body -mx-3 bg-[var(--bg-primary)]">
          {fileDiff ? (
            <FileDiff
              fileDiff={fileDiff}
              options={options}
              disableWorkerPool
              className="aegis-file-diff"
            />
          ) : (
            <div className="px-4 py-3 text-xs text-[var(--text-muted)]">
              No inline diff captured for this file.
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Anchored "Jump to file" popover: filters the changed files and scrolls the
 * chosen file's diff into view.
 */
function JumpToFileButton({
  files,
  onSelect,
}: {
  files: AegisDiffFile[];
  onSelect: (file: AegisDiffFile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? files.filter((file) => file.path.toLowerCase().includes(needle))
      : files;
    return [...list].sort((a, b) =>
      basenameOfDiffPath(a.path).localeCompare(basenameOfDiffPath(b.path))
    );
  }, [files, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = useCallback(
    (file: AegisDiffFile) => {
      setOpen(false);
      onSelect(file);
    },
    [onSelect]
  );

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={files.length === 0}
        className={`${ICON_BUTTON_CLASS} ${open ? 'bg-[var(--bg-tertiary)]' : ''}`}
        title="Jump to file"
        aria-label="Jump to file"
      >
        <FileSearch className="h-4 w-4" />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-[340px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_12px_32px_rgba(15,23,42,0.14)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((current) => Math.min(current + 1, matches.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((current) => Math.max(current - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const file = matches[activeIndex];
                  if (file) choose(file);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                }
              }}
              placeholder="Jump to file"
              className="h-8 w-full bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto p-1">
            {matches.length === 0 ? (
              <div className="px-2.5 py-2 text-[12px] text-[var(--text-muted)]">No matching files</div>
            ) : (
              matches.map((file, index) => {
                const basename = basenameOfDiffPath(file.path);
                const dir = file.path.slice(0, file.path.length - basename.length);
                return (
                  <button
                    key={file.key}
                    type="button"
                    onClick={() => choose(file)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12px] ${
                      index === activeIndex ? 'bg-[var(--bg-tertiary)]/70' : ''
                    }`}
                    title={file.path}
                  >
                    <span className="shrink-0 text-[var(--text-primary)]">{basename}</span>
                    {dir ? (
                      <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">{dir}</span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Commit or push" split button: commit stages everything in the working
 * tree first (dialog with a generated message), push publishes the branch.
 */
function CommitOrPushButton({ cwd, onRefresh }: { cwd: string; onRefresh: () => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<'commit' | 'commit_push'>('commit');
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pushing, setPushing] = useState(false);

  const generateMessage = useCallback(async () => {
    setGenerating(true);
    try {
      const result = await window.electron.gitGenerateCommitMessage(cwd);
      if (result.ok && result.message) {
        setMessage(result.message);
      } else if (result.message) {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate commit message.');
    } finally {
      setGenerating(false);
    }
  }, [cwd]);

  const openDialog = useCallback(
    (nextMode: 'commit' | 'commit_push') => {
      setMode(nextMode);
      setMessage('');
      setDialogOpen(true);
      void generateMessage();
    },
    [generateMessage]
  );

  const runPush = useCallback(async () => {
    setPushing(true);
    try {
      const result = await window.electron.gitPush(cwd);
      if (!result.ok) {
        toast.error(result.message || 'Push failed.');
        return;
      }
      toast.success('Push completed.');
      onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Push failed.');
    } finally {
      setPushing(false);
    }
  }, [cwd, onRefresh]);

  const runCommit = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setWorking(true);
    try {
      const changes = await window.electron.getGitChanges(cwd);
      if (!changes.ok) {
        toast.error('Failed to read git status.');
        return;
      }
      if (changes.entries.length === 0) {
        toast.error('No changes to commit.');
        return;
      }
      for (const entry of changes.entries.filter((item) => !item.staged)) {
        const staged = await window.electron.gitStagePath(cwd, entry.filePath);
        if (!staged.ok) {
          toast.error(staged.message || `Failed to stage ${entry.filePath}.`);
          return;
        }
      }
      const commitResult = await window.electron.gitCommit(cwd, trimmed);
      if (!commitResult.ok) {
        toast.error(commitResult.message || 'Commit failed.');
        return;
      }
      if (mode === 'commit_push') {
        const pushResult = await window.electron.gitPush(cwd);
        if (!pushResult.ok) {
          toast.error(pushResult.message || 'Push failed.');
          return;
        }
      }
      toast.success(mode === 'commit_push' ? 'Commit and push completed.' : 'Commit created.');
      setDialogOpen(false);
      setMessage('');
      onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Commit failed.');
    } finally {
      setWorking(false);
    }
  }, [cwd, message, mode, onRefresh]);

  const busy = working || pushing;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="ml-1 inline-flex h-7 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
            ) : (
              <GitCommitHorizontalGlyph className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            )}
            <span>Commit or push</span>
            <ChevronDown className="h-3 w-3 text-[var(--text-muted)]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[190px] p-1">
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openDialog('commit')}>
            Commit...
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openDialog('commit_push')}>
            Commit and push...
          </DropdownMenuItem>
          <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={pushing} onSelect={() => void runPush()}>
            Push
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/18 backdrop-blur-[1px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[100] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_60px_rgba(15,23,42,0.18)] outline-none">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <Dialog.Title className="text-[14px] font-semibold text-[var(--text-primary)]">
                Commit all changes
              </Dialog.Title>
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-3 px-4 py-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-[var(--text-secondary)]">Message</span>
                <button
                  type="button"
                  onClick={() => void generateMessage()}
                  disabled={generating || working}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generating ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  <span>{generating ? 'Generating...' : 'Generate'}</span>
                </button>
              </div>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={generating ? 'Generating commit message...' : 'Commit message...'}
                rows={4}
                className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-[13px] leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void runCommit()}
                disabled={working || generating || !message.trim()}
                className="inline-flex h-8 min-w-[110px] items-center justify-center rounded-md bg-[var(--accent)] px-3 text-[13px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {working ? 'Working...' : mode === 'commit_push' ? 'Commit & Push' : 'Commit'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
