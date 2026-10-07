// Rebuilds the tree-shaped WorkflowSpec from the Planner's flat exchange
// format. This pass checks structure only (parents, cycles, depth, required
// fields per kind); semantic rules such as member capabilities, reference
// ordering and product limits belong to the SpecValidator. Fields that do not
// apply to a step's kind carry no authority, so models that fill them in are
// not failed for it: the values are dropped and reported as warnings.

import type {
  ConditionNode,
  FlatRef,
  PlannedStep,
  PlannedTaskBlock,
  PlannedWorkflow,
} from '../spec/planned-workflow';
import type {
  Acceptance,
  CheckStep,
  Condition,
  Member,
  PromptBlock,
  Ref,
  RouteField,
  Step,
  WorkflowSpec,
} from '../spec/workflow-spec';

export type ConversionError = { path: string; message: string };

export type ConversionResult =
  | { ok: true; spec: WorkflowSpec; warnings: ConversionError[] }
  | { ok: false; errors: ConversionError[]; warnings: ConversionError[] };

export type ConversionOptions = {
  /** Maximum container nesting depth; top-level steps are depth 1. */
  maxDepth?: number;
};

const CONTAINER_KINDS = new Set(['parallel', 'repeat', 'reviewLoop']);
const DEFAULT_MAX_DEPTH = 3;

/** Fields each step kind may set; any other optional field is ignored with a warning. */
const STEP_FIELDS: Record<PlannedStep['kind'], ReadonlyArray<keyof PlannedStep>> = {
  agent: ['condition', 'member', 'task', 'workspace', 'output', 'route', 'session'],
  check: ['condition', 'argv', 'timeoutMs'],
  parallel: [],
  repeat: ['condition', 'max'],
  ask: ['condition', 'question', 'options'],
  stop: ['condition', 'reason'],
  reviewLoop: ['implementer', 'reviewers', 'task', 'max', 'start'],
};

const OPTIONAL_STEP_FIELDS: ReadonlyArray<keyof PlannedStep> = [
  'condition',
  'member',
  'task',
  'workspace',
  'output',
  'route',
  'session',
  'argv',
  'timeoutMs',
  'max',
  'question',
  'options',
  'reason',
  'implementer',
  'reviewers',
  'start',
];

export function convertPlannedWorkflow(
  planned: PlannedWorkflow,
  options: ConversionOptions = {},
): ConversionResult {
  const errors: ConversionError[] = [];
  const warnings: ConversionError[] = [];
  const fail = (path: string, message: string) => {
    errors.push({ path, message });
  };
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const members: Member[] = planned.members.map((m) => ({
    key: m.key,
    role: m.role,
    agent: m.agent,
    ...(m.model !== null ? { model: m.model } : {}),
    ...(m.focus !== null ? { focus: m.focus } : {}),
    source: m.source,
  }));

  const acceptance: Acceptance[] = [];
  planned.acceptance.forEach((a, i) => {
    const path = `acceptance[${i}]`;
    if (a.verifyKind === 'manual') {
      if (a.verifyRef !== null) fail(`${path}.verifyRef`, 'Manual acceptance must not reference a step or member.');
      acceptance.push({ id: a.id, description: a.description, verify: { kind: 'manual' }, source: a.source });
      return;
    }
    if (a.verifyRef === null || a.verifyRef === '') {
      fail(`${path}.verifyRef`, `A ${a.verifyKind} acceptance must name the ${a.verifyKind === 'check' ? 'check step' : 'reviewer'}.`);
      return;
    }
    acceptance.push({
      id: a.id,
      description: a.description,
      verify: a.verifyKind === 'check' ? { kind: 'check', step: a.verifyRef } : { kind: 'review', member: a.verifyRef },
      source: a.source,
    });
  });

  // Index steps and validate parent links. Only these structural errors stop
  // the tree build; everything else is collected so the Planner can repair
  // all problems in one round.
  const errorsBeforeStructure = errors.length;
  const byId = new Map<string, { step: PlannedStep; index: number }>();
  planned.steps.forEach((step, index) => {
    if (step.id === '') fail(`steps[${index}].id`, 'Step id must not be empty.');
    else if (byId.has(step.id)) fail(`steps[${index}].id`, `Duplicate step id "${step.id}".`);
    else byId.set(step.id, { step, index });
  });

  const children = new Map<string | null, PlannedStep[]>();
  planned.steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    if (step.parent !== null) {
      const parent = byId.get(step.parent);
      if (!parent) {
        fail(`${path}.parent`, `Parent "${step.parent}" does not exist.`);
        return;
      }
      if (!CONTAINER_KINDS.has(parent.step.kind)) {
        fail(`${path}.parent`, `Parent "${step.parent}" is a ${parent.step.kind} step and cannot contain steps.`);
        return;
      }
      if (parent.step.kind === 'reviewLoop' && step.kind !== 'check') {
        fail(`${path}.kind`, 'Only check steps may be placed inside a reviewLoop.');
        return;
      }
    }
    const list = children.get(step.parent) ?? [];
    list.push(step);
    children.set(step.parent, list);
  });

  // Cycles: walk each step's parent chain.
  for (const { step, index } of byId.values()) {
    const seen = new Set<string>([step.id]);
    let cursor = step.parent;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        fail(`steps[${index}].parent`, `Step "${step.id}" is part of a parent cycle.`);
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.step.parent ?? null;
    }
  }

  for (const [parent, list] of children) {
    const orders = new Set<number>();
    for (const step of list) {
      const index = byId.get(step.id)?.index ?? -1;
      if (!Number.isInteger(step.order)) fail(`steps[${index}].order`, 'Order must be an integer.');
      else if (orders.has(step.order)) {
        fail(`steps[${index}].order`, `Order ${step.order} is used twice under ${parent === null ? 'the top level' : `"${parent}"`}.`);
      }
      orders.add(step.order);
    }
  }

  if (errors.length > errorsBeforeStructure) return { ok: false, errors, warnings };

  const build = (step: PlannedStep, depth: number): Step | null => {
    const index = byId.get(step.id)?.index ?? -1;
    const path = `steps[${index}]`;
    const allowed = new Set(STEP_FIELDS[step.kind]);
    for (const field of OPTIONAL_STEP_FIELDS) {
      if (!allowed.has(field) && step[field] != null) {
        warnings.push({ path: `${path}.${field}`, message: `Ignored: a ${step.kind} step does not use "${field}".` });
      }
    }
    if (CONTAINER_KINDS.has(step.kind) && depth > maxDepth) {
      fail(path, `Nesting deeper than ${maxDepth} levels is not allowed.`);
      return null;
    }
    const kids = (children.get(step.id) ?? []).slice().sort((a, b) => a.order - b.order);
    const buildKids = () => kids.map((kid) => build(kid, depth + 1)).filter((s): s is Step => s !== null);
    const base = { id: step.id, ...(step.phase !== null ? { phase: step.phase } : {}) };
    const condition = step.condition !== null ? buildCondition(step.condition, `${path}.condition`, fail) : undefined;
    const withIf = condition ? { if: condition } : {};

    switch (step.kind) {
      case 'agent': {
        if (step.member === null) fail(`${path}.member`, 'An agent step must name a member.');
        const task = requireTask(step.task, `${path}.task`, fail);
        let output: Extract<Step, { kind: 'agent' }>['output'] | null = null;
        if (step.output === null) fail(`${path}.output`, 'An agent step must declare its output.');
        else if (step.output === 'route') {
          const route = buildRoute(step.route, `${path}.route`, fail);
          if (route) output = { route };
        } else {
          if (step.route !== null) fail(`${path}.route`, 'Route fields are only allowed when output is "route".');
          output = step.output;
        }
        if (step.member === null || !task || !output) return null;
        return {
          ...base,
          kind: 'agent',
          ...withIf,
          member: step.member,
          task,
          ...(step.workspace !== null ? { workspace: step.workspace } : {}),
          output,
          ...(step.session !== null ? { session: step.session } : {}),
        };
      }
      case 'check': {
        const check = buildCheck(step, path, fail);
        return check ? { ...check, ...withIf } : null;
      }
      case 'parallel': {
        if (kids.length === 0) fail(path, 'A parallel step must contain at least one step.');
        return { ...base, kind: 'parallel', steps: buildKids() };
      }
      case 'repeat': {
        if (kids.length === 0) fail(path, 'A repeat step must contain at least one step.');
        if (!condition) fail(`${path}.condition`, 'A repeat step must declare its until condition.');
        if (step.max === null) fail(`${path}.max`, 'A repeat step must declare max.');
        if (!condition || step.max === null) return null;
        return { ...base, kind: 'repeat', max: step.max, until: condition, steps: buildKids() };
      }
      case 'ask': {
        if (step.question === null || step.question === '') {
          fail(`${path}.question`, 'An ask step must have a question.');
          return null;
        }
        return {
          ...base,
          kind: 'ask',
          ...withIf,
          question: step.question,
          ...(step.options !== null ? { options: step.options } : {}),
        };
      }
      case 'stop': {
        if (step.reason === null || step.reason === '') {
          fail(`${path}.reason`, 'A stop step must have a reason.');
          return null;
        }
        return { ...base, kind: 'stop', ...withIf, reason: step.reason };
      }
      case 'reviewLoop': {
        if (step.implementer === null) fail(`${path}.implementer`, 'A reviewLoop must name its implementer.');
        if (step.reviewers === null || step.reviewers.length === 0) {
          fail(`${path}.reviewers`, 'A reviewLoop must name at least one reviewer.');
        }
        if (step.max === null) fail(`${path}.max`, 'A reviewLoop must declare max (repair rounds).');
        const task = requireTask(step.task, `${path}.task`, fail);
        const checks = buildKids().filter((s): s is CheckStep => s.kind === 'check');
        if (step.implementer === null || !step.reviewers?.length || step.max === null || !task) return null;
        return {
          ...base,
          kind: 'reviewLoop',
          implementer: step.implementer,
          reviewers: step.reviewers,
          task,
          checks,
          maxRepairRounds: step.max,
          ...(step.start === 'review' ? { start: 'review' as const } : {}),
        };
      }
    }
  };

  const topLevel = (children.get(null) ?? []).slice().sort((a, b) => a.order - b.order);
  if (topLevel.length === 0) fail('steps', 'A workflow must have at least one top-level step.');
  const steps = topLevel.map((step) => build(step, 1)).filter((s): s is Step => s !== null);

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    warnings,
    spec: {
      schemaVersion: 1,
      name: planned.name,
      description: planned.description,
      members,
      acceptance,
      unsupported: planned.unsupported,
      assumptions: planned.assumptions,
      steps,
    },
  };
}

type Fail = (path: string, message: string) => void;

function buildCheck(step: PlannedStep, path: string, fail: Fail): CheckStep | null {
  if (step.argv === null || step.argv.length === 0 || step.argv[0] === '') {
    fail(`${path}.argv`, 'A check step must have a non-empty argv.');
    return null;
  }
  if (step.timeoutMs === null) {
    fail(`${path}.timeoutMs`, 'A check step must declare timeoutMs.');
    return null;
  }
  return {
    id: step.id,
    ...(step.phase !== null ? { phase: step.phase } : {}),
    kind: 'check',
    argv: step.argv,
    timeoutMs: step.timeoutMs,
  };
}

function requireTask(blocks: PlannedTaskBlock[] | null, path: string, fail: Fail): PromptBlock[] | null {
  if (blocks === null || blocks.length === 0) {
    fail(path, 'A task must contain at least one block.');
    return null;
  }
  const result: PromptBlock[] = [];
  blocks.forEach((block, i) => {
    const blockPath = `${path}[${i}]`;
    if (block.kind === 'text') {
      if (block.text === null || block.text === '') fail(`${blockPath}.text`, 'A text block must have text.');
      else result.push({ text: block.text });
      if (block.ref !== null) fail(`${blockPath}.ref`, 'A text block must leave ref null.');
    } else if (block.kind === 'goal') {
      if (block.text !== null || block.ref !== null) fail(blockPath, 'A goal block must leave text and ref null.');
      result.push({ goal: true });
    } else {
      if (block.text !== null) fail(`${blockPath}.text`, 'A from block must leave text null.');
      const ref = block.ref ? buildRef(block.ref, `${blockPath}.ref`, fail) : null;
      if (!block.ref) fail(`${blockPath}.ref`, 'A from block must reference a step.');
      if (ref) result.push({ from: ref });
    }
  });
  return result.length === blocks.length ? result : null;
}

function buildRef(ref: FlatRef, path: string, fail: Fail): Ref | null {
  if (ref.step === '') {
    fail(`${path}.step`, 'A reference must name a step.');
    return null;
  }
  return {
    step: ref.step,
    ...(ref.field !== null ? { field: ref.field } : {}),
    ...(ref.iteration !== null ? { iteration: ref.iteration } : {}),
  };
}

function buildRoute(fields: PlannedStep['route'], path: string, fail: Fail): RouteField[] | null {
  if (fields === null || fields.length === 0) {
    fail(path, 'A route output must declare at least one field.');
    return null;
  }
  const names = new Set<string>();
  const result: RouteField[] = [];
  fields.forEach((field, i) => {
    const fieldPath = `${path}[${i}]`;
    if (names.has(field.name)) fail(`${fieldPath}.name`, `Duplicate route field "${field.name}".`);
    names.add(field.name);
    if (field.kind === 'boolean') {
      if (field.values !== null) fail(`${fieldPath}.values`, 'A boolean route field must leave values null.');
      result.push({ name: field.name, kind: 'boolean' });
    } else if (field.values === null || field.values.length === 0) {
      fail(`${fieldPath}.values`, 'An enum route field must list its values.');
    } else {
      result.push({ name: field.name, kind: 'enum', values: field.values });
    }
  });
  return result.length === fields.length ? result : null;
}

const GROUP_OPS = new Set(['all', 'any']);
const STEP_LIST_OPS = new Set(['approved', 'checkPassed', 'hasBlocking']);
const SINGLE_STEP_OPS = new Set(['hasQuestions', 'changed']);

function buildCondition(nodes: ConditionNode[], path: string, fail: Fail): Condition | undefined {
  if (nodes.length === 0) {
    fail(path, 'A condition must contain at least one node.');
    return undefined;
  }
  const byId = new Map<string, ConditionNode>();
  const kids = new Map<string | null, ConditionNode[]>();
  for (const [i, node] of nodes.entries()) {
    if (byId.has(node.id)) fail(`${path}[${i}].id`, `Duplicate condition node id "${node.id}".`);
    byId.set(node.id, node);
  }
  for (const [i, node] of nodes.entries()) {
    if (node.parent !== null) {
      const parent = byId.get(node.parent);
      if (!parent) fail(`${path}[${i}].parent`, `Condition parent "${node.parent}" does not exist.`);
      else if (!GROUP_OPS.has(parent.op) && parent.op !== 'not') {
        fail(`${path}[${i}].parent`, `Condition "${node.parent}" (${parent.op}) cannot have children.`);
      }
    }
    const list = kids.get(node.parent) ?? [];
    list.push(node);
    kids.set(node.parent, list);
  }
  const roots = kids.get(null) ?? [];
  if (roots.length !== 1) {
    fail(path, `A condition must have exactly one root node; found ${roots.length}.`);
    return undefined;
  }

  const visited = new Set<string>();
  const build = (node: ConditionNode, nodePath: string): Condition | undefined => {
    if (visited.has(node.id)) {
      fail(nodePath, `Condition node "${node.id}" is part of a cycle.`);
      return undefined;
    }
    visited.add(node.id);
    const childNodes = kids.get(node.id) ?? [];
    const leafOnly = () => {
      if (childNodes.length > 0) fail(nodePath, `A ${node.op} condition cannot have children.`);
    };
    const noFields = (...fields: Array<'steps' | 'ref' | 'value'>) => {
      for (const field of fields) {
        if (node[field] !== null) fail(`${nodePath}.${field}`, `A ${node.op} condition must leave "${field}" null.`);
      }
    };

    if (GROUP_OPS.has(node.op) || node.op === 'not') {
      noFields('steps', 'ref', 'value');
      if (node.op === 'not' && childNodes.length !== 1) {
        fail(nodePath, 'A not condition must have exactly one child.');
        return undefined;
      }
      if (childNodes.length === 0) {
        fail(nodePath, `An ${node.op} condition must have at least one child.`);
        return undefined;
      }
      const built = childNodes.map((child) => build(child, `${nodePath}>${child.id}`));
      if (built.some((c) => c === undefined)) return undefined;
      const conditions = built as Condition[];
      if (node.op === 'not') return { not: conditions[0] };
      return node.op === 'all' ? { all: conditions } : { any: conditions };
    }

    leafOnly();
    if (STEP_LIST_OPS.has(node.op) || SINGLE_STEP_OPS.has(node.op)) {
      noFields('ref', 'value');
      if (node.steps === null || node.steps.length === 0) {
        fail(`${nodePath}.steps`, `A ${node.op} condition must name at least one step.`);
        return undefined;
      }
      if (SINGLE_STEP_OPS.has(node.op)) {
        if (node.steps.length !== 1) {
          fail(`${nodePath}.steps`, `A ${node.op} condition must name exactly one step.`);
          return undefined;
        }
        return node.op === 'changed' ? { changed: node.steps[0] } : { hasQuestions: node.steps[0] };
      }
      if (node.op === 'approved') return { approved: node.steps };
      if (node.op === 'checkPassed') return { checkPassed: node.steps };
      return { hasBlocking: node.steps };
    }
    if (node.op === 'equals') {
      noFields('steps');
      if (node.ref === null || node.value === null) {
        fail(nodePath, 'An equals condition must have both ref and value.');
        return undefined;
      }
      const ref = buildRef(node.ref, `${nodePath}.ref`, fail);
      return ref ? { equals: { ref, value: node.value } } : undefined;
    }
    noFields('steps', 'ref', 'value');
    return { lastIteration: true };
  };

  const result = build(roots[0], `${path}>${roots[0].id}`);
  for (const node of nodes) {
    if (!visited.has(node.id)) fail(path, `Condition node "${node.id}" is not reachable from the root.`);
  }
  return result;
}
