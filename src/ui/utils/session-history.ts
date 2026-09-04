/**
 * A browser-style back/forward stack. Generic over the entry type: the app
 * tabs keep one of these per tab, holding the views visited in that tab.
 * Entries that stop being visitable (a deleted session, a removed board
 * task) stay in the stack and are skipped over when stepping.
 */
export interface HistoryState<T> {
  stack: T[];
  index: number;
}

export const SESSION_HISTORY_LIMIT = 50;

const strictEqual = <T,>(a: T, b: T): boolean => a === b;

export function pushSessionHistory<T>(
  stack: T[],
  index: number,
  entry: T,
  isSame: (a: T, b: T) => boolean = strictEqual
): HistoryState<T> {
  if (stack.length > 0 && index >= 0 && index < stack.length && isSame(stack[index], entry)) {
    return { stack, index };
  }

  const truncated = [...stack.slice(0, Math.max(index, -1) + 1), entry];
  const nextStack =
    truncated.length > SESSION_HISTORY_LIMIT
      ? truncated.slice(-SESSION_HISTORY_LIMIT)
      : truncated;
  return { stack: nextStack, index: nextStack.length - 1 };
}

export function stepSessionHistory<T>(
  stack: T[],
  index: number,
  direction: -1 | 1,
  isVisitable: (entry: T) => boolean
): { stack: T[]; index: number; entry: T } | null {
  let cursor = index + direction;
  while (cursor >= 0 && cursor < stack.length) {
    if (isVisitable(stack[cursor])) {
      return { stack, index: cursor, entry: stack[cursor] };
    }
    cursor += direction;
  }
  return null;
}

export function canMoveSessionHistory<T>(
  stack: T[],
  index: number,
  direction: -1 | 1,
  isVisitable: (entry: T) => boolean
): boolean {
  return stepSessionHistory(stack, index, direction, isVisitable) !== null;
}
