import { extractSessionLinks } from '../../shared/session-links';
import { createNativeSessionReader, createNativeStartWorkflow } from './session-native-tool';
import type { BubbleContentPart } from './provider/bubble-sdk-loader';

export const BUBBLE_SESSION_TOOL = 'read_session';
const installed = new WeakSet<object>();

/** Register the host reader outside MCP's interactive/destructive permission gate.
 * The pinned SDK patch retains native Plan read-only checks and explicit deny rules. */
export function installBubbleSessionReader(instance: object): void {
  if (installed.has(instance)) return;
  const sdk = instance as { registerHostTool?: (tool: object) => void };
  if (typeof sdk.registerHostTool !== 'function') {
    throw new Error('This Bubble SDK cannot register the Aegis conversation reader. Reinstall dependencies to apply the host patch.');
  }
  sdk.registerHostTool(createNativeSessionReader());
  // The workflow entry (start_workflow); member sessions are refused at call time.
  sdk.registerHostTool(createNativeStartWorkflow());
  installed.add(instance);
}

export function assertBubbleSessionReader(prompt: string | BubbleContentPart[], tools: string[], currentSessionId: string): void {
  const text = typeof prompt === 'string' ? prompt : prompt.filter(part => part.type === 'text').map(part => part.text || '').join('\n');
  if (extractSessionLinks(text).some(link => link.sessionId !== currentSessionId) && !tools.includes(BUBBLE_SESSION_TOOL)) {
    throw new Error('Conversation reader is unavailable in this Bubble runtime. Restart Aegis, then retry this message.');
  }
}
