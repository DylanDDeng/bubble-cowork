import { createServer } from 'net';
import {
  loadOpenCodeSdk,
  loadOpenCodeV2Sdk,
  type OpenCodeSdkModule,
  type OpenCodeV2SdkModule,
} from './opencode-sdk-loader';

type OpenCodePermissionReplyApi = {
  reply(options: unknown): Promise<unknown>;
};

type OpenCodeQuestionReplyApi = {
  reply(options: unknown): Promise<unknown>;
  reject(options: unknown): Promise<unknown>;
};

type OpenCodeV2Client = {
  permission?: OpenCodePermissionReplyApi;
  question?: OpenCodeQuestionReplyApi;
  session?: {
    permission?: OpenCodePermissionReplyApi;
    question?: OpenCodeQuestionReplyApi;
  };
};

export type OpenCodeClient = {
  session: {
    create(options?: unknown): Promise<unknown>;
    get(options: unknown): Promise<unknown>;
    prompt(options: unknown): Promise<unknown>;
    command(options: unknown): Promise<unknown>;
    abort(options: unknown): Promise<unknown>;
    fork(options: unknown): Promise<unknown>;
  };
  command?: {
    list(options?: unknown): Promise<unknown>;
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
  v2?: OpenCodeV2Client;
};

type OpenCodeServerHandle = {
  url: string;
  close(): void;
};

type OpenCodeServerState = {
  sdk: OpenCodeSdkModule;
  v2Sdk: OpenCodeV2SdkModule | null;
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
    if (state.v2Sdk) {
      client.v2 = state.v2Sdk.createOpencodeClient({
        baseUrl: state.server.url,
        directory,
      }) as OpenCodeV2Client;
    }
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
    const v2Sdk = await loadOpenCodeV2Sdk().catch((error) => {
      console.warn('[OpenCodeServeManager] failed to load OpenCode v2 client:', error);
      return null;
    });
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
    return { sdk, v2Sdk, server };
  }
}
