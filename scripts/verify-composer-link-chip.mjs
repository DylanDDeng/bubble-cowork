#!/usr/bin/env node
// Verifies the Codex-style known-site link chip in the composer: pasting or
// typing a GitHub repo URL (any depth) or an X profile/status URL renders an
// inline chip (site icon + short label) while the serialized prompt keeps the
// original URL. Compiles + runs the unit test, then does static wiring checks.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 1. Static wiring checks.
const links = read('src/ui/utils/known-site-links.ts');
assert.ok(
  links.includes('extractKnownSiteLinkTokens') &&
    links.includes('splitTextIntoKnownSiteLinkSegments') &&
    links.includes('getKnownSiteIconSvg'),
  'known-site-links must export the tokenizer, the segment splitter, and the icon lookup'
);
assert.ok(
  links.includes("site: 'github'") &&
    links.includes("site: 'x'") &&
    links.includes("site: 'huggingface'"),
  'the site registry must include github, x, and huggingface descriptors'
);

const segments = read('src/ui/utils/composer-segments.ts');
assert.ok(
  segments.includes("type: 'link'") && segments.includes('splitTextIntoKnownSiteLinkSegments'),
  'composer segments must include the link segment type expanded from text runs'
);

const editor = read('src/ui/components/ComposerPromptEditor.tsx');
assert.ok(
  editor.includes('createLinkNode') && editor.includes("segment.type === 'link'"),
  'the prompt editor must render link segments as chips'
);
assert.ok(
  editor.includes('composer-inline-chip--link'),
  'the link chip must use the shared inline-chip styling'
);
assert.ok(
  editor.includes('removeLinkTokenAdjacentToCursor'),
  'Backspace/Delete must remove a link chip atomically'
);

const css = read('src/ui/index.css');
assert.ok(
  css.includes('.composer-inline-chip--link') && css.includes('--composer-link-chip-text'),
  'index.css must style the link chip in light and dark themes'
);
assert.ok(
  css.split('--composer-link-chip-text').length >= 3,
  'the link chip text color must be defined for both themes'
);

// 2. Compile + run the unit test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-composer-link-chip-'));
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
    'scripts/tests/composer-link-chip.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);
if (compile.status !== 0) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}
const run = spawnSync(
  process.execPath,
  [path.join(tmpDir, 'scripts', 'tests', 'composer-link-chip.test.js')],
  { cwd: root, stdio: 'inherit' }
);
fs.rmSync(tmpDir, { recursive: true, force: true });
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

console.log('composer-link-chip: wiring checks passed');
