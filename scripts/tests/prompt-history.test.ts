import assert from 'node:assert/strict';
import {
  EMPTY_PROMPT_HISTORY_NAV,
  collectPromptHistory,
  isCursorOnFirstLine,
  isCursorOnLastLine,
  remapPromptHistoryNav,
  stepPromptHistory,
  type PromptHistoryEntry,
  type PromptHistoryNav,
} from '../../src/ui/utils/prompt-history';
import type { StreamMessage } from '../../src/shared/types';

const entries = (...pairs: [string, string | null][]): PromptHistoryEntry[] =>
  pairs.map(([text, id]) => ({ text, id }));

// ── collectPromptHistory ─────────────────────────────────────────────────────

{
  const messages: StreamMessage[] = [
    { type: 'user_prompt', prompt: 'first', createdAt: 100 },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'user_prompt', prompt: '  ', createdAt: 150 }, // blank → skipped
    { type: 'user_prompt', prompt: 'second', createdAt: 200 },
    { type: 'user_prompt', prompt: 'second', createdAt: 250 }, // consecutive duplicate → collapsed
    { type: 'user_prompt', prompt: 'third', createdAt: 300 },
    { type: 'user_prompt', prompt: 'second', createdAt: 400 }, // non-consecutive duplicate → kept
  ];
  assert.deepEqual(
    collectPromptHistory(messages),
    entries(['first', '100'], ['second', '250'], ['third', '300'], ['second', '400'])
  );
  assert.deepEqual(collectPromptHistory([]), []);

  // A collapsed duplicate run anchors to its LAST message (id '250' above),
  // so the id survives older messages being prepended in front of the run.
  // Messages without createdAt produce id-less entries.
  assert.deepEqual(collectPromptHistory([{ type: 'user_prompt', prompt: 'legacy' }]), [
    { text: 'legacy', id: null },
  ]);
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

const HISTORY = entries(['one', '1'], ['two', '2'], ['three', '3']);

{
  // No history → ArrowUp is not consumed.
  assert.equal(stepPromptHistory([], EMPTY_PROMPT_HISTORY_NAV, 'prev', 'draft'), null);
  // Not navigating → ArrowDown is not consumed.
  assert.equal(stepPromptHistory(HISTORY, EMPTY_PROMPT_HISTORY_NAV, 'next', 'draft'), null);
}

{
  // Entering history stashes the draft and anchors on the newest entry.
  const first = stepPromptHistory(HISTORY, EMPTY_PROMPT_HISTORY_NAV, 'prev', 'my draft');
  assert.ok(first);
  assert.equal(first.text, 'three');
  assert.deepEqual(first.nav, { index: 2, draft: 'my draft', anchorId: '3' });
  assert.equal(first.clamped ?? false, false);

  // Stepping back walks toward the oldest entry, draft preserved.
  const second = stepPromptHistory(HISTORY, first.nav, 'prev', first.text);
  assert.ok(second);
  assert.equal(second.text, 'two');
  assert.deepEqual(second.nav, { index: 1, draft: 'my draft', anchorId: '2' });

  const third = stepPromptHistory(HISTORY, second.nav, 'prev', second.text);
  assert.ok(third);
  assert.equal(third.text, 'one');
  assert.equal(third.nav.index, 0);
  assert.equal(third.nav.anchorId, '1');
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
  assert.equal(forward.nav.anchorId, '2');
  assert.equal(forward.clamped ?? false, false);

  // ...and past the newest entry the draft comes back and navigation ends.
  const toNewest = stepPromptHistory(HISTORY, forward.nav, 'next', forward.text);
  assert.ok(toNewest);
  assert.equal(toNewest.text, 'three');
  const restored = stepPromptHistory(HISTORY, toNewest.nav, 'next', toNewest.text);
  assert.ok(restored);
  assert.equal(restored.text, 'my draft');
  assert.deepEqual(restored.nav, { index: null, draft: null, anchorId: null });
}

{
  // An empty draft restores to an empty composer.
  const nav: PromptHistoryNav = { index: 2, draft: '', anchorId: '3' };
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
  const stable: PromptHistoryNav = { index: 1, draft: 'my draft', anchorId: '2' };
  assert.equal(remapPromptHistoryNav(HISTORY, stable, 'two'), stable);

  // Older prompts get PREPENDED while browsing (lazy history loading):
  // [one,two,three] → [old1,old2,one,two,three] shifts the entry from 1 to 3.
  const grown = [...entries(['old1', '01'], ['old2', '02']), ...HISTORY];
  assert.deepEqual(remapPromptHistoryNav(grown, stable, 'two'), {
    index: 3,
    draft: 'my draft',
    anchorId: '2',
  });

  // A prepended older prompt can DUPLICATE the recalled text: browsing
  // 'one'@0, prepend [one,x] → [one,x,one,two,three]. The stale index 0 still
  // reads 'one', but the id anchor re-targets the ORIGINAL entry at index 2.
  const dupedFront = [...entries(['one', '01'], ['x', '02']), ...HISTORY];
  const anchoredOne: PromptHistoryNav = { index: 0, draft: 'my draft', anchorId: '1' };
  assert.deepEqual(remapPromptHistoryNav(dupedFront, anchoredOne, 'one'), {
    index: 2,
    draft: 'my draft',
    anchorId: '1',
  });

  // Id-less legacy entries fall back to text matching: the occurrence nearest
  // to the old index wins.
  const withDupes = entries(['echo', null], ['a', null], ['b', null], ['echo', null], ['c', null]);
  assert.deepEqual(
    remapPromptHistoryNav(withDupes, { index: 4, draft: null, anchorId: null }, 'echo'),
    { index: 3, draft: null, anchorId: null }
  );

  // Text fallback also rescues an id whose duplicate run was extended by a
  // re-send (last-of-run id changed): re-anchors onto the new id.
  const extendedRun = entries(['one', '1'], ['two', '9'], ['three', '3']);
  const staleRunId: PromptHistoryNav = { index: 1, draft: null, anchorId: '2' };
  assert.deepEqual(remapPromptHistoryNav(extendedRun, staleRunId, 'two'), {
    index: 1,
    draft: null,
    anchorId: '9',
  });

  // Recalled entry vanished (e.g. rewind dropped it) → exit navigation.
  assert.deepEqual(
    remapPromptHistoryNav(HISTORY, { index: 1, draft: 'my draft', anchorId: 'gone' }, 'gone'),
    EMPTY_PROMPT_HISTORY_NAV
  );

  // Browsing without any anchor or recalled text is inconsistent → exit.
  assert.deepEqual(
    remapPromptHistoryNav(HISTORY, { index: 1, draft: 'my draft', anchorId: null }, null),
    EMPTY_PROMPT_HISTORY_NAV
  );
}

// ── Out-of-bounds safety when history shrinks mid-browse ────────────────────

{
  // A stale index past the end never reads out of bounds on ArrowUp...
  const stale: PromptHistoryNav = { index: 7, draft: 'my draft', anchorId: 'stale' };
  const prev = stepPromptHistory(HISTORY, stale, 'prev', 'whatever');
  assert.ok(prev);
  assert.equal(prev.text, 'two'); // bounded to the last entry, then stepped back
  assert.deepEqual(prev.nav, { index: 1, draft: 'my draft', anchorId: '2' });

  // ...nor on ArrowDown, which restores the draft and exits.
  const next = stepPromptHistory(HISTORY, stale, 'next', 'whatever');
  assert.ok(next);
  assert.equal(next.text, 'my draft');
  assert.equal(next.nav.index, null);

  // A stale index over a single-entry history applies that entry (not clamped:
  // the text changes and must be rendered).
  const single = stepPromptHistory(entries(['only', '5']), stale, 'prev', 'whatever');
  assert.ok(single);
  assert.equal(single.text, 'only');
  assert.equal(single.nav.index, 0);
  assert.equal(single.nav.anchorId, '5');
  assert.equal(single.clamped ?? false, false);

  // Every entry disappeared mid-browse → ArrowDown restores the draft.
  const emptied = stepPromptHistory([], stale, 'next', 'whatever');
  assert.ok(emptied);
  assert.equal(emptied.text, 'my draft');
  assert.equal(emptied.nav.index, null);
}

console.log('prompt-history.test.ts passed');
