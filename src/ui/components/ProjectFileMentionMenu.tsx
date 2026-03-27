import { File, Search } from 'lucide-react';
import type { ProjectFileSuggestion } from '../utils/project-file-mentions';

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
    <div className="mx-4 mb-3 overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_8px_24px_rgba(0,0,0,0.04)]">
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
          <Search className="h-3.5 w-3.5" />
          <span>Project Files</span>
        </div>
      </div>

      {loading ? (
        <div className="px-4 pb-4 text-sm text-[var(--text-muted)]">
          Loading project files...
        </div>
      ) : suggestions.length === 0 ? (
        <div className="px-4 pb-4 text-sm text-[var(--text-muted)]">
          No matching files in this project.
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto px-2 pb-2">
          {suggestions.map((suggestion, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={suggestion.path}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(suggestion);
                }}
                className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-2 text-left transition-colors ${
                  selected ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]/80'
                }`}
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                  <File className="h-4 w-4" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11px] font-semibold text-[var(--text-primary)]">
                    @{suggestion.relativePath}
                  </div>
                  <div className="truncate text-[11px] text-[var(--text-muted)]">
                    {suggestion.name}
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
