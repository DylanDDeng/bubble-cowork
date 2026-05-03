import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { BuiltinApprovalController, BuiltinToolRegistryEntry } from '../types';
import { asString, resolveInsideCwd } from './common';

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
      if (existsSync(file.path)) {
        return { content: `Error: File already exists: ${file.rel}. Use edit for existing files.`, isError: true, status: 'command_error' };
      }
      const content = asString(args.content);
      const decision = await approval?.requestFileChange({
        id: ctx.toolCall.id,
        toolName: 'write',
        title: 'Write file',
        question: `Allow Aegis Built-in Agent to create ${file.rel}?`,
        filePath: file.path,
        summary: [`Create ${file.rel}`, `${content.split('\n').length} lines`],
      });
      if (decision && decision.behavior !== 'allow') {
        return { content: decision.message || 'File creation was denied by the user.', isError: true, status: 'blocked' };
      }
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, content, 'utf-8');
      return { content: `Wrote ${content.split('\n').length} lines to ${file.rel}.`, status: 'success', metadata: { kind: 'write', path: file.path } };
    },
  };
}

