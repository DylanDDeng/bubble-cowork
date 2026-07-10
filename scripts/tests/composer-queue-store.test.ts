import assert from 'node:assert/strict';
import {
  selectQueuedMessages,
  useComposerQueueStore,
  type QueuedComposerMessage,
} from '../../src/ui/store/useComposerQueueStore.ts';

function makeItem(id: string, text: string): QueuedComposerMessage {
  return {
    id,
    displayPrompt: text,
    effectivePrompt: text,
    attachments: [],
    references: {},
  };
}

const store = useComposerQueueStore.getState;

function testEnqueueKeepsOrderPerSession() {
  useComposerQueueStore.setState({ queues: {} });
  store().enqueue('s1', makeItem('a', 'first'));
  store().enqueue('s1', makeItem('b', 'second'));
  store().enqueue('s2', makeItem('c', 'other session'));

  const s1 = selectQueuedMessages(store(), 's1');
  assert.deepEqual(s1.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(selectQueuedMessages(store(), 's2').map((item) => item.id), ['c']);
}

function testTakeOneRemovesOnlyThatItem() {
  useComposerQueueStore.setState({ queues: {} });
  store().enqueue('s1', makeItem('a', 'first'));
  store().enqueue('s1', makeItem('b', 'second'));

  const taken = store().takeOne('s1', 'a');
  assert.equal(taken?.displayPrompt, 'first');
  assert.deepEqual(selectQueuedMessages(store(), 's1').map((item) => item.id), ['b']);

  // Double-take must be a no-op — the chip's Steer can only dispatch once.
  assert.equal(store().takeOne('s1', 'a'), null);
}

function testTakeAllDrainsAtomically() {
  useComposerQueueStore.setState({ queues: {} });
  store().enqueue('s1', makeItem('a', 'first'));
  store().enqueue('s1', makeItem('b', 'second'));

  const drained = store().takeAll('s1');
  assert.deepEqual(drained.map((item) => item.id), ['a', 'b']);
  // A second flush (e.g. duplicated status-transition effect) must see nothing.
  assert.deepEqual(store().takeAll('s1'), []);
}

function testSelectorReturnsStableEmpty() {
  useComposerQueueStore.setState({ queues: {} });
  const first = selectQueuedMessages(store(), 's-none');
  const second = selectQueuedMessages(store(), null);
  assert.equal(first, second, 'empty selections must share one array identity (no re-render churn)');
  assert.equal(first.length, 0);
}

testEnqueueKeepsOrderPerSession();
testTakeOneRemovesOnlyThatItem();
testTakeAllDrainsAtomically();
testSelectorReturnsStableEmpty();
console.log('composer-queue-store.test.ts: ok');
