import { Boxes, Search } from 'lucide-react';
import type { ClaudeSkillSummary } from '../types';

export function ClaudeSkillMenu({
  suggestions,
  selectedIndex,
  empty,
  onSelect,
}: {
  suggestions: ClaudeSkillSummary[];
  selectedIndex: number;
  empty?: boolean;
  onSelect: (skill: ClaudeSkillSummary) => void;
}) {
  return (
    <div className="mx-4 mb-3 rounded-[28px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_8px_24px_rgba(0,0,0,0.04)] overflow-hidden">
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
          <Search className="w-3.5 h-3.5" />
          <span>Skills</span>
        </div>
      </div>

      {empty ? (
        <div className="px-4 pb-4 text-sm text-[var(--text-muted)]">
          No matching Claude skills.
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto px-2 pb-2">
          {suggestions.map((skill, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={`${skill.source}:${skill.name}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(skill);
                }}
                className={`w-full flex items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors ${
                  selected ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]/80'
                }`}
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                  <Boxes className="w-4 h-4" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate font-mono text-[13px] font-semibold text-[var(--text-primary)]">
                      {skill.title}
                    </span>
                    <span className="truncate text-[13px] text-[var(--text-muted)]">
                      {skill.description || `/${skill.name}`}
                    </span>
                  </div>
                </div>

                <div className="flex-shrink-0 text-[12px] text-[var(--text-muted)]">
                  {skill.source === 'project' ? 'Workspace' : 'Personal'}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
