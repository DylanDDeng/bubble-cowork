import { useMemo, useState } from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui-components/react/tooltip';
import { ChevronDown, ChevronRight } from './icons';
import { FileTypeIcon } from './FileTypeIcon';
import { DiffStatLabel } from './DiffStatLabel';
import { DiffHunkView } from './UnifiedDiffView';
import { useTurnDiffContext } from './TurnDiffContext';
import { parseUnifiedDiff, type UnifiedDiffHunk } from '../utils/unified-diff';
import type { ChangeRecord } from '../utils/change-records';
import type { TurnChangeSummary } from '../utils/turn-change-records';
import { getTurnDiffKey, getTurnDiffLabel } from '../utils/review-diff-selection';

/**
 * Rows shown before the list folds the tail behind "Show N more files".
 * Small turns (the common case) stay fully visible; a 40-file refactor doesn't
 * push the rest of the conversation off-screen.
 */
const VISIBLE_FILE_LIMIT = 5;

/** Cap on diff lines rendered inside the hover preview. */
const PREVIEW_LINE_LIMIT = 60;

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** Trims parsed hunks down to `PREVIEW_LINE_LIMIT` lines, hunk by hunk. */
function takePreviewHunks(hunks: UnifiedDiffHunk[]): {
  hunks: UnifiedDiffHunk[];
  hiddenLines: number;
} {
  const totalLines = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (totalLines <= PREVIEW_LINE_LIMIT) {
    return { hunks, hiddenLines: 0 };
  }

  const trimmed: UnifiedDiffHunk[] = [];
  let budget = PREVIEW_LINE_LIMIT;
  for (const hunk of hunks) {
    if (budget <= 0) break;
    trimmed.push(
      hunk.lines.length <= budget ? hunk : { ...hunk, lines: hunk.lines.slice(0, budget) }
    );
    budget -= hunk.lines.length;
  }
  return { hunks: trimmed, hiddenLines: totalLines - PREVIEW_LINE_LIMIT };
}

export function TurnChangesCard({ summary }: { summary: TurnChangeSummary }) {
  // Expanded by default — the file list is the point of the card; collapsing it
  // hid the result of the turn behind an extra click.
  const [expanded, setExpanded] = useState(true);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const { onOpenDiff } = useTurnDiffContext();

  if (summary.records.length === 0) {
    return null;
  }

  const fileWord = summary.totalFiles === 1 ? 'file' : 'files';
  const turnKey = getTurnDiffKey(summary);
  const overflowCount = Math.max(0, summary.records.length - VISIBLE_FILE_LIMIT);
  const visibleRecords =
    showAllFiles || overflowCount === 0
      ? summary.records
      : summary.records.slice(0, VISIBLE_FILE_LIMIT);

  return (
    <div className="my-3 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)]/70">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]/25"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform duration-200 ${
            expanded ? 'rotate-90' : ''
          }`}
        />
        <span className="text-[13px] font-medium text-[var(--text-primary)]">
          {summary.totalFiles} {fileWord} changed
        </span>
        <span className="ml-auto">
          <DiffStatLabel
            additions={summary.totalAdded}
            deletions={summary.totalRemoved}
            muted
          />
        </span>
      </button>

      {expanded ? (
        <>
          <ul className="border-t border-[var(--border)]/50 bg-[var(--bg-primary)]/40">
            {visibleRecords.map((record) => (
              <li key={`${record.filePath}:${record.id}`}>
                <ChangedFileRow
                  record={record}
                  onOpenDiff={
                    onOpenDiff
                      ? () =>
                          onOpenDiff(record, {
                            records: summary.records,
                            label: getTurnDiffLabel(summary),
                            turnKey,
                          })
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>

          {overflowCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAllFiles((current) => !current)}
              className="flex w-full items-center gap-1.5 border-t border-[var(--border)]/50 bg-[var(--bg-primary)]/40 px-3 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]/40 hover:text-[var(--text-primary)]"
              aria-expanded={showAllFiles}
            >
              <span>
                {showAllFiles
                  ? 'Show fewer files'
                  : `Show ${overflowCount} more ${overflowCount === 1 ? 'file' : 'files'}`}
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform duration-200 ${
                  showAllFiles ? 'rotate-180' : ''
                }`}
              />
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ChangedFileRow({
  record,
  onOpenDiff,
}: {
  record: ChangeRecord;
  onOpenDiff?: () => void;
}) {
  const clickable = Boolean(onOpenDiff);

  return (
    <TooltipPrimitive.Root disableHoverablePopup>
      <TooltipPrimitive.Trigger
        delay={280}
        closeDelay={80}
        render={
          <button
            type="button"
            onClick={onOpenDiff}
            // Not `disabled` — a disabled button swallows pointer events, which
            // would kill the hover preview for rows with no diff panel wired up.
            aria-disabled={!clickable}
            className={`group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
              clickable ? 'cursor-pointer hover:bg-[var(--bg-tertiary)]/40' : 'cursor-default'
            }`}
          >
            <FileTypeIcon
              name={basename(record.filePath)}
              className="h-4 w-4 shrink-0 opacity-80"
            />
            <span
              className={`min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-primary)] ${
                clickable ? 'group-hover:text-[var(--accent)]' : ''
              }`}
            >
              {record.filePath}
            </span>
            <DiffStatLabel additions={record.addedLines} deletions={record.removedLines} />
          </button>
        }
      />

      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="z-[130]"
        >
          <TooltipPrimitive.Popup className="w-[min(620px,calc(100vw-4rem))] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--popover-border)] bg-[var(--popover-bg)] text-left shadow-[var(--popover-shadow-lg)] outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[starting-style]:translate-y-1 data-[starting-style]:opacity-0 data-[ending-style]:translate-y-1 data-[ending-style]:opacity-0">
            <FileDiffPreview record={record} clickable={clickable} />
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

function FileDiffPreview({
  record,
  clickable,
}: {
  record: ChangeRecord;
  clickable: boolean;
}) {
  const { hunks, hiddenLines } = useMemo(() => {
    if (!record.diffContent) {
      return { hunks: [] as UnifiedDiffHunk[], hiddenLines: 0 };
    }
    return takePreviewHunks(parseUnifiedDiff(record.diffContent));
  }, [record.diffContent]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--border)]/60 px-3 py-2">
        <FileTypeIcon name={basename(record.filePath)} className="h-4 w-4 shrink-0 opacity-80" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-primary)]">
          {record.filePath}
        </span>
        <DiffStatLabel additions={record.addedLines} deletions={record.removedLines} />
      </div>

      {hunks.length > 0 ? (
        <>
          <div className="max-h-[320px] overflow-hidden bg-[var(--bg-primary)]/40">
            {hunks.map((hunk, index) => (
              <DiffHunkView
                key={`${hunk.oldStart}-${hunk.newStart}-${index}`}
                hunk={hunk}
                compact
              />
            ))}
          </div>
          {hiddenLines > 0 || clickable ? (
            <div className="border-t border-[var(--border)]/60 px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
              {hiddenLines > 0 ? `${hiddenLines} more lines · ` : ''}
              {clickable ? 'Click to open the full diff' : 'Preview'}
            </div>
          ) : null}
        </>
      ) : (
        <div className="px-3 py-2.5 text-[12px] text-[var(--text-muted)]">
          {clickable
            ? 'No inline diff captured for this change — click to open it.'
            : 'No inline diff captured for this change.'}
        </div>
      )}
    </>
  );
}
