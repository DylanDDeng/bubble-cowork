import type { BuiltinToolRegistryEntry } from '../types';
import { callExaMcpTool } from './exa-mcp';

export function createWebFetchTool(): BuiltinToolRegistryEntry {
  return {
    name: 'web_fetch',
    readOnly: true,
    description: 'Fetch and extract the contents of a specific URL using a remote web crawling service.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch and extract' },
        query: { type: 'string', description: 'Optional topic to focus the extracted summary/highlights on' },
        maxCharacters: {
          type: 'number',
          description: 'Maximum number of characters to include in the extracted context',
        },
        livecrawl: {
          type: 'string',
          description: 'Live crawl mode',
          enum: ['never', 'fallback', 'preferred', 'always'],
        },
        livecrawlTimeout: {
          type: 'number',
          description: 'Maximum live crawl time in milliseconds',
        },
        subpages: {
          type: 'number',
          description: 'Optional number of linked subpages to fetch as well',
        },
        subpageTarget: {
          type: 'string',
          description: 'Optional guidance for which subpages matter most',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args) {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) {
        return { content: 'Error: url is required', isError: true, status: 'command_error' };
      }
      const query = typeof args.query === 'string' ? args.query.trim() : undefined;
      return callExaMcpTool('crawling_exa', {
        urls: [url],
        livecrawl: typeof args.livecrawl === 'string' ? args.livecrawl : 'fallback',
        ...(typeof args.livecrawlTimeout === 'number' ? { livecrawlTimeout: args.livecrawlTimeout } : {}),
        ...(typeof args.subpages === 'number' ? { subpages: args.subpages } : {}),
        ...(typeof args.subpageTarget === 'string' && args.subpageTarget.trim()
          ? { subpageTarget: args.subpageTarget.trim() }
          : {}),
        text: true,
        context: typeof args.maxCharacters === 'number' ? { maxCharacters: args.maxCharacters } : true,
        summary: query ? { query } : true,
        highlights: query
          ? {
              query,
              numSentences: 3,
              highlightsPerUrl: 5,
            }
          : undefined,
      });
    },
  };
}

