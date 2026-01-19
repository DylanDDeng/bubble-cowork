import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type { RunnerOptions, RunnerHandle, StreamMessage, Attachment } from '../types';
import { isDev } from '../util';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

type PromptCapabilities = {
  image?: boolean;
};

type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content?: unknown }
  | { sessionUpdate: string; [key: string]: unknown };

class JsonRpcClient {
  private readonly pending = new Map<
    number,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private buffer = '';

  constructor(
    private readonly proc: ReturnType<typeof spawn>,
    private readonly onNotification: (method: string, params?: Record<string, unknown>) => void,
    private readonly onRequest: (id: number, method: string, params?: Record<string, unknown>) => void,
    private readonly onParseError: (line: string, err: Error) => void
  ) {
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk) => this.handleChunk(String(chunk)));
    proc.on('exit', () => this.rejectAllPending(new Error('Codex ACP process exited')));
    proc.on('error', (err) => this.rejectAllPending(err instanceof Error ? err : new Error(String(err))));
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    if (isDev()) {
      const keys = params ? Object.keys(params) : [];
      console.log('[Codex ACP] ->', { id, method, keys });
    }
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.send(payload);
  }

  respond(id: number, result?: Record<string, unknown>, error?: { code?: number; message?: string }): void {
    const payload: JsonRpcResponse = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };
    this.send(payload);
  }

  private send(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (this.proc.stdin?.writable) {
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    }
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        this.handleLine(line);
      }
      idx = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcResponse & { method?: string; params?: Record<string, unknown> };
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.onParseError(line, error as Error);
      return;
    }

    if (parsed.method) {
      if (typeof parsed.id === 'number') {
        this.onRequest(parsed.id, parsed.method, parsed.params);
      } else {
        this.onNotification(parsed.method, parsed.params);
      }
      return;
    }

    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.error) {
        const code = parsed.error.code;
        const message = parsed.error.message || 'JSON-RPC error';
        const data = parsed.error.data;
        const codePart = typeof code === 'number' ? ` (code ${code})` : '';
        const dataPart = data !== undefined ? `: ${safeStringify(data)}` : '';
        pending.reject(new Error(`${pending.method}: ${message}${codePart}${dataPart}`));
      } else {
        pending.resolve(parsed.result);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function buildPromptContent(
  prompt: string,
  attachments: Attachment[] | undefined,
  capabilities: PromptCapabilities
): Promise<PromptContentBlock[]> {
  const allAttachments = attachments?.filter((a) => a && a.path) || [];
  const imageAttachments = allAttachments.filter((a) => a.kind === 'image');

  const lines: string[] = [prompt];
  if (allAttachments.length > 0) {
    lines.push('', 'Attachments:');
    for (const attachment of allAttachments) {
      lines.push(`- ${attachment.name}: ${attachment.path}`);
    }
  }

  const blocks: PromptContentBlock[] = [{ type: 'text', text: lines.join('\n') }];

  if (allAttachments.length === 0) {
    return blocks;
  }

  // Codex ACP prompt content blocks do not support generic file attachments.
  // For non-image files we only pass absolute paths in the text block above.

  if (capabilities.image && imageAttachments.length > 0) {
    for (const image of imageAttachments) {
      try {
        const buffer = await readFile(image.path);
        blocks.push({
          type: 'image',
          mimeType: image.mimeType,
          data: buffer.toString('base64'),
        });
      } catch (error) {
        if (isDev()) {
          console.warn('[Codex Runner] Failed to read image attachment:', image.path, error);
        }
      }
    }
  }

  return blocks;
}

export function runCodex(options: RunnerOptions): RunnerHandle {
  const { prompt, attachments, session, onMessage, onError } = options;
  const abortController = new AbortController();
  let currentSessionId = '';
  let streamingStarted = false;
  let assistantBuffer = '';
  let resultEmitted = false;
  let promptCapabilities: PromptCapabilities = {};

  const proc = spawn('codex-acp', [], {
    cwd: session.cwd || process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (isDev()) {
    console.log('[Codex Runner] spawned codex-acp', { cwd: session.cwd || process.cwd() });
  }

  proc.on('exit', (code, signal) => {
    if (!abortController.signal.aborted) {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      onError?.(new Error(`Codex ACP exited (${reason})`));
    }
  });

  proc.on('error', (error) => {
    if (!abortController.signal.aborted) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });

  proc.stderr?.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (line) {
      console.warn('[Codex ACP]', line);
    }
  });

  const client = new JsonRpcClient(
    proc,
    (method, params) => {
      if (method === 'session/update') {
        handleSessionUpdate(params);
      }
    },
    (id, method, params) => {
      if (method.includes('request_permission') || method.includes('requestPermission')) {
        handlePermissionRequest(id, params);
        return;
      }

      if (isDev()) {
        console.warn('[Codex ACP] Unhandled request from agent:', { method });
      }
      client.respond(id, undefined, { code: -32601, message: `Method not supported: ${method}` });
    },
    (line, err) => {
      console.warn('[Codex ACP] Failed to parse JSON:', line.slice(0, 120), err);
    }
  );

  const ready = initializeAndCreateSession();
  let enqueueChain: Promise<void> = Promise.resolve();

  const enqueuePrompt = (text: string, promptAttachments?: Attachment[]) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    enqueueChain = enqueueChain
      .then(async () => {
        await ready;
        if (abortController.signal.aborted) return;
        await sendPrompt(trimmed, promptAttachments);
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        onError?.(err);
      });
  };

  enqueuePrompt(prompt, attachments);

  const emitResult = (status: 'success' | 'cancelled' | 'error') => {
    if (resultEmitted || abortController.signal.aborted) {
      return;
    }
    resultEmitted = true;

    if (streamingStarted) {
      onMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      });
    }

    if (assistantBuffer.trim()) {
      onMessage({
        type: 'assistant',
        uuid: uuidv4(),
        message: { content: [{ type: 'text', text: assistantBuffer }] },
      });
    }

    if (status === 'cancelled') {
      return;
    }

    onMessage({
      type: 'result',
      subtype: status === 'error' ? 'error' : 'success',
      duration_ms: 0,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  };

  async function initializeAndCreateSession(): Promise<void> {
    const initResult = (await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'bubble-cowork',
        title: 'Bubble Cowork',
        version: '0.0.4',
      },
    })) as Record<string, unknown> | undefined;

    const caps =
      (initResult?.agentCapabilities as Record<string, unknown>) ||
      (initResult?.capabilities as Record<string, unknown>) ||
      {};
    const promptCaps =
      (caps.promptCapabilities as Record<string, unknown>) ||
      (caps.prompt as Record<string, unknown>) ||
      {};
    promptCapabilities = { image: !!promptCaps.image };

    const sessionResult = (await client.request('session/new', {
      cwd: session.cwd || process.cwd(),
      mcpServers: [],
    })) as Record<string, unknown>;

    currentSessionId = String(sessionResult?.sessionId || sessionResult?.id || '');
    if (!currentSessionId) {
      throw new Error('Codex ACP did not return a session id.');
    }

    const initMessage: StreamMessage = {
      type: 'system',
      subtype: 'init',
      session_id: currentSessionId,
      model: '',
      permissionMode: '',
      cwd: session.cwd || process.cwd(),
      tools: [],
    };
    onMessage(initMessage);
  }

  async function sendPrompt(text: string, promptAttachments?: Attachment[]): Promise<void> {
    const content = await buildPromptContent(text, promptAttachments, promptCapabilities);
    assistantBuffer = '';
    streamingStarted = false;
    resultEmitted = false;

    let result: Record<string, unknown> | undefined;
    try {
      result = (await client.request('session/prompt', {
        sessionId: currentSessionId,
        prompt: content,
      })) as Record<string, unknown>;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      onError?.(err);
      return;
    }

    if (abortController.signal.aborted) {
      return;
    }

    const stopReason = String(result?.stopReason || result?.stop_reason || '');
    const status = String(result?.status || '');
    const done = Boolean(result?.done || result?.completed);

    if (stopReason) {
      emitResult(stopReason === 'cancelled' ? 'cancelled' : 'success');
      return;
    }

    // Codex ACP may return an empty object here. The request resolving is enough
    // to treat the turn as complete.
    if (done || status) {
      emitResult(status === 'error' ? 'error' : 'success');
      return;
    }

    emitResult('success');
  }

  function handleSessionUpdate(params?: Record<string, unknown>): void {
    const update = (params?.update as SessionUpdate) || (params as SessionUpdate);
    if (!update) return;

    const updateType = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';

    if (updateType === 'agent_message_chunk') {
      let rawContent = update.content as { type?: string; text?: string; thinking?: string; content?: unknown } | undefined;
      if (rawContent?.type === 'content' && rawContent.content) {
        rawContent = rawContent.content as { type?: string; text?: string; thinking?: string };
      }
      const contentType = rawContent?.type;
      const text = rawContent?.text;
      const thinking = rawContent?.thinking;

      if (contentType === 'text' && typeof text === 'string') {
        if (!streamingStarted) {
          streamingStarted = true;
          onMessage({ type: 'stream_event', event: { type: 'content_block_start' } });
        }
        assistantBuffer += text;
        onMessage({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text },
          },
        });
      }

      if (contentType === 'thinking' && typeof thinking === 'string') {
        if (!streamingStarted) {
          streamingStarted = true;
          onMessage({ type: 'stream_event', event: { type: 'content_block_start' } });
        }
        onMessage({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking },
          },
        });
      }
      return;
    }

    if (updateType === 'agent_message') {
      const text = extractText(update as Record<string, unknown>);
      if (text) {
        assistantBuffer += text;
      }
      emitResult('success');
      return;
    }

    const completion = updateSignalsCompletion(update as Record<string, unknown>);
    if (completion) {
      emitResult(completion === 'cancelled' ? 'cancelled' : 'success');
    }
  }

  function handlePermissionRequest(id: number, params?: Record<string, unknown>): void {
    const options =
      (params?.options as Array<{ optionId?: string; label?: string; name?: string }>) ||
      (params?.choices as Array<{ optionId?: string; label?: string; name?: string }>) ||
      [];
    const allowOption =
      options.find((o) =>
        /allow|yes/i.test(String(o.label || o.name || o.optionId || ''))
      ) || options[0];

    if (!allowOption?.optionId) {
      client.respond(id, { outcome: { outcome: 'cancelled' } });
      return;
    }

    client.respond(id, { outcome: { outcome: 'selected', optionId: allowOption.optionId } });
  }

  return {
    abort: () => {
      abortController.abort();
      if (currentSessionId) {
        client.notify('session/cancel', { sessionId: currentSessionId });
      }
      proc.kill();
    },
    send: enqueuePrompt,
  };
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractText(update: Record<string, unknown>): string | null {
  const content = update.content ?? update.message ?? update.output;
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (typeof obj.text === 'string') return obj.text;
          if (typeof obj.content === 'string') return obj.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('');
    return parts || null;
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (Array.isArray(obj.content)) {
      const parts = obj.content
        .map((item) => (item && typeof item === 'object' && typeof (item as any).text === 'string' ? (item as any).text : ''))
        .filter(Boolean)
        .join('');
      return parts || null;
    }
  }
  return null;
}

function updateSignalsCompletion(update: Record<string, unknown>): 'success' | 'cancelled' | null {
  const rawType = String(update.sessionUpdate || update.type || update.kind || update.event || '').toLowerCase();
  if (rawType) {
    if (rawType.includes('cancel')) return 'cancelled';
    if (rawType.includes('complete') || rawType.includes('finish') || rawType.includes('done') || rawType.includes('end') || rawType.includes('stop')) {
      return 'success';
    }
  }

  const stopReason = String(update.stopReason || update.stop_reason || '');
  if (stopReason) {
    return stopReason === 'cancelled' ? 'cancelled' : 'success';
  }

  if (update.done === true || update.final === true || update.completed === true) {
    return 'success';
  }

  if (typeof update.status === 'string') {
    const status = update.status.toLowerCase();
    if (status.includes('cancel')) return 'cancelled';
    if (status.includes('complete') || status.includes('finish') || status.includes('done') || status.includes('end') || status.includes('success')) {
      return 'success';
    }
  }

  return null;
}
