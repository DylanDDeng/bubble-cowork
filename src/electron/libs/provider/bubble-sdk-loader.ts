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
  listModels(provider: BubbleProviderProfile): Promise<BubbleModelInfo[]>;
};

export type BubbleSdkInstance = {
  readonly registry: BubbleProviderRegistry;
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

export type BubbleSdkModule = {
  BubbleSdk: new (options?: { defaultCwd?: string }) => BubbleSdkInstance;
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
