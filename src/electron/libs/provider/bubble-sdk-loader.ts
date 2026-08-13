/**
 * Bubble SDK loader.
 *
 * Bubble (@bubblebrain-ai/bubble) ships as an ESM-only package while the
 * Electron main process is compiled to CommonJS, so — like the Pi loader —
 * we go through a dynamic import() that TypeScript can't rewrite into a
 * require() call.
 *
 * The types below are hand-declared structural mirrors of
 * node_modules/@bubblebrain-ai/bubble/dist/sdk/index.d.ts (the repo pattern
 * for ESM SDKs consumed from CJS). Open sets (thinking levels, tool result
 * status, provider ids) are kept as plain strings on purpose.
 */

export type BubbleContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type BubbleTokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

/** Priced usage attached to turn_end when the model has pricing configured. */
export type BubbleUsageCost = {
  currency: 'USD' | 'CNY';
  cost: number;
  /** True when the provider gave no cache breakdown and everything was billed at the miss rate. */
  estimated: boolean;
};

export type BubbleTodo = {
  content: string;
  status: string;
  activeForm: string;
};

export type BubbleToolResult = {
  content: string;
  isError?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
};

export type BubbleAgentEvent =
  | { type: 'turn_start' }
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; name: string; argumentsDelta: string; arguments: string }
  | { type: 'tool_call_end'; id: string; name: string; arguments: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_update'; id: string; name: string; update: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; result: BubbleToolResult }
  | { type: 'turn_end'; usage?: BubbleTokenUsage; cost?: BubbleUsageCost; willContinue?: boolean }
  | { type: 'mode_changed'; mode: string }
  | { type: 'todos_updated'; todos: BubbleTodo[] }
  | { type: 'agent_end' }
  | { type: string; [key: string]: unknown };

/** Tool-typed approval payload (bash / edit / write / patch / …). */
export type BubbleApprovalRequest = { type: string } & Record<string, unknown>;

export type BubbleApprovalDecision = {
  action: 'approve' | 'reject';
  feedback?: string;
};

export type BubbleQuestionOption = { label: string; description: string };

export type BubbleQuestionPrompt = {
  header: string;
  question: string;
  options: BubbleQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

export type BubbleQuestionRequest = {
  id: string;
  sessionID?: string;
  questions: BubbleQuestionPrompt[];
  createdAt?: number;
};

/** One string[] of selected labels per question, in question order. */
export type BubbleQuestionAnswer = string[];

export type BubbleTurnStartInfo = {
  providerId: string;
  model: string;
  thinkingLevel: string;
  mode: string;
  tools: string[];
  skills: string[];
};

export type BubbleRunTurnOptions = {
  prompt: string | BubbleContentPart[];
  model?: string;
  mode?: string;
  thinkingLevel?: string;
  signal?: AbortSignal;
  onStart?: (info: BubbleTurnStartInfo) => void;
  onApproval?: (req: BubbleApprovalRequest) => Promise<BubbleApprovalDecision>;
  onQuestion?: (req: BubbleQuestionRequest) => Promise<BubbleQuestionAnswer[] | null>;
  onPlanApproval?: (planMarkdown: string) => Promise<boolean>;
};

export type BubbleSessionSummary = {
  file: string;
  /** The session id. */
  name: string;
  cwd?: string;
  cwdLabel: string;
  title: string;
  preview: string;
  firstUserMessage: string;
  messageCount: number;
  mtime: number;
};

export type BubbleSkillSummary = {
  name: string;
  description: string;
  tags?: string[];
  source?: string;
};

export type BubbleProviderProfile = {
  id: string;
  name?: string;
  baseURL?: string;
  enabled?: boolean;
} & Record<string, unknown>;

export type BubbleModelInfo = {
  id: string;
  name?: string;
  providerId?: string;
  reasoningLevels?: string[];
  defaultReasoningLevel?: string;
  contextWindow?: number;
};

export type BubbleModelConfig = {
  defaultProviderId: string;
  defaultModel: string;
  providers: Array<{ id: string; baseURL?: string; hasApiKey: boolean }>;
};

export type BubbleProviderRegistry = {
  getConfigured(): BubbleProviderProfile[];
  getEnabled(): BubbleProviderProfile[];
  getDefault(): BubbleProviderProfile | undefined;
  setDefault(id: string): void;
  /** Adds (or replaces) a builtin provider with the given key; false for unknown ids. */
  addProvider(id: string, apiKey: string): boolean;
  removeProvider(id: string): void;
  updateProviderKey(id: string, apiKey: string): void;
  listModels(provider: BubbleProviderProfile): Promise<BubbleModelInfo[]>;
  /**
   * Local-only model list: the user's models.json custom models when present,
   * otherwise the SDK's builtin static catalog. Synchronous — never touches
   * the network, so it backs the picker's first frame.
   */
  localModelsForProvider(provider: BubbleProviderProfile): BubbleModelInfo[];
};

export type BubbleSdkInstance = {
  readonly registry: BubbleProviderRegistry;
  readonly userConfig: {
    getProviders(): BubbleProviderProfile[];
    setProviders(providers: BubbleProviderProfile[]): void;
  };
  listSessions(): BubbleSessionSummary[];
  createSession(options?: { cwd?: string; id?: string }): { id: string; cwd: string };
  getHistory(sessionId: string): unknown[];
  deleteSession(sessionId: string): void;
  /** Abort the in-flight turn of a session, if any. */
  stop(sessionId: string): void;
  listSkills(cwd?: string): BubbleSkillSummary[];
  getModelConfig(): BubbleModelConfig;
  runTurn(sessionId: string, options: BubbleRunTurnOptions): AsyncGenerator<BubbleAgentEvent>;
};

/**
 * Structural mirror of the SDK's SessionManager surface, used by the adapter
 * to run manual `/compact` and `/rewind` outside of a live turn. The SDK
 * re-exports SessionManager from its main entry; we reconstruct it from the
 * on-disk session file (keyed by the adapter's providerSessionId).
 */
export type BubbleCompactResult = {
  compacted: boolean;
  summary?: string;
  droppedEntries?: number;
};

export type BubbleUserTurn = {
  /** Session log entry id that anchors /rewind (also the checkpoint turn). */
  id: string;
  preview: string;
  text: string;
  timestamp: number;
};

export type BubbleCheckpointStore = {
  /** Unique files first captured during exactly the given turn. */
  filesTouchedAt(turn: string): string[];
  /** Unique files first captured at or after the given turn (rewind preview). */
  filesTouchedSince(turn: string): string[];
  restoreTo(turn: string): Promise<{
    restored: string[];
    deleted: string[];
    failed: string[];
  }>;
};

export type BubbleSessionManager = {
  getMessages(): unknown[];
  getCompactionPlan(): { oldMessages: unknown[] } | null;
  compact(): BubbleCompactResult;
  applyLLMCompaction(summary: string): BubbleCompactResult;
  getCheckpoints(): BubbleCheckpointStore;
  listUserTurns(): BubbleUserTurn[];
  rewindToEntry(entryId: string): { removedEntries: number; targetText: string } | undefined;
  getSessionFile(): string;
};

export type BubbleSdkModule = {
  BubbleSdk: new (options?: { defaultCwd?: string }) => BubbleSdkInstance;
  SessionManager: new (file: string) => BubbleSessionManager;
};

export type BubbleBuiltinProviderDefinition = {
  id: string;
  name: string;
  baseURL: string;
  hidden?: boolean;
  supportsOAuth?: boolean;
} & Record<string, unknown>;

// The builtin provider catalog lives one module below the SDK facade; the
// package's exports map explicitly opens "./dist/*", so this is public API.
export type BubbleProviderCatalogModule = {
  BUILTIN_PROVIDERS: BubbleBuiltinProviderDefinition[];
  USER_VISIBLE_PROVIDER_IDS: string[];
  isUserVisibleProvider(providerId: string): boolean;
};

// Resolve the Bubble home directory that holds the user's config.json
// (provider credentials). Mirrors the SDK's own resolution: BUBBLE_HOME wins,
// otherwise ~/.bubble.
export function resolveBubbleHome(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { homedir } = require('node:os') as { homedir: () => string };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as { join: (...parts: string[]) => string };
  const explicitHome = process.env.BUBBLE_HOME?.trim();
  if (explicitHome) {
    return explicitHome;
  }
  return join(homedir(), '.bubble');
}

const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<BubbleSdkModule>;

let sdkPromise: Promise<BubbleSdkModule> | null = null;
let sdkInstance: BubbleSdkInstance | null = null;

export function loadBubbleSdk(): Promise<BubbleSdkModule> {
  if (!sdkPromise) {
    sdkPromise = importEsm('@bubblebrain-ai/bubble');
    sdkPromise.catch(() => {
      sdkPromise = null;
    });
  }
  return sdkPromise;
}

let catalogPromise: Promise<BubbleProviderCatalogModule> | null = null;

export function loadBubbleProviderCatalog(): Promise<BubbleProviderCatalogModule> {
  if (!catalogPromise) {
    catalogPromise = (importEsm as unknown as (s: string) => Promise<BubbleProviderCatalogModule>)(
      '@bubblebrain-ai/bubble/dist/provider-registry.js'
    );
    catalogPromise.catch(() => {
      catalogPromise = null;
    });
  }
  return catalogPromise;
}

/**
 * Process-wide BubbleSdk facade. One instance owns the on-disk session index,
 * per-session bash allowlists, and active-turn abort handles, so every thread
 * must share it (per-thread instances would fork that state).
 */
export async function getBubbleSdk(defaultCwd?: string): Promise<BubbleSdkInstance> {
  if (!sdkInstance) {
    const { BubbleSdk } = await loadBubbleSdk();
    sdkInstance = new BubbleSdk(defaultCwd ? { defaultCwd } : undefined);
  }
  return sdkInstance;
}

/**
 * Reconstruct the SDK's SessionManager for an adapter session so manual
 * `/compact` / `/rewind` can mutate the same on-disk log the live turns
 * append to. The providerSessionId is the session file's basename (minus
 * `.jsonl`), which `sdk.listSessions()` reports as `name`.
 */
export async function getBubbleSessionManager(
  sdk: BubbleSdkInstance,
  sessionId: string
): Promise<BubbleSessionManager> {
  const { SessionManager } = await loadBubbleSdk();
  const normalized = sessionId.trim();
  if (normalized) {
    try {
      const match = sdk.listSessions().find((summary) => summary.name === normalized);
      if (match) {
        return new SessionManager(match.file);
      }
    } catch (error) {
      console.warn('[BubbleSdk] failed to resolve session for manager:', error);
    }
  }
  // A fresh session is persisted lazily (nothing on disk before the first
  // message), so `/compact` / `/rewind` only ever run against a session that
  // already has a discoverable on-disk file.
  throw new Error(`Unknown Bubble session "${sessionId}" on disk.`);
}

/**
 * Re-read Bubble's on-disk config into the shared SDK instance.
 *
 * The SDK parses ~/.bubble/config.json (UserConfig) and models.json
 * (ModelConfig) exactly once at construction and caches them. A transient
 * read at app startup — e.g. the Bubble CLI or a second Aegis instance
 * rewriting config.json non-atomically at that moment — freezes an empty
 * catalog for the whole process (the composer then shows "No models
 * configured" until restart). Config views call this before reading so the
 * UI always reflects the on-disk truth.
 *
 * UserConfig.load() wipes `data` to {} on a parse error, so we keep a
 * last-known-good snapshot and only accept a reload whose providers array is
 * still present (a legitimate "remove every provider" write yields
 * providers: []; a mid-write JSON parse error yields no providers key).
 * ModelConfig.load() keeps old data on error, so it is safe unconditionally.
 */
export function reloadBubbleSdkConfig(sdk: BubbleSdkInstance): void {
  const userConfig = sdk.userConfig as unknown as {
    load?: () => void;
    data?: { providers?: unknown };
  };
  if (typeof userConfig.load === 'function') {
    const previous = userConfig.data;
    const hadProviders =
      Array.isArray(previous?.providers) && previous.providers.length > 0;
    try {
      userConfig.load();
    } catch {
      // keep previous state
    }
    const nextProviders = (userConfig.data as { providers?: unknown } | undefined)?.providers;
    if (previous && hadProviders && !Array.isArray(nextProviders)) {
      (userConfig as { data?: unknown }).data = previous;
    }
  }
  const registry = sdk.registry as unknown as { modelConfig?: { load?: () => void } };
  try {
    registry.modelConfig?.load?.();
  } catch {
    // keep previous state
  }
}
