import { parseReadBashCommand, parseSearchBashCommand } from '../tools/common';

export type BuiltinToolFamily = 'search' | 'read' | 'write' | 'edit' | 'shell' | 'web' | 'todo' | 'memory' | 'other';

export interface BuiltinSearchIntent {
  pattern: string;
  path?: string;
  include?: string;
  signature: string;
  familyKey: string;
}

export interface BuiltinReadIntent {
  path: string;
  offset?: number | string;
  limit?: number | string;
  signature: string;
  familyKey: string;
}

export interface BuiltinToolIntent {
  family: BuiltinToolFamily;
  search?: BuiltinSearchIntent;
  read?: BuiltinReadIntent;
}

const SEARCH_TOKEN_CANONICAL = new Map<string, string>([
  ['api_key', 'secret'],
  ['apikey', 'secret'],
  ['api', 'secret'],
  ['key', 'secret'],
  ['keys', 'secret'],
  ['secret', 'secret'],
  ['secrets', 'secret'],
  ['token', 'secret'],
  ['tokens', 'secret'],
  ['credential', 'secret'],
  ['credentials', 'secret'],
  ['auth', 'secret'],
  ['password', 'secret'],
  ['passwd', 'secret'],
  ['bearer', 'secret'],
  ['env', 'config'],
  ['config', 'config'],
  ['dotenv', 'config'],
]);

export function analyzeBuiltinToolIntent(input: {
  name: string;
  args: Record<string, unknown>;
}): BuiltinToolIntent {
  switch (input.name) {
    case 'glob':
      return {
        family: 'search',
        search: buildSearchIntent(stringArg(input.args.pattern), stringArg(input.args.path)),
      };
    case 'grep':
      return {
        family: 'search',
        search: buildSearchIntent(stringArg(input.args.pattern), stringArg(input.args.path), stringArg(input.args.glob)),
      };
    case 'bash': {
      const command = stringArg(input.args.command);
      const parsedSearch = parseSearchBashCommand(command);
      if (parsedSearch) {
        return {
          family: 'search',
          search: buildSearchIntent(parsedSearch.pattern, parsedSearch.path, parsedSearch.include),
        };
      }
      const parsedRead = parseReadBashCommand(command);
      if (parsedRead) {
        return {
          family: 'read',
          read: buildReadIntent(parsedRead.path, parsedRead.offset, parsedRead.limit),
        };
      }
      return { family: 'shell' };
    }
    case 'read':
    case 'skill_read':
    case 'skill_read_resource':
      return {
        family: 'read',
        read: buildReadIntent(
          stringArg(input.args.path || input.args.resourcePath || input.args.file),
          numberOrStringArg(input.args.offset),
          numberOrStringArg(input.args.limit)
        ),
      };
    case 'write':
    case 'patch':
      return { family: 'write' };
    case 'edit':
      return { family: 'edit' };
    case 'web_search':
    case 'web_fetch':
      return { family: 'web' };
    case 'memory_search':
    case 'memory_read_summary':
      return { family: 'memory' };
    case 'todo_write':
      return { family: 'todo' };
    default:
      return { family: 'other' };
  }
}

function buildSearchIntent(pattern: string, path?: string, include?: string): BuiltinSearchIntent {
  const normalizedPath = normalizePath(path || '.');
  const rawNormalizedPattern = normalizeRawPattern(pattern);
  const normalizedTokens = canonicalizeSearchTokens(pattern);
  const signature = `${normalizedPath}::${include || '*'}::${rawNormalizedPattern || normalizedTokens.join('|')}`;
  const familyTokens = normalizedTokens.filter((token) => token === 'secret' || token === 'config');
  const familyKey = `${normalizedPath}::${familyTokens.join('|') || normalizedTokens.slice(0, 3).join('|') || 'generic-search'}`;
  return { pattern, path, include, signature, familyKey };
}

function buildReadIntent(path: string, offset?: number | string, limit?: number | string): BuiltinReadIntent {
  const normalizedPath = normalizePath(path || '.');
  const normalizedOffset = offset ?? 1;
  const normalizedLimit = limit ?? 'default';
  return {
    path,
    offset,
    limit,
    signature: `${normalizedPath}::${normalizedOffset}::${normalizedLimit}`,
    familyKey: normalizedPath,
  };
}

function canonicalizeSearchTokens(pattern: string): string[] {
  const normalized = normalizeRawPattern(pattern);
  const tokens = normalized.split(/[^a-z0-9_]+/).filter(Boolean);
  const canonical = new Set<string>();
  for (const token of tokens) {
    canonical.add(SEARCH_TOKEN_CANONICAL.get(token) || token);
  }
  return [...canonical].sort();
}

function normalizeRawPattern(pattern: string): string {
  return pattern.trim().toLowerCase().replace(/\\s\+/g, ' ').replace(/\s+/g, ' ');
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrStringArg(value: unknown): number | string | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}
