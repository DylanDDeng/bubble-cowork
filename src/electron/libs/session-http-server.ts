import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { buildSessionMcpServer, SESSION_MCP_SERVER_NAME } from './session-mcp';

export { SESSION_MCP_SERVER_NAME } from './session-mcp';
export const SESSION_TOKEN_ENV_VAR = 'AEGIS_SESSION_MCP_TOKEN';
export interface SessionHttpServerInfo { url: string; port: number; token: string }
let pending: Promise<SessionHttpServerInfo> | null = null;
let http: Server | null = null;

export async function handleSessionMcpRequest(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  if (new URL(req.url || '/', 'http://127.0.0.1').pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const server = buildSessionMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function ensureSessionHttpServer(): Promise<SessionHttpServerInfo> {
  if (pending) return pending;
  pending = (async () => {
    const token = randomUUID();
    const server = createServer((req, res) => {
      void handleSessionMcpRequest(req, res, token).catch(error => {
        console.warn('Conversation reader request failed:', error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      server.unref();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Conversation reader did not bind a port.');
      const info = { url: `http://127.0.0.1:${address.port}/mcp`, port: address.port, token };
      process.env[SESSION_TOKEN_ENV_VAR] = token;
      http = server;
      return info;
    } catch (error) {
      server.close();
      throw error;
    }
  })();
  void pending.catch(() => { pending = null; });
  return pending;
}

export function disposeSessionHttpServer(): void {
  http?.close();
  http = null;
  pending = null;
}

// Runtime-only descriptor. Never persist this endpoint in a user's agent config.
export async function getSessionReaderHttpConfig() {
  const info = await ensureSessionHttpServer();
  return { type: 'http' as const, url: info.url, headers: { Authorization: `Bearer ${info.token}` } };
}

export async function getSessionReaderCodexArgs(): Promise<string[]> {
  const info = await ensureSessionHttpServer();
  return ['-c', `mcp_servers.aegis-sessions={url=${JSON.stringify(info.url)},bearer_token_env_var="${SESSION_TOKEN_ENV_VAR}",enabled=true}`];
}
