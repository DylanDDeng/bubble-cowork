import {
  Brain,
  Bug,
  BookOpenText,
  CircleGauge,
  GitFork,
  ListTodo,
  MessageSquare,
  Plug,
  RotateCcw,
  SkillStack,
  Terminal,
  Trash2,
  Target,
  Workflow,
  Zap,
} from './icons';
import type { LucideIcon } from './icons';
import type { ClaudeSlashSuggestion } from '../utils/claude-slash';
import {
  commandGlyph,
  commandTitle,
  groupSuggestions,
  skillScopeLabel,
  type SlashCommandGlyph,
} from '../utils/slash-menu';

const COMMAND_ICONS: Record<SlashCommandGlyph, LucideIcon> = {
  clear: Trash2,
  rewind: RotateCcw,
  usage: CircleGauge,
  fast: Zap,
  fork: GitFork,
  brain: Brain,
  plan: ListTodo,
  goal: Target,
  review: Bug,
  agents: Workflow,
  plugin: Plug,
  help: BookOpenText,
  thread: MessageSquare,
  terminal: Terminal,
};

function suggestionKey(suggestion: ClaudeSlashSuggestion): string {
  if (suggestion.kind === 'command') {
    return `command:${suggestion.command.source}:${suggestion.command.name}`;
  }
  return `skill:${suggestion.skill.source}:${suggestion.skill.path || suggestion.skill.name}`;
}

export function ClaudeSkillMenu({
  suggestions,
  selectedIndex,
  empty,
  title = 'Commands and skills',
  emptyMessage = 'No matching commands or skills.',
  onSelect,
  onHighlight,
}: {
  suggestions: ClaudeSlashSuggestion[];
  selectedIndex: number;
  empty?: boolean;
  title?: string;
  emptyMessage?: string;
  onSelect: (suggestion: ClaudeSlashSuggestion) => void;
  onHighlight?: (index: number) => void;
}) {
  const groups = groupSuggestions(suggestions);

  return (
    <div
      className="mx-1 mb-2 overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--border)_82%,transparent)] bg-[var(--bg-primary)] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_18px_46px_rgba(15,23,42,0.12)]"
      aria-label={title}
    >
      <div className="max-h-72 overflow-y-auto py-1">
        {groups.map((group, groupIndex) => (
          <div
            key={group.id}
            className={groupIndex > 0 ? 'border-t border-[color-mix(in_srgb,var(--border)_62%,transparent)] pt-0.5' : ''}
          >
            {group.label ? (
              <div className="px-2 pt-1.5 pb-1 text-[11px] font-normal text-[var(--text-muted)]">
                {group.label}
              </div>
            ) : null}

            {group.suggestions.map(({ suggestion, index }) => {
              const selected = index === selectedIndex;
              const isSkill = suggestion.kind === 'skill';
              const Icon = isSkill
                ? suggestion.skill.source === 'plugin'
                  ? Plug
                  : SkillStack
                : COMMAND_ICONS[commandGlyph(suggestion.command)];
              const title =
                isSkill
                  ? suggestion.skill.title || suggestion.skill.name.replace(/^\//, '')
                  : commandTitle(suggestion.command);
              const description =
                isSkill
                  ? suggestion.skill.description || suggestion.skill.path || `/${suggestion.skill.name}`
                  : suggestion.command.description;
              const trailingMeta =
                isSkill
                  ? skillScopeLabel(suggestion.skill.source)
                  : `/${suggestion.command.name}`;

              return (
                <button
                  key={suggestionKey(suggestion)}
                  type="button"
                  onMouseMove={() => {
                    if (!selected) onHighlight?.(index);
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => onSelect(suggestion)}
                  className={`flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors ${
                    selected
                      ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/80 hover:text-[var(--text-primary)]'
                  }`}
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`} />

                  <div className="min-w-0 flex flex-1 items-center gap-3">
                    <div className="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
                      <span className={`shrink-0 truncate text-[11.5px] font-medium ${isSkill ? 'font-semibold' : ''}`}>
                        {title}
                      </span>
                      {description ? (
                        <span className="truncate text-[11px] text-[var(--text-muted)]">
                          {description}
                        </span>
                      ) : null}
                    </div>

                    <span className="shrink-0 pl-2 text-right text-[10.5px] text-[var(--text-muted)]">
                      {trailingMeta}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        ))}

        {empty || suggestions.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
            {emptyMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}
