import type { StreamMessage } from '../types';

/**
 * ArrowUp/ArrowDown prompt-history navigation state for the composer.
 *
 * `index === null` means not navigating. While navigating, `draft` holds the
 * text that was in the composer before the first ArrowUp so exiting the
 * browse restores it, and `anchorId` holds the recalled entry's stable id so
 * the browse survives the history array shifting underneath it.
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
   * Stable ids (createdAt timestamps — user prompts carry no uuid; loads from
   * storage backfill createdAt) of every source message collapsed into this
   * entry, oldest → newest. Anchoring matches against ALL of them, so a run
   * extended by a re-send still contains the previously stored anchor. Empty
   * for degenerate/legacy messages without a timestamp.
   */
  ids: string[];
}

/** The id a fresh step anchors to: the entry's newest source message. */
function entryAnchorId(entry: PromptHistoryEntry): string | null {
  return entry.ids.length > 0 ? entry.ids[entry.ids.length - 1] : null;
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
      // Extend the collapsed run with this message's id.
      if (id !== null) {
        last.ids.push(id);
      }
      continue;
    }
    history.push({ text, ids: id === null ? [] : [id] });
  }
  return history;
}

/**
 * ArrowUp may only ENTER history when the caret sits on the first line (once
 * a browse is active the arrows always step). Newline-based fallback for when
 * visual (soft-wrap) caret geometry is unavailable — the editor's rect-based
 * check takes precedence.
 */
export function isCursorOnFirstLine(text: string, cursorIndex: number): boolean {
  return !text.slice(0, Math.max(0, cursorIndex)).includes('\n');
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
 * entry.
 *
 * Anchored entries remap STRICTLY by id: prompt text can repeat, so when the
 * anchored message is gone the browse exits (the caller restores the draft)
 * instead of guessing among same-text duplicates from other turns. A run
 * extended by a re-send keeps matching because entries carry every collapsed
 * message id. Matching by text exists only for id-less legacy entries.
 */
export function remapPromptHistoryNav(
  history: PromptHistoryEntry[],
  nav: PromptHistoryNav,
  recalledText: string | null
): PromptHistoryNav {
  if (nav.index === null) {
    return nav;
  }

  const anchorId = nav.anchorId;
  if (anchorId !== null) {
    // Fast path: the anchored entry hasn't moved.
    if (history[nav.index]?.ids.includes(anchorId)) {
      return nav;
    }
    const byId = nearestMatchIndex(history, nav.index, (entry) => entry.ids.includes(anchorId));
    return byId === -1 ? EMPTY_PROMPT_HISTORY_NAV : { ...nav, index: byId };
  }

  if (recalledText !== null) {
    if (history[nav.index]?.text === recalledText) {
      return nav;
    }
    const byText = nearestMatchIndex(history, nav.index, (entry) => entry.text === recalledText);
    if (byText !== -1) {
      return { ...nav, index: byText, anchorId: entryAnchorId(history[byText]) };
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

function stepTo(
  history: PromptHistoryEntry[],
  nav: PromptHistoryNav,
  index: number
): PromptHistoryStep {
  return {
    nav: { ...nav, index, anchorId: entryAnchorId(history[index]) },
    text: history[index].text,
  };
}

/**
 * Step through history. Returns null when the key should NOT be consumed
 * (no history, or not navigating on ArrowDown) — the caller lets the caret
 * move normally in that case.
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
