#!/usr/bin/env node
// Live smoke for the Qoder SDK adapter — REAL SDK + real qodercli login.
// Not part of `npm test`: requires `qodercli login` on this machine and makes
// real (small) Qoder requests. Run after `npm run transpile:electron`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { QoderSdkAdapter } = require('../dist-electron/electron/libs/provider/qoder-sdk-adapter.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const adapter = new QoderSdkAdapter();
const events = [];
adapter.events.on('event', (event) => events.push(event));
const results = () => events.filter((e) => e.type === 'message' && e.message.type === 'result');

console.log('[smoke] startSession…');
const session = await adapter.startSession({
  provider: 'qoder',
  threadId: 'smoke-1',
  cwd: process.cwd(),
  prompt: 'Reply with exactly: AEGIS_QODER_SMOKE_OK',
});
console.log(`[smoke] init: providerSessionId=${session.providerSessionId} model=${session.model}`);

await waitFor(() => results().length === 1, 120_000, 'first result');
const first = results()[0].message;
console.log(`[smoke] turn 1: subtype=${first.subtype} duration=${first.duration_ms}ms usage=${JSON.stringify(first.usage)}`);
assert.equal(first.subtype, 'success', 'first turn must succeed (login present?)');

console.log('[smoke] sendTurn (resume context)…');
await adapter.sendTurn({ threadId: 'smoke-1', prompt: 'What exact string did I ask you to print? Answer with just the string.' });
await waitFor(() => results().length === 2, 120_000, 'second result');
const second = results()[1].message;
assert.equal(second.subtype, 'success');
const assistantTexts = events
  .filter((e) => e.type === 'message' && e.message.type === 'assistant')
  .map((e) => JSON.stringify(e.message.message?.content ?? ''))
  .join('\n');
assert.ok(assistantTexts.includes('AEGIS_QODER_SMOKE_OK'), 'second turn must recall the string (context continuity)');
console.log('[smoke] context continuity OK');

const catalog = adapter.getModelCatalog();
console.log(`[smoke] catalog: ${catalog?.models?.length ?? 0} models, default=${catalog?.defaultModel}`);
assert.ok((catalog?.models?.length ?? 0) > 0, 'model catalog must be populated');

console.log('[smoke] stopSession…');
await adapter.stopSession('smoke-1');
assert.equal(adapter.hasSession('smoke-1'), false);

console.log('\nverify-qoder-sdk-live: PASS');
process.exit(0);
