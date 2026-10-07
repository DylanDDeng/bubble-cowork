import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {
  buildPlannedWorkflowSchema,
  type PlannedStep,
  type PlannedWorkflow,
} from '../../src/workflow-engine/spec/planned-workflow';
import { convertPlannedWorkflow } from '../../src/workflow-engine/convert/from-planned';
import {
  appearsLiterallyInUserText,
  authorizeCheckCommand,
  highlightReasons,
  isAuthorizedAtRuntime,
  matchProjectScript,
  unboundedReasons,
  type CheckAuthorizationContext,
} from '../../src/workflow-engine/authorize/check-authorization';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

// ---------------------------------------------------------------------------
// Planner schema: must fit Claude structured outputs and Codex strict mode.
// ---------------------------------------------------------------------------

const schema = buildPlannedWorkflowSchema({
  agentNames: ['claude', 'codex'],
  modelIds: ['claude-opus-5-5', 'gpt-5.5'],
});

// Keywords both providers accept; anything else (numeric/string/array
// constraints, $ref recursion, oneOf, patternProperties…) is rejected.
const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
]);

function walkSchema(node: unknown, path: string, visit: (node: Record<string, unknown>, path: string) => void) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  visit(obj, path);
  if (obj.properties && typeof obj.properties === 'object') {
    for (const [key, child] of Object.entries(obj.properties as Record<string, unknown>)) {
      walkSchema(child, `${path}.${key}`, visit);
    }
  }
  if (obj.items) walkSchema(obj.items, `${path}[]`, visit);
  if (Array.isArray(obj.anyOf)) obj.anyOf.forEach((child, i) => walkSchema(child, `${path}|${i}`, visit));
}

test('planner schema uses only keywords supported by both structured-output modes', () => {
  walkSchema(schema, '$', (node, path) => {
    for (const key of Object.keys(node)) {
      assert.ok(ALLOWED_KEYWORDS.has(key), `${path} uses unsupported keyword "${key}"`);
    }
  });
});

test('every planner schema object is closed and requires all of its properties', () => {
  walkSchema(schema, '$', (node, path) => {
    if (node.type !== 'object') return;
    assert.equal(node.additionalProperties, false, `${path} must set additionalProperties: false`);
    const keys = Object.keys((node.properties ?? {}) as object).sort();
    const required = [...((node.required ?? []) as string[])].sort();
    assert.deepEqual(required, keys, `${path} must list every property as required`);
  });
});

test('planner schema root is a plain object and anyOf never appears at the root', () => {
  assert.equal(schema.type, 'object');
  assert.equal('anyOf' in schema, false);
});

test('planner schema nesting stays within strict-mode depth limits', () => {
  let maxDepth = 0;
  walkSchema(schema, '$', (_node, path) => {
    const depth = path.split(/[.[]/).length - 1;
    maxDepth = Math.max(maxDepth, depth);
  });
  assert.ok(maxDepth <= 10, `schema nests ${maxDepth} levels`);
});

test('planner schema offers only the Host member configurations as agents', () => {
  const agent = (((schema.properties as any).members.items.properties.agent) as { enum: string[] });
  assert.deepEqual(agent.enum, ['claude', 'codex']);
  assert.throws(() => buildPlannedWorkflowSchema({ agentNames: [], modelIds: [] }));
});

// ---------------------------------------------------------------------------
// Exchange format → tree conversion
// ---------------------------------------------------------------------------

const blankStep = (overrides: Partial<PlannedStep> & Pick<PlannedStep, 'id' | 'kind'>): PlannedStep => ({
  parent: null,
  order: 0,
  phase: null,
  condition: null,
  member: null,
  task: null,
  workspace: null,
  output: null,
  route: null,
  session: null,
  argv: null,
  timeoutMs: null,
  max: null,
  question: null,
  options: null,
  reason: null,
  implementer: null,
  reviewers: null,
  start: null,
  ...overrides,
});

/** The plan's §4.1 example, in exchange format. */
const loginPlan = (): PlannedWorkflow => ({
  schemaVersion: 1,
  name: 'login',
  description: 'Implement login; security and edge-case reviews; up to 2 repair rounds',
  members: [
    { key: 'impl', role: 'implementer', agent: 'codex', model: null, focus: null, source: 'user' },
    { key: 'security', role: 'reviewer', agent: 'claude', model: null, focus: 'security', source: 'user' },
    { key: 'edges', role: 'reviewer', agent: 'codex', model: null, focus: 'edge cases', source: 'user' },
  ],
  acceptance: [
    { id: 'a1', description: 'Tests pass', verifyKind: 'check', verifyRef: 'tests', source: 'inferred' },
    { id: 'a2', description: 'Security review approves', verifyKind: 'review', verifyRef: 'security', source: 'user' },
    { id: 'a3', description: 'Edge-case review approves', verifyKind: 'review', verifyRef: 'edges', source: 'user' },
  ],
  unsupported: [],
  assumptions: ['npm test is the test command'],
  steps: [
    blankStep({
      id: 'build',
      kind: 'reviewLoop',
      implementer: 'impl',
      reviewers: ['security', 'edges'],
      task: [
        { kind: 'text', text: 'Implement the login feature.', ref: null },
        { kind: 'goal', text: null, ref: null },
      ],
      max: 2,
    }),
    blankStep({ id: 'tests', kind: 'check', parent: 'build', argv: ['npm', 'test'], timeoutMs: 600000 }),
  ],
});

test('the plan example validates against the planner schema', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  assert.ok(validate(loginPlan()), JSON.stringify(validate.errors));
});

test('converts the plan example into a reviewLoop tree with its nested check', () => {
  const result = convertPlannedWorkflow(loginPlan());
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.errors));
  const [loop] = result.spec.steps;
  assert.equal(loop.kind, 'reviewLoop');
  if (loop.kind !== 'reviewLoop') return;
  assert.deepEqual(loop.reviewers, ['security', 'edges']);
  assert.equal(loop.maxRepairRounds, 2);
  assert.deepEqual(loop.task, [{ text: 'Implement the login feature.' }, { goal: true }]);
  assert.deepEqual(loop.checks.map((c) => [c.id, c.argv]), [['tests', ['npm', 'test']]]);
  assert.deepEqual(result.spec.acceptance[0].verify, { kind: 'check', step: 'tests' });
  assert.equal(result.spec.members[0].model, undefined);
  assert.equal(result.spec.members[1].focus, 'security');
});

/** Investigate → implement, with a proposals-and-judge branch and a repeat. */
const nestedPlan = (): PlannedWorkflow => ({
  ...loginPlan(),
  acceptance: [],
  assumptions: [],
  steps: [
    blankStep({
      id: 'investigate', kind: 'agent', order: 0, member: 'security', output: 'notes',
      task: [{ kind: 'goal', text: null, ref: null }],
    }),
    blankStep({ id: 'choose', kind: 'parallel', order: 1 }),
    blankStep({
      id: 'judge', kind: 'agent', parent: 'choose', order: 0, member: 'edges', output: 'route',
      route: [{ name: 'winner', kind: 'enum', values: ['a', 'b'] }],
      task: [{ kind: 'from', text: null, ref: { step: 'investigate', field: null, iteration: null } }],
    }),
    blankStep({
      id: 'cycle', kind: 'repeat', order: 2, max: 3,
      condition: [
        { id: 'root', parent: null, op: 'all', steps: null, ref: null, value: null },
        { id: 'ok', parent: 'root', op: 'checkPassed', steps: ['t'], ref: null, value: null },
        { id: 'neg', parent: 'root', op: 'not', steps: null, ref: null, value: null },
        { id: 'blk', parent: 'neg', op: 'hasBlocking', steps: ['judge'], ref: null, value: null },
      ],
    }),
    blankStep({ id: 't', kind: 'check', parent: 'cycle', order: 1, argv: ['npm', 'test'], timeoutMs: 1000 }),
    blankStep({
      id: 'impl1', kind: 'agent', parent: 'cycle', order: 0, member: 'impl', output: 'implementation',
      workspace: 'write', session: 'continue',
      condition: [
        {
          id: 'pick', parent: null, op: 'equals', steps: null,
          ref: { step: 'judge', field: 'winner', iteration: null }, value: 'a',
        },
      ],
      task: [{ kind: 'text', text: 'Implement the chosen design.', ref: null }],
    }),
  ],
});

test('rebuilds nesting from parent links, sorted by order, with flattened conditions', () => {
  const result = convertPlannedWorkflow(nestedPlan());
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.errors));
  assert.deepEqual(result.spec.steps.map((s) => s.id), ['investigate', 'choose', 'cycle']);
  const cycle = result.spec.steps[2];
  assert.equal(cycle.kind, 'repeat');
  if (cycle.kind !== 'repeat') return;
  assert.deepEqual(cycle.steps.map((s) => s.id), ['impl1', 't']);
  assert.deepEqual(cycle.until, { all: [{ checkPassed: ['t'] }, { not: { hasBlocking: ['judge'] } }] });
  const impl = cycle.steps[0];
  assert.equal(impl.kind, 'agent');
  if (impl.kind !== 'agent') return;
  assert.deepEqual(impl.if, { equals: { ref: { step: 'judge', field: 'winner' }, value: 'a' } });
  const choose = result.spec.steps[1];
  assert.ok(choose.kind === 'parallel' && choose.steps[0].kind === 'agent');
  assert.deepEqual(
    choose.kind === 'parallel' && choose.steps[0].kind === 'agent' ? choose.steps[0].output : null,
    { route: [{ name: 'winner', kind: 'enum', values: ['a', 'b'] }] },
  );
});

function expectErrors(plan: PlannedWorkflow, ...fragments: string[]) {
  const result = convertPlannedWorkflow(plan);
  assert.equal(result.ok, false, 'conversion should fail');
  if (result.ok) return;
  const text = result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
  for (const fragment of fragments) assert.ok(text.includes(fragment), `missing "${fragment}" in:\n${text}`);
}

test('rejects unknown, non-container and cyclic parents', () => {
  const plan = loginPlan();
  plan.steps[1].parent = 'missing';
  expectErrors(plan, 'Parent "missing" does not exist');

  const nested = nestedPlan();
  nested.steps.find((s) => s.id === 't')!.parent = 'investigate';
  expectErrors(nested, 'is a agent step and cannot contain steps');

  const cyclic = nestedPlan();
  cyclic.steps.find((s) => s.id === 'choose')!.parent = 'cycle';
  cyclic.steps.find((s) => s.id === 'cycle')!.parent = 'choose';
  expectErrors(cyclic, 'part of a parent cycle');
});

test('rejects duplicate ids and duplicate order under one parent', () => {
  const plan = nestedPlan();
  plan.steps.push(blankStep({ id: 'investigate', kind: 'stop', order: 9, reason: 'x' }));
  expectErrors(plan, 'Duplicate step id "investigate"');

  const ordered = nestedPlan();
  ordered.steps.find((s) => s.id === 't')!.order = 0;
  expectErrors(ordered, 'Order 0 is used twice under "cycle"');
});

test('ignores fields a step kind does not use, with a warning', () => {
  // Observed from Claude in the planner probe: a reviewLoop came back with
  // workspace/output/session filled in.
  const plan = loginPlan();
  Object.assign(plan.steps[0], { workspace: 'write', output: 'implementation', session: 'continue' });
  plan.steps[1].member = 'impl';
  const result = convertPlannedWorkflow(plan);
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.errors));
  assert.deepEqual(
    result.warnings.map((w) => w.path),
    ['steps[0].workspace', 'steps[0].output', 'steps[0].session', 'steps[1].member'],
  );
  const [loop] = result.spec.steps;
  assert.ok(loop.kind === 'reviewLoop' && !('workspace' in loop) && !('output' in loop));
});

test('rejects missing required fields', () => {
  const plan = loginPlan();
  plan.steps[1].timeoutMs = null;
  expectErrors(plan, 'A check step must declare timeoutMs');

  const nested = nestedPlan();
  nested.steps.find((s) => s.id === 'cycle')!.condition = null;
  expectErrors(nested, 'must declare its until condition');
});

test('only check steps may sit inside a reviewLoop', () => {
  const plan = loginPlan();
  plan.steps.push(blankStep({ id: 'extra', kind: 'stop', parent: 'build', order: 1, reason: 'x' }));
  expectErrors(plan, 'Only check steps may be placed inside a reviewLoop');
});

test('enforces the nesting depth limit', () => {
  const plan = nestedPlan();
  plan.steps.push(
    blankStep({ id: 'p2', kind: 'parallel', parent: 'choose', order: 1 }),
    blankStep({ id: 'p3', kind: 'parallel', parent: 'p2', order: 0 }),
    blankStep({ id: 'p4', kind: 'parallel', parent: 'p3', order: 0 }),
    blankStep({ id: 'leaf', kind: 'stop', parent: 'p4', order: 0, reason: 'x' }),
  );
  expectErrors(plan, 'Nesting deeper than 3 levels');
});

test('rejects malformed condition trees', () => {
  const twoRoots = nestedPlan();
  twoRoots.steps.find((s) => s.id === 'cycle')!.condition!.push(
    { id: 'r2', parent: null, op: 'lastIteration', steps: null, ref: null, value: null },
  );
  expectErrors(twoRoots, 'exactly one root node; found 2');

  const badNot = nestedPlan();
  badNot.steps.find((s) => s.id === 'cycle')!.condition!.push(
    { id: 'extra', parent: 'neg', op: 'lastIteration', steps: null, ref: null, value: null },
  );
  expectErrors(badNot, 'A not condition must have exactly one child');

  const badEquals = nestedPlan();
  badEquals.steps.find((s) => s.id === 'impl1')!.condition![0].value = null;
  expectErrors(badEquals, 'must have both ref and value');

  const leafWithKids = nestedPlan();
  leafWithKids.steps.find((s) => s.id === 'cycle')!.condition!.push(
    { id: 'kid', parent: 'ok', op: 'lastIteration', steps: null, ref: null, value: null },
  );
  expectErrors(leafWithKids, '(checkPassed) cannot have children');
});

test('rejects malformed task blocks, routes and acceptance references', () => {
  const plan = nestedPlan();
  plan.steps.find((s) => s.id === 'judge')!.task = [{ kind: 'from', text: null, ref: null }];
  plan.steps.find((s) => s.id === 'judge')!.route = [{ name: 'winner', kind: 'enum', values: null }];
  plan.acceptance = [{ id: 'a', description: 'x', verifyKind: 'review', verifyRef: null, source: 'user' }];
  expectErrors(
    plan,
    'A from block must reference a step',
    'An enum route field must list its values',
    'A review acceptance must name the reviewer',
  );
});

// ---------------------------------------------------------------------------
// Check command authorization
// ---------------------------------------------------------------------------

const ctx = (overrides: Partial<CheckAuthorizationContext> = {}): CheckAuthorizationContext => ({
  projectScripts: { packageManagers: ['npm'], scripts: ['test', 'lint', 'typecheck'] },
  userText: '',
  approvedCommands: [],
  ...overrides,
});

test('declared project scripts run without confirmation', () => {
  assert.deepEqual(authorizeCheckCommand(['npm', 'test'], ctx()), { kind: 'auto', basis: 'project-script' });
  assert.deepEqual(authorizeCheckCommand(['npm', 'run', 'lint'], ctx()), { kind: 'auto', basis: 'project-script' });
  assert.equal(matchProjectScript(['npm', 'run', 'deploy'], ctx().projectScripts), null);
  // Extra arguments, other package managers and missing manifests are not auto.
  assert.equal(matchProjectScript(['npm', 'run', 'lint', '--', '--fix'], ctx().projectScripts), null);
  assert.equal(matchProjectScript(['pnpm', 'lint'], ctx().projectScripts), null);
  assert.equal(matchProjectScript(['npm', 'test'], null), null);
  assert.equal(
    matchProjectScript(['pnpm', 'lint'], { packageManagers: ['pnpm'], scripts: ['lint'] }),
    'lint',
  );
});

test('a command the user typed verbatim runs without confirmation', () => {
  const context = ctx({ projectScripts: null, userText: '实现登录，然后跑 `cargo test -p auth` 确认' });
  assert.deepEqual(authorizeCheckCommand(['cargo', 'test', '-p', 'auth'], context), {
    kind: 'auto',
    basis: 'user-literal',
  });
  // A prefix of a longer token is not a literal match.
  assert.equal(appearsLiterallyInUserText(['cargo', 'test'], 'run cargo test-all please'), false);
  assert.equal(appearsLiterallyInUserText(['go', 'test', './...'], 'please run go test ./... now'), true);
});

test('previously approved commands run without confirmation; others need it', () => {
  const approved = ctx({ projectScripts: null, approvedCommands: [['make', 'check']] });
  assert.deepEqual(authorizeCheckCommand(['make', 'check'], approved), { kind: 'auto', basis: 'previously-approved' });
  assert.deepEqual(authorizeCheckCommand(['make', 'check-all'], approved), {
    kind: 'confirm',
    highlight: false,
    reasons: [],
  });
});

test('inline code, downloads, network and privilege are always highlighted', () => {
  assert.deepEqual(highlightReasons(['bash', '-c', 'npm test']), ['shell-inline']);
  assert.deepEqual(highlightReasons(['/bin/zsh', '-lc', 'x']), ['shell-inline']);
  assert.deepEqual(highlightReasons(['env', 'CI=1', 'sh', '-c', 'x']), ['shell-inline']);
  assert.deepEqual(highlightReasons(['timeout', '60', 'node', '-e', 'x']), ['interpreter-inline']);
  assert.deepEqual(highlightReasons(['python3', '-c', 'x']), ['interpreter-inline']);
  assert.deepEqual(highlightReasons(['curl', '-fsSL', 'https://example.com']), ['network']);
  assert.deepEqual(highlightReasons(['npx', 'some-tool']), ['package-download-exec']);
  assert.deepEqual(highlightReasons(['pnpm', 'dlx', 'x']), ['package-download-exec']);
  assert.deepEqual(highlightReasons(['sudo', 'make']), ['privilege']);
  assert.deepEqual(highlightReasons(['bash', 'scripts/check.sh']), []);
  assert.deepEqual(highlightReasons(['npm', 'test']), []);
});

test('highlighted commands need confirmation even when the user typed them or approved them', () => {
  const context = ctx({
    userText: 'run bash -c "npm test" first',
    approvedCommands: [['curl', 'https://example.com']],
  });
  assert.deepEqual(authorizeCheckCommand(['curl', 'https://example.com'], context), {
    kind: 'confirm',
    highlight: true,
    reasons: ['network'],
  });
});

test('runtime guard requires the exact authorized argv', () => {
  const authorized = [['npm', 'test']];
  assert.equal(isAuthorizedAtRuntime(['npm', 'test'], authorized), true);
  assert.equal(isAuthorizedAtRuntime(['npm', 'test', '--', '-u'], authorized), false);
  assert.equal(isAuthorizedAtRuntime(['npm', 'tests'], authorized), false);
});

test('watch flags, background operators and detach wrappers are flagged as unbounded', () => {
  assert.deepEqual(unboundedReasons(['vitest', '--watch']), ['watch-flag']);
  assert.deepEqual(unboundedReasons(['jest', '--watchAll']), ['watch-flag']);
  assert.deepEqual(unboundedReasons(['npm', 'test', '&']), ['background-operator']);
  assert.deepEqual(unboundedReasons(['nohup', 'npm', 'test']), ['detach-wrapper']);
  assert.deepEqual(unboundedReasons(['npm', 'test']), []);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nworkflow-engine: all tests passed');
