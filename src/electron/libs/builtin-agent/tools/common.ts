import { homedir } from 'os';
import { relative, resolve, sep } from 'path';

export const MAX_TOOL_OUTPUT_CHARS = 48_000;

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function truncate(value: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n\n[truncated ${value.length - maxChars} chars]`;
}

export function resolveInsideCwd(
  cwd: string,
  inputPath: unknown
): { ok: true; path: string; rel: string } | { ok: false; error: string } {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : '';
  if (!raw) return { ok: false, error: 'path is required' };
  const absolute = resolve(cwd, raw);
  const rel = relative(cwd, absolute);
  if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) {
    return { ok: false, error: `Path is outside the project directory: ${raw}` };
  }
  return { ok: true, path: absolute, rel };
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function getSensitivePaths(): string[] {
  return [
    resolve(homedir(), '.codex', 'auth.json'),
    resolve(homedir(), '.codex', 'config.toml'),
    resolve(homedir(), '.claude', '.credentials.json'),
    resolve(homedir(), '.claude.json'),
    resolve(homedir(), '.aegis', 'auth.json'),
    resolve(homedir(), '.aegis', 'config.json'),
  ];
}

export function isSensitivePath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return getSensitivePaths().includes(resolved);
}

export function referencesSensitivePath(command: string): boolean {
  const lower = command.toLowerCase();
  return getSensitivePaths().some((filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    return lower.includes(normalized.toLowerCase()) || lower.includes(normalized.toLowerCase().replace(homedir().toLowerCase(), '~'));
  });
}

export interface ParsedSearchBashCommand {
  pattern: string;
  path?: string;
  include?: string;
}

export interface ParsedReadBashCommand {
  path: string;
  offset?: number | string;
  limit?: number | string;
}

export function shellSplit(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export function parseSearchBashCommand(command: string): ParsedSearchBashCommand | null {
  const trimmed = command.trim();
  if (!trimmed || /[|;&><`]/.test(trimmed)) return null;
  const tokens = shellSplit(trimmed);
  if (tokens.length === 0 || !['rg', 'ripgrep', 'grep'].includes(tokens[0])) return null;

  const positional: string[] = [];
  let include: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === '--glob' || token === '--iglob' || token === '--include') {
      include = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--glob=') || token.startsWith('--iglob=') || token.startsWith('--include=')) {
      include = token.slice(token.indexOf('=') + 1);
      continue;
    }
    if (token.startsWith('-')) continue;
    positional.push(token);
  }

  if (positional.length === 0) return null;
  return {
    pattern: positional[0],
    path: positional[1],
    include,
  };
}

export function parseReadBashCommand(command: string): ParsedReadBashCommand | null {
  const trimmed = command.trim();
  if (!trimmed || /[|;&><`]/.test(trimmed)) return null;
  const tokens = shellSplit(trimmed);
  if (tokens.length === 0) return null;

  const binary = tokens[0];
  if (binary === 'cat' || binary === 'nl') {
    const path = lastPositional(tokens.slice(1));
    return path ? { path } : null;
  }
  if (binary === 'head') {
    const { path, lineCount } = parseHeadTailArgs(tokens.slice(1));
    return path ? { path, offset: 1, limit: lineCount ?? 'head' } : null;
  }
  if (binary === 'tail') {
    const { path, lineCount } = parseHeadTailArgs(tokens.slice(1));
    return path ? { path, offset: `tail:${lineCount ?? 'default'}`, limit: lineCount ?? 'tail' } : null;
  }
  if (binary === 'sed') {
    return parseSedReadCommand(tokens.slice(1));
  }
  return null;
}

export function classifyDangerousBashCommand(command: string): string | null {
  const normalized = command.trim().replace(/\s+/g, ' ');
  const lower = normalized.toLowerCase();
  if (!normalized) return null;

  const tokens = shellSplit(normalized);
  const binary = tokens[0] || '';
  if (['sudo', 'su'].includes(binary)) {
    return 'privilege escalation commands are not allowed from the built-in agent';
  }
  if (binary === 'rm' && tokens.some((token) => /^-.*r/i.test(token)) && tokens.some(isDangerousRmTarget)) {
    return 'recursive removal of broad or root-level paths is blocked';
  }
  if ((binary === 'chmod' || binary === 'chown') && tokens.some((token) => token === '-R' || token === '--recursive')) {
    return 'recursive ownership/permission changes are blocked';
  }
  if (binary === 'chmod' && tokens.some((token) => token === '777' || token === '0777')) {
    return 'world-writable permission changes are blocked';
  }
  if (['mkfs', 'mount', 'umount', 'shutdown', 'reboot', 'halt', 'poweroff'].includes(binary)) {
    return 'system-level commands are blocked';
  }
  if (binary === 'diskutil' && /\b(erase|partition|apfs\s+delete|unmountdisk)\b/i.test(lower)) {
    return 'destructive diskutil operations are blocked';
  }
  if (binary === 'dd' && /\bof=\/dev\//i.test(lower)) {
    return 'raw disk writes are blocked';
  }
  if ((binary === 'pkill' || binary === 'killall') && tokens.some((token) => token === '-9' || token === '-f')) {
    return 'broad process-kill commands are blocked';
  }
  if (lower.includes(':(){ :|:& };:') || lower.includes('while true; do') && lower.includes('&')) {
    return 'fork-bomb or unbounded background loop patterns are blocked';
  }
  return null;
}

function isDangerousRmTarget(token: string): boolean {
  const normalized = token.replace(/['"]/g, '');
  return normalized === '/'
    || normalized === '.'
    || normalized === './'
    || normalized === '..'
    || normalized === '../'
    || normalized === '*'
    || normalized === './*'
    || normalized === '~'
    || normalized === '~/'
    || normalized === '$HOME'
    || normalized === '${HOME}';
}

function lastPositional(tokens: string[]): string | undefined {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) return token;
  }
  return undefined;
}

function parseHeadTailArgs(tokens: string[]): { path?: string; lineCount?: number } {
  let lineCount: number | undefined;
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-n' || token === '--lines') {
      lineCount = parsePositiveInt(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith('-n') && token.length > 2) {
      lineCount = parsePositiveInt(token.slice(2));
      continue;
    }
    if (token.startsWith('--lines=')) {
      lineCount = parsePositiveInt(token.slice('--lines='.length));
      continue;
    }
    if (token.startsWith('-')) continue;
    positional.push(token);
  }
  return { path: positional[positional.length - 1], lineCount };
}

function parseSedReadCommand(tokens: string[]): ParsedReadBashCommand | null {
  const positional = tokens.filter((token) => token !== '-n' && !token.startsWith('-'));
  if (positional.length < 2) return null;
  const expression = positional[0];
  const path = positional[positional.length - 1];
  const range = expression.match(/^(\d+)(?:,(\d+))?p$/);
  if (!range) return { path, offset: expression };
  const start = Number(range[1]);
  const end = range[2] ? Number(range[2]) : start;
  return { path, offset: start, limit: Math.max(1, end - start + 1) };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/^\+/, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
