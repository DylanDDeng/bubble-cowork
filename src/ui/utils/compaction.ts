import type { StreamMessage } from '../types';

export type CompactionMessage = Extract<StreamMessage, {
  type: 'system'; subtype: 'compact_status' | 'compact_boundary';
}>;
export type WorkstreamMessage = Extract<StreamMessage, { type: 'assistant' }> | CompactionMessage;
export interface CompactionEntry {
  id: string;
  type: 'compaction';
  summary: string;
  detail?: never;
  state: 'inProgress' | 'completed' | 'interrupted';
  trigger: 'auto' | 'manual';
  startedAt?: number;
}

export function isCompactionMessage(message: StreamMessage): message is CompactionMessage {
  return message.type === 'system' &&
    (message.subtype === 'compact_status' || message.subtype === 'compact_boundary');
}

/** Keep one activity at its start position; older providers only emit a boundary. */
export function deriveCompactionEntries(messages: WorkstreamMessage[]): Map<number, CompactionEntry> {
  const entries = new Map<number, CompactionEntry>();
  const byId = new Map<string, CompactionEntry>();
  let pending: CompactionEntry | undefined;
  messages.forEach((message, index) => {
    if (!isCompactionMessage(message)) return;
    const completed = message.subtype === 'compact_boundary';
    const trigger = completed ? message.compactMetadata.trigger : message.trigger;
    const state = completed ? 'completed' : message.status === 'interrupted' ? 'interrupted' : 'inProgress';
    const existing = message.compactionId ? byId.get(message.compactionId)
      : state !== 'inProgress' ? pending : undefined;
    if (existing?.state === 'completed') return;
    const entry: CompactionEntry = existing ?? {
      id: `compaction:${message.compactionId ?? message.uuid}`,
      type: 'compaction', summary: '', trigger, state,
      startedAt: completed ? undefined : message.createdAt,
    };
    entry.state = state;
    if (completed) entry.trigger = trigger;
    entry.summary = state === 'inProgress' ? 'Compacting context'
      : state === 'interrupted' ? 'Compaction interrupted'
      : entry.trigger === 'manual' ? 'Context compacted' : 'Context automatically compacted';
    if (!existing) entries.set(index, entry);
    if (message.compactionId) byId.set(message.compactionId, entry);
    pending = state === 'inProgress' ? entry : undefined;
  });
  return entries;
}
