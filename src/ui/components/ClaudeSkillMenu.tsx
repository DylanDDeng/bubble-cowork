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
  Workflow,
  Zap,
} from './icons';
import type { LucideIcon } from './icons';
import type { ClaudeSlashSuggestion, ClaudeSlashCommand } from '../utils/claude-slash';

interface MenuGroup {
  id: string;
  label: string | null;
  suggestions: Array<{ suggestion: ClaudeSlashSuggestion; index: number }>;
}

function commandTitle(command: ClaudeSlashCommand): string {
  switch (command.name) {
    case 'clear':
      return 'Clear';
    case 'compact':
      return 'Compact Context';
    case 'context':
    case 'session-info':
      return 'Session Info';
    case 'cost':
    case 'usage':
      return 'Cost';
    case 'details':
      return 'Details';
    case 'editor':
      return 'Editor';
    case 'exit':
      return 'Exit';
    case 'export':
      return 'Export';
    case 'fast':
      return 'Fast Mode';
    case 'fork':
      return 'Fork';
    case 'help':
    case 'docs':
      return 'Help';
    case 'init':
      return 'Init';
    case 'model':
    case 'models':
    case 'effort':
      return 'Model';
    case 'always-approve':
    case 'auto':
    case 'yolo':
      return 'Permissions';
    case 'new':
      return 'New Thread';
    case 'plan':
    case 'view-plan':
    case 'show-plan':
      return 'Plan Mode';
    case 'review':
    case 'code-review':
      return 'Code Review';
    case 'sessions':
      return 'Sessions';
    case 'share':
      return 'Share';
    case 'status':
      return 'Status';
    case 'subagents':
    case 'config-agents':
    case 'personas':
      return 'Subagents';
    case 'thinking':
      return 'Thinking';
    case 'imagine':
    case 'imagine-video':
      return 'Imagine';
    case 'memory':
    case 'flush':
    case 'dream':
    case 'remember':
      return 'Memory';
    case 'plugins':
    case 'marketplace':
    case 'skills':
    case 'mcps':
    case 'hooks':
    case 'hooks-list':
    case 'hooks-trust':
    case 'hooks-untrust':
    case 'hooks-add':
    case 'hooks-remove':
    case 'reload-plugins':
      return 'Extensions';
    case 'rewind':
      return 'Rewind';
    case 'loop':
    case 'goal':
      return 'Automation';
    default:
      return command.name
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}

function commandIcon(command: ClaudeSlashCommand): LucideIcon {
  switch (command.name) {
    case 'clear':
      return Trash2;
    case 'compact':
    case 'rewind':
      return RotateCcw;
    case 'cost':
    case 'status':
    case 'usage':
    case 'context':
    case 'session-info':
      return CircleGauge;
    case 'fast':
    case 'always-approve':
    case 'auto':
    case 'yolo':
      return Zap;
    case 'fork':
      return GitFork;
    case 'model':
    case 'models':
    case 'effort':
      return Brain;
    case 'plan':
    case 'view-plan':
    case 'show-plan':
    case 'goal':
    case 'loop':
      return ListTodo;
    case 'review':
    case 'code-review':
      return Bug;
    case 'subagents':
    case 'config-agents':
    case 'personas':
      return Workflow;
    case 'plugins':
    case 'marketplace':
    case 'skills':
    case 'mcps':
    case 'hooks':
    case 'hooks-list':
    case 'hooks-trust':
    case 'hooks-untrust':
    case 'hooks-add':
    case 'hooks-remove':
    case 'reload-plugins':
      return Plug;
    case 'help':
    case 'docs':
    case 'release-notes':
      return BookOpenText;
    case 'memory':
    case 'flush':
    case 'dream':
    case 'remember':
      return Brain;
    case 'default':
    case 'new':
      return MessageSquare;
    default:
      return Terminal;
  }
}

function skillScopeLabel(source: string | undefined): string {
  if (source === 'plugin') return 'Plugin';
  if (source === 'project') return 'Project';
  return 'Personal';
}

function getGroupId(suggestion: ClaudeSlashSuggestion): string {
  if (suggestion.kind === 'command') {
    return suggestion.command.source === 'default' ? 'built-in' : 'provider';
  }

  if (suggestion.skill.source === 'plugin') return 'plugins';
  if (suggestion.skill.source === 'project') return 'project-skills';
  return 'global-skills';
}

const GROUP_LABELS: Record<string, string> = {
  'built-in': 'Built-in',
  provider: 'Provider',
  plugins: 'Plugins',
  'project-skills': 'Project Skills',
  'global-skills': 'Global Skills',
};

const GROUP_ORDER = ['built-in', 'provider', 'plugins', 'project-skills', 'global-skills'];

function groupSuggestions(suggestions: ClaudeSlashSuggestion[]): MenuGroup[] {
  const buckets = new Map<string, MenuGroup>();

  suggestions.forEach((suggestion, index) => {
    const id = getGroupId(suggestion);
    const existing = buckets.get(id);
    if (existing) {
      existing.suggestions.push({ suggestion, index });
      return;
    }

    buckets.set(id, {
      id,
      label: GROUP_LABELS[id] || null,
      suggestions: [{ suggestion, index }],
    });
  });

  return Array.from(buckets.values()).sort((left, right) => {
    const leftIndex = GROUP_ORDER.indexOf(left.id);
    const rightIndex = GROUP_ORDER.indexOf(right.id);
    return (leftIndex === -1 ? GROUP_ORDER.length : leftIndex) -
      (rightIndex === -1 ? GROUP_ORDER.length : rightIndex);
  });
}

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
                : commandIcon(suggestion.command);
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
