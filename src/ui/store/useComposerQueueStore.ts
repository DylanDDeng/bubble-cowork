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
  /** Preserve attachment numbering for a dedicated image edit turn. */
  exclusive?: boolean;
  /** An exclusive action keeps its captured session configuration. */
  dispatch?: () => void;
  onRemove?: () => void;
}

interface ComposerQueueStore {
  queues: Record<string, QueuedComposerMessage[]>;
  enqueue: (sessionId: string, item: QueuedComposerMessage) => void;
  remove: (sessionId: string, itemId: string) => void;
  /** Atomically remove and return one item (empty result if already gone). */
  takeOne: (sessionId: string, itemId: string) => QueuedComposerMessage | null;
  /** Atomically drain the whole queue for a session. */
  takeAll: (sessionId: string) => QueuedComposerMessage[];
  takeNextBatch: (sessionId: string) => QueuedComposerMessage[];
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

// Flush ownership: a mounted composer bound to a session claims its flush so
// the auto-send applies the LIVE composer selection (model, permission mode).
// The store-level watcher (queue-auto-flush.ts) only flushes sessions with no
// owner — i.e. panes the user navigated away from — using session-sticky
// config. Refcounted (split view can bind two composers to one session).
const flushOwners = new Map<string, number>();

export function claimQueueFlushOwner(sessionId: string): void {
  flushOwners.set(sessionId, (flushOwners.get(sessionId) || 0) + 1);
}

export function releaseQueueFlushOwner(sessionId: string): void {
  const count = (flushOwners.get(sessionId) || 0) - 1;
  if (count > 0) flushOwners.set(sessionId, count);
  else flushOwners.delete(sessionId);
}

export function hasQueueFlushOwner(sessionId: string): boolean {
  return (flushOwners.get(sessionId) || 0) > 0;
}

export const useComposerQueueStore = create<ComposerQueueStore>()((set, get) => ({
  queues: {},

  enqueue: (sessionId, item) =>
    set((state) => ({
      queues: {
        ...state.queues,
        [sessionId]: [...(state.queues[sessionId] ?? []), item],
      },
    })),

  remove: (sessionId, itemId) => {
    const item = get().queues[sessionId]?.find(entry => entry.id === itemId);
    if (!item) return;
    set(state => ({ queues: { ...state.queues, [sessionId]: state.queues[sessionId].filter(entry => entry.id !== itemId) } }));
    item.onRemove?.();
  },

  takeOne: (sessionId, itemId) => {
    const item = get().queues[sessionId]?.find((entry) => entry.id === itemId) ?? null;
    if (item) set(state => ({ queues: { ...state.queues, [sessionId]: state.queues[sessionId].filter(entry => entry.id !== itemId) } }));
    return item;
  },

  takeNextBatch: (sessionId) => {
    const queue = get().queues[sessionId] ?? EMPTY_QUEUE;
    const boundary = queue.findIndex(item => item.exclusive);
    const count = boundary === 0 ? 1 : boundary < 0 ? queue.length : boundary;
    const items = queue.slice(0, count);
    if (count) set(state => ({ queues: { ...state.queues, [sessionId]: queue.slice(count) } }));
    return items;
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
