import { Check, ListChecks, Loader2 } from 'lucide-react';
import type { PlanStep, PlanStepStatus } from '../types';

function StepStatusIcon({ status }: { status: PlanStepStatus }) {
  if (status === 'completed') {
    return <Check className="h-3 w-3" />;
  }
  if (status === 'inProgress') {
    return <Loader2 className="h-3 w-3 animate-spin" />;
  }
  return <span className="block h-[7px] w-[7px] rounded-full border border-current" />;
}

export function CodexActivePlanCard({
  explanation,
  steps,
}: {
  explanation?: string | null;
  steps: PlanStep[];
}) {
  if (steps.length === 0) {
    return null;
  }

  const completedCount = steps.filter((step) => step.status === 'completed').length;
  const stepOccurrenceCount = new Map<string, number>();

  return (
    <div className="mx-auto mb-0 w-full max-w-[760px] px-3">
      <div className="overflow-hidden rounded-t-[var(--radius-xl)] border border-b-0 border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
            <ListChecks className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">
              {completedCount} out of {steps.length} tasks completed
            </span>
          </div>
          <span className="flex-shrink-0 rounded-md bg-[var(--accent-light)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]">
            Plan
          </span>
        </div>

        {explanation ? (
          <p className="border-t border-[var(--border)]/60 px-3 py-2 text-[12px] leading-5 text-[var(--text-secondary)]">
            {explanation}
          </p>
        ) : null}

        <ol className="space-y-0 px-3 pb-2">
          {steps.map((step, index) => {
            const occurrence = (stepOccurrenceCount.get(step.step) ?? 0) + 1;
            stepOccurrenceCount.set(step.step, occurrence);

            return (
              <li key={`${step.step}:${occurrence}`} className="flex items-start gap-2 py-1">
                <div
                  className={`mt-[3px] flex min-w-0 flex-shrink-0 items-center gap-1.5 text-[12px] ${
                    step.status === 'completed'
                      ? 'text-[var(--text-muted)]/55'
                      : step.status === 'inProgress'
                        ? 'text-[var(--text-primary)]/85'
                        : 'text-[var(--text-secondary)]/70'
                  }`}
                >
                  <span className="flex h-3.5 w-3.5 items-center justify-center">
                    <StepStatusIcon status={step.status} />
                  </span>
                  <span className="tabular-nums">{index + 1}.</span>
                </div>
                <p
                  className={`min-w-0 flex-1 text-[13px] leading-5 ${
                    step.status === 'completed'
                      ? 'text-[var(--text-muted)]/55 line-through'
                      : 'text-[var(--text-primary)]/85'
                  }`}
                >
                  {step.step}
                </p>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
