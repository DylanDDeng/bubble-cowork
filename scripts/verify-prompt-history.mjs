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
  promptInput.includes('caret.onFirstVisualLine ?? isCursorOnFirstLine(prompt, caret.index)'),
  true,
  'ArrowUp must gate on the first VISUAL line (soft wrap aware), with a newline fallback'
);
assert.equal(
  promptInput.includes('caret.onLastVisualLine ?? isCursorOnLastLine(prompt, caret.index)'),
  true,
  'ArrowDown must gate on the last VISUAL line (soft wrap aware), with a newline fallback'
);
assert.equal(
  promptInput.includes('e.shiftKey || e.altKey || e.metaKey || e.ctrlKey'),
  true,
  'modified arrow keys must never trigger history navigation'
);
assert.equal(
  promptInput.includes('!caret.collapsed'),
  true,
  'history navigation must require a collapsed selection'
);
assert.equal(
  promptInput.includes('step.clamped'),
  true,
  'a clamped step at the oldest entry must not re-apply text or move the caret'
);
assert.equal(
  promptInput.includes('value === historyAppliedTextRef.current'),
  true,
  'history-applied text must be exempt from long-prompt auto-attachment conversion'
);

// Arrow-key priority: while a browse is ACTIVE, history owns the arrows even
// if the recalled text re-opened the @-mention or slash menu; when idle, the
// menus keep priority and history only sees keys they did not consume.
const activeHistoryIndex = promptInput.indexOf('historyBrowseActive && handleHistoryArrowKey(e)');
const mentionIndex = promptInput.indexOf('projectFileMentions.moveSelection(-1)');
const slashIndex = promptInput.indexOf('capabilityMenu.moveSelection(-1)');
const idleHistoryIndex = promptInput.indexOf('!historyBrowseActive && handleHistoryArrowKey(e)');
assert.equal(
  activeHistoryIndex > -1 && mentionIndex > -1 && activeHistoryIndex < mentionIndex,
  true,
  'an active history browse must consume arrows before the mention/slash menus'
);
assert.equal(
  slashIndex > -1 && idleHistoryIndex > slashIndex,
  true,
  'when idle, menus must take priority over entering history'
);

const editor = fs.readFileSync(
  path.join(root, 'src', 'ui', 'components', 'ComposerPromptEditor.tsx'),
  'utf8'
);
assert.equal(
  editor.includes('getCaretInfo'),
  true,
  'the composer editor must expose caret info (index, collapsed, visual line)'
);
assert.equal(
  editor.includes('getCaretVisualLine'),
  true,
  'the composer editor must detect first/last visual line from caret rects'
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
