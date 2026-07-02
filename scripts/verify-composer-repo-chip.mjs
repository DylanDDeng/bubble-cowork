#!/usr/bin/env node
// Verifies the Codex-style GitHub repo chip in the composer: pasting or typing
// a bare github.com/owner/repo URL renders an inline chip (GitHub icon +
// owner/repo) while the serialized prompt keeps the original URL. Compiles +
// runs the unit test, then does static wiring assertions.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 1. Static wiring checks.
const links = read('src/ui/utils/github-repo-links.ts');
assert.ok(
  links.includes('extractGitHubRepoTokens') && links.includes('splitTextIntoGitHubRepoSegments'),
  'github-repo-links must export the tokenizer and the segment splitter'
);

const segments = read('src/ui/utils/composer-segments.ts');
assert.ok(
  segments.includes("type: 'repo'") && segments.includes('splitTextIntoGitHubRepoSegments'),
  'composer segments must include the repo segment type expanded from text runs'
);

const editor = read('src/ui/components/ComposerPromptEditor.tsx');
assert.ok(
  editor.includes('createRepoNode') && editor.includes("segment.type === 'repo'"),
  'the prompt editor must render repo segments as chips'
);
assert.ok(
  editor.includes('composer-inline-chip--repo'),
  'the repo chip must use the shared inline-chip styling'
);
assert.ok(
  editor.includes('removeRepoTokenAdjacentToCursor'),
  'Backspace/Delete must remove a repo chip atomically'
);

const css = read('src/ui/index.css');
assert.ok(
  css.includes('.composer-inline-chip--repo') && css.includes('--composer-repo-chip-text'),
  'index.css must style the repo chip in light and dark themes'
);
assert.ok(
  css.split('--composer-repo-chip-text').length >= 3,
  'the repo chip text color must be defined for both themes'
);

// 2. Compile + run the unit test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-composer-repo-chip-'));
const tscBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);
const compile = spawnSync(
  tscBin,
  [
    '--target', 'ES2022',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--outDir', tmpDir,
    'scripts/tests/composer-repo-chip.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);
if (compile.status !== 0) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}
const run = spawnSync(
  process.execPath,
  [path.join(tmpDir, 'scripts', 'tests', 'composer-repo-chip.test.js')],
  { cwd: root, stdio: 'inherit' }
);
fs.rmSync(tmpDir, { recursive: true, force: true });
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

console.log('composer-repo-chip: wiring checks passed');
