import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileDiff, Virtualizer } from '@pierre/diffs/react';
import { toast } from 'sonner';
import type { GitPatchScope, ReviewDiffSelection, SessionView } from '../types';
import { useAppStore } from '../store/useAppStore';
import {
  buildReviewTurnSelection,
  buildWorkspaceReviewSelection,
  useAegisDiffPanelData,
} from '../hooks/useAegisDiffPanelData';
import type { AegisDiffFile, AegisDiffRenderMode } from '../utils/aegis-diff-rendering';
import { basenameOfDiffPath } from '../utils/aegis-diff-rendering';
import { DiffStatLabel } from './DiffStatLabel';
import { FileTypeIcon } from './FileTypeIcon';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff as FileDiffIcon,
  GitBranch,
  LayoutList,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  X,
} from './icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const WORKSPACE_SCOPES: Array<{ scope: GitPatchScope; label: string }> = [
  { scope: 'working-tree', label: 'Working tree' },
  { scope: 'unstaged', label: 'Unstaged' },
  { scope: 'staged', label: 'Staged' },
  { scope: 'branch', label: 'Branch' },
];

function sourceLabel(selection: ReviewDiffSelection): string {
  if (selection.source.kind === 'turn') return selection.source.label;
  return selection.source.label || WORKSPACE_SCOPES.find((entry) => entry.scope === selection.source.scope)?.label || 'Working tree';
}

function sourceSubtitle(selection: ReviewDiffSelection): string {
  if (selection.source.kind === 'turn') return 'current turn';
  return selection.source.scope;
}

function statusLabel(file: AegisDiffFile): string {
  if (file.status === 'A' || file.status === '?') return 'added';
  if (file.status === 'D') return 'deleted';
  if (file.status === 'R') return 'renamed';
  return 'modified';
}

function emptyMessage(selection: ReviewDiffSelection, error: string | null): { title: string; detail: string } {
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
  return { title: 'Working tree is clean', detail: 'No file changes are available for this scope.' };
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

  const collapseAll = useCallback(() => setExpandedKeys(new Set()), []);
  const expandAll = useCallback(() => setExpandedKeys(new Set(files.map((file) => file.key))), [files]);

  return { expandedKeys, toggleFile, collapseAll, expandAll };
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
  const [query, setQuery] = useState('');
  const [renderMode, setRenderMode] = useState<AegisDiffRenderMode>('unified');
  const [copied, setCopied] = useState(false);
  const { expandedKeys, toggleFile, collapseAll, expandAll } = useExpandedFiles(data.files, data.selection);

  const filteredFiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data.files;
    return data.files.filter((file) => file.path.toLowerCase().includes(needle));
  }, [data.files, query]);

  const diffOptions = useMemo(
    () => ({
      diffStyle: renderMode,
      hunkSeparators: 'line-info-basic' as const,
      disableFileHeader: true,
      stickyHeader: false,
      overflow: 'scroll' as const,
      diffIndicators: 'bars' as const,
      lineDiffType: 'word' as const,
      useCSSClasses: true,
      tokenizeMaxLineLength: 400,
    }),
    [renderMode]
  );

  const openWorkspaceScope = useCallback((scope: GitPatchScope) => {
    setReviewDiffSelection(buildWorkspaceReviewSelection(scope));
  }, [setReviewDiffSelection]);

  const openTurn = useCallback((turnKey: string) => {
    const turn = data.turns.find((entry) => entry.key === turnKey);
    if (!turn) return;
    setReviewDiffSelection(buildReviewTurnSelection(turn.summary, session?.id ?? null));
  }, [data.turns, session?.id, setReviewDiffSelection]);

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

  const showEmpty = !data.loading && filteredFiles.length === 0;
  const empty = emptyMessage(data.selection, data.error);

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
                className="inline-flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              >
                <FileDiffIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                <span className="min-w-0 truncate font-medium">{sourceLabel(data.selection)}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px]">
              {WORKSPACE_SCOPES.map((entry) => (
                <DropdownMenuItem key={entry.scope} onSelect={() => openWorkspaceScope(entry.scope)}>
                  <GitBranch className="mr-2 h-4 w-4 text-[var(--text-muted)]" />
                  <span>{entry.label}</span>
                </DropdownMenuItem>
              ))}
              {data.turns.length > 0 ? <DropdownMenuSeparator /> : null}
              {data.turns.map((entry) => (
                <DropdownMenuItem key={entry.key} onSelect={() => openTurn(entry.key)}>
                  <FileDiffIcon className="mr-2 h-4 w-4 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  <DiffStatLabel additions={entry.summary.totalAdded} deletions={entry.summary.totalRemoved} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="hidden min-w-0 items-center gap-2 text-xs text-[var(--text-muted)] sm:flex">
            <span className="rounded-md bg-[var(--bg-secondary)] px-1.5 py-0.5 font-mono">
              {sourceSubtitle(data.selection)}
            </span>
            <span>{data.summary.totalFiles} files</span>
            <DiffStatLabel additions={data.summary.addedLines} deletions={data.summary.removedLines} />
            {data.gitResult?.truncated ? (
              <span className="text-amber-600">truncated</span>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={data.refresh}
              disabled={data.loading || data.selection.source.kind !== 'workspace'}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-40"
              title="Refresh"
              aria-label="Refresh"
            >
              {data.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setRenderMode((current) => current === 'unified' ? 'split' : 'unified')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              title={renderMode === 'unified' ? 'Split diff' : 'Unified diff'}
              aria-label={renderMode === 'unified' ? 'Split diff' : 'Unified diff'}
            >
              <LayoutList className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={copyPatch}
              disabled={!data.patch.trim()}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-40"
              title="Copy patch"
              aria-label="Copy patch"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              title="Close"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex h-10 items-center gap-2 px-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter files..."
              className="h-7 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] pl-7 pr-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
          </div>
          <button
            type="button"
            onClick={expandedKeys.size === data.files.length ? collapseAll : expandAll}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            {expandedKeys.size === data.files.length ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto bg-[var(--bg-primary)] px-3 py-3">
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
            <div className="space-y-2 pb-8">
              {filteredFiles.map((file) => (
                <DiffFileCard
                  key={file.key}
                  file={file}
                  expanded={expandedKeys.has(file.key)}
                  onToggle={() => toggleFile(file.key)}
                  options={diffOptions}
                />
              ))}
            </div>
          </Virtualizer>
        )}

        {!data.loading && data.parseError && filteredFiles.length === 0 && data.patch.trim() ? (
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
}: {
  file: AegisDiffFile;
  expanded: boolean;
  onToggle: () => void;
  options: Parameters<typeof FileDiff>[0]['options'];
}) {
  return (
    <section
      data-aegis-diff-file={file.path}
      className="aegis-diff-card overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/60"
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-[42px] w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)]/35"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <FileTypeIcon
          name={basenameOfDiffPath(file.path)}
          className="h-4 w-4 shrink-0"
          fallbackClassName="h-4 w-4 text-[var(--text-muted)]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] font-medium text-[var(--text-primary)]" title={file.path}>
            {file.path}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{statusLabel(file)}</div>
        </div>
        <DiffStatLabel additions={file.addedLines} deletions={file.removedLines} />
      </button>

      {expanded ? (
        <div className="aegis-diff-body border-t border-[var(--border)] bg-[var(--bg-primary)]">
          {file.diff ? (
            <FileDiff
              fileDiff={file.diff}
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
