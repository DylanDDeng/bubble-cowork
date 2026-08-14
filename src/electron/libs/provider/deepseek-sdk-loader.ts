/**
 * DeepSeek Harness SDK loader.
 *
 * @deepseek-ai/dsh-sdk-client ships as an ESM-only package while the Electron
 * main process is compiled to CommonJS, so — like the Pi and Bubble loaders —
 * we go through a dynamic import() that TypeScript can't rewrite into a
 * require() call.
 *
 * The types below are hand-declared structural mirrors of
 * node_modules/@deepseek-ai/dsh-sdk-client/lib/types/*.d.ts (the repo pattern
 * for ESM SDKs consumed from CJS). Session-log event vocabulary (event types,
 * chunk kinds, content-block types) is an open set owned by the runtime's
 * plugins and is deliberately typed as plain records here.
 */

export interface DshHarnessClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /** Complete child environment; undefined inherits the parent env verbatim. */
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  disposeEofGraceMs?: number;
  disposeGraceMs?: number;
}

export interface DshHarnessOptions {
  launch: DshHarnessClientOptions;
  /** Workspace cwd recorded on every SDK-created session. */
  cwd?: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
}

export type DshContentBlock = { type: 'text'; text: string } & Record<string, unknown>;

/** Full session-log event envelope (type + seq/time + data payload). */
export interface DshSessionEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
}

export interface DshHarnessNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface DshRunResult {
  sessionId: string;
  finalResponse: string;
  events: DshSessionEvent[];
  notifications: DshHarnessNotification[];
}

export interface DshRunOptions {
  sessionId?: string;
  onNotification?: (notification: DshHarnessNotification) => void;
}

export interface DshHarnessSession {
  readonly id: string;
  run(
    input: string | DshContentBlock[],
    options?: Pick<DshRunOptions, 'onNotification'>
  ): Promise<DshRunResult>;
}

export interface DshNotificationSubscription extends AsyncIterable<DshHarnessNotification> {
  next(): Promise<DshHarnessNotification>;
  tryNext(): DshHarnessNotification | undefined;
  close(): void;
}

export interface DshHarnessClient {
  /** Queue one prompt (durable enqueue receipt); never waits for the turn. */
  prompt(sessionId: string, contentBlocks: DshContentBlock[]): Promise<string>;
  /** Root session + descendants discovered from subagent.started lineage. */
  subscribeSessionTree(sessionId: string): DshNotificationSubscription;
}

export interface DshHarness {
  start(): Promise<void>;
  session(sessionId?: string): DshHarnessSession;
  run(input: string | DshContentBlock[], options?: DshRunOptions): Promise<DshRunResult>;
  close(): Promise<void>;
  readonly client: DshHarnessClient;
}

export interface DeepseekSdkModule {
  DeepSeekHarness: new (options: DshHarnessOptions) => DshHarness;
}

const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<DeepseekSdkModule>;

let modulePromise: Promise<DeepseekSdkModule> | null = null;

export function loadDeepseekSdk(): Promise<DeepseekSdkModule> {
  if (!modulePromise) {
    modulePromise = importEsm('@deepseek-ai/dsh-sdk-client');
  }
  return modulePromise;
}
