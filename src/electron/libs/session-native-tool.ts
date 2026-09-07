import { READ_SESSION_DESCRIPTION, readSessionTool } from './session-reference';

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
