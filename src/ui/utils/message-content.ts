import type { ContentBlock, StreamMessage } from '../types';

function isContentBlock(value: unknown): value is ContentBlock {
  return !!value && typeof value === 'object' && 'type' in value;
}

export function getContentBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) {
    return content.filter(isContentBlock);
  }

  if (typeof content === 'string' && content.trim().length > 0) {
    return [{ type: 'text', text: content }];
  }

  return [];
}

export function getMessageContentBlocks(message: StreamMessage): ContentBlock[] {
  if (message.type !== 'assistant' && message.type !== 'user') {
    return [];
  }

  return getContentBlocks(message.message.content);
}
