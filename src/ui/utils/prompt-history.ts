import type { StreamMessage } from '../types';

/**
 * ArrowUp/ArrowDown prompt-history navigation state for the composer.
 *
 * `index === null` means not navigating. While navigating, `draft` holds the
 * text that was in the composer before the first ArrowUp, so stepping past
 * the newest entry restores it.
 */
export interface PromptHistoryNav {
  index: number | null;
  draft: string | null;
}

export const EMPTY_PROMPT_HISTORY_NAV: PromptHistoryNav = { index: null, draft: null };

/**
 * The session's sent prompts, oldest → newest. Blank prompts are skipped and
 * consecutive duplicates collapse (re-sending the same text should not cost
 * two ArrowUp presses).
 */
export function collectPromptHistory(messages: StreamMessage[]): string[] {
  const history: string[] = [];
  for (const message of messages) {
    if (message.type !== 'user_prompt') continue;
    const text = message.prompt?.trim();
    if (!text) continue;
    if (history[history.length - 1] === text) continue;
    history.push(text);
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

/**
 * Re-anchor an active browse after the underlying history changed — older
 * messages are lazily prepended while the chat pane scrolls up, and a rewind
 * can drop entries — so a stored numeric index would drift onto the wrong
 * entry. The recalled entry is matched by text; when the text repeats, the
 * occurrence nearest to the old index wins. Navigation exits only when the
 * recalled entry no longer exists at all.
 */
export function remapPromptHistoryNav(
  history: string[],
  nav: PromptHistoryNav,
  recalledText: string | null
): PromptHistoryNav {
  if (nav.index === null) {
    return nav;
  }
  if (recalledText === null) {
    // Browsing without a recalled entry is inconsistent state; exit safely.
    return EMPTY_PROMPT_HISTORY_NAV;
  }
  if (history[nav.index] === recalledText) {
    return nav;
  }

  let nearest = -1;
  for (let index = 0; index < history.length; index += 1) {
    if (history[index] !== recalledText) {
      continue;
    }
    if (nearest === -1 || Math.abs(index - nav.index) < Math.abs(nearest - nav.index)) {
      nearest = index;
    }
  }
  return nearest === -1 ? EMPTY_PROMPT_HISTORY_NAV : { ...nav, index: nearest };
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

/**
 * Step through history. Returns null when the key should NOT be consumed
 * (no history, not navigating on ArrowDown, or already at the oldest entry) —
 * the caller lets the caret move normally in that case.
 *
 * 'prev' (ArrowUp) stashes the current composer text as the draft on entry;
 * 'next' (ArrowDown) past the newest entry restores that draft and exits.
 */
export function stepPromptHistory(
  history: string[],
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
      return { nav: { index, draft: currentText }, text: history[index] };
    }
    // The stored index may briefly be stale if history changed since the last
    // remap — never index out of bounds.
    const boundedIndex = Math.min(nav.index, history.length - 1);
    if (boundedIndex > 0) {
      const index = boundedIndex - 1;
      return { nav: { ...nav, index }, text: history[index] };
    }
    // Already at the oldest entry — swallow the key but change nothing, so
    // the caret doesn't jump while browsing. (Not clamped when the index was
    // out of bounds: the text does change then and must be applied.)
    return {
      nav: { ...nav, index: boundedIndex },
      text: history[boundedIndex],
      clamped: nav.index === boundedIndex,
    };
  }

  if (nav.index === null) {
    return null;
  }
  if (history.length === 0) {
    // Every entry disappeared mid-browse: restore the draft and exit.
    return { nav: { index: null, draft: null }, text: nav.draft ?? '' };
  }
  const boundedIndex = Math.min(nav.index, history.length - 1);
  if (boundedIndex < history.length - 1) {
    const index = boundedIndex + 1;
    return { nav: { ...nav, index }, text: history[index] };
  }
  // Past the newest entry: restore the stashed draft and exit history mode.
  return { nav: { index: null, draft: null }, text: nav.draft ?? '' };
}
