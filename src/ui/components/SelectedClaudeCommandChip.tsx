import { Terminal, X } from './icons';
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
  const label = command.title.replace(/^\//, '');

  return (
    <div
      className={`composer-inline-chip composer-inline-chip--command composer-inline-chip--message ${
        compact ? '' : 'composer-inline-chip--large'
      }`}
      title={command.title}
    >
      <span className="composer-inline-chip__icon" aria-hidden="true">
        <Terminal />
      </span>

      <span className="composer-inline-chip__label max-w-[180px]">
        {label}
      </span>

      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="composer-inline-chip__clear"
          aria-label="Remove selected command"
          title="Remove command"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
