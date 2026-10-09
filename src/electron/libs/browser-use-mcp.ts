// Browser Use MCP wiring (Codex-parity, Phase 1).
//
// Exposes the browser-use service to Claude leads as an in-process SDK MCP
// server (the delegate-mcp pattern) with ONE tool whose actions map to the
// service primitives. Navigation consent rides the SAME permission pipeline
// every tool uses: the runner passes its onPermissionRequest hook in here, so
// the approval card the user already knows also guards agent navigation
// (Codex's "Allow browsing for {origin}" equivalent), with per-origin
// remember for the rest of the session (shared with the HTTP path).

import { BROWSER_USE_SERVER_NAME, runBrowserUseAction } from './browser-use';
import {
  BROWSER_USE_TOOL_DESCRIPTION,
  browserUseInputFromArgs,
  browserUseInputSchema,
  browserUseResultContent,
} from './browser-use-tool';
import {
  browserUseOriginOf,
  decideBrowserUseNavigation,
  rememberBrowserUseApproval,
} from './browser-use-consent';
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

/** The runner's permission hook shape (same one canUseTool uses). */
export type BrowserUsePermissionHook = (
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>
) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;

/** Ask navigation consent: the shared decision first (the same rules the
 * HTTP path uses), then the runner's permission card. */
async function askNavigationConsent(
  sessionId: string,
  url: string,
  askPermission: BrowserUsePermissionHook
): Promise<boolean> {
  const decision = decideBrowserUseNavigation(sessionId, url);
  if (decision !== 'ask') return decision === 'allow';
  const origin = browserUseOriginOf(url);
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

/** The two SDK calls an in-process MCP server needs. */
export type BrowserUseSdkMcpModule = Pick<ClaudeAgentSdkModule, 'createSdkMcpServer' | 'tool'>;

function buildBrowserUseSdkServer(
  sdk: BrowserUseSdkMcpModule,
  z: ZodModule['z'],
  sessionId: string,
  manager: BrowserManager,
  allowNavigation: (url: string) => Promise<boolean>
) {
  return sdk.createSdkMcpServer({
    name: BROWSER_USE_SERVER_NAME,
    version: '0.1.0',
    tools: [
      sdk.tool(TOOL_NAME, BROWSER_USE_TOOL_DESCRIPTION, browserUseInputSchema(z), async (args) => {
        if (args.action === 'navigate' && args.url && !(await allowNavigation(args.url))) {
          return {
            content: [{ type: 'text' as const, text: 'The user declined to open this origin in the session browser.' }],
            isError: true,
          };
        }
        const result = await runBrowserUseAction(manager, browserUseInputFromArgs(sessionId, args));
        return {
          // Both SDKs hand MCP image blocks to the model, so screenshots go inline.
          content: browserUseResultContent(result, { inlineImage: true }),
          ...(result.ok ? {} : { isError: true }),
        };
      }),
    ],
  });
}

/** Claude: consent goes through the runner's own permission hook. */
export async function createBrowserUseMcpServer(
  parentSessionId: string,
  manager: BrowserManager,
  askPermission: BrowserUsePermissionHook
) {
  const sdk = await loadSdk();
  const { z } = await loadZod();
  return buildBrowserUseSdkServer(sdk, z, parentSessionId, manager, (url) =>
    askNavigationConsent(parentSessionId, url, askPermission)
  );
}
