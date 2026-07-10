import { create } from 'zustand';
import type { Attachment } from '../types';
import type { CodexReferencePayload } from '../utils/codex-composer';

/**
 * A composer message captured while the agent was still running a turn.
 * It waits above the composer as a chip: "Steer" dispatches it into the
 * running turn immediately; otherwise it auto-sends when the turn completes.
 *
 * Deliberately NOT part of the persisted app store — a queued message only
 * makes sense relative to the live turn it was queued behind.
 */
export interface QueuedComposerMessage {
  id: string;
  /** Text shown on the chip and used as the transcript user bubble. */
  displayPrompt: string;
  /** Normalized prompt (file mentions resolved) actually sent to the agent. */
  effectivePrompt: string;
  attachments: Attachment[];
  references: CodexReferencePayload;
}

interface ComposerQueueStore {
  queues: Record<string, QueuedComposerMessage[]>;
  enqueue: (sessionId: string, item: QueuedComposerMessage) => void;
  remove: (sessionId: string, itemId: string) => void;
  /** Atomically remove and return one item (empty result if already gone). */
  takeOne: (sessionId: string, itemId: string) => QueuedComposerMessage | null;
  /** Atomically drain the whole queue for a session. */
  takeAll: (sessionId: string) => QueuedComposerMessage[];
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

export const useComposerQueueStore = create<ComposerQueueStore>()((set, get) => ({
  queues: {},

  enqueue: (sessionId, item) =>
    set((state) => ({
      queues: {
        ...state.queues,
        [sessionId]: [...(state.queues[sessionId] ?? []), item],
      },
    })),

  remove: (sessionId, itemId) =>
    set((state) => {
      const queue = state.queues[sessionId];
      if (!queue?.some((item) => item.id === itemId)) return state;
      return {
        queues: {
          ...state.queues,
          [sessionId]: queue.filter((item) => item.id !== itemId),
        },
      };
    }),

  takeOne: (sessionId, itemId) => {
    const item = get().queues[sessionId]?.find((entry) => entry.id === itemId) ?? null;
    if (item) get().remove(sessionId, itemId);
    return item;
  },

  takeAll: (sessionId) => {
    const items = get().queues[sessionId] ?? EMPTY_QUEUE;
    if (items.length > 0) {
      set((state) => ({ queues: { ...state.queues, [sessionId]: [] } }));
    }
    return items;
  },
}));

export function selectQueuedMessages(
  state: ComposerQueueStore,
  sessionId: string | null | undefined
): QueuedComposerMessage[] {
  return (sessionId && state.queues[sessionId]) || EMPTY_QUEUE;
}
