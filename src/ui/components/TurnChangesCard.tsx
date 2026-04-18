import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { FileTypeIcon } from './FileTypeIcon';
import { DiffStatLabel } from './DiffStatLabel';
import { useTurnDiffContext } from './TurnDiffContext';
import type { TurnChangeSummary } from '../utils/turn-change-records';

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function TurnChangesCard({ summary }: { summary: TurnChangeSummary }) {
  const [expanded, setExpanded] = useState(true);
  const { onOpenDiff } = useTurnDiffContext();

  if (summary.records.length === 0) {
    return null;
  }

  const fileWord = summary.totalFiles === 1 ? 'file' : 'files';

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
        <ul className="border-t border-[var(--border)]/50 bg-[var(--bg-primary)]/40">
              {summary.records.map((record) => {
                const clickable = Boolean(onOpenDiff);
                return (
              <li key={`${record.filePath}:${record.id}`}>
                <button
                  type="button"
                  onClick={clickable ? () => onOpenDiff?.(record) : undefined}
                  disabled={!clickable}
                  className={`group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    clickable
                      ? 'cursor-pointer hover:bg-[var(--bg-tertiary)]/40'
                      : 'cursor-default'
                  }`}
                  title={record.filePath}
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
                  <DiffStatLabel
                    additions={record.addedLines}
                    deletions={record.removedLines}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
