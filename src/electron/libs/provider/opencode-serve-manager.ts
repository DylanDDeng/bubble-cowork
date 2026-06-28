import { createServer } from 'net';
import { loadOpenCodeSdk, type OpenCodeSdkModule } from './opencode-sdk-loader';

export type OpenCodeClient = {
  session: {
    create(options?: unknown): Promise<unknown>;
    get(options: unknown): Promise<unknown>;
    prompt(options: unknown): Promise<unknown>;
    abort(options: unknown): Promise<unknown>;
  };
  config?: {
    providers(options?: unknown): Promise<unknown>;
  };
  event: {
    subscribe(options?: unknown): Promise<{ stream: AsyncGenerator<unknown> }>;
  };
  mcp?: {
    status(options?: unknown): Promise<unknown>;
  };
  postSessionIdPermissionsPermissionId(options: unknown): Promise<unknown>;
};

type OpenCodeServerHandle = {
  url: string;
  close(): void;
};

type OpenCodeServerState = {
  sdk: OpenCodeSdkModule;
  server: OpenCodeServerHandle;
};

function buildDefaultOpenCodeConfig(): Record<string, unknown> {
  return {
    permission: {
      edit: 'ask',
      bash: 'ask',
      webfetch: 'ask',
      doom_loop: 'ask',
      external_directory: 'ask',
    },
  };
}

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
        reject(new Error('Failed to allocate a local OpenCode SDK server port.'));
      });
    });
  });
}

export class OpenCodeServeManager {
  private serverState: OpenCodeServerState | null = null;
  private serverPromise: Promise<OpenCodeServerState> | null = null;
  private abortController: AbortController | null = null;

  async getClient(directory: string): Promise<OpenCodeClient> {
    const state = await this.ensureServer();
    const client = state.sdk.createOpencodeClient({
      baseUrl: state.server.url,
      directory,
    }) as OpenCodeClient;
    return client;
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.serverPromise = null;
    const state = this.serverState;
    this.serverState = null;
    state?.server.close();
  }

  private async ensureServer(): Promise<OpenCodeServerState> {
    if (this.serverState) {
      return this.serverState;
    }
    if (this.serverPromise) {
      return this.serverPromise;
    }

    this.serverPromise = this.startServer();
    try {
      this.serverState = await this.serverPromise;
      return this.serverState;
    } catch (error) {
      this.serverPromise = null;
      throw error;
    }
  }

  private async startServer(): Promise<OpenCodeServerState> {
    const sdk = await loadOpenCodeSdk();
    const hostname = '127.0.0.1';
    const port = await findAvailablePort(hostname);
    this.abortController = new AbortController();
    const server = await sdk.createOpencodeServer({
      hostname,
      port,
      signal: this.abortController.signal,
      timeout: 15_000,
      config: buildDefaultOpenCodeConfig(),
    });
    return { sdk, server };
  }
}
