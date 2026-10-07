// In-memory store and a scriptable host for exercising workflow semantics
// without Electron or real agents.

import type {
  AgentInstance,
  AgentOutcome,
  AskInstance,
  AskOutcome,
  CheckInstance,
  CheckOutcome,
  InstanceRecord,
  InstanceStore,
  Version,
  WorkflowEvent,
  WorkflowHost,
} from '../engine/engine';

export class MemoryInstanceStore implements InstanceStore {
  private readonly records = new Map<string, InstanceRecord>();

  constructor(initial: InstanceRecord[] = []) {
    for (const record of initial) this.records.set(record.key, record);
  }

  get(key: string) {
    return this.records.get(key);
  }

  all() {
    return [...this.records.values()];
  }

  async put(record: InstanceRecord) {
    this.records.set(record.key, record);
  }

  /** Drop settled results for keys (simulates a crash mid-execution). */
  markDispatched(key: string) {
    const record = this.records.get(key);
    if (record) this.records.set(key, { ...record, state: 'dispatched' });
  }
}

export type AgentScript = (
  instance: AgentInstance,
  call: number,
) => { output: unknown; changed?: boolean } | { fail: 'needs_input' | 'failed'; reason: string };

export type CheckScript = (instance: CheckInstance, call: number) => { passed: boolean; modifies?: boolean };

/**
 * Workspace versions are `v0`, `v1`, … ; a write that changes the workspace
 * or a check that modifies files advances the version.
 */
export class FakeWorkflowHost implements WorkflowHost {
  version = 0;
  readonly calls: Array<{ kind: 'agent' | 'check' | 'ask'; key: string; instance: unknown }> = [];
  readonly events: WorkflowEvent[] = [];
  private executions = 0;
  private readonly agentCalls = new Map<string, number>();
  private readonly checkCalls = new Map<string, number>();

  constructor(
    private readonly scripts: {
      agent: AgentScript;
      check?: CheckScript;
      answer?: (instance: AskInstance) => string;
    },
  ) {}

  get currentVersion(): Version {
    return `v${this.version}`;
  }

  async runAgent(instance: AgentInstance): Promise<AgentOutcome> {
    this.calls.push({ kind: 'agent', key: instance.key, instance });
    const n = (this.agentCalls.get(instance.stepId) ?? 0) + 1;
    this.agentCalls.set(instance.stepId, n);
    const result = this.scripts.agent(instance, n);
    if ('fail' in result) return { status: result.fail, reason: result.reason };
    const versionIn = instance.workspace === 'write' ? this.currentVersion : instance.version;
    if (instance.workspace === 'write') {
      const changed = result.changed ?? true;
      if (changed) this.version += 1;
      return {
        status: 'succeeded',
        executionId: `exec-${++this.executions}`,
        output: result.output,
        versionIn,
        versionOut: this.currentVersion,
        changed,
      };
    }
    return { status: 'succeeded', executionId: `exec-${++this.executions}`, output: result.output, versionIn };
  }

  async runCheck(instance: CheckInstance): Promise<CheckOutcome> {
    this.calls.push({ kind: 'check', key: instance.key, instance });
    const n = (this.checkCalls.get(instance.stepId) ?? 0) + 1;
    this.checkCalls.set(instance.stepId, n);
    const result = this.scripts.check?.(instance, n) ?? { passed: true };
    const versionIn = this.currentVersion;
    if (result.modifies) this.version += 1;
    return {
      status: 'succeeded',
      executionId: `exec-${++this.executions}`,
      passed: result.passed,
      exitCode: result.passed ? 0 : 1,
      versionIn,
      versionOut: this.currentVersion,
      summary: result.passed ? 'passed' : 'failed',
    };
  }

  async ask(instance: AskInstance): Promise<AskOutcome> {
    this.calls.push({ kind: 'ask', key: instance.key, instance });
    return { status: 'succeeded', answer: this.scripts.answer?.(instance) ?? 'yes' };
  }

  emit(event: WorkflowEvent) {
    this.events.push(event);
  }
}

// Helpers for building results in tests.
export const implementation = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  status: 'completed',
  summary: 'done',
  changes: [{ file: 'src/a.ts', description: 'edit' }],
  blockers: [],
  ...extra,
});

export const approved = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  verdict: 'approved',
  summary: 'ok',
  findings: [],
  blockers: [],
  ...extra,
});

export const changesRequested = (findingId: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  verdict: 'changes_requested',
  summary: 'needs work',
  findings: [{ id: 'f1', findingId, severity: 'blocking', category: 'security', reason: 'problem' }],
  blockers: [],
  ...extra,
});
