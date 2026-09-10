import { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import type { ServerEvent } from '../../shared/types';
import {
  validateGoalAction,
  type GoalAction,
  type GoalSettings,
  type SessionGoalSnapshot,
  type ThreadGoal,
} from '../../shared/session-goal';
import { ipcMainHandle } from '../util';
import { getProviderService } from '../libs/provider/service';
import { CodexAdapter } from '../libs/provider/codex-adapter';
import { CodexRpcError } from '../libs/provider/codex-app-server-manager';
import * as sessions from '../libs/session-store';
import { onClaudeGoalChanged, readClaudeGoalState } from '../libs/claude-goal-manager';

const snapshots = new Map<string, SessionGoalSnapshot>();
const changes = new Map<string, Promise<unknown>>();
const startingFailures = new Map<string, (error: Error) => void>();
const pendingObjectives = new Map<string, string>();
let revision = 0;
export function rejectSessionGoalStart(sessionId: string, error: Error) {
  startingFailures.get(sessionId)?.(error);
}
let emit: (event: ServerEvent) => void = () => {};

function enqueueChange<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const operation = (changes.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(run);
  changes.set(sessionId, operation);
  const cleanup = () => {
    if (changes.get(sessionId) === operation) changes.delete(sessionId);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

export function getCachedSessionGoal(sessionId: string) {
  return snapshots.get(sessionId);
}

export function publishSessionGoal(
  sessionId: string,
  goal: ThreadGoal | null,
  supported = true,
  resumeConfirmation = false,
): SessionGoalSnapshot {
  const previous = snapshots.get(sessionId);
  const pending = pendingObjectives.get(sessionId);
  if (pending && (goal?.displayObjective ?? goal?.objective) === pending) {
    pendingObjectives.delete(sessionId);
    const prompt = `/goal ${pending}`;
    const createdAt = Date.now();
    sessions.updateLastPrompt(sessionId, prompt);
    sessions.addMessage(sessionId, { type: 'user_prompt', prompt, createdAt });
    emit({ type: 'stream.user_prompt', payload: { sessionId, prompt, createdAt } });
  }
  const snapshot: SessionGoalSnapshot = {
    sessionId,
    supported,
    goal,
    revision: ++revision,
    completedGoal: goal?.status === 'complete' ? goal : goal ? null : previous?.completedGoal,
    resumeConfirmation:
      resumeConfirmation ||
      (goal && previous?.goal?.objective === goal.objective && previous.goal.status === goal.status
        ? previous.resumeConfirmation
        : false),
  };
  snapshots.set(sessionId, snapshot);
  if (goal?.status === 'complete' && previous?.completedGoal !== goal) {
    // Keep completion in the transcript, independent of the mutable current
    // goal. A stable UUID makes rehydration/repeated native events an upsert.
    const uuid = 'goal-completed:' + createHash('sha256')
      .update(JSON.stringify([sessionId, goal.createdAt, goal.objective])).digest('hex');
    const stored = sessions.getStoredMessage(sessionId, uuid);
    // Live notification arrives after the answer; persisted/native snapshots
    // may use whole-second timestamps, so include that second when backfilling.
    const wasPursuing = previous?.goal?.createdAt === goal.createdAt
      && previous.goal.objective === goal.objective && previous.goal.status === 'active';
    const end = wasPursuing ? Date.now()
      : goal.claude ? goal.updatedAt * 1000 : Math.floor(goal.updatedAt + 1) * 1000 - 1;
    const afterMessageId = (stored?.type === 'goal_completed' ? stored.afterMessageId : undefined)
      ?? sessions.findGoalCompletionAnswer(sessionId, goal.createdAt * 1000, end);
    const message = {
      type: 'goal_completed' as const,
      uuid,
      afterMessageId,
      goal,
      createdAt: goal.updatedAt * 1000,
    };
    sessions.addMessage(sessionId, message);
    emit({ type: 'stream.message', payload: { sessionId, message } });
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('session-goal-changed', snapshot);
  }
  if (!goal?.claude && !previous?.goal?.claude && goal?.status !== 'active' && previous?.goal?.status === 'active') {
    const adapter = getProviderService().getAdapter('codex');
    // Pause allows the current turn to finish; its normal result owns status.
    if (!(adapter instanceof CodexAdapter && adapter.hasActiveGoalTurn(sessionId))) {
      sessions.updateSessionStatus(sessionId, 'completed');
      emit({ type: 'session.status', payload: { sessionId, status: 'completed' } });
    }
  }
  if (!goal?.claude && goal?.status === 'complete' && previous?.completedGoal?.updatedAt !== goal.updatedAt) {
    // Share the mutation queue with replacement/clear so an old completion
    // cannot erase a subsequently submitted objective.
    void enqueueChange(sessionId, async () => {
      const isCurrent = () => {
        const current = snapshots.get(sessionId)?.goal;
        return (
          current?.status === 'complete' &&
          current.objective === goal.objective &&
          current.updatedAt === goal.updatedAt
        );
      };
      if (!isCurrent()) return;
      const session = sessions.getSession(sessionId);
      const adapter = getProviderService().getAdapter('codex');
      if (!session?.codex_session_id || !(adapter instanceof CodexAdapter)) return;
      if (adapter.hasSession(sessionId)) await adapter.changeGoal(sessionId, { type: 'clear' });
      else
        await adapter.changeUnloadedGoal(session.codex_session_id, session.cwd || process.cwd(), {
          type: 'clear',
        });
      if (isCurrent()) publishSessionGoal(sessionId, null);
    }).catch((error) => console.warn('Failed to clear completed task goal:', error));
  }
  return snapshot;
}

export function setupSessionGoalIPC(deps: {
  startGoalRunner: (
    session: NonNullable<ReturnType<typeof sessions.getSession>>,
    action: GoalAction,
    settings: GoalSettings,
  ) => void;
  broadcast: (event: ServerEvent) => void;
  changeClaudeGoal?: (sessionId: string, action: GoalAction, settings: GoalSettings) => Promise<import('../libs/claude-goal').ClaudeGoalState>;
}) {
  emit = deps.broadcast;
  onClaudeGoalChanged((id, state) => publishSessionGoal(id, state.goal, state.supported, state.resumeConfirmation));
  const getSession = (id: string) => {
    const session = sessions.getSession(id);
    if (!session || !['codex', 'claude'].includes(session.provider || ''))
      throw new Error('Native Goal mode requires a Codex or Claude task.');
    return session;
  };
  const getAdapter = () => {
    const adapter = getProviderService().getAdapter('codex');
    if (!(adapter instanceof CodexAdapter)) throw new Error('Codex is not available.');
    return adapter;
  };
  ipcMainHandle('get-session-goal', async (_, sessionId: string) => {
    const session = getSession(sessionId);
    if (session.provider === 'claude') {
      const state = readClaudeGoalState(sessionId);
      return publishSessionGoal(sessionId, state.goal, state.supported, state.resumeConfirmation);
    }
    if (!session.codex_session_id)
      return snapshots.get(sessionId) ?? publishSessionGoal(sessionId, null);
    const before = snapshots.get(sessionId)?.revision;
    try {
      const goal = await getAdapter().readGoal(
        sessionId,
        session.codex_session_id,
        session.cwd || process.cwd(),
      );
      // A pushed update wins over a read which was already in flight.
      if (snapshots.get(sessionId)?.revision !== before) return snapshots.get(sessionId)!;
      return publishSessionGoal(sessionId, goal);
    } catch (error) {
      if (snapshots.get(sessionId)?.revision !== before) return snapshots.get(sessionId)!;
      if (
        error instanceof CodexRpcError &&
        (error.code === -32601 ||
          /unknown variant|not supported|goals.*disabled/i.test(error.message))
      ) {
        return publishSessionGoal(sessionId, null, false);
      }
      throw error;
    }
  });
  ipcMainHandle(
    'change-session-goal',
    async (_, sessionId: string, rawAction: GoalAction, settings: GoalSettings = {}) => {
      const action = validateGoalAction(rawAction);
      return enqueueChange(sessionId, async () => {
        const session = getSession(sessionId);
        if (session.provider === 'claude') {
          if (!deps.changeClaudeGoal) throw new Error('Claude Goal mode is not available.');
          await deps.changeClaudeGoal(sessionId, action, settings);
          const state = readClaudeGoalState(sessionId);
          if (action.type === 'clear') snapshots.delete(sessionId);
          return publishSessionGoal(sessionId, state.goal, state.supported, state.resumeConfirmation);
        }
        const adapter = getAdapter();
        let goal: ThreadGoal | null;
        if (settings.appendTranscript && action.type === 'set' && action.objective)
          pendingObjectives.set(sessionId, action.objective);
        try {
          if (
            action.type === 'clear' &&
            !session.codex_session_id &&
            !adapter.hasSession(sessionId)
          ) {
            goal = null;
          } else if (adapter.hasSession(sessionId)) {
            goal = await adapter.changeGoal(sessionId, action, settings);
          } else if (
            (action.type === 'clear' || action.status === 'paused') &&
            session.codex_session_id
          ) {
            goal = await adapter.changeUnloadedGoal(
              session.codex_session_id,
              session.cwd || process.cwd(),
              action,
            );
          } else {
            // Subscribe before starting: a native goal may begin its first turn
            // before the set RPC response reaches us.
            goal = await new Promise<ThreadGoal | null>((resolve, reject) => {
              const service = getProviderService();
              let settled = false;
              const finish = (error?: Error, value: ThreadGoal | null = null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                service.events.off('event', listener);
                startingFailures.delete(sessionId);
                if (error) void adapter.stopSession(sessionId).catch(() => {});
                error ? reject(error) : resolve(value);
              };
              const listener = (event: import('../libs/provider/types').ProviderRuntimeEvent) => {
                if (event.threadId !== sessionId) return;
                if (
                  event.type === 'goal_changed' &&
                  event.goal &&
                  action.type === 'set' &&
                  (!action.objective ||
                    (event.goal.displayObjective ?? event.goal.objective) === action.objective) &&
                  (!action.status || event.goal.status === action.status)
                )
                  finish(undefined, event.goal);
                if (event.type === 'error') finish(event.error);
              };
              const timer = setTimeout(
                () => finish(new Error('Timed out starting Goal mode.')),
                30_000,
              );
              service.events.on('event', listener);
              startingFailures.set(sessionId, (error) => finish(error));
              try {
                deps.startGoalRunner(session, action, settings);
              } catch (error) {
                finish(error as Error);
              }
            });
          }
          if (action.type === 'set' && goal) {
            if (goal.status === 'active')
              sessions.updateSessionCodexExecutionMode(sessionId, 'execute');
            if (settings.model) sessions.updateSessionModel(sessionId, settings.model);
            if (settings.codexPermissionMode)
              sessions.updateSessionCodexPermissionMode(sessionId, settings.codexPermissionMode);
            if (settings.codexReasoningEffort)
              sessions.updateSessionCodexReasoningEffort(sessionId, settings.codexReasoningEffort);
            if (settings.codexFastMode !== undefined)
              sessions.updateSessionCodexFastMode(sessionId, settings.codexFastMode);
          }
          if (action.type === 'clear') snapshots.delete(sessionId);
          return publishSessionGoal(sessionId, goal);
        } finally {
          pendingObjectives.delete(sessionId);
        }
      });
    },
  );
}
