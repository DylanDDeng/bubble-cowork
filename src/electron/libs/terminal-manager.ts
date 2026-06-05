import { app } from 'electron';
import { execFile, execFileSync } from 'child_process';
import { chmodSync, existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { spawn as spawnPty } from 'node-pty';
import type { IPty } from 'node-pty';
import type {
  ManagedTerminalAgentKind,
  TerminalActivityEvent,
  TerminalAgentKind,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalOpenResult,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalRpcResult,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalStartInput,
  TerminalWriteInput,
} from '../../shared/terminal';
import {
  buildTerminalRuntimeKey,
  DEFAULT_TERMINAL_ID,
  isManagedTerminalAgentKind,
  normalizeTerminalSize,
  terminalActivityStateFromAgentEvent,
  validateTerminalClearInput,
  validateTerminalCloseInput,
  validateTerminalOpenInput,
  validateTerminalResizeInput,
  validateTerminalRestartInput,
  validateTerminalSessionInput,
  validateTerminalWriteInput,
} from '../../shared/terminal';
import { parseTerminalOsc, type TerminalOscActivityEvent, type TerminalOscState } from '../../shared/terminal-osc';
import { isDev } from '../util';
import { prepareManagedTerminalEnvironment } from './terminal-agent-wrapper';
import {
  capHistoryByLimits,
  deleteTerminalHistory,
  readTerminalHistory,
  writeTerminalHistory,
} from './terminal-history';

const TERMINAL_STARTUP_BUFFER_MS = 120;
const OUTPUT_FLUSH_MS = 16;
const OUTPUT_FLUSH_MAX_CHARS = 128 * 1024;
const OUTPUT_BUFFER_HIGH_WATERMARK = 1024 * 1024;
const HISTORY_PERSIST_DEBOUNCE_MS = 40;
const SUBPROCESS_POLL_INTERVAL_MS = 1000;
const PROCESS_KILL_GRACE_MS = 1000;
const MAX_RETAINED_INACTIVE_SESSIONS = 128;
const PROVIDER_INPUT_ACTIVITY_GRACE_MS = 120_000;
const PROVIDER_OUTPUT_ACTIVITY_GRACE_MS = 30_000;
const POSIX_TREE_WALK_MAX_VISITED = 256;
const TERMINAL_ENV_BLOCKLIST = new Set(['PORT', 'ELECTRON_RENDERER_PORT', 'ELECTRON_RUN_AS_NODE']);

type ShellCandidate = {
  command: string;
  args: string[];
};

type SubprocessActivity = {
  cliKind: ManagedTerminalAgentKind | 'opencode' | null;
  hasRunningSubprocess: boolean;
  hasProviderDescendant: boolean;
  hasNonProviderSubprocess: boolean;
};

type TerminalSessionState = {
  threadId: string;
  terminalId: string;
  cwd: string;
  process: IPty;
  status: TerminalSessionStatus;
  history: string;
  pendingControlSequence: string;
  pendingOutputChunks: string[];
  pendingOutputLength: number;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
  lastCols: number;
  lastRows: number;
  agentKind: TerminalAgentKind;
  cliKind: ManagedTerminalAgentKind | 'opencode' | null;
  agentState: Exclude<TerminalActivityEvent['agentState'], null> | null;
  hasRunningSubprocess: boolean;
  lastInputAt: number | null;
  lastOutputAt: number | null;
  exitCode: number | null;
  exitSignal: number | string | null;
  updatedAt: string;
  launchCommands: Partial<Record<ManagedTerminalAgentKind, string>>;
  pausedForBackpressure: boolean;
  inactivityRank: number;
};

let terminalHelperPrepared = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeTerminalEnv(env?: Record<string, string>): Record<string, string> {
  const merged = {
    ...process.env,
    ...(env || {}),
    TERM: env?.TERM || process.env.TERM || 'xterm-256color',
    COLORTERM: env?.COLORTERM || process.env.COLORTERM || 'truecolor',
  };
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (TERMINAL_ENV_BLOCKLIST.has(key)) continue;
    if (typeof value === 'string') {
      output[key] = value;
    }
  }
  return output;
}

function ensureNodePtyHelpersExecutable(): void {
  if (process.platform === 'win32') {
    return;
  }

  try {
    if (!app?.getAppPath) {
      return;
    }
    const baseDir = join(app.getAppPath(), 'node_modules', 'node-pty');
    const archDir = `${process.platform}-${process.arch}`;
    const candidatePaths = [
      join(baseDir, 'prebuilds', archDir, 'spawn-helper'),
      join(baseDir, 'build', 'Release', 'spawn-helper'),
    ];

    for (const helperPath of candidatePaths) {
      if (existsSync(helperPath)) {
        chmodSync(helperPath, 0o755);
      }
    }

    try {
      const helperDir = join(dirname(require.resolve('node-pty')), 'build', 'Release');
      const fullPath = join(helperDir, 'spawn-helper');
      if (existsSync(fullPath)) {
        chmodSync(fullPath, 0o755);
      }
    } catch {
      // ignore alternate resolution failures
    }
  } catch (error) {
    if (isDev()) {
      console.warn('[Terminal] Failed to mark node-pty helper executable:', error);
    }
  }
}

function prepareTerminalHelpers(): void {
  if (terminalHelperPrepared) return;
  ensureNodePtyHelpersExecutable();
  terminalHelperPrepared = true;
}

function normalizeShellCommand(command: string | undefined): string | null {
  if (!command) return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (process.platform === 'win32') return trimmed;
  return trimmed.split(/\s+/g)[0]?.replace(/^['"]|['"]$/g, '') || null;
}

function shellCandidateFromCommand(command: string | null): ShellCandidate | null {
  if (!command) return null;
  const shellName = basename(command).toLowerCase();
  if (process.platform !== 'win32' && shellName === 'zsh') {
    return { command, args: ['-o', 'nopromptsp'] };
  }
  return { command, args: [] };
}

function formatShellCandidate(candidate: ShellCandidate): string {
  return `${candidate.command} ${candidate.args.join(' ')}`.trim();
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function getTerminalLaunchSpecs(): ShellCandidate[] {
  if (process.platform === 'win32') {
    return uniqueShellCandidates([
      shellCandidateFromCommand(process.env.COMSPEC || 'powershell.exe'),
      shellCandidateFromCommand('cmd.exe'),
    ]);
  }

  return uniqueShellCandidates([
    shellCandidateFromCommand(normalizeShellCommand(process.env.SHELL)),
    shellCandidateFromCommand('/bin/zsh'),
    shellCandidateFromCommand('/bin/bash'),
    shellCandidateFromCommand('/bin/sh'),
    shellCandidateFromCommand('zsh'),
    shellCandidateFromCommand('bash'),
    shellCandidateFromCommand('sh'),
  ]).filter((candidate) => (candidate.command.includes('/') ? existsSync(candidate.command) : true));
}

function collectDescendantPids(pid: number, seen = new Set<number>()): number[] {
  if (seen.size > POSIX_TREE_WALK_MAX_VISITED) return [];

  let output = '';
  try {
    output = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
  } catch {
    return [];
  }

  const children = output
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0 && !seen.has(value));

  const result: number[] = [];
  for (const child of children) {
    seen.add(child);
    result.push(...collectDescendantPids(child, seen));
    result.push(child);
  }
  return result;
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // process may already be gone
  }
}

function terminateProcessTree(processHandle: IPty): void {
  const pid = processHandle.pid;

  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {
      try {
        processHandle.kill();
      } catch {
        // ignore
      }
    });
    return;
  }

  const pids = [...collectDescendantPids(pid), pid];
  for (const childPid of pids) {
    killPid(childPid, 'SIGTERM');
  }

  const killTimer = setTimeout(() => {
    for (const childPid of pids) {
      killPid(childPid, 'SIGKILL');
    }
    try {
      processHandle.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, PROCESS_KILL_GRACE_MS);
  killTimer.unref?.();
}

function readProcessCommand(pid: number): string {
  if (process.platform === 'win32') return '';
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
  } catch {
    return '';
  }
}

function inferCliKindFromCommand(command: string): ManagedTerminalAgentKind | 'opencode' | null {
  const lower = basename(command).toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('opencode')) return 'opencode';
  return null;
}

function checkSubprocessActivity(pid: number): SubprocessActivity {
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($children) { exit 0 } else { exit 1 }`,
        ],
        { timeout: 1000 }
      );
      return {
        cliKind: null,
        hasRunningSubprocess: true,
        hasProviderDescendant: false,
        hasNonProviderSubprocess: true,
      };
    } catch {
      return {
        cliKind: null,
        hasRunningSubprocess: false,
        hasProviderDescendant: false,
        hasNonProviderSubprocess: false,
      };
    }
  }

  const descendants = collectDescendantPids(pid);
  let cliKind: ManagedTerminalAgentKind | 'opencode' | null = null;
  for (const childPid of descendants) {
    cliKind = inferCliKindFromCommand(readProcessCommand(childPid));
    if (cliKind) break;
  }
  return {
    cliKind,
    hasRunningSubprocess: descendants.length > 0,
    hasProviderDescendant: Boolean(cliKind),
    hasNonProviderSubprocess: descendants.length > 0 && !cliKind,
  };
}

function isProviderSessionBusy(session: TerminalSessionState, now: number): boolean {
  const lastInputAt = session.lastInputAt ?? 0;
  const lastOutputAt = session.lastOutputAt ?? 0;
  const latestSignalAt = Math.max(lastInputAt, lastOutputAt);
  if (latestSignalAt <= 0) return false;
  if (lastOutputAt >= lastInputAt) {
    return now - lastOutputAt <= PROVIDER_OUTPUT_ACTIVITY_GRACE_MS;
  }
  return now - lastInputAt <= PROVIDER_INPUT_ACTIVITY_GRACE_MS;
}

function snapshotOf(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    status: session.status,
    pid: session.process.pid || null,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    updatedAt: session.updatedAt,
    cols: session.lastCols,
    rows: session.lastRows,
    agentKind: session.agentKind,
  };
}

function legacyOpenInput(input: TerminalStartInput): TerminalOpenInput {
  return {
    threadId: input.sessionId,
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: input.cwd,
    cols: input.cols,
    rows: input.rows,
    agentKind: input.agentKind,
  };
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSessionState>();
  private subprocessPollTimer: ReturnType<typeof setInterval> | null = null;
  private inactivityCounter = 0;

  constructor(private readonly emitEvent: (payload: TerminalEvent) => void) {}

  async open(rawInput: TerminalOpenInput): Promise<TerminalOpenResult> {
    const decoded = validateTerminalOpenInput(rawInput);
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const input = decoded.value;
    prepareTerminalHelpers();

    const key = buildTerminalRuntimeKey(input.threadId, input.terminalId);
    const { cols, rows } = normalizeTerminalSize(input.cols, input.rows);
    const existing = this.sessions.get(key);
    if (existing && existing.cwd === input.cwd && existing.status === 'running') {
      this.resize({ threadId: input.threadId, terminalId: input.terminalId, cols, rows });
      existing.inactivityRank = ++this.inactivityCounter;
      await delay(TERMINAL_STARTUP_BUFFER_MS);
      return {
        ok: true,
        snapshot: snapshotOf(existing),
        launchCommand: isManagedTerminalAgentKind(input.agentKind)
          ? existing.launchCommands[input.agentKind] || input.agentKind
          : undefined,
      };
    }

    if (existing) {
      this.close({ threadId: input.threadId, terminalId: input.terminalId });
    }

    const baseEnv = sanitizeTerminalEnv(input.env);
    const managedEnv = prepareManagedTerminalEnvironment(baseEnv);
    const env = managedEnv.env;
    let spawned: IPty | null = null;
    let lastError: unknown = null;
    const attempted: string[] = [];

    for (const launch of getTerminalLaunchSpecs()) {
      attempted.push(formatShellCandidate(launch));
      try {
        spawned = spawnPty(launch.command, launch.args, {
          name: env.TERM || 'xterm-256color',
          cols,
          rows,
          cwd: input.cwd,
          env,
        });
        break;
      } catch (error) {
        lastError = error;
        if (isDev()) {
          console.warn('[Terminal] Failed to spawn shell', {
            command: launch.command,
            args: launch.args,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (!spawned) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown');
      return { ok: false, message: `Failed to spawn shell: ${detail}. Tried: ${attempted.join(' | ')}` };
    }

    const history = readTerminalHistory(input.threadId, input.terminalId);
    const session: TerminalSessionState = {
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      process: spawned,
      status: 'running',
      history,
      pendingControlSequence: '',
      pendingOutputChunks: [],
      pendingOutputLength: 0,
      outputFlushTimer: null,
      persistTimer: null,
      lastCols: cols,
      lastRows: rows,
      agentKind: input.agentKind || 'shell',
      cliKind: isManagedTerminalAgentKind(input.agentKind) ? input.agentKind : null,
      agentState: null,
      hasRunningSubprocess: false,
      lastInputAt: null,
      lastOutputAt: null,
      exitCode: null,
      exitSignal: null,
      updatedAt: nowIso(),
      launchCommands: managedEnv.launchCommands,
      pausedForBackpressure: false,
      inactivityRank: ++this.inactivityCounter,
    };
    this.sessions.set(key, session);
    this.ensureSubprocessPolling();

    spawned.onData((data: string) => {
      const current = this.sessions.get(key);
      if (current?.process !== spawned) return;
      this.handleData(key, data);
    });

    spawned.onExit((event) => {
      const current = this.sessions.get(key);
      if (current?.process !== spawned) return;
      this.flushOutput(key);
      current.status = 'exited';
      current.exitCode = typeof event.exitCode === 'number' ? event.exitCode : null;
      current.exitSignal = event.signal ?? null;
      current.updatedAt = nowIso();
      this.persistHistory(key, true);
      this.emit({
        type: 'exited',
        threadId: current.threadId,
        terminalId: current.terminalId,
        createdAt: nowIso(),
        exitCode: current.exitCode,
        exitSignal: current.exitSignal,
      });
      this.cleanupSession(key, { keepHistory: true });
    });

    this.emit({
      type: 'started',
      threadId: input.threadId,
      terminalId: input.terminalId,
      createdAt: nowIso(),
      snapshot: snapshotOf(session),
    });

    await delay(TERMINAL_STARTUP_BUFFER_MS);
    this.pruneInactiveSessions();
    return {
      ok: true,
      snapshot: snapshotOf(session),
      launchCommand: isManagedTerminalAgentKind(input.agentKind)
        ? managedEnv.launchCommands[input.agentKind] || input.agentKind
        : undefined,
    };
  }

  async start(input: TerminalStartInput): Promise<{
    ok: boolean;
    history?: string;
    message?: string;
    launchCommand?: string;
    managedByServer?: boolean;
    snapshot?: TerminalSessionSnapshot;
  }> {
    const result = await this.open(legacyOpenInput(input));
    if (!result.ok) return result;
    return {
      ok: true,
      history: result.snapshot.history,
      launchCommand: result.launchCommand,
      managedByServer: Boolean(result.launchCommand),
      snapshot: result.snapshot,
    };
  }

  write(rawInputOrThreadId: TerminalWriteInput | string, data?: string): TerminalRpcResult {
    const rawInput =
      typeof rawInputOrThreadId === 'string'
        ? { threadId: rawInputOrThreadId, terminalId: DEFAULT_TERMINAL_ID, data }
        : rawInputOrThreadId;
    const decoded = validateTerminalWriteInput(rawInput);
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const input = decoded.value;
    const session = this.sessions.get(buildTerminalRuntimeKey(input.threadId, input.terminalId));
    if (!session || session.status !== 'running') {
      return { ok: false, message: 'Terminal session is not running.' };
    }

    try {
      session.lastInputAt = Date.now();
      session.inactivityRank = ++this.inactivityCounter;
      session.process.write(input.data);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  resize(rawInputOrThreadId: TerminalResizeInput | string, cols?: number, rows?: number): TerminalRpcResult {
    const rawInput =
      typeof rawInputOrThreadId === 'string'
        ? { threadId: rawInputOrThreadId, terminalId: DEFAULT_TERMINAL_ID, cols, rows }
        : rawInputOrThreadId;
    const decoded = validateTerminalResizeInput(rawInput);
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const input = decoded.value;
    const session = this.sessions.get(buildTerminalRuntimeKey(input.threadId, input.terminalId));
    if (!session || session.status !== 'running') {
      return { ok: false, message: 'Terminal session is not running.' };
    }
    if (session.lastCols === input.cols && session.lastRows === input.rows) {
      return { ok: true };
    }

    try {
      session.lastCols = input.cols;
      session.lastRows = input.rows;
      session.updatedAt = nowIso();
      session.inactivityRank = ++this.inactivityCounter;
      session.process.resize(input.cols, input.rows);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  clear(rawInput: TerminalClearInput): TerminalRpcResult {
    const decoded = validateTerminalClearInput(rawInput);
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const key = buildTerminalRuntimeKey(decoded.value.threadId, decoded.value.terminalId);
    const session = this.sessions.get(key);
    if (session) {
      session.history = '';
      session.pendingControlSequence = '';
      session.updatedAt = nowIso();
      this.persistHistory(key, true);
    } else {
      writeTerminalHistory(decoded.value.threadId, decoded.value.terminalId, '');
    }
    this.emit({
      type: 'cleared',
      threadId: decoded.value.threadId,
      terminalId: decoded.value.terminalId,
      createdAt: nowIso(),
    });
    return { ok: true };
  }

  async restart(rawInput: TerminalRestartInput): Promise<TerminalOpenResult> {
    const decoded = validateTerminalRestartInput(rawInput);
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const input = decoded.value;
    this.close({ threadId: input.threadId, terminalId: input.terminalId });
    const result = await this.open(input);
    if (result.ok) {
      this.emit({
        type: 'restarted',
        threadId: input.threadId,
        terminalId: input.terminalId,
        createdAt: nowIso(),
        snapshot: result.snapshot,
      });
    }
    return result;
  }

  close(rawInputOrThreadId: TerminalCloseInput | string): TerminalRpcResult {
    const rawInput =
      typeof rawInputOrThreadId === 'string'
        ? { threadId: rawInputOrThreadId, terminalId: DEFAULT_TERMINAL_ID }
        : rawInputOrThreadId;
    const decoded = validateTerminalCloseInput(rawInput);
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const { threadId, terminalId, deleteHistory: shouldDeleteHistory } = decoded.value;
    const keys = terminalId
      ? [buildTerminalRuntimeKey(threadId, terminalId)]
      : [...this.sessions.keys()].filter((key) => key.startsWith(`${threadId}::`));

    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      this.flushOutput(key);
      this.persistHistory(key, true);
      terminateProcessTree(session.process);
      this.cleanupSession(key, { keepHistory: !shouldDeleteHistory });
      if (shouldDeleteHistory) {
        deleteTerminalHistory(session.threadId, session.terminalId);
      }
    }

    if (terminalId && shouldDeleteHistory) {
      deleteTerminalHistory(threadId, terminalId);
    }
    return { ok: true };
  }

  stop(threadId: string): TerminalRpcResult {
    return this.close(threadId);
  }

  disposeAll(): void {
    for (const session of [...this.sessions.values()]) {
      this.close({ threadId: session.threadId, terminalId: session.terminalId });
    }
    if (this.subprocessPollTimer) {
      clearInterval(this.subprocessPollTimer);
      this.subprocessPollTimer = null;
    }
  }

  getSnapshot(rawInput: unknown): TerminalSessionSnapshot | null {
    const decoded = validateTerminalSessionInput(rawInput);
    if (!decoded.ok) return null;
    const session = this.sessions.get(buildTerminalRuntimeKey(decoded.value.threadId, decoded.value.terminalId));
    return session ? snapshotOf(session) : null;
  }

  private handleData(key: string, data: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    const oscState: TerminalOscState = session;
    const parsed = parseTerminalOsc(oscState, data);
    for (const activity of parsed.activityEvents) {
      this.applyOscActivity(session, activity);
    }

    if (!parsed.output) return;
    session.lastOutputAt = Date.now();
    session.inactivityRank = ++this.inactivityCounter;
    session.history = capHistoryByLimits(`${session.history}${parsed.output}`);
    session.updatedAt = nowIso();
    this.schedulePersistHistory(key);
    this.queueOutput(key, parsed.output);
  }

  private applyOscActivity(session: TerminalSessionState, activity: TerminalOscActivityEvent): void {
    session.cliKind = activity.agent;
    const state = terminalActivityStateFromAgentEvent(activity.event);
    session.agentState = state === 'idle' ? null : state;
    if (activity.event === 'stop') {
      session.hasRunningSubprocess = false;
    }
    this.emitActivity(session, activity.event, activity.exitCode ?? null);
  }

  private queueOutput(key: string, data: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.pendingOutputChunks.push(data);
    session.pendingOutputLength += data.length;

    if (session.pendingOutputLength >= OUTPUT_BUFFER_HIGH_WATERMARK && !session.pausedForBackpressure) {
      const pausable = session.process as IPty & { pause?: () => void };
      pausable.pause?.();
      session.pausedForBackpressure = true;
    }

    if (session.pendingOutputLength >= OUTPUT_FLUSH_MAX_CHARS) {
      this.flushOutput(key);
      return;
    }

    if (!session.outputFlushTimer) {
      session.outputFlushTimer = setTimeout(() => {
        this.flushOutput(key);
      }, OUTPUT_FLUSH_MS);
    }
  }

  private flushOutput(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    if (session.outputFlushTimer) {
      clearTimeout(session.outputFlushTimer);
      session.outputFlushTimer = null;
    }

    if (session.pendingOutputChunks.length === 0) {
      session.pendingOutputLength = 0;
      return;
    }

    const data = session.pendingOutputChunks.join('');
    session.pendingOutputChunks = [];
    session.pendingOutputLength = 0;

    if (session.pausedForBackpressure) {
      const resumable = session.process as IPty & { resume?: () => void };
      resumable.resume?.();
      session.pausedForBackpressure = false;
    }

    this.emit({
      type: 'output',
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: nowIso(),
      data,
    });
  }

  private schedulePersistHistory(key: string): void {
    const session = this.sessions.get(key);
    if (!session || session.persistTimer) return;
    session.persistTimer = setTimeout(() => {
      this.persistHistory(key, true);
    }, HISTORY_PERSIST_DEBOUNCE_MS);
  }

  private persistHistory(key: string, immediate = false): void {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.persistTimer) {
      clearTimeout(session.persistTimer);
      session.persistTimer = null;
    }
    if (!immediate) return;
    session.history = writeTerminalHistory(session.threadId, session.terminalId, session.history);
  }

  private cleanupSession(key: string, options: { keepHistory: boolean }): void {
    const session = this.sessions.get(key);
    if (!session) return;

    if (session.outputFlushTimer) {
      clearTimeout(session.outputFlushTimer);
      session.outputFlushTimer = null;
    }
    if (session.persistTimer) {
      clearTimeout(session.persistTimer);
      session.persistTimer = null;
    }
    session.pendingOutputChunks = [];
    session.pendingOutputLength = 0;
    if (!options.keepHistory) {
      deleteTerminalHistory(session.threadId, session.terminalId);
    }
    this.sessions.delete(key);
    if (this.sessions.size === 0 && this.subprocessPollTimer) {
      clearInterval(this.subprocessPollTimer);
      this.subprocessPollTimer = null;
    }
  }

  private ensureSubprocessPolling(): void {
    if (this.subprocessPollTimer) return;
    this.subprocessPollTimer = setInterval(() => {
      this.pollSubprocessActivity();
    }, SUBPROCESS_POLL_INTERVAL_MS);
    this.subprocessPollTimer.unref?.();
  }

  private pollSubprocessActivity(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.status !== 'running') continue;
      const activity = checkSubprocessActivity(session.process.pid);
      const cliKind = activity.cliKind || session.cliKind;
      const providerBusy = Boolean(cliKind) && isProviderSessionBusy(session, now);
      const hasRunningSubprocess = activity.hasRunningSubprocess || providerBusy;
      const nextAgentState = session.agentState || (providerBusy ? 'running' : null);
      const changed =
        session.hasRunningSubprocess !== hasRunningSubprocess ||
        session.cliKind !== cliKind ||
        session.agentState !== nextAgentState;
      session.hasRunningSubprocess = hasRunningSubprocess;
      session.cliKind = cliKind;
      session.agentState = nextAgentState;
      if (changed) {
        this.emitActivity(session);
      }
    }
  }

  private emitActivity(session: TerminalSessionState, event?: TerminalActivityEvent['event'], exitCode?: number | null): void {
    this.emit({
      type: 'activity',
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: nowIso(),
      hasRunningSubprocess: session.hasRunningSubprocess || Boolean(session.agentState),
      cliKind: session.cliKind,
      agentState: session.agentState,
      event,
      exitCode,
    });
  }

  private pruneInactiveSessions(): void {
    if (this.sessions.size <= MAX_RETAINED_INACTIVE_SESSIONS) return;
    const inactive = [...this.sessions.values()]
      .filter((session) => !session.hasRunningSubprocess && !session.agentState)
      .sort((a, b) => a.inactivityRank - b.inactivityRank);
    while (this.sessions.size > MAX_RETAINED_INACTIVE_SESSIONS && inactive.length > 0) {
      const session = inactive.shift();
      if (!session) break;
      this.close({ threadId: session.threadId, terminalId: session.terminalId });
    }
  }

  private emit(payload: TerminalEvent): void {
    this.emitEvent(payload);
  }
}
