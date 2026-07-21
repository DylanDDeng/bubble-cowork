import { accessSync, constants as fsConstants } from 'fs';
import { homedir } from 'os';
import { delimiter as pathDelimiter, join } from 'path';

/**
 * Minimal structural types for `@qoder-ai/qoder-agent-sdk` (verified 1.0.15).
 *
 * The SDK ships ESM with its own .d.ts, but Aegis's main process compiles to
 * CommonJS with node module resolution; structural types keep the dynamic
 * import decoupled from the package's type resolution — and let L1 tests
 * inject a fake SDK through setQoderSdkForTests() (kimi-loader seam style,
 * NOT pi's seam-less loader).
 */

export type QoderSdkPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'yolo'
  | 'plan'
  | 'dontAsk'
  | 'auto';

export type QoderContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  source?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  [key: string]: unknown;
};

export type QoderUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** Context window usage ratio for the completed turn (0~1) — the only
   * usage field that carries real data on SDK 1.0.15 (P12: tokens are 0). */
  context_usage_ratio?: number;
  [key: string]: unknown;
};

/** Structurally identical to shared `ClaudeModelUsage` — passthrough on results. */
export type QoderModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
};

export type QoderModelInfo = {
  value: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  isEnabled?: boolean;
  isVl?: boolean;
  priceFactor?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  efforts?: string[];
  defaultEffort?: string;
  availableContextWindows?: number[];
  defaultContextWindow?: number;
  source?: 'system' | 'user';
  [key: string]: unknown;
};

export type QoderSDKUserMessage = {
  type: 'user';
  message: { role: 'user'; content: string | QoderContentBlock[] };
  parent_tool_use_id: string | null;
  [key: string]: unknown;
};

export type QoderAssistantMessage = {
  type: 'assistant';
  message: {
    role?: string;
    content?: string | QoderContentBlock[];
    model?: string;
    usage?: QoderUsage;
  };
  parent_tool_use_id: string | null;
  /** Never terminates a turn (plan: turn-terminal invariant). */
  error?: string;
  uuid?: string;
  session_id?: string;
};

export type QoderUserMessage = {
  type: 'user';
  message: { role?: string; content?: string | QoderContentBlock[] };
  parent_tool_use_id: string | null;
  isReplay?: boolean;
  isSynthetic?: boolean;
  uuid?: string;
  session_id?: string;
};

export type QoderResultMessage = {
  type: 'result';
  subtype:
    | 'success'
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries'
    | string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: QoderUsage;
  modelUsage?: Record<string, QoderModelUsage>;
  result?: string;
  errors?: string[];
  is_error?: boolean;
  stop_reason?: string | null;
  /** `auth_required` marks the startup auth failure (exit 41 baseline). */
  terminal_reason?: string | null;
  uuid?: string;
  session_id?: string;
};

export type QoderSystemInitMessage = {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  permissionMode?: QoderSdkPermissionMode;
  cwd?: string;
  tools?: string[];
  slash_commands?: string[];
  skills?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  uuid?: string;
};

export type QoderStreamEventMessage = {
  type: 'stream_event';
  event: {
    type?: string;
    index?: number;
    delta?: unknown;
    content_block?: QoderContentBlock;
    [key: string]: unknown;
  };
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
};

/** Every `type: 'system'` variant other than init, keyed by `subtype`. */
export type QoderSystemMessage = {
  type: 'system';
  subtype?: string;
  status?: string | null;
  compact_metadata?: { trigger?: 'manual' | 'auto'; pre_tokens?: number };
  attempt?: number;
  max_retries?: number;
  error?: unknown;
  tool_name?: string;
  tool_use_id?: string;
  message?: string;
  permissionMode?: QoderSdkPermissionMode;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
};

/** prompt_suggestion / cloud_agent_event / future variants — dropped on sight. */
export type QoderOtherMessage = {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
};

export type QoderSDKMessage =
  | QoderAssistantMessage
  | QoderUserMessage
  | QoderResultMessage
  | QoderSystemInitMessage
  | QoderStreamEventMessage
  | QoderSystemMessage
  | QoderOtherMessage;

export type QoderPermissionUpdate = { type: string; [key: string]: unknown };

export type QoderCanUseToolOptions = {
  signal: AbortSignal;
  toolUseID: string;
  suggestions?: QoderPermissionUpdate[];
  title?: string;
  decisionReason?: string;
  [key: string]: unknown;
};

export type QoderPermissionDecision =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: QoderPermissionUpdate[];
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export type QoderCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: QoderCanUseToolOptions
) => Promise<QoderPermissionDecision>;

export type QoderQueryOptions = {
  cwd?: string;
  model?: string;
  permissionMode?: QoderSdkPermissionMode;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  includePartialMessages?: boolean;
  canUseTool?: QoderCanUseTool;
  onAuthExpired?: () => void;
  pathToQoderCLIExecutable?: string;
  auth?: unknown;
  maxTurns?: number;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  stderr?: (data: string) => void;
  [key: string]: unknown;
};

/** Quota bucket inside getUsageInfo() (verified 1.0.15). */
export type QoderUsageQuotaBucket = {
  total?: number;
  used?: number;
  remaining?: number;
  percentage?: number;
  unit?: string;
  detailUrl?: string;
  /** orgResourcePackage variant caps with `cap` instead of `total`. */
  cap?: number;
  available?: boolean;
  [key: string]: unknown;
};

/** Account quota payload from getUsageInfo() (verified 1.0.15). */
export type QoderUsageInfo = {
  userId?: string;
  userType?: string;
  totalUsagePercentage?: number;
  isHighestTier?: boolean;
  expiresAt?: number;
  upgradeUrl?: string;
  userQuota?: QoderUsageQuotaBucket;
  addOnQuota?: QoderUsageQuotaBucket;
  orgResourcePackage?: QoderUsageQuotaBucket;
  isQuotaExceeded?: boolean;
  isPlanQuotaProrated?: boolean;
  [key: string]: unknown;
};

export type QoderInitializationResult = {
  models?: QoderModelInfo[];
  commands?: Array<{ name: string; description?: string }>;
  agents?: unknown[];
  skills?: unknown[];
  account?: { subscriptionType?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type QoderQuery = AsyncIterable<QoderSDKMessage> & {
  interrupt(): Promise<void>;
  close(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: QoderSdkPermissionMode): Promise<void>;
  initializationResult(): Promise<QoderInitializationResult>;
  /** Account quota/usage; null when unauthenticated. Optional so L1 fakes can omit it. */
  getUsageInfo?(): Promise<QoderUsageInfo | null>;
  generateSessionTitle(
    description: string,
    options?: { persist?: boolean }
  ): Promise<string | null | undefined>;
};

export type QoderForkSessionOptions = {
  /** Restrict the session search to this working directory. */
  dir?: string;
  upToMessageId?: string;
  title?: string;
};

export type QoderSdkModule = {
  query(params: {
    prompt: string | AsyncIterable<QoderSDKUserMessage>;
    options?: QoderQueryOptions;
  }): QoderQuery;
  qodercliAuth(): unknown;
  forkSession(
    sessionId: string,
    options?: QoderForkSessionOptions
  ): Promise<{ sessionId: string }>;
};

const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<QoderSdkModule>;

let sdkPromise: Promise<QoderSdkModule> | null = null;
let injectedSdk: QoderSdkModule | null = null;

/**
 * Test seam (L1): inject a fake SDK module; pass null to restore the real
 * dynamic import. Resets the module-level promise cache both ways.
 */
export function setQoderSdkForTests(fake: QoderSdkModule | null): void {
  injectedSdk = fake;
  sdkPromise = null;
}

export function loadQoderSdk(): Promise<QoderSdkModule> {
  if (injectedSdk) {
    return Promise.resolve(injectedSdk);
  }
  if (!sdkPromise) {
    sdkPromise = importEsm('@qoder-ai/qoder-agent-sdk');
  }
  return sdkPromise;
}

// ── Machine qodercli detection ─────────────────────────────────────────────

const MACHINE_CLI_NAMES = ['qodercli', 'qoder'];

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function withWindowsAliases(names: string[]): string[] {
  if (process.platform !== 'win32') {
    return names;
  }
  return names.flatMap((name) => [name, `${name}.exe`, `${name}.cmd`]);
}

/**
 * Locate the machine's own qodercli (production requirement: Qoder installed
 * locally, same as Claude/Codex/OpenCode — the SDK-bundled binary is a
 * dev-only fallback the adapter only reaches when this returns null).
 */
export function findMachineQoderCli(): string | null {
  // Explicit env override wins; the SDK honors the same variable.
  const envPath = process.env.QODERCLI_PATH?.trim();
  if (envPath && isExecutable(envPath)) {
    return envPath;
  }

  // Well-known install locations. These run before the PATH scan because
  // macOS GUI apps inherit a sparse PATH (/usr/bin:/bin:…) that user-level
  // installers (~/.local/bin, homebrew) never touch.
  const home = homedir();
  const candidates = [
    join(home, '.local', 'bin', 'qodercli'),
    '/usr/local/bin/qodercli',
    '/usr/local/bin/qoder',
    '/opt/homebrew/bin/qodercli',
    '/opt/homebrew/bin/qoder',
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of withWindowsAliases(MACHINE_CLI_NAMES)) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
