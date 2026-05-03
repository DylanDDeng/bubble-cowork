import type { BuiltinChatMessage } from '../types';

const DEFAULT_MAX_CHARS = 480_000;
const TOOL_RESULT_KEEP_CHARS = 12_000;

export function estimateMessageChars(messages: BuiltinChatMessage[]): number {
  return JSON.stringify(messages).length;
}

export function projectMessages(
  messages: BuiltinChatMessage[],
  options: { maxChars?: number; keepRecentTurns?: number } = {}
): BuiltinChatMessage[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const keepRecentTurns = options.keepRecentTurns ?? 4;
  let projected = pruneLargeToolResults(messages);
  if (estimateMessageChars(projected) <= maxChars) {
    return projected;
  }

  const system = projected.find((message) => message.role === 'system');
  const recent = takeRecentTurns(projected.filter((message) => message.role !== 'system'), keepRecentTurns);
  const omitted = projected.length - recent.length - (system ? 1 : 0);
  projected = [
    ...(system ? [system] : []),
    {
      role: 'system',
      content: [
        `Older conversation history was compacted before this model call (${Math.max(0, omitted)} message(s) omitted).`,
        'Use project tools, memory_search, memory_read_summary, web_search, or web_fetch to recover needed details.',
      ].join('\n'),
    },
    ...recent,
  ];

  while (estimateMessageChars(projected) > maxChars && projected.length > 3) {
    projected.splice(1, 1);
  }
  return projected;
}

export function compactResidentHistory(
  messages: BuiltinChatMessage[],
  options: { maxChars?: number; maxMessages?: number; keepRecentTurns?: number } = {}
): BuiltinChatMessage[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxMessages = options.maxMessages ?? 160;
  const pruned = pruneLargeToolResults(messages);
  if (pruned.length <= maxMessages && estimateMessageChars(pruned) <= maxChars) {
    return pruned;
  }
  return projectMessages(pruned, {
    maxChars,
    keepRecentTurns: options.keepRecentTurns ?? 5,
  });
}

function pruneLargeToolResults(messages: BuiltinChatMessage[]): BuiltinChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') {
      return message;
    }
    if (message.content.length <= TOOL_RESULT_KEEP_CHARS) {
      return message;
    }
    return {
      ...message,
      content: [
        message.content.slice(0, Math.floor(TOOL_RESULT_KEEP_CHARS * 0.7)).trimEnd(),
        '',
        `[tool output truncated from ${message.content.length} chars to control context size]`,
        '',
        message.content.slice(-Math.floor(TOOL_RESULT_KEEP_CHARS * 0.3)).trimStart(),
      ].join('\n'),
    };
  });
}

function takeRecentTurns(messages: BuiltinChatMessage[], keepRecentTurns: number): BuiltinChatMessage[] {
  let userTurns = 0;
  let startIndex = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      userTurns += 1;
      if (userTurns >= keepRecentTurns) {
        startIndex = index;
        break;
      }
    }
  }
  const recent = messages.slice(startIndex);
  while (recent.length > 0 && recent[0].role === 'tool') {
    recent.shift();
  }
  return recent;
}

