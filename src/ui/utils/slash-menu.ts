import type { ClaudeSlashCommand, ClaudeSlashSuggestion } from './claude-slash';

// How the composer's "/" menu names, groups and marks its entries. Pure so the
// iPhone composer shows the same menu as the desktop (ClaudeSkillMenu).

/** Semantic icon for a command; each surface maps it to its own icon set. */
export type SlashCommandGlyph =
  | 'clear' | 'rewind' | 'usage' | 'fast' | 'fork' | 'brain' | 'plan' | 'goal'
  | 'review' | 'agents' | 'plugin' | 'help' | 'thread' | 'terminal';

export interface MenuGroup {
  id: string;
  label: string | null;
  suggestions: Array<{ suggestion: ClaudeSlashSuggestion; index: number }>;
}

export function commandTitle(command: Pick<ClaudeSlashCommand, 'name'>): string {
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
    case 'goal':
      return 'Goal';
    case 'loop':
      return 'Automation';
    default:
      return command.name
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}

export function commandGlyph(command: Pick<ClaudeSlashCommand, 'name'>): SlashCommandGlyph {
  switch (command.name) {
    case 'clear':
      return 'clear';
    case 'compact':
    case 'rewind':
      return 'rewind';
    case 'cost':
    case 'status':
    case 'usage':
    case 'context':
    case 'session-info':
      return 'usage';
    case 'fast':
    case 'always-approve':
    case 'auto':
    case 'yolo':
      return 'fast';
    case 'fork':
      return 'fork';
    case 'model':
    case 'models':
    case 'effort':
      return 'brain';
    case 'plan':
    case 'view-plan':
    case 'show-plan':
    case 'loop':
      return 'plan';
    case 'goal':
      return 'goal';
    case 'review':
    case 'code-review':
      return 'review';
    case 'subagents':
    case 'config-agents':
    case 'personas':
      return 'agents';
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
      return 'plugin';
    case 'help':
    case 'docs':
    case 'release-notes':
      return 'help';
    case 'memory':
    case 'flush':
    case 'dream':
    case 'remember':
      return 'brain';
    case 'default':
    case 'new':
      return 'thread';
    default:
      return 'terminal';
  }
}

export function skillScopeLabel(source: string | undefined): string {
  if (source === 'plugin') return 'Plugin';
  if (source === 'project') return 'Project';
  return 'Personal';
}

export function getGroupId(suggestion: ClaudeSlashSuggestion): string {
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

export function groupSuggestions(suggestions: ClaudeSlashSuggestion[]): MenuGroup[] {
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
