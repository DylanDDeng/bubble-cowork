// History page boundaries that budget only top-level messages.
//
// Subagent (Task) messages carry a parentToolUseId and never render as
// top-level transcript rows — they surface inside their Task's nested trace.
// If they consumed the page budget, one chatty Task could fill a reopened
// session's first page with invisible rows and push the visible prompt/Task
// row out of it. Instead, page boundaries count only top-level messages and
// let parented messages ride along with the slice they belong to (a subagent
// message always follows the top-level message that launched its Task).

interface PageableMessage {
  parentToolUseId?: string | null;
}

function isTopLevelMessage(message: PageableMessage): boolean {
  return !message.parentToolUseId;
}

/**
 * Walk backwards from `endExclusive` and return the index of the `count`-th
 * top-level message, i.e. the start of a page that contains `count` top-level
 * messages (plus any parented messages interleaved after them). Returns 0
 * when fewer top-level messages exist.
 */
export function startIndexForTopLevelCount(
  messages: PageableMessage[],
  endExclusive: number,
  count: number
): number {
  if (count <= 0) return Math.max(0, endExclusive);
  let remaining = count;
  for (let index = Math.min(endExclusive, messages.length) - 1; index >= 0; index -= 1) {
    if (isTopLevelMessage(messages[index])) {
      remaining -= 1;
      if (remaining === 0) return index;
    }
  }
  return 0;
}

/**
 * Walk forwards from `startInclusive` and return the exclusive end index of a
 * page containing `count` top-level messages. Parented messages trailing the
 * last counted top-level message ride along; the boundary lands right before
 * the next top-level message past the budget.
 */
export function endIndexAfterTopLevelCount(
  messages: PageableMessage[],
  startInclusive: number,
  count: number
): number {
  let remaining = count;
  for (let index = Math.max(0, startInclusive); index < messages.length; index += 1) {
    if (isTopLevelMessage(messages[index])) {
      if (remaining === 0) return index;
      remaining -= 1;
    }
  }
  return messages.length;
}
