import { constants } from 'fs';
import { access, readFile, stat, writeFile } from 'fs/promises';
import type { BuiltinApprovalController, BuiltinToolRegistryEntry } from '../types';
import { asString, resolveInsideCwd } from './common';
import { countDiffChanges, createToolUnifiedDiff } from './diff-utils';
import { withFileMutationQueue } from './file-mutation-queue';

interface NormalizedText {
  text: string;
  map: number[];
}

interface AppliedEdit {
  content: string;
  normalizedMatches: number;
}

function normalizeMatchChar(char: string): string {
  switch (char) {
    case '\u00a0':
    case '\u2007':
    case '\u202f':
      return ' ';
    case '\u2018':
    case '\u2019':
    case '\u201b':
      return "'";
    case '\u201c':
    case '\u201d':
    case '\u201f':
      return '"';
    case '\u2013':
    case '\u2014':
      return '-';
    default:
      return char;
  }
}

function buildNormalizedText(value: string): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];
  const push = (char: string, index: number) => {
    chars.push(normalizeMatchChar(char));
    map.push(index);
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\r') {
      if (value[index + 1] === '\n') {
        push('\n', index);
        index += 1;
      } else {
        push('\n', index);
      }
      continue;
    }
    push(char, index);
  }

  const keep = new Array(chars.length).fill(true);
  let lineEnd = chars.length;
  for (let index = chars.length - 1; index >= -1; index -= 1) {
    if (index === -1 || chars[index] === '\n') {
      let trimIndex = lineEnd - 1;
      while (trimIndex > index && chars[trimIndex] === ' ') {
        keep[trimIndex] = false;
        trimIndex -= 1;
      }
      lineEnd = index;
    }
  }

  const normalizedChars: string[] = [];
  const normalizedMap: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    if (!keep[index]) continue;
    normalizedChars.push(chars[index]);
    normalizedMap.push(map[index]);
  }
  return { text: normalizedChars.join(''), map: normalizedMap };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  const indexes: number[] = [];
  if (!needle) return indexes;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    indexes.push(index);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return indexes;
}

function applySingleEdit(content: string, oldText: string, newText: string): AppliedEdit {
  const exactCount = countOccurrences(content, oldText);
  if (exactCount === 1) {
    return { content: content.replace(oldText, newText), normalizedMatches: 0 };
  }
  if (exactCount > 1) {
    throw new Error(`oldText occurs ${exactCount} time(s); expected exactly once.`);
  }

  const normalizedContent = buildNormalizedText(content);
  const normalizedOldText = buildNormalizedText(oldText);
  if (!normalizedOldText.text) {
    throw new Error('oldText is empty after normalization.');
  }
  const normalizedIndexes = findAllOccurrences(normalizedContent.text, normalizedOldText.text);
  if (normalizedIndexes.length !== 1) {
    throw new Error(`oldText occurs ${normalizedIndexes.length} time(s) after normalized matching; expected exactly once.`);
  }

  const normalizedStart = normalizedIndexes[0];
  const normalizedEnd = normalizedStart + normalizedOldText.text.length;
  const originalStart = normalizedContent.map[normalizedStart];
  const originalEnd = normalizedEnd < normalizedContent.map.length
    ? normalizedContent.map[normalizedEnd]
    : content.length;
  return {
    content: `${content.slice(0, originalStart)}${newText}${content.slice(originalEnd)}`,
    normalizedMatches: 1,
  };
}

function applyEdits(content: string, edits: Array<{ oldText: string; newText: string }>): AppliedEdit {
  let next = content;
  let normalizedMatches = 0;
  for (const edit of edits) {
    if (!edit.oldText) {
      throw new Error('every edit requires oldText');
    }
    const applied = applySingleEdit(next, edit.oldText, edit.newText);
    next = applied.content;
    normalizedMatches += applied.normalizedMatches;
  }
  return { content: next, normalizedMatches };
}

export function createEditTool(cwd: string, approval?: BuiltinApprovalController): BuiltinToolRegistryEntry {
  return {
    name: 'edit',
    description: 'Apply one or more targeted string replacements to an existing UTF-8 file inside the project directory. Prefer exact oldText; unique normalized matches can tolerate line endings, trailing whitespace, Unicode spaces, and smart punctuation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        edits: {
          type: 'array',
          description: 'List of replacements. Each oldText must occur exactly once.',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact text to replace.' },
              newText: { type: 'string', description: 'Replacement text.' },
            },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
        oldText: { type: 'string', description: 'Deprecated single replacement old text.' },
        newText: { type: 'string', description: 'Deprecated single replacement new text.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const file = resolveInsideCwd(cwd, args.path);
      if (!file.ok) return { content: `Error: ${file.error}`, isError: true, status: 'command_error' };
      return withFileMutationQueue(file.path, async () => {
        try {
          await access(file.path, constants.R_OK | constants.W_OK);
          const fileStat = await stat(file.path);
          if (fileStat.isDirectory()) {
            return {
              content: `Error: ${file.rel} is a directory. Edit requires a specific UTF-8 file path.`,
              isError: true,
              status: 'command_error',
            };
          }
        } catch {
          return { content: `Error: Cannot read/write file: ${file.rel}`, isError: true, status: 'command_error' };
        }
        const edits = Array.isArray(args.edits)
          ? args.edits.map((edit) => ({
              oldText: asString((edit as Record<string, unknown>).oldText),
              newText: asString((edit as Record<string, unknown>).newText),
            }))
          : [{ oldText: asString(args.oldText), newText: asString(args.newText) }];
        if (edits.length === 0) return { content: 'Error: edits are required', isError: true, status: 'command_error' };
        const original = await readFile(file.path, 'utf-8');
        let applied: AppliedEdit;
        try {
          applied = applyEdits(original, edits);
        } catch (error) {
          return {
            content: `Error: ${error instanceof Error ? error.message : String(error)} in ${file.rel}`,
            isError: true,
            status: 'command_error',
          };
        }
        if (applied.content === original) {
          return { content: `No changes needed for ${file.rel}.`, status: 'success', metadata: { kind: 'edit', path: file.path } };
        }
        const removedChars = edits.reduce((sum, edit) => sum + edit.oldText.length, 0);
        const addedChars = edits.reduce((sum, edit) => sum + edit.newText.length, 0);
        const diff = createToolUnifiedDiff(file.rel, original, applied.content);
        const changes = countDiffChanges(diff);
        const decision = await approval?.requestFileChange({
          id: ctx.toolCall.id,
          toolName: 'edit',
          title: 'Edit file',
          question: `Allow Aegis Built-in Agent to edit ${file.rel}?`,
          filePath: file.path,
          summary: [
            `Edit ${file.rel}`,
            `${edits.length} replacement(s)`,
            `Replace ${removedChars} chars with ${addedChars} chars`,
            ...(applied.normalizedMatches > 0 ? [`${applied.normalizedMatches} normalized match(es)`] : []),
            `${changes.addedLines} line(s) added, ${changes.removedLines} removed`,
          ],
        });
        if (decision && decision.behavior !== 'allow') {
          return { content: decision.message || 'File edit was denied by the user.', isError: true, status: 'blocked' };
        }
        const latest = await readFile(file.path, 'utf-8');
        if (latest !== original) {
          return {
            content: `Error: Cannot safely edit ${file.rel} because it changed while approval was pending. Re-read the file and retry against the latest content.`,
            isError: true,
            status: 'blocked',
            metadata: { kind: 'security', path: file.path, reason: 'changed' },
          };
        }
        await writeFile(file.path, applied.content, 'utf-8');
        return {
          content: [
            `Edited ${file.rel} with ${edits.length} replacement(s).`,
            applied.normalizedMatches > 0 ? `Used ${applied.normalizedMatches} normalized match(es).` : '',
            diff ? `\nDiff:\n${diff}` : '',
          ].filter(Boolean).join('\n'),
          status: 'success',
          metadata: {
            kind: 'edit',
            path: file.path,
            ...(diff ? { diff } : {}),
            addedLines: changes.addedLines,
            removedLines: changes.removedLines,
          },
        };
      });
    },
  };
}
