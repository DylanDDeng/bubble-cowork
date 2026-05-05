import { access, stat } from 'fs/promises';
import { constants } from 'fs';
import { resolve } from 'path';
import type { BuiltinLspAdapter, BuiltinToolRegistryEntry } from '../types';
import { asNumber, asString } from './common';

const OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const;

export function createLspTool(cwd: string, adapter?: BuiltinLspAdapter): BuiltinToolRegistryEntry {
  return {
    name: 'lsp',
    readOnly: true,
    description: 'Use code intelligence for navigation. Supports goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, and outgoingCalls.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...OPERATIONS], description: 'LSP operation to perform.' },
        filePath: { type: 'string', description: 'Path to the file, relative or absolute.' },
        line: { type: 'number', description: 'One-based line number for position-based operations.' },
        character: { type: 'number', description: 'One-based character offset for position-based operations.' },
        query: { type: 'string', description: 'Optional query for workspaceSymbol.' },
      },
      required: ['operation', 'filePath'],
      additionalProperties: false,
    },
    async execute(args) {
      const operation = asString(args.operation);
      if (!OPERATIONS.includes(operation as (typeof OPERATIONS)[number])) {
        return { content: `Error: Unsupported LSP operation: ${operation}`, isError: true, status: 'command_error' };
      }
      const filePath = resolve(cwd, asString(args.filePath));
      try {
        await access(filePath, constants.R_OK);
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) {
          return { content: `Error: LSP requires a file path, but received a directory: ${filePath}`, isError: true, status: 'command_error' };
        }
      } catch {
        return { content: `Error: File not found or not readable: ${filePath}`, isError: true, status: 'command_error' };
      }
      if (!adapter) {
        return {
          content: 'Error: No LSP adapter is available for Aegis built-in agent yet.',
          isError: true,
          status: 'command_error',
          metadata: { kind: 'lsp', path: filePath },
        };
      }
      return adapter.run({
        operation,
        filePath,
        line: asNumber(args.line, 1),
        character: asNumber(args.character, 1),
        query: asString(args.query),
        cwd,
      });
    },
  };
}
