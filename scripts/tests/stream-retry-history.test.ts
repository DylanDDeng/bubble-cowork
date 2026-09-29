import assert from 'node:assert/strict';
import { StreamRetryTracker } from '../../src/electron/libs/stream-retry-tracker';
import { restoreRetryHistory } from '../../src/ui/utils/stream-retry';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import { useAppStore } from '../../src/ui/store/useAppStore';
import type { StreamMessage } from '../../src/shared/types';

const id = useAppStore.getState().createDraftSession('/tmp/retry-history');
const attribution = { agentId: 'profile', agentRunId: 'run-profile' };
const tracker = new StreamRetryTracker();
let stored: StreamMessage[] = [];
const send = (message: StreamMessage) => useAppStore.getState().handleServerEvent({
  type: 'stream.message', payload: { sessionId: id, message },
});
const emit = (message: StreamMessage) => {
  const output = tracker.observe(message, attribution);
  for (const event of [output.resolved, output.message]) {
    if (!event) continue;
    if (event.type !== 'stream_event') stored.push(JSON.parse(JSON.stringify(event)));
    send(event);
  }
};
const reload = (status: 'running' | 'error' | 'idle' = 'running', messages = stored) => {
  useAppStore.getState().handleServerEvent({ type: 'session.history', payload: {
    sessionId: id, status, messages: JSON.parse(JSON.stringify(messages)),
  } });
};
const read = () => useAppStore.getState().sessions[id];
const snapshots = () => read().messages.filter(m => m.type === 'assistant' && m.interrupted);
const delta = (thinking: string): StreamMessage => ({ type: 'stream_event', event: {
  type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking },
} });
const retry = (attempt: number): StreamMessage => ({ type: 'system', subtype: 'api_retry',
  uuid: `retry-${attempt}`, session_id: id, attempt, maxRetries: 10, delayMs: 500, errorStatus: null,
});
const reset = () => { tracker.reset(); stored = []; reload(); };

reset();
emit({ type: 'user_prompt', prompt: 'work', createdAt: 100 });
emit({ type: 'assistant', uuid: 'before', createdAt: 1000, ...attribution,
  message: { content: [{ type: 'thinking', thinking: 'Earlier reasoning', signature: 'signed' }] } });
emit(delta('Interrupted reasoning'));
emit(retry(1));
emit(retry(2));
reload();
assert.equal(read().streaming.retry?.attempt, 2, 'reopening a running task restores retry');
assert.equal(read().streaming.thinking, 'Interrupted reasoning', 'frozen content survives hydration');
assert.equal(snapshots().length, 0, 'frozen content appears once, as the live trace');
assert.equal(read().streaming.retry?.snapshot?.agentRunId, attribution.agentRunId);

// Neither transport bookkeeping nor background completion is a recovered response.
const historyLength = stored.length;
emit({ type: 'user', uuid: 'tool-result', message: { content: [
  { type: 'tool_result', tool_use_id: 'background', content: 'finished' },
] } });
emit({ ...delta('child'), parentToolUseId: 'child' });
emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
assert.equal(read().streaming.retry?.attempt, 2);
assert(!stored.slice(historyLength).some(m => m.type === 'system' && m.subtype === 'api_retry_resolved'));
reload();
assert.equal(read().streaming.retry?.attempt, 2, 'background result cannot hide retry in history either');

// Recovery must be persisted even if no complete assistant message has landed yet.
emit(delta('Recovered reasoning'));
assert(stored.some(m => m.type === 'system' && m.subtype === 'api_retry_resolved'));
reload();
assert.equal(read().streaming.retry, undefined, 'reopening after recovery never resurrects stale retry');
assert.equal(snapshots().length, 1, 'consecutive retries restore one interrupted attempt');
assert.equal(snapshots()[0].agentRunId, attribution.agentRunId);
assert(!stored.some(m => m.type === 'assistant' && m.interrupted), 'unsigned snapshots are system metadata, not replayable assistant messages');

emit({ type: 'assistant', uuid: 'after', ...attribution, phase: 'final_answer',
  message: { content: [{ type: 'text', text: 'Done' }] } });
emit({ type: 'result', subtype: 'success', duration_ms: 1000, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
reload('idle');
const timeline = deriveTranscriptTimelineItems(read().messages, { sessionRunning: false, activeTurnStartIndex: 0 });
const groups = timeline.filter(i => i.type === 'work');
assert.equal(groups.length, 1, 'profile attribution keeps the entire turn in one work group');
assert(groups[0].canCollapse, 'completed trace can collapse normally');

// Already-restored pages can be normalized again without duplicating snapshots.
const restored = restoreRetryHistory(stored, 'idle');
const twice = restoreRetryHistory(restored.messages, 'idle');
assert.equal(twice.messages.filter(m => m.type === 'assistant' && m.interrupted).length, 1);
const retryIndex = stored.findIndex(m => m.type === 'system' && m.subtype === 'api_retry' && m.attempt === 2);
const partialPage = restoreRetryHistory(stored.slice(retryIndex), 'idle');
assert.equal(partialPage.messages.filter(m => m.type === 'assistant' && m.interrupted).length, 1,
  'later retry carries the snapshot even when the first attempt falls outside the history page');

for (const terminal of ['error', 'idle'] as const) {
  reset(); emit(delta('Preserved at stop')); emit(retry(1)); reload(terminal);
  assert.equal(snapshots().length, 1);
  assert.equal(read().streaming.retry, undefined);
}

reset(); emit(delta('Late commit')); emit(retry(1));
emit({ type: 'assistant', uuid: 'late', ...attribution, message: { content: [
  { type: 'thinking', thinking: 'Late commit with complete text', signature: 'valid' },
] } });
reload();
assert.equal(snapshots().length, 0, 'late full commit removes duplicate snapshot in persisted history too');
assert.equal(read().streaming.retry, undefined);

reset(); emit(retry(1)); reload();
assert.equal(read().streaming.retry?.attempt, 1, 'retry without partial output is still visible');
assert.equal(snapshots().length, 0);
emit({ type: 'user_prompt', prompt: 'new task' }); reload();
assert.equal(read().streaming.retry, undefined, 'new prompt starts without stale retry');

reset(); emit(delta('First attempt')); emit(retry(1));
emit(delta('Second attempt')); emit(retry(2)); reload();
assert.equal(snapshots().length, 1, 'earlier interrupted attempts stay visible during a later retry');
assert.equal(read().streaming.thinking, 'Second attempt');
reload('error');
assert.equal(snapshots().length, 2, 'multiple attempts each survive reopening a failed task');

// Support existing installations whose recorded retries have no snapshots/markers.
reload('running', [retry(5)]);
assert.equal(read().streaming.retry?.attempt, 5);
reload('running', [retry(5), { type: 'assistant', uuid: 'old-complete', message: { content: [{ type: 'text', text: 'done' }] } }]);
assert.equal(read().streaming.retry, undefined);
console.log('retry history: persisted recovery, snapshots, profiles, pagination, background events, stop and legacy history passed');
