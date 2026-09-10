import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  goalCanResume,
  supportsGoalUI,
  goalStatusLabel,
  type GoalAction,
  type ThreadGoal,
} from '../../shared/session-goal';
import { useSessionGoal } from '../hooks/useSessionGoal';
import { useAppStore } from '../store/useAppStore';
import { Target, X, Play, Pause, Pencil, RotateCcw } from './icons';
import * as Dialog from './ui/dialog';
import './session-goal.css';

export function GoalModePill({ onExit, disabled }: { onExit: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="goal-mode-pill"
      title="Clear goal"
      aria-label="Clear goal mode"
      disabled={disabled}
      onClick={onExit}
    >
      <span className="goal-mode-icon">
        <Target className="goal-icon" />
        <X className="goal-icon goal-mode-close" />
      </span>
      <span>Goal</span>
    </button>
  );
}

function formatElapsed(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}

export function SessionGoal({
  sessionId,
  goal,
  onChange,
  resumeConfirmation,
  onDismissResume,
}: {
  sessionId: string;
  goal: ThreadGoal;
  onChange: (action: GoalAction) => Promise<unknown>;
  resumeConfirmation?: boolean;
  onDismissResume: () => void;
}) {
  const objective = goal.displayObjective ?? goal.objective;
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setNow(Date.now());
    if (goal.status !== 'active' || goal.claude) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [goal.status, goal.updatedAt, goal.claude]);
  const elapsed =
    goal.timeUsedSeconds +
    (goal.status === 'active' ? Math.max(0, now / 1000 - goal.updatedAt) : 0);
  const number = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const checks = goal.claude
    ? `${goal.claude.iterations} ${goal.claude.iterations === 1 ? 'check' : 'checks'}`
    : undefined;
  const hasCompletedDuration = goal.status === 'complete'
    && Number.isFinite(goal.timeUsedSeconds) && goal.timeUsedSeconds > 0;
  const progress = checks && !hasCompletedDuration
    ? checks
    : goal.tokenBudget != null && (goal.status === 'active' || goal.status === 'budgetLimited')
      ? `${number.format(goal.tokensUsed)} / ${number.format(goal.tokenBudget)}`
      : formatElapsed(elapsed);
  const summaryTitle = [
    objective,
    checks,
    goal.claude?.lastReason ? `Last check: ${goal.claude.lastReason}` : undefined,
  ].filter(Boolean).join('\n\n');
  const edit = () => useAppStore.getState().setActiveRightUtilityTab(`goal:${sessionId}`);
  const mutate = async (action: GoalAction) => {
    if (busy) return;
    setBusy(true);
    try {
      await onChange(action);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update goal');
    } finally {
      setBusy(false);
    }
  };
  const resumable = goalCanResume(goal.status);
  return (
    <>
      <div
        className="session-goal-row"
        data-status={goal.status}
        aria-label="Task goal"
        aria-busy={busy}
      >
        <button
          type="button"
          className="session-goal-summary"
          onClick={edit}
          disabled={busy || goal.status === 'complete'}
          title={summaryTitle}
          aria-label="Edit goal"
        >
          <Target className="goal-icon session-goal-symbol" aria-hidden="true" />
          <span className="session-goal-status">{goalStatusLabel(goal.status)}</span>
          <span className="session-goal-objective">{objective}</span>
          <span className="session-goal-progress">· {progress}</span>
        </button>
        <div className="session-goal-actions">
          <button
            type="button"
            className="goal-icon-button"
            title="Clear goal"
            aria-label="Clear goal"
            disabled={busy}
            onClick={() => void mutate({ type: 'clear' })}
          >
            <X className="goal-icon" />
          </button>
          {goal.status === 'active' || resumable ? (
            <button
              type="button"
              className="goal-icon-button"
              title={resumable ? 'Resume goal' : 'Pause goal'}
              aria-label={resumable ? 'Resume goal' : 'Pause goal'}
              disabled={busy}
              onClick={() => void mutate({ type: 'set', status: resumable ? 'active' : 'paused' })}
            >
              {resumable ? <Play className="goal-icon" /> : <Pause className="goal-icon" />}
            </button>
          ) : null}
          {goal.status !== 'complete' && (
            <button
              type="button"
              className="goal-icon-button"
              title="Edit goal"
              aria-label="Open goal editor"
              disabled={busy}
              onClick={edit}
            >
              <Pencil className="goal-icon" />
            </button>
          )}
        </div>
      </div>
      <Dialog.Root
        open={!!resumeConfirmation && resumable}
        onOpenChange={(open) => {
          if (!open) onDismissResume();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="goal-confirm-overlay" />
          <Dialog.Content className="goal-confirm-dialog">
            <Dialog.Title>
              {goal.status === 'paused' ? 'Resume paused goal?' : 'Resume goal?'}
            </Dialog.Title>
            <Dialog.Description>
              The agent will keep working toward this goal when the chat is idle.
            </Dialog.Description>
            <div className="goal-confirm-objective">{objective}</div>
            <footer>
              <button className="goal-confirm-cancel" onClick={onDismissResume}>
                {goal.status === 'paused' ? 'Keep paused' : 'Not now'}
              </button>
              <button
                className="goal-save-button"
                disabled={busy}
                onClick={() => {
                  onDismissResume();
                  void mutate({ type: 'set', status: 'active' });
                }}
              >
                Resume goal
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/** A normal utility tab: resizing it makes room in the conversation layout. */
export function GoalEditorPanel({ sessionId, hidden }: { sessionId: string; hidden?: boolean }) {
  const session = useAppStore((state) => state.sessions[sessionId]);
  const { goal, snapshot, change } = useSessionGoal(sessionId, supportsGoalUI(session?.provider));
  const objective = goal?.displayObjective ?? goal?.objective ?? '';
  const [draft, setDraft] = useState(objective);
  const [saved, setSaved] = useState(objective);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const close = () => useAppStore.getState().closeRightUtilityTab(`goal:${sessionId}`);
  useEffect(() => {
    if (snapshot && (!goal || goal.status === 'complete')) close();
  }, [snapshot, goal]);
  useEffect(() => {
    if (!busy && objective !== saved) {
      // A different objective arrived outside this editor. Codex closes its
      // Goal tab rather than allowing a stale draft to replace the new goal.
      if (saved) close();
      else {
        setSaved(objective);
        setDraft(objective);
      }
    }
  }, [objective, busy, saved]);
  useEffect(() => {
    if (hidden) return;
    textarea.current?.focus();
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hidden]);
  const save = async () => {
    if (!draft.trim() || draft.trim() === saved || busy) return;
    setBusy(true);
    try {
      await change(
        { type: 'set', objective: draft.trim(), status: 'active' },
        {
          model: session?.model,
          claudeAccessMode: session?.claudeAccessMode,
          claudeReasoningEffort: session?.claudeReasoningEffort,
          codexReasoningEffort: session?.codexReasoningEffort,
          codexPermissionMode: session?.codexPermissionMode,
          codexFastMode: session?.codexFastMode,
        },
      );
      setSaved(draft.trim());
      if (session?.provider === 'claude') useAppStore.getState().setSessionClaudeMode(sessionId, session.claudeAccessMode || 'default', 'execute');
      else useAppStore.getState().setSessionCodexExecutionMode(sessionId, 'execute');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update goal');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="goal-editor-panel" hidden={hidden} aria-label="Goal editor">
      <textarea
        ref={textarea}
        className="goal-editor-text"
        aria-label="Goal"
        placeholder="Goal"
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void save();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
      />
      <footer className="goal-editor-footer">
        <span>
          {!goal || now - goal.updatedAt * 1000 < 60_000
            ? 'Updated just now'
            : `Updated ${Math.floor((now - goal.updatedAt * 1000) / 60_000)} min ago`}
        </span>
        <button
          type="button"
          className="goal-icon-button"
          title="Revert"
          aria-label="Revert goal changes"
          disabled={draft === saved || busy}
          onClick={() => setDraft(saved)}
        >
          <RotateCcw className="goal-icon" />
        </button>
        <button
          type="button"
          className="goal-save-button"
          disabled={!draft.trim() || draft.trim() === saved || busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </section>
  );
}
