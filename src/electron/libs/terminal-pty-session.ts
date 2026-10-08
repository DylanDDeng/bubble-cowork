import type { IPty } from 'node-pty';
import {
  terminalActivityStateFromAgentEvent,
  type ManagedTerminalAgentKind,
  type TerminalActivityEvent,
  type TerminalAgentKind,
  type TerminalCliKind,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
} from '../../shared/terminal';
import { parseTerminalOsc, type TerminalOscActivityEvent } from '../../shared/terminal-osc';
import { capHistoryByLimits, writeTerminalHistory } from './terminal-history';
import { agentCliForCommand, type ProcessEntry } from './terminal-process-tree';

// Output is coalesced into one event per OUTPUT_BATCH_MS, or sooner once
// OUTPUT_BATCH_CHARS are waiting.
const OUTPUT_BATCH_MS = 16;
const OUTPUT_BATCH_CHARS = 128 * 1024;
const HISTORY_SAVE_DELAY_MS = 40;
// How long an agent CLI counts as busy after its last output or input.
const BUSY_AFTER_OUTPUT_MS = 30_000;
const BUSY_AFTER_INPUT_MS = 120_000;

type AgentState = Exclude<TerminalActivityEvent['agentState'], null>;
type Emit = (event: TerminalEvent) => void;

export interface PtySessionInit {
  scope: string;
  tabId: string;
  cwd: string;
  agent: TerminalAgentKind;
  pty: IPty;
  history: string;
  launchCommands: Partial<Record<ManagedTerminalAgentKind, string>>;
  cols: number;
  rows: number;
  emit: Emit;
}

const stamp = () => new Date().toISOString();

/**
 * One running shell: forwards its output in batches, keeps the capped
 * scrollback history on disk, and tracks what the shell is doing (agent
 * events from the wrappers, child processes from polling).
 */
export class PtySession {
  readonly scope: string;
  readonly tabId: string;
  readonly cwd: string;
  readonly agent: TerminalAgentKind;
  readonly pty: IPty;
  readonly launchCommands: Partial<Record<ManagedTerminalAgentKind, string>>;
  status: TerminalSessionStatus = 'running';
  /** Larger means used more recently; set by the manager. */
  recency = 0;
  private history: string;
  private readonly osc: { pendingControlSequence?: string } = {};
  private outbox: string[] = [];
  private outboxSize = 0;
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cols: number;
  private rows: number;
  private exitCode: number | null = null;
  private exitSignal: number | string | null = null;
  private updatedAt = stamp();
  private cli: TerminalCliKind | null;
  private agentState: AgentState | null = null;
  private busy = false;
  private lastInputAt = 0;
  private lastOutputAt = 0;
  private readonly emit: Emit;

  constructor(init: PtySessionInit) {
    this.scope = init.scope;
    this.tabId = init.tabId;
    this.cwd = init.cwd;
    this.agent = init.agent;
    this.pty = init.pty;
    this.history = init.history;
    this.launchCommands = init.launchCommands;
    this.cols = init.cols;
    this.rows = init.rows;
    this.emit = init.emit;
    this.cli = init.agent === 'claude' || init.agent === 'codex' ? init.agent : null;
  }

  get running(): boolean {
    return this.status === 'running';
  }

  /** Neither a child process nor an agent is at work. */
  get idle(): boolean {
    return !this.busy && !this.agentState;
  }

  snapshot(): TerminalSessionSnapshot {
    return {
      threadId: this.scope,
      terminalId: this.tabId,
      cwd: this.cwd,
      status: this.status,
      pid: this.pty.pid || null,
      history: this.history,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      updatedAt: this.updatedAt,
      cols: this.cols,
      rows: this.rows,
      agentKind: this.agent,
    };
  }

  write(data: string): void {
    this.lastInputAt = Date.now();
    this.pty.write(data);
  }

  /** False when the size is unchanged and nothing was sent to the pty. */
  resize(cols: number, rows: number): boolean {
    if (cols === this.cols && rows === this.rows) return false;
    this.pty.resize(cols, rows);
    this.cols = cols;
    this.rows = rows;
    this.updatedAt = stamp();
    return true;
  }

  clearHistory(): void {
    this.history = '';
    this.osc.pendingControlSequence = '';
    this.updatedAt = stamp();
    this.saveHistory();
  }

  /** Pty output: agent OSC events are lifted out, the rest goes to history and listeners. */
  receive(data: string): boolean {
    const parsed = parseTerminalOsc(this.osc, data);
    for (const activity of parsed.activityEvents) this.applyAgentEvent(activity);
    if (!parsed.output) return false;
    this.lastOutputAt = Date.now();
    this.history = capHistoryByLimits(this.history + parsed.output);
    this.updatedAt = stamp();
    this.saveTimer ??= setTimeout(() => this.saveHistory(), HISTORY_SAVE_DELAY_MS);
    this.outbox.push(parsed.output);
    this.outboxSize += parsed.output.length;
    if (this.outboxSize >= OUTPUT_BATCH_CHARS) this.flushOutput();
    else this.outboxTimer ??= setTimeout(() => this.flushOutput(), OUTPUT_BATCH_MS);
    return true;
  }

  exited(exitCode: number | undefined, signal: number | string | undefined): void {
    this.flushOutput();
    this.status = 'exited';
    this.exitCode = typeof exitCode === 'number' ? exitCode : null;
    this.exitSignal = signal ?? null;
    this.updatedAt = stamp();
    this.saveHistory();
    this.emit({ ...this.address(), type: 'exited', exitCode: this.exitCode, exitSignal: this.exitSignal });
  }

  flushOutput(): void {
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    if (!this.outbox.length) return;
    const data = this.outbox.join('');
    this.outbox = [];
    this.outboxSize = 0;
    this.emit({ ...this.address(), type: 'output', data });
  }

  saveHistory(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.history = writeTerminalHistory(this.scope, this.tabId, this.history);
  }

  /** Stops timers and drops unsent output; the caller decides about the process. */
  release(): void {
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.outboxTimer = this.saveTimer = null;
    this.outbox = [];
    this.outboxSize = 0;
  }

  /**
   * Folds one polling sample in: the shell's descendants (or, on Windows,
   * just whether it has any). An agent CLI that printed or was typed into
   * recently still counts as busy between child processes.
   */
  sample(children: ProcessEntry[] | boolean, now = Date.now()): void {
    const hasChildren = typeof children === 'boolean' ? children : children.length > 0;
    const seenCli = typeof children === 'boolean' ? null : children.map((c) => agentCliForCommand(c.command)).find(Boolean) ?? null;
    const cli = seenCli ?? this.cli;
    const busy = hasChildren || (!!cli && this.recentlyActive(now));
    const agentState = this.agentState ?? (cli && this.recentlyActive(now) ? 'running' : null);
    if (busy === this.busy && cli === this.cli && agentState === this.agentState) return;
    this.busy = busy;
    this.cli = cli;
    this.agentState = agentState;
    this.announceActivity();
  }

  private recentlyActive(now: number): boolean {
    if (!this.lastOutputAt && !this.lastInputAt) return false;
    return this.lastOutputAt >= this.lastInputAt
      ? now - this.lastOutputAt <= BUSY_AFTER_OUTPUT_MS
      : now - this.lastInputAt <= BUSY_AFTER_INPUT_MS;
  }

  private applyAgentEvent(activity: TerminalOscActivityEvent): void {
    this.cli = activity.agent;
    const state = terminalActivityStateFromAgentEvent(activity.event);
    this.agentState = state === 'idle' ? null : state;
    if (activity.event === 'stop') this.busy = false;
    this.announceActivity(activity.event, activity.exitCode ?? null);
  }

  private announceActivity(event?: TerminalActivityEvent['event'], exitCode?: number | null): void {
    this.emit({
      ...this.address(),
      type: 'activity',
      hasRunningSubprocess: this.busy || !!this.agentState,
      cliKind: this.cli,
      agentState: this.agentState,
      event,
      exitCode,
    });
  }

  private address() {
    return { threadId: this.scope, terminalId: this.tabId, createdAt: stamp() };
  }
}
