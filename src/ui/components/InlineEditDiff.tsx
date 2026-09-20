import { useMemo } from 'react';
import type { ChangeRecord } from '../utils/change-records';
import { parseUnifiedDiff } from '../utils/unified-diff';
import { highlightCodeLines } from './HighlightedCode';
import { DiffStatLabel } from './DiffStatLabel';

/** The individual edit's recorded patch, never the current working-tree diff. */
export function InlineEditDiff({ record, onOpen }: { record: ChangeRecord; onOpen?: () => void }) {
  const hunks = useMemo(() => parseUnifiedDiff(record.diffContent || '').map(hunk => ({
    ...hunk,
    highlighted: highlightCodeLines(hunk.lines.map(line => line.text).join('\n'), undefined, record.fileName),
  })), [record.diffContent, record.fileName]);
  return (
    <div data-inline-edit-diff={record.filePath} className="my-1 min-w-0 overflow-hidden rounded-lg border border-[var(--border)]/60">
      <div className="flex items-center gap-2 border-b border-[var(--border)]/50 bg-[var(--bg-secondary)]/50 px-3 py-1.5 text-[11px]">
        {onOpen ? <button type="button" onClick={onOpen} title={record.filePath} className="min-w-0 truncate text-[var(--text-secondary)] hover:underline">{record.fileName}</button>
          : <span title={record.filePath} className="min-w-0 truncate text-[var(--text-secondary)]">{record.fileName}</span>}
        <DiffStatLabel additions={record.addedLines} deletions={record.removedLines} />
      </div>
      {hunks.length ? (
        <div className="max-h-72 overflow-auto" tabIndex={0} aria-label={`Changes to ${record.fileName}`}>
          <div className="w-max min-w-full font-mono text-[11px] leading-5 aegis-code-text">
            {hunks.map((hunk, hunkIndex) => <div key={hunkIndex} className="border-t border-[var(--border)]/50 first:border-t-0">
              {hunk.lines.map((line, index) => <div key={index} data-diff-line={line.type}
                className={`flex border-l-2 ${line.type === 'addition' ? 'border-emerald-500 bg-emerald-500/10' : line.type === 'deletion' ? 'border-rose-500 bg-rose-500/10' : 'border-transparent'}`}>
                <span className="w-12 shrink-0 select-none px-2 text-right text-[var(--text-muted)]">{line.newLineNumber ?? line.oldLineNumber}</span>
                <span className="w-4 shrink-0 select-none text-[var(--text-muted)]">{line.type === 'addition' ? '+' : line.type === 'deletion' ? '−' : ''}</span>
                <code className="whitespace-pre px-2 text-[var(--text-primary)]" dangerouslySetInnerHTML={{ __html: hunk.highlighted[index] || ' ' }} />
              </div>)}
            </div>)}
          </div>
        </div>
      ) : <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">No text diff available for this change.</div>}
    </div>
  );
}
