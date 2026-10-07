import { z } from 'zod';
import { READ_SESSION_DESCRIPTION, readSessionTool } from './session-reference';
import { START_WORKFLOW_DESCRIPTION, startWorkflowSchema, startWorkflowTool, type StartWorkflowArgs } from './workflow/chat-entry';
import { START_WORKFLOW_TOOL } from '../../shared/workflow';

export const SESSION_MCP_SERVER_NAME = 'aegis-sessions';
const schema = {
  sessionId: z.string().describe('The Aegis session ID from a conversation link.'),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  maxMessageChars: z.number().int().min(1).max(12000).optional(),
};
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const workflowAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function buildSessionMcpServer() {
  // Electron compiles to CJS; node10 resolution cannot resolve the SDK export map.
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: SESSION_MCP_SERVER_NAME, version: '0.1.0' });
  server.registerTool('read_session', {
    description: READ_SESSION_DESCRIPTION, inputSchema: schema, annotations,
  }, readSessionTool);
  // HTTP calls carry no caller identity; the workflow entry attributes them
  // to the session whose history holds the matching pending tool call.
  server.registerTool(START_WORKFLOW_TOOL, {
    description: START_WORKFLOW_DESCRIPTION, inputSchema: startWorkflowSchema, annotations: workflowAnnotations,
  }, (args: StartWorkflowArgs) => startWorkflowTool(null, args));
  return server;
}

/**
 * In-process server for one Claude session. `callerSessionId` identifies the
 * session for start_workflow; workflow member sessions get no such tool.
 */
export async function createSessionSdkMcpServer(options: { callerSessionId?: string; workflows?: boolean } = {}) {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as
    (specifier: string) => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>;
  const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk');
  return sdk.createSdkMcpServer({
    name: SESSION_MCP_SERVER_NAME, version: '0.1.0',
    tools: [
      sdk.tool('read_session', READ_SESSION_DESCRIPTION, schema, readSessionTool, { annotations }),
      ...(options.workflows && options.callerSessionId
        ? [sdk.tool(START_WORKFLOW_TOOL, START_WORKFLOW_DESCRIPTION, startWorkflowSchema,
          (args: StartWorkflowArgs) => startWorkflowTool(options.callerSessionId!, args), { annotations: workflowAnnotations })]
        : []),
    ],
  });
}
