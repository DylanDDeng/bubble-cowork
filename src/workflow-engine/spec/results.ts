// Structured results agent steps return, and the consistency rules the Host
// enforces on them regardless of how a workflow is composed (plan §6.6).

export type Severity = 'blocking' | 'advisory';

export type ImplementationReport = {
  schemaVersion: 1;
  status: 'completed' | 'blocked';
  summary: string;
  changes: Array<{ file: string; description: string }>;
  selfReportedChecks?: Array<{ command: string; outcome: 'passed' | 'failed' | 'not_run' }>;
  findingResponses?: Array<{ findingId: string; action: 'fixed' | 'disputed'; note: string }>;
  questions?: Array<{ to?: string; question: string }>;
  blockers: string[];
};

export type ReviewFinding = {
  /** Assigned by the Host after validation; the model's own id is not trusted. */
  findingId?: string;
  id: string;
  severity: Severity;
  category: string;
  file?: string;
  line?: number;
  reason: string;
  suggestedFix?: string;
  supersedes?: string;
  missedReason?: string;
};

export type ReviewResult = {
  schemaVersion: 1;
  verdict: 'approved' | 'changes_requested' | 'blocked';
  summary: string;
  findings: ReviewFinding[];
  previousFindings?: Array<{ findingId: string; status: 'resolved' | 'unresolved' | 'withdrawn'; note?: string }>;
  blockers: string[];
};

export type Notes = {
  schemaVersion: 1;
  summary: string;
  details: string;
  references?: Array<{ file: string; line?: number }>;
};

export type RouteResult = Record<string, string | boolean>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

export function validateImplementationReport(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['Implementation report must be an object.'];
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (value.status !== 'completed' && value.status !== 'blocked') errors.push('status must be "completed" or "blocked".');
  if (!isString(value.summary)) errors.push('summary must be a string.');
  if (!Array.isArray(value.changes) || !value.changes.every((c) => isObject(c) && isString(c.file) && isString(c.description))) {
    errors.push('changes must be a list of { file, description }.');
  }
  if (!isStringArray(value.blockers)) errors.push('blockers must be a list of strings.');
  else if (value.status === 'completed' && value.blockers.length > 0) {
    errors.push('A completed report must not list blockers.');
  }
  if (value.findingResponses !== undefined) {
    const ok =
      Array.isArray(value.findingResponses) &&
      value.findingResponses.every(
        (r) => isObject(r) && isString(r.findingId) && (r.action === 'fixed' || r.action === 'disputed') && isString(r.note),
      );
    if (!ok) errors.push('findingResponses must be a list of { findingId, action: fixed|disputed, note }.');
  }
  if (value.questions !== undefined) {
    const ok =
      Array.isArray(value.questions) &&
      value.questions.every((q) => isObject(q) && isString(q.question) && (q.to === undefined || isString(q.to)));
    if (!ok) errors.push('questions must be a list of { question, to? }.');
  }
  return errors;
}

/**
 * @param previousBlockingIds Host-assigned ids of the blocking findings from
 *   this reviewer's previous round; a re-review must account for each one.
 */
export function validateReviewResult(value: unknown, previousBlockingIds: string[] = []): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['Review result must be an object.'];
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  const verdict = value.verdict;
  if (verdict !== 'approved' && verdict !== 'changes_requested' && verdict !== 'blocked') {
    errors.push('verdict must be approved, changes_requested or blocked.');
  }
  if (!isString(value.summary)) errors.push('summary must be a string.');
  if (!isStringArray(value.blockers)) errors.push('blockers must be a list of strings.');
  const findings = Array.isArray(value.findings) ? value.findings : null;
  if (!findings) errors.push('findings must be a list.');
  let blocking = 0;
  findings?.forEach((f, i) => {
    if (!isObject(f) || !isString(f.id) || !isString(f.category) || !isString(f.reason)) {
      errors.push(`findings[${i}] must have id, category and reason.`);
      return;
    }
    if (f.severity !== 'blocking' && f.severity !== 'advisory') errors.push(`findings[${i}].severity is invalid.`);
    if (f.severity === 'blocking') blocking += 1;
  });
  const blockers = isStringArray(value.blockers) ? value.blockers : [];
  if (verdict === 'approved' && (blocking > 0 || blockers.length > 0)) {
    errors.push('An approved review must not contain blocking findings or blockers.');
  }
  if (verdict === 'changes_requested' && blocking === 0) {
    errors.push('changes_requested requires at least one blocking finding.');
  }
  if (previousBlockingIds.length > 0) {
    const previous = Array.isArray(value.previousFindings) ? value.previousFindings : [];
    const covered = new Set(
      previous.filter((p) => isObject(p) && isString(p.findingId)).map((p) => (p as { findingId: string }).findingId),
    );
    const missing = previousBlockingIds.filter((id) => !covered.has(id));
    if (missing.length > 0) {
      errors.push(`previousFindings must give a status for every earlier blocking finding (missing: ${missing.join(', ')}).`);
    }
    for (const p of previous) {
      if (!isObject(p) || !['resolved', 'unresolved', 'withdrawn'].includes(p.status as string)) {
        errors.push('previousFindings entries must have status resolved, unresolved or withdrawn.');
        break;
      }
    }
  }
  return errors;
}

export function validateNotes(value: unknown): string[] {
  if (!isObject(value)) return ['Notes must be an object.'];
  const errors: string[] = [];
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (!isString(value.summary)) errors.push('summary must be a string.');
  if (!isString(value.details)) errors.push('details must be a string.');
  return errors;
}

export function validateRouteResult(
  value: unknown,
  fields: Array<{ name: string; kind: 'enum'; values: string[] } | { name: string; kind: 'boolean' }>,
): string[] {
  if (!isObject(value)) return ['Route result must be an object.'];
  const errors: string[] = [];
  for (const field of fields) {
    const got = value[field.name];
    if (field.kind === 'boolean') {
      if (typeof got !== 'boolean') errors.push(`${field.name} must be true or false.`);
    } else if (!isString(got) || !field.values.includes(got)) {
      errors.push(`${field.name} must be one of: ${field.values.join(', ')}.`);
    }
  }
  return errors;
}
