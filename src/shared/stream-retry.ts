import type { RetryOutputSnapshot, StreamMessage } from './types';

export type ApiRetryMessage = Extract<StreamMessage, { subtype: 'api_retry' }>;
export type RetryResolvedMessage = Extract<StreamMessage, { subtype: 'api_retry_resolved' }>;

/** Only provider output or a turn boundary can settle a connection retry. */
export function resolvesStreamRetry(message: StreamMessage): boolean {
  if (message.parentToolUseId) return false;
  if (message.type === 'result' || message.type === 'user_prompt') return true;
  if (message.type === 'assistant') return message.message.content.length > 0;
  // A background tool result is not evidence of a recovered API connection.
  if (message.type === 'user') {
    return message.message.content.some(block => block.type === 'text' && Boolean(block.text.trim()));
  }
  if (message.type !== 'stream_event' || message.event.type !== 'content_block_delta') return false;
  const delta = message.event.delta;
  return (delta?.type === 'thinking_delta' && Boolean(delta.thinking))
    || (delta?.type === 'text_delta' && Boolean(delta.text));
}

export function removeCommittedRetryOutput(snapshot: RetryOutputSnapshot, incoming?: StreamMessage): RetryOutputSnapshot {
  const blocks = incoming?.type === 'assistant' ? incoming.message.content : [];
  return {
    ...snapshot,
    thinking: blocks.some(b => b.type === 'thinking' && b.thinking.startsWith(snapshot.thinking)) ? '' : snapshot.thinking,
    text: blocks.some(b => b.type === 'text' && b.text.startsWith(snapshot.text)) ? '' : snapshot.text,
  };
}

export function retrySnapshotMessage(snapshot: RetryOutputSnapshot): Extract<StreamMessage, { type: 'assistant' }> | null {
  if (!snapshot.thinking && !snapshot.text) return null;
  return {
    type: 'assistant', uuid: snapshot.uuid, createdAt: snapshot.createdAt,
    agentId: snapshot.agentId, agentRunId: snapshot.agentRunId,
    phase: 'commentary', interrupted: true,
    message: { content: [
      ...(snapshot.thinking ? [{ type: 'thinking' as const, thinking: snapshot.thinking }] : []),
      ...(snapshot.text ? [{ type: 'text' as const, text: snapshot.text }] : []),
    ] },
  };
}
