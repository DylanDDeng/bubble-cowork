import { constants } from 'fs';
import { access, readFile } from 'fs/promises';
import type { BuiltinToolRegistryEntry } from '../types';
import { asNumber, isSensitivePath, resolveInsideCwd } from './common';

const MAX_LINES = 250;
const MAX_BYTES = 100 * 1024;

export function createReadTool(cwd: string): BuiltinToolRegistryEntry {
  return {
    name: 'read',
    readOnly: true,
    description: `Read the contents of a file. Output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB. Use offset/limit for large files.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        offset: { type: 'number', description: 'Line number to start from, one-indexed.' },
        limit: { type: 'number', description: 'Maximum number of lines to read.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args) {
      const file = resolveInsideCwd(cwd, args.path);
      if (!file.ok) return { content: `Error: ${file.error}`, isError: true, status: 'command_error' };
      if (isSensitivePath(file.path)) {
        return {
          content: `Error: Access to sensitive credential storage is blocked: ${file.path}`,
          isError: true,
          status: 'blocked',
          metadata: { kind: 'security', path: file.path, reason: 'Sensitive credential storage is not readable from general-purpose tasks.' },
        };
      }
      try {
        await access(file.path, constants.R_OK);
      } catch {
        return { content: `Error: Cannot read file: ${file.rel}`, isError: true, status: 'command_error' };
      }
      const content = await readFile(file.path, 'utf-8');
      const lines = content.split('\n');
      const offset = Math.max(0, Math.floor(asNumber(args.offset, 1)) - 1);
      const limit = Math.max(1, Math.floor(asNumber(args.limit, lines.length)));
      let selected = lines.slice(offset, offset + limit);
      let truncated = false;
      if (selected.length > MAX_LINES) {
        selected = selected.slice(0, MAX_LINES);
        truncated = true;
      }
      let output = selected.join('\n');
      if (Buffer.byteLength(output, 'utf-8') > MAX_BYTES) {
        output = Buffer.from(output, 'utf-8').subarray(0, MAX_BYTES).toString('utf-8');
        truncated = true;
      }
      if (truncated) {
        output += `\n[Output truncated: exceeded ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB limit]`;
      }
      return {
        content: output,
        status: truncated ? 'partial' : 'success',
        metadata: { kind: 'read', path: file.path, truncated },
      };
    },
  };
}

