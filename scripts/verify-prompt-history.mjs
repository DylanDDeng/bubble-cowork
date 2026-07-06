#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

// ── Wiring assertions ────────────────────────────────────────────────────────

const promptInput = fs.readFileSync(
  path.join(root, 'src', 'ui', 'components', 'PromptInput.tsx'),
  'utf8'
);
assert.equal(
  promptInput.includes('stepPromptHistory(promptHistory, historyNavRef.current'),
  true,
  'PromptInput must navigate prompt history on arrow keys'
);
assert.equal(
  promptInput.includes('isCursorOnFirstLine(prompt, cursor)'),
  true,
  'ArrowUp must only trigger history when the caret is on the first line'
);
assert.equal(
  promptInput.includes("historyNavRef.current.index !== null &&\n        isCursorOnLastLine(prompt, cursor)"),
  true,
  'ArrowDown must only step while navigating and on the last line'
);
assert.equal(
  promptInput.includes('!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey'),
  true,
  'modified arrow keys must never trigger history navigation'
);

// History navigation must yield to the mention and slash menus, which consume
// the arrow keys earlier in the handler.
const historyIndex = promptInput.indexOf('stepPromptHistory(promptHistory');
const mentionIndex = promptInput.indexOf('projectFileMentions.moveSelection(-1)');
const slashIndex = promptInput.indexOf('capabilityMenu.moveSelection(-1)');
assert.equal(
  mentionIndex > -1 && slashIndex > -1 && historyIndex > mentionIndex && historyIndex > slashIndex,
  true,
  'menus must take priority over history navigation'
);

const editor = fs.readFileSync(
  path.join(root, 'src', 'ui', 'components', 'ComposerPromptEditor.tsx'),
  'utf8'
);
assert.equal(
  editor.includes('getCursorIndex: () =>'),
  true,
  'the composer editor must expose the caret position'
);

// ── Compile + run the unit test ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-prompt-history-'));
const tscBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);

const compile = spawnSync(
  tscBin,
  [
    '--target',
    'ES2022',
    '--module',
    'CommonJS',
    '--moduleResolution',
    'Node',
    '--jsx',
    'react-jsx',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict',
    '--noEmitOnError',
    'true',
    '--outDir',
    tmpDir,
    'scripts/tests/prompt-history.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);

if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

const testPath = path.join(tmpDir, 'scripts', 'tests', 'prompt-history.test.js');
const run = spawnSync(process.execPath, [testPath], { cwd: root, stdio: 'inherit' });
fs.rmSync(tmpDir, { recursive: true, force: true });

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

console.log('prompt-history: wiring checks passed');
