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
    const requireFromCjs = new Function('return require')() as NodeRequire;
    const workerThreads = requireFromCjs('node:worker_threads') as {
      markAsUncloneable?: (value: unknown) => void;
    };
    if (typeof workerThreads.markAsUncloneable !== 'function') {
      workerThreads.markAsUncloneable = () => {};
    }
  } catch {
    // If require is unavailable, let the SDK import surface the real failure.
  }
}

export function loadPiSdk(): Promise<PiSdkModule> {
  if (!sdkPromise) {
    ensurePiSdkNodeCompat();
    sdkPromise = importEsm('@earendil-works/pi-coding-agent');
  }
  return sdkPromise;
}
