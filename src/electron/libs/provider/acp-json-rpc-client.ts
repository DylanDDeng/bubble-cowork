import type { ChildProcessWithoutNullStreams } from 'child_process';

export type AcpJsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export type AcpJsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
};

export type AcpJsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type AcpJsonRpcIncomingRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export class AcpJsonRpcClient {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly onNotification: (method: string, params?: Record<string, unknown>) => void,
    private readonly onRequest: (request: AcpJsonRpcIncomingRequest) => void,
    private readonly onParseError: (line: string, error: Error) => void
  ) {
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.handleChunk(String(chunk)));
    this.proc.on('exit', () => this.rejectAll(new Error('ACP process exited')));
    this.proc.on('error', (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload: AcpJsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  respond(id: number, result?: Record<string, unknown>, error?: { code?: number; message?: string }): void {
    const payload: AcpJsonRpcResponse = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };
    this.send(payload);
  }

  private send(payload: AcpJsonRpcRequest | AcpJsonRpcNotification | AcpJsonRpcResponse): void {
    if (this.proc.stdin.writable) {
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
    let parsed: AcpJsonRpcResponse & {
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch (error) {
      this.onParseError(line, error as Error);
      return;
    }

    if (typeof parsed.id === 'number' && parsed.method) {
      this.onRequest({ id: parsed.id, method: parsed.method, params: parsed.params });
      return;
    }

    if (parsed.method) {
      this.onNotification(parsed.method, parsed.params);
      return;
    }

    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pending.delete(parsed.id);
      if (parsed.error) {
        const message = parsed.error.message || `ACP request ${pending.method} failed`;
        const err = new Error(message) as Error & { code?: number; data?: unknown };
        err.code = parsed.error.code;
        err.data = parsed.error.data;
        pending.reject(err);
        return;
      }
      pending.resolve(parsed.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
