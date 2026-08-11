// Loopback streamable-HTTP MCP transport for the delegate server
// (docs/delegate-mcp-plan.md). Non-Claude leads (v1: codex) are singleton CLI
// daemons that cannot reach into the Electron main process over stdio, so the
// main process hosts the MCP server on 127.0.0.1 and writes the endpoint into
// the CLI's global config. Auth: per-run bearer token, exported as
// AEGIS_DELEGATE_TOKEN into this process's env — CLIs spawned by Aegis
// inherit it (config references it via bearer_token_env_var), while a CLI
// running outside Aegis lacks both a live port and the token and fails fast.
//
// Caller attribution is delegate-service's pending-tool-call scan: an HTTP
// call carries no session identity, so `runDelegateTask` matches (tool name +
// arguments) against pending delegate tool_use blocks of running sessions.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
  DELEGATE_MCP_SERVER_NAME,
  DELEGATE_TARGET_PROVIDERS,
  DELEGATE_TOOL_NAME,
  getDelegateStatus,
  runDelegateTask,
} from './delegate-service';
import { upsertCodexMcpServer } from './codex-mcp-settings';
import { upsertKimiMcpServerRaw } from './kimi-mcp-settings';

export const DELEGATE_TOKEN_ENV_VAR = 'AEGIS_DELEGATE_TOKEN';
const MCP_PATH = '/mcp';
// Keep the CLI-side tool timeout above the delegate's own 30-minute ceiling
// so Aegis, not the CLI, decides when a delegation is overdue.
const CODEX_TOOL_TIMEOUT_SEC = 35 * 60;

export interface DelegateHttpServerInfo {
  url: string;
  port: number;
  token: string;
}

let serverPromise: Promise<DelegateHttpServerInfo> | null = null;
let httpServer: HttpServer | null = null;

// The SDK ships a CJS build, but the electron tsconfig uses node10 module
// resolution which cannot see the exports map — require at runtime instead.
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

const DELEGATE_TOOL_DESCRIPTION = [
  'Delegate a self-contained task to a different coding agent and wait for its result.',
  'The delegated agent runs in this project with the same permission mode as the current session;',
  'its full trace is visible to the user in a side panel. Use for hand-offs the user asked for',
  '(e.g. "have claude review this") or when a second, independent perspective is genuinely useful.',
  'The call blocks until the delegated agent finishes and returns its final answer plus the list',
  'of files it changed. If the result instead says the delegation is still running, it includes a',
  'handle — poll delegate_status with that handle until it completes; do NOT retry delegate_task.',
  'Delegated agents cannot delegate further.',
].join(' ');

function buildMcpServer() {
  const { McpServer } = loadMcpSdk();
  const { z } = loadZod();
  const server = new McpServer({ name: DELEGATE_MCP_SERVER_NAME, version: '0.1.0' });
  server.registerTool(
    DELEGATE_TOOL_NAME,
    {
      description: DELEGATE_TOOL_DESCRIPTION,
      inputSchema: {
        agent: z
          .enum(DELEGATE_TARGET_PROVIDERS as [string, ...string[]])
          .describe('Which agent to delegate to.'),
        prompt: z
          .string()
          .describe(
            'Complete, self-contained instructions for the delegated agent. It sees none of this conversation — include all context it needs.'
          ),
        description: z
          .string()
          .optional()
          .describe('Short (3-6 word) task label shown to the user.'),
        model: z
          .string()
          .optional()
          .describe(
            "Model for the delegated agent. Pass the user's wording as-is (e.g. 'kimi code k3', 'gpt 5.6 sol') — it is fuzzily resolved against that agent's installed model catalog, and unresolvable values fail fast with the list of valid ids. Omit unless the user named a model."
          ),
        reasoning_effort: z
          .string()
          .optional()
          .describe(
            "Reasoning effort tier for the delegated agent (e.g. low/medium/high; the valid set is per agent/model). Omit to use the agent's default."
          ),
      },
    },
    async (args: Record<string, unknown>) => {
      const result = await runDelegateTask({
        agent: String(args.agent ?? ''),
        prompt: String(args.prompt ?? ''),
        description: typeof args.description === 'string' ? args.description : undefined,
        model: typeof args.model === 'string' ? args.model : undefined,
        reasoningEffort: typeof args.reasoning_effort === 'string' ? args.reasoning_effort : undefined,
        callerSessionId: null,
      });
      return {
        content: [{ type: 'text' as const, text: result.summary }],
        ...(result.ok ? {} : { isError: true }),
      };
    }
  );
  server.registerTool(
    'delegate_status',
    {
      description:
        'Check on a delegation that delegate_task reported as still running. Returns the final answer once the delegated agent completes; otherwise reports elapsed time — poll again in 30-60 seconds.',
      inputSchema: {
        handle: z.string().describe('The handle from the delegate_task "still running" result.'),
      },
    },
    async (args: Record<string, unknown>) => {
      const result = getDelegateStatus(String(args.handle ?? ''));
      return {
        content: [{ type: 'text' as const, text: result.summary }],
        ...(result.ok ? {} : { isError: true }),
      };
    }
  );
  return server;
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${token}`;
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string
): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }
  if (!isAuthorized(req, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      })
    );
    return;
  }
  // Stateless mode: a fresh server+transport pair per request. Delegate calls
  // are rare and long-lived; per-request setup cost is irrelevant, and no
  // session bookkeeping can leak.
  const { StreamableHTTPServerTransport } = loadMcpSdk();
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function ensureDelegateHttpServer(): Promise<DelegateHttpServerInfo> {
  if (serverPromise) return serverPromise;
  serverPromise = (async () => {
    const token = process.env[DELEGATE_TOKEN_ENV_VAR] || randomUUID();
    const server = createServer((req, res) => {
      handleMcpRequest(req, res, token).catch((error) => {
        console.warn('Delegate MCP HTTP request failed:', error);
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
        else reject(new Error('Failed to resolve delegate MCP server port'));
      });
    });
    server.unref();
    httpServer = server;
    // Make the token visible to CLIs spawned from this process (codex config
    // references it via bearer_token_env_var).
    process.env[DELEGATE_TOKEN_ENV_VAR] = token;
    const info: DelegateHttpServerInfo = {
      url: `http://127.0.0.1:${port}${MCP_PATH}`,
      port,
      token,
    };
    try {
      writeCodexDelegateEntry(info);
    } catch (error) {
      console.warn('Failed to write the codex delegate MCP entry:', error);
    }
    try {
      writeKimiDelegateEntry(info);
    } catch (error) {
      console.warn('Failed to write the kimi delegate MCP entry:', error);
    }
    return info;
  })();
  serverPromise.catch(() => {
    serverPromise = null;
  });
  return serverPromise;
}

/** Refresh ~/.codex/config.toml with this run's endpoint (port is ephemeral). */
export function writeCodexDelegateEntry(info: DelegateHttpServerInfo): void {
  upsertCodexMcpServer(
    DELEGATE_MCP_SERVER_NAME,
    { type: 'http', url: info.url },
    [
      `bearer_token_env_var = "${DELEGATE_TOKEN_ENV_VAR}"`,
      `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    ]
  );
}

/**
 * Refresh ~/.kimi/mcp.json so kimi sessions can be delegation leads too.
 * Kimi's MCP config has no env-var indirection for auth — the header carries
 * the literal per-run token; the entry is rewritten on every launch anyway
 * (the port is ephemeral), and a stale entry outside a live Aegis fails fast.
 */
export function writeKimiDelegateEntry(info: DelegateHttpServerInfo): void {
  upsertKimiMcpServerRaw(DELEGATE_MCP_SERVER_NAME, {
    url: info.url,
    headers: { Authorization: `Bearer ${info.token}` },
  });
}

export function disposeDelegateHttpServer(): void {
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
