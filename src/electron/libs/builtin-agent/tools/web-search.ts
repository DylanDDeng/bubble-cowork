import type { BuiltinToolRegistryEntry } from '../types';
import { callExaMcpTool } from './exa-mcp';

const DEFAULT_RESULTS = 8;

export function createWebSearchTool(): BuiltinToolRegistryEntry {
  return {
    name: 'web_search',
    readOnly: true,
    description: 'Search the web using a remote search service and return current, structured results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Web search query' },
        numResults: { type: 'number', description: `Number of search results to return (default: ${DEFAULT_RESULTS})` },
        livecrawl: {
          type: 'string',
          description: 'Live crawl mode',
          enum: ['fallback', 'preferred'],
        },
        type: {
          type: 'string',
          description: 'Search type',
          enum: ['auto', 'fast', 'deep'],
        },
        contextMaxCharacters: {
          type: 'number',
          description: 'Maximum number of characters to return in the result context',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return { content: 'Error: query is required', isError: true, status: 'command_error' };
      }
      return callExaMcpTool('web_search_exa', {
        query,
        type: typeof args.type === 'string' ? args.type : 'auto',
        numResults: typeof args.numResults === 'number' ? args.numResults : DEFAULT_RESULTS,
        livecrawl: typeof args.livecrawl === 'string' ? args.livecrawl : 'fallback',
        ...(typeof args.contextMaxCharacters === 'number'
          ? { contextMaxCharacters: args.contextMaxCharacters }
          : {}),
      });
    },
  };
}

