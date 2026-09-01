import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';
import { useAppStore } from './useAppStore';
import type { SessionView } from '../types';
import type { SessionStartPayload } from '../../shared/types';

/**
 * Board task stages. A column is a HUMAN-owned position in your workflow;
 * the live run state (running / needs permission / failed) is derived from
 * the linked sessions at render time and never stored here. The one
 * automated transition is working → review when a linked run finishes —
 * "done" is always a user decision.
 */
export type BoardStage = 'inbox' | 'working' | 'review' | 'done';

export const BOARD_STAGES: BoardStage[] = ['inbox', 'working', 'review', 'done'];

export type BoardSessionConfig = Pick<
  SessionStartPayload,
  | 'provider'
  | 'model'
  | 'compatibleProviderId'
  | 'claudeAccessMode'
  | 'claudeExecutionMode'
  | 'claudeReasoningEffort'
  | 'codexExecutionMode'
  | 'codexPermissionMode'
  | 'codexReasoningEffort'
  | 'codexFastMode'
  | 'kimiPermissionMode'
  | 'kimiThinking'
  | 'grokPermissionMode'
  | 'grokReasoningEffort'
  | 'deepseekPermissionMode'
  | 'deepseekAgentPreset'
  | 'deepseekReasoningEffort'
  | 'opencodePermissionMode'
  | 'qoderPermissionMode'
  | 'bubblePermissionMode'
  | 'bubbleThinkingLevel'
>;

/**
 * A card on the board. Deliberately NOT a session: one task can accumulate
 * several runs (retry after a failure, hand the same job to another agent),
 * so it holds a list of session ids instead of merging into SessionView.
 */
export interface BoardTask {
  id: string;
  title: string;
  /** The work request that can be started directly from the board. */
  prompt: string;
  projectCwd: string | null;
  /** Runtime choices captured when the task is composed. */
  sessionConfig: Partial<BoardSessionConfig>;
  stage: BoardStage;
  /** Linked sessions (runs), oldest first. The last one drives the live badge. */
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
  /** A linked run finished while you weren't looking. Cleared on open. */
  unread: boolean;
}

export interface BoardStore {
  tasks: Record<string, BoardTask>;
  addTask: (input: {
    title: string;
    prompt?: string;
    projectCwd?: string | null;
    sessionConfig?: Partial<BoardSessionConfig>;
    sessionId?: string | null;
    stage?: BoardStage;
  }) => string;
  updateTask: (
    taskId: string,
    patch: Partial<Pick<BoardTask, 'title' | 'prompt' | 'projectCwd' | 'sessionConfig'>>
  ) => void;
  setStage: (taskId: string, stage: BoardStage) => void;
  renameTask: (taskId: string, title: string) => void;
  attachSession: (taskId: string, sessionId: string) => void;
  removeTask: (taskId: string) => void;
  markSeen: (taskId: string) => void;
}

function makeTaskId(): string {
  return `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useBoardStore = create<BoardStore>()(
  persist(
    (set) => ({
      tasks: {},

      addTask: ({
        title,
        prompt = '',
        projectCwd = null,
        sessionConfig = {},
        sessionId = null,
        stage = 'inbox',
      }) => {
        const id = makeTaskId();
        const now = Date.now();
        set((state) => ({
          tasks: {
            ...state.tasks,
            [id]: {
              id,
              title: title.trim() || 'Untitled task',
              prompt: prompt.trim(),
              projectCwd: projectCwd?.trim() || null,
              sessionConfig,
              stage,
              sessionIds: sessionId ? [sessionId] : [],
              createdAt: now,
              updatedAt: now,
              unread: false,
            },
          },
        }));
        return id;
      },

      updateTask: (taskId, patch) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task) return state;
          const nextTitle = patch.title === undefined ? task.title : patch.title.trim() || task.title;
          const nextProjectCwd =
            patch.projectCwd === undefined ? task.projectCwd : patch.projectCwd?.trim() || null;
          return {
            tasks: {
              ...state.tasks,
              [taskId]: {
                ...task,
                ...patch,
                title: nextTitle,
                prompt: patch.prompt === undefined ? task.prompt : patch.prompt.trim(),
                projectCwd: nextProjectCwd,
                sessionConfig: patch.sessionConfig ?? task.sessionConfig,
                updatedAt: Date.now(),
              },
            },
          };
        }),

      setStage: (taskId, stage) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task || task.stage === stage) return state;
          return {
            tasks: {
              ...state.tasks,
              [taskId]: { ...task, stage, updatedAt: Date.now(), unread: false },
            },
          };
        }),

      renameTask: (taskId, title) =>
        set((state) => {
          const task = state.tasks[taskId];
          const trimmed = title.trim();
          if (!task || !trimmed || task.title === trimmed) return state;
          return {
            tasks: { ...state.tasks, [taskId]: { ...task, title: trimmed, updatedAt: Date.now() } },
          };
        }),

      attachSession: (taskId, sessionId) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task || task.sessionIds.includes(sessionId)) return state;
          return {
            tasks: {
              ...state.tasks,
              [taskId]: {
                ...task,
                sessionIds: [...task.sessionIds, sessionId],
                updatedAt: Date.now(),
              },
            },
          };
        }),

      removeTask: (taskId) =>
        set((state) => {
          if (!state.tasks[taskId]) return state;
          const tasks = { ...state.tasks };
          delete tasks[taskId];
          return { tasks };
        }),

      markSeen: (taskId) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task || !task.unread) return state;
          return { tasks: { ...state.tasks, [taskId]: { ...task, unread: false } } };
        }),
    }),
    {
      name: 'cowork-board-storage',
      storage: createJSONStorage(() => rendererStateStorage),
      version: 2,
      migrate: (persistedState) => {
        const state = persistedState as Partial<BoardStore> | undefined;
        const tasks = state?.tasks || {};
        return {
          ...state,
          tasks: Object.fromEntries(
            Object.entries(tasks).map(([id, task]) => [
              id,
              {
                ...task,
                prompt: task.prompt || '',
                sessionConfig: task.sessionConfig || {},
                // Older Board starts linked renderer-only drafts. They are
                // removed by session.start and can never be opened again.
                sessionIds: task.sessionIds.filter((sessionId) => !sessionId.startsWith('draft-')),
              },
            ])
          ),
        };
      },
    }
  )
);

/** The session whose live state a task's card reflects: its latest run. */
export function latestTaskSession(
  task: BoardTask,
  sessions: Record<string, SessionView>
): SessionView | null {
  for (let i = task.sessionIds.length - 1; i >= 0; i -= 1) {
    const session = sessions[task.sessionIds[i]];
    if (session) return session;
  }
  return null;
}

export function sessionIdsOnBoard(tasks: Record<string, BoardTask>): Set<string> {
  const ids = new Set<string>();
  for (const task of Object.values(tasks)) {
    for (const id of task.sessionIds) ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Automated stage transitions, driven by live session status.
//
// Subscribed to the whole app store (which updates on every stream chunk), so
// the pass must stay cheap: one status read per task, compared against a
// cached signature. Rules:
//   - inbox + linked run starts running          → working (you kicked it off)
//   - working + latest run completes             → review + unread
// Everything else (review → done, reopening, failures) stays manual — a
// failed run keeps the card in Working with a red badge, and only the user
// moves a card into Done.
// ---------------------------------------------------------------------------

const lastSeenStatus = new Map<string, string>();

function syncStagesFromSessions(sessions: Record<string, SessionView>): void {
  const { tasks, setStage } = useBoardStore.getState();
  for (const task of Object.values(tasks)) {
    const session = latestTaskSession(task, sessions);
    if (!session) continue;
    const previous = lastSeenStatus.get(task.id);
    lastSeenStatus.set(task.id, session.status);
    if (previous === session.status) continue;
    if (task.stage === 'inbox' && session.status === 'running') {
      setStage(task.id, 'working');
    } else if (
      task.stage === 'working' &&
      previous === 'running' &&
      session.status === 'completed'
    ) {
      useBoardStore.setState((state) => {
        const current = state.tasks[task.id];
        if (!current || current.stage !== 'working') return state;
        return {
          tasks: {
            ...state.tasks,
            [task.id]: { ...current, stage: 'review', unread: true, updatedAt: Date.now() },
          },
        };
      });
    }
  }
}

let sessionSyncStarted = false;

/** Idempotent; called once from BoardView (and safe to call again). */
export function ensureBoardSessionSync(): void {
  if (sessionSyncStarted) return;
  sessionSyncStarted = true;
  let prevSessions = useAppStore.getState().sessions;
  syncStagesFromSessions(prevSessions);
  useAppStore.subscribe((state) => {
    if (state.sessions === prevSessions) return;
    prevSessions = state.sessions;
    syncStagesFromSessions(state.sessions);
  });
}
