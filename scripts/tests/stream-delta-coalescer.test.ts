// Behavioral tests for the renderer-side stream delta coalescer (P1).
// Run via scripts/verify-stream-perf.mjs (ad-hoc tsc compile, node run).

import assert from 'node:assert/strict';
import { StreamDeltaCoalescer } from '../../src/ui/utils/stream-delta-coalescer';
import type { StreamMessage } from '../../src/ui/types';

type Emitted = { sessionId: string; message: StreamMessage };

/** Manual scheduler: collects callbacks; fire() runs and clears them. */
function createManualScheduler() {
  const scheduled: Array<{ callback: () => void; cancelled: boolean }> = [];
  return {
    schedule(callback: () => void, _ms: number): () => void {
      const entry = { callback, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    fire(): void {
      const pending = scheduled.splice(0);
      for (const entry of pending) {
        if (!entry.cancelled) {
          entry.callback();
        }
      }
    },
    liveCount(): number {
      return scheduled.filter((entry) => !entry.cancelled).length;
    },
  };
}

function textDelta(text: string, index = 0, parentToolUseId: string | null = null): StreamMessage {
  return {
    type: 'stream_event',
    parentToolUseId,
    event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  };
}

function thinkingDelta(thinking: string, index = 0): StreamMessage {
  return {
    type: 'stream_event',
    parentToolUseId: null,
    event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } },
  };
}

function blockStop(index = 0): StreamMessage {
  return {
    type: 'stream_event',
    parentToolUseId: null,
    event: { type: 'content_block_stop', index },
  };
}

function setup(options: { maxChars?: number } = {}) {
  const scheduler = createManualScheduler();
  const emitted: Emitted[] = [];
  const coalescer = new StreamDeltaCoalescer({
    maxChars: options.maxChars,
    schedule: scheduler.schedule,
  });
  coalescer.setEmitter((payload) => emitted.push(payload));
  return { scheduler, emitted, coalescer };
}

function deltaText(message: StreamMessage): string {
  if (message.type !== 'stream_event' || !message.event.delta) return '';
  return message.event.delta.text ?? message.event.delta.thinking ?? '';
}

// ── 1. Same-key deltas coalesce into a single emit on the timer deadline ────
{
  const { scheduler, emitted, coalescer } = setup();
  assert.equal(coalescer.push({ sessionId: 's1', message: textDelta('Hel') }), true);
  assert.equal(coalescer.push({ sessionId: 's1', message: textDelta('lo ') }), true);
  assert.equal(coalescer.push({ sessionId: 's1', message: textDelta('world') }), true);
  assert.equal(emitted.length, 0, 'nothing emits before the deadline');
  scheduler.fire();
  assert.equal(emitted.length, 1, 'one coalesced emit');
  assert.equal(deltaText(emitted[0].message), 'Hello world');
  assert.equal(coalescer.pendingSessionCount(), 0);
  scheduler.fire();
  assert.equal(emitted.length, 1, 'timer flush is idempotent');
}

// ── 2. Key change (index or delta type) flushes the previous run first ──────
{
  const { emitted, coalescer } = setup();
  coalescer.push({ sessionId: 's1', message: thinkingDelta('planning', 0) });
  coalescer.push({ sessionId: 's1', message: textDelta('answer', 1) });
  assert.equal(emitted.length, 1, 'thinking run flushed when text block starts');
  assert.equal(deltaText(emitted[0].message), 'planning');
  assert.equal(
    emitted[0].message.type === 'stream_event' && emitted[0].message.event.delta?.type,
    'thinking_delta'
  );
}

// ── 3. Non-coalescible message flushes the buffered tail BEFORE passthrough ─
{
  const { emitted, coalescer } = setup();
  coalescer.push({ sessionId: 's1', message: textDelta('tail') });
  const consumed = coalescer.push({ sessionId: 's1', message: blockStop() });
  assert.equal(consumed, false, 'content_block_stop passes through to the caller');
  assert.equal(emitted.length, 1, 'buffered tail flushed ahead of the stop');
  assert.equal(deltaText(emitted[0].message), 'tail');
}

// ── 4. discardSession drops the buffer without emitting (stop path) ─────────
{
  const { scheduler, emitted, coalescer } = setup();
  coalescer.push({ sessionId: 's1', message: textDelta('doomed') });
  coalescer.discardSession('s1');
  scheduler.fire();
  assert.equal(emitted.length, 0, 'discarded tail never emits — no ghost bubble');
  assert.equal(coalescer.pendingSessionCount(), 0);
}

// ── 5. maxChars triggers an immediate flush ──────────────────────────────────
{
  const { emitted, coalescer } = setup({ maxChars: 8 });
  coalescer.push({ sessionId: 's1', message: textDelta('12345') });
  assert.equal(emitted.length, 0);
  coalescer.push({ sessionId: 's1', message: textDelta('6789') });
  assert.equal(emitted.length, 1, 'size threshold flushes without waiting for the timer');
  assert.equal(deltaText(emitted[0].message), '123456789');
}

// ── 6. Sessions buffer independently ────────────────────────────────────────
{
  const { scheduler, emitted, coalescer } = setup();
  coalescer.push({ sessionId: 'a', message: textDelta('A1') });
  coalescer.push({ sessionId: 'b', message: textDelta('B1') });
  coalescer.push({ sessionId: 'a', message: textDelta('A2') });
  scheduler.fire();
  assert.equal(emitted.length, 2);
  const bySession = new Map(emitted.map((entry) => [entry.sessionId, deltaText(entry.message)]));
  assert.equal(bySession.get('a'), 'A1A2');
  assert.equal(bySession.get('b'), 'B1');
}

// ── 7. Subagent deltas are never buffered (defense in depth) ─────────────────
{
  const { emitted, coalescer } = setup();
  const consumed = coalescer.push({ sessionId: 's1', message: textDelta('sub', 0, 'toolu_1') });
  assert.equal(consumed, false, 'subagent stream_event passes through');
  assert.equal(emitted.length, 0);
  assert.equal(coalescer.pendingSessionCount(), 0);
}

// ── 8. Signature deltas pass through after flushing ─────────────────────────
{
  const { emitted, coalescer } = setup();
  coalescer.push({ sessionId: 's1', message: thinkingDelta('think') });
  const signatureMessage: StreamMessage = {
    type: 'stream_event',
    parentToolUseId: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  };
  const consumed = coalescer.push({ sessionId: 's1', message: signatureMessage });
  assert.equal(consumed, false);
  assert.equal(emitted.length, 1, 'thinking run flushed ahead of the signature delta');
}

// ── 9. flushAll flushes every session ────────────────────────────────────────
{
  const { emitted, coalescer } = setup();
  coalescer.push({ sessionId: 'a', message: textDelta('A') });
  coalescer.push({ sessionId: 'b', message: textDelta('B') });
  coalescer.flushAll();
  assert.equal(emitted.length, 2);
  assert.equal(coalescer.pendingSessionCount(), 0);
}

// ── 10. Timer cancel on early flush: no double emit ──────────────────────────
{
  const { scheduler, emitted, coalescer } = setup();
  coalescer.push({ sessionId: 's1', message: textDelta('once') });
  coalescer.flushSession('s1');
  assert.equal(emitted.length, 1);
  scheduler.fire();
  assert.equal(emitted.length, 1, 'cancelled deadline must not re-emit');
  assert.equal(scheduler.liveCount(), 0, 'timer cancelled on flush');
}

// ── 11. Interleaved same-key runs across a passthrough keep total order ──────
{
  const { emitted, coalescer } = setup();
  const order: string[] = [];
  coalescer.setEmitter((payload) => order.push(`flush:${deltaText(payload.message)}`));
  coalescer.push({ sessionId: 's1', message: textDelta('one') });
  const consumed = coalescer.push({ sessionId: 's1', message: blockStop() });
  if (!consumed) order.push('stop');
  coalescer.push({ sessionId: 's1', message: textDelta('two', 1) });
  coalescer.flushSession('s1');
  assert.deepEqual(order, ['flush:one', 'stop', 'flush:two']);
  assert.equal(emitted.length, 0, 'rebound emitter used');
}

console.log('stream-delta-coalescer tests passed');
