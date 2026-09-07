/** Public links address Aegis session IDs, never provider-specific IDs. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSessionLink(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid conversation ID.');
  return `aegis://sessions/${sessionId}`;
}

export function parseSessionLink(value: string): string | null {
  // Match the entire value so credentials, query strings, paths and malformed
  // URLs cannot be interpreted as an existing session.
  const match = /^aegis:\/\/sessions\/([^/?#]+)$/i.exec(value);
  return match && SESSION_ID.test(match[1]) ? match[1].toLowerCase() : null;
}

export function extractSessionLinks(text: string) {
  const result: Array<{ sessionId: string; raw: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/(?<![\w/:])aegis:\/\/sessions\/[^\s<>"'`\[\]()，。！？；、]+/gi)) {
    const raw = match[0].replace(/[.,;!]+$/, '');
    const sessionId = parseSessionLink(raw);
    if (sessionId) result.push({ sessionId, raw, start: match.index!, end: match.index! + raw.length });
  }
  return result;
}

/** Keep composer and main-process capability checks identical. */
export function getSessionReferenceCapabilityError(prompt: string, provider: string, currentSessionId?: string): string | null {
  if (!extractSessionLinks(prompt).some(link => link.sessionId !== currentSessionId)) return null;
  if (['claude', 'codex', 'bubble', 'pi', 'qoder', 'opencode', 'deepseek', 'grok'].includes(provider)) return null;
  return 'Conversation references are not available with this agent runtime. Remove the reference or select another agent.';
}
