// Interprets an expanded workflow (plan §5). Every side effect goes through
// the WorkflowHost; the engine owns ordering, conditions, reference
// resolution, step-instance identity and resume.
//
// Instance key: the enclosing repeats with their iteration, then the step id,
// e.g. `build.rounds[1]/build.review.security`. Resume reuses a settled
// instance only when its input fingerprint matches; write and check
// fingerprints include the workspace version they start from, which the
// engine derives from the instances before them rather than from the live
// directory (the Host's version gates compare the live directory).

import type { DEFAULT_LIMITS } from '../limits';
import type {
  AgentStep,
  AskStep,
  CheckStep,
  Condition,
  Member,
  PromptBlock,
  Ref,
  RouteField,
  StopStep,
} from '../spec/workflow-spec';
import type { ImplementationReport, ReviewResult } from '../spec/results';
import type { ExpandedSpec, ReviewLoopPolicy, XRepeatStep, XStep } from './expand';

/** Minimal cancellation view; structurally satisfied by DOM/Node AbortSignal. */
export interface CancelSignal {
  readonly aborted: boolean;
}

export type Version = string;
export type OutputKind = 'implementation' | 'review' | 'notes' | 'route';

export type ResolvedBlock =
  | { kind: 'text'; text: string }
  | { kind: 'goal'; text: string }
  | { kind: 'from'; ref: Ref; instanceKey: string; stepId: string; member?: string; outputKind: string; value: unknown };

export type AgentInstance = {
  key: string;
  stepId: string;
  phase?: string;
  iterations: number[];
  member: Member;
  workspace: 'write' | 'snapshot';
  session: 'continue' | 'fresh';
  outputKind: OutputKind;
  route?: RouteField[];
  blocks: ResolvedBlock[];
  /** write: the version the step must start from (G0); snapshot: the version to read. */
  version: Version;
  /** snapshot steps re-reviewing: the version this reviewer saw last round. */
  diffFrom?: Version;
  /** Host-assigned ids of this reviewer's blocking findings from its previous round. */
  previousBlockingFindingIds: string[];
  fingerprint: string;
};

export type CheckInstance = {
  key: string;
  stepId: string;
  phase?: string;
  iterations: number[];
  argv: string[];
  timeoutMs: number;
  version: Version;
  fingerprint: string;
};

export type AskInstance = {
  key: string;
  stepId: string;
  iterations: number[];
  question: string;
  options?: string[];
  fingerprint: string;
};

export type LeafFailure =
  | { status: 'needs_input'; reason: string; detail?: string }
  | { status: 'failed'; reason: string; detail?: string }
  | { status: 'cancelled' };

export type AgentOutcome =
  | {
      status: 'succeeded';
      executionId: string;
      /** Validated output; review findings carry Host-assigned findingId. */
      output: unknown;
      versionIn: Version;
      /** write steps: the captured version after the turn settled. */
      versionOut?: Version;
      changed?: boolean;
    }
  | LeafFailure;

export type CheckOutcome =
  | {
      status: 'succeeded';
      executionId: string;
      passed: boolean;
      exitCode: number | null;
      versionIn: Version;
      versionOut: Version;
      summary: string;
      logRef?: string;
    }
  | LeafFailure;

export type AskOutcome = { status: 'succeeded'; answer: string } | { status: 'cancelled' };

export type InstanceRecord = {
  key: string;
  stepId: string;
  iterations: number[];
  kind: 'agent' | 'check' | 'ask';
  member?: string;
  outputKind?: OutputKind;
  fingerprint: string;
  state: 'dispatched' | 'settled';
  /** Monotonic settle order within the run. */
  seq?: number;
  executionId?: string;
  versionIn?: Version;
  versionOut?: Version;
  changed?: boolean;
  output?: unknown;
  passed?: boolean;
  answer?: string;
};

export interface InstanceStore {
  get(key: string): InstanceRecord | undefined;
  all(): InstanceRecord[];
  put(record: InstanceRecord): Promise<void>;
}

export type WorkflowEvent =
  | { type: 'instance_started'; key: string; stepId: string }
  | { type: 'instance_reused'; key: string; stepId: string }
  | { type: 'instance_settled'; key: string; stepId: string }
  | { type: 'instance_skipped'; key: string; stepId: string }
  | { type: 'iteration_started'; repeatId: string; iteration: number; max: number };

export interface WorkflowHost {
  runAgent(instance: AgentInstance, signal: CancelSignal): Promise<AgentOutcome>;
  runCheck(instance: CheckInstance, signal: CancelSignal): Promise<CheckOutcome>;
  ask(instance: AskInstance, signal: CancelSignal): Promise<AskOutcome>;
  emit?(event: WorkflowEvent): void;
}

export type NeedsInputReason =
  | 'leaf'
  | 'stop-step'
  | 'repeat-exhausted'
  | 'interrupted-instance'
  | 'budget'
  | 'review-blocked'
  | 'dispute-maintained'
  | 'unresolved-twice'
  | 'no-progress';

export type EngineResult =
  | { status: 'finished'; finalVersion: Version }
  | { status: 'needs_input'; reason: NeedsInputReason; instanceKey?: string; stepId?: string; detail?: string }
  | { status: 'failed'; reason: string; instanceKey?: string; detail?: string }
  | { status: 'cancelled' };

export type EngineOptions = {
  goal: string;
  baselineVersion: Version;
  limits: Pick<typeof DEFAULT_LIMITS, 'maxConcurrent' | 'maxAgentSteps'>;
  signal?: CancelSignal;
  /** User decisions from earlier needs_input: extra iterations granted per repeat id. */
  extraIterations?: Record<string, number>;
  /** Interrupted instances the user chose to run again. */
  rerunInstances?: string[];
};

type Scope = Array<{ repeatId: string; iteration: number; max: number }>;

class Halt {
  constructor(readonly result: Exclude<EngineResult, { status: 'finished' }>) {}
}

export async function runWorkflow(
  spec: ExpandedSpec,
  host: WorkflowHost,
  store: InstanceStore,
  options: EngineOptions,
): Promise<EngineResult> {
  const engine = new Engine(spec, host, store, options);
  return engine.run();
}

class Engine {
  private readonly members = new Map<string, Member>();
  private readonly stepIndex = new Map<string, { step: XStep; repeats: string[] }>();
  private latestVersion: Version;
  private halted: Halt | null = null;
  private agentExecutions = 0;
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private seq = 0;
  private readonly unresolvedCounts = new Map<string, number>();
  private readonly signal: CancelSignal;

  constructor(
    private readonly spec: ExpandedSpec,
    private readonly host: WorkflowHost,
    private readonly store: InstanceStore,
    private readonly options: EngineOptions,
  ) {
    for (const member of spec.members) this.members.set(member.key, member);
    this.index(spec.steps, []);
    this.latestVersion = options.baselineVersion;
    this.signal = options.signal ?? { aborted: false };
    for (const record of store.all()) {
      if (record.seq !== undefined) this.seq = Math.max(this.seq, record.seq);
    }
  }

  private index(steps: XStep[], repeats: string[]) {
    for (const step of steps) {
      this.stepIndex.set(step.id, { step, repeats });
      if (step.kind === 'parallel' || step.kind === 'sequence') this.index(step.steps, repeats);
      if (step.kind === 'repeat') this.index(step.steps, [...repeats, step.id]);
    }
  }

  async run(): Promise<EngineResult> {
    try {
      await this.runSequence(this.spec.steps, []);
      if (this.halted) return this.halted.result;
      if (this.signal.aborted) return { status: 'cancelled' };
      return { status: 'finished', finalVersion: this.latestVersion };
    } catch (error) {
      if (error instanceof Halt) return error.result;
      throw error;
    }
  }

  private halt(result: Exclude<EngineResult, { status: 'finished' }>): never {
    if (!this.halted) this.halted = new Halt(result);
    throw this.halted;
  }

  private checkContinue() {
    if (this.halted) throw this.halted;
    if (this.signal.aborted) this.halt({ status: 'cancelled' });
  }

  private async runSequence(steps: XStep[], scope: Scope) {
    for (const step of steps) {
      this.checkContinue();
      await this.runStep(step, scope);
    }
  }

  private async runStep(step: XStep, scope: Scope): Promise<void> {
    switch (step.kind) {
      case 'sequence':
        return this.runSequence(step.steps, scope);
      case 'parallel': {
        const results = await Promise.allSettled(step.steps.map((child) => this.runStep(child, scope)));
        for (const result of results) {
          if (result.status === 'rejected' && !(result.reason instanceof Halt)) throw result.reason;
        }
        if (this.halted) throw this.halted;
        return;
      }
      case 'repeat':
        return this.runRepeat(step, scope);
      case 'agent':
        return this.runAgent(step, scope);
      case 'check':
        return this.runCheck(step, scope);
      case 'ask':
        return this.runAsk(step, scope);
      case 'stop':
        return this.runStop(step, scope);
    }
  }

  private async runRepeat(step: XRepeatStep, scope: Scope) {
    const max = step.max + (this.options.extraIterations?.[step.id] ?? 0);
    for (let iteration = 0; iteration < max; iteration += 1) {
      this.checkContinue();
      const inner: Scope = [...scope, { repeatId: step.id, iteration, max }];
      this.host.emit?.({ type: 'iteration_started', repeatId: step.id, iteration, max });
      const writesBefore = this.writeRecordsIn(step.id, inner);
      for (const child of step.steps) {
        this.checkContinue();
        await this.runStep(child, inner);
        if (step.policy && child.id === step.policy.reviewsStepId) this.applyReviewPolicy(step.policy, inner);
      }
      if (this.evaluate(step.until, inner)) return;
      const writes = this.writeRecordsIn(step.id, inner).slice(writesBefore.length);
      if (writes.length > 0 && writes.every((w) => w.changed === false)) {
        this.halt({ status: 'needs_input', reason: 'no-progress', stepId: step.id });
      }
    }
    if (step.policy?.reportOnly && !this.options.extraIterations?.[step.id]) return;
    this.halt({ status: 'needs_input', reason: 'repeat-exhausted', stepId: step.id });
  }

  private writeRecordsIn(repeatId: string, scope: Scope): InstanceRecord[] {
    const prefix = scopePrefix(scope);
    return this.store
      .all()
      .filter((r) => r.state === 'settled' && r.key.startsWith(prefix) && r.versionOut !== undefined && r.kind === 'agent')
      .filter((r) => this.stepIndex.get(r.stepId)?.repeats.includes(repeatId));
  }

  /** reviewLoop convergence rules, applied once a round's reviews have settled. */
  private applyReviewPolicy(policy: ReviewLoopPolicy, scope: Scope) {
    const reviews = policy.reviewStepIds
      .map((id) => this.recordAt(id, scope))
      .filter((r): r is InstanceRecord => r?.state === 'settled');
    for (const record of reviews) {
      const review = record.output as ReviewResult;
      if (review.verdict === 'blocked') {
        this.halt({ status: 'needs_input', reason: 'review-blocked', instanceKey: record.key, stepId: record.stepId });
      }
    }
    const previousFix = this.resolveRef({ step: policy.fixStepId, iteration: 'previous' }, scope);
    const disputed = new Set(
      ((previousFix?.output as ImplementationReport | undefined)?.findingResponses ?? [])
        .filter((r) => r.action === 'disputed')
        .map((r) => r.findingId),
    );
    for (const record of reviews) {
      for (const previous of (record.output as ReviewResult).previousFindings ?? []) {
        if (previous.status !== 'unresolved') continue;
        if (disputed.has(previous.findingId)) {
          this.halt({
            status: 'needs_input',
            reason: 'dispute-maintained',
            instanceKey: record.key,
            stepId: record.stepId,
            detail: previous.findingId,
          });
        }
        const count = (this.unresolvedCounts.get(previous.findingId) ?? 0) + 1;
        this.unresolvedCounts.set(previous.findingId, count);
        if (count >= 2) {
          this.halt({
            status: 'needs_input',
            reason: 'unresolved-twice',
            instanceKey: record.key,
            stepId: record.stepId,
            detail: previous.findingId,
          });
        }
      }
    }
  }

  // ---- leaves -------------------------------------------------------------

  private async runAgent(step: AgentStep, scope: Scope) {
    const key = instanceKey(step.id, scope);
    if (step.if && !this.evaluate(step.if, scope)) {
      this.host.emit?.({ type: 'instance_skipped', key, stepId: step.id });
      return;
    }
    const member = this.members.get(step.member);
    if (!member) this.halt({ status: 'failed', reason: `Unknown member "${step.member}".`, instanceKey: key });
    const workspace = step.workspace ?? (member.role === 'implementer' ? 'write' : 'snapshot');
    const session = step.session ?? (member.role === 'implementer' ? 'continue' : 'fresh');
    const outputKind: OutputKind = typeof step.output === 'string' ? step.output : 'route';
    const blocks = this.resolveBlocks(step.task, scope);
    const previousSelf = outputKind === 'review' ? this.resolveRef({ step: step.id, iteration: 'previous' }, scope) : null;
    const previousBlockingFindingIds = previousSelf
      ? ((previousSelf.output as ReviewResult).findings ?? [])
          .filter((f) => f.severity === 'blocking' && f.findingId)
          .map((f) => f.findingId as string)
      : [];
    const version = this.latestVersion;
    const continuation =
      session === 'continue'
        ? this.store
            .all()
            .filter((r) => r.state === 'settled' && r.member === member.key && r.kind === 'agent' && r.key !== key)
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            .map((r) => r.executionId)
        : [];
    const fingerprint = canonicalJson({
      step: step.id,
      member: [member.key, member.agent, member.model ?? null],
      workspace,
      session,
      outputKind,
      route: typeof step.output === 'string' ? null : step.output.route,
      blocks: blocks.map((b) => (b.kind === 'from' ? { from: b.instanceKey, value: b.value } : b)),
      version,
      continuation,
    });

    const instance: AgentInstance = {
      key,
      stepId: step.id,
      ...(step.phase ? { phase: step.phase } : {}),
      iterations: scope.map((s) => s.iteration),
      member,
      workspace,
      session,
      outputKind,
      ...(typeof step.output === 'string' ? {} : { route: step.output.route }),
      blocks,
      version,
      ...(previousSelf?.versionIn ? { diffFrom: previousSelf.versionIn } : {}),
      previousBlockingFindingIds,
      fingerprint,
    };

    const reused = this.reuse(key, fingerprint, workspace === 'write');
    if (reused) {
      if (reused.versionOut) this.latestVersion = reused.versionOut;
      return;
    }
    if (this.agentExecutions + this.settledAgentCount() >= this.options.limits.maxAgentSteps) {
      this.halt({ status: 'needs_input', reason: 'budget', instanceKey: key, stepId: step.id });
    }
    this.agentExecutions += 1;
    const outcome = await this.leaf(key, step.id, () => this.host.runAgent(instance, this.signal), {
      kind: 'agent',
      member: member.key,
      outputKind,
      fingerprint,
      iterations: instance.iterations,
    });
    if (outcome.status !== 'succeeded') this.failLeaf(outcome, key, step.id);
    const record: InstanceRecord = {
      key,
      stepId: step.id,
      iterations: instance.iterations,
      kind: 'agent',
      member: member.key,
      outputKind,
      fingerprint,
      state: 'settled',
      seq: ++this.seq,
      executionId: outcome.executionId,
      versionIn: outcome.versionIn,
      ...(outcome.versionOut !== undefined ? { versionOut: outcome.versionOut, changed: outcome.changed } : {}),
      output: outcome.output,
    };
    await this.store.put(record);
    if (outcome.versionOut !== undefined) this.latestVersion = outcome.versionOut;
    this.host.emit?.({ type: 'instance_settled', key, stepId: step.id });
  }

  private async runCheck(step: CheckStep, scope: Scope) {
    const key = instanceKey(step.id, scope);
    if (step.if && !this.evaluate(step.if, scope)) {
      this.host.emit?.({ type: 'instance_skipped', key, stepId: step.id });
      return;
    }
    const version = this.latestVersion;
    const fingerprint = canonicalJson({ step: step.id, argv: step.argv, timeoutMs: step.timeoutMs, version });
    const instance: CheckInstance = {
      key,
      stepId: step.id,
      ...(step.phase ? { phase: step.phase } : {}),
      iterations: scope.map((s) => s.iteration),
      argv: step.argv,
      timeoutMs: step.timeoutMs,
      version,
      fingerprint,
    };
    const reused = this.reuse(key, fingerprint, true);
    if (reused) {
      if (reused.versionOut) this.latestVersion = reused.versionOut;
      return;
    }
    const outcome = await this.leaf(key, step.id, () => this.host.runCheck(instance, this.signal), {
      kind: 'check',
      fingerprint,
      iterations: instance.iterations,
    });
    if (outcome.status !== 'succeeded') this.failLeaf(outcome, key, step.id);
    await this.store.put({
      key,
      stepId: step.id,
      iterations: instance.iterations,
      kind: 'check',
      fingerprint,
      state: 'settled',
      seq: ++this.seq,
      executionId: outcome.executionId,
      versionIn: outcome.versionIn,
      versionOut: outcome.versionOut,
      changed: outcome.versionOut !== outcome.versionIn,
      passed: outcome.passed && outcome.versionOut === outcome.versionIn,
      output: { exitCode: outcome.exitCode, summary: outcome.summary, logRef: outcome.logRef ?? null },
    });
    this.latestVersion = outcome.versionOut;
    this.host.emit?.({ type: 'instance_settled', key, stepId: step.id });
  }

  private async runAsk(step: AskStep, scope: Scope) {
    const key = instanceKey(step.id, scope);
    if (step.if && !this.evaluate(step.if, scope)) {
      this.host.emit?.({ type: 'instance_skipped', key, stepId: step.id });
      return;
    }
    const fingerprint = canonicalJson({ step: step.id, question: step.question, options: step.options ?? null });
    const reused = this.reuse(key, fingerprint, false);
    if (reused) return;
    const iterations = scope.map((s) => s.iteration);
    const outcome = await this.leaf(
      key,
      step.id,
      () =>
        this.host.ask(
          { key, stepId: step.id, iterations, question: step.question, ...(step.options ? { options: step.options } : {}), fingerprint },
          this.signal,
        ),
      { kind: 'ask', fingerprint, iterations },
    );
    if (outcome.status !== 'succeeded') this.halt({ status: 'cancelled' });
    await this.store.put({
      key,
      stepId: step.id,
      iterations,
      kind: 'ask',
      fingerprint,
      state: 'settled',
      seq: ++this.seq,
      answer: outcome.answer,
      output: { answer: outcome.answer },
    });
    this.host.emit?.({ type: 'instance_settled', key, stepId: step.id });
  }

  private async runStop(step: StopStep, scope: Scope) {
    if (step.if && !this.evaluate(step.if, scope)) return;
    this.halt({ status: 'needs_input', reason: 'stop-step', stepId: step.id, detail: step.reason });
  }

  /** Persist `dispatched` before handing the instance to the Host, under the concurrency limit. */
  private async leaf<T>(
    key: string,
    stepId: string,
    call: () => Promise<T>,
    meta: Pick<InstanceRecord, 'kind' | 'fingerprint' | 'iterations' | 'member' | 'outputKind'>,
  ): Promise<T> {
    await this.acquire();
    try {
      this.checkContinue();
      await this.store.put({ key, stepId, state: 'dispatched', ...meta });
      this.host.emit?.({ type: 'instance_started', key, stepId });
      return await call();
    } finally {
      this.release();
    }
  }

  private failLeaf(outcome: LeafFailure, key: string, stepId: string): never {
    if (outcome.status === 'cancelled') this.halt({ status: 'cancelled' });
    if (outcome.status === 'needs_input') {
      this.halt({ status: 'needs_input', reason: 'leaf', instanceKey: key, stepId, detail: outcome.detail ?? outcome.reason });
    }
    this.halt({ status: 'failed', reason: outcome.reason, instanceKey: key, ...(outcome.detail ? { detail: outcome.detail } : {}) });
  }

  /**
   * A settled record with the same fingerprint is reused. A record left
   * `dispatched` was in flight when the run stopped: writes and checks never
   * re-run without the user choosing to (after the Host confirmed the old
   * execution stopped); read-only steps simply run again.
   */
  private reuse(key: string, fingerprint: string, sideEffecting: boolean): InstanceRecord | null {
    const record = this.store.get(key);
    if (!record) return null;
    if (record.state === 'settled') {
      if (record.fingerprint !== fingerprint) return null;
      this.host.emit?.({ type: 'instance_reused', key, stepId: record.stepId });
      return record;
    }
    if (sideEffecting && !(this.options.rerunInstances ?? []).includes(key)) {
      this.halt({ status: 'needs_input', reason: 'interrupted-instance', instanceKey: key, stepId: record.stepId });
    }
    return null;
  }

  private settledAgentCount(): number {
    return this.store.all().filter((r) => r.kind === 'agent' && r.state === 'settled').length;
  }

  private async acquire() {
    if (this.running < this.options.limits.maxConcurrent) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.running += 1;
  }

  private release() {
    this.running -= 1;
    this.waiters.shift()?.();
  }

  // ---- references & conditions --------------------------------------------

  private resolveBlocks(blocks: PromptBlock[], scope: Scope): ResolvedBlock[] {
    const resolved: ResolvedBlock[] = [];
    for (const block of blocks) {
      if ('text' in block) resolved.push({ kind: 'text', text: block.text });
      else if ('goal' in block) resolved.push({ kind: 'goal', text: this.options.goal });
      else {
        const record = this.resolveRef(block.from, scope);
        if (!record || record.state !== 'settled') continue;
        const value = block.from.field ? fieldOf(record.output, block.from.field) : record.output;
        resolved.push({
          kind: 'from',
          ref: block.from,
          instanceKey: record.key,
          stepId: record.stepId,
          ...(record.member ? { member: record.member } : {}),
          outputKind: record.outputKind ?? record.kind,
          value,
        });
      }
    }
    return resolved;
  }

  /**
   * §4.3: repeats shared with the current scope use the current iteration
   * (or the previous one for `iteration: 'previous'` on the innermost shared
   * repeat); repeats not enclosing the reader resolve to their last settled
   * instance.
   */
  private resolveRef(ref: Ref, scope: Scope): InstanceRecord | null {
    const target = this.stepIndex.get(ref.step);
    if (!target) return null;
    const shared = target.repeats.filter((r) => scope.some((s) => s.repeatId === r));
    const required = new Map<string, number>();
    for (const repeatId of shared) {
      const current = scope.find((s) => s.repeatId === repeatId)!.iteration;
      required.set(repeatId, current);
    }
    if (ref.iteration === 'previous') {
      const innermost = shared[shared.length - 1];
      if (innermost === undefined) return null;
      const previous = (required.get(innermost) ?? 0) - 1;
      if (previous < 0) return null;
      required.set(innermost, previous);
    }
    const candidates = this.store
      .all()
      .filter((r) => r.stepId === ref.step && r.state === 'settled')
      .filter((r) =>
        target.repeats.every((repeatId, i) => !required.has(repeatId) || r.iterations[i] === required.get(repeatId)),
      )
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return candidates[candidates.length - 1] ?? null;
  }

  private recordAt(stepId: string, scope: Scope): InstanceRecord | undefined {
    return this.resolveRef({ step: stepId }, scope) ?? undefined;
  }

  private evaluate(condition: Condition, scope: Scope): boolean {
    if ('all' in condition) return condition.all.every((c) => this.evaluate(c, scope));
    if ('any' in condition) return condition.any.some((c) => this.evaluate(c, scope));
    if ('not' in condition) return !this.evaluate(condition.not, scope);
    if ('lastIteration' in condition) {
      const innermost = scope[scope.length - 1];
      return innermost !== undefined && innermost.iteration === innermost.max - 1;
    }
    if ('approved' in condition) {
      return condition.approved.every(
        (id) => (this.recordAt(id, scope)?.output as ReviewResult | undefined)?.verdict === 'approved',
      );
    }
    if ('checkPassed' in condition) {
      return condition.checkPassed.every((id) => this.recordAt(id, scope)?.passed === true);
    }
    if ('hasBlocking' in condition) {
      return condition.hasBlocking.some((id) =>
        ((this.recordAt(id, scope)?.output as ReviewResult | undefined)?.findings ?? []).some((f) => f.severity === 'blocking'),
      );
    }
    if ('hasQuestions' in condition) {
      const report = this.recordAt(condition.hasQuestions, scope)?.output as ImplementationReport | undefined;
      return (report?.questions?.length ?? 0) > 0;
    }
    if ('changed' in condition) return this.recordAt(condition.changed, scope)?.changed === true;
    const record = this.resolveRef(condition.equals.ref, scope);
    if (!record || !condition.equals.ref.field) return false;
    const value = fieldOf(record.output, condition.equals.ref.field);
    return value !== undefined && String(value) === condition.equals.value;
  }
}

export function instanceKey(stepId: string, scope: Scope): string {
  return `${scopePrefix(scope)}${stepId}`;
}

function scopePrefix(scope: Scope): string {
  return scope.map((s) => `${s.repeatId}[${s.iteration}]/`).join('');
}

function fieldOf(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[field];
}

/** JSON with sorted object keys, so equal inputs always produce equal strings. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
