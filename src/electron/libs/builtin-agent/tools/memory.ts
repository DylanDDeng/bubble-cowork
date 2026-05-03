import type { BuiltinMemoryAdapter, BuiltinToolRegistryEntry } from '../types';
import { asNumber, asString } from './common';

export function createMemorySearchTool(memory: BuiltinMemoryAdapter): BuiltinToolRegistryEntry {
  return {
    name: 'memory_search',
    readOnly: true,
    description: 'Search persistent Aegis built-in agent memory for prior facts, user preferences, workflows, decisions, and gotchas.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Concrete search terms such as file names, decisions, preferences, or error text.' },
        limit: { type: 'number', description: 'Maximum results. Defaults to 16.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args) {
      const query = asString(args.query).trim();
      if (!query) return { content: 'Error: query is required', isError: true, status: 'command_error' };
      const limit = Math.max(1, Math.min(50, Math.floor(asNumber(args.limit, 16))));
      return { content: await memory.search(query, limit), status: 'success', metadata: { kind: 'memory' } };
    },
  };
}

export function createMemoryReadSummaryTool(memory: BuiltinMemoryAdapter): BuiltinToolRegistryEntry {
  return {
    name: 'memory_read_summary',
    readOnly: true,
    description: 'Read the concise long-term memory summary for this specific Aegis built-in agent profile.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return { content: await memory.readSummary(), status: 'success', metadata: { kind: 'memory' } };
    },
  };
}

