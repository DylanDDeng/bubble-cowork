import assert from 'node:assert/strict';
import { useAppStore } from '../../src/ui/store/useAppStore';
import { extractTraceEntries, createStreamingWorkstreamModel } from '../../src/ui/utils/workstream';
import type { ServerEvent, StreamMessage } from '../../src/ui/types';

const id = useAppStore.getState().createDraftSession('/tmp/retry-test');
const read = () => useAppStore.getState().sessions[id];
const emit = (message: StreamMessage) => useAppStore.getState().handleServerEvent({
  type: 'stream.message', payload: { sessionId: id, message },
});
const status = (value: 'running' | 'idle' | 'error') => useAppStore.getState().handleServerEvent({
  type: 'session.status', payload: { sessionId: id, status: value },
} as ServerEvent);
const reset = () => useAppStore.setState(s => ({ sessions: { ...s.sessions, [id]: {
  ...s.sessions[id], provider: 'claude', status: 'running', messages: [],
  streaming: { text: '', thinking: '', isStreaming: false },
} } }));
const delta = (thinking: string): StreamMessage => ({ type: 'stream_event', event: {
  type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking },
} });
const retry = (attempt = 1): StreamMessage => ({ type: 'system', subtype: 'api_retry',
  uuid: `retry-${attempt}`, session_id: id, attempt, maxRetries: 10, delayMs: 500, errorStatus: null,
});
const snapshots = () => read().messages.filter(m => m.type === 'assistant' && m.interrupted);

reset();
emit(delta('Original thought'));
emit(retry()); // Flushes coalesced deltas before the retry boundary.
assert.equal(read().streaming.thinking, 'Original thought');
assert.equal(read().streaming.retry?.attempt, 1);
emit(retry(2));
assert.equal(read().streaming.thinking, 'Original thought');
assert.equal(read().streaming.retry?.attempt, 2);
assert.equal(snapshots().length, 0, 'waiting preserves the existing trace instead of remounting it');

for (const type of ['message_start', 'content_block_start', 'content_block_stop', 'message_stop']) {
  emit({ type: 'stream_event', event: { type, index: 0 } } as StreamMessage);
}
emit({ ...delta('Child output'), parentToolUseId: 'child' });
emit({ ...retry(8), parentToolUseId: 'child' });
assert.equal(read().streaming.thinking, 'Original thought');
assert.equal(read().streaming.retry?.attempt, 2, 'subagent traffic cannot resolve or replace the parent retry');

emit(delta('New attempt'));
status('running'); // Flush, without a timer.
assert.equal(read().streaming.thinking, 'New attempt', 'different attempts must not concatenate');
assert.equal(read().streaming.retry, undefined, 'first real output resolves the retry');
assert.equal(snapshots().length, 1);
assert.deepEqual(snapshots()[0].type === 'assistant' && snapshots()[0].message.content,
  [{ type: 'thinking', thinking: 'Original thought' }]);
const archived = snapshots().filter((m): m is StreamMessage & { type: 'assistant' } => m.type === 'assistant');
assert.equal(extractTraceEntries(archived, { partialThinking: 'Original' }).length, 2,
  'a restarted attempt with the same prefix is not deduplicated against interrupted output');
assert.equal(createStreamingWorkstreamModel({ partialThinking: 'Original', retrying: true, phase: 'thinking' })
  ?.entries[0].state, 'interrupted', 'retrying reasoning is not shown as actively thinking');
emit(delta(' continued'));
status('running');
assert.equal(snapshots().length, 1, 'archive exactly once');
emit(retry(3));
status('error');
assert.equal(read().streaming.retry, undefined);
assert.equal(snapshots().length, 2, 'failure keeps the interrupted attempt');

reset();
emit(delta('Cancelled thought'));
emit(retry());
status('idle');
assert.equal(snapshots().length, 1, 'stop during retry retains partial output');
assert.equal(read().streaming.retry, undefined);
status('running');
assert.equal(read().streaming.retry, undefined, 'new turn has no stale retry');

reset();
emit(delta('Committed thought'));
emit(retry());
emit({ type: 'assistant', uuid: 'commit', message: { content: [
  { type: 'thinking', thinking: 'Committed thought fully delivered' },
] } });
assert.equal(snapshots().length, 0, 'late full commit does not duplicate the partial');
assert.equal(read().streaming.retry, undefined);

reset();
emit(retry());
emit(delta(''));
status('running');
assert(read().streaming.retry, 'empty deltas do not signal recovery');
emit({ type: 'result', subtype: 'error', duration_ms: 100, total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 } });
assert.equal(read().streaming.retry, undefined, 'terminal result clears retry');
assert.equal(snapshots().length, 0, 'empty retry never creates empty transcript entries');

reset();
emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
  delta: { type: 'text_delta', text: 'Partial answer' } } });
emit(retry());
assert.equal(read().streaming.text, 'Partial answer', 'text is frozen as well as reasoning');
useAppStore.getState().handleServerEvent({ type: 'stream.user_prompt', payload: { sessionId: id, prompt: 'Try again' } });
assert.equal(snapshots().length, 1, 'a new prompt preserves the interrupted text before clearing retry');
assert.equal(read().streaming.retry, undefined);
assert.equal(read().messages.at(-1)?.type, 'user_prompt');
console.log('Claude retry: freeze, resume, separate attempts, subagents, stop, failure and late commit passed');
