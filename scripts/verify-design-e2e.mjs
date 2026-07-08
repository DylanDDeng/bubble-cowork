#!/usr/bin/env node
// Live end-to-end check of the design-mode ANNOTATE loop against a real
// Vite + React 18 page:
//   inject inspector → click element → bubble appears → type a note →
//   submit → drain yields the annotate event with element context + geometry.
//
// Design mode is write-free (the agent is the only writer), so this e2e
// exercises intent capture, not file edits.
//
// Standalone (not part of `npm test`): requires the agent-browser CLI and
// dev-fixtures/design-mode-demo dependencies (`npm install` there first).
// Usage: npm run verify:design-e2e

import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const fixtureDir = path.join(root, 'dev-fixtures', 'design-mode-demo');
const PORT = 5199;
const URL_BASE = `http://localhost:${PORT}`;

assert.ok(existsSync(path.join(fixtureDir, 'node_modules')), 'fixture deps missing — run npm install in dev-fixtures/design-mode-demo');
assert.ok(existsSync(path.join(root, 'dist-electron')), 'dist-electron missing — run npm run transpile:electron first');

const { INSPECTOR_SCRIPT } = await import(
  new URL(`file://${path.join(root, 'dist-electron/electron/libs/design-writeback/inspector-script.js')}`).href
);

function browserEval(js) {
  const out = execFileSync('agent-browser', ['eval', js], { encoding: 'utf8' }).trim();
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

try {
  execFileSync('agent-browser', ['open', URL_BASE], { encoding: 'utf8' });
  await waitFor(() => browserEval(`document.querySelector('button') ? 'yes' : ''`), 15000, 'page render');
  const injectResult = execFileSync('agent-browser', ['eval', INSPECTOR_SCRIPT], { encoding: 'utf8' });
  assert.ok(/injected/.test(injectResult), 'inspector injected');

  const raw = browserEval(`(() => {
    document.querySelector('button').click();
    const selected = JSON.parse(window.__aegisDesignDrain());
    const bubble = document.querySelector('[data-aegis-ui]');
    const visible = bubble && bubble.style.display !== 'none';
    const input = bubble.querySelector('input');
    input.value = '把这个按钮改成绿色';
    bubble.querySelector('button').click();
    const events = JSON.parse(window.__aegisDesignDrain());
    const measure = JSON.parse(window.__aegisDesignMeasure());
    return JSON.stringify({ selected, visible, events, measure });
  })()`);
  const result = JSON.parse(raw);

  assert.ok(result.visible, 'annotate bubble visible after selection');
  const selectedEvent = result.selected.find((event) => event.kind === 'selected');
  assert.ok(selectedEvent, 'selection event emitted');
  assert.equal(selectedEvent.info.tagName, 'button');
  assert.ok(selectedEvent.info.source && selectedEvent.info.source.tier === 'fiber', 'A-tier fiber source present');

  const annotateEvent = result.events.find((event) => event.kind === 'annotate');
  assert.ok(annotateEvent, 'annotate event emitted on submit');
  assert.equal(annotateEvent.note, '把这个按钮改成绿色');
  assert.ok(annotateEvent.info.source.file.endsWith('src/App.tsx'), 'annotate carries element source');

  assert.ok(result.measure.found && result.measure.rect && result.measure.viewport, 'submit-time geometry available for cropping');

  console.log('verify-design-e2e: OK (inject → select → bubble → annotate event with context + geometry)');
} finally {
  if (viteProc) viteProc.kill();
}
