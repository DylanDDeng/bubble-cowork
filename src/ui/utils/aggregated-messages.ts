import type { ContentBlock, StreamMessage } from '../types';
import {
  getMessageContentBlocks,
  isAnyToolResultBlockType,
  isAnyToolUseBlockType,
} from './message-content';

export type AggregatedItem =
  | { type: 'message'; message: StreamMessage; originalIndex: number }
  | { type: 'tool_batch'; messages: (StreamMessage & { type: 'assistant' })[]; originalIndices: number[] };

type IndexedMessage = { message: StreamMessage; index: number };

function isToolResultOnlyMessage(msg: StreamMessage): boolean {
  if (msg.type !== 'user') return false;
  const content = getMessageContentBlocks(msg);
  return content.length > 0 && content.every((block) => isAnyToolResultBlockType(block.type));
}

function isTraceBlock(block: ContentBlock): boolean {
  return block.type === 'thinking' || isAnyToolUseBlockType(block.type);
}

function isVisibleAssistantTextBlock(block: ContentBlock): block is ContentBlock & { type: 'text' } {
  return block.type === 'text' && Boolean(block.text?.trim());
}

function cloneAssistantMessageWithContent(
  message: StreamMessage & { type: 'assistant' },
  content: ContentBlock[]
): StreamMessage & { type: 'assistant' } {
  return {
    ...message,
    message: {
      ...message.message,
      content,
    },
  };
}

export function aggregateMessages(messages: StreamMessage[]): AggregatedItem[] {
  const items: AggregatedItem[] = [];
  let turnMessages: IndexedMessage[] = [];

  const flushTurn = () => {
    if (turnMessages.length === 0) return;
    items.push(...aggregateTurnMessages(turnMessages));
    turnMessages = [];
  };

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];

    if (message.type === 'stream_event') {
      continue;
    }

    if (message.type === 'user_prompt') {
      flushTurn();
      items.push({ type: 'message', message, originalIndex: i });
      continue;
    }

    turnMessages.push({ message, index: i });
  }

  flushTurn();

  return items;
}

function aggregateTurnMessages(turnMessages: IndexedMessage[]): AggregatedItem[] {
  const items: AggregatedItem[] = [];
  let pendingTraceMessages: Array<{
    message: StreamMessage & { type: 'assistant' };
    index: number;
  }> = [];

  const flushTraceBatch = () => {
    if (pendingTraceMessages.length === 0) return;
    items.push({
      type: 'tool_batch',
      messages: pendingTraceMessages.map((entry) => entry.message),
      originalIndices: pendingTraceMessages.map((entry) => entry.index),
    });
    pendingTraceMessages = [];
  };

  const traceShape = getTurnTraceShape(turnMessages);

  for (let turnPos = 0; turnPos < turnMessages.length; turnPos += 1) {
    const { message, index: i } = turnMessages[turnPos];

    if (isToolResultOnlyMessage(message)) {
      continue;
    }

    if (message.type !== 'assistant') {
      flushTraceBatch();
      items.push({ type: 'message', message, originalIndex: i });
      continue;
    }

    const blocks = getMessageContentBlocks(message);
    if (blocks.length === 0) {
      flushTraceBatch();
      items.push({ type: 'message', message, originalIndex: i });
      continue;
    }

    let traceBuffer: ContentBlock[] = [];
    let textBuffer: ContentBlock[] = [];

    const flushTraceBuffer = () => {
      if (traceBuffer.length === 0) return;
      pendingTraceMessages.push({
        message: cloneAssistantMessageWithContent(message, traceBuffer),
        index: i,
      });
      traceBuffer = [];
    };

    const flushTextBuffer = () => {
      if (textBuffer.length === 0) return;
      flushTraceBatch();
      items.push({
        type: 'message',
        message: cloneAssistantMessageWithContent(message, textBuffer),
        originalIndex: i,
      });
      textBuffer = [];
    };

    for (const block of blocks) {
      if (isTraceBlock(block)) {
        traceBuffer.push(block);
        continue;
      }

      if (isVisibleAssistantTextBlock(block)) {
        const isFinalResponseText =
          traceShape.hasTrace &&
          traceShape.finalTextMessagePos === turnPos &&
          isPositionAfterLastTrace(traceShape, turnPos, blocks.indexOf(block));

        if (isFinalResponseText || !traceShape.hasTrace) {
          flushTraceBuffer();
          textBuffer.push(block);
        } else {
          traceBuffer.push(block);
        }
      }
    }

    flushTraceBuffer();
    flushTextBuffer();
  }

  flushTraceBatch();

  return items;
}

function getTurnTraceShape(turnMessages: IndexedMessage[]): {
  hasTrace: boolean;
  lastTraceMessagePos: number;
  lastTraceBlockPos: number;
  finalTextMessagePos: number;
} {
  let hasTrace = false;
  let lastTraceMessagePos = -1;
  let lastTraceBlockPos = -1;

  for (let turnPos = 0; turnPos < turnMessages.length; turnPos += 1) {
    const { message } = turnMessages[turnPos];
    if (message.type !== 'assistant') continue;
    const blocks = getMessageContentBlocks(message);
    for (let blockPos = 0; blockPos < blocks.length; blockPos += 1) {
      if (isTraceBlock(blocks[blockPos])) {
        hasTrace = true;
        lastTraceMessagePos = turnPos;
        lastTraceBlockPos = blockPos;
      }
    }
  }

  let finalTextMessagePos = -1;
  if (hasTrace) {
    for (let turnPos = 0; turnPos < turnMessages.length; turnPos += 1) {
      const { message } = turnMessages[turnPos];
      if (message.type !== 'assistant') continue;
      const blocks = getMessageContentBlocks(message);
      if (
        blocks.some(
          (block, blockPos) =>
            isVisibleAssistantTextBlock(block) &&
            isPositionAfter(lastTraceMessagePos, lastTraceBlockPos, turnPos, blockPos)
        )
      ) {
        finalTextMessagePos = turnPos;
      }
    }
  }

  return { hasTrace, lastTraceMessagePos, lastTraceBlockPos, finalTextMessagePos };
}

function isPositionAfterLastTrace(
  shape: { lastTraceMessagePos: number; lastTraceBlockPos: number },
  messagePos: number,
  blockPos: number
): boolean {
  return isPositionAfter(
    shape.lastTraceMessagePos,
    shape.lastTraceBlockPos,
    messagePos,
    blockPos
  );
}

function isPositionAfter(
  leftMessagePos: number,
  leftBlockPos: number,
  rightMessagePos: number,
  rightBlockPos: number
): boolean {
  return (
    rightMessagePos > leftMessagePos ||
    (rightMessagePos === leftMessagePos && rightBlockPos > leftBlockPos)
  );
}
