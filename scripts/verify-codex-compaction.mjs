#!/usr/bin/env node
// Runtime check for the Codex auto-compaction pipeline: app-server
// notifications (`thread/compacted` + `contextCompaction` item) must surface
// as exactly one deduped `compact_boundary` StreamMessage carrying the last
// known context size, matching the Claude compaction card contract.
// Requires `npm run transpile:electron` to have produced dist-electron.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../dist-electron/electron/libs/provider/codex-adapter.js');

const adapter = new CodexAdapter('/nonexistent-codex-binary');
const manager = adapter.manager;

// Fake an active session pair (adapter threadId ↔ provider threadId) without
// spawning the codex process.
manager.sessions.set('thread-1', { providerThreadId: 'prov-1', status: 'ready' });
adapter.sessions.set('thread-1', {
  threadId: 'thread-1',
  providerThreadId: 'prov-1',
  status: 'running',
});

const messages = [];
adapter.events.on('event', (event) => {
  if (event.type === 'message') {
    messages.push(event.message);
  }
});

const notify = (method, params) => manager.handleNotification({ method, params });

// 1. Token usage arrives first — the compaction card reports this as preTokens.
// `total` is cumulative across the thread (can exceed the window many times
// over); `last` is the actual current context, and must win when present.
notify('thread/tokenUsage/updated', {
  threadId: 'prov-1',
  tokenUsage: {
    modelContextWindow: 272000,
    total: {
      inputTokens: 1250000,
      cachedInputTokens: 900000,
      outputTokens: 48000,
      reasoningOutputTokens: 9000,
      totalTokens: 1298000,
    },
    last: {
      inputTokens: 250000,
      cachedInputTokens: 200000,
      outputTokens: 8000,
      reasoningOutputTokens: 2000,
      totalTokens: 258000,
    },
  },
});

const usageMessages = () =>
  messages.filter((m) => m.type === 'system' && m.subtype === 'token_usage');
assert.equal(usageMessages().length, 1, 'token usage must surface as one system message');
assert.equal(
  usageMessages()[0].usage.totalTokens,
  258000,
  'token usage must report the current context (last), not the cumulative thread total'
);

// 2. Compaction completes: new-style item AND deprecated notification fire for
// the same compaction. Exactly one compact_boundary must come out.
notify('item/completed', {
  threadId: 'prov-1',
  item: { id: 'item_compact_1', type: 'contextCompaction' },
});
notify('thread/compacted', { threadId: 'prov-1', turnId: 'turn_1' });

const boundaries = () =>
  messages.filter((m) => m.type === 'system' && m.subtype === 'compact_boundary');

assert.equal(boundaries().length, 1, 'duplicate compaction channels must dedupe to one boundary');
const boundary = boundaries()[0];
assert.equal(boundary.compactMetadata.trigger, 'auto', 'codex compaction must report trigger=auto');
assert.equal(
  boundary.compactMetadata.preTokens,
  258000,
  'boundary must carry the last token_usage totalTokens as preTokens'
);
assert.ok(boundary.uuid, 'boundary must have a uuid');

// 3. A later, separate compaction (outside the dedupe window) must emit again.
manager.lastCompactionEmitAt.set('thread-1', Date.now() - 60_000);
notify('thread/compacted', { threadId: 'prov-1', turnId: 'turn_2' });
assert.equal(boundaries().length, 2, 'a later compaction must emit a new boundary');

// 4. Unknown provider thread ids must not emit anything.
notify('thread/compacted', { threadId: 'prov-unknown', turnId: 'turn_3' });
assert.equal(boundaries().length, 2, 'unknown threads must be ignored');

// 5. Older codex builds may omit `last` — fall back to `total` rather than
// dropping the update entirely.
notify('thread/tokenUsage/updated', {
  threadId: 'prov-1',
  tokenUsage: {
    modelContextWindow: 272000,
    total: {
      inputTokens: 100000,
      cachedInputTokens: 60000,
      outputTokens: 4000,
      reasoningOutputTokens: 1000,
      totalTokens: 104000,
    },
  },
});
assert.equal(usageMessages().length, 2, 'total-only token usage must still surface');
assert.equal(
  usageMessages()[1].usage.totalTokens,
  104000,
  'without `last`, token usage must fall back to `total`'
);

console.log('verify-codex-compaction: OK');
