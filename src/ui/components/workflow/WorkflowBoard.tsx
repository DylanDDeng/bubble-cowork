// In-chat view of a workflow a chat session started with start_workflow
// (docs/collaboration/README.md §8). It sits in the conversation where the
// tool was called and uses the subagent board's visuals: one lane per step,
// each lane opens that member's session in the right panel. Plan
// confirmation, questions and the outcome are handled inline.

import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { AgentProvider } from '../../types';
import {
  CURRENT_SESSION_AGENT,
  type WorkflowAction,
  type WorkflowMemberView,
  type WorkflowRunStatus,
  type WorkflowRunView,
  type WorkflowStepView,
} from '../../../shared/workflow';
import { useAppStore } from '../../store/useAppStore';
import { findRunForToolUse, useWorkflowStore } from '../../store/useWorkflowStore';
import { ProviderIcon } from '../AgentModelPicker';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleX,
  LoaderCircle,
  Play,
  ShieldAlert,
  Square,
  Workflow,
  X,
} from '../icons';
import { cn } from '../../utils/cn';

const STATUS_WORD: Record<WorkflowRunStatus, string> = {
  planning: 'planning',
  awaiting_confirmation: 'waiting for you',
  running: 'running',
  pausing: 'pausing',
  paused: 'paused',
  needs_input: 'needs you',
  succeeded: 'done',
  completed_with_gaps: 'done with open items',
  interrupted: 'interrupted',
  cancelling: 'stopping',
  cancelled: 'stopped',
  failed: 'failed',
};

const ACTIVE = new Set<WorkflowRunStatus>(['planning', 'running', 'pausing', 'cancelling']);
const FINISHED = new Set<WorkflowRunStatus>(['succeeded', 'completed_with_gaps', 'cancelled', 'failed']);

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  opencode: 'OpenCode',
  grok: 'Grok',
  pi: 'Pi',
  qoder: 'Qoder',
  bubble: 'Bubble',
  deepseek: 'DeepSeek',
  devin: 'Devin',
};

const NEEDS_TITLE: Record<string, string> = {
  ask: 'A question for you',
  'plan-invalid': 'The plan could not be used',
  'repeat-exhausted': 'The review rounds ran out',
  budget: 'Agent-step limit reached',
  'interrupted-instance': 'A step was interrupted',
  'stop-step': 'The workflow stopped',
  'review-blocked': 'A reviewer could not review',
  'dispute-maintained': 'A disputed finding was kept',
  'unresolved-twice': 'A blocking finding is not getting fixed',
  'no-progress': 'A fix changed nothing',
  'workspace-drift': 'Files changed outside the workflow',
  'final-drift': 'Files changed after the last check',
  'app-restart': 'Aegis was closed during this workflow',
  'parent-moved': 'This chat moved to another folder',
  step: 'A step needs attention',
};

const buttonClass =
  'inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:opacity-50';
const primaryButtonClass =
  'inline-flex h-7 items-center gap-1 rounded-md bg-[var(--text-primary)] px-2.5 text-[12px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50';

/** The run id the start_workflow tool returned, when its result is in. */
function parseRunId(resultText: string | null): string | null {
  if (!resultText) return null;
  try {
    const value = JSON.parse(resultText) as { workflowId?: unknown };
    return typeof value.workflowId === 'string' ? value.workflowId : null;
  } catch {
    return null;
  }
}

export function WorkflowBoard({
  toolUseId,
  resultText,
  failed,
}: {
  toolUseId: string;
  resultText: string | null;
  failed: boolean;
}) {
  const runId = parseRunId(resultText);
  const run = useWorkflowStore((s) => findRunForToolUse(s.runs, toolUseId, runId));
  const loaded = useWorkflowStore((s) => s.loaded);
  useEffect(() => {
    if (!run && !loaded) void useWorkflowStore.getState().load();
  }, [run, loaded]);

  if (failed) {
    return (
      <div className="my-1 flex items-start gap-2 text-[12px] leading-5 text-[var(--text-secondary)]">
        <Workflow className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 break-words">Workflow could not start{resultText ? `: ${resultText}` : ''}</span>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="my-1 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        Starting workflow…
      </div>
    );
  }
  return <RunBoard run={run} />;
}

function RunBoard({ run }: { run: WorkflowRunView }) {
  const [busy, setBusy] = useState(false);
  const perform = async (action: WorkflowAction) => {
    setBusy(true);
    try {
      const result = await useWorkflowStore.getState().act(action);
      if (!result.ok) toast.error(result.error);
    } finally {
      setBusy(false);
    }
  };
  const collapsed = useWorkflowStore((s) => s.collapsed[run.id] === true);
  const toggleCollapsed = () => useWorkflowStore.getState().toggleCollapsed(run.id);
  const members = new Map(run.members.map((m) => [m.key, m]));
  const lanes = laneSteps(run);
  const counts = laneCounts(lanes, FINISHED.has(run.status));

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40" data-workflow-board={run.id}>
      <div
        className={cn(
          'flex cursor-pointer items-center gap-2 bg-[var(--accent-light)] px-2.5 py-1.5',
          !collapsed && 'border-b border-[var(--border)]',
        )}
        onClick={toggleCollapsed}
      >
        <Workflow className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]" title={run.goal}>
          {run.description || run.title}
        </span>
        <span className="flex flex-shrink-0 items-center gap-1 font-mono text-[10.5px] text-[var(--text-muted)]">
          {ACTIVE.has(run.status) ? <LoaderCircle className="h-3 w-3 animate-spin" /> : null}
          {[STATUS_WORD[run.status], ...counts].join(' · ')}
        </span>
        {ACTIVE.has(run.status) && run.status !== 'cancelling' ? (
          <button
            type="button"
            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            title="Stop the workflow"
            aria-label="Stop the workflow"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void perform({ type: 'cancel', runId: run.id, expectedRevision: run.revision });
            }}
          >
            <Square className="h-3 w-3" />
          </button>
        ) : null}
        <button
          type="button"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          title={collapsed ? 'Show steps' : 'Hide steps'}
          aria-label={collapsed ? 'Show steps' : 'Hide steps'}
          aria-expanded={!collapsed}
          data-workflow-toggle
          onClick={(event) => {
            event.stopPropagation();
            toggleCollapsed();
          }}
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', collapsed && '-rotate-90')} />
        </button>
      </div>

      {collapsed ? null : (
        <>
          <div className="divide-y divide-[var(--border)]/60">
            {run.status === 'planning' ? (
              <Lane
                icon={<Workflow className="h-3 w-3 text-[var(--text-muted)]" />}
                label="Planning the workflow"
                state="running"
                sessionId={run.plannerSessionId}
              />
            ) : null}
            {lanes.map((step) => (
              <StepLane
                key={step.key}
                step={step}
                member={step.memberKey ? members.get(step.memberKey) : undefined}
                members={run.members}
                showRound={hasRounds(lanes)}
              />
            ))}
          </div>

          {run.status !== 'awaiting_confirmation' && run.assumptions.length > 0 && run.status !== 'planning' ? (
            <AssumptionsLine assumptions={run.assumptions} />
          ) : null}
          {run.status === 'succeeded' || run.status === 'completed_with_gaps' ? (
            <OutcomeSection run={run} busy={busy} perform={perform} />
          ) : null}
        </>
      )}

      {/* What the user must act on stays visible even when the board is collapsed. */}
      {run.status === 'awaiting_confirmation' ? <PlanSection run={run} busy={busy} perform={perform} /> : null}
      {run.needsInput && (run.status === 'needs_input' || run.status === 'interrupted') ? (
        <NeedsInputSection run={run} busy={busy} perform={perform} />
      ) : null}
      {run.status === 'failed' && run.error ? <Section tone="error">{run.error}</Section> : null}
    </div>
  );
}

/** Agent and check steps that have run or are coming up; skipped and, once finished, unreached steps are left out. */
function laneSteps(run: WorkflowRunView): WorkflowStepView[] {
  return run.steps.filter(
    (step) =>
      (step.kind === 'agent' || step.kind === 'check') &&
      step.state !== 'skipped' &&
      !(step.state === 'pending' && (FINISHED.has(run.status) || run.status === 'awaiting_confirmation' || run.status === 'planning')),
  );
}

function laneCounts(lanes: WorkflowStepView[], finished: boolean): string[] {
  if (finished) return lanes.length ? [`${lanes.length} ${lanes.length === 1 ? 'step' : 'steps'}`] : [];
  const done = lanes.filter((s) => s.state === 'succeeded' || s.state === 'failed').length;
  const running = lanes.filter((s) => s.state === 'running').length;
  return [done ? `${done} done` : null, running ? `${running} running` : null].filter((p): p is string => p !== null);
}

function hasRounds(lanes: WorkflowStepView[]): boolean {
  return lanes.some((s) => (s.iteration?.[s.iteration.length - 1] ?? 0) > 0);
}

/**
 * Short member name for lanes and the plan card. The planner's focus text can
 * be a whole instruction, so it goes in the tooltip; the member key only
 * appears when two members share a provider.
 */
function memberName(member: WorkflowMemberView | undefined, members: WorkflowMemberView[] = []): string {
  if (!member) return 'Check';
  if (member.agent === CURRENT_SESSION_AGENT) return 'This chat';
  const name = PROVIDER_LABEL[member.provider] ?? member.agent;
  const shared = members.some((m) => m.key !== member.key && m.provider === member.provider && m.agent !== CURRENT_SESSION_AGENT);
  return shared ? `${name} (${member.key})` : name;
}

/** Assumptions do not stop the run; they stay available behind one line. */
function AssumptionsLine({ assumptions }: { assumptions: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[var(--border)] px-2.5 py-1 text-[11px] leading-4 text-[var(--text-muted)]">
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-[var(--text-secondary)]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        Assumptions ({assumptions.length})
      </button>
      {open ? (
        <ul className="mt-1 ml-4 list-disc space-y-0.5">
          {assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StepLane({
  step,
  member,
  members,
  showRound,
}: {
  step: WorkflowStepView;
  member?: WorkflowMemberView;
  members: WorkflowMemberView[];
  showRound: boolean;
}) {
  const isCurrent = member?.agent === CURRENT_SESSION_AGENT;
  const approvals = useAppStore((s) => (step.sessionId && !isCurrent ? s.sessions[step.sessionId]?.permissionRequests?.length ?? 0 : 0));
  const round = step.iteration ? step.iteration[step.iteration.length - 1] + 1 : null;
  // Agent step labels read "<member> · <output>"; the lane already names the member.
  const what = step.kind === 'check' ? step.label : step.phase ?? step.label.split(' · ').pop() ?? step.label;
  return (
    <Lane
      icon={member ? <ProviderIcon provider={member.provider as AgentProvider} /> : <CircleDashed className="h-3 w-3 text-[var(--text-muted)]" />}
      label={`${memberName(member, members)} · ${what}${showRound && round ? ` · round ${round}` : ''}`}
      title={[member?.focus, step.summary].filter(Boolean).join('\n') || undefined}
      state={step.state}
      verdict={step.verdict}
      approvals={approvals}
      // The chat's own turns are already in this conversation.
      sessionId={isCurrent ? null : step.sessionId}
    />
  );
}

function Lane({
  icon,
  label,
  title,
  state,
  verdict,
  approvals = 0,
  sessionId,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  state: WorkflowStepView['state'];
  verdict?: string | null;
  approvals?: number;
  sessionId: string | null;
}) {
  const clickable = Boolean(sessionId);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => sessionId && useAppStore.getState().openWorkflowMemberPanel(sessionId)}
      title={title ? `${label}\n${title}` : label}
      className={cn(
        'group flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left text-[12px] leading-5 transition-colors',
        clickable ? 'cursor-pointer' : 'cursor-default',
        state === 'pending' && 'opacity-55',
      )}
    >
      <span
        className={cn(
          'flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-secondary)]/60 py-0.5 pl-1.5 pr-2.5 transition-colors',
          clickable && 'group-hover:border-[var(--text-muted)]/45 group-hover:bg-[var(--bg-tertiary)]/60',
        )}
      >
        <span className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 truncate text-[12px] leading-4 text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]">
          {label}
        </span>
      </span>
      {approvals > 0 ? (
        <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,#d97706_20%,transparent)] px-1.5 text-[11px] text-[var(--text-primary)]">
          <ShieldAlert className="h-3 w-3" /> needs approval
        </span>
      ) : null}
      <LaneStatusWord state={state} verdict={verdict ?? null} />
    </button>
  );
}

function LaneStatusWord({ state, verdict }: { state: WorkflowStepView['state']; verdict: string | null }) {
  if (state === 'running') {
    return (
      <span className="flex flex-shrink-0 items-center gap-1 text-[11px] text-[var(--text-muted)]/80">
        <LoaderCircle className="h-3 w-3 flex-shrink-0 animate-spin text-[var(--text-muted)]/55" />
        running
      </span>
    );
  }
  const word =
    state === 'pending'
      ? 'waiting'
      : state === 'needs_input'
        ? 'needs you'
        : verdict
          ? verdict.replace('_', ' ')
          : state === 'failed'
            ? 'failed'
            : 'finished';
  return <span className="flex-shrink-0 text-[11px] text-[var(--text-muted)]/80">{word}</span>;
}

function Section({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'error'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 border-t border-[var(--border)] px-2.5 py-2 text-[12px] leading-5',
        tone === 'warning' && 'bg-[color-mix(in_srgb,#d97706_7%,transparent)]',
        tone === 'error' && 'bg-[color-mix(in_srgb,#dc2626_7%,transparent)] text-[var(--text-primary)]',
        tone === 'info' && 'text-[var(--text-secondary)]',
      )}
    >
      {children}
    </div>
  );
}

type Perform = (action: WorkflowAction) => Promise<void>;

function PlanSection({ run, busy, perform }: { run: WorkflowRunView; busy: boolean; perform: Perform }) {
  return (
    <Section tone="warning">
      <div className="font-medium text-[var(--text-primary)]">Start this workflow?</div>
      <ul className="flex flex-col gap-0.5">
        {run.members
          .filter((m) => m.agent !== CURRENT_SESSION_AGENT)
          .map((m) => (
            <li key={m.key} className="flex items-center gap-1.5">
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
                <ProviderIcon provider={m.provider as AgentProvider} />
              </span>
              <span className="text-[var(--text-primary)]" title={m.focus ?? undefined}>
                {memberName(m, run.members)}
              </span>
              <span className="text-[var(--text-muted)]">{m.role === 'implementer' ? 'writes code' : `${m.role}, read-only`}</span>
              {m.source === 'inferred' ? <span className="text-[11px] text-[var(--text-muted)]">· suggested</span> : null}
              {m.unverified ? <span className="text-[11px] text-[var(--text-muted)]">· not yet conformance-tested</span> : null}
            </li>
          ))}
      </ul>
      {run.checks.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-[var(--text-muted)]">Commands it will run</span>
          {run.checks.map((c) => (
            <code
              key={c.stepId}
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-primary)]',
                c.highlight ? 'bg-[color-mix(in_srgb,#dc2626_14%,transparent)]' : 'bg-[var(--bg-tertiary)]/70',
              )}
              title={c.reasons.join(', ') || undefined}
            >
              {c.argv.join(' ')}
            </code>
          ))}
        </div>
      ) : null}
      {run.unsupported.length > 0 ? (
        <div className="flex items-start gap-1.5 text-[var(--text-primary)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[#d97706]" />
          <span>Not covered: {run.unsupported.join('; ')}</span>
        </div>
      ) : null}
      {run.assumptions.length > 0 ? <div>Assumes: {run.assumptions.join('; ')}</div> : null}
      {run.spec ? (
        <details>
          <summary className="cursor-pointer select-none text-[var(--text-muted)]">View workflow JSON</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-[var(--bg-tertiary)]/70 p-2 font-mono text-[10.5px] leading-4 text-[var(--text-primary)]">
            {JSON.stringify(run.spec, null, 2)}
          </pre>
        </details>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy}
          onClick={() => void perform({ type: 'confirm', runId: run.id, expectedRevision: run.revision })}
        >
          <Play className="h-3 w-3" /> Start
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void perform({ type: 'cancel', runId: run.id, expectedRevision: run.revision })}
        >
          <X className="h-3 w-3" /> Cancel
        </button>
        {run.checks.length > 0 ? <span className="text-[11px] text-[var(--text-muted)]">Starting approves these commands for this run.</span> : null}
      </div>
    </Section>
  );
}

function NeedsInputSection({ run, busy, perform }: { run: WorkflowRunView; busy: boolean; perform: Perform }) {
  const needs = run.needsInput!;
  const [text, setText] = useState('');
  const drift = needs.reason === 'workspace-drift' || needs.reason === 'final-drift';
  return (
    <Section tone="warning">
      <div className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
        <AlertTriangle className="h-3.5 w-3.5 text-[#d97706]" />
        {NEEDS_TITLE[needs.reason] ?? 'The workflow needs you'}
      </div>
      {needs.question ? <div className="text-[var(--text-primary)]">{needs.question}</div> : null}
      {drift ? (
        <div>
          Files no longer match the version the workflow expected. Using the current files continues with those edits included; they
          will be checked and reviewed too.
        </div>
      ) : needs.detail ? (
        <div className="whitespace-pre-wrap break-words">{needs.detail}</div>
      ) : null}
      {needs.reason === 'ask' && needs.options.length === 0 ? (
        <div className="flex items-center gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[12px] text-[var(--text-primary)]"
          />
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy || !text.trim()}
            onClick={() => void perform({ type: 'answer', runId: run.id, expectedRevision: run.revision, text })}
          >
            Answer
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {needs.options.map((o, index) => (
            <button
              key={o.id}
              type="button"
              className={index === 0 ? primaryButtonClass : buttonClass}
              disabled={busy}
              onClick={() =>
                void perform(
                  needs.reason === 'ask'
                    ? { type: 'answer', runId: run.id, expectedRevision: run.revision, text: o.label }
                    : { type: 'answer', runId: run.id, expectedRevision: run.revision, optionId: o.id },
                )
              }
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

function OutcomeSection({ run, busy, perform }: { run: WorkflowRunView; busy: boolean; perform: Perform }) {
  if (run.acceptance.length === 0) return null;
  return (
    <Section>
      {run.acceptance.map((a) => (
        <div key={a.id} className="flex items-center gap-1.5">
          {a.status === 'satisfied' ? (
            <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--success,#16a34a)]" />
          ) : a.status === 'manual' ? (
            <CircleDashed className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
          ) : (
            <CircleX className="h-3.5 w-3.5 flex-shrink-0 text-[#dc2626]" />
          )}
          <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{a.description}</span>
          {a.status === 'manual' ? (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void perform({ type: 'verify-manual', runId: run.id, acceptanceId: a.id })}
            >
              Mark verified
            </button>
          ) : a.status === 'waived' ? (
            <span className="text-[11px] text-[var(--text-muted)]">waived</span>
          ) : a.status !== 'satisfied' ? (
            <span className="text-[11px] text-[var(--text-muted)]">not met</span>
          ) : null}
        </div>
      ))}
    </Section>
  );
}
