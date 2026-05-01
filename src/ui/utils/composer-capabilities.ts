import type { ClaudeSkillSummary, PromptLibraryItem } from '../types';
import type { ClaudeSlashCommand, ClaudeSlashSuggestion } from './claude-slash';
import { filterClaudeSkills } from './claude-skills';
import { filterClaudeSlashCommands } from './claude-slash';
import type { ComposerTriggerKind } from './composer-triggers';

function normalizeCapabilitySearchText(value: string | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/[:/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPromptSearchBlob(prompt: PromptLibraryItem): string {
  return normalizeCapabilitySearchText(
    [prompt.title, prompt.description, prompt.tags.join(' '), prompt.content]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
  );
}

function rankPrompt(prompt: PromptLibraryItem, query: string): number {
  const normalizedTitle = normalizeCapabilitySearchText(prompt.title);
  const normalizedTags = normalizeCapabilitySearchText(prompt.tags.join(' '));
  const normalizedDescription = normalizeCapabilitySearchText(prompt.description);

  if (!query) return 0;
  if (normalizedTitle === query) return 0;
  if (normalizedTitle.startsWith(query)) return 1;
  if (normalizedTags.includes(query)) return 2;
  if (normalizedDescription.includes(query)) return 3;
  if (buildPromptSearchBlob(prompt).includes(query)) return 4;
  return 5;
}

export function filterPromptLibraryItems(
  prompts: PromptLibraryItem[],
  query: string,
  limit = 6
): PromptLibraryItem[] {
  const normalizedQuery = normalizeCapabilitySearchText(query);
  return prompts
    .filter((prompt) => {
      if (!normalizedQuery) return true;
      return buildPromptSearchBlob(prompt).includes(normalizedQuery);
    })
    .sort((left, right) => {
      const rankDifference = rankPrompt(left, normalizedQuery) - rankPrompt(right, normalizedQuery);
      if (rankDifference !== 0) return rankDifference;
      return right.updatedAt - left.updatedAt;
    })
    .slice(0, limit);
}

export function buildComposerCapabilitySuggestions(input: {
  enabled: boolean;
  query: string | null;
  triggerKind: ComposerTriggerKind | null;
  availableCommands: ClaudeSlashCommand[];
  availableSkills: ClaudeSkillSummary[];
  promptLibraryItems: PromptLibraryItem[];
  includeCommands?: boolean;
  includeSkills?: boolean;
  includePrompts?: boolean;
}): ClaudeSlashSuggestion[] {
  if (!input.enabled || input.query === null || input.triggerKind === null) {
    return [];
  }

  const includeCommands = input.includeCommands ?? input.triggerKind !== 'skill';
  const includeSkills = input.includeSkills ?? input.triggerKind === 'skill';
  const includePrompts = input.includePrompts ?? input.triggerKind === 'slash-command';

  const commandSuggestions = includeCommands
    ? filterClaudeSlashCommands(input.availableCommands, input.query)
    : [];
  const skillLimit = input.triggerKind === 'skill' ? 80 : 8;
  const skillSuggestions = includeSkills
    ? filterClaudeSkills(input.availableSkills, input.query, skillLimit)
    : [];
  const promptSuggestions = includePrompts
    ? filterPromptLibraryItems(input.promptLibraryItems, input.query)
    : [];

  // Claude CLI exposes every skill as a slash command too, so drop commands
  // whose names collide with a known skill to avoid duplicate entries.
  const skillNameSet = new Set(
    input.availableSkills.map((skill) => skill.name.replace(/^\//, '').toLowerCase())
  );
  const dedupedCommands = commandSuggestions.filter(
    (command) => !skillNameSet.has(command.name.toLowerCase())
  );

  return [
    ...dedupedCommands.map((command) => ({ kind: 'command', command }) as ClaudeSlashSuggestion),
    ...skillSuggestions.map((skill) => ({ kind: 'skill', skill }) as ClaudeSlashSuggestion),
    ...promptSuggestions.map((prompt) => ({ kind: 'prompt', prompt }) as ClaudeSlashSuggestion),
  ];
}
