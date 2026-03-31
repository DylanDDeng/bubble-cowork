import type { StreamMessage } from '../types';
import { getMessageContentBlocks } from './message-content';

export type AggregatedItem =
  | { type: 'message'; message: StreamMessage; originalIndex: number }
  | { type: 'tool_batch'; messages: (StreamMessage & { type: 'assistant' })[]; originalIndices: number[] };

function hasTraceAssistantContent(
  msg: StreamMessage
): msg is StreamMessage & { type: 'assistant' } {
  if (msg.type !== 'assistant') return false;
  const content = getMessageContentBlocks(msg);
  if (content.length === 0) return false;
  return content.some((block) => block.type === 'thinking' || block.type === 'tool_use');
}

function isToolResultOnlyMessage(msg: StreamMessage): boolean {
  if (msg.type !== 'user') return false;
  const content = getMessageContentBlocks(msg);
  return content.length > 0 && content.every((block) => block.type === 'tool_result');
}

function pushSegment(
  items: AggregatedItem[],
  segment: Array<{ message: StreamMessage; index: number }>
) {
  if (segment.length === 0) return;

  const lastTraceIndex = segment.reduce((lastIndex, entry, index) => {
    if (hasTraceAssistantContent(entry.message) || isToolResultOnlyMessage(entry.message)) {
      return index;
    }
    return lastIndex;
  }, -1);

  if (lastTraceIndex === -1) {
    segment.forEach((entry) =>
      items.push({ type: 'message', message: entry.message, originalIndex: entry.index })
    );
    return;
  }

  const traceAssistantEntries = segment
    .slice(0, lastTraceIndex + 1)
    .filter(
      (
        entry
      ): entry is {
        message: StreamMessage & { type: 'assistant' };
        index: number;
      } => entry.message.type === 'assistant'
    );

  if (traceAssistantEntries.length > 0) {
    items.push({
      type: 'tool_batch',
      messages: traceAssistantEntries.map((entry) => entry.message),
      originalIndices: traceAssistantEntries.map((entry) => entry.index),
    });
  }

  segment.slice(lastTraceIndex + 1).forEach((entry) =>
    items.push({ type: 'message', message: entry.message, originalIndex: entry.index })
  );
}

export function aggregateMessages(messages: StreamMessage[]): AggregatedItem[] {
  const items: AggregatedItem[] = [];
  let currentSegment: Array<{ message: StreamMessage; index: number }> = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];

    if (message.type === 'stream_event') {
      continue;
    }

    if (message.type === 'user_prompt') {
      pushSegment(items, currentSegment);
      currentSegment = [];
      items.push({ type: 'message', message, originalIndex: i });
      continue;
    }

    currentSegment.push({ message, index: i });
  }

  pushSegment(items, currentSegment);

  return items;
}
