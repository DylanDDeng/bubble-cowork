import { Boxes, X } from 'lucide-react';
import type { ClaudeSkillSummary } from '../types';

export function SelectedClaudeSkillChip({
  skill,
  onClear,
}: {
  skill: ClaudeSkillSummary;
  onClear?: () => void;
}) {
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 py-2 shadow-sm">
      <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
        <Boxes className="w-3.5 h-3.5" />
      </div>

      <div
        className="max-w-[220px] truncate text-sm font-medium text-[var(--text-primary)]"
        title={skill.title}
      >
        {skill.title}
      </div>

      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition-colors"
          aria-label="Remove selected skill"
          title="Remove skill"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
