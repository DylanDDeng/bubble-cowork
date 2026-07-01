export type PiUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    total?: number;
  };
};

export type PiModel = {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
};

export type PiToolCallBlock = { type: 'toolCall'; id?: string; name?: string; arguments?: Record<string, unknown> };

export type PiContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; thinkingSignature?: string }
  | PiToolCallBlock;

export type PiAgentMessage = {
  role?: string;
  content?: string | PiContentBlock[];
  provider?: string;
  model?: string;
  usage?: PiUsage;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
};

export type PiAgentSessionEvent =
  | { type: 'message_update'; message: PiAgentMessage; assistantMessageEvent?: Record<string, unknown> }
  | { type: 'message_end'; message: PiAgentMessage }
  | { type: 'agent_end'; messages: PiAgentMessage[]; willRetry?: boolean }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'turn_end'; message: PiAgentMessage; toolResults: unknown[] }
  | { type: 'context'; messages: PiAgentMessage[] }
  | { type: string; [key: string]: unknown };

export type PiImageContent = {
  type: 'image';
  data: string;
  mimeType: string;
};

export type PiAgentSession = {
  sessionId: string;
  model?: PiModel;
  sessionFile?: string;
  messages?: PiAgentMessage[];
  subscribe(listener: (event: PiAgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { images?: PiImageContent[]; streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  setModel?(model: PiModel): Promise<void>;
  getActiveToolNames?(): string[];
};

export type PiSessionManager = unknown;
export type PiAuthStorage = unknown;
export type PiModelRegistry = {
  find(provider: string, modelId: string): PiModel | undefined;
};

export type PiSdkModule = {
  createAgentSession(options?: Record<string, unknown>): Promise<{ session: PiAgentSession }>;
  AuthStorage: {
    create(authPath?: string): PiAuthStorage;
  };
  ModelRegistry: {
    create(authStorage: PiAuthStorage, modelsJsonPath?: string): PiModelRegistry;
  };
  SessionManager: {
    create(cwd: string, sessionDir?: string, options?: { id?: string }): PiSessionManager;
    open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManager;
    list(cwd: string, sessionDir?: string): Promise<Array<{ id: string; path: string }>>;
  };
};

const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<PiSdkModule>;

let sdkPromise: Promise<PiSdkModule> | null = null;

function ensurePiSdkNodeCompat(): void {
  try {
    // Electron's bundled Node can lack `worker_threads.markAsUncloneable`, which the Pi
    // SDK's bundled undici destructures at load time (undici/lib/web/webidl/index.js) and
    // crashes on ("webidl.util.markAsUncloneable is not a function") if it's missing.
    // Polyfill it before the SDK — and therefore undici — is imported.
    //
    // Use the module-scoped CommonJS `require` (this file is compiled to CommonJS for the
    // Electron main process). Grabbing require via `new Function('return require')()` throws
    // "require is not defined" in the Electron main process, so the polyfill previously never
    // applied and the Pi SDK failed to load entirely.
    const workerThreads = require('node:worker_threads') as {
      markAsUncloneable?: (value: unknown) => void;
    };
    if (typeof workerThreads.markAsUncloneable !== 'function') {
      workerThreads.markAsUncloneable = () => {};
    }
  } catch {
    // If the polyfill can't be applied, let the SDK import surface the real failure.
  }
}

// Resolve the Pi agent config directory that actually holds the user's credentials.
//
// An orchestration layer ("orca") launches the app with PI_CODING_AGENT_DIR pointed at a
// per-session overlay whose auth.json is empty ("{}"), which makes Pi's default
// getAgentDir() resolve to a directory with no credentials ("No API key found ..."). It
// exposes the user's real agent dir via ORCA_PI_SOURCE_AGENT_DIR, so prefer that; fall
// back to the standard ~/.pi/agent. We deliberately ignore the overlay PI_CODING_AGENT_DIR
// so Aegis always talks to the user's real Pi setup.
export function resolvePiAgentDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { homedir } = require('node:os') as { homedir: () => string };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as { join: (...parts: string[]) => string };
  const source = process.env.ORCA_PI_SOURCE_AGENT_DIR?.trim();
  if (source) {
    return source;
  }
  return join(homedir(), '.pi', 'agent');
}

// Create Pi's AuthStorage + ModelRegistry bound to the real agent dir (see resolvePiAgentDir).
export function createPiAuthAndRegistry(sdk: PiSdkModule): {
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as { join: (...parts: string[]) => string };
  const agentDir = resolvePiAgentDir();
  const authStorage = sdk.AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = sdk.ModelRegistry.create(authStorage, join(agentDir, 'models.json'));
  return { authStorage, modelRegistry };
}

let proxyDispatcherApplied = false;

// Pi's model calls use the global `fetch` (undici), which — unlike curl and the Pi CLI —
// ignores the http_proxy/https_proxy environment variables by default. On networks where
// a provider endpoint is only reachable through a proxy (e.g. chatgpt.com for openai-codex
// behind a local proxy), that makes the direct connection fail with ECONNRESET ("fetch
// failed"). When a proxy is configured in the environment, install undici's
// EnvHttpProxyAgent as the global dispatcher so global fetch honors it (NO_PROXY respected).
function ensurePiProxyDispatcher(): void {
  if (proxyDispatcherApplied) {
    return;
  }
  proxyDispatcherApplied = true;
  const proxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY;
  if (!proxy) {
    return;
  }
  try {
    // undici's setGlobalDispatcher targets the same global dispatcher that Node's built-in
    // fetch reads, so any resolvable undici works. (The Pi SDK bundles one.)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const undici = require('undici') as {
      setGlobalDispatcher?: (dispatcher: unknown) => void;
      EnvHttpProxyAgent?: new () => unknown;
    };
    if (undici.setGlobalDispatcher && undici.EnvHttpProxyAgent) {
      undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
      console.log('[pi-sdk-loader] Installed EnvHttpProxyAgent so Pi fetch honors the system proxy.');
    }
  } catch (error) {
    console.warn('[pi-sdk-loader] Failed to install proxy dispatcher for Pi fetch:', error);
  }
}

export function loadPiSdk(): Promise<PiSdkModule> {
  if (!sdkPromise) {
    ensurePiSdkNodeCompat();
    // Install the proxy dispatcher AFTER the SDK import resolves: importing the Pi SDK
    // pulls in its own bundled undici, which resets the global dispatcher during init and
    // would otherwise clobber a proxy agent set beforehand.
    sdkPromise = importEsm('@earendil-works/pi-coding-agent').then((sdk) => {
      ensurePiProxyDispatcher();
      return sdk;
    });
  }
  return sdkPromise;
}
