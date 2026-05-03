import { Users } from 'lucide-react';
import type { ProjectAgentMentionSuggestion } from '../utils/agent-mentions';
import { AgentAvatar } from './AgentAvatar';

function providerLabel(provider: ProjectAgentMentionSuggestion['profile']['provider']): string {
  if (provider === 'aegis') return 'Aegis';
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  return 'Claude';
}

export function ProjectAgentMentionMenu({
  suggestions,
  selectedIndex,
  onSelect,
}: {
  suggestions: ProjectAgentMentionSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: ProjectAgentMentionSuggestion) => void;
}) {
  return (
    <div className="mx-4 mb-3 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_10px_28px_rgba(0,0,0,0.045)]">
      <div className="px-3 pt-2.5 pb-1.5">
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          <Users className="h-3.5 w-3.5" />
          <span>Project Agents</span>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto px-1.5 pb-1.5">
        {suggestions.map((suggestion, index) => {
          const selected = index === selectedIndex;
          const profile = suggestion.profile;
          return (
            <button
              key={profile.id}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(suggestion);
              }}
              className={`flex w-full items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 text-left transition-colors ${
                selected ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]/80'
              }`}
            >
              <AgentAvatar profile={profile} size="sm" decorative />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                  @{suggestion.handle}
                </div>
                <div className="truncate text-[11px] text-[var(--text-muted)]">
                  {profile.role.trim() || 'Agent'} · {providerLabel(profile.provider)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
