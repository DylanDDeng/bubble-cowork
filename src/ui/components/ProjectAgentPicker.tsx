import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AgentAvatar } from './AgentAvatar';
import { Check, ChevronDown } from './icons';
import type { AgentProfile } from '../types';
import { getAgentMentionHandle } from '../utils/agent-mentions';

function providerLabel(provider: AgentProfile['provider']): string {
  if (provider === 'aegis') return 'Aegis';
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  return 'Claude';
}

export function ProjectAgentPicker({
  profiles,
  selectedProfile,
  disabled,
  onSelect,
}: {
  profiles: AgentProfile[];
  selectedProfile: AgentProfile | null;
  disabled: boolean;
  onSelect: (profileId: string) => void;
}) {
  if (profiles.length === 0) {
    return null;
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-8 min-w-0 max-w-[220px] items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--bg-tertiary)_76%,var(--accent)_24%)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          title={selectedProfile ? `Send with ${selectedProfile.name.trim() || 'Agent'}` : 'Select agent'}
          aria-label="Select project agent"
        >
          {selectedProfile ? (
            <AgentAvatar profile={selectedProfile} size="sm" decorative />
          ) : null}
          <span className="min-w-0 truncate">
            {selectedProfile?.name.trim() || 'Select agent'}
          </span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={8}
          className="z-50 w-[280px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
        >
          {profiles.map((profile) => {
            const selected = selectedProfile?.id === profile.id;
            return (
              <DropdownMenu.Item
                key={profile.id}
                onSelect={() => onSelect(profile.id)}
                className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
              >
                <AgentAvatar profile={profile} size="sm" decorative />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                    {profile.name.trim() || 'Agent'}
                  </div>
                  <div className="truncate text-[11px] text-[var(--text-muted)]">
                    @{getAgentMentionHandle(profile)} - {profile.role.trim() || 'Agent'} - {providerLabel(profile.provider)}
                  </div>
                </div>
                {selected ? <Check className="h-4 w-4 text-[var(--accent)]" /> : null}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
