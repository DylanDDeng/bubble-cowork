import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import type { TerminalEvent, TerminalTransportInfo } from '../../shared/terminal';
import {
  DEFAULT_TERMINAL_ID,
  validateTerminalClearInput,
  validateTerminalCloseInput,
  validateTerminalOpenInput,
  validateTerminalResizeInput,
  validateTerminalRestartInput,
  validateTerminalWriteInput,
} from '../../shared/terminal';
import { subscribeTerminalEvents, terminalManager } from './terminal-runtime';

const MAX_JSON_BODY_BYTES = 1024 * 1024;

type SseClient = {
  id: string;
  res: ServerResponse;
  close: () => void;
};

let server: Server | null = null;
let serverInfo: Required<Pick<TerminalTransportInfo, 'url' | 'token'>> | null = null;
const sseClients = new Map<string, SseClient>();

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  });
  res.end();
}

function getRequestToken(req: IncomingMessage, url: URL, body?: Record<string, unknown>): string | null {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim() || null;
  }
  const queryToken = url.searchParams.get('token')?.trim();
  if (queryToken) return queryToken;
  const bodyToken = typeof body?.token === 'string' ? body.token.trim() : '';
  return bodyToken || null;
}

function isAuthorized(req: IncomingMessage, url: URL, body?: Record<string, unknown>): boolean {
  return Boolean(serverInfo?.token && getRequestToken(req, url, body) === serverInfo.token);
}

function parseBodyAsJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('Request body is not valid JSON.'));
      }
    });

    req.on('error', reject);
  });
}

function normalizeLegacyBody(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.sessionId !== 'string') return body;
  return {
    ...body,
    threadId: body.threadId || body.sessionId,
    terminalId: body.terminalId || DEFAULT_TERMINAL_ID,
  };
}

function emitSseEvent(payload: TerminalEvent): void {
  const data = JSON.stringify(payload);
  for (const client of sseClients.values()) {
    client.res.write(`event: terminal\n`);
    client.res.write(`data: ${data}\n\n`);
  }
}

subscribeTerminalEvents(emitSseEvent);

async function handlePost(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await parseBodyAsJson(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (!isAuthorized(req, url, body)) {
    sendJson(res, 401, { ok: false, message: 'Unauthorized terminal transport request.' });
    return;
  }

  const normalized = normalizeLegacyBody(body);

  if (url.pathname === '/terminal/open' || url.pathname === '/terminal/start') {
    const input = validateTerminalOpenInput(normalized);
    if (!input.ok) {
      sendJson(res, 400, { ok: false, message: input.message });
      return;
    }
    sendJson(res, 200, await terminalManager.open(input.value));
    return;
  }

  if (url.pathname === '/terminal/write') {
    const input = validateTerminalWriteInput(normalized);
    if (!input.ok) {
      sendJson(res, 400, { ok: false, message: input.message });
      return;
    }
    sendJson(res, 200, terminalManager.write(input.value));
    return;
  }

  if (url.pathname === '/terminal/resize') {
    const input = validateTerminalResizeInput(normalized);
    if (!input.ok) {
      sendJson(res, 400, { ok: false, message: input.message });
      return;
    }
    sendJson(res, 200, terminalManager.resize(input.value));
    return;
  }

  if (url.pathname === '/terminal/clear') {
    const input = validateTerminalClearInput(normalized);
    if (!input.ok) {
      sendJson(res, 400, { ok: false, message: input.message });
      return;
    }
    sendJson(res, 200, terminalManager.clear(input.value));
    return;
  }

  if (url.pathname === '/terminal/restart') {
    const input = validateTerminalRestartInput(normalized);
    if (!input.ok) {
      sendJson(res, 400, { ok: false, message: input.message });
      return;
    }
    sendJson(res, 200, await terminalManager.restart(input.value));
    return;
  }

  if (url.pathname === '/terminal/close' || url.pathname === '/terminal/stop') {
    const input = validateTerminalCloseInput(normalized);
    if (!input.ok) {
      sendJson(res, 400, { ok: false, message: input.message });
      return;
    }
    sendJson(res, 200, terminalManager.close(input.value));
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Unknown terminal transport endpoint.' });
}

function handleEvents(url: URL, req: IncomingMessage, res: ServerResponse): void {
  if (!isAuthorized(req, url)) {
    sendJson(res, 401, { ok: false, message: 'Unauthorized terminal transport request.' });
    return;
  }

  const id = randomUUID();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true}\n\n`);

  const pingTimer = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${Date.now()}\n\n`);
  }, 30000);

  const close = () => {
    clearInterval(pingTimer);
    sseClients.delete(id);
  };
  sseClients.set(id, { id, res, close });
  req.on('close', close);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'OPTIONS') {
    sendNoContent(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/terminal/events') {
    handleEvents(url, req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/terminal/health') {
    if (!isAuthorized(req, url)) {
      sendJson(res, 401, { ok: false, message: 'Unauthorized terminal transport request.' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST') {
    void handlePost(url, req, res);
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Unknown terminal transport endpoint.' });
}

export async function ensureTerminalTransportServer(): Promise<TerminalTransportInfo> {
  if (server && serverInfo) {
    return { ok: true, ...serverInfo };
  }

  const token = randomUUID();
  const nextServer = createServer(handleRequest);
  const port = await new Promise<number>((resolve, reject) => {
    const handleError = (error: Error) => {
      nextServer.removeListener('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      nextServer.removeListener('error', handleError);
      const address = nextServer.address() as AddressInfo | null;
      if (!address || typeof address.port !== 'number') {
        reject(new Error('Failed to determine terminal transport port.'));
        return;
      }
      resolve(address.port);
    };

    nextServer.once('error', handleError);
    nextServer.once('listening', handleListening);
    nextServer.listen(0, '127.0.0.1');
  });

  nextServer.unref();
  nextServer.once('close', () => {
    if (server === nextServer) {
      server = null;
      serverInfo = null;
    }
  });

  server = nextServer;
  serverInfo = {
    url: `http://127.0.0.1:${port}`,
    token,
  };
  return { ok: true, ...serverInfo };
}

export function disposeTerminalTransportServer(): void {
  for (const client of sseClients.values()) {
    client.close();
    client.res.end();
  }
  sseClients.clear();

  if (server) {
    server.close();
    server = null;
  }
  serverInfo = null;
}
