import { extractSessionLinks } from '../../shared/session-links';
import { createNativeSessionReader, createNativeStartWorkflow } from './session-native-tool';
import { createBubbleBrowserUseTool } from './bubble-browser-use-tool';
import { isBrowserUseEnabled } from './browser-use-permissions';
import type { BubbleContentPart } from './provider/bubble-sdk-loader';

export const BUBBLE_SESSION_TOOL = 'read_session';

/** Aegis host tools, passed to every Bubble turn (`runTurn({ hostTools })`).
 * The read-only conversation reader runs ungated, like builtin Read in Plan
 * mode; start_workflow and browser_use are actions, so Bubble gates them like
 * MCP tools. Host tools are turn-scoped, so a session's turns carry tools
 * bound to it. Bubble withholds host tools from subagents. */
export function bubbleHostTools(sessionId?: string): object[] {
  // The workflow entry (start_workflow); member sessions are refused at call time.
  const tools: object[] = [createNativeSessionReader(), createNativeStartWorkflow()];
  if (sessionId && isBrowserUseEnabled()) tools.push(createBubbleBrowserUseTool(sessionId));
  return tools;
}

export function assertBubbleSessionReader(prompt: string | BubbleContentPart[], tools: string[], currentSessionId: string): void {
  const text = typeof prompt === 'string' ? prompt : prompt.filter(part => part.type === 'text').map(part => part.text || '').join('\n');
  if (extractSessionLinks(text).some(link => link.sessionId !== currentSessionId) && !tools.includes(BUBBLE_SESSION_TOOL)) {
    throw new Error('Conversation reader is unavailable in this Bubble runtime. Restart Aegis, then retry this message.');
  }
}
