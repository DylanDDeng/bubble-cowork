export interface GrokAcpHttpHeader {
  name: string;
  value: string;
}

export interface GrokAcpHttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: GrokAcpHttpHeader[];
}

/**
 * ACP does not use the record-shaped headers accepted by provider config
 * files. Session-scoped HTTP MCP entries require an explicit transport type
 * and an array of name/value header pairs.
 */
export function createGrokAcpHttpMcpServer(
  name: string,
  descriptor: { url: string; headers: Record<string, string> }
): GrokAcpHttpMcpServer {
  return {
    type: 'http',
    name,
    url: descriptor.url,
    headers: Object.entries(descriptor.headers).map(([headerName, value]) => ({
      name: headerName,
      value,
    })),
  };
}
