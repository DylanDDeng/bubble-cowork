import { spawn as spawnPty, type IPty } from 'node-pty';
import {
  buildTerminalRuntimeKey,
  DEFAULT_TERMINAL_ID,
  isManagedTerminalAgentKind,
  normalizeTerminalSize,
  validateTerminalClearInput,
  validateTerminalCloseInput,
  validateTerminalOpenInput,
  validateTerminalResizeInput,
  validateTerminalRestartInput,
  validateTerminalSessionInput,
  validateTerminalWriteInput,
  type TerminalAgentKind,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalOpenResult,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalRpcResult,
  type TerminalSessionSnapshot,
  type TerminalStartInput,
  type TerminalWriteInput,
} from '../../shared/terminal';
import { isDev } from '../util';
import { prepareManagedTerminalEnvironment } from './terminal-agent-wrapper';
import { deleteTerminalHistory, readTerminalHistory, writeTerminalHistory } from './terminal-history';
import { descendantsOf, hasChildProcessWindows, ProcessTable, terminateTree } from './terminal-process-tree';
import { PtySession } from './terminal-pty-session';
import { describeLaunch, ensurePtyHelperExecutable, shellEnvironment, shellLaunchOrder } from './terminal-shells';

// Give a fresh shell a moment to print its first prompt before answering open.
const STARTUP_SETTLE_MS = 120;
const ACTIVITY_POLL_MS = 1000;
// Idle shells beyond this many are closed, least recently used first.
const SESSION_BUDGET = 128;

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, STARTUP_SETTLE_MS));
const NOT_RUNNING: TerminalRpcResult = { ok: false, message: 'Terminal session is not running.' };
const failure = (error: unknown): TerminalRpcResult => ({ ok: false, message: error instanceof Error ? error.message : String(error) });

/**
 * Shells for the embedded terminals, keyed by scope and tab. Each is a
 * PtySession; the manager starts and reuses them, routes calls, polls their
 * process trees for activity, and keeps the number of idle shells bounded.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, PtySession>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private clock = 0;

  constructor(private readonly emitEvent: (payload: TerminalEvent) => void) {}

  async open(rawInput: TerminalOpenInput): Promise<TerminalOpenResult> {
    const decoded = validateTerminalOpenInput(rawInput);
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const input = decoded.value;
    const key = buildTerminalRuntimeKey(input.threadId, input.terminalId);
    const size = normalizeTerminalSize(input.cols, input.rows);
    const launchFor = (session: PtySession) =>
      isManagedTerminalAgentKind(input.agentKind) ? session.launchCommands[input.agentKind] || input.agentKind : undefined;

    // Reattach to a live shell in the same directory instead of starting over.
    const existing = this.sessions.get(key);
    if (existing?.running && existing.cwd === input.cwd) {
      this.touch(existing);
      this.resizeSession(existing, size.cols, size.rows);
      await settle();
      return { ok: true, snapshot: existing.snapshot(), launchCommand: launchFor(existing) };
    }
    if (existing) this.close({ threadId: input.threadId, terminalId: input.terminalId });

    ensurePtyHelperExecutable();
    const managed = prepareManagedTerminalEnvironment(shellEnvironment(input.env));
    const spawned = this.spawnShell(input.cwd, managed.env, size);
    if ('message' in spawned) return { ok: false, message: spawned.message };

    const session = new PtySession({
      scope: input.threadId,
      tabId: input.terminalId,
      cwd: input.cwd,
      agent: (input.agentKind || 'shell') as TerminalAgentKind,
      pty: spawned.pty,
      history: readTerminalHistory(input.threadId, input.terminalId),
      launchCommands: managed.launchCommands,
      ...size,
      emit: (event) => this.emitEvent(event),
    });
    this.sessions.set(key, session);
    this.touch(session);
    this.watch();

    // Events from a shell that has since been replaced are ignored.
    const current = () => this.sessions.get(key) === session;
    spawned.pty.onData((data) => {
      if (current() && session.receive(data)) this.touch(session);
    });
    spawned.pty.onExit(({ exitCode, signal }) => {
      if (!current()) return;
      session.exited(exitCode, signal);
      this.forget(key);
    });

    this.emitEvent({
      type: 'started',
      threadId: input.threadId,
      terminalId: input.terminalId,
      createdAt: new Date().toISOString(),
      snapshot: session.snapshot(),
    });
    await settle();
    this.trimIdleSessions();
    return { ok: true, snapshot: session.snapshot(), launchCommand: launchFor(session) };
  }

  /** Legacy single-terminal API: one default tab per session id. */
  async start(input: TerminalStartInput): Promise<{
    ok: boolean;
    history?: string;
    message?: string;
    launchCommand?: string;
    managedByServer?: boolean;
    snapshot?: TerminalSessionSnapshot;
  }> {
    const result = await this.open({
      threadId: input.sessionId,
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      agentKind: input.agentKind,
    });
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
    const decoded = validateTerminalWriteInput(
      typeof rawInputOrThreadId === 'string'
        ? { threadId: rawInputOrThreadId, terminalId: DEFAULT_TERMINAL_ID, data }
        : rawInputOrThreadId
    );
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const session = this.find(decoded.value);
    if (!session?.running) return NOT_RUNNING;
    try {
      session.write(decoded.value.data);
      this.touch(session);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  resize(rawInputOrThreadId: TerminalResizeInput | string, cols?: number, rows?: number): TerminalRpcResult {
    const decoded = validateTerminalResizeInput(
      typeof rawInputOrThreadId === 'string'
        ? { threadId: rawInputOrThreadId, terminalId: DEFAULT_TERMINAL_ID, cols, rows }
        : rawInputOrThreadId
    );
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const session = this.find(decoded.value);
    if (!session?.running) return NOT_RUNNING;
    try {
      this.resizeSession(session, decoded.value.cols, decoded.value.rows);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  clear(rawInput: TerminalClearInput): TerminalRpcResult {
    const decoded = validateTerminalClearInput(rawInput);
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const { threadId, terminalId } = decoded.value;
    const session = this.find(decoded.value);
    if (session) session.clearHistory();
    else writeTerminalHistory(threadId, terminalId, '');
    this.emitEvent({ type: 'cleared', threadId, terminalId, createdAt: new Date().toISOString() });
    return { ok: true };
  }

  async restart(rawInput: TerminalRestartInput): Promise<TerminalOpenResult> {
    const decoded = validateTerminalRestartInput(rawInput);
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const { threadId, terminalId } = decoded.value;
    this.close({ threadId, terminalId });
    const result = await this.open(decoded.value);
    if (result.ok) {
      this.emitEvent({ type: 'restarted', threadId, terminalId, createdAt: new Date().toISOString(), snapshot: result.snapshot });
    }
    return result;
  }

  /** Ends one tab's shell, or every shell of a scope when no tab is given. */
  close(rawInputOrThreadId: TerminalCloseInput | string): TerminalRpcResult {
    const decoded = validateTerminalCloseInput(
      typeof rawInputOrThreadId === 'string'
        ? { threadId: rawInputOrThreadId, terminalId: DEFAULT_TERMINAL_ID }
        : rawInputOrThreadId
    );
    if (!decoded.ok) return { ok: false, message: decoded.message };
    const { threadId, terminalId, deleteHistory } = decoded.value;
    const keys = terminalId
      ? [buildTerminalRuntimeKey(threadId, terminalId)]
      : [...this.sessions.values()].filter((session) => session.scope === threadId).map((s) => buildTerminalRuntimeKey(s.scope, s.tabId));

    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      session.flushOutput();
      session.saveHistory();
      // Forget before killing: the exit that follows is not reported.
      this.forget(key);
      void terminateTree(session.pty.pid, (signal) => session.pty.kill(signal));
      if (deleteHistory) deleteTerminalHistory(session.scope, session.tabId);
    }
    if (terminalId && deleteHistory) deleteTerminalHistory(threadId, terminalId);
    return { ok: true };
  }

  stop(threadId: string): TerminalRpcResult {
    return this.close(threadId);
  }

  disposeAll(): void {
    for (const session of [...this.sessions.values()]) {
      this.close({ threadId: session.scope, terminalId: session.tabId });
    }
    this.unwatch();
  }

  getSnapshot(rawInput: unknown): TerminalSessionSnapshot | null {
    const decoded = validateTerminalSessionInput(rawInput);
    return decoded.ok ? this.find(decoded.value)?.snapshot() ?? null : null;
  }

  private find(input: { threadId: string; terminalId: string }): PtySession | undefined {
    return this.sessions.get(buildTerminalRuntimeKey(input.threadId, input.terminalId));
  }

  private touch(session: PtySession): void {
    session.recency = ++this.clock;
  }

  private resizeSession(session: PtySession, cols: number, rows: number): void {
    if (session.resize(cols, rows)) this.touch(session);
  }

  private spawnShell(cwd: string, env: Record<string, string>, size: { cols: number; rows: number }): { pty: IPty } | { message: string } {
    const tried: string[] = [];
    let lastError: unknown = 'unknown';
    for (const launch of shellLaunchOrder()) {
      tried.push(describeLaunch(launch));
      try {
        return { pty: spawnPty(launch.file, launch.args, { name: env.TERM || 'xterm-256color', ...size, cwd, env }) };
      } catch (error) {
        lastError = error;
        if (isDev()) console.warn('[Terminal] Shell failed to start:', describeLaunch(launch), error);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    return { message: `Failed to spawn shell: ${detail}. Tried: ${tried.join(' | ')}` };
  }

  private forget(key: string): void {
    this.sessions.get(key)?.release();
    this.sessions.delete(key);
    if (!this.sessions.size) this.unwatch();
  }

  private trimIdleSessions(): void {
    const excess = this.sessions.size - SESSION_BUDGET;
    if (excess <= 0) return;
    const idle = [...this.sessions.values()].filter((session) => session.idle).sort((a, b) => a.recency - b.recency);
    for (const session of idle.slice(0, excess)) {
      this.close({ threadId: session.scope, terminalId: session.tabId });
    }
  }

  private watch(): void {
    if (this.poller) return;
    this.poller = setInterval(() => void this.sampleActivity(), ACTIVITY_POLL_MS);
    this.poller.unref?.();
  }

  private unwatch(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  /** One process listing per tick, shared by every running shell. */
  private async sampleActivity(): Promise<void> {
    const running = [...this.sessions.values()].filter((session) => session.running);
    if (this.polling || !running.length) return;
    this.polling = true;
    try {
      if (process.platform === 'win32') {
        for (const session of running) session.sample(await hasChildProcessWindows(session.pty.pid));
        return;
      }
      const table = await ProcessTable.read();
      const now = Date.now();
      for (const session of running) {
        if (this.sessions.get(buildTerminalRuntimeKey(session.scope, session.tabId)) !== session) continue;
        session.sample(await descendantsOf(session.pty.pid, table), now);
      }
    } finally {
      this.polling = false;
    }
  }
}
