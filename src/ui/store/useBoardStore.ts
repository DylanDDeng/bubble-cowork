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
export type BoardStage = 'backlog' | 'todo' | 'working' | 'review' | 'done' | 'canceled';

export const BOARD_STAGES: BoardStage[] = ['backlog', 'todo', 'working', 'review', 'done', 'canceled'];

/**
 * A system event on a task's timeline: what happened to the card itself, as
 * opposed to what was said in the conversation. Kept append-only and capped;
 * the Activity view interleaves these with the message transcript.
 */
export type BoardTaskEvent =
  | { type: 'created'; at: number }
  | { type: 'stage'; at: number; from: BoardStage; to: BoardStage; auto?: boolean }
  | { type: 'run-started'; at: number }
  | { type: 'run-completed'; at: number }
  | { type: 'run-failed'; at: number }
  | { type: 'description-updated'; at: number };

const EVENT_CAP = 200;

function withEvent(events: BoardTaskEvent[] | undefined, event: BoardTaskEvent): BoardTaskEvent[] {
  const next = [...(events ?? []), event];
  return next.length > EVENT_CAP ? next.slice(-EVENT_CAP) : next;
}

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
  /** System events, oldest first, capped at EVENT_CAP. */
  events: BoardTaskEvent[];
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
  setStage: (taskId: string, stage: BoardStage, opts?: { auto?: boolean }) => void;
  renameTask: (taskId: string, title: string) => void;
  attachSession: (taskId: string, sessionId: string) => void;
  removeTask: (taskId: string) => void;
  markSeen: (taskId: string) => void;
  /**
   * The task open in the detail page, lifted to the store so app tabs can
   * reference and restore it. Null = the column view.
   */
  selectedTaskId: string | null;
  setSelectedTask: (taskId: string | null) => void;
  /**
   * Sessions the user removed from the board. Every chat session
   * auto-materializes as a card, so removal must be remembered or the next
   * sync pass would resurrect the card.
   */
  excludedSessionIds: Record<string, true>;
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
        stage = 'todo',
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
              events: [{ type: 'created', at: now }],
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
          const nextPrompt = patch.prompt === undefined ? task.prompt : patch.prompt.trim();
          return {
            tasks: {
              ...state.tasks,
              [taskId]: {
                ...task,
                ...patch,
                title: nextTitle,
                prompt: nextPrompt,
                projectCwd: nextProjectCwd,
                sessionConfig: patch.sessionConfig ?? task.sessionConfig,
                updatedAt: Date.now(),
                events:
                  nextPrompt !== task.prompt
                    ? withEvent(task.events, { type: 'description-updated', at: Date.now() })
                    : task.events,
              },
            },
          };
        }),

      setStage: (taskId, stage, opts) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task || task.stage === stage) return state;
          return {
            tasks: {
              ...state.tasks,
              [taskId]: {
                ...task,
                stage,
                updatedAt: Date.now(),
                unread: false,
                events: withEvent(task.events, {
                  type: 'stage',
                  at: Date.now(),
                  from: task.stage,
                  to: stage,
                  auto: opts?.auto,
                }),
              },
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
          const task = state.tasks[taskId];
          if (!task) return state;
          const tasks = { ...state.tasks };
          delete tasks[taskId];
          const excludedSessionIds = { ...state.excludedSessionIds };
          for (const sessionId of task.sessionIds) excludedSessionIds[sessionId] = true;
          return {
            tasks,
            excludedSessionIds,
            selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
          };
        }),

      markSeen: (taskId) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task || !task.unread) return state;
          return { tasks: { ...state.tasks, [taskId]: { ...task, unread: false } } };
        }),

      selectedTaskId: null,
      setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),

      excludedSessionIds: {},
    }),
    {
      name: 'cowork-board-storage',
      storage: createJSONStorage(() => rendererStateStorage),
      version: 4,
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
                // v2 boards had a single "inbox" column, since split into
                // Backlog + Todo. Inbox tasks were startable, so they land
                // in Todo.
                stage: (task.stage as string) === 'inbox' ? 'todo' : task.stage,
                // v3 tasks predate the event timeline; seed it with creation.
                events: task.events ?? [{ type: 'created', at: task.createdAt }],
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
//   - backlog/todo + linked run starts running   → working (you kicked it off)
//   - working + latest run completes             → review + unread
// Everything else (review → done, reopening, failures) stays manual — a
// failed run keeps the card in Working with a red badge, and only the user
// moves a card into Done.
// ---------------------------------------------------------------------------

const lastSeenStatus = new Map<string, string>();

/** Append a system event without touching updatedAt (no reorder side effects). */
function recordTaskEvent(taskId: string, event: BoardTaskEvent): void {
  useBoardStore.setState((state) => {
    const task = state.tasks[taskId];
    if (!task) return state;
    return {
      tasks: { ...state.tasks, [taskId]: { ...task, events: withEvent(task.events, event) } },
    };
  });
}

function syncStagesFromSessions(sessions: Record<string, SessionView>): void {
  const { tasks, setStage } = useBoardStore.getState();
  for (const task of Object.values(tasks)) {
    const session = latestTaskSession(task, sessions);
    if (!session) continue;
    const previous = lastSeenStatus.get(task.id);
    lastSeenStatus.set(task.id, session.status);
    if (previous === session.status) continue;
    // Run lifecycle events. `previous === undefined` is the first pass after
    // app launch — the status is not a transition, so nothing is recorded.
    if (previous !== undefined) {
      const wasRunning = previous === 'running' || previous === 'stopping';
      if (session.status === 'running' && !wasRunning) {
        recordTaskEvent(task.id, { type: 'run-started', at: Date.now() });
      } else if (wasRunning && session.status === 'completed') {
        recordTaskEvent(task.id, { type: 'run-completed', at: Date.now() });
      } else if (wasRunning && session.status === 'error') {
        recordTaskEvent(task.id, { type: 'run-failed', at: Date.now() });
      }
    }
    if ((task.stage === 'backlog' || task.stage === 'todo') && session.status === 'running') {
      setStage(task.id, 'working', { auto: true });
    } else if (
      task.stage === 'working' &&
      previous === 'running' &&
      session.status === 'completed'
    ) {
      useBoardStore.setState((state) => {
        const current = state.tasks[task.id];
        if (!current || current.stage !== 'working') return state;
        const now = Date.now();
        return {
          tasks: {
            ...state.tasks,
            [task.id]: {
              ...current,
              stage: 'review',
              unread: true,
              updatedAt: now,
              events: withEvent(current.events, {
                type: 'stage',
                at: now,
                from: 'working',
                to: 'review',
                auto: true,
              }),
            },
          },
        };
      });
    }
  }
}

/**
 * The board is a view over ALL chat sessions, not a hand-curated subset:
 * every real session (titled, not hidden, not excluded, not already linked
 * as a task run) materializes as a card. First placement follows the
 * session's live status; afterwards the stage belongs to the user and the
 * normal transition rules above.
 */
function materializeSessions(sessions: Record<string, SessionView>): void {
  const { tasks, addTask, excludedSessionIds } = useBoardStore.getState();
  const linked = sessionIdsOnBoard(tasks);
  for (const session of Object.values(sessions)) {
    if (session.isDraft || session.hiddenFromThreads) continue;
    if (!session.title?.trim()) continue;
    if (linked.has(session.id) || excludedSessionIds[session.id]) continue;
    const stage: BoardStage =
      session.status === 'running' || session.status === 'stopping'
        ? 'working'
        : session.status === 'completed'
          ? 'review'
          : 'todo';
    addTask({
      title: session.title,
      projectCwd: session.projectCwd || session.cwd || null,
      sessionConfig: {
        provider: session.provider,
        model: session.model,
        compatibleProviderId: session.compatibleProviderId,
        claudeAccessMode: session.claudeAccessMode,
        claudeExecutionMode: session.claudeExecutionMode,
        claudeReasoningEffort: session.claudeReasoningEffort,
        codexExecutionMode: session.codexExecutionMode,
        codexPermissionMode: session.codexPermissionMode,
        codexReasoningEffort: session.codexReasoningEffort,
        codexFastMode: session.codexFastMode,
        kimiPermissionMode: session.kimiPermissionMode,
        grokPermissionMode: session.grokPermissionMode,
        grokReasoningEffort: session.grokReasoningEffort,
        deepseekAgentPreset: session.deepseekAgentPreset,
        opencodePermissionMode: session.opencodePermissionMode,
        bubblePermissionMode: session.bubblePermissionMode,
      },
      sessionId: session.id,
      stage,
    });
  }
}

let sessionSyncStarted = false;

/** Idempotent; called once from BoardView (and safe to call again). */
export function ensureBoardSessionSync(): void {
  if (sessionSyncStarted) return;
  sessionSyncStarted = true;
  let prevSessions = useAppStore.getState().sessions;
  materializeSessions(prevSessions);
  syncStagesFromSessions(prevSessions);
  useAppStore.subscribe((state) => {
    if (state.sessions === prevSessions) return;
    prevSessions = state.sessions;
    materializeSessions(state.sessions);
    syncStagesFromSessions(state.sessions);
  });
}
