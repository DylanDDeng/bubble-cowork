import { Terminal, X } from 'lucide-react';
import type { ClaudeSlashCommand } from '../utils/claude-slash';

export function SelectedClaudeCommandChip({
  command,
  onClear,
  compact = false,
}: {
  command: ClaudeSlashCommand;
  onClear?: () => void;
  compact?: boolean;
}) {
  const label = compact ? command.title.replace(/^\//, '') : command.title;

  return (
    <div
      className={`inline-flex max-w-full items-center border border-[var(--border)] bg-[var(--bg-tertiary)] shadow-sm ${
        compact ? 'gap-1.5 rounded-[10px] px-2 py-0.5' : 'gap-2 rounded-[14px] px-2.5 py-2'
      }`}
    >
      <div
        className={`flex flex-shrink-0 items-center justify-center border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] ${
          compact ? 'h-4.5 w-4.5 rounded-sm' : 'h-6 w-6 rounded-lg'
        }`}
      >
        <Terminal className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
      </div>

      <div
        className={`truncate font-medium text-[var(--text-primary)] ${
          compact ? 'max-w-[180px] text-[11px] font-semibold text-black' : 'max-w-[220px] text-sm'
        }`}
        title={command.title}
      >
        {label}
      </div>

      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className={`flex flex-shrink-0 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition-colors ${
            compact ? 'h-4.5 w-4.5 rounded-sm' : 'h-6 w-6 rounded-md'
          }`}
          aria-label="Remove selected command"
          title="Remove command"
        >
          <X className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
        </button>
      )}
    </div>
  );
}
