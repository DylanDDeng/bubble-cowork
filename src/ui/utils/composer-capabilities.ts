import type { ClaudeSkillSummary } from '../types';
import type { ClaudeSlashCommand, ClaudeSlashSuggestion } from './claude-slash';
import { filterClaudeSkills } from './claude-skills';
import { filterClaudeSlashCommands } from './claude-slash';
import type { ComposerTriggerKind } from './composer-triggers';

export function buildComposerCapabilitySuggestions(input: {
  enabled: boolean;
  query: string | null;
  triggerKind: ComposerTriggerKind | null;
  availableCommands: ClaudeSlashCommand[];
  availableSkills: ClaudeSkillSummary[];
  includeCommands?: boolean;
  includeSkills?: boolean;
  skillLimit?: number;
}): ClaudeSlashSuggestion[] {
  if (!input.enabled || input.query === null || input.triggerKind === null) {
    return [];
  }

  const includeCommands = input.includeCommands ?? input.triggerKind !== 'skill';
  const includeSkills = input.includeSkills ?? input.triggerKind === 'skill';

  const commandSuggestions = includeCommands
    ? filterClaudeSlashCommands(input.availableCommands, input.query)
    : [];
  const skillLimit = input.skillLimit ?? (input.triggerKind === 'skill' ? 80 : 8);
  const skillSuggestions = includeSkills
    ? filterClaudeSkills(input.availableSkills, input.query, skillLimit)
    : [];

  // Claude CLI exposes every skill as a slash command too (Kimi as
  // `skill:<name>`), so drop commands whose names collide with a known skill
  // to avoid duplicate entries.
  const skillNameSet = new Set(
    input.availableSkills.map((skill) => skill.name.replace(/^\//, '').toLowerCase())
  );
  const dedupedCommands = commandSuggestions.filter(
    (command) => !skillNameSet.has(command.name.replace(/^skill:/, '').toLowerCase())
  );

  return [
    ...dedupedCommands.map((command) => ({ kind: 'command', command }) as ClaudeSlashSuggestion),
    ...skillSuggestions.map((skill) => ({ kind: 'skill', skill }) as ClaudeSlashSuggestion),
  ];
}
