import type { UnifiedDiffHunk, UnifiedDiffLine } from '../utils/unified-diff';

/**
 * Shared unified-diff renderer.
 *
 * `compact` drops the old-line-number gutter — used by narrow surfaces like the
 * turn-changes hover preview, where two number columns eat too much width.
 */

export function DiffHunkView({
  hunk,
  compact = false,
}: {
  hunk: UnifiedDiffHunk;
  compact?: boolean;
}) {
  return (
    <div className="border-t border-[var(--border)]/50 first:border-t-0">
      {/* The `@@ -a,b +c,d @@` header is noise in the hover preview — line
          numbers already carry the position there. */}
      {compact ? null : (
        <div className="px-3 py-1 font-mono text-[11px] text-[var(--text-muted)]">
          {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
        </div>
      )}
      {hunk.lines.map((line, index) => (
        <DiffLineView
          key={`${hunk.oldStart}-${hunk.newStart}-${index}`}
          line={line}
          compact={compact}
        />
      ))}
    </div>
  );
}

export function DiffLineView({
  line,
  compact = false,
}: {
  line: UnifiedDiffLine;
  compact?: boolean;
}) {
  const containerClass =
    line.type === 'addition'
      ? 'bg-emerald-500/10'
      : line.type === 'deletion'
        ? 'bg-rose-500/10'
        : 'bg-transparent';
  const markerClass =
    line.type === 'addition'
      ? 'text-emerald-400'
      : line.type === 'deletion'
        ? 'text-rose-400'
        : 'text-[var(--text-muted)]';
  const marker = line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' ';
  return (
    <div
      className={`grid items-start gap-0 font-mono ${
        compact
          ? 'grid-cols-[48px_16px_minmax(0,1fr)] text-[11px] leading-5'
          : 'grid-cols-[56px_56px_18px_minmax(0,1fr)] text-[12px] leading-6'
      } ${containerClass}`}
    >
      {compact ? null : (
        <div className="px-2 text-right text-[var(--text-muted)]">{line.oldLineNumber ?? ''}</div>
      )}
      <div className="px-2 text-right text-[var(--text-muted)]">
        {(compact ? (line.newLineNumber ?? line.oldLineNumber) : line.newLineNumber) ?? ''}
      </div>
      <div className={`px-1 text-center ${markerClass}`}>{marker}</div>
      <div
        className={`min-w-0 px-2 text-[var(--text-primary)] ${
          compact ? 'truncate' : 'whitespace-pre-wrap break-words'
        }`}
      >
        {line.text || ' '}
      </div>
    </div>
  );
}
