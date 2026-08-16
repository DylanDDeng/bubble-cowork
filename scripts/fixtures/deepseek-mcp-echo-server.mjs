#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'aegis-deepseek-mcp-probe', version: '1.0.0' });
server.registerTool(
  'echo',
  {
    description: 'Echo probe text back to the caller.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `ECHO:${text}` }] })
);

await server.connect(new StdioServerTransport());
