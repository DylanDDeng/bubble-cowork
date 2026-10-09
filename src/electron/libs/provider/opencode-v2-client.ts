/**
 * Minimal client for the OpenCode 2.x server API (`/api/*`, HTTP Basic auth).
 * Covers only the routes the OpenCode adapter uses; request and payload shapes
 * follow @opencode/client 2.0.23's generated client. We don't depend on that
 * package: it pulls in an Effect release candidate and is published as a
 * private generation target.
 */

export type OpenCodeModelRef = { id: string; providerID: string; variant?: string };
export type OpenCodePermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' };
export type OpenCodePermissionDecision = 'once' | 'always' | 'reject';
export type OpenCodeTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type OpenCodeSessionInfo = {
  id: string;
  agent?: string;
  model?: OpenCodeModelRef;
  permissions?: OpenCodePermissionRule[];
  [key: string]: unknown;
};

export type OpenCodeModelInfo = {
  modelID: string;
  providerID: string;
  enabled?: boolean;
  limit?: { context?: number; output?: number };
};

export type OpenCodeServerEvent = {
  id?: string;
  type: string;
  location?: { directory?: string };
  data?: Record<string, unknown>;
};

export type OpenCodePromptFile = { uri: string; name?: string };

export class OpenCodeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly tag?: string
  ) {
    super(message);
    this.name = 'OpenCodeApiError';
  }
}

type Query = Record<string, unknown>;

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return;
  if (value === null) {
    params.append(key, 'null');
  } else if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item);
  } else if (typeof value === 'object') {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item);
  } else {
    params.append(key, String(value));
  }
}

function locationQuery(directory: string): Query {
  return { location: { directory } };
}

function listData<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const enc = encodeURIComponent;

export class OpenCodeV2Client {
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly baseUrl: string,
    password: string,
    fetchImpl: typeof fetch = globalThis.fetch
  ) {
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    this.fetchImpl = fetchImpl;
  }

  private url(path: string, query?: Query): URL {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) appendQuery(url.searchParams, key, value);
    return url;
  }

  async request<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; signal?: AbortSignal } = {}
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: this.authorization, accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(this.url(path, options.query), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      let tag: string | undefined;
      let message = `OpenCode ${method} ${path} failed with ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { _tag?: unknown; message?: unknown };
        tag = typeof parsed._tag === 'string' ? parsed._tag : undefined;
        if (typeof parsed.message === 'string' && parsed.message) message = parsed.message;
      } catch {
        // Non-JSON error body: keep the status message.
      }
      throw new OpenCodeApiError(message, response.status, tag);
    }
    if (!text) return undefined as T;
    // Responses wrap their payload as { data } (lists also carry the location).
    const parsed = JSON.parse(text) as unknown;
    return (parsed && typeof parsed === 'object' && 'data' in parsed ? (parsed as { data: unknown }).data : parsed) as T;
  }

  info(): Promise<{ version: string; pid: number }> {
    return this.request('GET', '/api/info');
  }

  createSession(input: {
    directory: string;
    agent?: string;
    model?: OpenCodeModelRef;
    permissions?: OpenCodePermissionRule[];
  }): Promise<OpenCodeSessionInfo> {
    return this.request('POST', '/api/session', {
      body: {
        location: { directory: input.directory },
        agent: input.agent,
        model: input.model,
        permissions: input.permissions,
      },
    });
  }

  getSession(sessionID: string): Promise<OpenCodeSessionInfo> {
    return this.request('GET', `/api/session/${enc(sessionID)}`);
  }

  updateSession(sessionID: string, input: { permissions?: OpenCodePermissionRule[] }): Promise<void> {
    return this.request('PATCH', `/api/session/${enc(sessionID)}`, { body: input });
  }

  switchModel(sessionID: string, model: OpenCodeModelRef): Promise<void> {
    return this.request('POST', `/api/session/${enc(sessionID)}/model`, { body: { model } });
  }

  switchAgent(sessionID: string, agent: string): Promise<void> {
    return this.request('POST', `/api/session/${enc(sessionID)}/agent`, { body: { agent } });
  }

  prompt(
    sessionID: string,
    input: { text: string; files?: OpenCodePromptFile[]; delivery?: 'steer' | 'queue' }
  ): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/session/${enc(sessionID)}/prompt`, { body: input });
  }

  command(sessionID: string, input: { name: string; text: string }): Promise<void> {
    return this.request('POST', `/api/session/${enc(sessionID)}/command`, { body: input });
  }

  compact(sessionID: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/session/${enc(sessionID)}/compact`, { body: {} });
  }

  interrupt(sessionID: string, signal?: AbortSignal): Promise<{ interrupted: boolean }> {
    return this.request('POST', `/api/session/${enc(sessionID)}/interrupt`, { signal });
  }

  fork(sessionID: string): Promise<OpenCodeSessionInfo> {
    return this.request('POST', `/api/session/${enc(sessionID)}/fork`, { body: {} });
  }

  replyPermission(sessionID: string, requestID: string, decision: OpenCodePermissionDecision): Promise<void> {
    return this.request('POST', `/api/session/${enc(sessionID)}/permission/${enc(requestID)}/reply`, {
      body: { decision },
    });
  }

  replyForm(sessionID: string, formID: string, answer: Record<string, unknown>): Promise<void> {
    return this.request('POST', `/api/session/${enc(sessionID)}/form/${enc(formID)}/reply`, { body: { answer } });
  }

  cancelForm(sessionID: string, formID: string): Promise<void> {
    return this.request('DELETE', `/api/session/${enc(sessionID)}/form/${enc(formID)}`);
  }

  async listCommands(directory: string): Promise<Array<{ name: string; description?: string }>> {
    return listData(await this.request('GET', '/api/command', { query: locationQuery(directory) }));
  }

  async listSkills(directory: string): Promise<Array<Record<string, unknown>>> {
    return listData(await this.request('GET', '/api/skill', { query: locationQuery(directory) }));
  }

  async listMcpServers(directory: string): Promise<Array<{ name: string; status?: unknown }>> {
    return listData(await this.request('GET', '/api/mcp', { query: locationQuery(directory) }));
  }

  async listModels(directory: string): Promise<OpenCodeModelInfo[]> {
    return listData(await this.request('GET', '/api/model', { query: locationQuery(directory) }));
  }

  /** The configured default model. The full record includes provider settings (API keys): read ids only. */
  async defaultModel(directory: string): Promise<OpenCodeModelInfo | null> {
    const model = await this.request<OpenCodeModelInfo | null>('GET', '/api/model/default', {
      query: locationQuery(directory),
    });
    return model ?? null;
  }

  /**
   * Opens the server-wide event stream. Resolves once the server accepted the
   * subscription, so events emitted after this point are not missed.
   */
  async openEventStream(signal: AbortSignal): Promise<AsyncIterable<OpenCodeServerEvent>> {
    const response = await this.fetchImpl(this.url('/api/event'), {
      headers: { authorization: this.authorization, accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new OpenCodeApiError(`OpenCode event stream failed with ${response.status}`, response.status);
    }
    return parseServerSentEvents(response.body);
  }
}

/** Parses an SSE byte stream into JSON `data:` payloads, skipping comments (heartbeats). */
export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<OpenCodeServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, '\n');
      if (done) buffer += '\n\n';
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) {
          try {
            const event = JSON.parse(data) as OpenCodeServerEvent;
            if (event && typeof event.type === 'string') yield event;
          } catch {
            // A malformed frame must not end the stream.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
