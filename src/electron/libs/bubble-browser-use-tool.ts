// Browser Use for Bubble as a turn-scoped host tool instead of an MCP server:
// bound to its Aegis session by closure (no global ~/.bubble/settings.json
// entry, no port or token), visible without tool_search, and its screenshots
// reach the model as images (Bubble's MCP bridge turns image blocks into text).

import { browserManager } from '../browserManager';
import { BROWSER_USE_SERVER_NAME, runBrowserUseAction } from './browser-use';
import { requestBrowserUseNavigationConsent } from './browser-use-consent';
import {
  BROWSER_USE_TOOL_DESCRIPTION,
  browserUseInputFromArgs,
  browserUseInputSchema,
  browserUseResultContent,
  type BrowserUseToolArgs,
} from './browser-use-tool';

/**
 * The name the MCP tool had, so approval rules, the workstream's "Browser"
 * label and older transcripts keep matching, and Aegis's Bubble patch lets
 * this host tool shadow a stale MCP entry of the same name.
 */
export const BUBBLE_BROWSER_USE_TOOL = `mcp__${BROWSER_USE_SERVER_NAME}__browser_use`;

let parameters: Record<string, unknown> | null = null;

/** The shared browser_use schema as JSON Schema, which Bubble host tools take. */
function browserUseJsonSchema(): Record<string, unknown> {
  if (!parameters) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { z } = require('zod') as typeof import('zod');
    const { $schema: _dialect, ...schema } = z.toJSONSchema(z.object(browserUseInputSchema(z))) as Record<string, unknown>;
    parameters = schema;
  }
  return parameters;
}

type BubbleImage = { mimeType: 'image/png' | 'image/jpeg'; data: string };

export function createBubbleBrowserUseTool(sessionId: string) {
  return {
    name: BUBBLE_BROWSER_USE_TOOL,
    description: BROWSER_USE_TOOL_DESCRIPTION,
    parameters: browserUseJsonSchema(),
    // An action on the user's browser: approval-gated like the MCP tool was,
    // and unavailable in Plan mode.
    readOnly: false,
    effect: 'unknown' as const,
    requiresApproval: true,
    async execute(args: BrowserUseToolArgs, ctx?: { abortSignal?: AbortSignal }) {
      const signal = ctx?.abortSignal;
      try {
        if (args.action === 'navigate' && args.url && !(await requestBrowserUseNavigationConsent(sessionId, args.url, signal))) {
          return { content: 'The user declined to open this origin in the session browser.', isError: true };
        }
        const result = await runBrowserUseAction(browserManager, browserUseInputFromArgs(sessionId, args), { signal });
        const content = browserUseResultContent(result, { inlineImage: true });
        const text = content.map((part) => (part.type === 'text' ? part.text : '')).join('\n').trim();
        const images: BubbleImage[] = content.flatMap((part) =>
          part.type === 'image' ? [{ mimeType: part.mimeType as BubbleImage['mimeType'], data: part.data }] : []
        );
        return { content: text, ...(images.length ? { images } : {}), isError: !result.ok };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };
}
