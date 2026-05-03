import type { BuiltinToolRegistryEntry, BuiltinToolSearchController } from '../types';
import { asNumber, asString } from './common';

export function createToolSearchTool(controller: BuiltinToolSearchController): BuiltinToolRegistryEntry {
  return {
    name: 'tool_search',
    readOnly: true,
    description: [
      'Fetches full schema definitions for deferred tools so they can be called.',
      'Use query "select:<name>[,<name>...]" to load specific tools, or free-text keywords to search relevant tools.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Use "select:<name>,<name>" for exact tools, or keywords to search.' },
        max_results: { type: 'number', description: 'Maximum number of matches to return. Defaults to 5.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args) {
      const query = asString(args.query);
      const maxResults = Math.max(1, Math.min(25, Math.floor(asNumber(args.max_results, 5))));
      const deferred = controller.listDeferred();
      if (deferred.length === 0) {
        return { content: 'No deferred tools are registered in this session.', status: 'no_match' };
      }
      let matches: BuiltinToolRegistryEntry[];
      const selectPrefix = 'select:';
      if (query.startsWith(selectPrefix)) {
        const names = new Set(query.slice(selectPrefix.length).split(',').map((item) => item.trim()).filter(Boolean));
        matches = deferred.filter((tool) => names.has(tool.name));
        if (matches.length === 0) {
          return { content: `No deferred tool matched select list. Known deferred tools: ${deferred.map((tool) => tool.name).join(', ')}`, isError: true, status: 'no_match' };
        }
      } else {
        matches = rankByKeywords(deferred, query).slice(0, maxResults);
        if (matches.length === 0) {
          return { content: `No deferred tools matched "${query}". Use query "select:<name>" to fetch by exact name, or try different keywords.`, status: 'no_match' };
        }
      }
      controller.unlock(matches.map((tool) => tool.name));
      const lines = ['<functions>'];
      for (const tool of matches) {
        lines.push(`<function>${JSON.stringify({
          description: tool.description,
          name: tool.name,
          parameters: tool.parameters,
        })}</function>`);
      }
      lines.push('</functions>');
      lines.push('');
      lines.push(`Loaded ${matches.length} tool${matches.length === 1 ? '' : 's'}. They are now available and callable on the next turn.`);
      return { content: lines.join('\n'), status: 'success' };
    },
  };
}

function rankByKeywords(tools: BuiltinToolRegistryEntry[], rawQuery: string): BuiltinToolRegistryEntry[] {
  const terms = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: Array<{ tool: BuiltinToolRegistryEntry; score: number }> = [];
  for (const tool of tools) {
    const haystack = `${tool.name} ${tool.description}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (tool.name.toLowerCase().includes(term)) score += 3;
      if (tool.description.toLowerCase().includes(term)) score += 1;
    }
    if (score > 0) scored.push({ tool, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).map((item) => item.tool);
}

