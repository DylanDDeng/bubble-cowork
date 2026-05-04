import { constants } from 'fs';
import { access, readFile, writeFile } from 'fs/promises';
import { createUnifiedDiffHunks, formatUnifiedDiffHunks } from '../../../../shared/unified-diff';
import type { BuiltinApprovalController, BuiltinToolRegistryEntry } from '../types';
import { asString, resolveInsideCwd } from './common';

function normalizeDiffPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function createEditUnifiedDiff(filePath: string, oldText: string, newText: string): string {
  const hunks = createUnifiedDiffHunks(oldText, newText, { contextLines: 3 });
  const body = formatUnifiedDiffHunks(hunks);
  if (!body.trim()) {
    return '';
  }

  const normalized = normalizeDiffPath(filePath);
  return [
    `--- a/${normalized}`,
    `+++ b/${normalized}`,
    body,
  ].join('\n');
}

export function createEditTool(cwd: string, approval?: BuiltinApprovalController): BuiltinToolRegistryEntry {
  return {
    name: 'edit',
    description: 'Apply one or more exact string replacements to an existing UTF-8 file inside the project directory.',
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
      try {
        await access(file.path, constants.R_OK | constants.W_OK);
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
      let next = original;
      for (const edit of edits) {
        if (!edit.oldText) return { content: 'Error: every edit requires oldText', isError: true, status: 'command_error' };
        const count = next.split(edit.oldText).length - 1;
        if (count !== 1) {
          return { content: `Error: oldText occurs ${count} time(s) in ${file.rel}; expected exactly once.`, isError: true, status: 'command_error' };
        }
        next = next.replace(edit.oldText, edit.newText);
      }
      const removedChars = edits.reduce((sum, edit) => sum + edit.oldText.length, 0);
      const addedChars = edits.reduce((sum, edit) => sum + edit.newText.length, 0);
      const decision = await approval?.requestFileChange({
        id: ctx.toolCall.id,
        toolName: 'edit',
        title: 'Edit file',
        question: `Allow Aegis Built-in Agent to edit ${file.rel}?`,
        filePath: file.path,
        summary: [`Edit ${file.rel}`, `${edits.length} replacement(s)`, `Replace ${removedChars} chars with ${addedChars} chars`],
      });
      if (decision && decision.behavior !== 'allow') {
        return { content: decision.message || 'File edit was denied by the user.', isError: true, status: 'blocked' };
      }
      const diff = createEditUnifiedDiff(file.rel, original, next);
      await writeFile(file.path, next, 'utf-8');
      return {
        content: `Edited ${file.rel} with ${edits.length} replacement(s).`,
        status: 'success',
        metadata: {
          kind: 'edit',
          path: file.path,
          ...(diff ? { diff } : {}),
        },
      };
    },
  };
}
