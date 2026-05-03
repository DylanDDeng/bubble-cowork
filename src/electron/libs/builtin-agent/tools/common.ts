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

export function parseSearchBashCommand(command: string): { pattern?: string; path?: string } | null {
  const trimmed = command.trim();
  const rgMatch = trimmed.match(/^(?:rg|grep)\s+(?:-[^\s]+\s+)*['"]?([^'"\s]+)['"]?(?:\s+([^\s]+))?/);
  if (!rgMatch) return null;
  return {
    pattern: rgMatch[1],
    path: rgMatch[2],
  };
}

