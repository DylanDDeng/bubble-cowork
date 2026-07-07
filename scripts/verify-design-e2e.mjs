#!/usr/bin/env node
// Live end-to-end check of the design-mode write-back loop against a REAL
// Vite + React 18 + Tailwind v4 page:
//   inject inspector → click → fiber anchor → fingerprint resolve → plan →
//   write → HMR → measure in the page → reverse-patch rollback → measure.
//
// Standalone (not part of `npm test`): requires the agent-browser CLI and
// dev-fixtures/design-mode-demo dependencies (`npm install` there first).
// Usage: npm run verify:design-e2e

import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const fixtureDir = path.join(root, 'dev-fixtures', 'design-mode-demo');
const appFile = path.join(fixtureDir, 'src', 'App.tsx');
const PORT = 5199;
const URL_BASE = `http://localhost:${PORT}`;

assert.ok(existsSync(path.join(fixtureDir, 'node_modules')), 'fixture deps missing — run npm install in dev-fixtures/design-mode-demo');
assert.ok(existsSync(path.join(root, 'dist-electron')), 'dist-electron missing — run npm run transpile:electron first');

const { INSPECTOR_SCRIPT } = await import(pathToUrl('dist-electron/electron/libs/design-writeback/inspector-script.js'));
const { locateLineByFingerprint } = await import(pathToUrl('dist-electron/electron/libs/design-writeback/source-locator.js'));
const { computeWritebackPlan } = await import(pathToUrl('dist-electron/electron/libs/design-writeback/write-plan.js'));
const { applyReversePatch } = await import(pathToUrl('dist-electron/electron/libs/design-writeback/patch.js'));

function pathToUrl(rel) {
  return new URL(`file://${path.join(root, rel)}`).href;
}

function browserEval(js) {
  const out = execFileSync('agent-browser', ['eval', js], { encoding: 'utf8' }).trim();
  // agent-browser prints the JSON-encoded result on the last line.
  const lastLine = out.split('\n').filter(Boolean).pop() ?? 'null';
  return JSON.parse(lastLine);
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError}` : ''}`);
}

// ── 1. Dev server (reuse if already running) ────────────────────────────────
let viteProc = null;
const alreadyUp = await fetch(URL_BASE).then((res) => res.ok).catch(() => false);
if (!alreadyUp) {
  viteProc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: fixtureDir,
    stdio: 'ignore',
    detached: false,
  });
  await waitFor(() => fetch(URL_BASE).then((res) => res.ok).catch(() => false), 30000, 'vite dev server');
}

const originalContent = readFileSync(appFile, 'utf8');

try {
  // ── 2. Open page + inject inspector ──────────────────────────────────────
  execFileSync('agent-browser', ['open', URL_BASE], { encoding: 'utf8' });
  await waitFor(() => browserEval(`document.querySelector('button') ? 'yes' : ''`), 15000, 'page render');
  const injectResult = execFileSync('agent-browser', ['eval', INSPECTOR_SCRIPT], { encoding: 'utf8' });
  assert.ok(/injected/.test(injectResult), 'inspector injected');

  // ── 3. Click the button → drain the selection event ──────────────────────
  const events = browserEval(`(() => { document.querySelector('button').click(); return window.__aegisDesignDrain(); })()`);
  const parsedEvents = JSON.parse(events);
  const selected = parsedEvents.find((event) => event.kind === 'selected');
  assert.ok(selected, 'selection event emitted');
  const info = selected.info;
  assert.equal(info.tagName, 'button');
  assert.ok(info.source && info.source.tier === 'fiber', 'A-tier fiber source present (React 18 dev)');
  assert.ok(info.source.file.endsWith('src/App.tsx'), 'source file is the original tsx');

  // ── 4. Resolve anchor (fingerprint — fiber line is transform-stage) ──────
  const content = readFileSync(appFile, 'utf8');
  const fingerprint = locateLineByFingerprint(content, info.tagName, info.className);
  assert.ok(fingerprint.ok, `fingerprint resolves: ${fingerprint.ok ? '' : fingerprint.detail}`);

  // ── 5. Plan + write ───────────────────────────────────────────────────────
  const plan = computeWritebackPlan({
    filePath: appFile,
    fileContent: content,
    anchor: {
      line: fingerprint.line,
      tagName: info.tagName,
      siblingIndex: fingerprint.siblingIndex,
      classNameSnapshot: info.className,
    },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(plan.ok, `plan ok: ${plan.ok ? '' : plan.detail}`);
  assert.equal(plan.strategy, 'static');
  assert.deepEqual(plan.addedClasses, ['p-6']);
  writeFileSync(appFile, plan.newContent, 'utf8');

  // ── 6. HMR lands; measure the REAL page ──────────────────────────────────
  const measured = await waitFor(() => {
    const raw = browserEval(
      `(() => { const el = document.querySelector('button'); if (!el) return ''; const cs = getComputedStyle(el); return JSON.stringify({ cls: el.className, pt: cs.paddingTop }); })()`
    );
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state.cls.includes('p-6') && state.pt === '24px' ? state : null;
  }, 8000, 'HMR to apply p-6');
  assert.equal(measured.pt, '24px', 'computed padding hit the target on the live page');

  // ── 7. Reverse-patch rollback; page returns to baseline ──────────────────
  const undone = applyReversePatch(readFileSync(appFile, 'utf8'), plan.reversePatch);
  assert.ok(undone.ok, 'reverse patch applies');
  writeFileSync(appFile, undone.content, 'utf8');
  assert.equal(undone.content, originalContent, 'byte-exact restore');
  await waitFor(() => {
    const raw = browserEval(
      `(() => { const el = document.querySelector('button'); if (!el) return ''; return JSON.stringify({ pt: getComputedStyle(el).paddingTop }); })()`
    );
    if (!raw) return null;
    return JSON.parse(raw).pt === '8px' ? true : null;
  }, 8000, 'HMR to restore baseline');

  console.log('verify-design-e2e: OK (inject → select → fingerprint → write → HMR verified → rollback)');
} finally {
  // Restore the fixture no matter what.
  writeFileSync(appFile, originalContent, 'utf8');
  if (viteProc) viteProc.kill();
}
