import assert from 'node:assert/strict';
import {
  EMPTY_PROMPT_HISTORY_NAV,
  collectPromptHistory,
  isCursorOnFirstLine,
  isCursorOnLastLine,
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

console.log('prompt-history.test.ts passed');
