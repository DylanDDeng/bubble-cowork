import { extractSessionLinks } from '../../shared/session-links';
import { createNativeSessionReader } from './session-native-tool';
import type { BubbleContentPart } from './provider/bubble-sdk-loader';

export const BUBBLE_SESSION_TOOL = 'read_session';
const installed = new WeakSet<object>();

/**
 * Host-only adapter for Bubble 0.0.56's tool assembly seam. The SDK has no
 * public extraTools option; mcpToolsFor supplies entries before Agent is built.
 * Wrap this instance only, preserving its existing MCP discovery and cache.
 * No SDK file, environment variable or user configuration is changed.
 * The actual SDK catalog regression pins this internal seam; fail explicitly
 * if a future SDK removes it instead of sending a fictitious tool instruction.
 */
export function installBubbleSessionReader(instance: object): void {
  if (installed.has(instance)) return;
  const sdk = instance as { mcpToolsFor?: (cwd: string) => Promise<Array<{ name: string }>> };
  if (typeof sdk.mcpToolsFor !== 'function') {
    throw new Error('This Bubble SDK cannot register the Aegis conversation reader.');
  }
  const discover = sdk.mcpToolsFor.bind(instance);
  sdk.mcpToolsFor = async cwd => [
    ...(await discover(cwd)).filter(tool => tool.name !== BUBBLE_SESSION_TOOL),
    createNativeSessionReader(),
  ];
  installed.add(instance);
}

export function assertBubbleSessionReader(prompt: string | BubbleContentPart[], tools: string[], currentSessionId: string): void {
  const text = typeof prompt === 'string' ? prompt : prompt.filter(part => part.type === 'text').map(part => part.text || '').join('\n');
  if (extractSessionLinks(text).some(link => link.sessionId !== currentSessionId) && !tools.includes(BUBBLE_SESSION_TOOL)) {
    throw new Error('Conversation reader is unavailable in this Bubble runtime. Restart Aegis, then retry this message.');
  }
}
