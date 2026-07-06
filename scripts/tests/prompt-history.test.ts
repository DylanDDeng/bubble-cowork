import assert from 'node:assert/strict';
import {
  EMPTY_PROMPT_HISTORY_NAV,
  collectPromptHistory,
  isCursorOnFirstLine,
  remapPromptHistoryNav,
  stepPromptHistory,
  type PromptHistoryEntry,
  type PromptHistoryNav,
} from '../../src/ui/utils/prompt-history';
import type { Attachment, StreamMessage } from '../../src/shared/types';

const entries = (...pairs: [string, string[]][]): PromptHistoryEntry[] =>
  pairs.map(([text, ids]) => ({ text, ids }));

const FILE: Attachment = {
  id: 'att-1',
  path: '/tmp/spec.md',
  name: 'spec.md',
  size: 12,
  mimeType: 'text/markdown',
  kind: 'file',
};

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
  // A collapsed duplicate run carries ALL of its source message ids, so an
  // anchor stored before the run grows keeps matching afterwards.
  assert.deepEqual(
    collectPromptHistory(messages),
    entries(['first', ['100']], ['second', ['200', '250']], ['third', ['300']], ['second', ['400']])
  );
  assert.deepEqual(collectPromptHistory([]), []);

  // Messages without createdAt produce id-less entries.
  assert.deepEqual(collectPromptHistory([{ type: 'user_prompt', prompt: 'legacy' }]), [
    { text: 'legacy', ids: [] },
  ]);
}

// ── Cursor line helper (newline fallback for entering a browse) ─────────────

{
  const text = 'line one\nline two\nline three';
  assert.equal(isCursorOnFirstLine(text, 0), true);
  assert.equal(isCursorOnFirstLine(text, 8), true); // end of first line
  assert.equal(isCursorOnFirstLine(text, 9), false); // start of second line
  // Single-line text: true everywhere.
  assert.equal(isCursorOnFirstLine('hello', 3), true);
}

// ── stepPromptHistory ────────────────────────────────────────────────────────

const HISTORY = entries(['one', ['1']], ['two', ['2']], ['three', ['3']]);

{
  // No history → ArrowUp is not consumed.
  assert.equal(stepPromptHistory([], EMPTY_PROMPT_HISTORY_NAV, 'prev', 'draft', []), null);
  // Not navigating → ArrowDown is not consumed.
  assert.equal(stepPromptHistory(HISTORY, EMPTY_PROMPT_HISTORY_NAV, 'next', 'draft', []), null);
}

{
  // Entering history stashes the draft (text AND attachments), anchors on the
  // newest entry, and clears the attachment tray — recalled entries are
  // text-only, so a send must never carry the old draft's files.
  const first = stepPromptHistory(HISTORY, EMPTY_PROMPT_HISTORY_NAV, 'prev', 'my draft', [FILE]);
  assert.ok(first);
  assert.equal(first.text, 'three');
  assert.deepEqual(first.nav, {
    index: 2,
    draft: 'my draft',
    draftAttachments: [FILE],
    anchorId: '3',
  });
  assert.deepEqual(first.attachments, []);
  assert.equal(first.clamped ?? false, false);

  // Stepping back walks toward the oldest entry; the stash rides along and
  // mid-browse steps leave the (cleared) tray alone. Steps are line-agnostic:
  // multiline entries never block the walk (the component only gates the
  // caret line when ENTERING a browse).
  const second = stepPromptHistory(HISTORY, first.nav, 'prev', first.text, []);
  assert.ok(second);
  assert.equal(second.text, 'two');
  assert.deepEqual(second.nav, {
    index: 1,
    draft: 'my draft',
    draftAttachments: [FILE],
    anchorId: '2',
  });
  assert.equal(second.attachments, undefined);

  const third = stepPromptHistory(HISTORY, second.nav, 'prev', second.text, []);
  assert.ok(third);
  assert.equal(third.text, 'one');
  assert.equal(third.nav.index, 0);
  assert.equal(third.nav.anchorId, '1');
  assert.equal(third.clamped ?? false, false);

  // At the oldest entry the key is swallowed but nothing changes (no wrap);
  // the clamped flag tells the caller to skip re-applying text/caret.
  const clamped = stepPromptHistory(HISTORY, third.nav, 'prev', third.text, []);
  assert.ok(clamped);
  assert.equal(clamped.text, 'one');
  assert.equal(clamped.nav.index, 0);
  assert.equal(clamped.nav.draft, 'my draft');
  assert.equal(clamped.clamped, true);

  // Forward again...
  const forward = stepPromptHistory(HISTORY, clamped.nav, 'next', clamped.text, []);
  assert.ok(forward);
  assert.equal(forward.text, 'two');
  assert.equal(forward.nav.anchorId, '2');
  assert.equal(forward.clamped ?? false, false);

  // ...and past the newest entry the draft comes back — text and attachments
  // both — and navigation ends.
  const toNewest = stepPromptHistory(HISTORY, forward.nav, 'next', forward.text, []);
  assert.ok(toNewest);
  assert.equal(toNewest.text, 'three');
  const restored = stepPromptHistory(HISTORY, toNewest.nav, 'next', toNewest.text, []);
  assert.ok(restored);
  assert.equal(restored.text, 'my draft');
  assert.deepEqual(restored.attachments, [FILE]);
  assert.deepEqual(restored.nav, EMPTY_PROMPT_HISTORY_NAV);
}

{
  // Multiline history entries step through like any other entry.
  const multiline = entries(['alpha', ['1']], ['line1\nline2\nline3', ['2']], ['omega', ['3']]);
  const enter = stepPromptHistory(multiline, EMPTY_PROMPT_HISTORY_NAV, 'prev', 'draft', []);
  assert.ok(enter);
  assert.equal(enter.text, 'omega');
  const ontoMultiline = stepPromptHistory(multiline, enter.nav, 'prev', enter.text, []);
  assert.ok(ontoMultiline);
  assert.equal(ontoMultiline.text, 'line1\nline2\nline3');
  const pastMultiline = stepPromptHistory(
    multiline,
    ontoMultiline.nav,
    'prev',
    ontoMultiline.text,
    []
  );
  assert.ok(pastMultiline);
  assert.equal(pastMultiline.text, 'alpha');
}

{
  // An empty draft restores to an empty composer (and an empty tray).
  const nav: PromptHistoryNav = { index: 2, draft: '', draftAttachments: null, anchorId: '3' };
  const restored = stepPromptHistory(HISTORY, nav, 'next', 'three', []);
  assert.ok(restored);
  assert.equal(restored.text, '');
  assert.deepEqual(restored.attachments, []);
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
  const stable: PromptHistoryNav = {
    index: 1,
    draft: 'my draft',
    draftAttachments: null,
    anchorId: '2',
  };
  assert.equal(remapPromptHistoryNav(HISTORY, stable, 'two'), stable);

  // Older prompts get PREPENDED while browsing (lazy history loading):
  // [one,two,three] → [old1,old2,one,two,three] shifts the entry from 1 to 3.
  const grown = [...entries(['old1', ['01']], ['old2', ['02']]), ...HISTORY];
  assert.deepEqual(remapPromptHistoryNav(grown, stable, 'two'), {
    index: 3,
    draft: 'my draft',
    draftAttachments: null,
    anchorId: '2',
  });

  // A prepended older prompt can DUPLICATE the recalled text: browsing
  // 'one'@0, prepend [one,x] → [one,x,one,two,three]. The stale index 0 still
  // reads 'one', but the id anchor re-targets the ORIGINAL entry at index 2.
  // The attachment stash rides along untouched.
  const dupedFront = [...entries(['one', ['01']], ['x', ['02']]), ...HISTORY];
  const anchoredOne: PromptHistoryNav = {
    index: 0,
    draft: 'my draft',
    draftAttachments: [FILE],
    anchorId: '1',
  };
  assert.deepEqual(remapPromptHistoryNav(dupedFront, anchoredOne, 'one'), {
    index: 2,
    draft: 'my draft',
    draftAttachments: [FILE],
    anchorId: '1',
  });

  // A run extended by a re-send keeps matching: the entry accumulates the new
  // message id while still carrying the anchored one.
  const extendedRun = entries(['one', ['1']], ['two', ['2', '9']], ['three', ['3']]);
  assert.equal(remapPromptHistoryNav(extendedRun, stable, 'two'), stable);

  // Anchored entries never re-anchor by duplicate text: when the anchored
  // message vanished (rewind) the browse EXITS even though other entries have
  // identical text — continuing from a different turn would be wrong.
  const vanishedWithDupe = entries(['two', ['7']], ['x', ['8']], ['two', ['9']]);
  assert.deepEqual(
    remapPromptHistoryNav(
      vanishedWithDupe,
      { index: 1, draft: 'my draft', draftAttachments: null, anchorId: '2' },
      'two'
    ),
    EMPTY_PROMPT_HISTORY_NAV
  );

  // Id-less legacy entries fall back to text matching: the occurrence nearest
  // to the old index wins, and the nav re-anchors onto the found entry's id.
  const withDupes = entries(['echo', []], ['a', []], ['b', []], ['echo', ['5']], ['c', []]);
  assert.deepEqual(
    remapPromptHistoryNav(
      withDupes,
      { index: 4, draft: null, draftAttachments: null, anchorId: null },
      'echo'
    ),
    { index: 3, draft: null, draftAttachments: null, anchorId: '5' }
  );

  // Recalled entry vanished entirely → exit navigation.
  assert.deepEqual(
    remapPromptHistoryNav(
      HISTORY,
      { index: 1, draft: 'my draft', draftAttachments: null, anchorId: 'gone' },
      'gone'
    ),
    EMPTY_PROMPT_HISTORY_NAV
  );

  // Browsing without any anchor or recalled text is inconsistent → exit.
  assert.deepEqual(
    remapPromptHistoryNav(
      HISTORY,
      { index: 1, draft: 'my draft', draftAttachments: null, anchorId: null },
      null
    ),
    EMPTY_PROMPT_HISTORY_NAV
  );
}

// ── Out-of-bounds safety when history shrinks mid-browse ────────────────────

{
  // A stale index past the end never reads out of bounds on ArrowUp...
  const stale: PromptHistoryNav = {
    index: 7,
    draft: 'my draft',
    draftAttachments: [FILE],
    anchorId: 'stale',
  };
  const prev = stepPromptHistory(HISTORY, stale, 'prev', 'whatever', []);
  assert.ok(prev);
  assert.equal(prev.text, 'two'); // bounded to the last entry, then stepped back
  assert.deepEqual(prev.nav, {
    index: 1,
    draft: 'my draft',
    draftAttachments: [FILE],
    anchorId: '2',
  });

  // ...nor on ArrowDown, which restores the draft (and its attachments) and
  // exits.
  const next = stepPromptHistory(HISTORY, stale, 'next', 'whatever', []);
  assert.ok(next);
  assert.equal(next.text, 'my draft');
  assert.deepEqual(next.attachments, [FILE]);
  assert.equal(next.nav.index, null);

  // A stale index over a single-entry history applies that entry (not clamped:
  // the text changes and must be rendered).
  const single = stepPromptHistory(entries(['only', ['5']]), stale, 'prev', 'whatever', []);
  assert.ok(single);
  assert.equal(single.text, 'only');
  assert.equal(single.nav.index, 0);
  assert.equal(single.nav.anchorId, '5');
  assert.equal(single.clamped ?? false, false);

  // Every entry disappeared mid-browse → ArrowDown restores the full draft.
  const emptied = stepPromptHistory([], stale, 'next', 'whatever', []);
  assert.ok(emptied);
  assert.equal(emptied.text, 'my draft');
  assert.deepEqual(emptied.attachments, [FILE]);
  assert.equal(emptied.nav.index, null);
}

console.log('prompt-history.test.ts passed');
