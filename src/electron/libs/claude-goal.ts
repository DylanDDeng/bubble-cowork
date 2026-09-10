import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, open, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GoalAction, ThreadGoal } from '../../shared/session-goal';
import { isClaudeGoalClearObjective } from '../../shared/session-goal';

export interface ClaudeGoalState {
  goal: ThreadGoal | null;
  supported: boolean;
  transcriptPath?: string;
  resumeConfirmation?: boolean;
  /** A dispatched set may have reached Claude before its acknowledgement. */
  needsClear?: boolean;
  /** Changes only when the CLI acknowledges a new /goal set. */
  activationId?: string;
}
type WireMessage = {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  local_command_source?: string;
  result?: string;
  is_error?: boolean;
  [key: string]: unknown;
};
interface Transport {
  commands(): Promise<Array<{ name: string }>>;
  send(text: string): void;
  interrupt(): Promise<unknown>;
  abort(): void;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // The stream can fail before a caller starts awaiting readiness.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export function validateClaudeGoalObjective(objective: string): string {
  const value = objective.trim();
  if (!value) throw new Error('Enter a goal to pursue.');
  if (isClaudeGoalClearObjective(value))
    throw new Error('This word is a Claude Goal clear command. Describe the full goal instead.');
  return value;
}

/** Reads only the runtime-supplied transcript. No writes to Claude settings or history. */
class GoalTranscriptReader {
  private offset = 0;
  private partial = '';
  private chain: Promise<void> = Promise.resolve();
  constructor(
    readonly path: string,
    private receive: (entry: Record<string, any>) => void,
  ) {}
  refresh(): Promise<void> {
    this.chain = this.chain
      .catch(() => {})
      .then(async () => {
        let file;
        try {
          const size = (await stat(this.path)).size;
          if (size < this.offset) {
            this.offset = 0;
            this.partial = '';
          }
          file = await open(this.path, 'r');
          while (this.offset < size) {
            const buffer = Buffer.alloc(Math.min(256 * 1024, size - this.offset));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
            if (!bytesRead) break;
            this.offset += bytesRead;
            // Keep bytes until a newline, including split UTF-8 code points.
            const bytes = Buffer.concat([
              Buffer.from(this.partial, 'base64'),
              buffer.subarray(0, bytesRead),
            ]);
            const end = bytes.lastIndexOf(10);
            this.partial = bytes.subarray(end + 1).toString('base64');
            if (end < 0) continue;
            for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
              try {
                this.receive(JSON.parse(line));
              } catch {
                /* incomplete/foreign rows are ignored */
              }
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        } finally {
          await file?.close();
        }
      });
    return this.chain;
  }
}

/** Native /goal transport. Aegis never implements a model continuation loop. */
export class ClaudeGoalController {
  private transport?: Transport;
  private boot = deferred<void>();
  readonly ready = this.boot.promise;
  private control?: ReturnType<typeof deferred<string>>;
  private controlText = '';
  private work = 0;
  private idleWaiters = new Set<ReturnType<typeof deferred<void>>>();
  private mutations: Promise<unknown> = Promise.resolve();
  private pausing = false;
  private restoring = true;
  private disposed = false;
  private reader?: GoalTranscriptReader;
  private poll?: ReturnType<typeof setInterval>;
  private pendingSet?: { objective: string; condition: string };
  private pendingClear = false;
  private conditions = new Map<string, string>();
  private seen = new Set<string>();
  private state: ClaudeGoalState;

  constructor(
    private options: {
      sessionId: string;
      storageDir: string;
      initial: ClaudeGoalState;
      resumed: boolean;
      publish(state: ClaudeGoalState): void;
    },
  ) {
    this.state = structuredClone(options.initial);
    // A new process has no running work. Native resume may restore the hook;
    // initialize() clears it before any ordinary prompt is admitted.
    if (this.state.goal?.status === 'active') {
      this.state.goal.status = 'paused';
      this.state.resumeConfirmation = true;
    }
    if (this.state.goal)
      this.conditions.set(
        this.state.goal.objective,
        this.state.goal.displayObjective ?? this.state.goal.objective,
      );
  }

  get snapshot(): ClaudeGoalState {
    return structuredClone(this.state);
  }
  get isClosed(): boolean {
    return this.disposed;
  }
  private publish() {
    if (!this.disposed) this.options.publish(this.snapshot);
  }
  private setGoal(goal: ThreadGoal | null, resumeConfirmation = false) {
    this.state.goal = goal;
    if (!goal || goal.status === 'complete' || goal.status === 'paused')
      this.state.needsClear = false;
    this.state.resumeConfirmation = resumeConfirmation;
    this.publish();
    this.updatePolling();
  }

  private updatePolling() {
    const needed = !!this.reader && this.state.goal?.status === 'active' && !this.disposed;
    if (!needed && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    if (needed && !this.poll) {
      this.poll = setInterval(() => {
        void this.refresh().catch(() => {});
      }, 250);
      this.poll.unref?.();
    }
  }

  async initialize(transport: Transport): Promise<void> {
    this.transport = transport;
    try {
      this.state.supported = (await transport.commands()).some((c) => c.name === 'goal');
      this.publish();
      if (
        this.options.resumed &&
        this.state.supported &&
        (this.state.goal || this.state.needsClear)
      ) {
        // A local command: does not invoke a model or change permission mode.
        await this.localCommand('/goal clear');
        this.state.needsClear = false;
        this.publish();
      }
      this.restoring = false;
      this.boot.resolve();
    } catch (error) {
      this.boot.reject(error as Error);
      throw error;
    }
  }

  async attachTranscript(path: string): Promise<void> {
    if (this.disposed || !path || this.reader?.path === path) return;
    this.state.transcriptPath = path;
    if (!this.state.goal && !this.pendingSet) return;
    this.reader = new GoalTranscriptReader(path, (entry) => this.record(entry));
    // Read historical rows during restoration; they are not new transitions.
    const restoring = this.restoring;
    this.restoring = true;
    try {
      await this.reader.refresh();
    } finally {
      this.restoring = restoring;
    }
    this.publish();
    this.updatePolling();
  }
  async refresh() {
    await this.reader?.refresh();
  }

  private record(entry: Record<string, any>) {
    if (
      entry.isSidechain ||
      entry.type !== 'attachment' ||
      entry.attachment?.type !== 'goal_status'
    )
      return;
    if (typeof entry.uuid !== 'string' || this.seen.has(entry.uuid)) return;
    this.seen.add(entry.uuid);
    const value = entry.attachment;
    if (typeof value.condition !== 'string' || !value.condition || typeof value.met !== 'boolean')
      return;
    if (this.restoring) return;
    if (value.sentinel) {
      // Explicit set/clear commands are acknowledged by local_command_source,
      // not by historical sentinel rows (which also survive /resume).
      return;
    }
    const goal = this.state.goal;
    if (!goal || goal.objective !== value.condition || this.pausing) return;
    const iterations =
      Number.isSafeInteger(value.iterations) && value.iterations >= 0
        ? value.iterations
        : (goal.claude?.iterations ?? 0) + 1;
    const reason = typeof value.reason === 'string' ? value.reason : undefined;
    this.setGoal({
      ...goal,
      status: value.failed ? 'blocked' : value.met ? 'complete' : 'active',
      updatedAt: Date.now() / 1000,
      tokensUsed: Number.isFinite(value.tokens) ? Math.max(0, value.tokens) : goal.tokensUsed,
      timeUsedSeconds: Number.isFinite(value.durationMs)
        ? Math.max(0, value.durationMs / 1000)
        : goal.timeUsedSeconds,
      claude: { iterations, lastReason: reason },
    });
  }

  /** Runs before each actual prompt, after the SDK initialization handshake. */
  async prepare(text: string): Promise<string> {
    await this.ready;
    await this.mutations;
    if (this.disposed) throw new Error('Claude session has closed.');
    const match = /^\s*\/goal(?:\s+([\s\S]*))?$/i.exec(text);
    if (!match) {
      // A failed evaluator may leave the native Stop hook armed. Ordinary
      // follow-ups to a stalled/paused goal must not silently restart it.
      if (
        this.state.goal &&
        !['active', 'complete'].includes(this.state.goal.status) &&
        this.state.supported
      )
        await this.localCommand('/goal clear');
      return text;
    }
    if (!this.state.supported)
      throw new Error(
        'This Claude Code version does not support /goal. Update Claude Code and try again.',
      );
    const objective = (match[1] ?? '').trim();
    if (!objective || isClaudeGoalClearObjective(objective)) return text;
    validateClaudeGoalObjective(objective);
    let condition = objective;
    // Native Claude limits a condition to 4000 UTF-16 units. Long objectives
    // use a private, immutable app-owned file; the UI retains the full text.
    if (condition.length > 4000) {
      await mkdir(this.options.storageDir, { recursive: true, mode: 0o700 });
      const file = join(
        this.options.storageDir,
        `${createHash('sha256').update(objective).digest('hex')}.txt`,
      );
      await writeFile(file, objective, { mode: 0o600 });
      condition = `Complete the goal described in ${JSON.stringify(file)}. Read that file for the full objective and its completion criteria.`;
    }
    this.conditions.set(condition, objective);
    return `/goal ${condition}`;
  }

  /** Only the exact app-owned objective file is implicitly readable. */
  ownsObjectiveFile(filePath: string): boolean {
    return [...this.conditions.values()].some(
      (objective) =>
        objective.length > 4000 &&
        resolve(filePath) ===
          join(
            this.options.storageDir,
            `${createHash('sha256').update(objective).digest('hex')}.txt`,
          ),
    );
  }

  submitted(text: string) {
    this.work++;
    const condition = /^\/goal\s+([\s\S]+)$/i.exec(text)?.[1];
    this.pendingClear = !!condition && isClaudeGoalClearObjective(condition);
    if (condition && this.conditions.has(condition))
      this.pendingSet = { condition, objective: this.conditions.get(condition)! };
    if (this.pendingSet) {
      this.state.needsClear = true;
      this.publish();
    }
  }

  /** True means app-internal command output; omit it from chat/turn accounting. */
  async receive(message: WireMessage): Promise<boolean> {
    if (this.disposed) return true;
    if (message.parent_tool_use_id) return false;
    const local = typeof message.local_command_source === 'string';
    if (this.control) {
      if (local)
        this.controlText = message.local_command_source!.replace(
          /^<local-command-stdout>|<\/local-command-stdout>$/g,
          '',
        );
      if (message.type === 'result') {
        const control = this.control;
        this.control = undefined;
        message.is_error
          ? control.reject(
              new Error(
                String(message.result || this.controlText || 'Claude Goal command failed.'),
              ),
            )
          : control.resolve(this.controlText || String(message.result ?? ''));
      }
      // Preserve init: the host needs the runtime session id on cold controls.
      return !(message.type === 'system' && message.subtype === 'init');
    }
    if (local && this.pendingSet) {
      const { condition, objective } = this.pendingSet;
      if (
        message.local_command_source ===
        `<local-command-stdout>Goal set: ${condition}</local-command-stdout>`
      ) {
        const now = Date.now() / 1000;
        this.pendingSet = undefined;
        this.state.activationId = typeof message.uuid === 'string' ? message.uuid : randomUUID();
        this.setGoal({
          threadId: this.options.sessionId,
          objective: condition,
          displayObjective: objective,
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
          claude: { iterations: 0 },
        });
        return true;
      }
      throw new Error(message.local_command_source!.replace(/<\/?local-command-stdout>/g, ''));
    }
    if (
      local &&
      this.pendingClear &&
      /<local-command-stdout>(?:No goal set|Goal cleared: )/.test(message.local_command_source!)
    ) {
      this.pendingClear = false;
      this.setGoal(null);
      return true;
    }
    if (message.type === 'result') {
      this.work = Math.max(0, this.work - 1);
      this.pendingSet = undefined;
      this.pendingClear = false;
      await this.refresh();
      if (!this.work) {
        for (const waiter of this.idleWaiters) waiter.resolve();
        this.idleWaiters.clear();
        if (!this.pausing && this.state.goal?.status === 'active') {
          // The native transcript writer can flush just after the wire result.
          // Give it a bounded flush window before classifying a stopped goal.
          await new Promise((resolve) => setTimeout(resolve, 200));
          await this.refresh();
          // result means Claude actually stopped. A missing/erroring evaluator
          // cannot be presented as still pursuing, nor as success.
          if (!this.work && !this.pausing && this.state.goal?.status === 'active')
            this.setGoal({ ...this.state.goal, status: 'blocked', updatedAt: Date.now() / 1000 });
        }
      }
    }
    return false;
  }

  private async bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out ${label}.`)), 15_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async localCommand(text: string): Promise<string> {
    if (!this.transport || this.disposed) throw new Error('Claude session is not active.');
    if (this.control) throw new Error('A Claude Goal command is already pending.');
    const control = deferred<string>();
    this.control = control;
    this.controlText = '';
    this.transport.send(text);
    try {
      const result = await this.bounded(control.promise, 'updating the Claude goal');
      if (
        text === '/goal clear' &&
        result !== 'No goal set' &&
        !result.startsWith('Goal cleared: ')
      )
        throw new Error(result || 'Claude did not confirm clearing the goal.');
      return result;
    } catch (error) {
      this.transport.abort();
      throw error;
    } finally {
      if (this.control === control) this.control = undefined;
    }
  }

  change(action: GoalAction): Promise<ThreadGoal | null> {
    const run = this.mutations
      .catch(() => {})
      .then(async () => {
        await this.ready;
        if (action.type === 'set' && action.status !== 'paused')
          throw new Error('Submit the goal through the normal Claude turn dispatcher.');
        const previous = this.state.goal;
        if (!previous && action.type !== 'clear') return null;
        this.pausing = true;
        try {
          if (this.work) {
            const idle = deferred<void>();
            this.idleWaiters.add(idle);
            await this.transport!.interrupt();
            await this.bounded(idle.promise, 'stopping Claude');
          }
          if (this.state.supported) await this.localCommand('/goal clear');
          const next =
            action.type === 'clear'
              ? null
              : previous && {
                  ...previous,
                  status: 'paused' as const,
                  updatedAt: Date.now() / 1000,
                };
          this.setGoal(next);
          return next;
        } catch (error) {
          // No acknowledgement: terminate the owned runtime. On restart the
          // mandatory clear preflight runs before any user turn.
          this.transport?.abort();
          if (previous)
            this.setGoal({ ...previous, status: 'paused', updatedAt: Date.now() / 1000 }, true);
          throw error;
        } finally {
          this.pausing = false;
        }
      });
    this.mutations = run;
    return run;
  }

  async interrupt(): Promise<void> {
    // The host re-interrupts queued stopped turns as each prior result lands.
    // Do not enqueue behind the pause that's waiting for those same results.
    if (this.pausing) {
      await this.transport?.interrupt();
      return;
    }
    if (this.state.goal && this.state.goal.status !== 'complete') {
      await this.change({ type: 'set', status: 'paused' });
    } else {
      await this.transport?.interrupt();
    }
  }
  cancelPendingStart(error: Error) {
    this.transport?.abort();
    this.dispose(error);
  }
  dispose(error = new Error('Claude session has closed.')) {
    if (this.disposed) return;
    if (this.state.goal?.status === 'active')
      this.setGoal({ ...this.state.goal, status: 'paused', updatedAt: Date.now() / 1000 }, true);
    this.disposed = true;
    if (this.poll) clearInterval(this.poll);
    this.boot.reject(error);
    this.control?.reject(error);
    for (const waiter of this.idleWaiters) waiter.reject(error);
    this.idleWaiters.clear();
  }
}
