// Tree-shaped workflow definition the engine executes. Built-in templates and
// repository workflows are authored in this form; the Planner emits the flat
// exchange format (planned-workflow.ts) which is converted into it.

export type MemberRole = 'implementer' | 'reviewer' | 'advisor';
export type Source = 'user' | 'template' | 'inferred';

export type Member = {
  key: string;
  role: MemberRole;
  /** Name of a Host-provided member configuration. */
  agent: string;
  /** Must belong to that provider's live model catalog. */
  model?: string;
  focus?: string;
  source: Source;
};

export type Acceptance = {
  id: string;
  description: string;
  verify: { kind: 'check'; step: string } | { kind: 'review'; member: string } | { kind: 'manual' };
  source: Source;
};

export type Ref = { step: string; field?: string; iteration?: 'current' | 'previous' };

export type PromptBlock = { text: string } | { goal: true } | { from: Ref };

export type RouteField =
  | { name: string; kind: 'enum'; values: string[] }
  | { name: string; kind: 'boolean' };

/** Booleans in `equals` are compared as the strings "true" / "false". */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { approved: string[] }
  | { checkPassed: string[] }
  | { hasBlocking: string[] }
  | { hasQuestions: string }
  | { changed: string }
  | { equals: { ref: Ref; value: string } }
  | { lastIteration: true };

type StepBase = { id: string; phase?: string };

export type AgentStep = StepBase & {
  kind: 'agent';
  if?: Condition;
  member: string;
  task: PromptBlock[];
  workspace?: 'write' | 'snapshot';
  output: 'implementation' | 'review' | 'notes' | { route: RouteField[] };
  session?: 'continue' | 'fresh';
};

export type CheckStep = StepBase & { kind: 'check'; if?: Condition; argv: string[]; timeoutMs: number };
export type ParallelStep = StepBase & { kind: 'parallel'; steps: Step[] };
export type RepeatStep = StepBase & { kind: 'repeat'; max: number; until: Condition; steps: Step[] };
export type AskStep = StepBase & { kind: 'ask'; if?: Condition; question: string; options?: string[] };
export type StopStep = StepBase & { kind: 'stop'; if?: Condition; reason: string };

export type ReviewLoopStep = StepBase & {
  kind: 'reviewLoop';
  implementer: string;
  reviewers: string[];
  task: PromptBlock[];
  checks: CheckStep[];
  maxRepairRounds: number;
  /**
   * 'review' skips the initial implement step: the change already exists in
   * the workspace (e.g. a chat session asking for a review of its own edits)
   * and the loop starts with checks and reviews. Defaults to 'implement'.
   */
  start?: 'implement' | 'review';
};

export type Step = AgentStep | CheckStep | ParallelStep | RepeatStep | AskStep | StopStep | ReviewLoopStep;

export type WorkflowSpec = {
  schemaVersion: 1;
  name: string;
  description: string;
  members: Member[];
  acceptance: Acceptance[];
  unsupported: string[];
  assumptions: string[];
  steps: Step[];
};
