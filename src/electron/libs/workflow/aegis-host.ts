// AegisWorkflowHost: performs every side effect of a workflow step on behalf
// of the engine and enforces the Host-side guarantees (plan §6): member
// policies, version gates, review copies, single-writer leases, authorized
// check commands and structured-result validation.

import * as path from 'path';
import type {
  AgentInstance,
  AgentOutcome,
  AskInstance,
  AskOutcome,
  CheckInstance,
  CheckOutcome,
  WorkflowEvent,
  WorkflowHost,
} from '../../../workflow-engine/engine/engine';
import { isAuthorizedAtRuntime } from '../../../workflow-engine/authorize/check-authorization';
import type { ReviewResult } from '../../../workflow-engine/spec/results';
import type { SessionContinuePayload, SessionStartPayload } from '../../../shared/types';
import { CURRENT_SESSION_AGENT, type WorkflowSessionPolicy } from '../../../shared/workflow';
import { runCheckCommand } from './check-executor';
import { declarationFor, memberSessionPayload } from './member-configs';
import {
  cancelTurnExpectation,
  expectTurn,
  setWorkflowSessionPolicy,
  type TurnOutcome,
} from './session-hooks';
import { assignFindingIds, extractJson, renderBrief, repairPrompt, validateOutput } from './task-brief';
import {
  captureTree,
  exportTree,
  fingerprintDirectory,
  repoInfo,
  retainTree,
  SnapshotError,
  writeTreeDiff,
} from './workspace-snapshot';
import { recordResource, setMemberSession, type MemberRow, type RunRow, type SqliteInstanceStore } from './workflow-store';

export type SessionBridge = {
  start(payload: SessionStartPayload, onCreated: (sessionId: string) => void): Promise<string | null>;
  continue(payload: SessionContinuePayload): Promise<boolean>;
  stop(sessionId: string): void;
  sessionCwd(sessionId: string): string | null;
  /** The session is running a turn (its own, or one the user sent). */
  isBusy(sessionId: string): boolean;
};

export type RunControl = {
  /** Stop in-flight work (cancel). Pausing only stops new dispatches, in the engine. */
  cancelled: boolean;
};

/** Engine events plus what only the Host knows: a question for the user, a member session that just started. */
export type HostEvent =
  | WorkflowEvent
  | { type: 'ask'; key: string; question: string; options?: string[] }
  | { type: 'session_attached'; key: string; sessionId: string };

const GATE_SETTLE_MS = 1_500;
const GATE_ATTEMPTS = 3;
const STOP_CONFIRM_MS = 20_000;
const IDLE_POLL_MS = 1_000;

/** One writer per working tree across all runs in this app process (plan §6.4). */
const leases = new Map<string, string>();

function shortId(version: string) {
  return version.slice(0, 12);
}

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  opencode: 'OpenCode',
  grok: 'Grok',
  pi: 'Pi',
  qoder: 'Qoder',
  bubble: 'Bubble',
  deepseek: 'DeepSeek',
  devin: 'Devin',
};

/** One-line notice the chat shows for a workflow turn of the session itself (the agent gets the full brief). */
function currentSessionDisplay(instance: AgentInstance, members: Map<string, MemberRow>): string {
  const reviewers = [
    ...new Set(
      instance.blocks.flatMap((b) =>
        b.kind === 'from' && b.outputKind === 'review' && b.member ? [members.get(b.member)?.agent ?? b.member] : [],
      ),
    ),
  ].map((agent) => AGENT_LABELS[agent] ?? agent);
  const round = instance.iterations.length ? ` (round ${instance.iterations[instance.iterations.length - 1] + 1})` : '';
  if (instance.outputKind === 'implementation' && reviewers.length > 0) {
    return `Workflow asked this chat to fix ${reviewers.join(' and ')}'s findings${round}`;
  }
  if (instance.outputKind === 'implementation') return `Workflow asked this chat to implement the task${round}`;
  return `Workflow asked this chat for ${instance.phase ?? instance.stepId}${round}`;
}

function safeName(key: string) {
  return key.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export class AegisWorkflowHost implements WorkflowHost {
  private turnCounter = 0;
  private pendingAsk: { key: string; resolve: (outcome: AskOutcome) => void } | null = null;

  constructor(
    private readonly deps: {
      getRun: () => RunRow;
      members: () => Map<string, MemberRow>;
      store: SqliteInstanceStore;
      bridge: SessionBridge;
      artifactsDir: string;
      control: RunControl;
      appGeneration: string;
      onEvent: (event: HostEvent) => void;
    },
  ) {}

  emit(event: WorkflowEvent) {
    this.deps.onEvent(event);
  }

  /**
   * Record the session a step runs in and tell the UI right away, so a
   * running step's lane can open that session (otherwise the view only
   * learns it when the step settles).
   */
  private async attachSession(key: string, sessionId: string) {
    await this.deps.store.attachSession(key, sessionId);
    this.deps.onEvent({ type: 'session_attached', key, sessionId });
  }

  // ---- agent steps ------------------------------------------------------------

  async runAgent(instance: AgentInstance): Promise<AgentOutcome> {
    const run = this.deps.getRun();
    const member = this.deps.members().get(instance.member.key);
    const declaration = member ? declarationFor(member.provider) : undefined;
    if (!member || !declaration) return { status: 'failed', reason: `No configuration for member "${instance.member.key}".` };
    if (this.deps.control.cancelled) return { status: 'cancelled' };

    let workspaceDir: string;
    let versionIn = instance.version;
    let releaseLease: (() => void) | null = null;
    let copy: { dir: string; root: string; fingerprint: string } | null = null;
    const briefContext: Parameters<typeof renderBrief>[1] = { runTitle: run.title, workspaceDir: run.cwd };

    try {
      if (instance.workspace === 'write') {
        const gate = await this.gateZero(instance.version);
        if ('needsInput' in gate) return gate.needsInput;
        versionIn = gate.version;
        const lease = await this.acquireLease(instance.key);
        if ('needsInput' in lease) return lease.needsInput;
        releaseLease = lease.release;
        workspaceDir = run.cwd;
      } else {
        copy = await this.reviewCopy(instance);
        workspaceDir = copy.dir;
        briefContext.workspaceDir = copy.dir;
        const base = run.options.diffBase ?? run.baselineVersion ?? instance.version;
        const baseDiff = await this.diffFile(base, instance.version);
        briefContext.baselineDiffPath = baseDiff.path;
        briefContext.changedFiles = baseDiff.files;
        if (instance.diffFrom && instance.diffFrom !== instance.version) {
          briefContext.previousDiffPath = (await this.diffFile(instance.diffFrom, instance.version)).path;
        }
      }
    } catch (error) {
      releaseLease?.();
      return this.snapshotFailure(error);
    }

    try {
      const role = member.role;
      const policy: WorkflowSessionPolicy = { runId: run.id, role, readOnly: role !== 'implementer' };
      const isCurrent = member.agent === CURRENT_SESSION_AGENT;
      // The chat session keeps its own permission mode: nothing is overridden.
      const payload = isCurrent ? {} : memberSessionPayload(declaration, role, run.options.permissionModes).payload;
      const prompt = renderBrief(instance, briefContext);
      const display = isCurrent ? currentSessionDisplay(instance, this.deps.members()) : undefined;

      const reuse =
        instance.session === 'continue' && member.currentSessionId && this.deps.bridge.sessionCwd(member.currentSessionId) === workspaceDir
          ? member.currentSessionId
          : null;
      let sessionId: string;
      let turn: TurnOutcome;
      if (isCurrent) {
        if (!reuse) {
          return {
            status: 'needs_input',
            reason: 'parent-moved',
            detail: 'The chat session that started this workflow no longer works in this folder.',
          };
        }
        sessionId = reuse;
        if (!(await this.waitUntilIdle(sessionId))) return { status: 'cancelled' };
        await this.attachSession(instance.key, sessionId);
        turn = await this.continueTurn(sessionId, prompt, member.provider, payload, display);
      } else if (reuse) {
        sessionId = reuse;
        setWorkflowSessionPolicy(sessionId, policy);
        await this.attachSession(instance.key, sessionId);
        turn = await this.continueTurn(sessionId, prompt, member.provider, payload);
      } else {
        const started = await this.startTurn(instance, member, workspaceDir, prompt, payload, policy);
        if ('failure' in started) return started.failure;
        sessionId = started.sessionId;
        turn = started.turn;
      }

      const settled = this.turnFailure(turn);
      if (settled) return settled;

      let output = this.parse(instance, turn.text);
      if ('errors' in output && !this.deps.control.cancelled) {
        const repair = await this.continueTurn(
          sessionId,
          repairPrompt(output.errors, instance.outputKind),
          member.provider,
          payload,
          isCurrent ? 'Workflow asked this chat to resend its result' : undefined,
        );
        const repairFailure = this.turnFailure(repair);
        if (repairFailure) return repairFailure;
        output = this.parse(instance, repair.text);
      }
      if ('errors' in output) {
        return { status: 'needs_input', reason: 'invalid-result', detail: output.errors.join(' ') };
      }

      const executionId = `${sessionId}#${++this.turnCounter}`;
      if (instance.workspace === 'write') {
        const captured = await this.settledVersion();
        if ('needsInput' in captured) return captured.needsInput;
        await retainTree(run.cwd, captured.version, run.id, instance.key);
        return {
          status: 'succeeded',
          executionId,
          output: output.value,
          versionIn,
          versionOut: captured.version,
          changed: captured.version !== versionIn,
        };
      }
      if (copy && (await fingerprintDirectory(copy.root)) !== copy.fingerprint) {
        return {
          status: 'failed',
          reason: 'policy-violation',
          detail: `${member.key} modified its read-only review copy; its result is not accepted.`,
        };
      }
      return { status: 'succeeded', executionId, output: output.value, versionIn };
    } catch (error) {
      return this.snapshotFailure(error);
    } finally {
      releaseLease?.();
    }
  }

  private parse(instance: AgentInstance, text: string): { value: unknown } | { errors: string[] } {
    const extracted = extractJson(text);
    if ('error' in extracted) return { errors: [extracted.error] };
    const errors = validateOutput(instance, extracted.value);
    if (errors.length > 0) return { errors };
    const value =
      instance.outputKind === 'review' ? assignFindingIds(instance.key, extracted.value as ReviewResult) : extracted.value;
    return { value };
  }

  private turnFailure(turn: TurnOutcome): AgentOutcome | null {
    if (this.deps.control.cancelled) return { status: 'cancelled' };
    if (turn.status === 'error') return { status: 'failed', reason: 'agent-error', detail: turn.error ?? 'The agent turn failed.' };
    if (turn.status === 'stopped') {
      return { status: 'needs_input', reason: 'member-stopped', detail: turn.error ?? 'The member session was stopped.' };
    }
    return null;
  }

  private async startTurn(
    instance: AgentInstance,
    member: MemberRow,
    cwd: string,
    prompt: string,
    payload: Partial<SessionStartPayload>,
    policy: WorkflowSessionPolicy,
  ): Promise<{ sessionId: string; turn: TurnOutcome } | { failure: AgentOutcome }> {
    const run = this.deps.getRun();
    let created: string | null = null;
    let turnPromise: Promise<TurnOutcome> | null = null;
    const id = await this.deps.bridge.start(
      {
        ...payload,
        title: `${run.title} · ${member.key}`,
        prompt,
        workflowPrompt: 'task',
        ...this.sessionLocation(cwd),
        provider: member.provider as SessionStartPayload['provider'],
        ...(member.model ? { model: member.model } : {}),
        hiddenFromThreads: true,
        skipTitleGeneration: true,
      },
      (sessionId) => {
        created = sessionId;
        // Policy and turn observation must be in place before the runner starts.
        setWorkflowSessionPolicy(sessionId, policy);
        turnPromise = expectTurn(sessionId);
        setMemberSession(run.id, member.key, sessionId);
        member.currentSessionId = sessionId;
        void this.attachSession(instance.key, sessionId);
      },
    );
    if (!id || !turnPromise) {
      if (created) cancelTurnExpectation(created);
      return { failure: { status: 'failed', reason: 'session-start-failed', detail: `${member.provider} could not start.` } };
    }
    this.recordAgentResource(instance.key, id);
    return { sessionId: id, turn: await this.awaitTurn(id, turnPromise) };
  }

  /**
   * The session store derives a session's cwd from projectCwd (or the
   * worktree path for worktree sessions), so both must point where the member
   * works: the review copy for read-only members, the run directory for the
   * implementer. Isolated runs mark the implementer as a worktree session so
   * the existing "Apply to project" flow can take its result.
   */
  private sessionLocation(cwd: string): Partial<SessionStartPayload> {
    const run = this.deps.getRun();
    const isolated = run.options.isolated;
    if (isolated && cwd === isolated.worktreePath) {
      return {
        cwd,
        projectCwd: isolated.repoRoot,
        envMode: 'worktree',
        worktreePath: isolated.worktreePath,
        associatedWorktreePath: isolated.worktreePath,
        associatedWorktreeBranch: isolated.branch,
        associatedWorktreeRef: isolated.baseRef,
      };
    }
    return { cwd, projectCwd: cwd, envMode: 'local' };
  }

  /**
   * `display` is what the conversation shows for this turn when the session
   * is one the user reads (the chat session that started the run); the agent
   * still receives the full brief.
   */
  private async continueTurn(
    sessionId: string,
    prompt: string,
    provider: string,
    payload: Partial<SessionStartPayload>,
    display?: string,
  ): Promise<TurnOutcome> {
    const turnPromise = expectTurn(sessionId);
    const ok = await this.deps.bridge.continue({
      ...(payload as Partial<SessionContinuePayload>),
      sessionId,
      ...(display ? { prompt: display, effectivePrompt: prompt, workflowPrompt: 'event' as const } : { prompt, workflowPrompt: 'task' as const }),
      provider: provider as SessionContinuePayload['provider'],
    });
    if (!ok) {
      cancelTurnExpectation(sessionId);
      return { status: 'error', text: '', error: 'The session could not accept the prompt.', deniedTools: [] };
    }
    return this.awaitTurn(sessionId, turnPromise);
  }

  /** The chat session finishes its own turn (or the user's) before the workflow sends it one. */
  private async waitUntilIdle(sessionId: string): Promise<boolean> {
    while (this.deps.bridge.isBusy(sessionId)) {
      if (this.deps.control.cancelled) return false;
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
    return !this.deps.control.cancelled;
  }

  /** Wait for the turn; on cancel, stop the session and wait for the stop to settle. */
  private async awaitTurn(sessionId: string, turnPromise: Promise<TurnOutcome>): Promise<TurnOutcome> {
    let stopRequested = false;
    const poll = setInterval(() => {
      if (this.deps.control.cancelled && !stopRequested) {
        stopRequested = true;
        this.deps.bridge.stop(sessionId);
      }
    }, 250);
    try {
      return await turnPromise;
    } finally {
      clearInterval(poll);
      if (stopRequested) {
        await Promise.race([turnPromise, new Promise((resolve) => setTimeout(resolve, STOP_CONFIRM_MS))]);
      }
    }
  }

  private recordAgentResource(instanceKey: string, sessionId: string) {
    const run = this.deps.getRun();
    recordResource({
      id: `${run.id}:${instanceKey}:${sessionId}`,
      runId: run.id,
      instanceKey,
      kind: 'agent-session',
      pid: null,
      startedAt: Date.now(),
      appGeneration: this.deps.appGeneration,
      state: 'running',
      detail: sessionId,
    });
  }

  // ---- check steps ------------------------------------------------------------

  async runCheck(instance: CheckInstance): Promise<CheckOutcome> {
    const run = this.deps.getRun();
    const control = this.deps.control;
    if (control.cancelled) return { status: 'cancelled' };
    if (!isAuthorizedAtRuntime(instance.argv, run.options.approvedChecks)) {
      return {
        status: 'needs_input',
        reason: 'unauthorized-check',
        detail: `"${instance.argv.join(' ')}" was not authorized for this run.`,
      };
    }
    let releaseLease: (() => void) | null = null;
    try {
      const gate = await this.gateZero(instance.version);
      if ('needsInput' in gate) return gate.needsInput;
      const lease = await this.acquireLease(instance.key);
      if ('needsInput' in lease) return lease.needsInput;
      releaseLease = lease.release;
      const versionIn = gate.version;
      const resourceId = `${run.id}:${instance.key}:check`;
      const result = await runCheckCommand({
        argv: instance.argv,
        cwd: run.cwd,
        timeoutMs: instance.timeoutMs,
        logPath: path.join(this.deps.artifactsDir, 'logs', `${safeName(instance.key)}.log`),
        signal: { get aborted() { return control.cancelled; } },
        onStarted: (pid, startedAt) =>
          recordResource({
            id: resourceId,
            runId: run.id,
            instanceKey: instance.key,
            kind: 'check-process',
            pid,
            startedAt,
            appGeneration: this.deps.appGeneration,
            state: 'running',
          }),
      });
      recordResource({
        id: resourceId,
        runId: run.id,
        instanceKey: instance.key,
        kind: 'check-process',
        pid: result.pid,
        startedAt: result.startedAt,
        appGeneration: this.deps.appGeneration,
        state: result.groupExited ? 'exited' : 'unknown',
      });
      if (result.cancelled) return { status: 'cancelled' };
      if (result.spawnError) {
        return { status: 'failed', reason: 'check-spawn-failed', detail: result.spawnError };
      }
      if (!result.groupExited) {
        return { status: 'needs_input', reason: 'check-stop-unconfirmed', detail: 'Processes started by the check could not be confirmed stopped.' };
      }
      const versionOut = await captureTree(run.cwd);
      if (versionOut !== versionIn) await retainTree(run.cwd, versionOut, run.id, `${instance.key}-out`);
      const passed =
        result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.leftoversTerminated && versionOut === versionIn;
      const reasons = [
        result.timedOut ? 'timed out' : null,
        result.leftoversTerminated ? 'left processes running' : null,
        versionOut !== versionIn ? 'modified the workspace' : null,
      ].filter(Boolean);
      const summary = `${passed ? 'Passed' : 'Failed'} (exit ${result.exitCode ?? result.signal ?? 'unknown'})${reasons.length ? `; ${reasons.join(', ')}` : ''}\n${result.tail.slice(-2000)}`;
      return {
        status: 'succeeded',
        executionId: `${resourceId}#${++this.turnCounter}`,
        passed,
        exitCode: result.exitCode,
        versionIn,
        versionOut,
        summary,
        logRef: result.logPath,
      };
    } catch (error) {
      return this.snapshotFailure(error);
    } finally {
      releaseLease?.();
    }
  }

  // ---- ask --------------------------------------------------------------------

  ask(instance: AskInstance): Promise<AskOutcome> {
    return new Promise((resolve) => {
      this.pendingAsk = { key: instance.key, resolve };
      this.deps.onEvent({ type: 'ask', key: instance.key, question: instance.question, ...(instance.options ? { options: instance.options } : {}) });
    });
  }

  answer(text: string): boolean {
    if (!this.pendingAsk) return false;
    const pending = this.pendingAsk;
    this.pendingAsk = null;
    pending.resolve({ status: 'succeeded', answer: text });
    return true;
  }

  cancelAsk() {
    const pending = this.pendingAsk;
    this.pendingAsk = null;
    pending?.resolve({ status: 'cancelled' });
  }

  hasPendingAsk() {
    return this.pendingAsk !== null;
  }

  // ---- version gates, copies, leases ------------------------------------------

  /**
   * G0: before a write or check, the working tree must be the version the
   * workflow expects, or one the user explicitly adopted in its place.
   */
  private async gateZero(expected: string): Promise<{ version: string } | { needsInput: AgentOutcome & CheckOutcome }> {
    const run = this.deps.getRun();
    const current = await captureTree(run.cwd);
    if (current === expected) return { version: current };
    if (run.options.adoptions[expected] === current) return { version: current };
    return {
      needsInput: {
        status: 'needs_input',
        reason: 'workspace-drift',
        detail: JSON.stringify({ expected, current }),
      },
    };
  }

  /** G1: after a write, capture until the tree is stable. */
  private async settledVersion(): Promise<{ version: string } | { needsInput: AgentOutcome }> {
    const run = this.deps.getRun();
    let previous = await captureTree(run.cwd);
    for (let attempt = 0; attempt < GATE_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, GATE_SETTLE_MS));
      const next = await captureTree(run.cwd);
      if (next === previous) return { version: next };
      previous = next;
    }
    return {
      needsInput: {
        status: 'needs_input',
        reason: 'workspace-unstable',
        detail: 'Files kept changing after the implementer finished; something may still be running.',
      },
    };
  }

  private async acquireLease(owner: string): Promise<{ release: () => void } | { needsInput: AgentOutcome & CheckOutcome }> {
    const { root } = await repoInfo(this.deps.getRun().cwd);
    const holder = leases.get(root);
    if (holder && holder !== owner) {
      return { needsInput: { status: 'needs_input', reason: 'workspace-busy', detail: `Another workflow step (${holder}) is writing here.` } };
    }
    leases.set(root, owner);
    return {
      release: () => {
        if (leases.get(root) === owner) leases.delete(root);
      },
    };
  }

  private async reviewCopy(instance: AgentInstance): Promise<{ dir: string; root: string; fingerprint: string }> {
    const run = this.deps.getRun();
    const root = path.join(this.deps.artifactsDir, 'copies', safeName(instance.key));
    const dir = await exportTree(run.cwd, instance.version, root);
    return { dir, root, fingerprint: await fingerprintDirectory(root) };
  }

  private readonly diffCache = new Map<string, { path: string; files: string[] }>();

  private async diffFile(from: string, to: string): Promise<{ path: string; files: string[] }> {
    const key = `${from}..${to}`;
    const cached = this.diffCache.get(key);
    if (cached) return cached;
    const out = path.join(this.deps.artifactsDir, 'diffs', `${shortId(from)}-${shortId(to)}.diff`);
    const { files } = await writeTreeDiff(this.deps.getRun().cwd, from, to, out);
    const result = { path: out, files };
    this.diffCache.set(key, result);
    return result;
  }

  private snapshotFailure(error: unknown): AgentOutcome & CheckOutcome {
    if (error instanceof SnapshotError) {
      return { status: 'needs_input', reason: `snapshot-${error.kind}`, detail: error.message };
    }
    return { status: 'failed', reason: 'host-error', detail: error instanceof Error ? error.message : String(error) };
  }
}
