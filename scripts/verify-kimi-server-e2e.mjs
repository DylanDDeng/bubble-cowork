#!/usr/bin/env node
// LIVE end-to-end smoke for the kimi server runtime: drives the compiled
// facade against the REAL `kimi server` daemon (requires an installed,
// logged-in Kimi Code CLI; submits two tiny real prompts).
// Not part of `npm test` — run manually: npm run transpile:electron && node scripts/verify-kimi-server-e2e.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  KimiAdapterFacade,
  KIMI_SERVER_ID_PREFIX,
} = require('../dist-electron/electron/libs/provider/kimi-adapter-facade.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

process.env.AEGIS_KIMI_RUNTIME = 'server';
const facade = new KimiAdapterFacade();
const events = [];
facade.events.on('event', (event) => events.push(event));
const messages = (type) =>
  events.filter((e) => e.type === 'message' && e.message.type === type).map((e) => e.message);

console.log('▶ live E2E: startSession + first turn');
const session = await facade.startSession({
  provider: 'kimi',
  threadId: 'e2e-thread',
  cwd: process.cwd(),
  prompt: 'Reply with exactly: E2E-OK',
  model: 'kimi-for-coding',
});
assert.ok(session.providerSessionId.startsWith(KIMI_SERVER_ID_PREFIX), 'provenance prefix stamped');
console.log(`  session: ${session.providerSessionId}`);

await waitFor(() => messages('result').length >= 1, 120_000, 'first turn result');
assert.equal(messages('result')[0].subtype, 'success');
const text = messages('assistant')
  .filter((m) => !m.streaming)
  .map((m) => m.message.content.find((b) => b.type === 'text')?.text || '')
  .join(' ');
assert.ok(text.includes('E2E-OK'), `assistant replied (${JSON.stringify(text.slice(0, 120))})`);
const usage = messages('system').find((m) => m.subtype === 'token_usage');
assert.ok(usage, 'token_usage emitted from WS');
assert.ok(usage.usage.contextWindow > 0, 'context ring has a window');
console.log(`  ✓ first turn ok; context ${usage.usage.totalTokens}/${usage.usage.contextWindow}`);

console.log('▶ live E2E: stop mid-turn settles confirmed');
await facade.sendTurn({
  threadId: 'e2e-thread',
  prompt: 'Count slowly from 1 to 500, one number per line.',
  model: 'kimi-for-coding',
});
await sleep(1_500);
const settlePromise = waitFor(
  () => events.find((e) => e.type === 'stop_settled'),
  15_000,
  'stop settle'
);
await facade.stopSession('e2e-thread');
const settle = await settlePromise;
assert.equal(settle.confirmed, true, 'stop confirmed by turn.ended(cancelled)');
console.log('  ✓ stop settled confirmed');

console.log('▶ live E2E: resume by provenance id');
const resumed = await facade.startSession({
  provider: 'kimi',
  threadId: 'e2e-thread',
  cwd: process.cwd(),
  prompt: '',
  resumeSessionId: session.providerSessionId,
});
assert.equal(resumed.providerSessionId, session.providerSessionId, 'same server session resumed');
console.log('  ✓ resume ok');

// Cleanup: archive the session, stop everything (kills the owned daemon).
const rawId = session.providerSessionId.slice(KIMI_SERVER_ID_PREFIX.length);
await facade.server.manager.archiveSession(rawId).catch(() => {});
await facade.stopAll();
console.log('\nE2E PASSED');
process.exit(0);
