#!/usr/bin/env node
// Verifies the subagent detail-panel logic layer (persona naming, per-session
// registry derivation, and the transcript scope filter). UI wiring assertions
// are added as the panel/store pieces land.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

// ── Source presence assertions ───────────────────────────────────────────────
const personaSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'utils', 'subagent-persona.ts'), 'utf8');
assert.ok(
  personaSrc.includes('export function getSubagentPersona'),
  'subagent-persona must export getSubagentPersona'
);
assert.ok(
  personaSrc.includes('functionalName') && personaSrc.includes('persona') && personaSrc.includes('colorHue'),
  'persona must carry functionalName (primary) + persona/color (accent)'
);

const registrySrc = fs.readFileSync(path.join(root, 'src', 'ui', 'utils', 'subagent-registry.ts'), 'utf8');
assert.ok(
  registrySrc.includes('export function deriveSubagentSummaries'),
  'subagent-registry must export deriveSubagentSummaries'
);
assert.ok(
  registrySrc.includes('if (message.parentToolUseId) continue;'),
  'registry must list TOP-LEVEL subagents only (skip nested)'
);

const timelineSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'utils', 'transcript-timeline.ts'), 'utf8');
assert.ok(
  timelineSrc.includes('subagentScopeId'),
  'deriveTranscriptTimelineItems must accept a subagentScopeId scope'
);
assert.ok(
  timelineSrc.includes('message.parentToolUseId !== options.subagentScopeId'),
  'scope must keep only the scoped subagent messages'
);

// ── Behavioral tests (compiled + run) ────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-subagent-'));
const tscBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);

const testFiles = [
  'scripts/tests/subagent-persona.test.ts',
  'scripts/tests/subagent-registry.test.ts',
  'scripts/tests/subagent-scope.test.ts',
];

try {
  const compile = spawnSync(
    tscBin,
    [
      '--target', 'ES2022',
      '--module', 'CommonJS',
      '--moduleResolution', 'Node',
      '--skipLibCheck',
      '--esModuleInterop',
      '--strict',
      '--outDir', tmpDir,
      ...testFiles,
    ],
    { cwd: root, stdio: 'inherit' }
  );
  assert.equal(compile.status, 0, 'subagent test compile failed');

  for (const testFile of testFiles) {
    const jsPath = path.join(tmpDir, testFile.replace(/\.ts$/, '.js'));
    const run = spawnSync(process.execPath, [jsPath], { cwd: root, stdio: 'inherit' });
    assert.equal(run.status, 0, `${testFile} failed`);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('verify-subagent-panel: OK');
