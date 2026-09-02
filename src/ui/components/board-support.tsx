import { Check, CircleX, Clock, Loader2 } from './icons';
import { PROVIDERS } from '../utils/provider';
import { formatClaudeModelLabel } from '../utils/claude-model';
import { formatCodexModelLabel } from '../utils/codex-model';
import type { BoardStage, BoardTask } from '../store/useBoardStore';
import type { AgentProvider, SessionView } from '../types';

export const STAGE_META: Record<BoardStage, { label: string }> = {
  backlog: { label: 'Backlog' },
  todo: { label: 'Todo' },
  working: { label: 'Working' },
  review: { label: 'Review' },
  done: { label: 'Done' },
  canceled: { label: 'Canceled' },
};

const PIE_CIRCUMFERENCE = 2 * Math.PI * 2.5;

/** Linear-style pie inside the stage ring: a thick-stroked arc reads as a wedge. */
function StagePie({ fraction }: { fraction: number }) {
  return (
    <circle
      cx="7"
      cy="7"
      r="2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="5"
      strokeDasharray={`${fraction * PIE_CIRCUMFERENCE} ${PIE_CIRCUMFERENCE}`}
      transform="rotate(-90 7 7)"
    />
  );
}

/**
 * Linear-style stage icons: a dashed ring for Backlog, an empty ring for
 * Todo, a partially filled pie for Working, a nearly full pie for Review, a
 * solid check disc for Done, and a muted X disc for Canceled. Color is part
 * of the stage's identity, so it lives here, not at call sites.
 */
export function StageIcon({ stage, className = 'h-3.5 w-3.5' }: { stage: BoardStage; className?: string }) {
  if (stage === 'done') {
    return (
      <svg viewBox="0 0 14 14" className={`${className} flex-shrink-0 text-[var(--accent)]`} aria-hidden="true">
        <circle cx="7" cy="7" r="6.5" fill="currentColor" />
        <path
          d="M4.4 7.3l1.75 1.75L9.7 5.4"
          fill="none"
          stroke="var(--accent-foreground)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (stage === 'canceled') {
    return (
      <svg viewBox="0 0 14 14" className={`${className} flex-shrink-0 text-[var(--text-muted)]`} aria-hidden="true">
        <circle cx="7" cy="7" r="6.5" fill="currentColor" />
        <path
          d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2"
          fill="none"
          stroke="var(--bg-primary)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  const color =
    stage === 'working'
      ? 'text-[var(--warning)]'
      : stage === 'review'
        ? 'text-[var(--success)]'
        : 'text-[var(--text-muted)]';
  return (
    <svg viewBox="0 0 14 14" className={`${className} flex-shrink-0 ${color}`} aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="5.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={stage === 'backlog' ? '2 1.6' : undefined}
      />
      {stage === 'working' ? <StagePie fraction={0.5} /> : null}
      {stage === 'review' ? <StagePie fraction={0.75} /> : null}
    </svg>
  );
}

export type RunState = 'working' | 'permission' | 'failed' | 'ready';

/**
 * The live badge on a card. Derived, never stored: the column is where YOU
 * put the task; this is what the agent is doing right now.
 */
export function deriveRunState(task: BoardTask, session: SessionView | null): RunState | null {
  if (session) {
    if (session.status === 'running' || session.status === 'stopping') {
      return session.permissionRequests.length > 0 ? 'permission' : 'working';
    }
    if (session.status === 'error' || session.runtimeNotice === 'error') return 'failed';
  }
  if (task.stage === 'review') return 'ready';
  return null;
}

export function projectName(projectCwd: string | null): string {
  if (!projectCwd) return 'No Project';
  const parts = projectCwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || projectCwd;
}

export function providerLabel(provider: AgentProvider | undefined): string | null {
  if (!provider) return null;
  return PROVIDERS.find((entry) => entry.id === provider)?.label || provider;
}

/**
 * The model name shown next to the agent icon, like the chat composer.
 * Claude/Codex have dedicated pretty-printers; everything else falls back to
 * the id's last path/scope segment — a generic rule, not a model list.
 */
export function modelDisplayLabel(
  provider: AgentProvider | undefined,
  model: string | undefined
): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  if (provider === 'claude') return formatClaudeModelLabel(trimmed);
  if (provider === 'codex') return formatCodexModelLabel(trimmed);
  return trimmed.split(/[:/]/).pop() || trimmed;
}

export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export function RunBadge({ state }: { state: RunState }) {
  if (state === 'working') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
        <Loader2 className="h-3 w-3 animate-spin text-[var(--text-muted)]" />
        Working
      </span>
    );
  }
  if (state === 'permission') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--warning)]">
        <Clock className="h-3 w-3" />
        Needs permission
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--error)]">
        <CircleX className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--success)]">
      <Check className="h-3 w-3" />
      Ready for review
    </span>
  );
}

export function SessionRunStatus({ session }: { session: SessionView }) {
  if (session.status === 'running' || session.status === 'stopping') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)]">
        <Loader2 className="h-2.5 w-2.5 animate-spin text-[var(--text-muted)]" />
        Working
      </span>
    );
  }
  if (session.status === 'error') {
    return <span className="text-[11px] font-medium text-[var(--error)]">Failed</span>;
  }
  if (session.status === 'completed') {
    return <span className="text-[11px] font-medium text-[var(--success)]">Completed</span>;
  }
  return <span className="text-[11px] font-normal text-[var(--text-muted)]">Idle</span>;
}
