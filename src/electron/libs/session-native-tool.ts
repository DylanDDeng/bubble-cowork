import { READ_SESSION_DESCRIPTION, readSessionTool } from './session-reference';
import { START_WORKFLOW_DESCRIPTION, startWorkflowTool, type StartWorkflowArgs } from './workflow/chat-entry';
import { START_WORKFLOW_TOOL } from '../../shared/workflow';

export const SESSION_READER_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['sessionId'],
  properties: {
    sessionId: { type: 'string', description: 'Aegis session ID from the conversation link.' },
    cursor: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
    maxMessageChars: { type: 'integer', minimum: 1, maximum: 12000 },
  },
};

export function createNativeSessionReader() {
  return {
    name: 'read_session', description: READ_SESSION_DESCRIPTION,
    parameters: SESSION_READER_JSON_SCHEMA, readOnly: true, effect: 'read' as const,
    async execute(args: Parameters<typeof readSessionTool>[0]) {
      const result = await readSessionTool(args);
      return { content: result.content.map(item => item.text).join('\n'), isError: result.isError === true };
    },
  };
}

export function createPiSessionReader() {
  return {
    name: 'read_session', label: 'Read conversation',
    description: READ_SESSION_DESCRIPTION, promptSnippet: READ_SESSION_DESCRIPTION,
    parameters: SESSION_READER_JSON_SCHEMA,
    async execute(_callId: string, args: Parameters<typeof readSessionTool>[0]) {
      const result = await readSessionTool(args);
      if (result.isError) throw new Error(result.content[0].text);
      return { content: result.content, details: {} };
    },
  };
}

export const START_WORKFLOW_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['request'],
  properties: {
    request: { type: 'string', description: "The user's request, self-contained and in the user's words (which agents, what they should do)." },
    context: { type: 'string', description: 'What the other agents need to know from this conversation, such as a summary of the changes you made.' },
  },
};

/**
 * Bubble registers host tools once per SDK instance, so the call carries no
 * session; the workflow entry attributes it from the pending tool call in the
 * caller's history. It starts other agents, so it is approval-gated (follows
 * the session's permission mode) and unavailable in Plan mode.
 */
export function createNativeStartWorkflow() {
  return {
    name: START_WORKFLOW_TOOL, description: START_WORKFLOW_DESCRIPTION,
    parameters: START_WORKFLOW_JSON_SCHEMA, readOnly: false, effect: 'unknown' as const, requiresApproval: true,
    async execute(args: StartWorkflowArgs) {
      const result = await startWorkflowTool(null, args);
      return { content: result.content.map(item => item.text).join('\n'), isError: result.isError === true };
    },
  };
}

/** Pi custom tools are created per session, so the caller is known. */
export function createPiStartWorkflow(callerSessionId: string) {
  return {
    name: START_WORKFLOW_TOOL, label: 'Start workflow',
    description: START_WORKFLOW_DESCRIPTION, promptSnippet: START_WORKFLOW_DESCRIPTION,
    parameters: START_WORKFLOW_JSON_SCHEMA,
    async execute(_callId: string, args: StartWorkflowArgs) {
      const result = await startWorkflowTool(callerSessionId, args);
      if (result.isError) throw new Error(result.content[0].text);
      return { content: result.content, details: {} };
    },
  };
}
