import type { ProjectTreeNode } from '../types';

export interface ProjectFileSuggestion {
  path: string;
  name: string;
  relativePath: string;
}

export interface ProjectFileMentionState {
  query: string;
  start: number;
  end: number;
}

export interface ProjectFileMentionToken {
  raw: string;
  path: string;
  start: number;
  end: number;
}

export type ProjectFilePromptSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; path: string; text: string; start: number; end: number };

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function toRelativeProjectPath(cwd: string, filePath: string): string {
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/, '');
  const normalizedPath = normalizePath(filePath);
  if (!normalizedCwd) {
    return normalizedPath;
  }

  if (normalizedPath === normalizedCwd) {
    return '';
  }

  const prefix = `${normalizedCwd}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

export function flattenProjectTreeFiles(
  tree: ProjectTreeNode | null,
  cwd: string
): ProjectFileSuggestion[] {
  if (!tree) {
    return [];
  }

  const files: ProjectFileSuggestion[] = [];
  const visit = (node: ProjectTreeNode) => {
    if (node.kind === 'file') {
      files.push({
        path: node.path,
        name: node.name,
        relativePath: toRelativeProjectPath(cwd, node.path),
      });
      return;
    }

    node.children?.forEach(visit);
  };

  tree.children?.forEach(visit);

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function getProjectFileMentionState(
  prompt: string,
  cursorIndex: number
): ProjectFileMentionState | null {
  const safeCursor = Math.max(0, Math.min(cursorIndex, prompt.length));
  const beforeCursor = prompt.slice(0, safeCursor);
  const mentionMatch = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);

  if (!mentionMatch) {
    return null;
  }

  const query = mentionMatch[1] || '';
  const start = safeCursor - query.length - 1;
  if (start < 0 || prompt[start] !== '@') {
    return null;
  }

  let end = safeCursor;
  while (end < prompt.length) {
    const next = prompt[end];
    if (!next || /\s/.test(next) || next === '@') {
      break;
    }
    end += 1;
  }

  return { query, start, end };
}

function rankProjectFileSuggestion(suggestion: ProjectFileSuggestion, query: string): number {
  if (!query) {
    return 0;
  }

  const normalizedQuery = normalizePath(query.trim().toLowerCase());
  const relativePath = suggestion.relativePath.toLowerCase();
  const name = suggestion.name.toLowerCase();

  if (relativePath === normalizedQuery || name === normalizedQuery) return 0;
  if (relativePath.startsWith(normalizedQuery)) return 1;
  if (name.startsWith(normalizedQuery)) return 2;
  if (relativePath.includes(`/${normalizedQuery}`)) return 3;
  if (relativePath.includes(normalizedQuery)) return 4;
  if (name.includes(normalizedQuery)) return 5;
  return 6;
}

export function filterProjectFileSuggestions(
  files: ProjectFileSuggestion[],
  query: string,
  limit = 8
): ProjectFileSuggestion[] {
  const normalizedQuery = normalizePath(query.trim().toLowerCase());

  return files
    .filter((file) => {
      if (!normalizedQuery) {
        return true;
      }

      const relativePath = file.relativePath.toLowerCase();
      const name = file.name.toLowerCase();
      return relativePath.includes(normalizedQuery) || name.includes(normalizedQuery);
    })
    .sort((left, right) => {
      const rankDiff =
        rankProjectFileSuggestion(left, normalizedQuery) -
        rankProjectFileSuggestion(right, normalizedQuery);
      if (rankDiff !== 0) {
        return rankDiff;
      }

      return left.relativePath.localeCompare(right.relativePath);
    })
    .slice(0, limit);
}

export function removeProjectFileMention(
  prompt: string,
  mention: ProjectFileMentionState
): string {
  return `${prompt.slice(0, mention.start)}${prompt.slice(mention.end)}`;
}

export function insertProjectFileMention(
  prompt: string,
  mention: ProjectFileMentionState,
  relativePath: string
): { prompt: string; cursorIndex: number } {
  const replacement = `@${normalizePath(relativePath)} `;
  const nextPrompt = `${prompt.slice(0, mention.start)}${replacement}${prompt.slice(mention.end)}`;
  return {
    prompt: nextPrompt,
    cursorIndex: mention.start + replacement.length,
  };
}

export function extractProjectFileMentions(prompt: string): ProjectFileMentionToken[] {
  const tokens: ProjectFileMentionToken[] = [];

  for (const match of prompt.matchAll(/(^|\s)@([^\s@]+)(?=\s|$)/g)) {
    const raw = match[0] || '';
    const prefix = match[1] || '';
    const value = (match[2] || '').trim();
    const matchIndex = match.index ?? 0;
    const start = matchIndex + prefix.length;
    const end = start + 1 + value.length;

    if (!value) continue;

    tokens.push({
      raw: `@${value}`,
      path: normalizePath(value),
      start,
      end,
    });
  }

  return tokens;
}

export function hasProjectFileMentions(prompt: string): boolean {
  return extractProjectFileMentions(prompt).length > 0;
}

export function splitPromptIntoProjectFileSegments(prompt: string): ProjectFilePromptSegment[] {
  const mentions = extractProjectFileMentions(prompt);
  if (mentions.length === 0) {
    return prompt ? [{ type: 'text', text: prompt }] : [];
  }

  const segments: ProjectFilePromptSegment[] = [];
  let cursor = 0;

  for (const mention of mentions) {
    if (mention.start > cursor) {
      segments.push({
        type: 'text',
        text: prompt.slice(cursor, mention.start),
      });
    }

    segments.push({
      type: 'mention',
      path: mention.path,
      text: mention.raw,
      start: mention.start,
      end: mention.end,
    });
    cursor = mention.end;
  }

  if (cursor < prompt.length) {
    segments.push({
      type: 'text',
      text: prompt.slice(cursor),
    });
  }

  return segments;
}
