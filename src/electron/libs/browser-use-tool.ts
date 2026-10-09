// The browser_use tool as agents see it: one schema, description and result
// formatting shared by Claude's in-process MCP server and the HTTP server the
// other providers reach, so both expose exactly the same actions.

import type { BrowserUseAction, BrowserUseActionInput, BrowserUseActionResult } from './browser-use';

export const BROWSER_USE_ACTIONS = [
  'navigate',
  'back',
  'forward',
  'screenshot',
  'snapshot',
  'read',
  'click',
  'hover',
  'type',
  'select',
  'key',
  'scroll',
  'wait',
  'tabs',
] as const satisfies readonly BrowserUseAction[];

export const BROWSER_USE_TOOL_DESCRIPTION = [
  "Drive the chat's in-app browser to browse and check web pages, including local dev servers.",
  'The user sees the same page in the browser panel.',
  'Workflow: navigate; screenshot to see the page; snapshot to get interactive elements with node ids;',
  'click/hover/type/select by node_id + snapshot_id (preferred) or by x/y; then screenshot or snapshot again to verify.',
  'x/y are viewport CSS pixels, the same coordinates as screenshot images and snapshot nodes.',
  'Take a fresh snapshot after navigation or scrolling — node ids belong to one snapshot.',
  'Use wait (with text) for content that appears after a delay.',
  "Actions act on the chat's main browser tab; tabs lists the others, and tab picks one.",
].join(' ');

type Zod = typeof import('zod')['z'];

/** The tool's input schema, built with whichever zod instance the server loaded. */
export function browserUseInputSchema(z: Zod) {
  return {
    action: z.enum(BROWSER_USE_ACTIONS).describe('What to do in the browser.'),
    tab: z
      .string()
      .optional()
      .describe("Browser tab to act on: 'main' (default) or an id from the tabs action."),
    url: z.string().optional().describe('Absolute http(s) URL (navigate only). The user approves new sites.'),
    x: z.number().optional().describe('Viewport x in CSS pixels (click/hover/type/scroll).'),
    y: z.number().optional().describe('Viewport y in CSS pixels (click/hover/type/scroll).'),
    node_id: z.number().optional().describe('Node id from the latest snapshot (click/hover/type/select/scroll).'),
    snapshot_id: z.string().optional().describe('Snapshot id the node_id belongs to.'),
    text: z.string().optional().describe('Text to type (type), or text to wait for (wait).'),
    clear: z.boolean().optional().describe('Replace the field contents instead of adding to them (type only).'),
    value: z.string().optional().describe('Option value or visible label to choose (select only).'),
    key: z
      .string()
      .optional()
      .describe('Key to press: enter, tab, escape, backspace, delete, space, arrow keys, home, end, pageup, pagedown (key only).'),
    direction: z.enum(['up', 'down']).optional().describe('Scroll direction (scroll only).'),
    amount: z.number().optional().describe('Scroll pixels (scroll, default 600) or milliseconds to wait (wait, default 1000).'),
    timeout_ms: z.number().optional().describe('How long wait looks for its text (default 5000, at most 20000).'),
  };
}

export interface BrowserUseToolArgs {
  action: BrowserUseAction;
  tab?: string;
  url?: string;
  x?: number;
  y?: number;
  node_id?: number;
  snapshot_id?: string;
  text?: string;
  clear?: boolean;
  value?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  timeout_ms?: number;
}

export function browserUseInputFromArgs(sessionId: string, args: BrowserUseToolArgs): BrowserUseActionInput {
  return {
    sessionId,
    action: args.action,
    tab: args.tab,
    url: args.url,
    x: args.x,
    y: args.y,
    nodeId: args.node_id,
    snapshotId: args.snapshot_id,
    text: args.text,
    clear: args.clear,
    value: args.value,
    key: args.key,
    direction: args.direction,
    amount: args.amount,
    timeoutMs: args.timeout_ms,
  };
}

export type BrowserUseToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function describeResult(result: BrowserUseActionResult): string {
  const parts = [result.message];
  if (result.tabs) {
    parts.push(
      '\n--- browser tabs ---\n' +
        result.tabs
          .map((tab) => `${tab.tab}${tab.current ? ' (acting on)' : ''}: ${tab.title ? `"${tab.title.slice(0, 80)}" ` : ''}${tab.url || '(no page)'}`)
          .join('\n')
    );
  }
  if (result.text) parts.push('\n--- page text ---\n' + result.text.slice(0, 12000));
  if (result.snapshot) {
    const nodes = result.snapshot.nodes
      .map(
        (n) =>
          `[${n.id}] ${n.role}${n.text ? ` "${n.text.slice(0, 80)}"` : ''} @(${n.x},${n.y})${n.href ? ` -> ${n.href.slice(0, 100)}` : ''}`
      )
      .join('\n');
    parts.push(
      `\n--- interactive elements (snapshot ${result.snapshot.snapshotId}) ---\n` +
        (nodes || '(none found)') +
        `\npage: ${result.snapshot.url}`
    );
  }
  return parts.join('\n');
}

/**
 * MCP content for a result. The screenshot is always saved to a file named in
 * the text; `inlineImage` also attaches it as an image block, for clients
 * known to pass MCP images to the model.
 */
export function browserUseResultContent(
  result: BrowserUseActionResult,
  options: { inlineImage: boolean }
): BrowserUseToolContent[] {
  const content: BrowserUseToolContent[] = [{ type: 'text', text: describeResult(result) }];
  const shot = result.screenshot;
  if (shot) {
    const scale =
      shot.scale === 1
        ? 'Image pixels are viewport CSS pixels, so x/y read off the image can be used directly.'
        : `The image is scaled by ${shot.scale}; divide image coordinates by ${shot.scale} to get viewport x/y.`;
    const where = options.inlineImage
      ? `Also saved to ${shot.path}.`
      : `Saved to ${shot.path}. Open that image file (for example with your image viewing or file reading tool) to see it.`;
    content[0] = {
      type: 'text',
      text: `${describeResult(result)}\nScreenshot ${shot.width}x${shot.height} of ${shot.url}. ${scale} ${where}`,
    };
    if (options.inlineImage) content.push({ type: 'image', data: shot.base64, mimeType: shot.mimeType });
  }
  return content;
}
