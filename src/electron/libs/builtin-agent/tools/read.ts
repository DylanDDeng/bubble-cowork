import { constants } from 'fs';
import { access, readFile, stat } from 'fs/promises';
import type { BuiltinToolRegistryEntry } from '../types';
import { asNumber, isSensitivePath, resolveInsideCwd } from './common';
import type { FileStateTracker } from './file-state';

const MAX_LINES = 250;
const MAX_BYTES = 100 * 1024;

interface ReadHistoryEntry {
  mtimeMs: number;
  size: number;
  firstLine: number;
  lastLine: number;
  truncated: boolean;
}

export function createReadTool(cwd: string, fileState?: FileStateTracker): BuiltinToolRegistryEntry {
  const readHistory = new Map<string, ReadHistoryEntry>();

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
      const requestedOffset = Math.max(1, Math.floor(asNumber(args.offset, 1)));
      const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? String(Math.max(1, Math.floor(args.limit)))
        : 'all';
      const historyKey = `${file.path}:${requestedOffset}:${requestedLimit}`;
      let stableStat: { mtimeMs: number; size: number } | null = null;
      try {
        await access(file.path, constants.R_OK);
        const fileStat = await stat(file.path);
        if (fileStat.isDirectory()) {
          return {
            content: `Error: ${file.rel} is a directory. Use search or list a specific file path before reading.`,
            isError: true,
            status: 'command_error',
          };
        }
        stableStat = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
      } catch {
        return { content: `Error: Cannot read file: ${file.rel}`, isError: true, status: 'command_error' };
      }
      const previous = readHistory.get(historyKey);
      if (previous && stableStat && previous.mtimeMs === stableStat.mtimeMs && previous.size === stableStat.size) {
        return {
          content:
            `File unchanged since previous read of ${file.rel} lines ${previous.firstLine}-${previous.lastLine}. ` +
            `Reuse that earlier result instead of reading the same range again.` +
            (previous.truncated ? '\n[Previous read was truncated.]' : ''),
          status: previous.truncated ? 'partial' : 'success',
          metadata: {
            kind: 'read',
            path: file.path,
            truncated: previous.truncated,
            repeated: true,
            reason: 'unchanged',
          },
        };
      }
      const content = await readFile(file.path, 'utf-8');
      const lines = content.split('\n');
      const offset = requestedOffset - 1;
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
      const explicitLimit = typeof args.limit === 'number' && Number.isFinite(args.limit);
      if (!truncated && requestedOffset === 1 && !explicitLimit) {
        await fileState?.observe(file.path, 'read', content).catch(() => undefined);
      }
      readHistory.set(historyKey, {
        mtimeMs: stableStat?.mtimeMs ?? 0,
        size: stableStat?.size ?? Buffer.byteLength(content, 'utf-8'),
        firstLine: Math.min(lines.length, offset + 1),
        lastLine: Math.min(lines.length, offset + selected.length),
        truncated,
      });
      return {
        content: output,
        status: truncated ? 'partial' : 'success',
        metadata: { kind: 'read', path: file.path, truncated },
      };
    },
  };
}
