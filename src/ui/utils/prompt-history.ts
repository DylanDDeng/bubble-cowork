import type { StreamMessage } from '../types';

/**
 * ArrowUp/ArrowDown prompt-history navigation state for the composer.
 *
 * `index === null` means not navigating. While navigating, `draft` holds the
 * text that was in the composer before the first ArrowUp so stepping past the
 * newest entry restores it, and `anchorId` holds the recalled entry's stable
 * id so the browse survives the history array shifting underneath it.
 */
export interface PromptHistoryNav {
  index: number | null;
  draft: string | null;
  anchorId: string | null;
}

export const EMPTY_PROMPT_HISTORY_NAV: PromptHistoryNav = {
  index: null,
  draft: null,
  anchorId: null,
};

export interface PromptHistoryEntry {
  text: string;
  /**
   * Stable identity of the source message — its createdAt timestamp (user
   * prompts carry no uuid; loads from storage backfill createdAt). For a
   * collapsed duplicate run this is the LAST message's id, which stays stable
   * when older messages get prepended in front of the run. Null for
   * degenerate/legacy messages without a timestamp.
   */
  id: string | null;
}

/**
 * The session's sent prompts, oldest → newest. Blank prompts are skipped and
 * consecutive duplicates collapse (re-sending the same text should not cost
 * two ArrowUp presses).
 */
export function collectPromptHistory(messages: StreamMessage[]): PromptHistoryEntry[] {
  const history: PromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.type !== 'user_prompt') continue;
    const text = message.prompt?.trim();
    if (!text) continue;
    const id = typeof message.createdAt === 'number' ? String(message.createdAt) : null;
    const last = history[history.length - 1];
    if (last?.text === text) {
      // Extend the collapsed run: keep it anchored to its last message.
      last.id = id ?? last.id;
      continue;
    }
    history.push({ text, id });
  }
  return history;
}

/**
 * ArrowUp may only enter/step history when the caret sits on the first line.
 * Newline-based fallback for when visual (soft-wrap) caret geometry is
 * unavailable — the editor's rect-based check takes precedence.
 */
export function isCursorOnFirstLine(text: string, cursorIndex: number): boolean {
  return !text.slice(0, Math.max(0, cursorIndex)).includes('\n');
}

/**
 * ArrowDown may only step forward when the caret sits on the last line.
 * Newline-based fallback, same as {@link isCursorOnFirstLine}.
 */
export function isCursorOnLastLine(text: string, cursorIndex: number): boolean {
  return !text.slice(Math.max(0, cursorIndex)).includes('\n');
}

/** Index of the matching entry nearest to `target`, or -1 when none match. */
function nearestMatchIndex(
  history: PromptHistoryEntry[],
  target: number,
  matches: (entry: PromptHistoryEntry) => boolean
): number {
  let nearest = -1;
  for (let index = 0; index < history.length; index += 1) {
    if (!matches(history[index])) {
      continue;
    }
    if (nearest === -1 || Math.abs(index - target) < Math.abs(nearest - target)) {
      nearest = index;
    }
  }
  return nearest;
}

/**
 * Re-anchor an active browse after the underlying history changed — older
 * messages are lazily prepended while the chat pane scrolls up, and a rewind
 * can drop entries — so a stored numeric index would drift onto the wrong
 * entry. The recalled entry is matched by its stable id; matching by text is
 * only a fallback for id-less legacy entries (text can repeat, e.g. when a
 * prepended older prompt duplicates the recalled one, so text alone could
 * re-anchor onto the wrong duplicate). Navigation exits only when the
 * recalled entry no longer exists at all.
 */
export function remapPromptHistoryNav(
  history: PromptHistoryEntry[],
  nav: PromptHistoryNav,
  recalledText: string | null
): PromptHistoryNav {
  if (nav.index === null) {
    return nav;
  }

  const anchored = history[nav.index];
  if (nav.anchorId !== null) {
    // Fast path: the anchored entry hasn't moved.
    if (anchored?.id === nav.anchorId) {
      return nav;
    }
    const byId = nearestMatchIndex(history, nav.index, (entry) => entry.id === nav.anchorId);
    if (byId !== -1) {
      return { ...nav, index: byId };
    }
  }

  // Fallback for id-less entries, or when a duplicate run's last-message id
  // changed (a re-send extended the run): match the recalled text nearest to
  // the old position.
  if (recalledText !== null) {
    if (nav.anchorId === null && anchored?.text === recalledText) {
      return nav;
    }
    const byText = nearestMatchIndex(history, nav.index, (entry) => entry.text === recalledText);
    if (byText !== -1) {
      return { ...nav, index: byText, anchorId: history[byText].id };
    }
  }

  return EMPTY_PROMPT_HISTORY_NAV;
}

export interface PromptHistoryStep {
  nav: PromptHistoryNav;
  text: string;
  /**
   * True when the browse hit the oldest entry and nothing changed: the caller
   * should swallow the key but must not re-apply the text or move the caret.
   */
  clamped?: boolean;
}

function stepTo(history: PromptHistoryEntry[], nav: PromptHistoryNav, index: number): PromptHistoryStep {
  return {
    nav: { ...nav, index, anchorId: history[index].id },
    text: history[index].text,
  };
}

/**
 * Step through history. Returns null when the key should NOT be consumed
 * (no history, not navigating on ArrowDown, or already at the oldest entry) —
 * the caller lets the caret move normally in that case.
 *
 * 'prev' (ArrowUp) stashes the current composer text as the draft on entry;
 * 'next' (ArrowDown) past the newest entry restores that draft and exits.
 */
export function stepPromptHistory(
  history: PromptHistoryEntry[],
  nav: PromptHistoryNav,
  direction: 'prev' | 'next',
  currentText: string
): PromptHistoryStep | null {
  if (direction === 'prev') {
    if (history.length === 0) {
      return null;
    }
    if (nav.index === null) {
      const index = history.length - 1;
      return stepTo(history, { ...nav, draft: currentText }, index);
    }
    // The stored index may briefly be stale if history changed since the last
    // remap — never index out of bounds.
    const boundedIndex = Math.min(nav.index, history.length - 1);
    if (boundedIndex > 0) {
      return stepTo(history, nav, boundedIndex - 1);
    }
    // Already at the oldest entry — swallow the key but change nothing, so
    // the caret doesn't jump while browsing. (Not clamped when the index was
    // out of bounds: the text does change then and must be applied.)
    return {
      ...stepTo(history, nav, boundedIndex),
      clamped: nav.index === boundedIndex,
    };
  }

  if (nav.index === null) {
    return null;
  }
  if (history.length === 0) {
    // Every entry disappeared mid-browse: restore the draft and exit.
    return { nav: EMPTY_PROMPT_HISTORY_NAV, text: nav.draft ?? '' };
  }
  const boundedIndex = Math.min(nav.index, history.length - 1);
  if (boundedIndex < history.length - 1) {
    return stepTo(history, nav, boundedIndex + 1);
  }
  // Past the newest entry: restore the stashed draft and exit history mode.
  return { nav: EMPTY_PROMPT_HISTORY_NAV, text: nav.draft ?? '' };
}
