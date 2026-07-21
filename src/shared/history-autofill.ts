/**
 * Viewport-fill decision for paged session history.
 *
 * The transcript's only scroll-driven pagination trigger needs scroll events,
 * but a page of tool-heavy messages collapses into a few "Show work" rows and
 * can render shorter than the viewport — no scrollbar, no scroll events, and
 * older history becomes unreachable. This pure helper decides when to
 * auto-load the next older page instead, with two hard stops so a giant
 * single-turn session (whose pages add zero pixels) cannot quadratically
 * hydrate itself: a per-session page cap and a no-progress stall cap. Past
 * either cap the manual "Load earlier messages" affordance takes over.
 */

/** Auto-fill at most this many pages per session view. */
export const AUTO_FILL_MAX_PAGES = 3;
/** Stop after this many auto-loads that made no progress (failed IPC etc.). */
export const AUTO_FILL_MAX_STALLS = 3;
/** Content must exceed the viewport by more than this to count as overflowing. */
export const AUTO_FILL_OVERFLOW_EPSILON_PX = 4;

export interface AutoFillState {
  pages: number;
  stalls: number;
  lastMessageCount: number;
  lastCursor: string | null;
}

export function initialAutoFillState(): AutoFillState {
  return { pages: 0, stalls: 0, lastMessageCount: 0, lastCursor: null };
}

export interface AutoFillInput {
  hydrated: boolean;
  hasMoreHistory: boolean;
  loadingMoreHistory: boolean;
  scrollHeight: number;
  clientHeight: number;
  messageCount: number;
  historyCursor: string | null;
}

export function evaluateAutoFill(
  state: AutoFillState,
  input: AutoFillInput
): { load: boolean; nextState: AutoFillState } {
  if (!input.hydrated || !input.hasMoreHistory || input.loadingMoreHistory) {
    return { load: false, nextState: state };
  }
  if (input.scrollHeight > input.clientHeight + AUTO_FILL_OVERFLOW_EPSILON_PX) {
    // A scrollbar exists — the scroll-driven trigger is reachable again.
    return { load: false, nextState: state };
  }

  // Progress accounting for the load we previously dispatched: it counts
  // only when messages actually grew AND the cursor moved (a failed IPC
  // leaves both untouched).
  let stalls = state.stalls;
  if (state.pages > 0) {
    const progressed =
      input.messageCount > state.lastMessageCount && input.historyCursor !== state.lastCursor;
    stalls = progressed ? 0 : stalls + 1;
  }

  if (state.pages >= AUTO_FILL_MAX_PAGES || stalls >= AUTO_FILL_MAX_STALLS) {
    return { load: false, nextState: { ...state, stalls } };
  }

  return {
    load: true,
    nextState: {
      pages: state.pages + 1,
      stalls,
      lastMessageCount: input.messageCount,
      lastCursor: input.historyCursor,
    },
  };
}
