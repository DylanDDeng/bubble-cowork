export const DEFAULT_TERMINAL_ID = 'default';
export const DEFAULT_TERMINAL_COLS = 120;
export const DEFAULT_TERMINAL_ROWS = 30;
export const MIN_TERMINAL_COLS = 20;
export const MAX_TERMINAL_COLS = 400;
export const MIN_TERMINAL_ROWS = 5;
export const MAX_TERMINAL_ROWS = 200;
export const MAX_TERMINAL_ID_LENGTH = 128;
export const MAX_TERMINAL_ENV_KEYS = 128;
export const MAX_TERMINAL_ENV_KEY_LENGTH = 128;
export const MAX_TERMINAL_ENV_VALUE_LENGTH = 8192;
export const MAX_TERMINAL_WRITE_LENGTH = 65536;

export type TerminalAgentKind = 'shell' | 'claude' | 'codex' | 'opencode';
export type ManagedTerminalAgentKind = 'claude' | 'codex';
export type TerminalCliKind = ManagedTerminalAgentKind | 'opencode';
export type TerminalActivityState = 'idle' | 'running' | 'attention' | 'review';
export type TerminalAgentEventName = 'start' | 'stop' | 'permission-request' | 'review';
export type TerminalSessionStatus = 'starting' | 'running' | 'exited' | 'error';

export type TerminalThreadInput = {
  threadId: string;
};

export type TerminalSessionInput = TerminalThreadInput & {
  terminalId?: string;
};

export type TerminalOpenInput = TerminalSessionInput & {
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  agentKind?: TerminalAgentKind;
};

export type TerminalWriteInput = TerminalSessionInput & {
  data: string;
};

export type TerminalResizeInput = Required<TerminalSessionInput> & {
  cols: number;
  rows: number;
};

export type TerminalClearInput = TerminalSessionInput;

export type TerminalRestartInput = Required<TerminalSessionInput> & {
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  agentKind?: TerminalAgentKind;
};

export type TerminalCloseInput = TerminalThreadInput & {
  terminalId?: string;
  deleteHistory?: boolean;
};

export type TerminalSessionSnapshot = {
  threadId: string;
  terminalId: string;
  cwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | string | null;
  updatedAt: string;
  cols: number;
  rows: number;
  agentKind: TerminalAgentKind;
};

export type TerminalStartedEvent = {
  type: 'started';
  threadId: string;
  terminalId: string;
  createdAt: string;
  snapshot: TerminalSessionSnapshot;
};

export type TerminalOutputEvent = {
  type: 'output';
  threadId: string;
  terminalId: string;
  createdAt: string;
  data: string;
};

export type TerminalExitedEvent = {
  type: 'exited';
  threadId: string;
  terminalId: string;
  createdAt: string;
  exitCode: number | null;
  exitSignal: number | string | null;
};

export type TerminalErrorEvent = {
  type: 'error';
  threadId: string;
  terminalId: string;
  createdAt: string;
  message: string;
};

export type TerminalClearedEvent = {
  type: 'cleared';
  threadId: string;
  terminalId: string;
  createdAt: string;
};

export type TerminalRestartedEvent = {
  type: 'restarted';
  threadId: string;
  terminalId: string;
  createdAt: string;
  snapshot: TerminalSessionSnapshot;
};

export type TerminalActivityEvent = {
  type: 'activity';
  threadId: string;
  terminalId: string;
  createdAt: string;
  hasRunningSubprocess: boolean;
  cliKind: TerminalCliKind | null;
  agentState: Exclude<TerminalActivityState, 'idle'> | null;
  event?: TerminalAgentEventName;
  exitCode?: number | null;
};

export type TerminalEvent =
  | TerminalStartedEvent
  | TerminalOutputEvent
  | TerminalExitedEvent
  | TerminalErrorEvent
  | TerminalClearedEvent
  | TerminalRestartedEvent
  | TerminalActivityEvent;

export type TerminalEventPayload = TerminalEvent;

export type TerminalRpcResult = {
  ok: boolean;
  message?: string;
};

export type TerminalOpenResult =
  | {
      ok: true;
      snapshot: TerminalSessionSnapshot;
      launchCommand?: string;
    }
  | {
      ok: false;
      message: string;
    };

export type TerminalTransportInfo = {
  ok: boolean;
  url?: string;
  token?: string;
  message?: string;
};

export type StartTerminalSessionResult = {
  ok: boolean;
  history?: string;
  message?: string;
  launchCommand?: string;
  managedByServer?: boolean;
  snapshot?: TerminalSessionSnapshot;
};

export type TerminalStartInput = {
  sessionId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  agentKind?: TerminalAgentKind;
};

export type TerminalStopInput = {
  sessionId: string;
};

export type TerminalValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function validateNonEmptyString(value: unknown, label: string): TerminalValidationResult<string> {
  const trimmed = trimString(value);
  if (!trimmed) {
    return { ok: false, message: `Missing ${label}.` };
  }
  return { ok: true, value: trimmed };
}

function validateTerminalId(value: unknown): TerminalValidationResult<string> {
  const terminalId = value == null ? DEFAULT_TERMINAL_ID : trimString(value);
  if (!terminalId) {
    return { ok: false, message: 'Missing terminal id.' };
  }
  if (terminalId.length > MAX_TERMINAL_ID_LENGTH) {
    return { ok: false, message: `Terminal id must be at most ${MAX_TERMINAL_ID_LENGTH} characters.` };
  }
  return { ok: true, value: terminalId };
}

export function normalizeTerminalSize(cols?: unknown, rows?: unknown): { cols: number; rows: number } {
  return {
    cols: clampTerminalCols(cols),
    rows: clampTerminalRows(rows),
  };
}

export function clampTerminalCols(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_TERMINAL_COLS;
  return Math.min(MAX_TERMINAL_COLS, Math.max(MIN_TERMINAL_COLS, numeric));
}

export function clampTerminalRows(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_TERMINAL_ROWS;
  return Math.min(MAX_TERMINAL_ROWS, Math.max(MIN_TERMINAL_ROWS, numeric));
}

function validateExactCols(value: unknown): TerminalValidationResult<number> {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, message: 'Terminal cols must be an integer.' };
  }
  if (value < MIN_TERMINAL_COLS || value > MAX_TERMINAL_COLS) {
    return {
      ok: false,
      message: `Terminal cols must be between ${MIN_TERMINAL_COLS} and ${MAX_TERMINAL_COLS}.`,
    };
  }
  return { ok: true, value };
}

function validateExactRows(value: unknown): TerminalValidationResult<number> {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, message: 'Terminal rows must be an integer.' };
  }
  if (value < MIN_TERMINAL_ROWS || value > MAX_TERMINAL_ROWS) {
    return {
      ok: false,
      message: `Terminal rows must be between ${MIN_TERMINAL_ROWS} and ${MAX_TERMINAL_ROWS}.`,
    };
  }
  return { ok: true, value };
}

function validateEnv(value: unknown): TerminalValidationResult<Record<string, string> | undefined> {
  if (value == null) return { ok: true, value: undefined };
  if (!isPlainObject(value)) {
    return { ok: false, message: 'Terminal env must be an object.' };
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_TERMINAL_ENV_KEYS) {
    return { ok: false, message: `Terminal env can contain at most ${MAX_TERMINAL_ENV_KEYS} keys.` };
  }

  const env: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > MAX_TERMINAL_ENV_KEY_LENGTH) {
      return { ok: false, message: `Invalid terminal env key: ${key}` };
    }
    if (typeof rawValue !== 'string' || rawValue.length > MAX_TERMINAL_ENV_VALUE_LENGTH) {
      return { ok: false, message: `Invalid terminal env value for ${key}.` };
    }
    env[key] = rawValue;
  }
  return { ok: true, value: env };
}

export function isTerminalAgentKind(value: unknown): value is TerminalAgentKind {
  return value === 'shell' || value === 'claude' || value === 'codex' || value === 'opencode';
}

export function isManagedTerminalAgentKind(value: unknown): value is ManagedTerminalAgentKind {
  return value === 'claude' || value === 'codex';
}

export function validateTerminalOpenInput(value: unknown): TerminalValidationResult<Required<TerminalSessionInput> & Omit<TerminalOpenInput, keyof TerminalSessionInput>> {
  if (!isPlainObject(value)) {
    return { ok: false, message: 'Terminal open input must be an object.' };
  }
  const threadId = validateNonEmptyString(value.threadId, 'thread id');
  if (!threadId.ok) return threadId;
  const terminalId = validateTerminalId(value.terminalId);
  if (!terminalId.ok) return terminalId;
  const cwd = validateNonEmptyString(value.cwd, 'terminal cwd');
  if (!cwd.ok) return cwd;
  const env = validateEnv(value.env);
  if (!env.ok) return env;
  const { cols, rows } = normalizeTerminalSize(value.cols, value.rows);
  const agentKind = isTerminalAgentKind(value.agentKind) ? value.agentKind : 'shell';
  return {
    ok: true,
    value: {
      threadId: threadId.value,
      terminalId: terminalId.value,
      cwd: cwd.value,
      cols,
      rows,
      env: env.value,
      agentKind,
    },
  };
}

export function validateTerminalWriteInput(value: unknown): TerminalValidationResult<Required<TerminalSessionInput> & { data: string }> {
  if (!isPlainObject(value)) {
    return { ok: false, message: 'Terminal write input must be an object.' };
  }
  const session = validateTerminalSessionInput(value);
  if (!session.ok) return session;
  if (typeof value.data !== 'string' || value.data.length === 0) {
    return { ok: false, message: 'Missing terminal write data.' };
  }
  if (value.data.length > MAX_TERMINAL_WRITE_LENGTH) {
    return { ok: false, message: `Terminal write data must be at most ${MAX_TERMINAL_WRITE_LENGTH} characters.` };
  }
  return { ok: true, value: { ...session.value, data: value.data } };
}

export function validateTerminalResizeInput(value: unknown): TerminalValidationResult<TerminalResizeInput> {
  if (!isPlainObject(value)) {
    return { ok: false, message: 'Terminal resize input must be an object.' };
  }
  const session = validateTerminalSessionInput(value);
  if (!session.ok) return session;
  const cols = validateExactCols(value.cols);
  if (!cols.ok) return cols;
  const rows = validateExactRows(value.rows);
  if (!rows.ok) return rows;
  return { ok: true, value: { ...session.value, cols: cols.value, rows: rows.value } };
}

export function validateTerminalSessionInput(value: unknown): TerminalValidationResult<Required<TerminalSessionInput>> {
  if (!isPlainObject(value)) {
    return { ok: false, message: 'Terminal session input must be an object.' };
  }
  const threadId = validateNonEmptyString(value.threadId, 'thread id');
  if (!threadId.ok) return threadId;
  const terminalId = validateTerminalId(value.terminalId);
  if (!terminalId.ok) return terminalId;
  return { ok: true, value: { threadId: threadId.value, terminalId: terminalId.value } };
}

export function validateTerminalClearInput(value: unknown): TerminalValidationResult<Required<TerminalClearInput>> {
  return validateTerminalSessionInput(value);
}

export function validateTerminalRestartInput(value: unknown): TerminalValidationResult<TerminalRestartInput> {
  if (!isPlainObject(value)) {
    return { ok: false, message: 'Terminal restart input must be an object.' };
  }
  const open = validateTerminalOpenInput(value);
  if (!open.ok) return open;
  const cols = validateExactCols(open.value.cols);
  if (!cols.ok) return cols;
  const rows = validateExactRows(open.value.rows);
  if (!rows.ok) return rows;
  return {
    ok: true,
    value: {
      threadId: open.value.threadId,
      terminalId: open.value.terminalId,
      cwd: open.value.cwd,
      cols: cols.value,
      rows: rows.value,
      env: open.value.env,
      agentKind: open.value.agentKind,
    },
  };
}

export function validateTerminalCloseInput(value: unknown): TerminalValidationResult<TerminalCloseInput> {
  if (!isPlainObject(value)) {
    return { ok: false, message: 'Terminal close input must be an object.' };
  }
  const threadId = validateNonEmptyString(value.threadId, 'thread id');
  if (!threadId.ok) return threadId;
  const terminalId = value.terminalId == null ? undefined : validateTerminalId(value.terminalId);
  if (terminalId && !terminalId.ok) return terminalId;
  return {
    ok: true,
    value: {
      threadId: threadId.value,
      terminalId: terminalId?.value,
      deleteHistory: value.deleteHistory === true,
    },
  };
}

export function buildTerminalRuntimeKey(threadId: string, terminalId: string = DEFAULT_TERMINAL_ID): string {
  return `${threadId}::${terminalId}`;
}

export function buildLegacyTerminalSessionId(threadId: string, terminalId: string = DEFAULT_TERMINAL_ID): string {
  return buildTerminalRuntimeKey(threadId, terminalId);
}

export function terminalActivityStateFromAgentEvent(event: TerminalAgentEventName): TerminalActivityState {
  if (event === 'stop') return 'idle';
  if (event === 'permission-request') return 'attention';
  if (event === 'review') return 'review';
  return 'running';
}
