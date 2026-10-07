// Acceptance judgement (plan §6.4): a requirement counts only with evidence
// bound to the final version R(n). A check must have passed on R(n) without
// changing it; a review must be an approval of R(n) by the named member.

import type { ReviewResult } from '../spec/results';
import type { WorkflowSpec } from '../spec/workflow-spec';
import type { InstanceRecord, Version } from './engine';

export type AcceptanceStatus = {
  id: string;
  description: string;
  kind: 'check' | 'review' | 'manual';
  status: 'satisfied' | 'unsatisfied' | 'manual';
  evidenceKey?: string;
};

export function evaluateAcceptance(
  spec: Pick<WorkflowSpec, 'acceptance'>,
  records: InstanceRecord[],
  finalVersion: Version,
): AcceptanceStatus[] {
  const settled = records.filter((r) => r.state === 'settled');
  return spec.acceptance.map((item): AcceptanceStatus => {
    const base = { id: item.id, description: item.description, kind: item.verify.kind };
    if (item.verify.kind === 'manual') return { ...base, status: 'manual' };
    let evidence: InstanceRecord | undefined;
    if (item.verify.kind === 'check') {
      const stepId = item.verify.step;
      evidence = settled.find(
        (r) => r.kind === 'check' && r.stepId === stepId && r.passed === true && r.versionIn === finalVersion,
      );
    } else {
      const member = item.verify.member;
      evidence = settled.find(
        (r) =>
          r.outputKind === 'review' &&
          r.member === member &&
          r.versionIn === finalVersion &&
          (r.output as ReviewResult | undefined)?.verdict === 'approved',
      );
    }
    return evidence
      ? { ...base, status: 'satisfied', evidenceKey: evidence.key }
      : { ...base, status: 'unsatisfied' };
  });
}
