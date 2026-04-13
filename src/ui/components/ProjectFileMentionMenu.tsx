import { Search } from 'lucide-react';
import type { ProjectFileSuggestion } from '../utils/project-file-mentions';
import { FileTypeIcon } from './FileTypeIcon';

export function ProjectFileMentionMenu({
  suggestions,
  selectedIndex,
  loading = false,
  onSelect,
}: {
  suggestions: ProjectFileSuggestion[];
  selectedIndex: number;
  loading?: boolean;
  onSelect: (suggestion: ProjectFileSuggestion) => void;
}) {
  return (
    <div className="mx-4 mb-3 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_10px_28px_rgba(0,0,0,0.045)]">
      <div className="px-3 pt-2.5 pb-1.5">
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          <Search className="h-3.5 w-3.5" />
          <span>Project Files</span>
        </div>
      </div>

      {loading ? (
        <div className="px-3 pb-3 text-[11px] text-[var(--text-muted)]">
          Loading project files...
        </div>
      ) : suggestions.length === 0 ? (
        <div className="px-3 pb-3 text-[11px] text-[var(--text-muted)]">
          No matching files in this project.
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto px-1.5 pb-1.5">
          {suggestions.map((suggestion, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={suggestion.path}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(suggestion);
                }}
                className={`flex w-full items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 text-left transition-colors ${
                  selected ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]/80'
                }`}
              >
                <FileTypeIcon name={suggestion.name} />

                <div className="min-w-0 flex-1 text-[11px] leading-none">
                  <div className="truncate font-mono font-medium text-[var(--text-primary)]">
                    @{suggestion.relativePath}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
