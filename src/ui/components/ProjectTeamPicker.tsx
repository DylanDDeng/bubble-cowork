import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Users } from './icons';
import type { SessionTeamMode, TeamProfile } from '../types';

function teamLabel(team: TeamProfile | null | undefined): string {
  return team?.name.trim() || 'Team';
}

export function ProjectTeamPicker({
  teams,
  selectedMode,
  selectedTeam,
  channelDefaultTeam,
  disabled,
  onSelect,
}: {
  teams: TeamProfile[];
  selectedMode: SessionTeamMode;
  selectedTeam: TeamProfile | null;
  channelDefaultTeam: TeamProfile | null;
  disabled: boolean;
  onSelect: (mode: SessionTeamMode, teamId?: string | null) => void;
}) {
  if (teams.length === 0 && !channelDefaultTeam) {
    return null;
  }

  const label =
    selectedMode === 'solo'
      ? 'Solo'
      : selectedMode === 'channel_default'
        ? channelDefaultTeam
          ? `Team · ${teamLabel(channelDefaultTeam)}`
          : 'Channel default'
        : selectedTeam
          ? `Team · ${teamLabel(selectedTeam)}`
          : 'Team';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-8 min-w-0 max-w-[240px] items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--bg-tertiary)_76%,var(--accent)_24%)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          title={label}
          aria-label="Select channel team"
        >
          <Users className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={8}
          className="z-50 w-[300px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
        >
          <TeamMenuItem
            selected={selectedMode === 'channel_default'}
            title={channelDefaultTeam ? `Use channel default: ${teamLabel(channelDefaultTeam)}` : 'Use channel default'}
            description={channelDefaultTeam ? 'Follow this channel default team.' : 'No default team is set.'}
            onSelect={() => onSelect('channel_default', null)}
          />
          <TeamMenuItem
            selected={selectedMode === 'solo'}
            title="Solo"
            description="Only the selected leader agent responds."
            onSelect={() => onSelect('solo', null)}
          />
          {teams.map((team) => (
            <TeamMenuItem
              key={team.id}
              selected={(selectedMode === 'team' || selectedMode === 'manual') && selectedTeam?.id === team.id}
              title={teamLabel(team)}
              description={`${team.members.filter((member) => member.enabled).length} members`}
              onSelect={() => onSelect('team', team.id)}
            />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function TeamMenuItem({
  selected,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
    >
      <Users className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">{title}</div>
        <div className="truncate text-[11px] text-[var(--text-muted)]">{description}</div>
      </div>
      {selected ? <Check className="h-4 w-4 text-[var(--accent)]" /> : null}
    </DropdownMenu.Item>
  );
}
