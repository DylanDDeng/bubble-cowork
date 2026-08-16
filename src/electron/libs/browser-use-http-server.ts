// Loopback streamable-HTTP MCP transport for Browser Use (Codex parity).
//
// Non-Claude leads (codex/kimi/qoder/opencode) are singleton CLI daemons that
// cannot reach the Electron main process over stdio, so the main process hosts
// the browser-use MCP server on 127.0.0.1 — the exact delegate-http-server
// pattern. Auth: per-run bearer token in process env; CLIs spawned by Aegis
// inherit it via bearer_token_env_var, a CLI running outside Aegis lacks both
// the live port and the token and fails fast.
//
// Caller attribution: an HTTP call carries no session identity, so actions
// resolve the calling session by the delegate-service pending-tool-call scan
// (tool name + arguments against running sessions' in-flight tool_use blocks).

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
  BROWSER_USE_SERVER_NAME,
  runBrowserUseAction,
  type BrowserUseActionInput,
  type BrowserUseActionResult,
} from './browser-use';
import { isBrowserUseEnabled } from './browser-use-permissions';
import { browserManager } from '../browserManager';
import { upsertCodexMcpServer, getCodexMcpServers, saveCodexMcpServers } from './codex-mcp-settings';
import {
  upsertKimiMcpServerRaw,
  getKimiMcpServers,
  saveKimiMcpServers,
} from './kimi-mcp-settings';
import { getBubbleMcpServers, saveBubbleMcpServers } from './bubble-mcp-settings';
import { getQoderMcpServers, saveQoderMcpServers } from './qoder-mcp-settings';
import {
  getOpencodeMcpServers,
  saveOpencodeMcpServers,
} from './opencode-mcp-settings';
import {
  findBrowserUseCallerSessionId,
  requestBrowserUseNavigationConsent,
} from './browser-use-consent';

export const BROWSER_USE_TOKEN_ENV_VAR = 'AEGIS_BROWSER_USE_TOKEN';
const MCP_PATH = '/mcp';
const CODEX_TOOL_TIMEOUT_SEC = 5 * 60;

export interface BrowserUseHttpServerInfo {
  url: string;
  port: number;
  token: string;
}

let serverPromise: Promise<BrowserUseHttpServerInfo> | null = null;
let httpServer: HttpServer | null = null;

/** Current server descriptor for adapters that pass MCP entries per session
 * (grok ACP session/new). Null when not started / disabled. */
export function getBrowserUseMcpDescriptor(): { url: string; headers: Record<string, string> } | null {
  if (!isBrowserUseEnabled()) return null;
  const cached = serverInfoCache;
  if (!cached) return null;
  return { url: cached.url, headers: { Authorization: `Bearer ${cached.token}` } };
}

let serverInfoCache: BrowserUseHttpServerInfo | null = null;

/* eslint-disable @typescript-eslint/no-var-requires */
function loadMcpSdk(): {
  McpServer: new (info: { name: string; version: string }) => {
    registerTool: (
      name: string,
      config: { description: string; inputSchema: Record<string, unknown> },
      handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
      }>
    ) => void;
    connect: (transport: unknown) => Promise<void>;
    close: () => Promise<void>;
  };
  StreamableHTTPServerTransport: new (options: {
    sessionIdGenerator: undefined;
    enableJsonResponse?: boolean;
  }) => {
    handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    close: () => Promise<void>;
  };
} {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  return { McpServer, StreamableHTTPServerTransport };
}

function loadZod(): typeof import('zod') {
  return require('zod');
}
/* eslint-enable @typescript-eslint/no-var-requires */

const TOOL_NAME = 'browser_use';

const TOOL_DESCRIPTION = [
  'Drive the Aegis session browser panel to browse and interact with web pages.',
  'The panel opens automatically on first use; the user watches every action.',
  'Workflow: navigate (the user approves new origins), then snapshot to get',
  'interactive elements with stable node ids and viewport coordinates, then',
  'click/type/scroll by node id (preferred) or x/y, then read or snapshot again',
  'to verify. Take a fresh snapshot after any navigation or scroll — node ids',
  'are per-snapshot.',
].join(' ');

function formatResult(result: BrowserUseActionResult): string {
  const parts = [result.message];
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

function buildMcpServer() {
  const { McpServer } = loadMcpSdk();
  const { z } = loadZod();
  const server = new McpServer({ name: BROWSER_USE_SERVER_NAME, version: '0.1.0' });
  server.registerTool(
    TOOL_NAME,
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
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
    },
    async (args) => {
      // HTTP calls carry no session identity: resolve the caller by matching
      // this tool call against running sessions' pending browser_use blocks.
      const sessionId = await findBrowserUseCallerSessionId(args);
      if (!sessionId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No Aegis session has this browser_use call in flight — cannot attribute the action to a session browser panel.',
            },
          ],
          isError: true,
        };
      }
      if (args.action === 'navigate' && typeof args.url === 'string' && args.url) {
        const allowed = await requestBrowserUseNavigationConsent(sessionId, args.url);
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
      const typedArgs = args as unknown as {
        action: BrowserUseActionInput['action'];
        url?: string;
        x?: number;
        y?: number;
        node_id?: number;
        snapshot_id?: string;
        text?: string;
        key?: string;
        direction?: 'up' | 'down';
        amount?: number;
      };
      const input: BrowserUseActionInput = {
        sessionId,
        action: typedArgs.action,
        url: typedArgs.url,
        x: typedArgs.x,
        y: typedArgs.y,
        nodeId: typedArgs.node_id,
        snapshotId: typedArgs.snapshot_id,
        text: typedArgs.text,
        key: typedArgs.key,
        direction: typedArgs.direction,
        amount: typedArgs.amount,
      };
      const result = await runBrowserUseAction(browserManager, input);
      return {
        content: [{ type: 'text' as const, text: formatResult(result) }],
        ...(result.ok ? {} : { isError: true }),
      };
    }
  );
  return server;
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, token: string) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      })
    );
    return;
  }
  // Path allow-list (delegate-http-server parity): only /mcp is served, so
  // the port does not answer MCP on arbitrary paths.
  const requestUrl = req.url || '';
  if (requestUrl.split('?')[0] !== MCP_PATH) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Not Found' },
        id: null,
      })
    );
    return;
  }
  if (req.method === 'GET') {
    // Streamable HTTP: GET opens the SSE stream we don't use; 405 is the
    // spec-sanctioned response for servers without it.
    res.writeHead(405).end();
    return;
  }
  const transport = loadMcpSdk().StreamableHTTPServerTransport
    ? new (loadMcpSdk().StreamableHTTPServerTransport)({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
    : null;
  if (!transport) {
    res.writeHead(500).end();
    return;
  }
  const server = buildMcpServer();
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res);
  } finally {
    await server.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

export function ensureBrowserUseHttpServer(): Promise<BrowserUseHttpServerInfo> {
  if (!isBrowserUseEnabled()) {
    // Disabled: make sure nothing lingers in provider configs.
    removeBrowserUseMcpEntries();
    return Promise.reject(new Error('Browser Use is disabled in settings.'));
  }
  if (serverPromise) return serverPromise;
  serverPromise = (async () => {
    const token = process.env[BROWSER_USE_TOKEN_ENV_VAR] || randomUUID();
    const server = createServer((req, res) => {
      handleMcpRequest(req, res, token).catch((error) => {
        console.warn('Browser-use MCP HTTP request failed:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal error' },
              id: null,
            })
          );
        } else {
          res.end();
        }
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Failed to resolve browser-use MCP server port'));
      });
    });
    server.unref();
    httpServer = server;
    process.env[BROWSER_USE_TOKEN_ENV_VAR] = token;
    const info: BrowserUseHttpServerInfo = {
      url: `http://127.0.0.1:${port}${MCP_PATH}`,
      port,
      token,
    };
    try {
      upsertCodexMcpServer(
        BROWSER_USE_SERVER_NAME,
        { type: 'http', url: info.url },
        [
          `bearer_token_env_var = "${BROWSER_USE_TOKEN_ENV_VAR}"`,
          `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
        ]
      );
    } catch (error) {
      console.warn('Failed to write the codex browser-use MCP entry:', error);
    }
    try {
      upsertKimiMcpServerRaw(BROWSER_USE_SERVER_NAME, {
        url: info.url,
        headers: { Authorization: `Bearer ${info.token}` },
        toolTimeoutMs: CODEX_TOOL_TIMEOUT_SEC * 1000,
      });
    } catch (error) {
      console.warn('Failed to write the kimi browser-use MCP entry:', error);
    }
    try {
      const bubble = getBubbleMcpServers();
      bubble[BROWSER_USE_SERVER_NAME] = {
        url: info.url,
        headers: { Authorization: `Bearer ${info.token}` },
      } as never;
      saveBubbleMcpServers(bubble);
    } catch (error) {
      console.warn('Failed to write the bubble browser-use MCP entry:', error);
    }
    try {
      const qoder = getQoderMcpServers();
      qoder[BROWSER_USE_SERVER_NAME] = {
        url: info.url,
        headers: { Authorization: `Bearer ${info.token}` },
      } as never;
      saveQoderMcpServers(qoder);
    } catch (error) {
      console.warn('Failed to write the qoder browser-use MCP entry:', error);
    }
    try {
      const opencode = getOpencodeMcpServers();
      (opencode as Record<string, unknown>)[BROWSER_USE_SERVER_NAME] = {
        type: 'remote',
        url: info.url,
        enabled: true,
        headers: { Authorization: `Bearer ${info.token}` },
      };
      saveOpencodeMcpServers(opencode);
    } catch (error) {
      console.warn('Failed to write the opencode browser-use MCP entry:', error);
    }
    serverInfoCache = info;
    return info;
  })();
  serverPromise.catch(() => {
    serverPromise = null;
  });
  return serverPromise;
}

/** Remove the browser-use entry from every provider config (toggle-off,
 * and disabled boot). Idempotent. */
export function removeBrowserUseMcpEntries(): void {
  try {
    const codex = getCodexMcpServers();
    if (BROWSER_USE_SERVER_NAME in codex) {
      delete codex[BROWSER_USE_SERVER_NAME];
      saveCodexMcpServers(codex);
    }
  } catch (error) {
    console.warn('Failed to remove the codex browser-use MCP entry:', error);
  }
  try {
    const kimi = getKimiMcpServers();
    if (BROWSER_USE_SERVER_NAME in kimi) {
      delete kimi[BROWSER_USE_SERVER_NAME];
      saveKimiMcpServers(kimi);
    }
  } catch (error) {
    console.warn('Failed to remove the kimi browser-use MCP entry:', error);
  }
  try {
    const bubble = getBubbleMcpServers();
    if (BROWSER_USE_SERVER_NAME in bubble) {
      delete bubble[BROWSER_USE_SERVER_NAME];
      saveBubbleMcpServers(bubble);
    }
  } catch (error) {
    console.warn('Failed to remove the bubble browser-use MCP entry:', error);
  }
  try {
    const qoder = getQoderMcpServers();
    if (BROWSER_USE_SERVER_NAME in qoder) {
      delete qoder[BROWSER_USE_SERVER_NAME];
      saveQoderMcpServers(qoder);
    }
  } catch (error) {
    console.warn('Failed to remove the qoder browser-use MCP entry:', error);
  }
  try {
    const opencode = getOpencodeMcpServers();
    if (BROWSER_USE_SERVER_NAME in opencode) {
      delete opencode[BROWSER_USE_SERVER_NAME];
      saveOpencodeMcpServers(opencode);
    }
  } catch (error) {
    console.warn('Failed to remove the opencode browser-use MCP entry:', error);
  }
}

export function disposeBrowserUseHttpServer(): void {
  serverInfoCache = null;
  removeBrowserUseMcpEntries();
  if (httpServer) {
    try {
      httpServer.close();
    } catch {
      // ignore
    }
    httpServer = null;
  }
  serverPromise = null;
}
