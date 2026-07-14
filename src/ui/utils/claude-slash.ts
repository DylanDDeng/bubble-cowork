import type { AgentProvider, AvailableCommand, ClaudeSkillSummary, PromptLibraryItem, StreamMessage } from '../types';
import { parseComposerCapabilityToken } from './composer-capability-token';

export interface ClaudeSlashCommand {
  name: string;
  title: string;
  description: string;
  source: 'default' | 'session' | 'acp';
  submitOnSelect?: boolean;
  inputHint?: string;
}

export type ClaudeSlashSuggestion =
  | { kind: 'command'; command: ClaudeSlashCommand }
  | { kind: 'skill'; skill: ClaudeSkillSummary }
  | { kind: 'prompt'; prompt: PromptLibraryItem };

const DEFAULT_COMMAND_DEFINITIONS: Record<
  string,
  { title: string; description: string; submitOnSelect?: boolean }
> = {
  compact: {
    title: '/compact',
    description: 'Compact the current conversation context',
  },
  config: {
    title: '/config',
    description: 'Open or update Claude Code configuration',
  },
  cost: {
    title: '/cost',
    description: 'Show current token and cost usage',
    submitOnSelect: true,
  },
  doctor: {
    title: '/doctor',
    description: 'Check Claude Code installation and runtime health',
  },
  help: {
    title: '/help',
    description: 'Show Claude Code help and available commands',
  },
  init: {
    title: '/init',
    description: 'Initialize project memory and guidance for Claude Code',
  },
  login: {
    title: '/login',
    description: 'Sign in to Claude Code',
  },
  logout: {
    title: '/logout',
    description: 'Sign out of Claude Code',
  },
  mcp: {
    title: '/mcp',
    description: 'Manage MCP server connections',
  },
  memory: {
    title: '/memory',
    description: 'Edit Claude Code memory files',
  },
  model: {
    title: '/model',
    description: 'Change the Claude model for this conversation',
  },
  permissions: {
    title: '/permissions',
    description: 'Manage Claude Code tool permissions',
  },
  plan: {
    title: '/plan',
    description: 'Switch into planning mode',
  },
  pr_comments: {
    title: '/pr_comments',
    description: 'Fetch pull request comments for Claude to address',
  },
  release_notes: {
    title: '/release_notes',
    description: 'Show Claude Code release notes',
  },
  review: {
    title: '/review',
    description: 'Review the current changes',
  },
  rewind: {
    title: '/rewind',
    description: 'Rewind the conversation and/or files to an earlier checkpoint',
  },
  status: {
    title: '/status',
    description: 'Show Claude Code account and session status',
  },
  terminal_setup: {
    title: '/terminal_setup',
    description: 'Install terminal integration for Claude Code',
  },
  vim: {
    title: '/vim',
    description: 'Toggle Vim mode',
  },
};

const OPENCODE_COMMAND_DEFINITIONS: Record<string, { title: string; description: string }> = {
  help: { title: '/help', description: 'Show the help dialog' },
  connect: { title: '/connect', description: 'Add a provider to OpenCode' },
  compact: { title: '/compact', description: 'Compact the current session' },
  details: { title: '/details', description: 'Toggle tool execution details' },
  editor: { title: '/editor', description: 'Open an external editor for composing messages' },
  exit: { title: '/exit', description: 'Exit OpenCode' },
  export: { title: '/export', description: 'Export the current conversation' },
  init: { title: '/init', description: 'Create or update AGENTS.md' },
  models: { title: '/models', description: 'List available models' },
  new: { title: '/new', description: 'Start a new session' },
  sessions: { title: '/sessions', description: 'List and switch between sessions' },
  share: { title: '/share', description: 'Share the current session' },
  themes: { title: '/themes', description: 'List available themes' },
  thinking: { title: '/thinking', description: 'Toggle visibility of thinking blocks' },
  unshare: { title: '/unshare', description: 'Unshare the current session' },
};

// Codex builtins Aegis executes itself: the app-server has no slash-command
// passthrough (turn text is literal), so only commands the codex adapter
// intercepts and routes to dedicated RPCs (thread/compact/start,
// review/start) are advertised here.
const CODEX_COMMAND_DEFINITIONS: Record<
  string,
  { title: string; description: string; submitOnSelect?: boolean; inputHint?: string }
> = {
  compact: {
    title: '/compact',
    description: 'Summarize the conversation to free up context',
    submitOnSelect: true,
  },
  review: {
    title: '/review',
    description: 'Review uncommitted changes, or a branch/commit/custom target',
    inputHint: 'optional: branch <name> | commit <sha> | custom instructions',
  },
};

// Grok Build shell builtins advertised over ACP (plus a few documented agent
// commands users expect). Skills also arrive at runtime via
// available_commands_update and are merged on top of this catalog.
type GrokCommandDefinition = {
  title: string;
  description: string;
  submitOnSelect?: boolean;
  inputHint?: string;
};

const GROK_COMMAND_DEFINITIONS: Record<string, GrokCommandDefinition> = {
  compact: {
    title: '/compact',
    description: 'Compress conversation history to save context window',
    inputHint: 'optional context about what to preserve',
  },
  context: {
    title: '/context',
    description: 'Show context window usage and session stats',
    submitOnSelect: true,
  },
  'session-info': {
    title: '/session-info',
    description: 'Show session details (model, turns, context usage)',
    submitOnSelect: true,
  },
  model: {
    title: '/model',
    description: 'Switch the Grok Build model for this session',
    inputHint: 'model name or id',
  },
  effort: {
    title: '/effort',
    description: 'Set reasoning effort on the current model',
    inputHint: 'low | medium | high | xhigh',
  },
  'always-approve': {
    title: '/always-approve',
    description: 'Toggle always-approve mode (skip all permission prompts)',
    inputHint: 'on|off',
  },
  auto: {
    title: '/auto',
    description: 'Enable auto permission mode (classifier approves safe tools)',
  },
  yolo: {
    title: '/yolo',
    description: 'Alias for always-approve (skip permission prompts)',
    inputHint: 'on|off',
  },
  plan: {
    title: '/plan',
    description: 'Enter plan mode for the next turn',
    inputHint: 'optional plan description',
  },
  'view-plan': {
    title: '/view-plan',
    description: 'Open the current saved plan preview',
    submitOnSelect: true,
  },
  'show-plan': {
    title: '/show-plan',
    description: 'Alias for /view-plan',
    submitOnSelect: true,
  },
  memory: {
    title: '/memory',
    description: 'Browse or toggle cross-session memory',
    inputHint: 'on|off',
  },
  flush: {
    title: '/flush',
    description: 'Save current session knowledge to memory now',
    submitOnSelect: true,
  },
  dream: {
    title: '/dream',
    description: 'Run memory consolidation across session logs',
    submitOnSelect: true,
  },
  remember: {
    title: '/remember',
    description: 'Save a note to memory immediately',
    inputHint: 'note text',
  },
  hooks: {
    title: '/hooks',
    description: 'Manage project hooks',
  },
  'hooks-list': {
    title: '/hooks-list',
    description: 'Show hooks loaded in this session',
    submitOnSelect: true,
  },
  'hooks-trust': {
    title: '/hooks-trust',
    description: 'Trust this project for hook execution',
    submitOnSelect: true,
  },
  'hooks-untrust': {
    title: '/hooks-untrust',
    description: 'Remove trust for the current project',
    submitOnSelect: true,
  },
  'hooks-add': {
    title: '/hooks-add',
    description: 'Add a custom hook file or directory',
    inputHint: 'path to hook file or directory',
  },
  'hooks-remove': {
    title: '/hooks-remove',
    description: 'Remove a custom hook file or directory path',
    inputHint: 'path to hook file or directory',
  },
  plugins: {
    title: '/plugins',
    description: 'Manage plugins (list, reload, trust, add, remove)',
    inputHint: 'list | reload | trust <path> | add <path> | remove <path>',
  },
  'reload-plugins': {
    title: '/reload-plugins',
    description: 'Reload plugins from disk',
    submitOnSelect: true,
  },
  marketplace: {
    title: '/marketplace',
    description: 'Browse and install plugins from the marketplace',
  },
  skills: {
    title: '/skills',
    description: 'View installed skills',
  },
  mcps: {
    title: '/mcps',
    description: 'Manage MCP server connections',
  },
  imagine: {
    title: '/imagine',
    description: 'Generate an image from a text description',
    inputHint: 'image description',
  },
  'imagine-video': {
    title: '/imagine-video',
    description: 'Generate a video from text or image guidance',
    inputHint: 'video description',
  },
  loop: {
    title: '/loop',
    description: 'Run a prompt on a recurring interval',
    inputHint: '[interval] <prompt>',
  },
  goal: {
    title: '/goal',
    description: 'Set, manage, or check an autonomous goal',
    inputHint: '<objective> | status | pause | resume | clear',
  },
  feedback: {
    title: '/feedback',
    description: 'Send feedback about the current session',
    inputHint: 'feedback text',
  },
  help: {
    title: '/help',
    description: 'Show Grok Build help for config, MCP, auth, and commands',
  },
  btw: {
    title: '/btw',
    description: 'Send an aside without interrupting the current task',
    inputHint: 'aside message',
  },
  rename: {
    title: '/rename',
    description: 'Rename the current session',
    inputHint: 'new session title',
  },
  fork: {
    title: '/fork',
    description: 'Branch the current session into a new agent',
    submitOnSelect: true,
  },
  rewind: {
    title: '/rewind',
    description: 'Rewind the conversation to an earlier turn',
  },
  export: {
    title: '/export',
    description: 'Export the current conversation',
  },
  'code-review': {
    title: '/code-review',
    description: 'Run a strict maintainability review of the current changes',
    submitOnSelect: true,
  },
  'terminal-setup': {
    title: '/terminal-setup',
    description: 'Show terminal capability detection and setup info',
    submitOnSelect: true,
  },
  'release-notes': {
    title: '/release-notes',
    description: 'View Grok Build release notes',
    submitOnSelect: true,
  },
  docs: {
    title: '/docs',
    description: 'Browse Grok Build docs and how-to guides',
    inputHint: 'web | guide title',
  },
  usage: {
    title: '/usage',
    description: 'View credit usage or manage billing',
    submitOnSelect: true,
  },
  login: {
    title: '/login',
    description: 'Log in or re-authenticate with Grok Build',
    submitOnSelect: true,
  },
  logout: {
    title: '/logout',
    description: 'Log out of Grok Build',
    submitOnSelect: true,
  },
  privacy: {
    title: '/privacy',
    description: 'Show or toggle privacy and data-retention status',
  },
  settings: {
    title: '/settings',
    description: 'Open Grok Build settings',
  },
  'config-agents': {
    title: '/config-agents',
    description: 'Manage agent definitions and the active agent',
  },
  personas: {
    title: '/personas',
    description: 'Create and manage subagent personas',
  },
  'import-claude': {
    title: '/import-claude',
    description: 'Import Claude Code settings into Grok Build',
    submitOnSelect: true,
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

function fromAvailableCommand(command: AvailableCommand): ClaudeSlashCommand | null {
  const normalized = command.name.replace(/^\//, '').trim();
  if (!normalized) {
    return null;
  }

  const grokFallback = GROK_COMMAND_DEFINITIONS[normalized];
  return {
    name: normalized,
    title: grokFallback?.title || `/${normalized}`,
    description: command.description || grokFallback?.description || 'ACP slash command',
    // Known Grok builtins use the same "Built-in" group as Claude/OpenCode defaults.
    source: grokFallback ? 'default' : 'acp',
    submitOnSelect: grokFallback?.submitOnSelect,
    inputHint: command.input?.hint || grokFallback?.inputHint,
  };
}

function buildDefaultCommandList(
  definitions: Record<string, { title: string; description: string; submitOnSelect?: boolean; inputHint?: string }>
): ClaudeSlashCommand[] {
  return Object.entries(definitions)
    .map(([name, definition]) => ({
      name,
      title: definition.title,
      description: definition.description,
      source: 'default' as const,
      submitOnSelect: definition.submitOnSelect,
      inputHint: definition.inputHint,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function enrichCommandsWithDefinitions(
  commands: ClaudeSlashCommand[],
  definitions: Record<string, { title: string; description: string; submitOnSelect?: boolean; inputHint?: string }>
): ClaudeSlashCommand[] {
  return commands.map((command) => {
    const definition = definitions[command.name];
    if (!definition) {
      return command;
    }
    return {
      ...command,
      title: definition.title || command.title,
      description: command.description || definition.description,
      submitOnSelect: command.submitOnSelect ?? definition.submitOnSelect,
      inputHint: command.inputHint || definition.inputHint,
    };
  });
}

function mergeMissingDefaultCommands(
  commands: ClaudeSlashCommand[],
  definitions: Record<string, { title: string; description: string; submitOnSelect?: boolean; inputHint?: string }>
): ClaudeSlashCommand[] {
  const existing = new Set(commands.map((command) => command.name.toLowerCase()));
  const missing = buildDefaultCommandList(definitions).filter(
    (command) => !existing.has(command.name.toLowerCase())
  );
  return [...commands, ...missing].sort((left, right) => left.name.localeCompare(right.name));
}

export function getSessionSlashCommands(messages: StreamMessage[]): ClaudeSlashCommand[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.type === 'system' &&
      message.subtype === 'available_commands_update' &&
      Array.isArray(message.availableCommands)
    ) {
      return message.availableCommands
        .map(fromAvailableCommand)
        .filter((command): command is ClaudeSlashCommand => Boolean(command))
        .sort((left, right) => left.name.localeCompare(right.name));
    }

    if (message.type === 'system' && message.subtype === 'init' && Array.isArray(message.slash_commands)) {
      return buildClaudeSlashCommands(new Set(message.slash_commands.map((command) => command.trim()).filter(Boolean)));
    }
  }

  return [];
}

export function buildClaudeSlashCommands(
  sessionCommands?: Set<string> | ClaudeSlashCommand[]
): ClaudeSlashCommand[] {
  if (Array.isArray(sessionCommands)) {
    return [...sessionCommands].sort((left, right) => left.name.localeCompare(right.name));
  }

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

// Commands handled by the Aegis UI itself (never dispatched to the model).
// The Claude runtime does not report these in available_commands_update, so
// they are merged into every Claude session's suggestion list locally.
const LOCAL_CLAUDE_UI_COMMANDS: ClaudeSlashCommand[] = [
  {
    name: 'rewind',
    title: '/rewind',
    description: 'Rewind the conversation and/or files to an earlier checkpoint',
    source: 'default',
  },
];

function withLocalClaudeUiCommands(commands: ClaudeSlashCommand[]): ClaudeSlashCommand[] {
  const existing = new Set(commands.map((command) => command.name));
  const merged = [
    ...commands,
    ...LOCAL_CLAUDE_UI_COMMANDS.filter((command) => !existing.has(command.name)),
  ];
  return merged.sort((left, right) => left.name.localeCompare(right.name));
}

export function buildProviderSlashCommands(
  provider: AgentProvider,
  sessionCommands?: ClaudeSlashCommand[]
): ClaudeSlashCommand[] {
  if (sessionCommands && sessionCommands.length > 0) {
    const commands = buildClaudeSlashCommands(sessionCommands);
    if (provider === 'claude') {
      return withLocalClaudeUiCommands(commands);
    }
    if (provider === 'grok') {
      // ACP may advertise skills as slash commands at runtime; keep them and
      // backfill any static Grok builtins that have not arrived yet.
      return mergeMissingDefaultCommands(
        enrichCommandsWithDefinitions(commands, GROK_COMMAND_DEFINITIONS),
        GROK_COMMAND_DEFINITIONS
      );
    }
    return commands;
  }

  if (provider === 'claude') {
    return withLocalClaudeUiCommands(buildClaudeSlashCommands());
  }

  if (provider === 'opencode') {
    return buildDefaultCommandList(OPENCODE_COMMAND_DEFINITIONS);
  }

  if (provider === 'grok') {
    return buildDefaultCommandList(GROK_COMMAND_DEFINITIONS);
  }

  if (provider === 'codex') {
    return buildDefaultCommandList(CODEX_COMMAND_DEFINITIONS);
  }

  return [];
}

export function parseSelectedSlashCommandPrompt(
  prompt: string,
  commands: ClaudeSlashCommand[]
): { command: ClaudeSlashCommand; remainder: string } | null {
  const token = parseComposerCapabilityToken(prompt, ['/']);
  if (!token) {
    return null;
  }

  // Case-insensitive: "/Rewind" must resolve to the same command as
  // "/rewind", otherwise the composer stays in search mode for one casing
  // and switches to the selected-command chip for the other.
  const tokenName = token.name.toLowerCase();
  const command = commands.find((item) => item.name.toLowerCase() === tokenName);
  if (!command) {
    return null;
  }

  return { command, remainder: token.remainder };
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
