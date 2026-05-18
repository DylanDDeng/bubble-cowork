import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { BuiltinApprovalController, BuiltinToolRegistryEntry } from '../types';
import { asString, resolveInsideCwd } from './common';
import { countDiffChanges, createToolUnifiedDiff } from './diff-utils';
import { withFileMutationQueue } from './file-mutation-queue';

export function createWriteTool(cwd: string, approval?: BuiltinApprovalController): BuiltinToolRegistryEntry {
  return {
    name: 'write',
    description: 'Create a new UTF-8 text file inside the project directory. Refuses to overwrite existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const file = resolveInsideCwd(cwd, args.path);
      if (!file.ok) return { content: `Error: ${file.error}`, isError: true, status: 'command_error' };
      return withFileMutationQueue(file.path, async () => {
        if (existsSync(file.path)) {
          return { content: `Error: File already exists: ${file.rel}. Use edit for existing files.`, isError: true, status: 'command_error' };
        }
        const content = asString(args.content);
        const diff = createToolUnifiedDiff(file.rel, '', content);
        const changes = countDiffChanges(diff);
        const decision = await approval?.requestFileChange({
          id: ctx.toolCall.id,
          toolName: 'write',
          title: 'Write file',
          question: `Allow Aegis Built-in Agent to create ${file.rel}?`,
          filePath: file.path,
          summary: [
            `Create ${file.rel}`,
            `${content.split('\n').length} lines`,
            `${changes.addedLines} line(s) added`,
          ],
        });
        if (decision && decision.behavior !== 'allow') {
          return { content: decision.message || 'File creation was denied by the user.', isError: true, status: 'blocked' };
        }
        if (existsSync(file.path)) {
          return {
            content: `Error: Cannot safely create ${file.rel} because it was created while approval was pending. Re-read the workspace state and retry with edit if needed.`,
            isError: true,
            status: 'blocked',
            metadata: { kind: 'security', path: file.path, reason: 'changed' },
          };
        }
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, content, 'utf-8');
        return {
          content: [
            `Wrote ${content.split('\n').length} lines to ${file.rel}.`,
            diff ? `\nDiff:\n${diff}` : '',
          ].filter(Boolean).join('\n'),
          status: 'success',
          metadata: {
            kind: 'write',
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
