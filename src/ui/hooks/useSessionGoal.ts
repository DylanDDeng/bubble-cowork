import { useEffect } from 'react';
import { create } from 'zustand';
import { useAppStore } from '../store/useAppStore';
import type { GoalAction, GoalSettings, SessionGoalSnapshot } from '../../shared/session-goal';

interface GoalStore {
  snapshots: Record<string, SessionGoalSnapshot>;
  drafts: Record<string, boolean>;
  resumeAcknowledged: Record<string, string>;
  acknowledgeResume: (sessionId: string) => void;
  apply: (snapshot: SessionGoalSnapshot) => void;
  setDraft: (key: string, active: boolean) => void;
}
export const useSessionGoalStore = create<GoalStore>((set) => ({
  snapshots: {},
  drafts: {},
  resumeAcknowledged: {},
  acknowledgeResume: (sessionId) =>
    set((state) => ({
      resumeAcknowledged: {
        ...state.resumeAcknowledged,
        [sessionId]: JSON.stringify(state.snapshots[sessionId]?.goal),
      },
      snapshots: {
        ...state.snapshots,
        [sessionId]: { ...state.snapshots[sessionId], resumeConfirmation: false },
      },
    })),
  apply: (snapshot) =>
    set((state) => {
      if ((state.snapshots[snapshot.sessionId]?.revision ?? -1) > snapshot.revision) return state;
      const acknowledged =
        state.resumeAcknowledged[snapshot.sessionId] === JSON.stringify(snapshot.goal);
      return {
        snapshots: {
          ...state.snapshots,
          [snapshot.sessionId]: acknowledged
            ? { ...snapshot, resumeConfirmation: false }
            : snapshot,
        },
      };
    }),
  setDraft: (key, active) => set((state) => ({ drafts: { ...state.drafts, [key]: active } })),
}));

const reads = new Map<string, Promise<void>>();
export function refreshSessionGoal(sessionId: string): Promise<void> {
  const pending = reads.get(sessionId);
  if (pending) return pending;
  const request = window.electron
    .getSessionGoal(sessionId)
    .then((snapshot) => useSessionGoalStore.getState().apply(snapshot))
    .finally(() => {
      if (reads.get(sessionId) === request) reads.delete(sessionId);
    });
  reads.set(sessionId, request);
  return request;
}

export function useSessionGoal(sessionId: string | undefined, enabled: boolean, persisted = true) {
  const key = sessionId || '__new_session__';
  const snapshot = useSessionGoalStore((state) =>
    sessionId ? state.snapshots[sessionId] : undefined,
  );
  const draft = useSessionGoalStore((state) => state.drafts[key] ?? false);
  useEffect(() => {
    if (!enabled || !window.electron.onSessionGoalChanged) return;
    const unsubscribe = window.electron.onSessionGoalChanged(useSessionGoalStore.getState().apply);
    // Keep cached content on transient read errors; mutations show actionable
    // errors at their control. Opening a task never activates its saved goal.
    if (sessionId && persisted) void refreshSessionGoal(sessionId).catch(() => {});
    return unsubscribe;
  }, [sessionId, enabled, persisted]);
  return {
    snapshot: enabled ? snapshot : undefined,
    goal: enabled ? (snapshot?.goal ?? snapshot?.completedGoal ?? null) : null,
    drafting: enabled && draft,
    setDraft: (active: boolean) => useSessionGoalStore.getState().setDraft(key, active),
    dismissResume: () => {
      if (sessionId) useSessionGoalStore.getState().acknowledgeResume(sessionId);
    },
    change: async (action: GoalAction, settings?: GoalSettings) => {
      if (!sessionId) throw new Error('Start a task before changing its goal.');
      const result = await window.electron.changeSessionGoal(sessionId, action, settings);
      useSessionGoalStore.getState().apply(result);
      if (result.goal?.status === 'active') {
        const state = useAppStore.getState();
        const session = state.sessions[sessionId];
        if (session?.provider === 'claude') state.setSessionClaudeMode(sessionId, session.claudeAccessMode || 'default', 'execute');
        else state.setSessionCodexExecutionMode(sessionId, 'execute');
      }
      return result;
    },
  };
}
