import assert from 'node:assert/strict';
import {
  EMPTY_PROMPT_HISTORY_NAV,
  collectPromptHistory,
  isCursorOnFirstLine,
  isCursorOnLastLine,
  remapPromptHistoryNav,
  stepPromptHistory,
  type PromptHistoryNav,
} from '../../src/ui/utils/prompt-history';
import type { StreamMessage } from '../../src/shared/types';

// ── collectPromptHistory ─────────────────────────────────────────────────────

{
  const messages: StreamMessage[] = [
    { type: 'user_prompt', prompt: 'first' },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'user_prompt', prompt: '  ' }, // blank → skipped
    { type: 'user_prompt', prompt: 'second' },
    { type: 'user_prompt', prompt: 'second' }, // consecutive duplicate → collapsed
    { type: 'user_prompt', prompt: 'third' },
    { type: 'user_prompt', prompt: 'second' }, // non-consecutive duplicate → kept
  ];
  assert.deepEqual(collectPromptHistory(messages), ['first', 'second', 'third', 'second']);
  assert.deepEqual(collectPromptHistory([]), []);
}

// ── Cursor line helpers ──────────────────────────────────────────────────────

{
  const text = 'line one\nline two\nline three';
  assert.equal(isCursorOnFirstLine(text, 0), true);
  assert.equal(isCursorOnFirstLine(text, 8), true); // end of first line
  assert.equal(isCursorOnFirstLine(text, 9), false); // start of second line
  assert.equal(isCursorOnLastLine(text, text.length), true);
  assert.equal(isCursorOnLastLine(text, 19), true); // within last line
  assert.equal(isCursorOnLastLine(text, 5), false);
  // Single-line text: both are true everywhere.
  assert.equal(isCursorOnFirstLine('hello', 3), true);
  assert.equal(isCursorOnLastLine('hello', 3), true);
}

// ── stepPromptHistory ────────────────────────────────────────────────────────

const HISTORY = ['one', 'two', 'three'];

{
  // No history → ArrowUp is not consumed.
  assert.equal(stepPromptHistory([], EMPTY_PROMPT_HISTORY_NAV, 'prev', 'draft'), null);
  // Not navigating → ArrowDown is not consumed.
  assert.equal(stepPromptHistory(HISTORY, EMPTY_PROMPT_HISTORY_NAV, 'next', 'draft'), null);
}

{
  // Entering history stashes the draft and lands on the newest entry.
  const first = stepPromptHistory(HISTORY, EMPTY_PROMPT_HISTORY_NAV, 'prev', 'my draft');
  assert.ok(first);
  assert.equal(first.text, 'three');
  assert.deepEqual(first.nav, { index: 2, draft: 'my draft' });
  assert.equal(first.clamped ?? false, false);

  // Stepping back walks toward the oldest entry, draft preserved.
  const second = stepPromptHistory(HISTORY, first.nav, 'prev', first.text);
  assert.ok(second);
  assert.equal(second.text, 'two');
  assert.deepEqual(second.nav, { index: 1, draft: 'my draft' });

  const third = stepPromptHistory(HISTORY, second.nav, 'prev', second.text);
  assert.ok(third);
  assert.equal(third.text, 'one');
  assert.equal(third.nav.index, 0);
  assert.equal(third.clamped ?? false, false);

  // At the oldest entry the key is swallowed but nothing changes (no wrap);
  // the clamped flag tells the caller to skip re-applying text/caret.
  const clamped = stepPromptHistory(HISTORY, third.nav, 'prev', third.text);
  assert.ok(clamped);
  assert.equal(clamped.text, 'one');
  assert.equal(clamped.nav.index, 0);
  assert.equal(clamped.nav.draft, 'my draft');
  assert.equal(clamped.clamped, true);

  // Forward again...
  const forward = stepPromptHistory(HISTORY, clamped.nav, 'next', clamped.text);
  assert.ok(forward);
  assert.equal(forward.text, 'two');
  assert.equal(forward.clamped ?? false, false);

  // ...and past the newest entry the draft comes back and navigation ends.
  const toNewest = stepPromptHistory(HISTORY, forward.nav, 'next', forward.text);
  assert.ok(toNewest);
  assert.equal(toNewest.text, 'three');
  const restored = stepPromptHistory(HISTORY, toNewest.nav, 'next', toNewest.text);
  assert.ok(restored);
  assert.equal(restored.text, 'my draft');
  assert.deepEqual(restored.nav, { index: null, draft: null });
}

{
  // An empty draft restores to an empty composer.
  const nav: PromptHistoryNav = { index: 2, draft: '' };
  const restored = stepPromptHistory(HISTORY, nav, 'next', 'three');
  assert.ok(restored);
  assert.equal(restored.text, '');
  assert.equal(restored.nav.index, null);
}

// ── remapPromptHistoryNav ────────────────────────────────────────────────────

{
  // Not browsing → untouched.
  assert.deepEqual(
    remapPromptHistoryNav(HISTORY, EMPTY_PROMPT_HISTORY_NAV, null),
    EMPTY_PROMPT_HISTORY_NAV
  );

  // Entry still at the stored index → nav returned as-is.
  const stable: PromptHistoryNav = { index: 1, draft: 'my draft' };
  assert.equal(remapPromptHistoryNav(HISTORY, stable, 'two'), stable);

  // Older prompts get PREPENDED while browsing (lazy history loading):
  // [one,two,three] → [old1,old2,one,two,three] shifts the entry from 1 to 3.
  const grown = ['old1', 'old2', ...HISTORY];
  assert.deepEqual(remapPromptHistoryNav(grown, stable, 'two'), {
    index: 3,
    draft: 'my draft',
  });

  // Duplicate entries: the occurrence nearest to the old index wins.
  const withDupes = ['echo', 'a', 'b', 'echo', 'c'];
  assert.deepEqual(
    remapPromptHistoryNav(withDupes, { index: 4, draft: null }, 'echo'),
    { index: 3, draft: null }
  );

  // Recalled entry vanished (e.g. rewind dropped it) → exit navigation.
  assert.deepEqual(
    remapPromptHistoryNav(HISTORY, { index: 1, draft: 'my draft' }, 'gone'),
    EMPTY_PROMPT_HISTORY_NAV
  );

  // Browsing without a recalled entry is inconsistent → exit navigation.
  assert.deepEqual(
    remapPromptHistoryNav(HISTORY, { index: 1, draft: 'my draft' }, null),
    EMPTY_PROMPT_HISTORY_NAV
  );
}

// ── Out-of-bounds safety when history shrinks mid-browse ────────────────────

{
  // A stale index past the end never reads out of bounds on ArrowUp...
  const stale: PromptHistoryNav = { index: 7, draft: 'my draft' };
  const prev = stepPromptHistory(HISTORY, stale, 'prev', 'whatever');
  assert.ok(prev);
  assert.equal(prev.text, 'two'); // bounded to the last entry, then stepped back
  assert.deepEqual(prev.nav, { index: 1, draft: 'my draft' });

  // ...nor on ArrowDown, which restores the draft and exits.
  const next = stepPromptHistory(HISTORY, stale, 'next', 'whatever');
  assert.ok(next);
  assert.equal(next.text, 'my draft');
  assert.equal(next.nav.index, null);

  // A stale index over a single-entry history applies that entry (not clamped:
  // the text changes and must be rendered).
  const single = stepPromptHistory(['only'], stale, 'prev', 'whatever');
  assert.ok(single);
  assert.equal(single.text, 'only');
  assert.equal(single.nav.index, 0);
  assert.equal(single.clamped ?? false, false);

  // Every entry disappeared mid-browse → ArrowDown restores the draft.
  const emptied = stepPromptHistory([], stale, 'next', 'whatever');
  assert.ok(emptied);
  assert.equal(emptied.text, 'my draft');
  assert.equal(emptied.nav.index, null);
}

console.log('prompt-history.test.ts passed');
