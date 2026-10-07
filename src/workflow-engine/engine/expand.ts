// Expands macros into generic steps. `reviewLoop` becomes
//   implement → repeat(checks → parallel reviews → fix-if-needed)
// (without the leading implement when it starts with a review)
// with fix skipped on the last round, so every version that could pass has
// been checked and reviewed. The repeat carries a policy marker the engine
// uses for the loop's convergence rules (plan §4.4).

import type {
  AgentStep,
  AskStep,
  CheckStep,
  Condition,
  ParallelStep,
  PromptBlock,
  RepeatStep,
  ReviewLoopStep,
  Step,
  StopStep,
  WorkflowSpec,
} from '../spec/workflow-spec';

export type ReviewLoopPolicy = {
  kind: 'reviewLoop';
  loopId: string;
  reviewsStepId: string;
  reviewStepIds: string[];
  fixStepId: string;
  /**
   * No repair rounds: the loop only reports what the reviews and checks
   * found. Running out of rounds then ends the loop instead of asking for
   * more, and acceptance records what did not pass.
   */
  reportOnly: boolean;
};

export type XParallelStep = Omit<ParallelStep, 'steps'> & { steps: XStep[] };
export type XRepeatStep = Omit<RepeatStep, 'steps'> & { steps: XStep[]; policy?: ReviewLoopPolicy };
/** Internal container produced by macro expansion; runs its steps in order. */
export type XSequenceStep = { id: string; kind: 'sequence'; phase?: string; steps: XStep[] };
export type XStep = AgentStep | CheckStep | AskStep | StopStep | XParallelStep | XRepeatStep | XSequenceStep;

export type ExpandedSpec = Omit<WorkflowSpec, 'steps'> & { steps: XStep[] };

export const reviewLoopIds = (loopId: string) => ({
  implement: `${loopId}.implement`,
  rounds: `${loopId}.rounds`,
  reviews: `${loopId}.reviews`,
  review: (member: string) => `${loopId}.review.${member}`,
  fix: `${loopId}.fix`,
});

export function expandSpec(spec: WorkflowSpec): ExpandedSpec {
  return { ...spec, steps: spec.steps.map(expandStep) };
}

function expandStep(step: Step): XStep {
  switch (step.kind) {
    case 'parallel':
      return { ...step, steps: step.steps.map(expandStep) };
    case 'repeat':
      return { ...step, steps: step.steps.map(expandStep) };
    case 'reviewLoop':
      return expandReviewLoop(step);
    default:
      return step;
  }
}

function expandReviewLoop(loop: ReviewLoopStep): XStep {
  const ids = reviewLoopIds(loop.id);
  const checkIds = loop.checks.map((c) => c.id);
  const reviewIds = loop.reviewers.map(ids.review);
  const phase = loop.phase;
  // Each generated step is named for what it does; a phase the planner gave
  // the whole loop stays on the loop's containers.
  const withPhase = <T extends object>(step: T, name: string): T => ({ ...step, phase: name }) as T;

  const implement: AgentStep = withPhase(
    {
      id: ids.implement,
      kind: 'agent',
      member: loop.implementer,
      task: loop.task,
      workspace: 'write',
      output: 'implementation',
      session: 'continue',
    },
    'implement',
  );

  const reviewTask = (member: string): PromptBlock[] => [
    { text: 'The implementer was given this task:' },
    ...loop.task,
    {
      text:
        'Review the current version of the change against the goal above. Report blocking problems as blocking findings; ' +
        'everything else is advisory. If a previous review of yours is included, give a status for each of its blocking findings.',
    },
    { from: { step: ids.review(member), iteration: 'previous' } },
    { from: { step: ids.fix, iteration: 'previous' } },
  ];

  const reviews: XParallelStep = withPhase(
    {
      id: ids.reviews,
      kind: 'parallel',
      steps: loop.reviewers.map(
        (member): AgentStep => ({
          id: ids.review(member),
          kind: 'agent',
          phase: 'review',
          member,
          task: reviewTask(member),
          workspace: 'snapshot',
          output: 'review',
          session: 'fresh',
          ...(checkIds.length > 0 ? { if: { checkPassed: checkIds } } : {}),
        }),
      ),
    },
    'review',
  );

  const needsFix: Condition =
    checkIds.length > 0
      ? { any: [{ not: { checkPassed: checkIds } }, { hasBlocking: reviewIds }] }
      : { hasBlocking: reviewIds };

  const fix: AgentStep = withPhase(
    {
      id: ids.fix,
      kind: 'agent',
      if: { all: [{ not: { lastIteration: true } }, needsFix] },
      member: loop.implementer,
      task: [
        {
          text:
            'Fix the failed checks and blocking findings below. For each blocking finding, report it as fixed or disputed ' +
            '(with your reasoning) in findingResponses. Conflicting suggestions from different reviewers are marked; say which you followed and why.',
        },
        ...checkIds.map((step): PromptBlock => ({ from: { step } })),
        ...reviewIds.map((step): PromptBlock => ({ from: { step } })),
      ],
      workspace: 'write',
      output: 'implementation',
      session: 'continue',
    },
    'fix',
  );

  const until: Condition =
    checkIds.length > 0 ? { all: [{ checkPassed: checkIds }, { approved: reviewIds }] } : { approved: reviewIds };

  const rounds: XRepeatStep = {
    id: ids.rounds,
    kind: 'repeat',
    max: loop.maxRepairRounds + 1,
    until,
    steps: [...loop.checks.map((c) => withPhase(c, 'check')), reviews, fix],
    policy: {
      kind: 'reviewLoop',
      loopId: loop.id,
      reviewsStepId: ids.reviews,
      reviewStepIds: reviewIds,
      fixStepId: ids.fix,
      reportOnly: loop.maxRepairRounds === 0,
    },
    ...(phase ? { phase } : {}),
  };

  const steps: XStep[] = loop.start === 'review' ? [rounds] : [implement, rounds];
  return { id: loop.id, kind: 'sequence', steps, ...(phase ? { phase } : {}) };
}

/**
 * True when a review runs before the implementer writes anything, so the
 * change under review predates the run (e.g. "review my uncommitted changes")
 * and reviewers need a diff against an earlier base than the run's baseline.
 */
export function reviewsBeforeWrite(spec: WorkflowSpec): boolean {
  const implementer = spec.members.find((m) => m.role === 'implementer')?.key;
  const order: XStep[] = [];
  const flatten = (steps: XStep[]) => {
    for (const step of steps) {
      if (step.kind === 'parallel' || step.kind === 'repeat' || step.kind === 'sequence') flatten(step.steps);
      else order.push(step);
    }
  };
  flatten(expandSpec(spec).steps);
  for (const step of order) {
    if (step.kind !== 'agent') continue;
    if (implementer && step.member === implementer) return false;
    if (step.output === 'review') return true;
  }
  return false;
}
