import { Terminal, X } from 'lucide-react';
import type { ClaudeSlashCommand } from '../utils/claude-slash';

export function SelectedClaudeCommandChip({
  command,
  onClear,
}: {
  command: ClaudeSlashCommand;
  onClear: () => void;
}) {
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 py-2 shadow-sm">
      <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
        <Terminal className="w-3.5 h-3.5" />
      </div>

      <div
        className="max-w-[220px] truncate text-sm font-medium text-[var(--text-primary)]"
        title={command.title}
      >
        {command.title}
      </div>

      <button
        type="button"
        onClick={onClear}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition-colors"
        aria-label="Remove selected command"
        title="Remove command"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
