#!/usr/bin/env node
// Source pins for the disposeSession contract (quiet errored-runner teardown).
// Runtime coverage lives in verify-qoder-sdk-adapter (fake SDK) and
// verify-opencode-sdk-adapter (fake serve manager + double-feed regression);
// grok/pi have no fake seam, so their dispose bodies are pinned at source
// level, as are the ipc-handlers call sites (ipc imports electron, so it can
// only be asserted at source level here).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function methodBlock(source, marker, label) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${label}: "${marker}" must exist`);
  // Next method at the same two-space indent bounds the block well enough
  // for containment pins.
  const rest = source.slice(start);
  const end = rest.search(/\n  (?:async |private |readonly |get |[a-zA-Z_]+\()/, 1);
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 4000);
}

// ── Contract: required method on the adapter + service interfaces ──────────
{
  const types = read('src/electron/libs/provider/types.ts');
  const adapterBlock = types.slice(types.indexOf('export interface ProviderAdapter'));
  assert.match(
    adapterBlock.slice(0, adapterBlock.indexOf('// Event stream')),
    /\n  disposeSession\(threadId: string\): boolean;/,
    'ProviderAdapter.disposeSession must be REQUIRED (optional recreates the forgot-a-provider hole)'
  );
  const serviceBlock = types.slice(types.indexOf('export interface ProviderService'));
  assert.match(
    serviceBlock,
    /disposeSession\(threadId: string\): boolean;/,
    'ProviderService.disposeSession must be declared'
  );
  ok('disposeSession is a required, synchronous (boolean) contract method');
}

// ── Service: sync body, boolean-gated binding removal, hasSession fallback ──
{
  const service = read('src/electron/libs/provider/service.ts');
  const block = methodBlock(service, 'disposeSession(threadId: string): boolean {', 'service');
  assert.ok(!block.includes('async disposeSession'), 'service dispose must stay synchronous by signature');
  assert.ok(!/\bawait\b/.test(block), 'service dispose must not await (sync map mutation is the race guard)');
  assert.match(block, /hasSession\(threadId\)/, 'binding-gone fallback must scan adapters by hasSession');
  assert.match(
    block,
    /if \(disposed\) \{[\s\S]{0,600}this\.directory\.remove\(threadId\);/,
    'directory binding may be removed ONLY on a true dispose (kimi/codex no-ops keep theirs)'
  );
  assert.match(block, /catch/, 'service dispose must never throw');
  ok('service.disposeSession: sync, never-throw, hasSession fallback, boolean-gated binding removal');
}

// ── agent-loop handle: dispose = disposeSession FIRST, then detach steps ────
{
  const agentLoop = read('src/electron/libs/agent-loop.ts');
  const block = methodBlock(agentLoop, 'dispose: () => {', 'agent-loop handle');
  const disposeIdx = block.indexOf('service.disposeSession(threadId)');
  const abortIdx = block.indexOf('abortController.abort()');
  const offIdx = block.indexOf("service.events.off('event', handleEvent)");
  assert.ok(disposeIdx >= 0 && abortIdx >= 0 && offIdx >= 0, 'dispose must run all three steps');
  assert.ok(
    disposeIdx < abortIdx && disposeIdx < offIdx,
    'disposeSession must run BEFORE forwarder teardown (permission_dismissed must reach the live listener)'
  );
  ok('handle.dispose ordering: adapter teardown before forwarder teardown');
}

// ── ipc-handlers: onError retires with dispose; stop-settled keeps detach ───
{
  const ipc = read('src/electron/ipc-handlers.ts');
  const onErrorIdx = ipc.indexOf('dispose, not abort: the session already errored');
  assert.ok(onErrorIdx >= 0, 'onError retirement comment must exist');
  assert.match(
    ipc.slice(onErrorIdx, onErrorIdx + 600),
    /handle\.dispose\?\.\(\);/,
    'onError retirement must call handle.dispose (detach alone leaks adapter resources)'
  );
  // Inverse pin: the codex stop-settled retirement site must STILL detach —
  // its adapter side is already clean and dispose semantics differ.
  const settleIdx = ipc.indexOf('detach it so its');
  assert.ok(settleIdx >= 0, 'codex stop-settled retirement comment must exist');
  assert.match(
    ipc.slice(settleIdx, settleIdx + 400),
    /stopHandle\.detach\?\.\(\);/,
    'codex stop-settled retirement must keep detach (do NOT sweep it into dispose)'
  );
  ok('onError → dispose; codex stop-settled → detach (inverse pin)');
}

// ── grok dispose: card dismissal, terminal cleanup, delete-before-kill ─────
{
  const grok = read('src/electron/libs/provider/grok-acp-adapter.ts');
  const block = methodBlock(grok, 'disposeSession(threadId: string): boolean {', 'grok');
  assert.match(block, /permission_dismissed/, 'grok dispose must dismiss stranded cards');
  assert.match(block, /outcome: 'cancelled'/, 'grok dispose must cancel the pending ACP request');
  assert.match(block, /cleanupTerminals\(session\)/, 'grok dispose must clean terminals');
  const deleteIdx = block.indexOf('this.sessions.delete(threadId)');
  const killIdx = block.indexOf("session.proc.kill('SIGTERM')");
  assert.ok(deleteIdx >= 0 && killIdx >= 0 && deleteIdx < killIdx, 'map delete must precede kill (exit-handler identity guard)');
  assert.ok(!block.includes('this.emit({ type: \'status_change\''), 'grok dispose must not emit status_change');
  // F5: a stale rejection from the killed proc must not emit into a
  // replacement session.
  const sendTurn = grok.slice(grok.indexOf('async sendTurn('));
  assert.match(
    sendTurn.slice(0, sendTurn.indexOf('async stopSession')),
    /this\.sessions\.get\(input\.threadId\) !== session/,
    'grok sendTurn catch must bail when the session was replaced (stale-rejection guard)'
  );
  ok('grok dispose: dismissals, cancelled respond, delete-before-kill, sendTurn stale guard');
}

// ── pi dispose: unsubscribe + dispose + delete, no emit ────────────────────
{
  const pi = read('src/electron/libs/provider/pi-sdk-adapter.ts');
  const block = methodBlock(pi, 'disposeSession(threadId: string): boolean {', 'pi');
  assert.match(block, /session\.unsubscribe\?\.\(\)/, 'pi dispose must unsubscribe');
  assert.match(block, /session\.session\.dispose\(\)/, 'pi dispose must dispose the SDK session');
  assert.match(block, /this\.sessions\.delete\(threadId\)/, 'pi dispose must drop the map entry');
  assert.ok(!block.includes('this.emit('), 'pi dispose must not emit');
  ok('pi dispose: unsubscribe + SDK dispose + delete, silent');
}

// ── Policy no-ops: codex + all three kimi classes return false ─────────────
{
  for (const file of [
    'src/electron/libs/provider/codex-adapter.ts',
    'src/electron/libs/provider/kimi-adapter-facade.ts',
    'src/electron/libs/provider/kimi-acp-adapter.ts',
    'src/electron/libs/provider/kimi-server-adapter.ts',
  ]) {
    const block = methodBlock(read(file), 'disposeSession(', file);
    assert.match(block, /return false;/, `${file} dispose must be a policy no-op returning false`);
    assert.ok(!block.includes('this.emit('), `${file} dispose must not emit`);
  }
  ok('codex + kimi (facade, acp, server) dispose are documented no-ops returning false');
}

console.log(`\nverify:provider-dispose OK (${passed} pins)`);
