#!/usr/bin/env node
// Paged-history reachability fixes:
//   1. viewport-fill auto-load (collapsed tool-heavy pages render shorter
//      than the viewport → no scrollbar → the scroll-driven loader was
//      unreachable), with page/stall caps via the pure shared helper;
//   2. "Load earlier messages" manual affordance (recovery past the caps,
//      hydration retry when hydration failed);
//   3. store-owned hydration with bounded retry (component refs never
//      retried and double-requested across the dead App.tsx twin);
//   4. sanitize page-safety (persisting a page slice truncated the whole
//      session history and deleted out-of-page artifacts).
// Requires `npm run transpile:electron` for the compiled helper test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ── Pure helper truth table ────────────────────────────────────────────────
{
  const {
    evaluateAutoFill,
    initialAutoFillState,
    AUTO_FILL_MAX_PAGES,
    AUTO_FILL_MAX_STALLS,
  } = require('../dist-electron/shared/history-autofill.js');

  const base = {
    hydrated: true,
    hasMoreHistory: true,
    loadingMoreHistory: false,
    scrollHeight: 400,
    clientHeight: 800,
    messageCount: 100,
    historyCursor: '253',
  };

  // Gates: each disqualifier alone blocks the load.
  for (const [label, patch] of [
    ['not hydrated', { hydrated: false }],
    ['no more history', { hasMoreHistory: false }],
    ['load in flight', { loadingMoreHistory: true }],
    ['content overflows', { scrollHeight: 900 }],
  ]) {
    const { load } = evaluateAutoFill(initialAutoFillState(), { ...base, ...patch });
    assert.equal(load, false, `${label} must not load`);
  }
  ok('gates: hydrated/hasMore/inFlight/overflow all block');

  // Short content + more history → load, state advances.
  let state = initialAutoFillState();
  let verdict = evaluateAutoFill(state, base);
  assert.equal(verdict.load, true);
  assert.equal(verdict.nextState.pages, 1);
  ok('short content with more history loads');

  // Progress (count grew + cursor moved) resets stalls and keeps loading up
  // to the page cap; the cap then halts auto-fill.
  state = verdict.nextState;
  let input = { ...base };
  for (let page = 2; page <= AUTO_FILL_MAX_PAGES; page += 1) {
    input = { ...input, messageCount: input.messageCount + 50, historyCursor: String(300 - page) };
    verdict = evaluateAutoFill(state, input);
    assert.equal(verdict.load, true, `page ${page} loads`);
    assert.equal(verdict.nextState.stalls, 0, 'progress resets stalls');
    state = verdict.nextState;
  }
  input = { ...input, messageCount: input.messageCount + 50, historyCursor: 'next' };
  verdict = evaluateAutoFill(state, input);
  assert.equal(verdict.load, false, 'page cap halts auto-fill');
  ok(`page cap (${AUTO_FILL_MAX_PAGES}) halts auto-fill`);

  // No progress (failed IPC: count and cursor unchanged) → stall counter
  // stops the loop even below the page cap.
  state = evaluateAutoFill(initialAutoFillState(), base).nextState;
  let halted = 0;
  for (let round = 0; round < AUTO_FILL_MAX_STALLS + 2; round += 1) {
    verdict = evaluateAutoFill(state, base); // unchanged input = no progress
    state = verdict.nextState;
    if (!verdict.load) {
      halted += 1;
    }
  }
  assert.ok(halted >= 2, 'stall cap must halt repeated no-progress loads');
  ok(`stall cap (${AUTO_FILL_MAX_STALLS}) halts failed-load retries`);
}

// ── Source pins ────────────────────────────────────────────────────────────
{
  const chatPane = read('src/ui/components/ChatPane.tsx');
  assert.match(chatPane, /evaluateAutoFill\(autoFillStateRef\.current/, 'ChatPane must use the pure auto-fill helper');
  const fillCall = chatPane.slice(chatPane.indexOf('evaluateAutoFill(autoFillStateRef.current'));
  assert.match(
    fillCall.slice(0, 900),
    /scrollHeightBeforeLoadRef\.current = container\.scrollHeight;\s*\n\s*loadOlderSessionHistory\(sessionId\)/,
    'auto-fill must set the prepend anchor before loading'
  );
  assert.match(chatPane, /Load earlier messages/, 'manual Load-earlier affordance must exist');
  assert.match(chatPane, /Retry loading history/, 'hydration-retry affordance must exist');
  assert.ok(!chatPane.includes('historyRequested'), 'component-level hydration dedupe ref must be gone');
  assert.match(chatPane, /requestSessionHydration\(sessionId\)/, 'ChatPane must hydrate via the store action');
  // Anchor hardening: the layout effect must NOT unconditionally zero the
  // prepend anchor (streaming re-runs wiped in-flight anchors).
  const layoutEffect = chatPane.slice(
    chatPane.indexOf('const previous = scrollUpdateStateRef.current;'),
    chatPane.indexOf('scrollUpdateStateRef.current = { key: scrollPositionKey, messageCount: count };')
  );
  assert.equal(
    (layoutEffect.match(/scrollHeightBeforeLoadRef\.current = 0;/g) || []).length,
    2,
    'prepend anchor is cleared only by the consuming/invalidating branches'
  );
  ok('ChatPane pins: helper wiring, anchor discipline, affordances, store hydration');

  const appSource = read('src/ui/App.tsx');
  for (const marker of ['loadOlderSessionHistory', 'historyRequested', 'scrollHeightBeforeLoadRef', 'handleScroll']) {
    assert.ok(!appSource.includes(marker), `App.tsx dead history twin must stay deleted (${marker})`);
  }
  ok('App.tsx dead scroll/hydration twin stays deleted');

  const store = read('src/ui/store/useAppStore.ts');
  assert.match(store, /requestSessionHydration: \(sessionId\) => \{/, 'store must own hydration');
  assert.match(store, /hydrationPending: true,/, 'hydration must single-flight');
  assert.match(store, /attempts < 2/, 'hydration auto-retry must be bounded');
  assert.match(store, /failed\.hydrationPending/, 'runner.error handling must gate on hydrationPending');
  ok('store pins: single-flight hydration with bounded retry');

  const ipc = read('src/electron/ipc-handlers.ts');
  const pageFn = ipc.slice(ipc.indexOf('function sanitizeStoredClaudeHistoryPage'));
  assert.match(
    pageFn.slice(0, 700),
    /sanitizeStoredClaudeHistory\(sessionId, sessions\.getSessionHistory\(sessionId\)\)/,
    'page sanitize must repair via FULL history (keeps the claude_session_id reset prewarm relies on)'
  );
  // The three paged endpoints must use the page-safe variant…
  for (const anchor of [
    "ipcMainHandle('load-older-session-history'",
    "'load-session-history-around'",
    'function handleSessionHistory(mainWindow',
  ]) {
    const block = ipc.slice(ipc.indexOf(anchor), ipc.indexOf(anchor) + 1600);
    assert.ok(
      block.includes('sanitizeStoredClaudeHistoryPage('),
      `paged endpoint must use the page-safe sanitize (${anchor})`
    );
    assert.ok(
      !block.includes('sanitizeStoredClaudeHistory(sessionId, page.messages)') &&
        !block.includes('sanitizeStoredClaudeHistory(sessionId, messages)'),
      `paged endpoint must not persist a page slice (${anchor})`
    );
  }
  // …while the full-history sites keep the persisting variant.
  const fullSiteCount = (ipc.match(/sanitizeStoredClaudeHistory\(sessionId, sessions\.getSessionHistory\(sessionId\)\)/g) || []).length;
  assert.ok(fullSiteCount >= 3, `full-history sanitize sites must remain (found ${fullSiteCount}, expect >= 3)`);
  ok('sanitize pins: page slices never persisted; full-history repair intact');
}

console.log(`\nverify:history-viewport-fill OK (${passed} checks)`);
