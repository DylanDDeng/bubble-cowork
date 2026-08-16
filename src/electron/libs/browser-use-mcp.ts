// Browser Use MCP wiring (Codex-parity, Phase 1).
//
// Exposes the browser-use service to Claude leads as an in-process SDK MCP
// server (the delegate-mcp pattern) with ONE tool whose actions map to the
// service primitives. Navigation consent rides the SAME permission pipeline
// every tool uses: the runner passes its onPermissionRequest hook in here, so
// the approval card the user already knows also guards agent navigation
// (Codex's "Allow browsing for {origin}" equivalent), with per-origin
// remember for the rest of the turn.

import {
  BROWSER_USE_SERVER_NAME,
  runBrowserUseAction,
  type BrowserUseActionInput,
  type BrowserUseActionResult,
} from './browser-use';
import { resolveBrowserUsePolicy } from './browser-use-permissions';
import type { BrowserManager } from '../browserManager';

export { BROWSER_USE_SERVER_NAME };

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

let sdkModule: ClaudeAgentSdkModule | null = null;

async function loadSdk(): Promise<ClaudeAgentSdkModule> {
  if (!sdkModule) {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<ClaudeAgentSdkModule>;
    sdkModule = await dynamicImport('@anthropic-ai/claude-agent-sdk');
  }
  return sdkModule;
}

type ZodModule = typeof import('zod');

let zodModule: ZodModule | null = null;

async function loadZod(): Promise<ZodModule> {
  if (!zodModule) {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<ZodModule>;
    zodModule = await dynamicImport('zod');
  }
  return zodModule;
}

const TOOL_NAME = 'browser_use';

const TOOL_DESCRIPTION = [
  'Drive the session browser panel to browse and interact with web pages.',
  'The panel opens automatically on first use and the user watches every action.',
  'Workflow: navigate,',
  'then snapshot to get interactive elements with stable node ids and viewport',
  'coordinates, then click/type/scroll by node id (preferred) or x/y, then',
  'read or snapshot again to verify. Take a fresh snapshot after any navigation',
  'or scroll — node ids are per-snapshot.',
].join(' ');

/** The runner's permission hook shape (same one canUseTool uses). */
export type BrowserUsePermissionHook = (
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>
) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;

/** Per-session origins the user already approved (turn-scoped memory). */
const approvedOrigins = new Map<string, Set<string>>();

export function rememberBrowserUseApproval(sessionId: string, origin: string): void {
  let set = approvedOrigins.get(sessionId);
  if (!set) {
    set = new Set();
    approvedOrigins.set(sessionId, set);
  }
  set.add(origin);
  if (approvedOrigins.size > 64) {
    const oldest = approvedOrigins.keys().next().value;
    if (oldest !== undefined && oldest !== sessionId) approvedOrigins.delete(oldest);
  }
}

export function forgetBrowserUseApprovals(sessionId: string): void {
  approvedOrigins.delete(sessionId);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Ask navigation consent: persisted policy first, then the permission card. */
async function askNavigationConsent(
  sessionId: string,
  url: string,
  askPermission: BrowserUsePermissionHook
): Promise<boolean> {
  const origin = originOf(url);
  if (!origin) return false;
  if (approvedOrigins.get(sessionId)?.has(origin)) return true;
  const policy = resolveBrowserUsePolicy(url);
  if (policy === 'allow') {
    rememberBrowserUseApproval(sessionId, origin);
    return true;
  }
  if (policy === 'block') return false;
  const toolUseId = `browser-use-nav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await askPermission(toolUseId, 'browser_use', {
    kind: 'browser-navigation',
    url,
    question: `Allow the agent to open ${origin} in the session browser?`,
  } as Record<string, unknown>);
  if (result.behavior === 'allow') {
    rememberBrowserUseApproval(sessionId, origin);
    return true;
  }
  return false;
}

function formatResult(result: BrowserUseActionResult): string {
  const parts = [result.message];
  if (result.text) {
    parts.push('\n--- page text ---\n' + result.text.slice(0, 12000));
  }
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

export async function createBrowserUseMcpServer(
  parentSessionId: string,
  manager: BrowserManager,
  askPermission: BrowserUsePermissionHook
) {
  const sdk = await loadSdk();
  const { z } = await loadZod();
  return sdk.createSdkMcpServer({
    name: BROWSER_USE_SERVER_NAME,
    version: '0.1.0',
    tools: [
      sdk.tool(
        TOOL_NAME,
        TOOL_DESCRIPTION,
        {
          action: z
            .enum(['navigate', 'snapshot', 'read', 'click', 'type', 'key', 'scroll'])
            .describe('What to do in the browser panel.'),
          url: z.string().optional().describe('Absolute URL (navigate only). The user approves new origins.'),
          x: z.number().optional().describe('Viewport x in CSS pixels (click/type/scroll).'),
          y: z.number().optional().describe('Viewport y in CSS pixels (click/type/scroll).'),
          node_id: z.number().optional().describe('Node id from the latest snapshot (click).'),
          snapshot_id: z.string().optional().describe('Snapshot id the node_id belongs to (click).'),
          text: z.string().optional().describe('Text to type (type only).'),
          key: z.string().optional().describe('Key to press: enter, tab, escape, backspace, arrow keys (key only).'),
          direction: z.enum(['up', 'down']).optional().describe('Scroll direction (scroll only).'),
          amount: z.number().optional().describe('Scroll pixels (scroll only, default 600).'),
        },
        async (args) => {
          if (args.action === 'navigate' && args.url) {
            const allowed = await askNavigationConsent(parentSessionId, args.url, askPermission);
            if (!allowed) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'The user declined to open this origin in the session browser.',
                  },
                ],
                isError: true,
              };
            }
          }
          const input: BrowserUseActionInput = {
            sessionId: parentSessionId,
            action: args.action,
            url: args.url,
            x: args.x,
            y: args.y,
            nodeId: args.node_id,
            snapshotId: args.snapshot_id,
            text: args.text,
            key: args.key,
            direction: args.direction,
            amount: args.amount,
          };
          const result = await runBrowserUseAction(manager, input);
          return {
            content: [{ type: 'text' as const, text: formatResult(result) }],
            ...(result.ok ? {} : { isError: true }),
          };
        }
      ),
    ],
  });
}
