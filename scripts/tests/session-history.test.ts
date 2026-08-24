import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canMoveSessionHistory,
  pushSessionHistory,
  SESSION_HISTORY_LIMIT,
  stepSessionHistory,
} from '../../src/ui/utils/session-history';

function visitable(alive: Set<string | null>) {
  return (entry: string | null) => alive.has(entry);
}

{
  const first = pushSessionHistory([], -1, 'a');
  assert.deepEqual(first.stack, ['a']);
  assert.equal(first.index, 0);

  const same = pushSessionHistory(first.stack, first.index, 'a');
  assert.equal(same.stack, first.stack, 'repeat visits must not grow the stack');
  assert.equal(same.index, 0);

  const second = pushSessionHistory(first.stack, first.index, 'b');
  assert.deepEqual(second.stack, ['a', 'b']);
  assert.equal(second.index, 1);
}

{
  const started = pushSessionHistory(['a', 'b', 'c'], 2, 'd');
  assert.deepEqual(started.stack, ['a', 'b', 'c', 'd']);

  const back = stepSessionHistory(started.stack, started.index, -1, () => true);
  assert.equal(back?.entry, 'c');
  const fromMiddle = pushSessionHistory(back!.stack, back!.index, 'e');
  assert.deepEqual(
    fromMiddle.stack,
    ['a', 'b', 'c', 'e'],
    'pushing after back must drop the forward branch'
  );
  assert.equal(fromMiddle.index, 3);
}

{
  const stack = ['a', 'gone', 'c'];
  const alive = visitable(new Set(['a', 'c', null]));
  const skipped = stepSessionHistory(stack, 2, -1, alive);
  assert.equal(skipped?.entry, 'a', 'back must skip deleted sessions');
  assert.equal(canMoveSessionHistory(stack, 0, -1, alive), false);
  assert.equal(canMoveSessionHistory(stack, 0, 1, alive), true);
}

{
  const stack = ['keep', null];
  const landing = stepSessionHistory(stack, 0, 1, (entry) => entry === null || entry === 'keep');
  assert.equal(landing?.entry, null, 'new-session landing is a real history entry');
}

{
  let state = { stack: [] as Array<string | null>, index: -1 };
  for (let i = 0; i < SESSION_HISTORY_LIMIT + 8; i += 1) {
    state = pushSessionHistory(state.stack, state.index, `s${i}`);
  }
  assert.equal(state.stack.length, SESSION_HISTORY_LIMIT);
  assert.equal(state.stack[0], 's8');
  assert.equal(state.stack.at(-1), `s${SESSION_HISTORY_LIMIT + 7}`);
}

async function main() {
  const sidebarSource = await readFile(
    new URL('../../src/ui/components/Sidebar.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    sidebarSource,
    /<SessionHistoryButtons/,
    'back/forward must live in the sidebar window chrome, next to the toggle'
  );

  const appSource = await readFile(new URL('../../src/ui/App.tsx', import.meta.url), 'utf8');
  assert.match(
    appSource,
    /sidebarCollapsed \? \(\s*<>\s*<SidebarHeaderTrigger/,
    'collapsed chat chrome must keep back/forward next to the sidebar toggle'
  );
  assert.doesNotMatch(
    appSource,
    /<SessionHistoryButtons \/>\s*<span className="truncate text-\[12px\]/,
    'back/forward must not sit beside the thread title'
  );

  const landingSource = await readFile(
    new URL('../../src/ui/components/NewSessionView.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    landingSource,
    /<SessionHistoryButtons/,
    'collapsed new-session chrome must keep back/forward next to the sidebar toggle'
  );

  const shortcutSource = await readFile(
    new URL('../../src/ui/hooks/useKeyboardShortcuts.ts', import.meta.url),
    'utf8'
  );
  assert.match(shortcutSource, /BracketLeft/, '⌘[ must go back through thread history');
  assert.match(shortcutSource, /BracketRight/, '⌘] must go forward through thread history');

  console.log('session-history tests passed');
}

void main();
