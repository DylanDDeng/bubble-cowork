import assert from 'node:assert/strict';
import {
  claimQueueFlushOwner,
  hasQueueFlushOwner,
  releaseQueueFlushOwner,
  useComposerQueueStore,
} from '../../src/ui/store/useComposerQueueStore';

// Flush ownership: refcounted per session (split view binds two composers).
assert.equal(hasQueueFlushOwner('s1'), false);
claimQueueFlushOwner('s1');
claimQueueFlushOwner('s1');
releaseQueueFlushOwner('s1');
assert.equal(hasQueueFlushOwner('s1'), true, 'refcount keeps ownership while one composer remains');
releaseQueueFlushOwner('s1');
assert.equal(hasQueueFlushOwner('s1'), false, 'fully released');
releaseQueueFlushOwner('s1'); // over-release is harmless
assert.equal(hasQueueFlushOwner('s1'), false);

// takeAll drains atomically and in order — the store-level flush depends on
// both (a second flusher gets nothing; messages keep queue order).
const store = useComposerQueueStore.getState();
const item = (id: string) => ({
  id,
  displayPrompt: `p-${id}`,
  effectivePrompt: `e-${id}`,
  attachments: [],
  references: {},
});
store.enqueue('s2', item('a'));
store.enqueue('s2', item('b'));
const drained = useComposerQueueStore.getState().takeAll('s2');
assert.deepEqual(
  drained.map((entry) => entry.id),
  ['a', 'b'],
  'queue order preserved'
);
assert.equal(useComposerQueueStore.getState().takeAll('s2').length, 0, 'second drain gets nothing');

console.log('kimi-queue-flush store semantics OK');
