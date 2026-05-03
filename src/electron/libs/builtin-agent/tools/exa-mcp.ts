import type { BuiltinToolResult } from '../types';

const DEFAULT_BASE_URL = 'https://mcp.exa.ai/mcp';

export function resolveExaMcpUrl(): string {
  const baseUrl = (process.env.AEGIS_WEB_SEARCH_URL || process.env.BUBBLE_WEB_SEARCH_URL || DEFAULT_BASE_URL).trim();
  const url = new URL(baseUrl);
  const enabledTools = new Set(
    (url.searchParams.get('tools') || 'web_search_exa,crawling_exa')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

  enabledTools.add('web_search_exa');
  enabledTools.add('crawling_exa');
  url.searchParams.set('tools', [...enabledTools].join(','));

  const apiKey = (process.env.AEGIS_EXA_API_KEY || process.env.BUBBLE_EXA_API_KEY || '').trim();
  if (apiKey && !url.searchParams.get('exaApiKey')) {
    url.searchParams.set('exaApiKey', apiKey);
  }

  return url.toString();
}

export async function callExaMcpTool(name: string, args: Record<string, unknown>): Promise<BuiltinToolResult> {
  const response = await fetch(resolveExaMcpUrl(), {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'User-Agent': 'aegis-built-in-agent',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    }),
  }).catch((error) => {
    throw new Error(error instanceof Error ? error.message : String(error));
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return {
      content: `Error: Remote MCP request failed with status ${response.status}${errorText ? `: ${errorText}` : ''}`,
      isError: true,
      status: 'command_error',
      metadata: { kind: 'web' },
    };
  }

  const text = await response.text();
  const result = parseMcpResponse(text);
  if (!result) {
    return { content: 'No results found.', status: 'no_match', metadata: { kind: 'web' } };
  }

  return { content: result, status: 'success', metadata: { kind: 'web' } };
}

function parseMcpResponse(body: string): string | undefined {
  const lines = body.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    try {
      const parsed = JSON.parse(line.slice(6)) as {
        result?: { content?: Array<{ type?: string; text?: string }> };
      };
      const text = parsed.result?.content?.find((item) => item.type === 'text')?.text;
      if (text) return text;
    } catch {
      // Ignore malformed SSE lines.
    }
  }

  try {
    const parsed = JSON.parse(body) as {
      result?: { content?: Array<{ type?: string; text?: string }> };
    };
    return parsed.result?.content?.find((item) => item.type === 'text')?.text;
  } catch {
    return undefined;
  }
}

