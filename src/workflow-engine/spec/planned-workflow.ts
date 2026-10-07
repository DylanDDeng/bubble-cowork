// Planner exchange format: flat, closed and non-recursive so the same JSON
// Schema can constrain both Claude structured outputs (no recursive schemas,
// no numeric/string constraints, additionalProperties must be false) and
// Codex strict mode (every property required, optional values nullable).
// Nesting is expressed through `parent` references and rebuilt locally.

import type { MemberRole, Source } from './workflow-spec';

export type PlannedStepKind = 'agent' | 'check' | 'parallel' | 'repeat' | 'ask' | 'stop' | 'reviewLoop';

export type ConditionOp =
  | 'all'
  | 'any'
  | 'not'
  | 'approved'
  | 'checkPassed'
  | 'hasBlocking'
  | 'hasQuestions'
  | 'changed'
  | 'equals'
  | 'lastIteration';

export type FlatRef = { step: string; field: string | null; iteration: 'current' | 'previous' | null };

export type ConditionNode = {
  id: string;
  parent: string | null;
  op: ConditionOp;
  steps: string[] | null;
  ref: FlatRef | null;
  value: string | null;
};

export type PlannedTaskBlock = { kind: 'text' | 'goal' | 'from'; text: string | null; ref: FlatRef | null };

export type PlannedRouteField = { name: string; kind: 'enum' | 'boolean'; values: string[] | null };

export type PlannedStep = {
  id: string;
  parent: string | null;
  order: number;
  kind: PlannedStepKind;
  phase: string | null;
  condition: ConditionNode[] | null;
  member: string | null;
  task: PlannedTaskBlock[] | null;
  workspace: 'write' | 'snapshot' | null;
  output: 'implementation' | 'review' | 'notes' | 'route' | null;
  route: PlannedRouteField[] | null;
  session: 'continue' | 'fresh' | null;
  argv: string[] | null;
  timeoutMs: number | null;
  max: number | null;
  question: string | null;
  options: string[] | null;
  reason: string | null;
  implementer: string | null;
  reviewers: string[] | null;
  start: 'implement' | 'review' | null;
};

export type PlannedWorkflow = {
  schemaVersion: 1;
  name: string;
  description: string;
  members: Array<{
    key: string;
    role: MemberRole;
    agent: string;
    model: string | null;
    focus: string | null;
    source: Source;
  }>;
  acceptance: Array<{
    id: string;
    description: string;
    verifyKind: 'check' | 'review' | 'manual';
    verifyRef: string | null;
    source: Source;
  }>;
  unsupported: string[];
  assumptions: string[];
  steps: PlannedStep[];
};

type JsonSchema = Record<string, unknown>;

const str: JsonSchema = { type: 'string' };
const num: JsonSchema = { type: 'number' };
const strArray: JsonSchema = { type: 'array', items: str };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const strEnum = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] });

/** Closed object: every property is required, nothing else is allowed. */
function object(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const ROLES = ['implementer', 'reviewer', 'advisor'] as const;
const SOURCES = ['user', 'template', 'inferred'] as const;
export const PLANNED_STEP_KINDS = ['agent', 'check', 'parallel', 'repeat', 'ask', 'stop', 'reviewLoop'] as const;
export const CONDITION_OPS = [
  'all',
  'any',
  'not',
  'approved',
  'checkPassed',
  'hasBlocking',
  'hasQuestions',
  'changed',
  'equals',
  'lastIteration',
] as const;

export type PlannerSchemaOptions = {
  /** Member configuration names the Host offers for this run. */
  agentNames: string[];
  /** Union of model ids from the live catalogs of those configurations. */
  modelIds: string[];
};

/**
 * JSON Schema for the Planner's structured output. Agent and model names are
 * injected per run so the model can only pick configurations the Host offers;
 * per-agent model membership and all numeric limits are checked locally.
 */
export function buildPlannedWorkflowSchema(options: PlannerSchemaOptions): JsonSchema {
  if (options.agentNames.length === 0) {
    throw new Error('At least one member configuration is required to plan a workflow.');
  }
  const flatRef = object({
    step: str,
    field: nullable(str),
    iteration: nullable(strEnum(['current', 'previous'])),
  });
  const conditionNode = object({
    id: str,
    parent: nullable(str),
    op: strEnum(CONDITION_OPS),
    steps: nullable(strArray),
    ref: nullable(flatRef),
    value: nullable(str),
  });
  const taskBlock = object({
    kind: strEnum(['text', 'goal', 'from']),
    text: nullable(str),
    ref: nullable(flatRef),
  });
  const routeField = object({
    name: str,
    kind: strEnum(['enum', 'boolean']),
    values: nullable(strArray),
  });
  const model = options.modelIds.length > 0 ? nullable(strEnum(options.modelIds)) : { type: 'null' };

  return object({
    schemaVersion: { type: 'number', enum: [1] },
    name: str,
    description: str,
    members: {
      type: 'array',
      items: object({
        key: str,
        role: strEnum(ROLES),
        agent: strEnum(options.agentNames),
        model,
        focus: nullable(str),
        source: strEnum(SOURCES),
      }),
    },
    acceptance: {
      type: 'array',
      items: object({
        id: str,
        description: str,
        verifyKind: strEnum(['check', 'review', 'manual']),
        verifyRef: nullable(str),
        source: strEnum(SOURCES),
      }),
    },
    unsupported: strArray,
    assumptions: strArray,
    steps: {
      type: 'array',
      items: object({
        id: str,
        parent: nullable(str),
        order: num,
        kind: strEnum(PLANNED_STEP_KINDS),
        phase: nullable(str),
        condition: nullable({ type: 'array', items: conditionNode }),
        member: nullable(str),
        task: nullable({ type: 'array', items: taskBlock }),
        workspace: nullable(strEnum(['write', 'snapshot'])),
        output: nullable(strEnum(['implementation', 'review', 'notes', 'route'])),
        route: nullable({ type: 'array', items: routeField }),
        session: nullable(strEnum(['continue', 'fresh'])),
        argv: nullable(strArray),
        timeoutMs: nullable(num),
        max: nullable(num),
        question: nullable(str),
        options: nullable(strArray),
        reason: nullable(str),
        implementer: nullable(str),
        reviewers: nullable(strArray),
        start: nullable(strEnum(['implement', 'review'])),
      }),
    },
  });
}
