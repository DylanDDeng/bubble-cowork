import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { createServer } from 'net';
import { getSessionReaderHttpConfig, SESSION_MCP_SERVER_NAME } from '../session-http-server';
import { BROWSER_USE_SERVER_NAME } from '../browser-use';
import {
  createBrowserUseProviderMcpDescriptor,
  type BrowserUseSessionMcpDescriptor,
  type BrowserUseSessionResolver,
} from '../browser-use-http-server';
import { isBrowserUseEnabled } from '../browser-use-permissions';
import {
  resolveOpenCodeBinary,
  startOpenCodeServerProcess,
  type OpenCodeServerProcess,
} from './opencode-server-process';
import {
  OpenCodeV2Client,
  type OpenCodeModelInfo,
  type OpenCodePermissionRule,
  type OpenCodeServerEvent,
} from './opencode-v2-client';

export type OpenCodeClient = OpenCodeV2Client;
export type OpenCodeEventListener = (event: OpenCodeServerEvent) => void;

/** Synthetic event sent to every subscriber when the server process dies. */
export const OPENCODE_SERVER_EXITED_EVENT = 'aegis.server.exited';

/**
 * Tool families Aegis always routes through its approval UI. Applied both as
 * server config and as each session's own (durable) rules: the session copy
 * keeps a turn that another OpenCode server resumes from running tools
 * without approval.
 */
export const OPENCODE_ASK_PERMISSIONS: OpenCodePermissionRule[] = [
  'edit',
  'shell',
  'webfetch',
  'external_directory',
  'doom_loop',
].map((action) => ({ action, resource: '*', effect: 'ask' as const }));

const SERVER_START_TIMEOUT_MS = 15_000;
const MODEL_CATALOG_TIMEOUT_MS = 8_000;
const SHUTDOWN_INTERRUPT_TIMEOUT_MS = 2_000;
const EXECUTION_END_EVENTS = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

type ServerState = {
  client: OpenCodeV2Client;
  password: string;
  process: OpenCodeServerProcess;
  events: AbortController;
  /** Browser Use as configured when the server started (its config is fixed). */
  browserUse: BrowserUseSessionMcpDescriptor | null;
};

function findAvailablePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
          return;
        }
        reject(new Error('Failed to allocate a local OpenCode server port.'));
      });
    });
  });
}

export function getOpenCodeEventSessionId(event: OpenCodeServerEvent): string {
  const data = event.data;
  if (typeof data?.sessionID === 'string') return data.sessionID;
  const form = data?.form as { sessionID?: unknown } | undefined;
  return typeof form?.sessionID === 'string' ? form.sessionID : '';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenCodeServeManager {
  private state: ServerState | null = null;
  private starting: Promise<ServerState> | null = null;
  private readonly listeners = new Map<string, Set<OpenCodeEventListener>>();
  /** Sessions with a turn in flight on our server (an execution claim in OpenCode's DB). */
  private readonly activeExecutions = new Set<string>();
  /** Directories whose provider/model catalog has finished loading. */
  private readonly loadedCatalogs = new Set<string>();
  private readonly catalogWaiters = new Map<string, Set<() => void>>();
  private resolveBrowserSession: BrowserUseSessionResolver | null = null;
  private canRestart: () => boolean = () => false;

  /**
   * Browser Use reaches OpenCode through this server's own config (never the
   * user's opencode.json): `resolve` names the Aegis session from a tool
   * call's request meta, and `canRestart` says when no session would notice
   * a restart that picks up a changed Browser Use setting.
   */
  setBrowserUseHooks(resolve: BrowserUseSessionResolver, canRestart: () => boolean): void {
    this.resolveBrowserSession = resolve;
    this.canRestart = canRestart;
  }

  async getClient(): Promise<OpenCodeClient> {
    const running = this.state;
    if (
      running &&
      Boolean(running.browserUse) !== isBrowserUseEnabled() &&
      this.activeExecutions.size === 0 &&
      this.canRestart()
    ) {
      // The Browser Use setting changed since start and nothing uses this
      // server: restart it with the current config.
      await this.close();
    }
    return (await this.ensureServer()).client;
  }

  /**
   * The model catalog for a directory. The server loads a directory's
   * providers lazily and answers with partial catalogs (and an interim default
   * model) until it announces the full one with `model.updated`.
   */
  async loadModels(directory: string): Promise<{ models: OpenCodeModelInfo[]; defaultModel: OpenCodeModelInfo | null }> {
    const client = await this.getClient();
    const loaded = this.waitForCatalog(directory);
    const early = await client.listModels(directory); // also starts the load
    await loaded;
    const [models, defaultModel] = await Promise.all([
      client.listModels(directory),
      client.defaultModel(directory).catch(() => null),
    ]);
    return { models: models.length > 0 ? models : early, defaultModel };
  }

  private waitForCatalog(directory: string): Promise<void> {
    if (this.loadedCatalogs.has(directory)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.catalogWaiters.get(directory) ?? new Set();
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, MODEL_CATALOG_TIMEOUT_MS);
      waiters.add(done);
      this.catalogWaiters.set(directory, waiters);
    });
  }

  /** Receives this session's events from the shared server stream. */
  subscribe(sessionID: string, listener: OpenCodeEventListener): () => void {
    const set = this.listeners.get(sessionID) ?? new Set();
    set.add(listener);
    this.listeners.set(sessionID, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(sessionID) === set) this.listeners.delete(sessionID);
    };
  }

  /**
   * Stops the server. Turns still running are interrupted first: OpenCode
   * keeps the execution claim of a turn cut off by shutdown, and the user's
   * background OpenCode service resumes such turns when it next starts.
   */
  async close(): Promise<void> {
    const state = this.state;
    this.state = null;
    this.starting = null;
    if (!state) return;
    const sessionIDs = [...this.activeExecutions];
    this.activeExecutions.clear();
    this.loadedCatalogs.clear();
    await Promise.allSettled(
      sessionIDs.map((id) => state.client.interrupt(id, AbortSignal.timeout(SHUTDOWN_INTERRUPT_TIMEOUT_MS)))
    );
    state.events.abort();
    state.browserUse?.dispose();
    state.process.close();
  }

  /**
   * Synchronous variant of close()'s interrupt step for app quit, where async
   * work never finishes. A short-lived Node child makes the HTTP calls.
   */
  interruptActiveExecutionsSync(): void {
    const state = this.state;
    if (!state || this.activeExecutions.size === 0) return;
    const payload = JSON.stringify({
      baseUrl: state.client.baseUrl,
      password: state.password,
      sessionIDs: [...this.activeExecutions],
      timeoutMs: SHUTDOWN_INTERRUPT_TIMEOUT_MS,
    });
    const script = `
      let input = '';
      process.stdin.on('data', (c) => (input += c)).on('end', async () => {
        const { baseUrl, password, sessionIDs, timeoutMs } = JSON.parse(input);
        const authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
        await Promise.allSettled(sessionIDs.map((id) => fetch(new URL('/api/session/' + encodeURIComponent(id) + '/interrupt', baseUrl), {
          method: 'POST', headers: { authorization }, signal: AbortSignal.timeout(timeoutMs),
        })));
      });`;
    try {
      spawnSync(process.execPath, ['-e', script], {
        input: payload,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: SHUTDOWN_INTERRUPT_TIMEOUT_MS + 1_000,
        windowsHide: true,
      });
    } catch (error) {
      console.warn('[OpenCodeServeManager] failed to interrupt running turns on quit:', error);
    }
    this.activeExecutions.clear();
  }

  private async ensureServer(): Promise<ServerState> {
    if (this.state) return this.state;
    if (!this.starting) {
      const starting = this.startServer();
      this.starting = starting;
      starting.then(
        (state) => {
          if (this.starting === starting) this.state = state;
        },
        () => {
          if (this.starting === starting) this.starting = null;
        }
      );
    }
    return this.starting;
  }

  private async startServer(): Promise<ServerState> {
    const binary = await resolveOpenCodeBinary();
    console.log(`[OpenCodeServeManager] starting opencode ${binary.version.raw} from ${binary.path}`);
    const hostname = '127.0.0.1';
    const [port, reader] = await Promise.all([findAvailablePort(hostname), getSessionReaderHttpConfig()]);
    const password = randomBytes(24).toString('base64url');
    const resolve = this.resolveBrowserSession;
    const browserUse =
      resolve && isBrowserUseEnabled()
        ? await createBrowserUseProviderMcpDescriptor(resolve).catch((error) => {
            console.warn('[OpenCodeServeManager] Browser Use unavailable for OpenCode:', error);
            return null;
          })
        : null;
    const serverProcess = await startOpenCodeServerProcess({
      binary: binary.path,
      hostname,
      port,
      password,
      timeout: SERVER_START_TIMEOUT_MS,
      config: {
        permissions: OPENCODE_ASK_PERMISSIONS,
        mcp: {
          servers: {
            [SESSION_MCP_SERVER_NAME]: { type: 'remote', url: reader.url, headers: reader.headers },
            // Inline config merges with the user's own servers. Code mode off:
            // browser_use stays a plain tool, so its calls read as such and
            // carry the calling session in their request meta.
            ...(browserUse
              ? { [BROWSER_USE_SERVER_NAME]: { type: 'remote', url: browserUse.url, headers: browserUse.headers, codemode: false } }
              : {}),
          },
        },
      },
    });
    const client = new OpenCodeV2Client(serverProcess.url, password);
    const events = new AbortController();
    try {
      await client.info();
      const stream = await client.openEventStream(events.signal);
      const state: ServerState = { client, password, process: serverProcess, events, browserUse };
      void this.pumpEvents(state, stream);
      void serverProcess.exited.then((code) => this.handleServerExit(state, code));
      return state;
    } catch (error) {
      events.abort();
      browserUse?.dispose();
      serverProcess.close();
      throw error;
    }
  }

  private async pumpEvents(state: ServerState, firstStream: AsyncIterable<OpenCodeServerEvent>): Promise<void> {
    let stream: AsyncIterable<OpenCodeServerEvent> | null = firstStream;
    let attempt = 0;
    while (!state.events.signal.aborted) {
      if (stream) {
        try {
          for await (const event of stream) {
            attempt = 0;
            this.dispatch(event);
          }
        } catch (error) {
          if (state.events.signal.aborted) return;
          console.warn('[OpenCodeServeManager] event stream error:', error instanceof Error ? error.message : error);
        }
        stream = null;
      }
      if (state.events.signal.aborted) return;
      await sleep(Math.min(5_000, 250 * 2 ** attempt++));
      try {
        stream = await state.client.openEventStream(state.events.signal);
      } catch (error) {
        if (!state.events.signal.aborted) console.warn('[OpenCodeServeManager] event stream reconnect failed:', error);
      }
    }
  }

  private dispatch(event: OpenCodeServerEvent): void {
    if (event.type === 'model.updated' && event.location?.directory) {
      const directory = event.location.directory;
      this.loadedCatalogs.add(directory);
      for (const done of [...(this.catalogWaiters.get(directory) ?? [])]) done();
      this.catalogWaiters.delete(directory);
      return;
    }
    const sessionID = getOpenCodeEventSessionId(event);
    if (!sessionID) return;
    if (event.type === 'session.execution.started') this.activeExecutions.add(sessionID);
    else if (EXECUTION_END_EVENTS.has(event.type)) this.activeExecutions.delete(sessionID);
    for (const listener of [...(this.listeners.get(sessionID) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[OpenCodeServeManager] event listener failed:', error);
      }
    }
  }

  private handleServerExit(state: ServerState, code: number | null): void {
    state.events.abort();
    if (this.state !== state) return;
    this.state = null;
    this.starting = null;
    this.activeExecutions.clear();
    this.loadedCatalogs.clear();
    console.warn(`[OpenCodeServeManager] opencode server exited with code ${code}`);
    const event: OpenCodeServerEvent = { type: OPENCODE_SERVER_EXITED_EVENT, data: { code } };
    for (const set of this.listeners.values()) {
      for (const listener of [...set]) listener(event);
    }
  }
}

let defaultManager: OpenCodeServeManager | null = null;

/** The app-wide server shared by OpenCode sessions and model discovery. */
export function getOpenCodeServeManager(): OpenCodeServeManager {
  defaultManager ??= new OpenCodeServeManager();
  return defaultManager;
}
