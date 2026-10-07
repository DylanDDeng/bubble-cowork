import assert from 'node:assert/strict';
import { expandSpec, reviewsBeforeWrite } from '../../src/workflow-engine/engine/expand';
import { runWorkflow, type EngineOptions, type EngineResult } from '../../src/workflow-engine/engine/engine';
import { evaluateAcceptance } from '../../src/workflow-engine/engine/acceptance';
import { validateSpec, type MemberConfig } from '../../src/workflow-engine/validate/spec-validator';
import { DEFAULT_LIMITS } from '../../src/workflow-engine/limits';
import type { WorkflowSpec } from '../../src/workflow-engine/spec/workflow-spec';
import { validateImplementationReport, validateReviewResult } from '../../src/workflow-engine/spec/results';
import {
  FakeWorkflowHost,
  MemoryInstanceStore,
  approved,
  changesRequested,
  implementation,
  type AgentScript,
} from '../../src/workflow-engine/testing/fake-host';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const loginSpec = (overrides: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
  schemaVersion: 1,
  name: 'login',
  description: 'login with two reviews',
  members: [
    { key: 'impl', role: 'implementer', agent: 'codex', source: 'user' },
    { key: 'security', role: 'reviewer', agent: 'claude', source: 'user' },
    { key: 'edges', role: 'reviewer', agent: 'codex', source: 'user' },
  ],
  acceptance: [
    { id: 'a1', description: 'tests pass', verify: { kind: 'check', step: 'tests' }, source: 'user' },
    { id: 'a2', description: 'security approves', verify: { kind: 'review', member: 'security' }, source: 'user' },
    { id: 'a3', description: 'edges approves', verify: { kind: 'review', member: 'edges' }, source: 'user' },
  ],
  unsupported: [],
  assumptions: [],
  steps: [
    {
      id: 'build',
      kind: 'reviewLoop',
      implementer: 'impl',
      reviewers: ['security', 'edges'],
      task: [{ text: 'Implement login.' }, { goal: true }],
      checks: [{ id: 'tests', kind: 'check', argv: ['npm', 'test'], timeoutMs: 60_000 }],
      maxRepairRounds: 2,
    },
  ],
  ...overrides,
});

const options = (extra: Partial<EngineOptions> = {}): EngineOptions => ({
  goal: 'Add login',
  baselineVersion: 'v0',
  limits: { maxConcurrent: 3, maxAgentSteps: 16 },
  ...extra,
});

async function run(spec: WorkflowSpec, host: FakeWorkflowHost, store = new MemoryInstanceStore(), extra = {}) {
  const result = await runWorkflow(expandSpec(spec), host, store, options(extra));
  return { result, store };
}

/** Reviewer verdicts keyed by member, per round (1-based call count of that review step). */
const reviewScript =
  (plan: Record<string, Array<Record<string, unknown>>>, implExtra: (n: number) => Record<string, unknown> = () => ({})): AgentScript =>
  (instance, call) => {
    if (instance.outputKind === 'implementation') return { output: implementation(implExtra(call)) };
    const rounds = plan[instance.member.key];
    return { output: rounds[Math.min(call, rounds.length) - 1] };
  };

const reasonOf = (result: EngineResult) => (result.status === 'needs_input' ? result.reason : result.status);

test('reviewLoop: approvals on the first round finish with every acceptance satisfied', async () => {
  const host = new FakeWorkflowHost({ agent: reviewScript({ security: [approved()], edges: [approved()] }) });
  const { result, store } = await run(loginSpec(), host);
  assert.deepEqual(result, { status: 'finished', finalVersion: 'v1' });
  assert.deepEqual(
    host.calls.map((c) => c.key),
    [
      'build.implement',
      'build.rounds[0]/tests',
      // reviews run in parallel; order of the two is not significant
      ...host.calls.slice(2, 4).map((c) => c.key),
    ],
  );
  assert.equal(host.calls.length, 4);
  const acceptance = evaluateAcceptance(loginSpec(), store.all(), 'v1');
  assert.deepEqual(acceptance.map((a) => a.status), ['satisfied', 'satisfied', 'satisfied']);
});

test('reviewLoop: blocking findings drive one fix, the re-review sees the previous round', async () => {
  const host = new FakeWorkflowHost({
    agent: reviewScript({
      security: [changesRequested('F1'), approved({ previousFindings: [{ findingId: 'F1', status: 'resolved' }] })],
      edges: [approved(), approved()],
    }),
  });
  const { result, store } = await run(loginSpec(), host);
  assert.equal(result.status, 'finished');
  const fix = host.calls.find((c) => c.key === 'build.rounds[0]/build.fix');
  assert.ok(fix, 'fix ran in round 0');
  const fixBlocks = (fix.instance as { blocks: Array<{ kind: string; stepId?: string }> }).blocks;
  assert.ok(fixBlocks.some((b) => b.kind === 'from' && b.stepId === 'build.review.security'));
  const reReview = host.calls.find((c) => c.key === 'build.rounds[1]/build.review.security')!.instance as {
    previousBlockingFindingIds: string[];
    diffFrom?: string;
    version: string;
  };
  assert.deepEqual(reReview.previousBlockingFindingIds, ['F1']);
  assert.equal(reReview.diffFrom, 'v1');
  assert.equal(reReview.version, 'v2');
  assert.equal(host.calls.some((c) => c.key === 'build.rounds[1]/build.fix'), false);
  const acceptance = evaluateAcceptance(loginSpec(), store.all(), 'v2');
  assert.deepEqual(acceptance.map((a) => a.status), ['satisfied', 'satisfied', 'satisfied']);
  // Approvals of the earlier version do not count for the final one.
  assert.equal(evaluateAcceptance(loginSpec(), store.all(), 'v1')[1].status, 'unsatisfied');
});

test('reviewLoop starting with a review: reviews the existing change, fixes, re-reviews', async () => {
  const spec = loginSpec();
  const loop = spec.steps[0] as Extract<WorkflowSpec['steps'][number], { kind: 'reviewLoop' }>;
  spec.steps = [{ ...loop, start: 'review', checks: [] }];
  spec.acceptance = spec.acceptance.filter((a) => a.verify.kind === 'review');
  const host = new FakeWorkflowHost({
    agent: reviewScript({
      security: [changesRequested('F1'), approved({ previousFindings: [{ findingId: 'F1', status: 'resolved' }] })],
      edges: [approved(), approved()],
    }),
  });
  const { result, store } = await run(spec, host);
  assert.equal(result.status, 'finished');
  assert.equal(host.calls.some((c) => c.key === 'build.implement'), false, 'no initial implement step');
  const firstReview = host.calls.find((c) => c.key === 'build.rounds[0]/build.review.security')!.instance as { version: string };
  assert.equal(firstReview.version, 'v0', 'the first review sees the baseline');
  assert.ok(host.calls.some((c) => c.key === 'build.rounds[0]/build.fix'));
  const final = result.status === 'finished' ? result.finalVersion : null;
  assert.deepEqual(evaluateAcceptance(spec, store.all(), final!).map((a) => a.status), ['satisfied', 'satisfied']);
  assert.deepEqual(validateSpec(spec, { memberConfigs: configs, limits: DEFAULT_LIMITS }).errors, []);
  assert.equal(reviewsBeforeWrite(spec), true, 'reviews the change that predates the run');
  assert.equal(reviewsBeforeWrite(loginSpec()), false, 'implements before the first review');
});

test('reviewLoop with no repair rounds reports findings and finishes instead of asking for more rounds', async () => {
  const spec = loginSpec();
  const loop = spec.steps[0] as Extract<WorkflowSpec['steps'][number], { kind: 'reviewLoop' }>;
  spec.steps = [{ ...loop, start: 'review', checks: [], maxRepairRounds: 0 }];
  spec.acceptance = spec.acceptance.filter((a) => a.verify.kind === 'review');
  const host = new FakeWorkflowHost({ agent: reviewScript({ security: [changesRequested('F1')], edges: [approved()] }) });
  const { result, store } = await run(spec, host);
  assert.deepEqual(result, { status: 'finished', finalVersion: 'v0' });
  assert.equal(host.calls.some((c) => c.instance.outputKind === 'implementation'), false, 'nothing is fixed');
  assert.deepEqual(evaluateAcceptance(spec, store.all(), 'v0').map((a) => a.status), ['unsatisfied', 'satisfied']);
});

test('reviewLoop: failed checks skip reviews and go straight to a fix', async () => {
  const host = new FakeWorkflowHost({
    agent: reviewScript({ security: [approved()], edges: [approved()] }),
    check: (_i, call) => ({ passed: call > 1 }),
  });
  const { result } = await run(loginSpec(), host);
  assert.equal(result.status, 'finished');
  const keys = host.calls.map((c) => c.key);
  assert.ok(!keys.includes('build.rounds[0]/build.review.security'));
  assert.ok(keys.includes('build.rounds[0]/build.fix'));
  assert.ok(keys.includes('build.rounds[1]/build.review.security'));
});

test('reviewLoop: the last round never fixes, so an unfinished loop asks the user', async () => {
  let n = 0;
  const host = new FakeWorkflowHost({
    agent: (instance) => {
      if (instance.outputKind === 'implementation') return { output: implementation() };
      if (instance.member.key === 'edges') return { output: approved() };
      n += 1;
      const previous = instance.previousBlockingFindingIds.map((findingId) => ({ findingId, status: 'resolved' }));
      return { output: changesRequested(`F${n}`, { previousFindings: previous }) };
    },
  });
  const { result } = await run(loginSpec(), host);
  assert.equal(reasonOf(result), 'repeat-exhausted');
  const fixes = host.calls.filter((c) => c.key.endsWith('build.fix')).map((c) => c.key);
  assert.deepEqual(fixes, ['build.rounds[0]/build.fix', 'build.rounds[1]/build.fix']);
});

test('reviewLoop: the same finding unresolved in two re-reviews stops the loop', async () => {
  const host = new FakeWorkflowHost({
    agent: reviewScript({
      security: [
        changesRequested('F1'),
        changesRequested('F1', { previousFindings: [{ findingId: 'F1', status: 'unresolved' }] }),
        changesRequested('F1', { previousFindings: [{ findingId: 'F1', status: 'unresolved' }] }),
      ],
      edges: [approved()],
    }),
  });
  const { result } = await run(loginSpec({ steps: [{ ...(loginSpec().steps[0] as any), maxRepairRounds: 3 }] }), host);
  assert.equal(reasonOf(result), 'unresolved-twice');
});

test('reviewLoop: a disputed finding the reviewer maintains goes to the user', async () => {
  const host = new FakeWorkflowHost({
    agent: reviewScript(
      {
        security: [
          changesRequested('F1'),
          changesRequested('F1', { previousFindings: [{ findingId: 'F1', status: 'unresolved' }] }),
        ],
        edges: [approved()],
      },
      (n) => (n === 2 ? { findingResponses: [{ findingId: 'F1', action: 'disputed', note: 'intended' }] } : {}),
    ),
  });
  const { result } = await run(loginSpec(), host);
  assert.equal(reasonOf(result), 'dispute-maintained');
});

test('reviewLoop: a fix that changes nothing stops for no progress', async () => {
  const host = new FakeWorkflowHost({
    agent: (instance, call) => {
      if (instance.outputKind === 'implementation') return { output: implementation(), changed: instance.stepId !== 'build.fix' };
      return { output: instance.member.key === 'security' ? changesRequested(`F${call}`) : approved() };
    },
  });
  const { result } = await run(loginSpec(), host);
  assert.equal(reasonOf(result), 'no-progress');
});

test('reviewLoop: a blocked review goes to the user without a fix', async () => {
  const host = new FakeWorkflowHost({
    agent: reviewScript({
      security: [{ schemaVersion: 1, verdict: 'blocked', summary: 'cannot review', findings: [], blockers: ['no access'] }],
      edges: [approved()],
    }),
  });
  const { result } = await run(loginSpec(), host);
  assert.equal(reasonOf(result), 'review-blocked');
  assert.equal(host.calls.some((c) => c.key.endsWith('build.fix')), false);
});

test('resume reuses settled instances and only runs what is left', async () => {
  let failSecurityOnce = true;
  const script: AgentScript = (instance, call) => {
    if (instance.outputKind === 'implementation') return { output: implementation() };
    if (instance.member.key === 'security' && failSecurityOnce) {
      failSecurityOnce = false;
      return { fail: 'needs_input', reason: 'permission' };
    }
    return { output: approved() };
  };
  const host = new FakeWorkflowHost({ agent: script });
  const store = new MemoryInstanceStore();
  const first = await run(loginSpec(), host, store);
  assert.equal(reasonOf(first.result), 'leaf');
  const callsBefore = host.calls.length;
  const second = await run(loginSpec(), host, store);
  assert.equal(second.result.status, 'finished');
  const newKeys = host.calls.slice(callsBefore).map((c) => c.key);
  assert.deepEqual(newKeys, ['build.rounds[0]/build.review.security']);
});

test('an interrupted write never re-runs without the user choosing to', async () => {
  const host = new FakeWorkflowHost({ agent: reviewScript({ security: [approved()], edges: [approved()] }) });
  const store = new MemoryInstanceStore();
  await run(loginSpec(), host, store);
  store.markDispatched('build.implement');
  const blocked = await run(loginSpec(), host, store);
  assert.deepEqual(
    blocked.result.status === 'needs_input' && [blocked.result.reason, blocked.result.instanceKey],
    ['interrupted-instance', 'build.implement'],
  );
  const rerun = await run(loginSpec(), host, store, { rerunInstances: ['build.implement'] });
  assert.equal(rerun.result.status, 'finished');
});

test('changed inputs invalidate reuse: a different goal re-runs the steps', async () => {
  const host = new FakeWorkflowHost({ agent: reviewScript({ security: [approved()], edges: [approved()] }) });
  const store = new MemoryInstanceStore();
  await run(loginSpec(), host, store);
  const before = host.calls.length;
  await run(loginSpec(), host, store, { goal: 'Add login with SSO' });
  assert.ok(host.calls.slice(before).some((c) => c.key === 'build.implement'));
});

test('the agent-step budget stops the run', async () => {
  const host = new FakeWorkflowHost({ agent: reviewScript({ security: [approved()], edges: [approved()] }) });
  const { result } = await run(loginSpec(), host, new MemoryInstanceStore(), {
    limits: { maxConcurrent: 3, maxAgentSteps: 2 },
  });
  assert.equal(reasonOf(result), 'budget');
});

test('concurrency limit of one still completes parallel reviews', async () => {
  const host = new FakeWorkflowHost({ agent: reviewScript({ security: [approved()], edges: [approved()] }) });
  const { result } = await run(loginSpec(), host, new MemoryInstanceStore(), {
    limits: { maxConcurrent: 1, maxAgentSteps: 16 },
  });
  assert.equal(result.status, 'finished');
});

/** investigate → proposals → judge → implement chosen → relay a question. */
const generalSpec = (): WorkflowSpec => ({
  schemaVersion: 1,
  name: 'general',
  description: 'mixed patterns',
  members: [
    { key: 'impl', role: 'implementer', agent: 'codex', source: 'user' },
    { key: 'a', role: 'advisor', agent: 'claude', source: 'user' },
    { key: 'b', role: 'advisor', agent: 'kimi', source: 'user' },
  ],
  acceptance: [],
  unsupported: [],
  assumptions: [],
  steps: [
    { id: 'investigate', kind: 'agent', member: 'a', task: [{ goal: true }], output: 'notes' },
    {
      id: 'proposals',
      kind: 'parallel',
      steps: [
        { id: 'pa', kind: 'agent', member: 'a', task: [{ from: { step: 'investigate' } }], output: 'notes' },
        { id: 'pb', kind: 'agent', member: 'b', task: [{ from: { step: 'investigate' } }], output: 'notes' },
      ],
    },
    {
      id: 'judge',
      kind: 'agent',
      member: 'b',
      task: [{ from: { step: 'pa' } }, { from: { step: 'pb' } }],
      output: { route: [{ name: 'winner', kind: 'enum', values: ['a', 'b'] }] },
    },
    {
      id: 'build-a',
      kind: 'agent',
      member: 'impl',
      if: { equals: { ref: { step: 'judge', field: 'winner' }, value: 'a' } },
      task: [{ from: { step: 'pa' } }],
      output: 'implementation',
    },
    {
      id: 'build-b',
      kind: 'agent',
      member: 'impl',
      if: { equals: { ref: { step: 'judge', field: 'winner' }, value: 'b' } },
      task: [{ from: { step: 'pb' } }],
      output: 'implementation',
    },
    { id: 'answer', kind: 'agent', member: 'a', if: { hasQuestions: 'build-b' }, task: [{ from: { step: 'build-b', field: 'questions' } }], output: 'notes' },
    { id: 'confirm', kind: 'ask', question: 'Ship it?', options: ['yes', 'no'] },
  ],
});

test('general flow: refs, route branching, relayed question and ask', async () => {
  const notes = (summary: string) => ({ schemaVersion: 1, summary, details: summary });
  const host = new FakeWorkflowHost({
    agent: (instance) => {
      if (instance.stepId === 'judge') return { output: { winner: 'b' } };
      if (instance.outputKind === 'implementation') {
        return { output: implementation({ questions: [{ to: 'a', question: 'Which cache?' }] }) };
      }
      return { output: notes(instance.stepId) };
    },
  });
  const { result, store } = await run(generalSpec(), host);
  assert.equal(result.status, 'finished');
  const keys = host.calls.map((c) => c.key);
  assert.ok(keys.includes('build-b') && !keys.includes('build-a'));
  assert.ok(keys.includes('answer') && keys.includes('confirm'));
  const judge = host.calls.find((c) => c.key === 'judge')!.instance as { blocks: Array<{ stepId?: string }> };
  assert.deepEqual(judge.blocks.map((b) => b.stepId), ['pa', 'pb']);
  assert.equal(store.get('confirm')?.answer, 'yes');
});

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

const configs: MemberConfig[] = [
  { name: 'claude', provider: 'claude', roles: ['implementer', 'reviewer', 'advisor'], models: ['claude-opus-5-5'], degraded: [] },
  { name: 'codex', provider: 'codex', roles: ['implementer', 'reviewer', 'advisor'], models: ['gpt-5.5'], degraded: [] },
  { name: 'kimi', provider: 'kimi', roles: ['implementer', 'reviewer', 'advisor'], models: [], degraded: ['structuredOutput'] },
  { name: 'pi', provider: 'pi', roles: ['implementer'], models: [], degraded: [] },
];
const validate = (spec: WorkflowSpec, extra = {}) =>
  validateSpec(spec, { memberConfigs: configs, limits: DEFAULT_LIMITS, ...extra });
const messages = (report: ReturnType<typeof validate>) => report.errors.map((e) => `${e.path}: ${e.message}`).join('\n');

test('validator accepts the login spec and the general spec', () => {
  assert.equal(messages(validate(loginSpec())), '');
  assert.equal(messages(validate(generalSpec())), '');
  assert.deepEqual(validate(loginSpec()).confirmReasons, []);
});

test('validator enforces member configurations and roles', () => {
  const spec = loginSpec();
  spec.members[1] = { key: 'security', role: 'reviewer', agent: 'pi', source: 'user' };
  spec.members.push({ key: 'x', role: 'implementer', agent: 'unknown', source: 'inferred' });
  const text = messages(validate(spec));
  assert.match(text, /pi cannot act as reviewer/);
  assert.match(text, /"unknown" is not an available member configuration/);
  assert.match(text, /Only one implementer/);
});

test('validator rejects bad references, parallel writes and unbounded checks', () => {
  const spec = generalSpec();
  (spec.steps[0] as any).task = [{ from: { step: 'judge' } }];
  (spec.steps[1] as any).steps.push({ id: 'w', kind: 'agent', member: 'impl', task: [{ text: 'x' }], output: 'implementation' });
  (spec.steps[1] as any).steps.push({ id: 'c', kind: 'check', argv: ['vitest', '--watch'], timeoutMs: 1000 });
  (spec.steps[2] as any).task = [{ from: { step: 'pa', iteration: 'previous' } }];
  const text = messages(validate(spec));
  assert.match(text, /"judge" does not run before this step/);
  assert.match(text, /at most one writing step or check/);
  assert.match(text, /must terminate on their own/);
  assert.match(text, /"previous" iteration needs/);
});

test('validator rejects writes by reviewers and references between parallel siblings', () => {
  const spec = generalSpec();
  (spec.steps[1] as any).steps[1].task = [{ from: { step: 'pa' } }];
  (spec.steps[0] as any).workspace = 'write';
  const text = messages(validate(spec));
  assert.match(text, /runs in parallel with this step/);
  assert.match(text, /Only the implementer may write/);
});

test('validator bounds agent executions and limits', () => {
  const spec = loginSpec();
  (spec.steps[0] as any).maxRepairRounds = 3;
  (spec.steps[0] as any).reviewers = ['security', 'edges'];
  spec.members.push({ key: 'r3', role: 'reviewer', agent: 'kimi', source: 'user' });
  (spec.steps[0] as any).reviewers.push('r3');
  // 1 implement + 4 rounds × (3 reviews + 1 fix) = 17
  assert.match(messages(validate(spec)), /up to 17 agent steps/);
});

test('validator reports confirmation reasons and check authorization', () => {
  const spec = loginSpec({ assumptions: ['npm test is the test command'] });
  spec.acceptance[0] = { ...spec.acceptance[0], source: 'inferred' };
  (spec.steps[0] as any).checks[0].argv = ['bash', '-c', 'npm test'];
  const report = validate(spec, {
    checkAuthorization: { projectScripts: { packageManagers: ['npm'], scripts: ['test'] }, userText: '', approvedCommands: [] },
  });
  assert.equal(messages(report), '');
  assert.deepEqual(report.checks.map((c) => c.authorization.kind), ['confirm']);
  // Only the command stops the plan; assumptions and inferred acceptance are shown, not asked about.
  assert.deepEqual(report.confirmReasons.map((r) => r.kind), ['check']);
  assert.match(report.confirmReasons[0].message, /highlighted/);
  const extra = loginSpec({ unsupported: ['open a pull request'] });
  extra.members.push({ key: 'extra', role: 'reviewer', agent: 'kimi', source: 'inferred' });
  (extra.steps[0] as any).reviewers.push('extra');
  assert.deepEqual(
    validate(extra, { checkAuthorization: { projectScripts: { packageManagers: ['npm'], scripts: ['test'] }, userText: '', approvedCommands: [] } })
      .confirmReasons.map((r) => r.kind)
      .sort(),
    ['member', 'unsupported'],
    'an unrequested member and an impossible part of the request still stop the plan',
  );
});

test('validator warns when a reviewer may not see the final version', () => {
  const spec: WorkflowSpec = {
    ...generalSpec(),
    members: [
      { key: 'impl', role: 'implementer', agent: 'codex', source: 'user' },
      { key: 'r', role: 'reviewer', agent: 'claude', source: 'user' },
    ],
    acceptance: [{ id: 'a', description: 'r approves', verify: { kind: 'review', member: 'r' }, source: 'user' }],
    steps: [
      { id: 'w1', kind: 'agent', member: 'impl', task: [{ goal: true }], output: 'implementation' },
      { id: 'rev', kind: 'agent', member: 'r', task: [{ goal: true }], output: 'review' },
      { id: 'w2', kind: 'agent', member: 'impl', task: [{ from: { step: 'rev' } }], output: 'implementation' },
    ],
  };
  const report = validate(spec);
  assert.equal(messages(report), '');
  assert.match(report.warnings.map((w) => w.message).join(), /may not review the final version/);
  assert.deepEqual(report.confirmReasons, [], 'warnings are shown but do not stop the plan');
});

// ---------------------------------------------------------------------------
// Result validation
// ---------------------------------------------------------------------------

test('result validation enforces verdict consistency and re-review coverage', () => {
  assert.deepEqual(validateReviewResult(approved()), []);
  assert.match(
    validateReviewResult({ ...approved(), blockers: ['x'] }).join(),
    /approved review must not contain blocking findings or blockers/,
  );
  assert.match(
    validateReviewResult({ ...changesRequested('F1'), findings: [] }).join(),
    /changes_requested requires at least one blocking finding/,
  );
  assert.match(validateReviewResult(approved(), ['F1']).join(), /missing: F1/);
  assert.deepEqual(validateReviewResult(approved({ previousFindings: [{ findingId: 'F1', status: 'resolved' }] }), ['F1']), []);
  assert.deepEqual(validateImplementationReport(implementation()), []);
  assert.match(validateImplementationReport(implementation({ blockers: ['x'] })).join(), /completed report must not list blockers/);
});

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nworkflow-engine run: all tests passed');
})();
