// Loopback streamable-HTTP MCP transport for Browser Use (Codex parity).
//
// Non-Claude leads (codex/kimi/qoder/opencode/bubble/deepseek) run outside the
// in-process Claude SDK path and cannot reach the Electron main process over
// stdio, so the main process hosts
// the browser-use MCP server on 127.0.0.1 — the exact delegate-http-server
// pattern. Auth: per-run bearer token in process env; CLIs spawned by Aegis
// inherit it via bearer_token_env_var, a CLI running outside Aegis lacks both
// the live port and the token and fails fast.
//
// DeepSeek runtimes receive a random session capability in their generated
// MCP headers. Legacy providers without per-session configuration retain the
// pending-tool-call scan as a compatibility fallback.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
  BROWSER_USE_SERVER_NAME,
  finishBrowserUseTurn,
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
  getDeepseekGlobalMcpServers,
  saveDeepseekGlobalMcpServers,
} from './deepseek-mcp-settings';
import {
  findBrowserUseCallerSessionId,
  requestBrowserUseNavigationConsent,
} from './browser-use-consent';

export const BROWSER_USE_TOKEN_ENV_VAR = 'AEGIS_BROWSER_USE_TOKEN';
export const BROWSER_USE_SESSION_HEADER = 'x-aegis-browser-session';
const MCP_PATH = '/mcp';
const CODEX_TOOL_TIMEOUT_SEC = 5 * 60;
export const BROWSER_USE_MCP_TOOL_TIMEOUT_MS = 45_000;

export interface BrowserUseHttpServerInfo {
  url: string;
  port: number;
  token: string;
}

export interface BrowserUseSessionMcpDescriptor {
  url: string;
  headers: Record<string, string>;
  dispose: () => void;
}

let serverPromise: Promise<BrowserUseHttpServerInfo> | null = null;
let httpServer: HttpServer | null = null;
const sessionCapabilities = new Map<string, { sessionId: string; createdAt: number }>();

/** Current server descriptor for adapters that pass MCP entries per session
 * (grok ACP session/new). Null when not started / disabled. */
export function getBrowserUseMcpDescriptor(): { url: string; headers: Record<string, string> } | null {
  if (!isBrowserUseEnabled()) return null;
  const cached = serverInfoCache;
  if (!cached) return null;
  return { url: cached.url, headers: { Authorization: `Bearer ${cached.token}` } };
}

/** Create a non-model-visible capability that binds every request from one
 * provider runtime to exactly one Aegis session. */
export async function createBrowserUseSessionMcpDescriptor(
  sessionId: string
): Promise<BrowserUseSessionMcpDescriptor> {
  const info = await ensureBrowserUseHttpServer();
  const capability = randomUUID();
  sessionCapabilities.set(capability, { sessionId, createdAt: Date.now() });
  let disposed = false;
  return {
    url: info.url,
    headers: {
      Authorization: `Bearer ${info.token}`,
      [BROWSER_USE_SESSION_HEADER]: capability,
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      sessionCapabilities.delete(capability);
    },
  };
}

let serverInfoCache: BrowserUseHttpServerInfo | null = null;

/* eslint-disable @typescript-eslint/no-var-requires */
function loadMcpSdk(): {
  McpServer: new (info: { name: string; version: string }) => {
    registerTool: (
      name: string,
      config: { description: string; inputSchema: Record<string, unknown> },
      handler: (
        args: Record<string, unknown>,
        context?: { signal?: AbortSignal }
      ) => Promise<{
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
  'Aegis reveals the panel when available and keeps the same tab usable in the background.',
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

function mergeRequestSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function buildMcpServer(scopedSessionId: string | null, requestSignal: AbortSignal) {
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
    async (args, context) => {
      const startedAt = Date.now();
      const signal = mergeRequestSignals(requestSignal, context?.signal);
      // Scoped runtimes never consult transcripts. The scan remains only for
      // legacy providers whose MCP configuration is process-global.
      const sessionId = scopedSessionId ?? (await findBrowserUseCallerSessionId(args, signal));
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
      console.info('[browser-use]', {
        stage: 'attributed',
        sessionId,
        action: args.action,
        scoped: scopedSessionId !== null,
        elapsedMs: Date.now() - startedAt,
      });
      if (args.action === 'navigate' && typeof args.url === 'string' && args.url) {
        const allowed = await requestBrowserUseNavigationConsent(sessionId, args.url, signal);
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
      const result = await runBrowserUseAction(browserManager, input, { signal });
      console.info('[browser-use]', {
        stage: 'response',
        sessionId,
        action: input.action,
        ok: result.ok,
        elapsedMs: Date.now() - startedAt,
      });
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
  const capabilityHeader = req.headers[BROWSER_USE_SESSION_HEADER];
  const capability = Array.isArray(capabilityHeader) ? capabilityHeader[0] : capabilityHeader;
  let scopedSessionId: string | null = null;
  if (capability) {
    const binding = sessionCapabilities.get(capability);
    if (!binding) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Invalid or expired browser session capability' },
          id: null,
        })
      );
      return;
    }
    scopedSessionId = binding.sessionId;
  }
  const requestController = new AbortController();
  const onResponseClose = () => {
    if (!res.writableEnded) requestController.abort(new Error('MCP client disconnected.'));
  };
  const onRequestAborted = () => requestController.abort(new Error('MCP request aborted.'));
  res.once('close', onResponseClose);
  req.once('aborted', onRequestAborted);
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
  const server = buildMcpServer(scopedSessionId, requestController.signal);
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res);
  } finally {
    res.removeListener('close', onResponseClose);
    req.removeListener('aborted', onRequestAborted);
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
    if (process.env.AEGIS_BROWSER_USE_TEST_MODE !== '1') {
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
      // Bubble's config parser REQUIRES a type discriminator: no type + no
      // command falls to "unsupported transport type undefined" and the
      // entry is silently dropped (the `paper` entry has the same bug).
      bubble[BROWSER_USE_SERVER_NAME] = {
        type: 'http',
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
    // DeepSeek is intentionally absent here: its adapter injects a fresh,
    // session-scoped capability into the per-runtime temporary config. Writing
    // the app bearer token to its persistent global settings would defeat that
    // isolation and leave a secret behind after crashes.
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
  if (process.env.AEGIS_BROWSER_USE_TEST_MODE === '1') return;
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
  try {
    const deepseek = getDeepseekGlobalMcpServers();
    if (BROWSER_USE_SERVER_NAME in deepseek) {
      delete deepseek[BROWSER_USE_SERVER_NAME];
      saveDeepseekGlobalMcpServers(deepseek);
    }
  } catch (error) {
    console.warn('Failed to remove the deepseek browser-use MCP entry:', error);
  }
}

export function disposeBrowserUseHttpServer(): void {
  const boundSessionIds = new Set(
    [...sessionCapabilities.values()].map((binding) => binding.sessionId)
  );
  sessionCapabilities.clear();
  for (const sessionId of boundSessionIds) {
    finishBrowserUseTurn(browserManager, sessionId);
  }
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
