import type { SessionView, SessionStreamingState, StreamMessage } from '../types';
import type { RetryOutputSnapshot } from '../../shared/types';
import {
  removeCommittedRetryOutput, resolvesStreamRetry, retrySnapshotMessage,
  type ApiRetryMessage,
} from '../../shared/stream-retry';

/** Retain display-only output; authoritative copies live inside persisted retry events. */
export function archiveRetryStream(session: SessionView, incoming?: StreamMessage): SessionView {
  const { retry, thinking, text } = session.streaming;
  if (!retry) return session;
  // Legacy/live-only events may lack a main-process snapshot. Keep attribution
  // from this turn rather than inventing a new, unattributed assistant run.
  let previous: Extract<StreamMessage, { type: 'assistant' }> | undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    if (message.type === 'user_prompt') break;
    if (message.type === 'assistant' && !message.parentToolUseId && !message.interrupted) {
      previous = message;
      break;
    }
  }
  const snapshot = incoming?.type === 'system' && incoming.subtype === 'api_retry_resolved' && incoming.snapshot
    ? incoming.snapshot
    : removeCommittedRetryOutput(retry.snapshot ?? {
      uuid: `interrupted:${retry.uuid}`, createdAt: retry.createdAt ?? Date.now(), thinking, text,
      agentId: retry.agentId ?? previous?.agentId ?? session.agentId,
      agentRunId: retry.agentRunId ?? previous?.agentRunId,
    }, incoming);
  const archived = retrySnapshotMessage(snapshot);
  const messages = session.messages.filter(m => !(m.type === 'assistant' && m.uuid === snapshot.uuid));
  return {
    ...session,
    messages: archived ? [...messages, archived] : messages,
    streaming: { isStreaming: false, text: '', thinking: '' },
  };
}

/** Reconstruct both the frozen trace and retry state without replaying SDK deltas. */
export function restoreRetryHistory(messages: StreamMessage[], status: SessionView['status']): {
  messages: StreamMessage[];
  streaming: SessionStreamingState;
} {
  let retry: ApiRetryMessage | undefined;
  const snapshots = new Map<string, RetryOutputSnapshot>();
  const slots: Array<StreamMessage | string> = [];
  const remember = (snapshot: RetryOutputSnapshot) => {
    if (!snapshots.has(snapshot.uuid)) slots.push(snapshot.uuid);
    snapshots.set(snapshot.uuid, snapshot);
  };
  for (const message of messages) {
    // Pagination can combine a raw history page with already-materialized UI
    // history. Fold its snapshots back into the same slots rather than duplicating.
    if (message.type === 'assistant' && message.interrupted) {
      remember({
        uuid: message.uuid, createdAt: message.createdAt ?? 0,
        agentId: message.agentId, agentRunId: message.agentRunId,
        thinking: message.message.content.filter(b => b.type === 'thinking').map(b => b.thinking).join(''),
        text: message.message.content.filter(b => b.type === 'text').map(b => b.text).join(''),
      });
      continue;
    }
    if (!message.parentToolUseId) {
      if (message.type === 'system' && message.subtype === 'api_retry') {
        retry = message;
        if (message.snapshot) remember(message.snapshot);
      } else if (message.type === 'system' && message.subtype === 'api_retry_resolved') {
        if (message.snapshot) remember(message.snapshot);
        if (retry?.uuid === message.retryId) retry = undefined;
      } else if (resolvesStreamRetry(message)) {
        // Also support old histories that predate explicit recovery markers.
        if (retry?.snapshot) remember(removeCommittedRetryOutput(retry.snapshot, message));
        retry = undefined;
      }
    }
    slots.push(message);
  }
  const activeRetry = status === 'running' ? retry : undefined;
  const activeSnapshotId = activeRetry?.snapshot?.uuid;
  const materialized = slots.flatMap(slot => {
    if (typeof slot !== 'string') return [slot];
    if (slot === activeSnapshotId) return [];
    const message = retrySnapshotMessage(snapshots.get(slot)!);
    return message ? [message] : [];
  });
  const frozen = activeRetry?.snapshot;
  return {
    messages: materialized,
    streaming: {
      isStreaming: Boolean(frozen?.thinking || frozen?.text),
      thinking: frozen?.thinking ?? '', text: frozen?.text ?? '', retry: activeRetry,
    },
  };
}
