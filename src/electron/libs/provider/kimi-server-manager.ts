import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { createServer } from 'net';
import { homedir } from 'os';
import path from 'path';
import { buildKimiEnv, resolveKimiBinary } from '../kimi-cli';

/**
 * KimiServerManager — lifecycle + REST/WS client for the `kimi server`
 * daemon (docs/kimi-server-adapter-plan.md).
 *
 * Protocol facts pinned by scripts/probe-kimi-server.mjs against 0.26.0:
 * - The daemon is a MACHINE-WIDE SINGLETON. A second `run` refuses with
 *   `server already running (pid=N, port=N, …)` on stderr; we adopt that
 *   daemon instead (token from ~/.kimi-code/server.token). We only kill a
 *   daemon we spawned ourselves.
 * - `--foreground`: child pid == serving pid, SIGTERM stops it, keep-alive
 *   is implied.
 * - REST envelope `{code, msg, data}`; list endpoints use `data.items`.
 * - WS event envelope `{type, seq, session_id, payload, epoch, volatile?}`;
 *   volatility is the top-level flag. Cursors are `{seq, epoch}`.
 */

// ── Errors ──────────────────────────────────────────────────────────────────

/** Envelope-level API failure (`code !== 0`). */
export class KimiServerApiError extends Error {
  readonly code: number;
  constructor(code: number, msg: string, requestPath: string) {
    super(`kimi server API error ${code} on ${requestPath}: ${msg}`);
    this.name = 'KimiServerApiError';
    this.code = code;
  }
}

export type KimiServerTransportFailureReason =
  | 'daemon_unavailable'
  | 'daemon_exit'
  | 'http_error'
  | 'timeout'
  | 'stale_generation';

/** Transport-level failure (daemon death, HTTP failure, stale generation). */
export class KimiServerTransportError extends Error {
  readonly reason: KimiServerTransportFailureReason;
  constructor(reason: KimiServerTransportFailureReason, detail: string) {
    super(`kimi server transport failure (${reason}): ${detail}`);
    this.name = 'KimiServerTransportError';
    this.reason = reason;
  }
}

// ── Wire types (subset we consume) ──────────────────────────────────────────

export interface KimiWsFrame {
  type: string;
  seq?: number;
  session_id?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
  epoch?: string;
  volatile?: boolean;
  offset?: number;
  id?: string;
  code?: number;
  msg?: string;
}

export interface KimiSessionCursor {
  seq: number;
  epoch: string;
}

// ── Injectable transports (L1/L2 test seam — day-one constraint) ────────────

export interface KimiWebSocketLike {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: (code?: number) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface KimiDaemonChildLike {
  readonly pid?: number;
  readonly exitCode: number | null;
  stdout?: { setEncoding(encoding: string): void; on(event: 'data', listener: (chunk: string) => void): void } | null;
  stderr?: { setEncoding(encoding: string): void; on(event: 'data', listener: (chunk: string) => void): void } | null;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface KimiServerTransport {
  fetchImpl?: typeof fetch;
  createWebSocket?: (url: string, headers: Record<string, string>) => KimiWebSocketLike;
  spawnDaemon?: (binary: string, args: string[]) => KimiDaemonChildLike;
  resolveBinary?: () => Promise<string | null>;
  readTokenFile?: () => string | null;
}

// ── Timeouts (env-overridable for tests) ────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const TOKEN_LINE_REGEX = /^\s*Token:\s+(\S+)\s*$/m;
const ALREADY_RUNNING_REGEX = /server already running \(pid=(\d+), port=(\d+)/;

export const KIMI_SERVER_TOKEN_PATH = path.join(homedir(), '.kimi-code', 'server.token');

function defaultReadTokenFile(): string | null {
  try {
    const token = readFileSync(KIMI_SERVER_TOKEN_PATH, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function defaultCreateWebSocket(url: string, headers: Record<string, string>): KimiWebSocketLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WebSocketImpl = require('ws') as new (
    url: string,
    options: { headers: Record<string, string> }
  ) => KimiWebSocketLike;
  return new WebSocketImpl(url, { headers });
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
          return;
        }
        reject(new Error('Failed to allocate a local kimi server port.'));
      });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

interface DaemonState {
  generation: number;
  port: number;
  baseUrl: string;
  token: string;
  /** Child handle when we spawned the daemon; null when adopted. */
  child: KimiDaemonChildLike | null;
  /** True when this process spawned (and therefore owns) the daemon. */
  owned: boolean;
  abortController: AbortController;
}

interface PendingSubscribe {
  resolve: (result: { accepted: boolean; resync: string | null; cursor: KimiSessionCursor | null }) => void;
  reject: (error: Error) => void;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
  /** Reconnect-path subscribes route not_found through gone-verification;
   * caller-consumed subscribes read the verdict off the promise instead. */
  verifyOnNotFound?: boolean;
}

/**
 * Events:
 * - 'session_event'    {sessionId, frame}        — seq-deduped agent/session frames
 * - 'resync_required'  {sessionId, reason}       — subscribe ack flagged a gap
 * - 'session_gone'     {sessionId}               — subscribe ack listed not_found
 * - 'daemon_exit'      {generation}              — daemon/transport died; sessions stale
 * - 'ws_reconnected'   {generation}              — WS re-established + resubscribed
 */
export class KimiServerManager extends EventEmitter {
  private state: DaemonState | null = null;
  private startPromise: Promise<DaemonState> | null = null;
  // In-flight spawn child, tracked synchronously: killSync() runs at
  // before-quit where no further event-loop ticks are guaranteed, so the
  // async stopped-checks inside startDaemon can never reap it there.
  private pendingSpawnChild: KimiDaemonChildLike | null = null;
  // Monotonic daemon generation. Sessions capture it; events/RPCs from stale
  // generations are rejected so a late exit can't clobber a replacement.
  private generation = 0;
  private stopped = false;

  private ws: KimiWebSocketLike | null = null;
  private wsGeneration = 0;
  private wsConnected = false;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsReconnectDelayMs = 500;
  private subscribeSeq = 0;
  private pendingSubscribes = new Map<string, PendingSubscribe>();

  /** Sessions the adapter wants events for, with replay cursors. */
  private subscriptions = new Map<string, KimiSessionCursor | null>();

  // ── session_gone verification ledger (F9b) ─────────────────────────────
  // A lone reconnect-ack not_found is NOT proof of absence (lazy session
  // registry after an external daemon restart) — the same class 40cab26
  // fixed for resume. Gone-verification runs async and must be deduped and
  // invalidated by any concurrent successful subscribe/unsubscribe.
  private activeGoneVerifies = new Set<string>();
  private verifyEpochs = new Map<string, number>();

  private readonly fetchImpl: typeof fetch;
  private readonly createWebSocketImpl: (url: string, headers: Record<string, string>) => KimiWebSocketLike;
  private readonly spawnDaemonImpl: (binary: string, args: string[]) => KimiDaemonChildLike;
  private readonly resolveBinaryImpl: () => Promise<string | null>;
  private readonly readTokenFileImpl: () => string | null;

  private readonly readyTimeoutMs = envInt('AEGIS_KIMI_SERVER_READY_TIMEOUT_MS', 15_000);
  private readonly requestTimeoutMs = envInt('AEGIS_KIMI_SERVER_REQUEST_TIMEOUT_MS', 30_000);
  private readonly subscribeTimeoutMs = envInt('AEGIS_KIMI_SERVER_SUBSCRIBE_TIMEOUT_MS', 10_000);
  private readonly reconnectMaxDelayMs = envInt('AEGIS_KIMI_SERVER_RECONNECT_MAX_MS', 8_000);

  constructor(transport: KimiServerTransport = {}) {
    super();
    this.fetchImpl = transport.fetchImpl || fetch;
    this.createWebSocketImpl = transport.createWebSocket || defaultCreateWebSocket;
    this.spawnDaemonImpl =
      transport.spawnDaemon ||
      ((binary, args) =>
        spawn(binary, args, {
          env: buildKimiEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as unknown as KimiDaemonChildLike);
    this.resolveBinaryImpl = transport.resolveBinary || resolveKimiBinary;
    this.readTokenFileImpl = transport.readTokenFile || defaultReadTokenFile;
  }

  getGeneration(): number {
    return this.generation;
  }

  isRunning(): boolean {
    return this.state !== null;
  }

  // ── Daemon lifecycle ──────────────────────────────────────────────────────

  /** Single-flight spawn barrier; resolves when healthz gates green. */
  async ensureDaemon(): Promise<DaemonState> {
    if (this.stopped) {
      throw new KimiServerTransportError('daemon_unavailable', 'manager is stopped');
    }
    if (this.state) return this.state;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startDaemon().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startDaemon(): Promise<DaemonState> {
    const binary = await this.resolveBinaryImpl();
    if (!binary) {
      throw new KimiServerTransportError(
        'daemon_unavailable',
        'Kimi Code CLI was not found. Install Kimi Code or set KIMI_CODE_PATH.'
      );
    }

    this.generation += 1;
    const generation = this.generation;
    const port = await findAvailablePort();
    if (this.stopped) {
      throw new KimiServerTransportError('daemon_unavailable', 'manager stopped');
    }
    const child = this.spawnDaemonImpl(binary, [
      'server',
      'run',
      '--foreground',
      '--port',
      String(port),
    ]);
    this.pendingSpawnChild = child;

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    let exited = false;
    let spawnErrorMessage = '';
    // On the adoption path this child is just the refused second `run` whose
    // exit is EXPECTED — once adoption is chosen its exit must not tear down
    // the adopted daemon's (same-numbered) generation.
    let adopted = false;
    child.on('exit', () => {
      exited = true;
      // A daemon we own dying invalidates the whole generation (b)/(c) —
      // late exits of an already-replaced generation are ignored inside.
      if (!adopted) {
        this.handleDaemonExit(generation);
      }
    });
    child.on('error', (error) => {
      spawnErrorMessage = error.message;
      exited = true;
    });

    try {
      // Wait for one of: the startup banner (we own the daemon), "already
      // running" (adopt the existing singleton), or child exit without either.
      const deadline = Date.now() + this.readyTimeoutMs;
      let adoptedPort: number | null = null;
      let owned = false;
      while (Date.now() < deadline && !this.stopped) {
        const already = ALREADY_RUNNING_REGEX.exec(stderr);
        if (already) {
          adoptedPort = Number.parseInt(already[2], 10);
          break;
        }
        if (TOKEN_LINE_REGEX.test(stdout)) {
          owned = true;
          break;
        }
        // Banner up but the Token line is unusable (per-version format drift):
        // the persistent token file is the pinned fallback.
        if (/Kimi server ready/i.test(stdout) && this.readTokenFileImpl()) {
          owned = true;
          break;
        }
        if (exited) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.stopped) {
        throw new KimiServerTransportError('daemon_unavailable', 'manager stopped');
      }

      if (!owned && adoptedPort === null) {
        throw new KimiServerTransportError(
          'daemon_unavailable',
          spawnErrorMessage
            ? `failed to spawn kimi server: ${spawnErrorMessage}`
            : `kimi server did not become ready within ${this.readyTimeoutMs}ms.\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`
        );
      }
      adopted = adoptedPort !== null;

      // Token: the persistent file works for both owned and adopted daemons;
      // the stdout line is the fallback for owned spawns.
      const token = this.readTokenFileImpl() || TOKEN_LINE_REGEX.exec(stdout)?.[1] || '';
      if (!token) {
        throw new KimiServerTransportError('daemon_unavailable', 'could not obtain the kimi server bearer token');
      }

      const effectivePort = owned ? port : (adoptedPort as number);
      const baseUrl = `http://127.0.0.1:${effectivePort}`;

      // Readiness gate on /healthz. The 2s shortcut applies only to an owned
      // child that already died; the refused adoption probe child exiting is
      // normal and must not shrink the adopted daemon's window.
      await this.waitForHealthz(baseUrl, owned && exited ? 2_000 : this.readyTimeoutMs, owned ? child : null);
      if (this.stopped) {
        throw new KimiServerTransportError('daemon_unavailable', 'manager stopped');
      }

      const state: DaemonState = {
        generation,
        port: effectivePort,
        baseUrl,
        token,
        child: owned ? child : null,
        owned,
        abortController: new AbortController(),
      };
      this.state = state;
      this.connectWebSocket(state);
      return state;
    } catch (error) {
      // Never leak the child we spawned, whichever step threw (healthz
      // failure included — a leaked wedged daemon makes every retry adopt
      // the corpse). Killing the refused adoption probe child is harmless;
      // the adopted daemon itself has no handle here and is never touched.
      if (error instanceof KimiServerTransportError && error.reason === 'daemon_unavailable' && adopted && !this.stopped) {
        // Adoption failed (unhealthy singleton): the error must be
        // actionable — we refuse to kill a daemon we did not spawn.
        const already = ALREADY_RUNNING_REGEX.exec(stderr);
        throw new KimiServerTransportError(
          'daemon_unavailable',
          `${error.message}\nAn existing kimi server daemon (pid=${already?.[1] ?? '?'}, port=${already?.[2] ?? '?'}) is not responding; run \`kimi server kill\` to clear it, then retry.`
        );
      }
      throw error;
    } finally {
      if (this.pendingSpawnChild === child) {
        this.pendingSpawnChild = null;
      }
      if (this.state?.child !== child) {
        // Failure path, stopped mid-start, or adoption (probe child): reap
        // our own spawn. try/catch — it may already be dead.
        try {
          child.kill('SIGTERM');
        } catch {
          // already dead
        }
      }
    }
  }

  /** One quick liveness check; false on any failure. */
  private async probeHealthz(state: DaemonState): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${state.baseUrl}/api/v1/healthz`, {
        signal: AbortSignal.any([state.abortController.signal, AbortSignal.timeout(2_000)]),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealthz(
    baseUrl: string,
    timeoutMs: number,
    child: KimiDaemonChildLike | null
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'timeout';
    while (Date.now() < deadline) {
      if (child && child.exitCode !== null) {
        throw new KimiServerTransportError('daemon_exit', 'kimi server exited before becoming healthy');
      }
      try {
        const response = await this.fetchImpl(`${baseUrl}/api/v1/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
        lastError = `healthz status ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new KimiServerTransportError('daemon_unavailable', `healthz never went green: ${lastError}`);
  }

  /**
   * Tear down a generation: abort in-flight fetches, close the WS, notify the
   * adapter (which dismisses pending approvals and marks sessions stale).
   * No-op for stale generations so a late exit can't clobber a replacement.
   */
  private handleDaemonExit(generation: number): void {
    if (generation !== this.generation) return;
    const state = this.state;
    if (!state || state.generation !== generation) {
      return;
    }
    this.state = null;
    state.abortController.abort();
    this.teardownWs();
    // Cursors are useless across daemon restarts (probe F: sessions come back
    // as not_found) — drop them; the ids stay registered for resubscribe
    // attempts so the adapter hears session_gone explicitly.
    for (const sessionId of this.subscriptions.keys()) {
      this.subscriptions.set(sessionId, null);
    }
    this.emit('daemon_exit', { generation });
  }

  /** Stop everything. Kills the daemon only if this process spawned it. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.reapPendingSpawn();
    const state = this.state;
    this.state = null;
    this.teardownWs();
    this.pendingSubscribes.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new KimiServerTransportError('daemon_exit', 'manager stopped'));
    });
    this.pendingSubscribes.clear();
    this.subscriptions.clear();
    if (!state) return;
    state.abortController.abort();
    if (state.owned && state.child) {
      // Best-effort graceful shutdown, then SIGTERM. An HTTP daemon does not
      // die on stdio EOF like ACP children — the kill is the real teardown.
      try {
        await this.fetchImpl(`${state.baseUrl}/api/v1/shutdown`, {
          method: 'POST',
          headers: { authorization: `Bearer ${state.token}` },
          signal: AbortSignal.timeout(1_000),
        });
      } catch {
        // daemon may already be gone
      }
      try {
        state.child.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
  }

  /**
   * Synchronous best-effort kill for before-quit (no awaits available there).
   * Only touches a daemon we own.
   */
  killSync(): void {
    this.stopped = true;
    this.reapPendingSpawn();
    const state = this.state;
    this.state = null;
    this.teardownWs();
    if (state?.owned && state.child) {
      try {
        state.child.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
  }

  /** Synchronously reap an in-flight spawn — see pendingSpawnChild. */
  private reapPendingSpawn(): void {
    const child = this.pendingSpawnChild;
    this.pendingSpawnChild = null;
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
  }

  // ── REST client ───────────────────────────────────────────────────────────

  /** Bearer-authed fetch that unwraps the `{code, msg, data}` envelope. */
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    requestPath: string,
    body?: unknown
  ): Promise<T> {
    const state = await this.ensureDaemon();
    return this.requestOnState<T>(state, method, requestPath, body, true);
  }

  private async requestOnState<T>(
    state: DaemonState,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    requestPath: string,
    body: unknown,
    allowTokenRetry: boolean
  ): Promise<T> {
    if (this.state !== state) {
      throw new KimiServerTransportError('stale_generation', `${method} ${requestPath}`);
    }
    let response: Response;
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    try {
      response = await this.fetchImpl(`${state.baseUrl}/api/v1${requestPath}`, {
        method,
        headers: {
          authorization: `Bearer ${state.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([state.abortController.signal, timeoutSignal]),
      });
    } catch (error) {
      if (state.abortController.signal.aborted) {
        throw new KimiServerTransportError('daemon_exit', `${method} ${requestPath}`);
      }
      // A slow endpoint is this request's problem, not daemon death — one
      // 30s GET /messages must never tear down every live session. (Check
      // the signal, not error.name: robust against undici wrapping.)
      if (timeoutSignal.aborted) {
        throw new KimiServerTransportError(
          'timeout',
          `${method} ${requestPath}: timed out after ${this.requestTimeoutMs}ms`
        );
      }
      // Verify before declaring death: only an unreachable daemon justifies
      // the full teardown (connection refused without a child-exit signal —
      // adopted daemon, sleep/wake). A transient socket error with a live
      // daemon fails this request only.
      const alive = await this.probeHealthz(state);
      if (state.abortController.signal.aborted) {
        throw new KimiServerTransportError('daemon_exit', `${method} ${requestPath}`);
      }
      if (alive) {
        throw new KimiServerTransportError(
          'http_error',
          `${method} ${requestPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.handleDaemonExit(state.generation);
      throw new KimiServerTransportError(
        'daemon_unavailable',
        `${method} ${requestPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (response.status === 401) {
      // Token rotated by the user (`kimi server rotate-token`) — re-read the
      // persistent token file once; unchanged token means restart-equivalent.
      const fresh = this.readTokenFileImpl();
      if (allowTokenRetry && fresh && fresh !== state.token) {
        state.token = fresh;
        return this.requestOnState<T>(state, method, requestPath, body, false);
      }
      this.handleDaemonExit(state.generation);
      throw new KimiServerTransportError('http_error', `${method} ${requestPath}: 401 unauthorized`);
    }

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      throw new KimiServerTransportError(
        'http_error',
        `${method} ${requestPath}: non-JSON response (status ${response.status})`
      );
    }
    if (!isRecord(parsed) || typeof parsed.code !== 'number') {
      throw new KimiServerTransportError(
        'http_error',
        `${method} ${requestPath}: malformed envelope (status ${response.status})`
      );
    }
    if (parsed.code !== 0) {
      throw new KimiServerApiError(parsed.code, String(parsed.msg || 'unknown error'), requestPath);
    }
    return parsed.data as T;
  }

  // ── High-level REST surface ───────────────────────────────────────────────

  async createSession(cwd: string): Promise<{ id: string }> {
    const data = await this.request<Record<string, unknown>>('POST', '/sessions', {
      metadata: { cwd },
    });
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      throw new KimiServerTransportError('http_error', 'POST /sessions returned no session id');
    }
    return { id };
  }

  async submitPrompt(
    sessionId: string,
    payload: {
      content: Array<Record<string, unknown>>;
      model: string;
      /** Effort tier string ('off' | 'on' | …), validated per-model server-side. */
      thinking?: string;
      permission_mode?: string;
      plan_mode?: boolean;
    }
  ): Promise<{ prompt_id: string; status: string }> {
    const data = await this.request<Record<string, unknown>>(
      'POST',
      `/sessions/${sessionId}/prompts`,
      payload
    );
    return {
      prompt_id: typeof data?.prompt_id === 'string' ? data.prompt_id : '',
      status: typeof data?.status === 'string' ? data.status : '',
    };
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const data = await this.request<Record<string, unknown>>('POST', `/sessions/${sessionId}:abort`);
    return data?.aborted === true;
  }

  /** Cancel one submitted/queued prompt (probe P1: the route exists; a stop
   * must use it because queued prompts auto-advance after `:abort`). */
  async cancelPrompt(sessionId: string, promptId: string): Promise<void> {
    await this.request('POST', `/sessions/${sessionId}/prompts/${promptId}:cancel`);
  }

  /** `GET /sessions/{id}` — carries the authoritative run-state
   * (`busy`/`main_turn_active`/`last_turn_reason`, probe P2). */
  async getSessionDetail(sessionId: string): Promise<Record<string, unknown> | null> {
    const data = await this.request<Record<string, unknown>>('GET', `/sessions/${sessionId}`);
    return isRecord(data) ? data : null;
  }

  async forkSession(sessionId: string): Promise<string> {
    const data = await this.request<Record<string, unknown>>('POST', `/sessions/${sessionId}:fork`);
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      throw new KimiServerTransportError('http_error', ':fork returned no session id');
    }
    return id;
  }

  async compactSession(sessionId: string): Promise<void> {
    await this.request('POST', `/sessions/${sessionId}:compact`);
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.request('POST', `/sessions/${sessionId}:archive`);
  }

  async steerPrompts(sessionId: string, promptIds: string[]): Promise<boolean> {
    try {
      await this.request('POST', `/sessions/${sessionId}/prompts:steer`, { prompt_ids: promptIds });
      return true;
    } catch (error) {
      // 40402 "no active prompt to steer into": the turn ended inside the race
      // window; the prompt stays queued and auto-runs (probe G) — benign.
      if (error instanceof KimiServerApiError && error.code === 40402) {
        return false;
      }
      throw error;
    }
  }

  async listModels(): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<Record<string, unknown>>('GET', '/models');
    return Array.isArray(data?.items) ? (data.items as Array<Record<string, unknown>>) : [];
  }

  /** REST existence check: `GET /sessions/{id}` → 40401 means genuinely absent. */
  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      await this.request('GET', `/sessions/${sessionId}`);
      return true;
    } catch (error) {
      if (error instanceof KimiServerApiError && error.code === 40401) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Resolve a resume id against the daemon with verification + retries.
   *
   * A single not_found subscribe is NOT proof the session is gone: a dev
   * restart kills the old daemon (SIGTERM) while the new app spawns a fresh
   * one, and the old daemon's async session flush can land AFTER the new
   * daemon builds its index — a just-active session transiently reads as
   * missing (observed in the wild: a 50-message session came back seconds
   * later). So: subscribe; on not_found consult REST (`40401` = absent,
   * confirmed across two spaced attempts before giving up); when REST says
   * the session EXISTS but the subscribe keeps failing, throw loudly so the
   * caller preserves the stored id and the user can retry — never fall
   * forward and orphan a live session.
   */
  async resolveResume(sessionId: string): Promise<'accepted' | 'missing'> {
    const attempts = envInt('AEGIS_KIMI_SERVER_RESUME_ATTEMPTS', 3);
    const retryDelayMs = envInt('AEGIS_KIMI_SERVER_RESUME_RETRY_MS', 500);
    let confirmedMissing = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const subscribed = await this.subscribeSession(sessionId);
      if (subscribed.accepted) {
        return 'accepted';
      }
      const exists = await this.sessionExists(sessionId);
      if (!exists) {
        confirmedMissing += 1;
        if (confirmedMissing >= 2) {
          this.unsubscribeSession(sessionId);
          return 'missing';
        }
      } else {
        confirmedMissing = 0;
        // WARM the daemon's live session registry: a legacy-store session
        // only materializes for WS subscription after its messages are
        // loaded once in this daemon's lifetime — the detail endpoint does
        // NOT do it (probed: cold subscribe → not_found even though the
        // session exists; subscribe after GET /messages → accepted).
        try {
          await this.getMessages(sessionId);
        } catch {
          // transport errors will surface on the next subscribe attempt
        }
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
    this.unsubscribeSession(sessionId);
    throw new KimiServerTransportError(
      'daemon_unavailable',
      `session ${sessionId} exists on the server but could not be attached — retry in a moment`
    );
  }

  /** `GET /sessions/{id}/skills` → `{skills: [{name, description, path, source}]}` (0.26.0). */
  async listSessionSkills(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<Record<string, unknown>>('GET', `/sessions/${sessionId}/skills`);
    return Array.isArray(data?.skills) ? (data.skills as Array<Record<string, unknown>>) : [];
  }

  /** `GET /workspaces` → `{items: [{id, root, name, …}]}` (0.26.0). */
  async listWorkspaces(): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<Record<string, unknown>>('GET', '/workspaces');
    return Array.isArray(data?.items) ? (data.items as Array<Record<string, unknown>>) : [];
  }

  /** Same payload shape as the session-scoped skills route. */
  async listWorkspaceSkills(workspaceId: string): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<Record<string, unknown>>('GET', `/workspaces/${workspaceId}/skills`);
    return Array.isArray(data?.skills) ? (data.skills as Array<Record<string, unknown>>) : [];
  }

  async getDefaultModel(): Promise<string | null> {
    const data = await this.request<Record<string, unknown>>('GET', '/config');
    return typeof data?.default_model === 'string' && data.default_model ? data.default_model : null;
  }

  async getMessages(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<Record<string, unknown>>('GET', `/sessions/${sessionId}/messages`);
    if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
    return Array.isArray(data?.items) ? (data.items as Array<Record<string, unknown>>) : [];
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    body: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string }
  ): Promise<void> {
    await this.request('POST', `/sessions/${sessionId}/approvals/${approvalId}`, body);
  }

  async resolveQuestion(sessionId: string, questionId: string, body: Record<string, unknown>): Promise<void> {
    await this.request('POST', `/sessions/${sessionId}/questions/${questionId}`, body);
  }

  // ── WS subscription plumbing ──────────────────────────────────────────────

  /**
   * Register interest in a session and subscribe over the live WS. Resolves
   * with `accepted:false` when the server does not know the id (probe: a
   * not_found subscribe never yields events later — callers must re-create).
   */
  async subscribeSession(sessionId: string): Promise<{ accepted: boolean; resync: string | null }> {
    await this.ensureDaemon();
    if (!this.subscriptions.has(sessionId)) {
      this.subscriptions.set(sessionId, null);
    }
    if (!this.wsConnected) {
      // The connect handler resubscribes everything registered; wait for it.
      await this.waitForWsConnected();
    }
    const result = await this.sendSubscribe([sessionId]);
    return result;
  }

  unsubscribeSession(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.bumpVerifyEpoch(sessionId);
    if (this.wsConnected && this.ws) {
      try {
        this.ws.send(
          JSON.stringify({ type: 'unsubscribe', payload: { session_ids: [sessionId] } })
        );
      } catch {
        // socket raced shut; the registry removal is what matters
      }
    }
  }

  getCursor(sessionId: string): KimiSessionCursor | null {
    return this.subscriptions.get(sessionId) || null;
  }

  private waitForWsConnected(): Promise<void> {
    if (this.wsConnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('ws_connected_internal', onConnected);
        this.off('daemon_exit', onExit);
        reject(new KimiServerTransportError('timeout', 'WS did not connect'));
      }, this.subscribeTimeoutMs);
      const onConnected = () => {
        clearTimeout(timer);
        this.off('daemon_exit', onExit);
        resolve();
      };
      const onExit = () => {
        clearTimeout(timer);
        this.off('ws_connected_internal', onConnected);
        reject(new KimiServerTransportError('daemon_exit', 'daemon died before WS connected'));
      };
      this.once('ws_connected_internal', onConnected);
      this.once('daemon_exit', onExit);
    });
  }

  private connectWebSocket(state: DaemonState): void {
    if (this.stopped || this.state !== state) return;
    const wsUrl = `${state.baseUrl.replace(/^http/, 'ws')}/api/v1/ws`;
    let ws: KimiWebSocketLike;
    try {
      ws = this.createWebSocketImpl(wsUrl, { authorization: `Bearer ${state.token}` });
    } catch (error) {
      this.scheduleWsReconnect(state);
      return;
    }
    this.ws = ws;
    this.wsGeneration = state.generation;

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      let frame: KimiWsFrame;
      try {
        frame = JSON.parse(String(data)) as KimiWsFrame;
      } catch {
        return;
      }
      this.handleWsFrame(state, ws, frame);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.wsConnected = false;
      this.ws = null;
      this.failPendingSubscribes('WS closed');
      // Failure domain (a): WS dropped but the daemon may be alive —
      // reconnect with backoff and resubscribe with stored cursors.
      this.scheduleWsReconnect(state);
    });
    ws.on('error', () => {
      // close follows; nothing to do here
    });
  }

  private handleWsFrame(state: DaemonState, ws: KimiWebSocketLike, frame: KimiWsFrame): void {
    if (frame.type === 'server_hello') {
      try {
        ws.send(JSON.stringify({ type: 'client_hello', payload: {} }));
      } catch {
        return;
      }
      this.wsConnected = true;
      this.wsReconnectDelayMs = 500;
      this.emit('ws_connected_internal');
      // Resubscribe everything registered (reconnect path) with cursors.
      // not_found here is NOT trusted alone (lazy registry after an external
      // restart) — it routes through REST-verified gone-notification.
      const sessionIds = Array.from(this.subscriptions.keys());
      if (sessionIds.length > 0) {
        void this.sendSubscribe(sessionIds, { verifyOnNotFound: true })
          .then(() => this.emit('ws_reconnected', { generation: state.generation }))
          .catch(() => {
            // subscribe failure surfaces via pending timeouts / close
          });
      }
      return;
    }
    if (frame.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong', payload: frame.payload }));
      } catch {
        // close handler takes over
      }
      return;
    }
    if (frame.type === 'ack' && typeof frame.id === 'string' && this.pendingSubscribes.has(frame.id)) {
      this.resolveSubscribeAck(frame);
      return;
    }
    const sessionId = frame.session_id;
    if (!sessionId || !this.subscriptions.has(sessionId)) return;

    // Replay idempotence: only non-volatile frames advance the cursor and are
    // deduped by seq; volatile frames (agent.status.updated, deltas) may
    // duplicate/share seq and are always forwarded.
    if (!frame.volatile && typeof frame.seq === 'number' && frame.epoch) {
      const cursor = this.subscriptions.get(sessionId);
      if (cursor && cursor.epoch === frame.epoch && frame.seq <= cursor.seq) {
        return;
      }
      this.subscriptions.set(sessionId, { seq: frame.seq, epoch: frame.epoch });
    }
    this.emit('session_event', { sessionId, frame });
  }

  private sendSubscribe(
    sessionIds: string[],
    options: { verifyOnNotFound?: boolean } = {}
  ): Promise<{ accepted: boolean; resync: string | null; cursor: KimiSessionCursor | null }> {
    const ws = this.ws;
    if (!ws || !this.wsConnected) {
      return Promise.reject(new KimiServerTransportError('daemon_unavailable', 'WS is not connected'));
    }
    this.subscribeSeq += 1;
    const id = `sub-${this.subscribeSeq}`;
    const cursors: Record<string, KimiSessionCursor> = {};
    for (const sessionId of sessionIds) {
      const cursor = this.subscriptions.get(sessionId);
      if (cursor) cursors[sessionId] = cursor;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSubscribes.delete(id);
        reject(new KimiServerTransportError('timeout', `subscribe ${id} timed out`));
      }, this.subscribeTimeoutMs);
      // One pending entry per subscribe message; sessionId is only used for
      // single-session subscribes (the common adapter path).
      this.pendingSubscribes.set(id, {
        resolve,
        reject,
        sessionId: sessionIds.length === 1 ? sessionIds[0] : '',
        timer,
        verifyOnNotFound: options.verifyOnNotFound === true,
      });
      try {
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            id,
            payload: {
              session_ids: sessionIds,
              ...(Object.keys(cursors).length > 0 ? { cursors } : {}),
            },
          })
        );
      } catch (error) {
        clearTimeout(timer);
        this.pendingSubscribes.delete(id);
        reject(
          new KimiServerTransportError(
            'daemon_unavailable',
            `subscribe send failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
  }

  private resolveSubscribeAck(frame: KimiWsFrame): void {
    const pending = this.pendingSubscribes.get(frame.id as string);
    if (!pending) return;
    this.pendingSubscribes.delete(frame.id as string);
    clearTimeout(pending.timer);

    const payload = isRecord(frame.payload) ? frame.payload : {};
    const accepted = Array.isArray(payload.accepted) ? (payload.accepted as string[]) : [];
    const notFound = Array.isArray(payload.not_found) ? (payload.not_found as string[]) : [];
    const resyncList = Array.isArray(payload.resync_required) ? payload.resync_required : [];
    const cursors = isRecord(payload.cursors) ? payload.cursors : {};

    for (const [sessionId, cursor] of Object.entries(cursors)) {
      if (this.subscriptions.has(sessionId) && isRecord(cursor) && typeof cursor.seq === 'number') {
        this.subscriptions.set(sessionId, {
          seq: cursor.seq,
          epoch: String(cursor.epoch || ''),
        });
      }
    }
    for (const entry of resyncList) {
      const record: Record<string, unknown> = isRecord(entry) ? entry : { session_id: entry };
      const sessionId = String(record.session_id || record.sessionId || pending.sessionId || '');
      if (sessionId) {
        // The buffer can't replay the gap — the adapter reconciles via
        // GET /messages instead of re-emitting the transcript.
        this.subscriptions.set(sessionId, null);
        this.emit('resync_required', {
          sessionId,
          reason: String(record.reason || 'unknown'),
        });
      }
    }
    for (const sessionId of accepted) {
      // A live subscription invalidates any in-flight gone-verification.
      this.bumpVerifyEpoch(sessionId);
    }
    if (pending.verifyOnNotFound) {
      // Reconnect-path not_found: verify before notifying (at most one loop
      // per session id). Caller-consumed subscribes (resolveResume, the
      // verification loop itself) read the verdict off the returned promise
      // instead — an immediate session_gone would fire before verification.
      for (const sessionId of notFound) {
        void this.verifyGoneAndNotify(sessionId);
      }
    }

    if (pending.sessionId) {
      const wasAccepted = accepted.includes(pending.sessionId);
      const resynced = resyncList.some((entry) => {
        const record = isRecord(entry) ? entry : null;
        return (record ? String(record.session_id || record.sessionId || '') : String(entry)) === pending.sessionId;
      });
      pending.resolve({
        accepted: wasAccepted || resynced,
        resync: resynced ? 'resync_required' : null,
        cursor: this.subscriptions.get(pending.sessionId) || null,
      });
      return;
    }
    pending.resolve({ accepted: accepted.length > 0, resync: null, cursor: null });
  }

  private bumpVerifyEpoch(sessionId: string): void {
    this.verifyEpochs.set(sessionId, (this.verifyEpochs.get(sessionId) || 0) + 1);
  }

  /**
   * REST-verified session_gone (F9b): re-subscribe with the resolveResume
   * discipline (40401 twice, spaced, GET /messages warm-up between), and
   * emit `session_gone` only when absence is double-confirmed AND nothing
   * concurrently re-attached the session (epoch/generation/registry checks
   * before every step). Never inserts into `subscriptions`.
   */
  private async verifyGoneAndNotify(sessionId: string): Promise<void> {
    if (!this.subscriptions.has(sessionId)) return;
    if (this.activeGoneVerifies.has(sessionId)) return;
    this.activeGoneVerifies.add(sessionId);
    const epoch = this.verifyEpochs.get(sessionId) || 0;
    const generation = this.generation;
    const attempts = envInt('AEGIS_KIMI_SERVER_RESUME_ATTEMPTS', 3);
    const retryDelayMs = envInt('AEGIS_KIMI_SERVER_RESUME_RETRY_MS', 500);
    const stale = () =>
      this.stopped ||
      this.generation !== generation ||
      !this.subscriptions.has(sessionId) ||
      (this.verifyEpochs.get(sessionId) || 0) !== epoch;
    try {
      let confirmedMissing = 0;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (stale()) return;
        const subscribed = await this.sendSubscribe([sessionId]).catch(() => null);
        if (subscribed?.accepted) return; // recovered
        if (stale()) return;
        let exists: boolean;
        try {
          exists = await this.sessionExists(sessionId);
        } catch {
          return; // transport trouble proves nothing — leave the thread bound
        }
        if (!exists) {
          confirmedMissing += 1;
          if (confirmedMissing >= 2) break;
        } else {
          confirmedMissing = 0;
          // Lazy-registry warm-up (pinned): a legacy-store session only
          // materializes for WS subscription after one messages load.
          await this.getMessages(sessionId).catch(() => {});
        }
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
      if (stale() || confirmedMissing < 2) return;
      this.emit('session_gone', { sessionId });
    } finally {
      this.activeGoneVerifies.delete(sessionId);
    }
  }

  private failPendingSubscribes(detail: string): void {
    for (const pending of this.pendingSubscribes.values()) {
      clearTimeout(pending.timer);
      pending.reject(new KimiServerTransportError('daemon_unavailable', detail));
    }
    this.pendingSubscribes.clear();
  }

  private scheduleWsReconnect(state: DaemonState): void {
    if (this.stopped || this.state !== state || this.wsReconnectTimer) return;
    const delayMs = this.wsReconnectDelayMs;
    this.wsReconnectDelayMs = Math.min(this.wsReconnectDelayMs * 2, this.reconnectMaxDelayMs);
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      if (this.stopped || this.state !== state) return;
      // The token may have been rotated while we were disconnected (`kimi
      // server rotate-token`): the REST path re-reads on 401, but a WS-only
      // reconnect has no REST traffic — refresh unconditionally or the loop
      // 401s forever mid-turn.
      const freshToken = this.readTokenFileImpl();
      if (freshToken && freshToken !== state.token) {
        state.token = freshToken;
      }
      // Distinguish failure domains: probe REST liveness first. Dead daemon
      // (ECONNREFUSED) goes down the full respawn path via handleDaemonExit.
      void this.fetchImpl(`${state.baseUrl}/api/v1/healthz`, { signal: AbortSignal.timeout(2_000) })
        .then((response) => {
          if (this.stopped || this.state !== state) return;
          if (response.ok) {
            this.connectWebSocket(state);
            return;
          }
          this.handleDaemonExit(state.generation);
        })
        .catch(() => {
          if (this.stopped || this.state !== state) return;
          this.handleDaemonExit(state.generation);
        });
    }, delayMs);
    this.wsReconnectTimer.unref?.();
  }

  private teardownWs(): void {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.wsConnected = false;
    this.failPendingSubscribes('WS torn down');
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }
}
