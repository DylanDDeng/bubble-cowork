import { Sparkles } from 'lucide-react';
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
    <div className="mx-4 mb-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
        <Sparkles className="w-3.5 h-3.5" />
        <span>Claude Skills</span>
        <span className="font-mono">Tab</span>
        <span>or</span>
        <span className="font-mono">Enter</span>
        <span>to insert</span>
      </div>

      {empty ? (
        <div className="px-4 py-3 text-sm text-[var(--text-muted)]">
          No matching Claude skills.
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto py-1">
          {suggestions.map((skill, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={`${skill.source}:${skill.name}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(skill);
                }}
                className={`w-full px-4 py-3 text-left transition-colors ${
                  selected ? 'bg-[var(--accent-light)]' : 'hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm text-[var(--text-primary)]">/{skill.name}</span>
                  <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
                    {skill.source === 'project' ? 'Project' : 'User'}
                  </span>
                </div>
                {skill.description && (
                  <div className="mt-1 text-sm text-[var(--text-secondary)] break-words">
                    {skill.description}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
