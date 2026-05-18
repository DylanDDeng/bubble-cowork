import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { BuiltinApprovalController, BuiltinToolRegistryEntry, BuiltinToolResult } from '../types';
import { asString, resolveInsideCwd } from './common';
import { countDiffChanges, createToolUnifiedDiff } from './diff-utils';
import type { FileStateTracker } from './file-state';
import { withFileMutationQueue } from './file-mutation-queue';

export function createWriteTool(cwd: string, approval?: BuiltinApprovalController, fileState?: FileStateTracker): BuiltinToolRegistryEntry {
  return {
    name: 'write',
    description: 'Write a UTF-8 text file inside the project directory. Creates new files directly. For existing files, set overwrite=true only for intentional full-file replacement after the file has been read or modified in this session; use edit for small targeted changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        content: { type: 'string', description: 'Full file content.' },
        overwrite: { type: 'boolean', description: 'Set true only for full-file replacement of an existing file observed in this session.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const file = resolveInsideCwd(cwd, args.path);
      if (!file.ok) return { content: `Error: ${file.error}`, isError: true, status: 'command_error' };
      return withFileMutationQueue(file.path, async () => {
        const overwrite = args.overwrite === true;
        let existed = false;
        let oldContent = '';
        try {
          oldContent = await readFile(file.path, 'utf-8');
          existed = true;
        } catch {
          // New file.
        }
        const content = asString(args.content);

        if (existed && !overwrite) {
          return {
            content:
              `Error: File already exists: ${file.rel}.\n\n` +
              'For small targeted changes, use edit.\n' +
              'For a full-file replacement, call write again with overwrite=true. Existing files must be read or modified in this session before they can be safely overwritten.\n' +
              'Do not delete and recreate the file just to overwrite it.',
            isError: true,
            status: 'command_error',
          };
        }

        if (existed && overwrite) {
          if (!fileState) {
            return {
              content: `Error: Cannot safely overwrite ${file.rel} because file-state tracking is unavailable. Read the file first in this agent session, then retry the full-file replacement.`,
              isError: true,
              status: 'blocked',
              metadata: { kind: 'security', path: file.path, reason: 'unobserved' },
            };
          }
          const freshness = await fileState.checkFresh(file.path);
          if (!freshness.ok) return staleOverwriteResult(file.rel, file.path, freshness.reason);
        }

        const diff = createToolUnifiedDiff(file.rel, oldContent, content);
        const changes = countDiffChanges(diff);
        const decision = await approval?.requestFileChange({
          id: ctx.toolCall.id,
          toolName: 'write',
          title: existed ? 'Overwrite file' : 'Write file',
          question: `Allow Aegis Built-in Agent to ${existed ? 'overwrite' : 'create'} ${file.rel}?`,
          filePath: file.path,
          summary: [
            `${existed ? 'Overwrite' : 'Create'} ${file.rel}`,
            `${content.split('\n').length} lines`,
            `${changes.addedLines} line(s) added, ${changes.removedLines} removed`,
          ],
        });
        if (decision && decision.behavior !== 'allow') {
          return { content: decision.message || 'File creation was denied by the user.', isError: true, status: 'blocked' };
        }

        if (existed && overwrite && fileState) {
          const freshness = await fileState.checkFresh(file.path);
          if (!freshness.ok) return staleOverwriteResult(file.rel, file.path, freshness.reason);
        }
        if (!existed) {
          try {
            await readFile(file.path, 'utf-8');
            return {
              content: `Error: Cannot safely create ${file.rel} because it was created while approval was pending. Re-read the workspace state and retry with edit or write overwrite=true if needed.`,
              isError: true,
              status: 'blocked',
              metadata: { kind: 'security', path: file.path, reason: 'changed' },
            };
          } catch {
            // Still a new file.
          }
        }
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, content, 'utf-8');
        await fileState?.observe(file.path, 'write', content).catch(() => undefined);
        return {
          content: [
            `${existed ? 'Updated' : 'Wrote'} ${content.split('\n').length} lines to ${file.rel}.`,
            diff ? `\nDiff:\n${diff}` : '',
          ].filter(Boolean).join('\n'),
          status: 'success',
          metadata: {
            kind: 'write',
            path: file.path,
            overwrite,
            ...(diff ? { diff } : {}),
            addedLines: changes.addedLines,
            removedLines: changes.removedLines,
          },
        };
      });
    },
  };
}

function staleOverwriteResult(relPath: string, filePath: string, reason: 'unobserved' | 'missing' | 'changed'): BuiltinToolResult {
  if (reason === 'unobserved') {
    return {
      content:
        `Error: Cannot safely overwrite existing file: ${relPath}.\n\n` +
        'This file has not been read or modified in this agent session. Read it first, then retry write with overwrite=true.\n' +
        'For small targeted changes, use edit. Do not delete and recreate the file just to overwrite it.',
      isError: true,
      status: 'blocked',
      metadata: { kind: 'security', path: filePath, reason },
    };
  }
  if (reason === 'changed') {
    return {
      content:
        `Error: Cannot safely overwrite ${relPath} because it changed since the last read/write/edit in this agent session.\n\n` +
        'Re-read the file to pick up the latest content, then retry write with overwrite=true if a full-file replacement is still intended.',
      isError: true,
      status: 'blocked',
      metadata: { kind: 'security', path: filePath, reason },
    };
  }
  return {
    content:
      `Error: Cannot safely overwrite ${relPath} because it is missing now.\n\n` +
      'Check the path before retrying.',
    isError: true,
    status: 'blocked',
    metadata: { kind: 'security', path: filePath, reason },
  };
}
