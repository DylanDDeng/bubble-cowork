import assert from 'node:assert/strict';
import { syncTitlesFromSessions, useBoardStore } from '../../src/ui/store/useBoardStore';
import type { SessionView } from '../../src/ui/types';

function session(id: string, title: string): SessionView {
  return { id, title } as unknown as SessionView;
}

useBoardStore.setState({ tasks: {}, selectedTaskId: null, excludedSessionIds: {} });
const { addTask, renameTask, updateTask } = useBoardStore.getState();

// A card materialized from a chat session starts under the draft placeholder
// and must pick up the generated title once the session is renamed.
const followingId = addTask({ title: 'New Chat', sessionId: 's-follow', titleFollowsSession: true });
// A board-authored task owns its title; the run's generated title must not touch it.
const authoredId = addTask({ title: 'inspect this project', sessionId: 's-authored' });
// A legacy card (no flag) still showing the placeholder was never renamed.
const legacyPlaceholderId = addTask({ title: 'New Chat', sessionId: 's-legacy-placeholder' });
// A legacy card with a real title might have been renamed; leave it alone.
const legacyTitledId = addTask({ title: 'hello', sessionId: 's-legacy-titled' });

const before = useBoardStore.getState().tasks[followingId];
syncTitlesFromSessions({
  's-follow': session('s-follow', '  看下这个项目在干嘛  '),
  's-authored': session('s-authored', 'generated title'),
  's-legacy-placeholder': session('s-legacy-placeholder', 'generated title'),
  's-legacy-titled': session('s-legacy-titled', 'generated title'),
});

let tasks = useBoardStore.getState().tasks;
assert.equal(tasks[followingId]?.title, '看下这个项目在干嘛', 'materialized card must follow the session title');
assert.equal(tasks[followingId]?.updatedAt, before?.updatedAt, 'a title follow must not reorder the card');
assert.equal(tasks[authoredId]?.title, 'inspect this project', 'board-authored titles must not follow');
assert.equal(tasks[legacyPlaceholderId]?.title, 'generated title', 'legacy placeholder cards must follow');
assert.equal(tasks[legacyTitledId]?.title, 'hello', 'legacy titled cards must not follow');

// Once the user renames a card it stops following, even if the session is renamed again.
renameTask(followingId, 'my own name');
syncTitlesFromSessions({ 's-follow': session('s-follow', 'another generated title') });
assert.equal(useBoardStore.getState().tasks[followingId]?.title, 'my own name');

// The same guard applies to the composer's title field.
updateTask(legacyPlaceholderId, { title: 'edited in composer' });
syncTitlesFromSessions({ 's-legacy-placeholder': session('s-legacy-placeholder', 'yet another') });
assert.equal(useBoardStore.getState().tasks[legacyPlaceholderId]?.title, 'edited in composer');

// The card mirrors the session that created it, not a later follow-up run.
const multiRunId = addTask({ title: 'New Chat', sessionId: 's-first', titleFollowsSession: true });
useBoardStore.getState().attachSession(multiRunId, 's-second');
syncTitlesFromSessions({
  's-first': session('s-first', 'first run title'),
  's-second': session('s-second', 'follow-up title'),
});
assert.equal(useBoardStore.getState().tasks[multiRunId]?.title, 'first run title');

// Sessions with no title yet, or one identical to the card, are a no-op.
const stateBefore = useBoardStore.getState().tasks;
syncTitlesFromSessions({ 's-first': session('s-first', '   ') });
assert.equal(useBoardStore.getState().tasks, stateBefore, 'blank session titles must not touch the store');

console.log('board title sync tests passed');
