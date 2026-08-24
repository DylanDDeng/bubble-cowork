export type SessionHistoryEntry = string | null;

export interface SessionHistoryState {
  stack: SessionHistoryEntry[];
  index: number;
}

export const SESSION_HISTORY_LIMIT = 50;

export function pushSessionHistory(
  stack: SessionHistoryEntry[],
  index: number,
  entry: SessionHistoryEntry
): SessionHistoryState {
  if (stack.length > 0 && stack[index] === entry) {
    return { stack, index };
  }

  const truncated = [...stack.slice(0, Math.max(index, -1) + 1), entry];
  const nextStack =
    truncated.length > SESSION_HISTORY_LIMIT
      ? truncated.slice(-SESSION_HISTORY_LIMIT)
      : truncated;
  return { stack: nextStack, index: nextStack.length - 1 };
}

export function stepSessionHistory(
  stack: SessionHistoryEntry[],
  index: number,
  direction: -1 | 1,
  isVisitable: (entry: SessionHistoryEntry) => boolean
): { stack: SessionHistoryEntry[]; index: number; entry: SessionHistoryEntry } | null {
  let cursor = index + direction;
  while (cursor >= 0 && cursor < stack.length) {
    if (isVisitable(stack[cursor])) {
      return { stack, index: cursor, entry: stack[cursor] };
    }
    cursor += direction;
  }
  return null;
}

export function canMoveSessionHistory(
  stack: SessionHistoryEntry[],
  index: number,
  direction: -1 | 1,
  isVisitable: (entry: SessionHistoryEntry) => boolean
): boolean {
  return stepSessionHistory(stack, index, direction, isVisitable) !== null;
}
