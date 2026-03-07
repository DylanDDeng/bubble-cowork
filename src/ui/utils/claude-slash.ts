import type { ClaudeSkillSummary, StreamMessage } from '../types';

export interface ClaudeSlashCommand {
  name: string;
  title: string;
  description: string;
  source: 'default' | 'session';
  submitOnSelect?: boolean;
}

export type ClaudeSlashSuggestion =
  | { kind: 'command'; command: ClaudeSlashCommand }
  | { kind: 'skill'; skill: ClaudeSkillSummary };

const DEFAULT_COMMAND_DEFINITIONS: Record<string, { title: string; description: string }> = {
  cost: {
    title: '/cost',
    description: 'Show current token and cost usage',
    submitOnSelect: true,
  },
  plan: {
    title: '/plan',
    description: 'Switch into planning mode',
  },
  compact: {
    title: '/compact',
    description: 'Compact the current conversation context',
  },
};

function rankCommand(command: ClaudeSlashCommand, query: string): number {
  const lowerName = command.name.toLowerCase();
  const lowerTitle = command.title.toLowerCase();

  if (!query) return 0;
  if (lowerName === query) return 0;
  if (lowerName.startsWith(query)) return 1;
  if (lowerTitle.startsWith(query)) return 2;
  if (lowerName.includes(query)) return 3;
  if (lowerTitle.includes(query)) return 4;
  return 5;
}

export function getSessionSlashCommands(messages: StreamMessage[]): Set<string> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'system' && message.subtype === 'init' && Array.isArray(message.slash_commands)) {
      return new Set(message.slash_commands.map((command) => command.trim()).filter(Boolean));
    }
  }

  return new Set();
}

export function buildClaudeSlashCommands(sessionCommands?: Set<string>): ClaudeSlashCommand[] {
  const names =
    sessionCommands && sessionCommands.size > 0
      ? Array.from(sessionCommands)
      : Object.keys(DEFAULT_COMMAND_DEFINITIONS);

  return names
    .map((name) => {
      const normalized = name.replace(/^\//, '').trim();
      const fallback = DEFAULT_COMMAND_DEFINITIONS[normalized];
      return {
        name: normalized,
        title: fallback?.title || `/${normalized}`,
        description: fallback?.description || 'Claude slash command',
        source: fallback ? 'default' : 'session',
        submitOnSelect: fallback?.submitOnSelect ?? false,
      } satisfies ClaudeSlashCommand;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseSelectedSlashCommandPrompt(
  prompt: string,
  commands: ClaudeSlashCommand[]
): { command: ClaudeSlashCommand; remainder: string } | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstWhitespaceIndex = trimmed.search(/\s/);
  const commandName =
    firstWhitespaceIndex === -1
      ? trimmed.slice(1)
      : trimmed.slice(1, firstWhitespaceIndex);

  if (!commandName) {
    return null;
  }

  const command = commands.find((item) => item.name === commandName);
  if (!command) {
    return null;
  }

  const remainder =
    firstWhitespaceIndex === -1 ? '' : trimmed.slice(firstWhitespaceIndex).replace(/^\s+/, '');

  return { command, remainder };
}

export function buildPromptWithSlashCommand(commandName: string, remainder: string): string {
  const trimmedRemainder = remainder.trimStart();
  return trimmedRemainder ? `/${commandName} ${trimmedRemainder}` : `/${commandName}`;
}

export function filterClaudeSlashCommands(
  commands: ClaudeSlashCommand[],
  query: string,
  limit = 6
): ClaudeSlashCommand[] {
  return commands
    .filter((command) => {
      if (!query) return true;
      const lowerName = command.name.toLowerCase();
      const lowerTitle = command.title.toLowerCase();
      return lowerName.includes(query) || lowerTitle.includes(query);
    })
    .sort((left, right) => {
      const rankDifference = rankCommand(left, query) - rankCommand(right, query);
      if (rankDifference !== 0) {
        return rankDifference;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, limit);
}

export function shouldAutoSubmitSlashCommand(command: ClaudeSlashCommand): boolean {
  return command.submitOnSelect === true;
}
