import type { CanonicalToolKind, ToolStatus } from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function safeJsonStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(
      value,
      (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
      space
    );
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}

function getStringField(input: unknown, key: string): string | null {
  if (!isRecord(input)) return null;
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function getProviderDisplayTitle(input: unknown): string | null {
  return (
    getStringField(input, '__aegisDisplayTitle') ||
    getStringField(input, 'displayTitle') ||
    getStringField(input, 'toolTitle')
  );
}

export function getToolSummary(name: string, input: unknown): string {
  const providerTitle = getProviderDisplayTitle(input);
  if (providerTitle) {
    return providerTitle;
  }

  switch (name) {
    case 'Bash':
      return getStringField(input, 'command') || '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Delete':
      return (
        getStringField(input, 'file_path') ||
        getStringField(input, 'path') ||
        getStringField(input, 'filename') ||
        ''
      );
    case 'Glob':
    case 'Grep':
      return getStringField(input, 'pattern') || '';
    case 'AskUserQuestion': {
      if (!isRecord(input)) return '';
      const questions = input.questions;
      if (!Array.isArray(questions) || questions.length === 0) return '';
      const first = questions[0];
      if (!isRecord(first)) return '';
      return getStringField(first, 'question') || '';
    }
    case 'Task': {
      const desc = getStringField(input, 'description');
      if (desc) return desc;
      const prompt = getStringField(input, 'prompt');
      return prompt ? prompt.slice(0, 50) : '';
    }
    default: {
      const json = safeJsonStringify(input);
      return json.length > 80 ? json.slice(0, 80) : json;
    }
  }
}

// ── Readable display ────────────────────────────────────────────────────────
// Humanized "verb + target" rendering for tool calls. Verb conjugates with
// status so the live spinner reads "Reading file.ts" while the completed entry
// reads "Read file.ts". Inspired by dpcode's deriveReadableCommandDisplay.

export interface ReadableToolDisplay {
  verb: string;
  target: string;
}

type VerbPair = readonly [present: string, past: string];

const TOOL_VERBS: Record<string, VerbPair> = {
  Read: ['Reading', 'Read'],
  Write: ['Writing', 'Wrote'],
  Edit: ['Editing', 'Edited'],
  MultiEdit: ['Editing', 'Edited'],
  Delete: ['Deleting', 'Deleted'],
  Glob: ['Finding', 'Found'],
  Grep: ['Searching', 'Searched'],
  WebFetch: ['Fetching', 'Fetched'],
  WebSearch: ['Searching', 'Searched'],
  Task: ['Running', 'Ran'],
  TodoWrite: ['Updating', 'Updated'],
  NotebookEdit: ['Editing', 'Edited'],
};

const SHELL_TOOL_VERBS: Record<string, VerbPair> = {
  cat: ['Reading', 'Read'],
  head: ['Reading', 'Read'],
  tail: ['Reading', 'Read'],
  less: ['Reading', 'Read'],
  more: ['Reading', 'Read'],
  bat: ['Reading', 'Read'],
  ls: ['Listing', 'Listed'],
  tree: ['Listing', 'Listed'],
  grep: ['Searching', 'Searched'],
  rg: ['Searching', 'Searched'],
  ag: ['Searching', 'Searched'],
  find: ['Finding', 'Found'],
  fd: ['Finding', 'Found'],
  rm: ['Removing', 'Removed'],
  mkdir: ['Creating', 'Created'],
  touch: ['Creating', 'Created'],
  cp: ['Copying', 'Copied'],
  mv: ['Moving', 'Moved'],
  curl: ['Fetching', 'Fetched'],
  wget: ['Fetching', 'Fetched'],
};

const GIT_VERBS: Record<string, VerbPair> = {
  status: ['Checking', 'Checked'],
  diff: ['Diffing', 'Diffed'],
  log: ['Reading', 'Read'],
  show: ['Reading', 'Read'],
  add: ['Staging', 'Staged'],
  commit: ['Committing', 'Committed'],
  push: ['Pushing', 'Pushed'],
  pull: ['Pulling', 'Pulled'],
  fetch: ['Fetching', 'Fetched'],
  checkout: ['Switching', 'Switched'],
  switch: ['Switching', 'Switched'],
  branch: ['Listing', 'Listed'],
  merge: ['Merging', 'Merged'],
  rebase: ['Rebasing', 'Rebased'],
  reset: ['Resetting', 'Reset'],
  stash: ['Stashing', 'Stashed'],
  restore: ['Restoring', 'Restored'],
  blame: ['Reading', 'Read'],
};

const DEFAULT_VERB: VerbPair = ['Running', 'Ran'];

function pickVerb(pair: VerbPair, status: ToolStatus): string {
  return status === 'pending' ? pair[0] : pair[1];
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function lastPathSegment(path: string): string {
  const cleaned = path.replace(/^['"]|['"]$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

const SHELL_WRAPPER_RE = /^(?:(?:[\w.-]+\/)+)?(?:bash|sh|zsh|fish|dash)\s+(?:-l\s+)?-l?c\s+(['"])([\s\S]*)\1\s*$/;

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(SHELL_WRAPPER_RE);
  if (match) {
    return match[2].trim();
  }
  return trimmed;
}

function splitFirstToken(command: string): { head: string; rest: string } {
  const trimmed = command.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { head: '', rest: '' };
  return { head: match[1], rest: (match[2] || '').trim() };
}

function firstNonFlagToken(args: string): string | null {
  const tokens = args.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (!token.startsWith('-')) {
      return token.replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

function describeBashCommand(command: string, status: ToolStatus): ReadableToolDisplay {
  const inner = unwrapShellCommand(command);
  // Strip the suffix after pipes / chains so the verb describes the leading
  // command rather than the full pipeline.
  const firstSegment = inner.split(/\s+&&\s+|\s+\|\|\s+|\s*;\s*|\s*\|\s*/)[0] || inner;
  const { head, rest } = splitFirstToken(firstSegment);

  if (head === 'git') {
    const gitTokens = rest.split(/\s+/).filter(Boolean);
    const subcommand = gitTokens[0] || '';
    const gitVerbs = GIT_VERBS[subcommand];
    const target = `git ${truncate(rest, 40)}`.trim();
    return {
      verb: pickVerb(gitVerbs || DEFAULT_VERB, status),
      target: target || 'git',
    };
  }

  const shellVerbs = SHELL_TOOL_VERBS[head];
  if (shellVerbs) {
    const verb = pickVerb(shellVerbs, status);

    if (head === 'cat' || head === 'head' || head === 'tail' || head === 'less' || head === 'more' || head === 'bat') {
      const file = firstNonFlagToken(rest);
      return { verb, target: file ? lastPathSegment(file) : 'file' };
    }

    if (head === 'ls' || head === 'tree') {
      const dir = firstNonFlagToken(rest);
      return { verb, target: dir || 'directory' };
    }

    if (head === 'grep' || head === 'rg' || head === 'ag') {
      const pattern = firstNonFlagToken(rest);
      return { verb, target: pattern ? `for ${truncate(pattern, 40)}` : 'pattern' };
    }

    if (head === 'find' || head === 'fd') {
      const path = firstNonFlagToken(rest);
      const nameFlag = rest.match(/-name\s+(['"]?)([^'"\s]+)\1/);
      const pattern = nameFlag ? nameFlag[2] : null;
      if (path && pattern) return { verb, target: `${pattern} in ${path}` };
      if (pattern) return { verb, target: pattern };
      if (path) return { verb, target: `in ${path}` };
      return { verb, target: truncate(rest || head, 50) };
    }

    if (head === 'rm' || head === 'mkdir' || head === 'touch') {
      const target = firstNonFlagToken(rest);
      return { verb, target: target || (head === 'mkdir' ? 'directory' : 'file') };
    }

    if (head === 'cp' || head === 'mv') {
      return { verb, target: truncate(rest, 50) };
    }

    if (head === 'curl' || head === 'wget') {
      const urlMatch = rest.match(/https?:\/\/\S+/);
      return { verb, target: urlMatch ? truncate(urlMatch[0], 60) : truncate(rest, 50) };
    }
  }

  // Package managers and language runtimes — keep the full short command.
  if (
    head === 'npm' ||
    head === 'yarn' ||
    head === 'pnpm' ||
    head === 'bun' ||
    head === 'node' ||
    head === 'python' ||
    head === 'python3' ||
    head === 'go' ||
    head === 'cargo' ||
    head === 'make' ||
    head === 'docker' ||
    head === 'kubectl' ||
    head === 'pip' ||
    head === 'pip3' ||
    head === 'tsc' ||
    head === 'deno'
  ) {
    return {
      verb: pickVerb(DEFAULT_VERB, status),
      target: truncate(`${head} ${rest}`.trim(), 60),
    };
  }

  return {
    verb: pickVerb(DEFAULT_VERB, status),
    target: truncate(firstSegment || command, 60),
  };
}

export function deriveReadableToolDisplay(
  name: string,
  input: unknown,
  status: ToolStatus
): ReadableToolDisplay {
  const providerTitle = getProviderDisplayTitle(input);
  if (providerTitle) {
    return { verb: '', target: providerTitle };
  }

  if (name === 'Bash') {
    const command = getStringField(input, 'command');
    if (command) {
      return describeBashCommand(command, status);
    }
    return { verb: pickVerb(DEFAULT_VERB, status), target: 'command' };
  }

  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'Delete' || name === 'MultiEdit') {
    const path =
      getStringField(input, 'file_path') ||
      getStringField(input, 'path') ||
      getStringField(input, 'filename') ||
      '';
    const verbs = TOOL_VERBS[name] || DEFAULT_VERB;
    return { verb: pickVerb(verbs, status), target: path ? lastPathSegment(path) : 'file' };
  }

  if (name === 'Glob') {
    const pattern = getStringField(input, 'pattern') || '';
    return { verb: pickVerb(TOOL_VERBS.Glob, status), target: pattern || 'pattern' };
  }

  if (name === 'Grep') {
    const pattern = getStringField(input, 'pattern') || '';
    return { verb: pickVerb(TOOL_VERBS.Grep, status), target: pattern ? `for ${truncate(pattern, 40)}` : 'pattern' };
  }

  if (name === 'WebFetch') {
    const url = getStringField(input, 'url') || '';
    return { verb: pickVerb(TOOL_VERBS.WebFetch, status), target: url ? truncate(url, 60) : 'url' };
  }

  if (name === 'WebSearch') {
    const query = getStringField(input, 'query') || '';
    return { verb: pickVerb(TOOL_VERBS.WebSearch, status), target: query ? truncate(query, 60) : 'query' };
  }

  if (name === 'Task') {
    const desc =
      getStringField(input, 'description') ||
      getStringField(input, 'subagent_type') ||
      getStringField(input, 'prompt') ||
      '';
    return { verb: pickVerb(TOOL_VERBS.Task, status), target: desc ? truncate(desc, 60) : 'subagent task' };
  }

  if (name === 'TodoWrite') {
    return { verb: pickVerb(TOOL_VERBS.TodoWrite, status), target: 'todo list' };
  }

  if (name === 'NotebookEdit') {
    const path = getStringField(input, 'notebook_path') || getStringField(input, 'path') || '';
    return { verb: pickVerb(TOOL_VERBS.NotebookEdit, status), target: path ? lastPathSegment(path) : 'notebook' };
  }

  if (name === 'AskUserQuestion') {
    const summary = getToolSummary(name, input);
    return { verb: pickVerb(DEFAULT_VERB, status), target: summary ? truncate(summary, 60) : 'question' };
  }

  // MCP-style names like "mcp__server__tool" — show just the tool segment.
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const toolName = parts[parts.length - 1] || name;
    const summary = getToolSummary(name, input);
    return {
      verb: pickVerb(DEFAULT_VERB, status),
      target: summary ? `${toolName} ${truncate(summary, 40)}`.trim() : toolName,
    };
  }

  // Unknown tool — fall back to the legacy summary.
  const fallback = getToolSummary(name, input);
  return {
    verb: pickVerb(DEFAULT_VERB, status),
    target: fallback ? truncate(fallback, 60) : name,
  };
}

export function formatReadableToolSummary(display: ReadableToolDisplay): string {
  return `${display.verb} ${display.target}`.trim();
}

// ── Canonical kind classification ───────────────────────────────────────────
// Maps a provider's tool name (currently Claude-shaped because CodexAdapter
// translates Codex events back into Anthropic wire format) to a canonical kind
// the UI can switch on without caring which provider produced it. New tool
// names from new providers slot in here rather than fanning out across UI
// components.

const SHELL_FILE_READERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat',
]);

function detectBashKind(command: string | null | undefined): CanonicalToolKind {
  if (!command) return 'command_execution';
  const inner = unwrapShellCommand(command);
  const firstSegment = inner.split(/\s+&&\s+|\s+\|\|\s+|\s*;\s*|\s*\|\s*/)[0] || inner;
  const { head } = splitFirstToken(firstSegment);
  if (SHELL_FILE_READERS.has(head)) return 'file_read';
  if (head === 'grep' || head === 'rg' || head === 'ag' || head === 'find' || head === 'fd' || head === 'glob') {
    return 'pattern_search';
  }
  return 'command_execution';
}

export function classifyToolUse(toolName: string, input: unknown): CanonicalToolKind {
  if (toolName === 'Read') return 'file_read';
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Delete' || toolName === 'NotebookEdit') {
    return 'file_change';
  }
  if (toolName === 'Bash') {
    return detectBashKind(getStringField(input, 'command'));
  }
  if (toolName === 'Grep' || toolName === 'Glob') return 'pattern_search';
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'web_search';
  if (toolName === 'Task') return 'subagent';
  if (toolName === 'TodoWrite') return 'todo_update';
  if (toolName === 'AskUserQuestion') return 'approval';
  if (
    toolName === 'remember_search' ||
    toolName === 'remember_get' ||
    toolName === 'remember_write' ||
    toolName === 'remember_recent' ||
    toolName.startsWith('aegis_memory_') ||
    toolName.endsWith('__remember_search') ||
    toolName.endsWith('__remember_get') ||
    toolName.endsWith('__remember_write') ||
    toolName.endsWith('__remember_recent')
  ) {
    return 'memory';
  }
  if (toolName.startsWith('mcp__')) return 'mcp_tool_call';
  return 'unknown';
}
