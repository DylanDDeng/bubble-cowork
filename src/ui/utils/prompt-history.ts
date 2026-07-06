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

/** ArrowUp may only enter/step history when the caret sits on the first line. */
export function isCursorOnFirstLine(text: string, cursorIndex: number): boolean {
  return !text.slice(0, Math.max(0, cursorIndex)).includes('\n');
}

/** ArrowDown may only step forward when the caret sits on the last line. */
export function isCursorOnLastLine(text: string, cursorIndex: number): boolean {
  return !text.slice(Math.max(0, cursorIndex)).includes('\n');
}

export interface PromptHistoryStep {
  nav: PromptHistoryNav;
  text: string;
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
    if (nav.index > 0) {
      const index = nav.index - 1;
      return { nav: { ...nav, index }, text: history[index] };
    }
    // Already at the oldest entry — swallow the key but change nothing, so
    // the caret doesn't jump to the text start while browsing.
    return { nav, text: history[nav.index] };
  }

  if (nav.index === null) {
    return null;
  }
  if (nav.index < history.length - 1) {
    const index = nav.index + 1;
    return { nav: { ...nav, index }, text: history[index] };
  }
  // Past the newest entry: restore the stashed draft and exit history mode.
  return { nav: { index: null, draft: null }, text: nav.draft ?? '' };
}
