// Semantic validation of a WorkflowSpec before it runs (plan §4.6). Every
// limit is enforced again at runtime; this pass gives early, complete
// feedback to the Planner and decides whether the plan card must ask for
// confirmation.

import {
  authorizeCheckCommand,
  unboundedReasons,
  type CheckAuthorization,
  type CheckAuthorizationContext,
} from '../authorize/check-authorization';
import { expandSpec, type XStep } from '../engine/expand';
import type { ProductLimits } from '../limits';
import type { Condition, MemberRole, PromptBlock, Ref, Step, WorkflowSpec } from '../spec/workflow-spec';

/** A Host-provided member configuration (plan §3.2). */
export type MemberConfig = {
  name: string;
  provider: string;
  /** Roles this provider has proven it can be held to (plan §6.2). */
  roles: MemberRole[];
  models: string[];
  /** Degradable capabilities this provider lacks, shown on the plan card. */
  degraded: string[];
};

export type ValidationContext = {
  memberConfigs: MemberConfig[];
  limits: ProductLimits;
  checkAuthorization?: CheckAuthorizationContext;
};

export type Issue = { path: string; message: string };

export type ConfirmReason = { kind: 'member' | 'unsupported' | 'check'; message: string };

export type ValidationReport = {
  errors: Issue[];
  warnings: Issue[];
  /**
   * Why the plan card must wait for the user; empty means it may start
   * directly. Only what the user did not ask for stops a run: members they did
   * not name, parts of the request the workflow cannot do, and commands that
   * need approval (which the Host may waive when the requesting session runs
   * with full access). Assumptions, inferred acceptance and warnings are shown
   * but do not stop it.
   */
  confirmReasons: ConfirmReason[];
  checks: Array<{ stepId: string; argv: string[]; authorization: CheckAuthorization }>;
};

/** Fields a reference may read from each kind of result. */
const OUTPUT_FIELDS: Record<'implementation' | 'review' | 'notes' | 'check' | 'ask', string[]> = {
  implementation: ['summary', 'changes', 'questions', 'blockers', 'findingResponses', 'selfReportedChecks'],
  review: ['verdict', 'summary', 'findings', 'blockers', 'previousFindings'],
  notes: ['summary', 'details', 'references'],
  check: ['summary', 'exitCode'],
  ask: ['answer'],
};

type Located = {
  step: XStep;
  position: number;
  /** Container ancestors, outermost first. */
  ancestors: XStep[];
};

export function validateSpec(spec: WorkflowSpec, context: ValidationContext): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const confirmReasons: ConfirmReason[] = [];
  const checks: ValidationReport['checks'] = [];
  const { limits } = context;
  const error = (path: string, message: string) => errors.push({ path, message });

  // ---- members ----
  const configs = new Map(context.memberConfigs.map((c) => [c.name, c]));
  const members = new Map(spec.members.map((m) => [m.key, m]));
  const seenMembers = new Set<string>();
  spec.members.forEach((member, i) => {
    const path = `members[${i}]`;
    if (seenMembers.has(member.key)) error(`${path}.key`, `Duplicate member key "${member.key}".`);
    seenMembers.add(member.key);
    const config = configs.get(member.agent);
    if (!config) {
      error(`${path}.agent`, `"${member.agent}" is not an available member configuration.`);
      return;
    }
    if (!config.roles.includes(member.role)) {
      error(`${path}.role`, `${member.agent} cannot act as ${member.role} (allowed: ${config.roles.join(', ') || 'none'}).`);
    }
    if (member.model !== undefined && !config.models.includes(member.model)) {
      error(`${path}.model`, `Model "${member.model}" is not in ${member.agent}'s catalog.`);
    }
    if (member.source === 'inferred') confirmReasons.push({ kind: 'member', message: `member "${member.key}" was not requested` });
  });
  if (spec.members.length > limits.maxMembers) error('members', `At most ${limits.maxMembers} members are allowed.`);
  if (spec.members.filter((m) => m.role === 'implementer').length > 1) {
    error('members', 'Only one implementer may write to the workspace.');
  }

  // ---- structure on the authored tree ----
  let stepCount = 0;
  const walk = (steps: Step[], depth: number, path: string) => {
    steps.forEach((step, i) => {
      const stepPath = `${path}[${i}]`;
      stepCount += step.kind === 'reviewLoop' ? 1 + step.checks.length : 1;
      if (step.kind === 'parallel' || step.kind === 'repeat' || step.kind === 'reviewLoop') {
        if (depth > limits.maxDepth) error(stepPath, `Nesting deeper than ${limits.maxDepth} levels is not allowed.`);
      }
      if (step.kind === 'repeat') {
        if (!Number.isInteger(step.max) || step.max < 1 || step.max > limits.maxRepeat) {
          error(`${stepPath}.max`, `repeat max must be an integer from 1 to ${limits.maxRepeat}.`);
        }
      }
      if (step.kind === 'reviewLoop') {
        if (!Number.isInteger(step.maxRepairRounds) || step.maxRepairRounds < 0 || step.maxRepairRounds > limits.maxRepairRounds) {
          error(`${stepPath}.maxRepairRounds`, `Repair rounds must be an integer from 0 to ${limits.maxRepairRounds}.`);
        }
        const implementer = members.get(step.implementer);
        if (!implementer) error(`${stepPath}.implementer`, `Unknown member "${step.implementer}".`);
        else if (implementer.role !== 'implementer') error(`${stepPath}.implementer`, `"${step.implementer}" is not an implementer.`);
        const unique = new Set(step.reviewers);
        if (unique.size !== step.reviewers.length) error(`${stepPath}.reviewers`, 'Reviewers must be distinct.');
        step.reviewers.forEach((key) => {
          const reviewer = members.get(key);
          if (!reviewer) error(`${stepPath}.reviewers`, `Unknown member "${key}".`);
          else if (reviewer.role !== 'reviewer') error(`${stepPath}.reviewers`, `"${key}" is not a reviewer.`);
        });
      }
      if (step.kind === 'parallel' || step.kind === 'repeat') walk(step.steps, depth + 1, `${stepPath}.steps`);
    });
  };
  walk(spec.steps, 1, 'steps');
  if (stepCount > limits.maxSteps) error('steps', `At most ${limits.maxSteps} steps are allowed.`);
  if (spec.steps.length === 0) error('steps', 'A workflow needs at least one step.');

  // ---- semantics on the expanded tree ----
  const expanded = expandSpec(spec);
  const located = new Map<string, Located>();
  let position = 0;
  const locate = (steps: XStep[], ancestors: XStep[]) => {
    for (const step of steps) {
      if (located.has(step.id)) error(`steps.${step.id}`, `Duplicate step id "${step.id}".`);
      located.set(step.id, { step, position: position++, ancestors });
      if (step.kind === 'parallel' || step.kind === 'repeat' || step.kind === 'sequence') {
        locate(step.steps, [...ancestors, step]);
      }
    }
  };
  locate(expanded.steps, []);

  const agentOutput = (id: string) => {
    const target = located.get(id)?.step;
    return target?.kind === 'agent' ? (typeof target.output === 'string' ? target.output : 'route') : null;
  };
  const isWrite = (step: XStep) =>
    step.kind === 'agent' && (step.workspace ?? (members.get(step.member)?.role === 'implementer' ? 'write' : 'snapshot')) === 'write';

  /** May `reader` see `targetId`'s result under §4.3? */
  const canReference = (reader: Located, targetId: string, previous: boolean, path: string): boolean => {
    const target = located.get(targetId);
    if (!target) {
      error(path, `Unknown step "${targetId}".`);
      return false;
    }
    const readerChain = [...reader.ancestors, reader.step];
    const targetChain = [...target.ancestors, target.step];
    const sharedRepeats = target.ancestors.filter((a) => a.kind === 'repeat' && readerChain.includes(a));
    if (previous) {
      if (sharedRepeats.length === 0) {
        error(path, `"previous" iteration needs "${targetId}" to be in a repeat that also contains this step.`);
        return false;
      }
      return true;
    }
    // A repeat's until condition may read its own body.
    if (reader.step.kind === 'repeat' && target.ancestors.includes(reader.step)) return true;
    if (target.position >= reader.position) {
      error(path, `"${targetId}" does not run before this step.`);
      return false;
    }
    let common: XStep | undefined;
    for (let i = 0; i < Math.min(readerChain.length, targetChain.length); i += 1) {
      if (readerChain[i] !== targetChain[i]) break;
      common = readerChain[i];
    }
    if (common?.kind === 'parallel') {
      error(path, `"${targetId}" runs in parallel with this step and cannot be referenced.`);
      return false;
    }
    return true;
  };

  const fieldsOf = (step: XStep): string[] => {
    if (step.kind === 'check') return OUTPUT_FIELDS.check;
    if (step.kind === 'ask') return OUTPUT_FIELDS.ask;
    if (step.kind !== 'agent') return [];
    return typeof step.output === 'string' ? OUTPUT_FIELDS[step.output] : step.output.route.map((f) => f.name);
  };

  const checkRef = (reader: Located, ref: Ref, path: string) => {
    if (!canReference(reader, ref.step, ref.iteration === 'previous', path)) return;
    if (ref.field !== undefined && !fieldsOf(located.get(ref.step)!.step).includes(ref.field)) {
      error(path, `"${ref.step}" has no output field "${ref.field}".`);
    }
  };

  const checkCondition = (reader: Located, condition: Condition, path: string) => {
    const expectKind = (ids: string[], expected: string, test: (id: string) => boolean) => {
      for (const id of ids) {
        if (canReference(reader, id, false, path) && !test(id)) error(path, `"${id}" is not ${expected}.`);
      }
    };
    if ('all' in condition) condition.all.forEach((c) => checkCondition(reader, c, path));
    else if ('any' in condition) condition.any.forEach((c) => checkCondition(reader, c, path));
    else if ('not' in condition) checkCondition(reader, condition.not, path);
    else if ('approved' in condition) expectKind(condition.approved, 'a review step', (id) => agentOutput(id) === 'review');
    else if ('hasBlocking' in condition) expectKind(condition.hasBlocking, 'a review step', (id) => agentOutput(id) === 'review');
    else if ('checkPassed' in condition) {
      expectKind(condition.checkPassed, 'a check step', (id) => located.get(id)?.step.kind === 'check');
    } else if ('hasQuestions' in condition) {
      expectKind([condition.hasQuestions], 'an implementation step', (id) => agentOutput(id) === 'implementation');
    } else if ('changed' in condition) {
      expectKind([condition.changed], 'a writing step', (id) => {
        const target = located.get(id)?.step;
        return !!target && isWrite(target);
      });
    } else if ('equals' in condition) {
      const { ref, value } = condition.equals;
      if (!ref.field) {
        error(path, 'equals must read a route field.');
        return;
      }
      checkRef(reader, ref, path);
      const target = located.get(ref.step)?.step;
      if (target && (target.kind !== 'agent' || typeof target.output === 'string')) {
        error(path, 'equals can only read a route output, whose fields have a fixed set of values.');
      }
      if (target?.kind === 'agent' && typeof target.output !== 'string') {
        const field = target.output.route.find((f) => f.name === ref.field);
        if (field?.kind === 'enum' && !field.values.includes(value)) {
          error(path, `"${value}" is not one of ${field.values.join(', ')}.`);
        }
        if (field?.kind === 'boolean' && value !== 'true' && value !== 'false') {
          error(path, 'A boolean route field compares with "true" or "false".');
        }
      }
    }
  };

  const countWritesAndChecks = (step: XStep): number => {
    if (step.kind === 'check') return 1;
    if (step.kind === 'agent') return isWrite(step) ? 1 : 0;
    if (step.kind === 'parallel' || step.kind === 'repeat' || step.kind === 'sequence') {
      return step.steps.reduce((n, s) => n + countWritesAndChecks(s), 0);
    }
    return 0;
  };

  for (const entry of located.values()) {
    const { step } = entry;
    const path = `steps.${step.id}`;
    if ('if' in step && step.if) checkCondition(entry, step.if, `${path}.if`);
    if (step.kind === 'repeat') checkCondition(entry, step.until, `${path}.until`);
    if (step.kind === 'parallel' && step.steps.reduce((n, s) => n + countWritesAndChecks(s), 0) > 1) {
      error(path, 'A parallel group may contain at most one writing step or check.');
    }
    if (step.kind === 'agent') {
      const member = members.get(step.member);
      if (!member) error(`${path}.member`, `Unknown member "${step.member}".`);
      else if (step.workspace === 'write' && member.role !== 'implementer') {
        error(`${path}.workspace`, `Only the implementer may write; "${step.member}" is a ${member.role}.`);
      }
      step.task.forEach((block: PromptBlock, i) => {
        if ('from' in block) checkRef(entry, block.from, `${path}.task[${i}]`);
      });
      if (step.task.length === 0) error(`${path}.task`, 'A task needs at least one block.');
    }
    if (step.kind === 'check') {
      const unbounded = unboundedReasons(step.argv);
      if (unbounded.length > 0) error(`${path}.argv`, `Checks must terminate on their own (${unbounded.join(', ')}).`);
      if (!Number.isInteger(step.timeoutMs) || step.timeoutMs <= 0 || step.timeoutMs > limits.maxCheckTimeoutMs) {
        error(`${path}.timeoutMs`, `timeoutMs must be a positive integer up to ${limits.maxCheckTimeoutMs}.`);
      }
      if (context.checkAuthorization) {
        const authorization = authorizeCheckCommand(step.argv, context.checkAuthorization);
        checks.push({ stepId: step.id, argv: step.argv, authorization });
        if (authorization.kind === 'confirm') {
          confirmReasons.push({
            kind: 'check',
            message: `check "${step.id}" needs approval${authorization.highlight ? ' (highlighted)' : ''}`,
          });
        }
      }
    }
  }

  // Upper bound on agent executions: each agent step times the max of its enclosing repeats.
  let agentBound = 0;
  for (const { step, ancestors } of located.values()) {
    if (step.kind !== 'agent') continue;
    agentBound += ancestors.reduce((n, a) => (a.kind === 'repeat' ? n * a.max : n), 1);
  }
  if (agentBound > limits.maxAgentSteps) {
    error('steps', `This workflow could run up to ${agentBound} agent steps; the limit is ${limits.maxAgentSteps}.`);
  }

  // ---- acceptance ----
  const acceptanceIds = new Set<string>();
  const lastWrite = [...located.values()].filter((l) => isWrite(l.step)).reduce((p, l) => Math.max(p, l.position), -1);
  spec.acceptance.forEach((item, i) => {
    const path = `acceptance[${i}]`;
    if (acceptanceIds.has(item.id)) error(`${path}.id`, `Duplicate acceptance id "${item.id}".`);
    acceptanceIds.add(item.id);
    if (item.verify.kind === 'check') {
      const target = located.get(item.verify.step);
      if (target?.step.kind !== 'check') error(`${path}.verify`, `"${item.verify.step}" is not a check step.`);
      else if (target.position < lastWrite && !target.ancestors.some((a) => a.kind === 'repeat')) {
        warnings.push({ path, message: `Check "${item.verify.step}" does not run after the last writing step.` });
      }
    } else if (item.verify.kind === 'review') {
      const memberKey = item.verify.member;
      const member = members.get(memberKey);
      if (!member || member.role !== 'reviewer') {
        error(`${path}.verify`, `"${memberKey}" is not a reviewer.`);
        return;
      }
      const reviews = [...located.values()].filter(
        (l) => l.step.kind === 'agent' && l.step.member === memberKey && agentOutput(l.step.id) === 'review',
      );
      if (reviews.length === 0) error(`${path}.verify`, `"${memberKey}" has no review step.`);
      else if (!reviews.some((r) => r.position > lastWrite || r.ancestors.some((a) => a.kind === 'repeat'))) {
        warnings.push({ path, message: `"${memberKey}" may not review the final version.` });
      }
    }
  });

  if (spec.unsupported.length > 0) {
    confirmReasons.push({ kind: 'unsupported', message: 'the request includes things the workflow cannot do' });
  }

  return { errors, warnings, confirmReasons, checks };
}
