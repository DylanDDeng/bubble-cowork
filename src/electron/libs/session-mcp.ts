import { z } from 'zod';
import { READ_SESSION_DESCRIPTION, readSessionTool } from './session-reference';

export const SESSION_MCP_SERVER_NAME = 'aegis-sessions';
const schema = {
  sessionId: z.string().describe('The Aegis session ID from a conversation link.'),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  maxMessageChars: z.number().int().min(1).max(12000).optional(),
};
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export function buildSessionMcpServer() {
  // Electron compiles to CJS; node10 resolution cannot resolve the SDK export map.
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: SESSION_MCP_SERVER_NAME, version: '0.1.0' });
  server.registerTool('read_session', {
    description: READ_SESSION_DESCRIPTION, inputSchema: schema, annotations,
  }, readSessionTool);
  return server;
}

export async function createSessionSdkMcpServer() {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as
    (specifier: string) => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>;
  const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk');
  return sdk.createSdkMcpServer({
    name: SESSION_MCP_SERVER_NAME, version: '0.1.0',
    tools: [sdk.tool('read_session', READ_SESSION_DESCRIPTION, schema, readSessionTool, { annotations })],
  });
}
