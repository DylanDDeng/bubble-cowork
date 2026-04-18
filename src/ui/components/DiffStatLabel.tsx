import { memo } from 'react';

interface DiffStatLabelProps {
  additions: number;
  deletions: number;
  muted?: boolean;
  className?: string;
}

export const DiffStatLabel = memo(function DiffStatLabel({
  additions,
  deletions,
  muted = false,
  className = '',
}: DiffStatLabelProps) {
  if (additions <= 0 && deletions <= 0) {
    return null;
  }

  const addTone = muted ? 'text-emerald-500/80' : 'text-emerald-500';
  const delTone = muted ? 'text-rose-500/80' : 'text-rose-500';

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[11px] tabular-nums ${className}`}
    >
      {additions > 0 ? <span className={addTone}>+{additions}</span> : null}
      {deletions > 0 ? <span className={delTone}>-{deletions}</span> : null}
    </span>
  );
});
